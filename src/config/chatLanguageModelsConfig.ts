import { VendorApiStyle, VendorConfig, VendorModelConfig } from './configStore';

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
export const CHAT_LANGUAGE_MODELS_FIXED_MAX_OUTPUT_TOKENS = 100000;
export const CHAT_LANGUAGE_MODELS_FIXED_SUPPORTS_REASONING_EFFORT = ['xhigh', 'high', 'max'];

const CHAT_LANGUAGE_MODELS_API_PATH_BY_TYPE: Record<
  'chat-completions' | 'responses' | 'messages',
  string
> = {
  'chat-completions': '/chat/completions',
  responses: '/responses',
  messages: '/messages',
};

export function toChatLanguageModelsApiType(
  apiStyle: VendorApiStyle | undefined,
  apiType: VendorModelConfig['apiType'],
): 'chat-completions' | 'responses' | 'messages' {
  if (apiType === 'responses') {
    return 'responses';
  }
  if (apiType === 'anthropic') {
    return 'messages';
  }
  if (apiStyle === 'openai-responses') {
    return 'responses';
  }
  if (apiStyle === 'anthropic') {
    return 'messages';
  }
  return 'chat-completions';
}

/**
 * 将扩展内的 baseUrl 解析为 chatLanguageModels.json 模型级完整 endpoint URL。
 * VS Code customendpoint 对模型 url 的语义是完整请求地址：若未包含显式 API 路径
 * （/chat/completions、/responses、/messages），会按 apiType 自动补路径，可能与
 * 扩展运行时使用的地址不一致。因此这里显式拼出完整 endpoint，与运行时保持一致。
 */
export function resolveChatLanguageModelsModelUrl(
  baseUrl: string,
  apiType: 'chat-completions' | 'responses' | 'messages',
): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (normalized.length === 0) {
    return baseUrl;
  }
  const apiPath = CHAT_LANGUAGE_MODELS_API_PATH_BY_TYPE[apiType];
  if (normalized.toLowerCase().endsWith(apiPath)) {
    return normalized;
  }
  return `${normalized}${apiPath}`;
}

function toChatLanguageModelsReasoningEffortFormat(
  apiType: 'chat-completions' | 'responses' | 'messages',
): 'chat-completions' | 'responses' | 'messages' {
  return apiType;
}

/**
 * 将扩展内部的 vendor+model 配置转换为 chatLanguageModels.json 的模型对象。
 * 字段按字母序排列，与 VS Code 保存 chatLanguageModels.json 时的顺序一致；
 * maxOutputTokens/editTools/supportsReasoningEffort/zeroDataRetentionEnabled 使用固定值。
 */
export function toChatLanguageModelsModelConfig(
  vendor: VendorConfig,
  model: VendorModelConfig,
): ChatLanguageModelsModelConfig {
  const apiType = toChatLanguageModelsApiType(model.apiStyle ?? vendor.defaultApiStyle, model.apiType);
  const config: ChatLanguageModelsModelConfig = {
    apiType,
    id: model.name,
    name: model.name,
    url: resolveChatLanguageModelsModelUrl(vendor.baseUrl, apiType),
  };

  if (model.contextSize !== undefined) {
    config.contextWindow = model.contextSize;
  }
  config.editTools = [...CHAT_LANGUAGE_MODELS_FIXED_EDIT_TOOLS];
  config.maxOutputTokens = CHAT_LANGUAGE_MODELS_FIXED_MAX_OUTPUT_TOKENS;
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
