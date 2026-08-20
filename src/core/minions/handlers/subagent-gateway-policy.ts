import {
  isThinkingModel,
  THINKING_MODEL_MAX_OUTPUT_TOKENS,
} from '../../ai/gateway.ts';

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const DEFAULT_RATE_KEY = 'anthropic:messages';

export function resolveExplicitMaxOutputTokens(
  perJob: number | undefined,
  configRaw: string | null | undefined,
): number | undefined {
  if (typeof perJob === 'number' && Number.isFinite(perJob) && perJob > 0) {
    return Math.floor(perJob);
  }
  if (typeof configRaw === 'string' && configRaw.trim() !== '') {
    const n = Number(configRaw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

export function resolveMaxOutputTokens(
  perJob: number | undefined,
  configRaw: string | null | undefined,
  model?: string,
): number {
  const explicit = resolveExplicitMaxOutputTokens(perJob, configRaw);
  if (explicit !== undefined) return explicit;
  return isThinkingModel(model)
    ? THINKING_MODEL_MAX_OUTPUT_TOKENS
    : DEFAULT_MAX_OUTPUT_TOKENS;
}

export function gatewayLeaseKeyForModel(model: string, override?: string): string {
  if (override) return override;
  const separator = model.indexOf(':');
  const recipeId = separator > 0 ? model.slice(0, separator) : 'anthropic';
  return recipeId === 'anthropic' ? DEFAULT_RATE_KEY : `${recipeId}:chat`;
}
