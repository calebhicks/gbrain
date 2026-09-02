import { createHash } from 'node:crypto';
import type { ChatOpts, ChatResult } from '../ai/gateway.ts';
import type { BrainEngine } from '../engine.ts';

interface AttemptRow {
  slug: string;
  frontmatter: Record<string, unknown>;
}

interface AttemptInput {
  system: string;
  content: string;
}

interface AttemptResponse {
  text: string;
  blocks: ChatResult['blocks'];
  stop_reason: ChatResult['stopReason'];
  model: string;
}

interface ReplayEntry {
  slug: string;
  attemptKind: string;
  inputSha256: string;
  response: AttemptResponse;
  consumed: boolean;
}

export interface NativeAttemptReplay {
  chat: (opts: ChatOpts) => Promise<ChatResult>;
  stats: () => { available: number; consumed: number; remaining: number; provider_calls: 0 };
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const requestKey = (system: string, content: string): string => `${sha256(system)}\n${sha256(content)}`;

function fail(message: string): never {
  throw new Error(`Native atom extraction replay refused: ${message}`);
}

function oneRawData<T>(
  rows: Array<{ source: string; data: unknown }>,
  source: string,
  slug: string,
): T {
  const matches = rows.filter(row => row.source === source);
  if (matches.length !== 1 || !matches[0]?.data || typeof matches[0].data !== 'object') {
    fail(`${slug} must have exactly one ${source} sidecar`);
  }
  return matches[0]!.data as T;
}

/**
 * Build a provider-free chat adapter from hash-pinned native attempt sidecars.
 * The adapter can only answer exact requests from the predecessor run, consumes
 * each stored response once, and reports zero usage so replay is never billed or
 * double-counted as a provider call.
 */
export async function createNativeAttemptReplayChat(
  engine: BrainEngine,
  opts: { sourceId: string; runId: string },
): Promise<NativeAttemptReplay> {
  if (!opts.sourceId.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(opts.runId)) {
    fail('sourceId and runId are required');
  }
  const rows = await engine.executeRaw<AttemptRow>(
    `SELECT slug,frontmatter FROM pages
     WHERE source_id=$1 AND type='extract_receipt' AND deleted_at IS NULL
       AND frontmatter->>'kind'='native-extract-attempt'
       AND frontmatter->>'run_id'=$2
       AND frontmatter->>'attempt_status'='response_recorded'
     ORDER BY (frontmatter->>'attempt_ordinal')::bigint,slug`,
    [opts.sourceId, opts.runId],
  );
  if (rows.length === 0) fail('no response-recorded attempts found');
  const queues = new Map<string, ReplayEntry[]>();
  const groundingByInput = new Map<string, ReplayEntry[]>();
  const ordinals = new Set<number>();
  for (const row of rows) {
    const fm = row.frontmatter;
    const ordinal = Number(fm.attempt_ordinal);
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinals.has(ordinal)) {
      fail(`${row.slug} has an invalid or duplicate attempt ordinal`);
    }
    ordinals.add(ordinal);
    const raw = await engine.getRawData(row.slug, undefined, { sourceId: opts.sourceId });
    const input = oneRawData<AttemptInput>(raw, 'native-extract-attempt-input', row.slug);
    const response = oneRawData<AttemptResponse>(raw, 'native-extract-attempt-response', row.slug);
    if (typeof input.system !== 'string' || typeof input.content !== 'string'
        || sha256(input.system) !== fm.system_sha256 || sha256(input.content) !== fm.input_sha256) {
      fail(`${row.slug} input hash mismatch`);
    }
    if (typeof response.text !== 'string' || sha256(response.text) !== fm.response_sha256) {
      fail(`${row.slug} response hash mismatch`);
    }
    if (!Array.isArray(response.blocks) || typeof response.model !== 'string'
        || !['end', 'tool_calls', 'length', 'refusal', 'content_filter', 'other'].includes(response.stop_reason)) {
      fail(`${row.slug} response shape is invalid`);
    }
    const attemptKind = String(fm.attempt_kind ?? '');
    const entry = {
      slug: row.slug,
      attemptKind,
      inputSha256: sha256(input.content),
      response,
      consumed: false,
    };
    const key = requestKey(input.system, input.content);
    const queue = queues.get(key) ?? [];
    queue.push(entry);
    queues.set(key, queue);
    if (attemptKind.endsWith('-grounding-retry')) {
      const candidates = groundingByInput.get(entry.inputSha256) ?? [];
      candidates.push(entry);
      groundingByInput.set(entry.inputSha256, candidates);
    }
  }

  let consumed = 0;
  return {
    chat: async (chatOpts) => {
      const system = chatOpts.system ?? '';
      if (chatOpts.messages.length !== 1 || chatOpts.messages[0]?.role !== 'user'
          || typeof chatOpts.messages[0].content !== 'string') {
        fail('request must contain exactly one text user message');
      }
      const content = chatOpts.messages[0].content;
      const key = requestKey(system, content);
      const exactQueue = queues.get(key);
      let entry = exactQueue?.find(candidate => !candidate.consumed);
      let matchBasis = 'exact_request_v1';
      if (!entry && system.includes('STRICT GROUNDING RETRY:')) {
        const candidates = (groundingByInput.get(sha256(content)) ?? [])
          .filter(candidate => !candidate.consumed);
        if (candidates.length === 1) {
          [entry] = candidates;
          matchBasis = 'exact_source_input_grounding_retry_v1';
        }
      }
      if (!entry) fail('request hashes are absent or already consumed');
      entry.consumed = true;
      consumed += 1;
      return {
        text: entry.response.text,
        blocks: entry.response.blocks,
        stopReason: entry.response.stop_reason,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: entry.response.model,
        providerId: 'native-attempt-replay',
        providerMetadata: {
          replayed_attempt_slug_sha256: sha256(entry.slug),
          replayed_response_sha256: sha256(entry.response.text),
          replay_match_basis: matchBasis,
        },
      };
    },
    stats: () => ({ available: rows.length, consumed, remaining: rows.length - consumed, provider_calls: 0 }),
  };
}
