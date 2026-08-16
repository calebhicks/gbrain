import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';

const CHILD_ID_DETAIL_LIMIT = 20;

export interface RequiredChildOutcomeReceipt {
  counts: { completed: number; failed: number; timed_out: number };
  failed_ids: number[];
  timed_out_ids: number[];
  unknown_status_ids: number[];
  unsuccessful_stop_reasons: Array<{ job_id: number; stop_reason: string }>;
  has_failures: boolean;
}

export type ChildOutcomeLike = {
  jobId: number;
  status: string;
  stopReason?: unknown;
  turns?: number;
};

export function toChildOutcome(
  jobId: number,
  status: string,
  rawResult: unknown,
): ChildOutcomeLike {
  const result = rawResult as Record<string, unknown> | null | undefined;
  const turns = result?.turns_count;
  return {
    jobId,
    status,
    ...(result && Object.prototype.hasOwnProperty.call(result, 'stop_reason')
      ? { stopReason: result.stop_reason }
      : {}),
    ...(typeof turns === 'number' && Number.isFinite(turns) ? { turns } : {}),
  };
}

/** Build a bounded receipt. Unknown persistence values fail closed. */
export function summarizeRequiredChildOutcomes(
  childOutcomes: ChildOutcomeLike[],
): RequiredChildOutcomeReceipt {
  const summary: RequiredChildOutcomeReceipt = {
    counts: { completed: 0, failed: 0, timed_out: 0 },
    failed_ids: [],
    timed_out_ids: [],
    unknown_status_ids: [],
    unsuccessful_stop_reasons: [],
    has_failures: false,
  };

  for (const outcome of childOutcomes) {
    // Missing stop_reason is accepted for legacy rows. Once present, only
    // end_turn proves that the required child completed successfully.
    if (outcome.status === 'completed'
        && (outcome.stopReason === undefined || outcome.stopReason === 'end_turn')) {
      summary.counts.completed++;
      continue;
    }
    if (outcome.status === 'timeout') {
      summary.counts.timed_out++;
      if (summary.timed_out_ids.length < CHILD_ID_DETAIL_LIMIT) {
        summary.timed_out_ids.push(outcome.jobId);
      }
      continue;
    }

    summary.counts.failed++;
    if (summary.failed_ids.length < CHILD_ID_DETAIL_LIMIT) {
      summary.failed_ids.push(outcome.jobId);
    }
    if (outcome.status === 'completed'
        && summary.unsuccessful_stop_reasons.length < CHILD_ID_DETAIL_LIMIT) {
      summary.unsuccessful_stop_reasons.push({
        job_id: outcome.jobId,
        stop_reason: typeof outcome.stopReason === 'string'
          ? outcome.stopReason
          : `invalid:${String(outcome.stopReason)}`,
      });
    } else if (!['failed', 'dead', 'cancelled'].includes(outcome.status)
        && summary.unknown_status_ids.length < CHILD_ID_DETAIL_LIMIT) {
      summary.unknown_status_ids.push(outcome.jobId);
    }
  }

  summary.has_failures = summary.counts.failed > 0 || summary.counts.timed_out > 0;
  return summary;
}

function formatChildFailureSummary(receipt: RequiredChildOutcomeReceipt): string {
  const counts = `completed=${receipt.counts.completed}, failed=${receipt.counts.failed}, timed_out=${receipt.counts.timed_out}`;
  const ids: string[] = [];
  if (receipt.failed_ids.length > 0) ids.push(`failed child ids: ${receipt.failed_ids.join(',')}`);
  if (receipt.timed_out_ids.length > 0) ids.push(`timed-out child ids: ${receipt.timed_out_ids.join(',')}`);
  if (receipt.unknown_status_ids.length > 0) ids.push(`unknown-status child ids: ${receipt.unknown_status_ids.join(',')}`);
  if (receipt.unsuccessful_stop_reasons.length > 0) {
    ids.push(`unsuccessful completed children: ${receipt.unsuccessful_stop_reasons
      .map(({ job_id, stop_reason }) => `${job_id}:${stop_reason}`).join(',')}`);
  }
  return ids.length > 0 ? `${counts} (${ids.join('; ')})` : counts;
}

/**
 * Release only unsuccessful queue-completed synth children for a later retry.
 * The old row remains for audit; ordinary completed-job idempotency is intact.
 */
export async function releaseUnsuccessfulCompletedChildKeys(
  engine: BrainEngine,
  childOutcomes: ChildOutcomeLike[],
): Promise<number> {
  const jobIds = childOutcomes
    .filter(outcome => outcome.status === 'completed'
      && outcome.stopReason !== undefined
      && outcome.stopReason !== 'end_turn')
    .map(outcome => outcome.jobId);
  if (jobIds.length === 0) return 0;

  const released = await engine.executeRaw<{ id: number }>(
    `UPDATE minion_jobs SET idempotency_key = NULL
      WHERE id = ANY($1::bigint[])
        AND status = 'completed'
        AND idempotency_key LIKE 'dream:synth-v2:%'
      RETURNING id`,
    [jobIds],
  );
  return released.length;
}

export function makeRequiredChildFailure(
  receipt: RequiredChildOutcomeReceipt,
  durationMs: number,
  details: Record<string, unknown>,
): PhaseResult | null {
  if (!receipt.has_failures) return null;
  const summary = `synthesize child failures: ${formatChildFailureSummary(receipt)}`;
  return {
    phase: 'synthesize',
    status: 'fail',
    duration_ms: durationMs,
    summary,
    details,
    error: {
      class: receipt.counts.timed_out > 0 && receipt.counts.failed === 0 ? 'Timeout' : 'InternalError',
      code: 'SYNTH_CHILD_FAILURES',
      message: summary,
      hint: 'Inspect the bounded child ids with `gbrain jobs get <id>` before rerunning synthesize.',
    },
  };
}

export function buildSynthesizeDetails(opts: {
  transcriptsDiscovered: number;
  transcriptsProcessed: number;
  writtenSlugs: string[];
  reverseWriteCount: number;
  childOutcomes: ChildOutcomeLike[];
  childReceipt: RequiredChildOutcomeReceipt;
  releasedRetryKeys: number;
  childrenSubmitted: number;
  skips: unknown;
  verdicts: unknown;
  triage: unknown;
  maxTurns: number;
  summarySlug: string;
}): Record<string, unknown> {
  const turnSamples = opts.childOutcomes.filter(o => typeof o.turns === 'number');
  return {
    transcripts_discovered: opts.transcriptsDiscovered,
    transcripts_processed: opts.transcriptsProcessed,
    pages_written: opts.writtenSlugs.length,
    written_slugs: opts.writtenSlugs,
    reverse_write_count: opts.reverseWriteCount,
    child_outcomes: opts.childOutcomes,
    child_receipt: opts.childReceipt,
    released_retry_keys: opts.releasedRetryKeys,
    children_submitted: opts.childrenSubmitted,
    skips: opts.skips,
    summary_slug: opts.childReceipt.has_failures ? null : opts.summarySlug,
    verdicts: opts.verdicts,
    triage: opts.triage,
    synthesis: {
      jobs: opts.childrenSubmitted,
      max_turns_config: opts.maxTurns,
      avg_turns: turnSamples.length > 0
        ? Math.round((turnSamples.reduce((sum, o) => sum + (o.turns ?? 0), 0) / turnSamples.length) * 10) / 10
        : null,
    },
  };
}
