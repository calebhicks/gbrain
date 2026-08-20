/** Narrow runtime helpers shared by tool-loop orchestration and fallback. */

export type ToolLoopTurnPermit =
  | (() => Promise<void> | void)
  | { release: () => Promise<void> | void; signal?: AbortSignal };

export async function callWithProviderPermit<T>(opts: {
  acquire?: () => Promise<ToolLoopTurnPermit>;
  callerSignal?: AbortSignal;
  call: (signal?: AbortSignal) => Promise<T>;
  onAbortObserved: (aborted: boolean) => void;
}): Promise<T> {
  const permit = await opts.acquire?.();
  const release = typeof permit === 'function' ? permit : permit?.release;
  const permitSignal = typeof permit === 'object' ? permit.signal : undefined;
  const signal = permitSignal
    ? (opts.callerSignal ? AbortSignal.any([opts.callerSignal, permitSignal]) : permitSignal)
    : opts.callerSignal;
  opts.onAbortObserved(false);
  try {
    return await opts.call(signal);
  } catch (err) {
    opts.onAbortObserved(signal?.aborted === true);
    throw err;
  } finally {
    if (release) await Promise.resolve(release()).catch(() => { /* best-effort */ });
  }
}

/** Keep durable fallback receipts useful without persisting provider tenancy data. */
export function safeFallbackError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\r\n\t]+/g, ' ')
    .replace(/\b((?:x[-_])?request(?:[-_ ]?id)?|org(?:anization)?(?:[-_ ]?id)?|tenant(?:[-_ ]?id)?)\s+([A-Za-z0-9_-]{3,})\b/gi, '$1=[redacted]')
    .replace(/\b(org(?:anization)?(?:[_ -]?id)?)\s*[:=]\s*[A-Za-z0-9_-]+/gi, '$1=[redacted]')
    .replace(/\b(request(?:[_ -]?id)?)\s*[:=]\s*[A-Za-z0-9_-]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|rk|pk|sess|req|request|org)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted-token]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted-uuid]')
    .slice(0, 240);
}
