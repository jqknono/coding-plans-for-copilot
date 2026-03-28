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

  const promptTokens = readPromptTokens(protocol, usage);
  const completionTokens = readCompletionTokens(protocol, usage);
  const explicitTotalTokens = readExplicitTotalTokens(protocol, usage, promptTokens, completionTokens);

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

function readPromptTokens(protocol: SupportedUsageProtocol, usage: NumericUsageRecord): number | undefined {
  if (protocol === 'openai-chat') {
    return readNonNegativeInteger(usage.prompt_tokens);
  }

  if (protocol === 'anthropic') {
    return readNonNegativeInteger(usage.prompt_tokens)
      ?? readAnthropicEffectiveInputTokens(usage)
      ?? readNonNegativeInteger(usage.input_tokens);
  }

  return readNonNegativeInteger(usage.input_tokens);
}

function readCompletionTokens(protocol: SupportedUsageProtocol, usage: NumericUsageRecord): number | undefined {
  if (protocol === 'openai-chat') {
    return readNonNegativeInteger(usage.completion_tokens);
  }

  if (protocol === 'anthropic') {
    return readNonNegativeInteger(usage.completion_tokens)
      ?? readNonNegativeInteger(usage.output_tokens);
  }

  return readNonNegativeInteger(usage.output_tokens);
}

function readExplicitTotalTokens(
  protocol: SupportedUsageProtocol,
  usage: NumericUsageRecord,
  promptTokens: number | undefined,
  completionTokens: number | undefined
): number | undefined {
  const totalTokens = readNonNegativeInteger(usage.total_tokens);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  if (protocol !== 'anthropic') {
    return undefined;
  }

  const effectivePromptTokens = readAnthropicEffectiveInputTokens(usage) ?? promptTokens;
  if (effectivePromptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }

  return (effectivePromptTokens ?? 0) + (completionTokens ?? 0);
}

function readAnthropicEffectiveInputTokens(usage: NumericUsageRecord): number | undefined {
  const promptTokens = readNonNegativeInteger(usage.prompt_tokens);
  if (promptTokens !== undefined) {
    return promptTokens;
  }

  const directInputTokens = readNonNegativeInteger(usage.input_tokens);
  const cacheCreationInputTokens = readNonNegativeInteger(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadInputTokens = readNonNegativeInteger(usage.cache_read_input_tokens) ?? 0;

  if (directInputTokens === undefined && cacheCreationInputTokens === 0 && cacheReadInputTokens === 0) {
    return undefined;
  }

  return (directInputTokens ?? 0) + cacheCreationInputTokens + cacheReadInputTokens;
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
