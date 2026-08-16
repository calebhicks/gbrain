/**
 * #1594 — dream synthesize subagent timeouts are config keys, not hardcoded
 * 30/35-minute constants. Approach ported from PR #1596 (@ai920wisco).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseSynthesize, TRIAGE_VERSION, __testing } from '../src/core/cycle/synthesize.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

interface RequiredChildReceiptForTest {
  counts: { completed: number; failed: number; timed_out: number };
  failed_ids: number[];
  timed_out_ids: number[];
  unknown_status_ids: number[];
  unsuccessful_stop_reasons: Array<{ job_id: number; stop_reason: string }>;
  has_failures: boolean;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedWorthProcessingVerdict(
  filePath: string,
  content: string,
): Promise<string> {
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  // Triage-v1 cache validity requires score + matching (model, triage_version);
  // TIER_DEFAULTS.utility is what loadSynthConfig resolves in a bare test env.
  await engine.putDreamVerdict(filePath, contentHash, {
    worth_processing: true,
    reasons: ['seeded for timeout config test'],
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
  return contentHash;
}

async function seedSettledChild(
  idempotencyKey: string,
  status: 'completed' | 'failed',
  stopReason?: string,
): Promise<number> {
  const result = stopReason === undefined
    ? { turns_count: 2 }
    : { turns_count: 2, stop_reason: stopReason };
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs
       (name, queue, status, data, result, idempotency_key, finished_at)
     VALUES ('subagent', 'prior-dream-run', $1, '{}'::jsonb, $3::jsonb, $2, now())
     RETURNING id`,
    [status, idempotencyKey, JSON.stringify(result)],
  );
  return Number(rows[0]!.id);
}

describe('runPhaseSynthesize subagent timeout config', () => {
  test('required child failure does not write a summary or advance cooldown', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-corpus-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-timeout-home-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.subagent_timeout_ms', '600000');
      await engine.setConfig('dream.synthesize.subagent_wait_timeout_ms', '1');

      const filePath = join(corpusDir, '2026-05-28-dense-transcript.txt');
      const content = 'dense transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      await seedWorthProcessingVerdict(filePath, content);

      const result = await withEnv(
        { ANTHROPIC_API_KEY: 'sk-ant-test', GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, {
          brainDir,
          dryRun: false,
        }),
      );

      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_CHILD_FAILURES');
      const childReceipt = result.details.child_receipt as {
        counts: { completed: number; failed: number; timed_out: number };
      };
      expect(childReceipt.counts).toEqual({
        completed: 0,
        failed: 1,
        timed_out: 0,
      });
      expect(result.details.children_submitted).toBe(1);
      expect(result.details.pages_written).toBe(0);
      expect(result.details.summary_slug).toBeNull();
      expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
      const summaries = await engine.executeRaw<{ count: string | number }>(
        `SELECT COUNT(*)::bigint AS count
           FROM pages
          WHERE slug LIKE 'dream-cycle-summaries/%'`,
      );
      expect(Number(summaries[0]!.count)).toBe(0);

      const jobs = await engine.executeRaw<{ timeout_ms: string | number | null }>(
        `SELECT timeout_ms
           FROM minion_jobs
          WHERE name = 'subagent'
          ORDER BY id DESC
          LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      expect(Number(jobs[0]!.timeout_ms)).toBe(600000);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('all completed children write the summary and advance cooldown', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-success-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-success-corpus-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-success-home-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);

      const filename = '2026-05-29-success-transcript.txt';
      const filePath = join(corpusDir, filename);
      const content = 'successful transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      const contentHash = await seedWorthProcessingVerdict(filePath, content);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent(filename)}:${contentHash.slice(0, 16)}`;
      await seedSettledChild(key, 'completed', 'end_turn');

      const before = Date.now();
      const result = await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('ok');
      const receipt = result.details.child_receipt as {
        counts: { completed: number; failed: number; timed_out: number };
        has_failures: boolean;
      };
      expect(receipt.counts).toEqual({ completed: 1, failed: 0, timed_out: 0 });
      expect(receipt.has_failures).toBe(false);
      expect(typeof result.details.summary_slug).toBe('string');
      const summary = await engine.getPage(result.details.summary_slug as string, { sourceId: 'default' });
      expect(summary?.compiled_truth).toContain('**Children:** 1 completed, 0 failed/timeout.');
      const completionTs = await engine.getConfig('dream.synthesize.last_completion_ts');
      expect(completionTs).not.toBeNull();
      expect(new Date(completionTs!).getTime()).toBeGreaterThanOrEqual(before);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('queue-completed children with unsuccessful stop reasons fail the phase', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-stop-reason-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-stop-reason-corpus-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-stop-reason-home-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      const stopReasons = ['max_turns', 'max_tokens', 'refusal', 'error'] as const;
      const jobIds: number[] = [];
      for (const [i, stopReason] of stopReasons.entries()) {
        const filename = `2026-06-0${i + 1}-${stopReason}.txt`;
        const filePath = join(corpusDir, filename);
        const content = `${stopReason} transcript line\n`.repeat(250);
        writeFileSync(filePath, content);
        const contentHash = await seedWorthProcessingVerdict(filePath, content);
        const key = `dream:synth-v2:default:filename:${encodeURIComponent(filename)}:${contentHash.slice(0, 16)}`;
        jobIds.push(await seedSettledChild(key, 'completed', stopReason));
      }

      const result = await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_CHILD_FAILURES');
      const receipt = result.details.child_receipt as RequiredChildReceiptForTest;
      expect(receipt.counts).toEqual({ completed: 0, failed: 4, timed_out: 0 });
      expect(receipt.failed_ids).toEqual(jobIds);
      expect(receipt.unsuccessful_stop_reasons).toEqual(
        jobIds.map((job_id, i) => ({ job_id, stop_reason: stopReasons[i] })),
      );
      expect(result.details.summary_slug).toBeNull();
      expect(result.details.released_retry_keys).toBe(4);
      expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
      const released = await engine.executeRaw<{ id: number; idempotency_key: string | null }>(
        `SELECT id, idempotency_key FROM minion_jobs WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [jobIds],
      );
      expect(released).toHaveLength(4);
      expect(released.every(row => row.idempotency_key === null)).toBe(true);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('an unsuccessful completed child releases its key for a fresh successful attempt', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-retry-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-retry-corpus-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-retry-home-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);

      const filename = '2026-06-06-retry-after-truncation.txt';
      const filePath = join(corpusDir, filename);
      const content = 'retryable transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      const contentHash = await seedWorthProcessingVerdict(filePath, content);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent(filename)}:${contentHash.slice(0, 16)}`;
      const firstJobId = await seedSettledChild(key, 'completed', 'max_tokens');

      const first = await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, { brainDir, dryRun: false }),
      );
      expect(first.status).toBe('fail');
      expect(first.details.released_retry_keys).toBe(1);

      const queue = new MinionQueue(engine);
      const retry = await queue.add(
        'subagent',
        { prompt: 'retry synthesis', model: 'anthropic:claude-sonnet-4-6' },
        { idempotency_key: key },
        { allowProtectedSubmit: true },
      );
      expect(retry.id).not.toBe(firstJobId);
      expect(retry.coalesced).not.toBe(true);
      await engine.executeRaw(
        `UPDATE minion_jobs
            SET status = 'completed', result = $2::jsonb, finished_at = now()
          WHERE id = $1`,
        [retry.id, JSON.stringify({ turns_count: 1, stop_reason: 'end_turn' })],
      );

      const second = await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, { brainDir, dryRun: false }),
      );
      expect(second.status).toBe('ok');
      expect(second.details.released_retry_keys).toBe(0);
      expect(second.details.child_outcomes).toEqual([
        { jobId: retry.id, status: 'completed', stopReason: 'end_turn', turns: 1 },
      ]);

      const oldRow = await engine.executeRaw<{ idempotency_key: string | null }>(
        `SELECT idempotency_key FROM minion_jobs WHERE id = $1`,
        [firstJobId],
      );
      expect(oldRow[0]!.idempotency_key).toBeNull();
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('partial child writes survive failure without refreshing prior success artifacts', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-partial-brain-'));
    const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-partial-corpus-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-partial-home-'));

    try {
      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.cooldown_hours', '0');
      const priorCompletion = '2000-01-01T00:00:00.000Z';
      await engine.setConfig('dream.synthesize.last_completion_ts', priorCompletion);

      const summarySlug = `dream-cycle-summaries/${new Date().toISOString().slice(0, 10)}`;
      await engine.putPage(summarySlug, {
        type: 'note',
        title: 'Prior successful summary',
        compiled_truth: 'sentinel prior summary',
      }, { sourceId: 'default' });

      const outputSlug = 'wiki/personal/reflections/partial-child-output';
      await engine.putPage(outputSlug, {
        type: 'note',
        title: 'Partial child output',
        compiled_truth: 'valuable partial output',
      }, { sourceId: 'default' });

      const filename = '2026-05-30-partial-transcript.txt';
      const filePath = join(corpusDir, filename);
      const content = 'partial transcript line\n'.repeat(250);
      writeFileSync(filePath, content);
      const contentHash = await seedWorthProcessingVerdict(filePath, content);
      const key = `dream:synth-v2:default:filename:${encodeURIComponent(filename)}:${contentHash.slice(0, 16)}`;
      const jobId = await seedSettledChild(key, 'failed');
      await engine.executeRaw(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status)
         VALUES ($1, 0, 'partial-put', 'brain_put_page', $2::jsonb, 'complete')`,
        [jobId, JSON.stringify({ slug: outputSlug })],
      );

      const result = await withEnv(
        { ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: homeDir },
        () => runPhaseSynthesize(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('fail');
      expect(result.error?.code).toBe('SYNTH_CHILD_FAILURES');
      expect(result.details.pages_written).toBe(1);
      expect(result.details.summary_slug).toBeNull();
      expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBe(priorCompletion);
      expect((await engine.getPage(summarySlug, { sourceId: 'default' }))?.compiled_truth)
        .toBe('sentinel prior summary');

      const partialPage = await engine.getPage(outputSlug, { sourceId: 'default' });
      expect(partialPage?.compiled_truth).toBe('valuable partial output');
      expect(partialPage?.frontmatter.dream_generated).toBe(true);
      expect(partialPage?.frontmatter.raw_source).toBe(filePath);
      const reversePath = join(brainDir, `${outputSlug}.md`);
      expect(existsSync(reversePath)).toBe(true);
      expect(readFileSync(reversePath, 'utf8')).toContain('valuable partial output');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(corpusDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('synthesize child receipt summary', () => {
  test('counts terminal outcomes', () => {
    const receipt = __testing.summarizeRequiredChildOutcomes(
      [
        { jobId: 1, status: 'completed' },
        { jobId: 2, status: 'failed' },
        { jobId: 3, status: 'dead' },
        { jobId: 4, status: 'cancelled' },
        { jobId: 5, status: 'timeout' },
      ],
    );

    expect(receipt.counts).toEqual({
      completed: 1,
      failed: 3,
      timed_out: 1,
    });
    expect(receipt.failed_ids).toEqual([2, 3, 4]);
    expect(receipt.timed_out_ids).toEqual([5]);
    expect(receipt.unknown_status_ids).toEqual([]);
    expect(receipt.unsuccessful_stop_reasons).toEqual([]);
    expect(receipt.has_failures).toBe(true);
  });

  test('fails closed on an unknown persisted status', () => {
    const receipt = __testing.summarizeRequiredChildOutcomes(
      [{ jobId: 9, status: 'waiting_elsewhere' }],
    );

    expect(receipt.counts.failed).toBe(1);
    expect(receipt.failed_ids).toEqual([9]);
    expect(receipt.unknown_status_ids).toEqual([9]);
    expect(receipt.has_failures).toBe(true);
  });

  test('all completed children remain successful', () => {
    const receipt = __testing.summarizeRequiredChildOutcomes(
      [
        { jobId: 42, status: 'completed', stopReason: 'end_turn' },
        { jobId: 43, status: 'completed' },
      ],
    );

    expect(receipt.counts).toEqual({
      completed: 2,
      failed: 0,
      timed_out: 0,
    });
    expect(receipt.has_failures).toBe(false);
  });

  test('completed status fails closed on unsuccessful or malformed stop reasons', () => {
    const receipt = __testing.summarizeRequiredChildOutcomes([
      { jobId: 51, status: 'completed', stopReason: 'max_turns' },
      { jobId: 52, status: 'completed', stopReason: 'max_tokens' },
      { jobId: 53, status: 'completed', stopReason: 'refusal' },
      { jobId: 54, status: 'completed', stopReason: 'error' },
      { jobId: 55, status: 'completed', stopReason: 7 },
    ]);

    expect(receipt.counts).toEqual({ completed: 0, failed: 5, timed_out: 0 });
    expect(receipt.unsuccessful_stop_reasons).toEqual([
      { job_id: 51, stop_reason: 'max_turns' },
      { job_id: 52, stop_reason: 'max_tokens' },
      { job_id: 53, stop_reason: 'refusal' },
      { job_id: 54, stop_reason: 'error' },
      { job_id: 55, stop_reason: 'invalid:7' },
    ]);
    expect(receipt.has_failures).toBe(true);
  });

  test('bounds each diagnostic id list without losing aggregate counts', () => {
    const outcomes = [
      ...Array.from({ length: 25 }, (_, i) => ({ jobId: i + 1, status: 'failed' })),
      ...Array.from({ length: 25 }, (_, i) => ({ jobId: i + 101, status: 'timeout' })),
      ...Array.from({ length: 25 }, (_, i) => ({ jobId: i + 201, status: 'unexpected' })),
    ];
    const receipt = __testing.summarizeRequiredChildOutcomes(outcomes);

    expect(receipt.counts).toEqual({ completed: 0, failed: 50, timed_out: 25 });
    expect(receipt.failed_ids).toHaveLength(20);
    expect(receipt.timed_out_ids).toHaveLength(20);
    expect(receipt.unknown_status_ids).toHaveLength(20);
    expect(receipt.failed_ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(receipt.timed_out_ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 101));
    expect(receipt.unknown_status_ids).toEqual(Array.from({ length: 20 }, (_, i) => i + 201));
  });
});
