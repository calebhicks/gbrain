import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createNativeAttemptReplayChat } from '../src/core/cycle/extract-atoms-attempt-replay.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let engine: PGLiteEngine;

async function registerSource(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id,name,local_path,config,created_at)
     VALUES ($1,$1,$2,'{}'::jsonb,NOW()) ON CONFLICT (id) DO NOTHING`,
    [sourceId, `/fake/${sourceId}`],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => engine.disconnect());

describe('native atom extraction attempt replay', () => {
  test('replays exact hash-pinned native sidecars with zero provider usage', async () => {
    await resetPgliteState(engine);
    const sourceId = 'winloss-test';
    await registerSource(sourceId);
    const runId = 'native-population-test';
    const system = 'Extract governed evidence.';
    const content = 'Exact native source context.';
    const response = '[{"title":"Exact evidence"}]';
    const slug = 'extracts/2026-09-02/atom-attempts/test/attempt-000001';
    await engine.putPage(slug, {
      type: 'extract_receipt', title: 'Attempt', compiled_truth: '# Attempt',
      frontmatter: {
        type: 'extract_receipt', kind: 'native-extract-attempt', run_id: runId,
        attempt_ordinal: 1, attempt_status: 'response_recorded',
        system_sha256: sha256(system), input_sha256: sha256(content),
        response_sha256: sha256(response), model_id: 'openai:gpt-5.6-luna',
      },
    }, { sourceId });
    await engine.putRawData(slug, 'native-extract-attempt-input', { system, content }, { sourceId });
    await engine.putRawData(slug, 'native-extract-attempt-response', {
      text: response, blocks: [{ type: 'text', text: response }], stop_reason: 'end',
      usage: { input_tokens: 12, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-5.6-luna', provider_id: 'openai', provider_metadata: { request_id: 'private' },
    }, { sourceId });

    const replay = await createNativeAttemptReplayChat(engine, { sourceId, runId });
    const result = await replay.chat({
      model: 'openai:gpt-5.6-luna', system,
      messages: [{ role: 'user', content }], maxTokens: 8_000,
    });
    expect(result.text).toBe(response);
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });
    expect(result.providerId).toBe('native-attempt-replay');
    expect(result.providerMetadata).toEqual({
      replayed_attempt_slug_sha256: sha256(slug),
      replayed_response_sha256: sha256(response),
    });
    expect(replay.stats()).toEqual({ available: 1, consumed: 1, remaining: 0, provider_calls: 0 });
    await expect(replay.chat({
      model: 'openai:gpt-5.6-luna', system,
      messages: [{ role: 'user', content }], maxTokens: 8_000,
    })).rejects.toThrow('absent or already consumed');
    await expect(replay.chat({
      model: 'openai:gpt-5.6-luna', system: 'drifted',
      messages: [{ role: 'user', content }], maxTokens: 8_000,
    })).rejects.toThrow('absent or already consumed');
  });

  test('fails closed on request drift, duplicate consumption, and sidecar hash drift', async () => {
    await resetPgliteState(engine);
    const sourceId = 'winloss-test';
    await registerSource(sourceId);
    const runId = 'native-population-test';
    const slug = 'extracts/2026-09-02/atom-attempts/test/attempt-000001';
    await engine.putPage(slug, {
      type: 'extract_receipt', title: 'Attempt', compiled_truth: '# Attempt',
      frontmatter: {
        type: 'extract_receipt', kind: 'native-extract-attempt', run_id: runId,
        attempt_ordinal: 1, attempt_status: 'response_recorded',
        system_sha256: sha256('system'), input_sha256: sha256('content'),
        response_sha256: sha256('expected'), model_id: 'openai:gpt-5.6-luna',
      },
    }, { sourceId });
    await engine.putRawData(slug, 'native-extract-attempt-input', { system: 'system', content: 'content' }, { sourceId });
    await engine.putRawData(slug, 'native-extract-attempt-response', {
      text: 'drifted', blocks: [], stop_reason: 'end', usage: {},
      model: 'openai:gpt-5.6-luna', provider_id: 'openai',
    }, { sourceId });
    await expect(createNativeAttemptReplayChat(engine, { sourceId, runId }))
      .rejects.toThrow('response hash mismatch');
  });
});
