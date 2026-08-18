import { AIConfigError } from './errors.ts';
import { classifyCapabilities } from './capabilities.ts';
import { safeFallbackError } from './tool-loop-runtime.ts';

export type ToolLoopFallbackReason = 'rate_limit' | 'provider_unavailable' | 'network' | 'timeout';
export type ToolLoopFallbackNonReason = 'auth_or_config' | 'invalid_request' | 'content_policy' | 'tool_or_validation' | 'unknown';
export type ToolLoopFallbackClassification =
  | { eligible: true; reason: ToolLoopFallbackReason }
  | { eligible: false; reason: ToolLoopFallbackNonReason };

export interface ToolLoopFallbackEvent {
  turnIdx: number;
  primaryModel: string;
  failedModel: string;
  fallbackModel: string;
  reason: ToolLoopFallbackReason;
  error: string;
}

interface RunWithFallbackOpts<T> {
  primaryModel: string;
  fallbackModels?: string[];
  turnIdx: number;
  call: (model: string) => Promise<T>;
  onHeartbeat?: (event: string, data: Record<string, unknown>) => void;
  onModelFallback?: (event: ToolLoopFallbackEvent) => Promise<void> | void;
  isAborted?: () => boolean;
}

function errorStatus(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const e = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    const status = typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
    if (status !== undefined) return status;
    cur = e.cause;
  }
  return undefined;
}

function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(`${cur.name} ${cur.message}`);
      cur = (cur as Error & { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(cur));
    break;
  }
  return parts.join(' ');
}

/** Cross-model substitution is allowed only for explicit infrastructure failures. */
export function classifyToolLoopFallbackFailure(err: unknown): ToolLoopFallbackClassification {
  if (err instanceof AIConfigError) return { eligible: false, reason: 'auth_or_config' };

  const status = errorStatus(err);
  if (status === 408) return { eligible: true, reason: 'timeout' };
  if (status === 429) return { eligible: true, reason: 'rate_limit' };
  if (status !== undefined && status >= 500 && status <= 599) {
    return { eligible: true, reason: 'provider_unavailable' };
  }
  if (status !== undefined && (status === 401 || status === 403)) {
    return { eligible: false, reason: 'auth_or_config' };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { eligible: false, reason: 'invalid_request' };
  }

  const text = errorText(err);
  if (/\b(rate limit|rate_limit|too many requests)\b/i.test(text)) {
    return { eligible: true, reason: 'rate_limit' };
  }
  if (/\b(HTTP|status|status code)[:= ]+(500|502|503|504)\b/i.test(text)
      || /\b(service unavailable|bad gateway|gateway timeout|provider unavailable|overloaded)\b/i.test(text)) {
    return { eligible: true, reason: 'provider_unavailable' };
  }
  if (/\b(content_filter|content filter|safety|policy|refusal)\b/i.test(text)) {
    return { eligible: false, reason: 'content_policy' };
  }
  if (/\b(tool|schema|validation|invalid argument|malformed|parse|json)\b/i.test(text)) {
    return { eligible: false, reason: 'tool_or_validation' };
  }
  if (/\b(ETIMEDOUT|TimeoutError|timed out|timeout|deadline exceeded)\b/i.test(text)) {
    return { eligible: true, reason: 'timeout' };
  }
  if (/\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|fetch failed)\b/i.test(text)) {
    return { eligible: true, reason: 'network' };
  }
  return { eligible: false, reason: 'unknown' };
}

function validFallbackModels(
  primaryModel: string,
  fallbackModels: string[] | undefined,
  onSkip: (model: string, reason: string) => void,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([primaryModel]);
  for (const raw of fallbackModels ?? []) {
    const model = typeof raw === 'string' ? raw.trim() : '';
    if (!model) {
      onSkip(String(raw), 'empty');
      continue;
    }
    if (seen.has(model)) {
      onSkip(model, 'duplicate');
      continue;
    }
    const verdict = classifyCapabilities(model);
    if (verdict === 'unknown' || verdict === 'unusable:no_tools') {
      onSkip(model, verdict);
      continue;
    }
    seen.add(model);
    out.push(model);
  }
  return out;
}

export async function runWithToolLoopFallback<T>(
  opts: RunWithFallbackOpts<T>,
  events: ToolLoopFallbackEvent[],
): Promise<T> {
  let currentModel = opts.primaryModel;
  let remainingFallbacks: string[] | null = null;

  for (;;) {
    try {
      return await opts.call(currentModel);
    } catch (err) {
      if (opts.isAborted?.()) throw err;
      const classification = classifyToolLoopFallbackFailure(err);
      if (!classification.eligible) throw err;

      remainingFallbacks ??= validFallbackModels(
        opts.primaryModel,
        opts.fallbackModels,
        (model, reason) => opts.onHeartbeat?.('fallback_model_skipped', {
          turn_idx: opts.turnIdx,
          primary_model: opts.primaryModel,
          fallback_model: model,
          reason,
        }),
      );
      const fallbackModel = remainingFallbacks.shift();
      if (!fallbackModel) throw err;

      const event: ToolLoopFallbackEvent = {
        turnIdx: opts.turnIdx,
        primaryModel: opts.primaryModel,
        failedModel: currentModel,
        fallbackModel,
        reason: classification.reason,
        error: safeFallbackError(err),
      };
      events.push(event);
      opts.onHeartbeat?.('model_fallback', {
        turn_idx: event.turnIdx,
        primary_model: event.primaryModel,
        failed_model: event.failedModel,
        fallback_model: event.fallbackModel,
        reason: event.reason,
        error: event.error,
      });
      await opts.onModelFallback?.(event);
      currentModel = fallbackModel;
    }
  }
}
