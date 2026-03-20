import { RESPONSE_USAGE_FIELD } from '../constants';

export interface NormalizedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  outputBuffer?: number;
}

export type SupportedUsageProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';

type NumericUsageRecord = Record<string, unknown>;

export function normalizeTokenUsage(
  protocol: SupportedUsageProtocol,
  usage: NumericUsageRecord | undefined,
  outputBuffer?: number
): NormalizedTokenUsage | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const promptTokens = protocol === 'openai-chat'
    ? readNonNegativeInteger(usage.prompt_tokens)
    : readNonNegativeInteger(usage.input_tokens);
  const completionTokens = protocol === 'openai-chat'
    ? readNonNegativeInteger(usage.completion_tokens)
    : readNonNegativeInteger(usage.output_tokens);
  const explicitTotalTokens = protocol === 'anthropic'
    ? undefined
    : readNonNegativeInteger(usage.total_tokens);

  if (promptTokens === undefined && completionTokens === undefined && explicitTotalTokens === undefined) {
    return undefined;
  }

  const normalizedPromptTokens = promptTokens ?? 0;
  const normalizedTotalTokens = explicitTotalTokens ?? (normalizedPromptTokens + (completionTokens ?? 0));
  const normalizedCompletionTokens = Math.max(
    normalizedTotalTokens - normalizedPromptTokens,
    0
  );
  const normalizedOutputBuffer = readNonNegativeInteger(outputBuffer);

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: normalizedTotalTokens,
    outputBuffer: normalizedOutputBuffer
  };
}

export function attachTokenUsage(
  target: Record<string, unknown>,
  usage: NormalizedTokenUsage | undefined
): Record<string, unknown> {
  if (!usage) {
    return target;
  }

  target.promptTokens = usage.promptTokens;
  target.completionTokens = usage.completionTokens;
  target.totalTokens = usage.totalTokens;
  target.outputBuffer = usage.outputBuffer;
  target[RESPONSE_USAGE_FIELD] = usage;
  return target;
}

export function readAttachedTokenUsage(source: unknown): NormalizedTokenUsage | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const record = source as Record<string, unknown>;
  const attachedUsage = record[RESPONSE_USAGE_FIELD];
  if (attachedUsage && typeof attachedUsage === 'object') {
    return normalizeAttachedUsage(attachedUsage as Record<string, unknown>);
  }

  return normalizeAttachedUsage(record);
}

function normalizeAttachedUsage(record: Record<string, unknown>): NormalizedTokenUsage | undefined {
  const promptTokens = readNonNegativeInteger(record.promptTokens);
  const completionTokens = readNonNegativeInteger(record.completionTokens);
  const totalTokens = readNonNegativeInteger(record.totalTokens);
  const outputBuffer = readNonNegativeInteger(record.outputBuffer);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  const normalizedPromptTokens = promptTokens ?? 0;
  const normalizedTotalTokens = totalTokens ?? (normalizedPromptTokens + (completionTokens ?? 0));
  const normalizedCompletionTokens = Math.max(
    normalizedTotalTokens - normalizedPromptTokens,
    0
  );

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: normalizedTotalTokens,
    outputBuffer
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}
