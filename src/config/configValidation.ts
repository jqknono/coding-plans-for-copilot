import type { ContextBudgetPolicy } from '../providers/contextBudget';

export type VendorApiStyle = 'chat-completions' | 'responses' | 'messages';
export type VendorAuthType = 'bearer' | 'x-api-key';
export type ReasoningEffortValue = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningEffortFormat = 'chat-completions' | 'responses';

export interface VendorModelPriceConfig {
  inputCost?: number;
  cacheCost?: number;
  outputCost?: number;
  longContextInputCost?: number;
  longContextCacheCost?: number;
  longContextOutputCost?: number;
}

export interface VendorModelConfig {
  name: string;
  enabled?: boolean;
  description?: string;
  apiStyle?: VendorApiStyle;
  capabilities?: { tools?: boolean; vision?: boolean; thinking?: boolean };
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextBudget?: ContextBudgetPolicy;
  limitSource?: 'configured' | 'endpoint' | 'models.dev';
  streaming?: boolean;
  editTools?: string[];
  supportsReasoningEffort?: ReasoningEffortValue[];
  reasoningEffortFormat?: ReasoningEffortFormat;
  zeroDataRetentionEnabled?: boolean;
  price?: VendorModelPriceConfig;
}

export interface VendorConfig {
  name: string;
  baseUrl: string;
  authType?: VendorAuthType;
  usageUrl?: string;
  defaultApiStyle: VendorApiStyle;
  useModelsEndpoint: boolean;
  defaultVision: boolean;
  models: VendorModelConfig[];
}

export interface VendorValidationError {
  /** 根配置错误使用 -1；厂商与模型索引对应原始数组。 */
  vendorIndex: number;
  /** 使用位置标签，诊断始终省略配置原值。 */
  vendorName: string;
  field: string;
  reason: string;
  modelIndex?: number;
  path?: string;
}

export type ValidatedVendor = Omit<VendorConfig, 'defaultApiStyle' | 'defaultVision' | 'models'> & {
  defaultApiStyle?: VendorApiStyle;
  defaultVision?: boolean;
  models: VendorModelConfig[];
};

interface Rule {
  kind: 'string' | 'boolean' | 'number' | 'object' | 'array';
  required?: boolean;
  nonEmpty?: boolean;
  minimum?: number;
  integer?: boolean;
  values?: readonly string[];
  fields?: Readonly<Record<string, Rule>>;
  item?: Rule;
}

const text: Rule = { kind: 'string' };
const nonEmptyText: Rule = { kind: 'string', nonEmpty: true };
const boolean: Rule = { kind: 'boolean' };
const integer = (minimum: number): Rule => ({ kind: 'number', integer: true, minimum });
const enumeration = (...values: string[]): Rule => ({ kind: 'string', values });
const object = (fields: Record<string, Rule>): Rule => ({ kind: 'object', fields });
const array = (item: Rule): Rule => ({ kind: 'array', item });
const apiStyle = enumeration('chat-completions', 'responses', 'messages');
const cost: Rule = { kind: 'number', minimum: 0 };

const modelRule = object({
  name: { ...nonEmptyText, required: true },
  enabled: boolean,
  description: text,
  apiStyle,
  capabilities: object({ tools: boolean, vision: boolean, thinking: boolean }),
  contextWindow: integer(2),
  maxInputTokens: integer(1),
  maxOutputTokens: integer(1),
  contextBudget: object({ inputTokens: integer(1), outputTokens: integer(1), presets: array(integer(1)) }),
  limitSource: enumeration('configured', 'endpoint', 'models.dev'),
  streaming: boolean,
  editTools: array(nonEmptyText),
  supportsReasoningEffort: array(enumeration('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  reasoningEffortFormat: enumeration('chat-completions', 'responses'),
  zeroDataRetentionEnabled: boolean,
  price: object({
    inputCost: cost,
    cacheCost: cost,
    outputCost: cost,
    longContextInputCost: cost,
    longContextCacheCost: cost,
    longContextOutputCost: cost,
  }),
});

const vendorRule = object({
  name: { ...nonEmptyText, required: true },
  baseUrl: { ...nonEmptyText, required: true },
  useModelsEndpoint: { ...boolean, required: true },
  authType: enumeration('bearer', 'x-api-key'),
  usageUrl: nonEmptyText,
  defaultApiStyle: apiStyle,
  defaultVision: boolean,
  models: array(modelRule),
});

/** 与当前 manifest 的保留设置对齐；同一规则同时提供根键与嵌套键白名单。 */
const rootRule = object({
  logLevel: enumeration('trace', 'debug', 'info', 'warn', 'error', 'off'),
  locale: enumeration('', 'zh-CN', 'en-US'),
  autoRefreshModels: boolean,
  terminalIntent: object({ enabled: boolean, maxEntries: integer(1) }),
  commitMessage: object({
    showGenerateCommand: boolean,
    language: enumeration('en', 'zh-cn'),
    useRecentCommitStyle: boolean,
    modelVendor: text,
    modelId: text,
    options: object({
      prompt: text,
      maxDiffLines: integer(1),
      pipelineMode: enumeration('single', 'two-stage', 'auto'),
      summaryTriggerLines: integer(1),
      summaryChunkLines: integer(1),
      summaryMaxChunks: integer(1),
      maxBodyBulletCount: integer(2),
      subjectMaxLength: integer(20),
      requireConventionalType: boolean,
      warnOnValidationFailure: boolean,
      llmMaxPromptLength: integer(500),
    }),
  }),
  vendors: array(vendorRule),
});

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 转义控制字符与方向控制字符；键用于定位，值始终留在调用方。 */
function fieldPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `${parent}.${key}`;
  }
  const escaped = JSON.stringify(key).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${parent}[${escaped}]`;
}

type Location = Pick<VendorValidationError, 'vendorIndex' | 'modelIndex'>;

function addError(errors: VendorValidationError[], location: Location, path: string, reason: string): void {
  errors.push({
    ...location,
    vendorName: location.vendorIndex < 0 ? 'coding-plans' : `#${location.vendorIndex + 1}`,
    field: path,
    path,
    reason,
  });
}

function validate(value: unknown, rule: Rule, path: string, location: Location, errors: VendorValidationError[]): void {
  if (value === undefined) {
    if (rule.required) {
      addError(errors, location, path, '字段为必填项');
    }
    return;
  }
  if (rule.kind === 'object') {
    if (!isConfigObject(value)) {
      addError(errors, location, path, '应为对象');
      return;
    }
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(rule.fields, key)) {
        addError(errors, location, fieldPath(path, key), '未知字段，请按当前配置结构修正');
      }
    }
    for (const [key, child] of Object.entries(rule.fields!)) {
      validate(
        Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined,
        child,
        fieldPath(path, key),
        location,
        errors,
      );
    }
    return;
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(value)) {
      addError(errors, location, path, '应为数组');
      return;
    }
    for (let index = 0; index < value.length; index++) {
      // 数组元素始终为必填值，稀疏数组也遵循同一规则。
      validate(value[index], { ...rule.item!, required: true }, `${path}[${index}]`, location, errors);
    }
    return;
  }
  if (typeof value !== rule.kind) {
    addError(errors, location, path, `应为 ${rule.kind} 类型`);
  } else if (typeof value === 'string') {
    if (rule.nonEmpty && value.trim().length === 0) {
      addError(errors, location, path, '应为有效文本');
    } else if (rule.values && !rule.values.includes(value)) {
      addError(errors, location, path, `允许值：${rule.values.join(' / ')}`);
    }
  } else if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (rule.integer && !Number.isSafeInteger(value)) || value < (rule.minimum ?? -Infinity))
  ) {
    addError(
      errors,
      location,
      path,
      rule.integer ? `应为至少 ${rule.minimum} 的安全整数` : `应为至少 ${rule.minimum} 的有限数值`,
    );
  }
}

/** 调用方可使用类型守卫校验发现结果，避免非法数据参与写回。 */
export function isValidModelConfig(value: unknown): value is VendorModelConfig {
  const errors: VendorValidationError[] = [];
  validate(value, { ...modelRule, required: true }, 'model', { vendorIndex: -1 }, errors);
  return errors.length === 0;
}

export function isVendorApiStyle(value: unknown): value is VendorApiStyle {
  return typeof value === 'string' && apiStyle.values!.includes(value);
}

/** 仅验证并隔离：厂商错误跳过厂商，模型错误仅跳过对应模型。 */
export function validateVendorConfiguration(raw: unknown): {
  vendors: ValidatedVendor[];
  errors: VendorValidationError[];
} {
  const vendors: ValidatedVendor[] = [];
  const errors: VendorValidationError[] = [];
  if (!Array.isArray(raw)) {
    addError(errors, { vendorIndex: -1 }, 'coding-plans.vendors', '应为数组');
    return { vendors, errors };
  }
  for (let vendorIndex = 0; vendorIndex < raw.length; vendorIndex++) {
    const value: unknown = raw[vendorIndex];
    const path = `coding-plans.vendors[${vendorIndex}]`;
    const start = errors.length;
    // models 的数组形状属于厂商，数组成员交由模型级校验。
    const header = isConfigObject(value) && Array.isArray(value.models) ? { ...value, models: [] } : value;
    validate(header, { ...vendorRule, required: true }, path, { vendorIndex }, errors);
    if (errors.length > start || !isConfigObject(value)) {
      continue;
    }
    const models: VendorModelConfig[] = [];
    const rawModels = (value.models ?? []) as unknown[];
    for (let modelIndex = 0; modelIndex < rawModels.length; modelIndex++) {
      const model = rawModels[modelIndex];
      const before = errors.length;
      validate(
        model,
        { ...modelRule, required: true },
        `${path}.models[${modelIndex}]`,
        { vendorIndex, modelIndex },
        errors,
      );
      if (errors.length === before) {
        models.push(model as VendorModelConfig);
      }
    }
    vendors.push({ ...value, models } as ValidatedVendor);
  }
  return { vendors, errors };
}

/** 根验证独立于厂商过滤，接受 VS Code 的嵌套表示和点分设置键。 */
export function validateRootConfiguration(raw: unknown): VendorValidationError[] {
  const errors: VendorValidationError[] = [];
  if (!isConfigObject(raw)) {
    addError(errors, { vendorIndex: -1 }, 'coding-plans', '应为对象');
    return errors;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'vendors') {
      continue;
    }
    let rule: Rule | undefined = rootRule;
    let path = 'coding-plans';
    for (const part of key.split('.')) {
      path = fieldPath(path, part);
      rule = rule?.fields && Object.prototype.hasOwnProperty.call(rule.fields, part) ? rule.fields[part] : undefined;
    }
    if (rule) {
      validate(value, rule, path, { vendorIndex: -1 }, errors);
    } else {
      addError(errors, { vendorIndex: -1 }, path, '未知字段，请按当前配置结构修正');
    }
  }
  return errors;
}

/** 用于 get/inspect 的已知对象与叶子路径，直接从规则派生。 */
export function getRootConfigurationKeys(): string[] {
  const collect = (rule: Rule, prefix: string): string[] =>
    rule.kind === 'object'
      ? [
          ...(prefix ? [prefix] : []),
          ...Object.entries(rule.fields!).flatMap(([key, child]) => collect(child, prefix ? `${prefix}.${key}` : key)),
        ]
      : [prefix];
  return collect(rootRule, '');
}
