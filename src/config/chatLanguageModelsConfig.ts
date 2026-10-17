import type { VendorApiStyle, VendorConfig, VendorModelConfig } from './configStore';
import { resolveModelBudget } from '../providers/contextBudget';

/**
 * chatLanguageModels.json 模型级配置对象。
 * 字段与 VS Code 官方 Model configuration reference 对齐。
 */
export interface ChatLanguageModelsModelConfig {
  apiType?: 'chat-completions' | 'responses' | 'messages';
  contextWindow?: number;
  editTools?: string[];
  id: string;
  maxOutputTokens?: number;
  name: string;
  reasoningEffortFormat?: 'chat-completions' | 'responses' | 'messages';
  streaming?: boolean;
  supportsReasoningEffort?: string[];
  thinking?: boolean;
  toolCalling?: boolean;
  url: string;
  vision?: boolean;
  zeroDataRetentionEnabled?: boolean;
}

/** 固定输出值：拷贝到 chatLanguageModels.json 时使用的模型属性。 */
export const CHAT_LANGUAGE_MODELS_FIXED_EDIT_TOOLS = ['apply-patch', 'find-replace', 'multi-find-replace'];
export const CHAT_LANGUAGE_MODELS_FIXED_SUPPORTS_REASONING_EFFORT = ['xhigh', 'high', 'max'];

export function toChatLanguageModelsApiType(
  apiStyle: VendorApiStyle | undefined,
): 'chat-completions' | 'responses' | 'messages' {
  return apiStyle ?? 'chat-completions';
}

/**
 * 将扩展内的 baseUrl 解析为 chatLanguageModels.json 模型级 url。
 * 直接使用供应商原始配置（如 http://100.64.0.14:34046/v1），仅做尾斜杠规范化，
 * 不擅自追加 /chat/completions、/responses、/messages 等路径。
 */
export function resolveChatLanguageModelsModelUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized.length === 0 ? baseUrl : normalized;
}

function toChatLanguageModelsReasoningEffortFormat(
  apiType: 'chat-completions' | 'responses' | 'messages',
): 'chat-completions' | 'responses' | 'messages' {
  return apiType;
}

/**
 * 将扩展内部的 vendor+model 配置转换为 chatLanguageModels.json 的模型对象。
 * 字段按字母序排列，与 VS Code 保存 chatLanguageModels.json 时的顺序一致；
 * token 声明与运行时共享预算解析，模型能力保持原值。
 */
export function toChatLanguageModelsModelConfig(
  vendor: VendorConfig,
  model: VendorModelConfig,
): ChatLanguageModelsModelConfig {
  const apiType = toChatLanguageModelsApiType(model.apiStyle ?? vendor.defaultApiStyle);
  const budget = resolveModelBudget(model, model.contextBudget);
  const config: ChatLanguageModelsModelConfig = {
    apiType,
    id: model.name,
    name: model.name,
    url: resolveChatLanguageModelsModelUrl(vendor.baseUrl),
  };

  config.contextWindow = budget.effectiveContextWindow;
  config.editTools = [...CHAT_LANGUAGE_MODELS_FIXED_EDIT_TOOLS];
  config.maxOutputTokens = budget.outputTokens;
  config.reasoningEffortFormat = toChatLanguageModelsReasoningEffortFormat(apiType);
  if (model.streaming !== undefined) {
    config.streaming = model.streaming;
  }
  config.supportsReasoningEffort = [...CHAT_LANGUAGE_MODELS_FIXED_SUPPORTS_REASONING_EFFORT];
  if (typeof model.capabilities?.thinking === 'boolean') {
    config.thinking = model.capabilities.thinking;
  }
  if (typeof model.capabilities?.tools === 'boolean') {
    config.toolCalling = model.capabilities.tools;
  }
  if (typeof model.capabilities?.vision === 'boolean') {
    config.vision = model.capabilities.vision;
  }
  config.zeroDataRetentionEnabled = true;

  return config;
}

/** 序列化为可直接粘贴到 chatLanguageModels.json 的 JSON 字符串。 */
export function serializeChatLanguageModelsModelConfig(config: ChatLanguageModelsModelConfig): string {
  return JSON.stringify(config, null, 2);
}
