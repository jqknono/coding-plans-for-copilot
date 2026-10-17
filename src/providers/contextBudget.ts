import {
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
} from '../constants';

export type ModelLimitSource = 'models.dev' | 'endpoint' | 'configured';

/** 模型能力上限，与用户选择的预算分离。 */
export interface ModelLimits {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limitSource?: ModelLimitSource;
}

export interface ContextBudgetPolicy {
  inputTokens?: number;
  outputTokens?: number;
  presets?: readonly number[];
}

export interface ResolvedModelBudget {
  readonly inputCeiling: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly effectiveContextWindow: number;
  readonly modelContextWindow?: number;
  readonly presets: readonly number[];
  readonly adjustments: readonly string[];
}

export function readPositiveTokenInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 纯预算计算：先预留输出，再在总窗口和输入能力内分配输入，入参保持原值。 */
export function resolveModelBudget(limits: ModelLimits, policy: ContextBudgetPolicy = {}): ResolvedModelBudget {
  const contextWindow = readPositiveTokenInteger(limits.contextWindow);
  if (contextWindow !== undefined && contextWindow < 2) {
    throw new Error('上下文总容量至少为 2 tokens，以分别预留输入和输出。');
  }
  const adjustments: string[] = [];
  const requestedOutput = readPositiveTokenInteger(policy.outputTokens) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  const outputTokens = Math.min(
    requestedOutput,
    readPositiveTokenInteger(limits.maxOutputTokens) ?? Number.MAX_SAFE_INTEGER,
    contextWindow === undefined ? Number.MAX_SAFE_INTEGER - 1 : contextWindow - 1,
  );
  const inputCeiling = Math.min(
    readPositiveTokenInteger(limits.maxInputTokens) ?? contextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE,
    contextWindow === undefined ? Number.MAX_SAFE_INTEGER - outputTokens : contextWindow - outputTokens,
  );
  const requestedInput = readPositiveTokenInteger(policy.inputTokens) ?? DEFAULT_CONTEXT_WINDOW_SIZE;
  const inputTokens = Math.min(requestedInput, inputCeiling);
  if (requestedInput > inputTokens) {
    adjustments.push('输入预算已按当前模型能力收紧，原始配置保持原值。');
  }
  if (requestedOutput > outputTokens) {
    adjustments.push('输出预算已按当前模型能力收紧，原始配置保持原值。');
  }
  const candidates = policy.presets ?? [32000, 64000, 128000, 256000, 512000];
  const presets = Object.freeze(
    [...new Set([
      ...candidates.filter((value) => readPositiveTokenInteger(value) !== undefined && value <= inputCeiling),
      inputTokens,
      inputCeiling,
    ])].sort((a, b) => a - b),
  );
  return Object.freeze({
    inputCeiling,
    inputTokens,
    outputTokens,
    effectiveContextWindow: inputTokens + outputTokens,
    modelContextWindow: contextWindow,
    presets,
    adjustments: Object.freeze(adjustments),
  });
}

/** 请求入口捕获选择；显式值须落在已声明的服务上限内。 */
export function resolveRequestBudget(budget: ResolvedModelBudget, selectedInput?: unknown): ResolvedModelBudget {
  if (selectedInput === undefined) {
    return budget;
  }
  const inputTokens = readPositiveTokenInteger(selectedInput);
  if (inputTokens === undefined || inputTokens > budget.inputCeiling) {
    throw new Error(`上下文输入预算应为 1 至 ${budget.inputCeiling} 的整数，请重新选择上下文大小。`);
  }
  return Object.freeze({ ...budget, inputTokens, effectiveContextWindow: inputTokens + budget.outputTokens });
}
