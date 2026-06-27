import * as vscode from 'vscode';
import {
  DEFAULT_CONFIGURED_MODELS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL_EDIT_TOOLS,
  DEFAULT_RESERVED_OUTPUT_RATIO,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_TOKEN_SIDE_LIMIT,
  MODEL_VERSION_LABEL,
} from '../constants';
import { logger } from '../logging/outputChannelLogger';

export { MODEL_VERSION_LABEL, DEFAULT_CONFIGURED_MODELS };

export interface ModelCapabilities {
  toolCalling?: boolean | number;
  imageInput?: boolean;
  thinking?: boolean;
}

export type ReasoningEffortValue = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningEffortFormat = 'chat-completions' | 'responses';

export interface AIModelConfig {
  id: string;
  vendor: string;
  family: string;
  name: string;
  apiStyle?: string;
  apiType?: string;
  version?: string;
  enableExtraRequestWrapping?: boolean;
  /**
   * Maximum input context window size in tokens.
   */
  maxTokens: number;
  /**
   * Maximum input context window size in tokens.
   */
  maxInputTokens?: number;
  /**
   * Maximum output token budget exposed for this model.
   */
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  streaming?: boolean;
  editTools?: string[];
  supportsReasoningEffort?: ReasoningEffortValue[];
  reasoningEffortFormat?: ReasoningEffortFormat;
  zeroDataRetentionEnabled?: boolean;
  inputCost?: number;
  cacheCost?: number;
  outputCost?: number;
  longContextInputCost?: number;
  longContextCacheCost?: number;
  longContextOutputCost?: number;
  modelsDevEnriched?: boolean;
  description: string;
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageContentPart {
  type: 'image';
  mimeType: string;
  data: string;
}

export type ChatContentPart = ChatTextContentPart | ChatImageContentPart;
export type ChatMessageContent = string | ChatContentPart[];

export function normalizeHttpBaseUrl(value: string | undefined): string | undefined {
  const trimmed = (value || '').trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }

    let normalized = url.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return undefined;
  }
}

export function getCompactErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return sanitizeErrorMessage(error);
  }

  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return sanitizeErrorMessage(message);
    }
  }

  return sanitizeErrorMessage(String(error));
}

function sanitizeErrorMessage(value: string): string {
  const collapsed = value
    .replace(/\r/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')
    .trim();

  if (collapsed.length === 0) {
    return collapsed;
  }

  const detailedStackIndex = collapsed.search(/\s+at\s+[^\s]+\s+\((?:file:\/\/|node:|[A-Za-z]:\\)/i);
  if (detailedStackIndex >= 0) {
    return collapsed.slice(0, detailedStackIndex).trim();
  }

  const genericStackIndex = collapsed.search(/\s+at\s+[^\s]+\s+\(/);
  if (genericStackIndex >= 0 && /(LanguageModelError|Error:)/.test(collapsed.slice(0, genericStackIndex))) {
    return collapsed.slice(0, genericStackIndex).trim();
  }

  return collapsed;
}

function sanitizeUnresolvedPlaceholderText(value: string): string {
  return value.replace(/\{\d+\}/g, 'value');
}

const UNSUPPORTED_FORWARDED_TOOL_SCHEMA_KEYS = new Set([
  'defaultSnippets',
  'deprecationMessage',
  'doNotSuggest',
  'enumDescriptions',
  'errorMessage',
  'markdownDeprecationMessage',
  'markdownDescription',
  'markdownEnumDescriptions',
  'patternErrorMessage',
  'suggestSortText',
]);

function sanitizeToolMetadataValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeUnresolvedPlaceholderText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolMetadataValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !UNSUPPORTED_FORWARDED_TOOL_SCHEMA_KEYS.has(key))
        .map(([key, nestedValue]) => [key, sanitizeToolMetadataValue(nestedValue)]),
    );
  }

  return value;
}

function readRuntimeToolFunction(tool: vscode.LanguageModelChatTool): Record<string, unknown> | undefined {
  const runtimeFunction = (tool as unknown as { function?: unknown }).function;
  if (!runtimeFunction || typeof runtimeFunction !== 'object') {
    return undefined;
  }
  return runtimeFunction as Record<string, unknown>;
}

function readRuntimeToolName(tool: vscode.LanguageModelChatTool): string | undefined {
  if (typeof tool.name === 'string') {
    return tool.name;
  }

  const runtimeFunction = readRuntimeToolFunction(tool);
  return typeof runtimeFunction?.name === 'string' ? runtimeFunction.name : undefined;
}

function readRuntimeToolDescription(tool: vscode.LanguageModelChatTool): string | undefined {
  if (typeof tool.description === 'string') {
    return tool.description;
  }

  const runtimeFunction = readRuntimeToolFunction(tool);
  return typeof runtimeFunction?.description === 'string' ? runtimeFunction.description : undefined;
}

function readRuntimeToolInputSchema(tool: vscode.LanguageModelChatTool): unknown {
  if (tool.inputSchema) {
    return tool.inputSchema;
  }

  return readRuntimeToolFunction(tool)?.parameters;
}

export abstract class BaseLanguageModel implements vscode.LanguageModelChat {
  public readonly id: string;
  public readonly vendor: string;
  public readonly family: string;
  public readonly name: string;
  public readonly apiStyle?: string;
  public readonly apiType?: string;
  public readonly version: string;
  public readonly enableExtraRequestWrapping: boolean;
  public readonly maxTokens: number;
  public readonly maxInputTokens: number;
  public readonly maxOutputTokens: number;
  public readonly capabilities: vscode.LanguageModelChatCapabilities & { thinking?: boolean };
  public readonly streaming?: boolean;
  public readonly editTools: readonly string[];
  public readonly supportsReasoningEffort?: readonly ReasoningEffortValue[];
  public readonly reasoningEffortFormat?: ReasoningEffortFormat;
  public readonly zeroDataRetentionEnabled?: boolean;
  public readonly inputCost?: number;
  public readonly cacheCost?: number;
  public readonly outputCost?: number;
  public readonly longContextInputCost?: number;
  public readonly longContextCacheCost?: number;
  public readonly longContextOutputCost?: number;
  public readonly description: string;

  constructor(
    protected provider: BaseAIProvider,
    modelInfo: AIModelConfig,
  ) {
    this.id = modelInfo.id;
    this.vendor = modelInfo.vendor;
    this.family = modelInfo.family;
    this.name = modelInfo.name;
    this.apiStyle = typeof modelInfo.apiStyle === 'string' ? modelInfo.apiStyle : undefined;
    this.apiType = typeof modelInfo.apiType === 'string' ? modelInfo.apiType : undefined;
    this.version = modelInfo.version || MODEL_VERSION_LABEL;
    this.enableExtraRequestWrapping = modelInfo.enableExtraRequestWrapping !== false;
    this.maxTokens = Math.max(1, Math.floor(modelInfo.maxTokens));
    this.maxInputTokens = Math.max(1, Math.floor(modelInfo.maxInputTokens ?? DEFAULT_TOKEN_SIDE_LIMIT));
    this.maxOutputTokens = Math.max(1, Math.floor(modelInfo.maxOutputTokens ?? DEFAULT_TOKEN_SIDE_LIMIT));
    this.capabilities = modelInfo.capabilities ?? {
      toolCalling: true,
      imageInput: true,
    };
    this.streaming = modelInfo.streaming;
    this.editTools =
      modelInfo.editTools && modelInfo.editTools.length > 0 ? [...modelInfo.editTools] : [...DEFAULT_MODEL_EDIT_TOOLS];
    this.supportsReasoningEffort = modelInfo.supportsReasoningEffort;
    this.reasoningEffortFormat = modelInfo.reasoningEffortFormat;
    this.zeroDataRetentionEnabled = modelInfo.zeroDataRetentionEnabled;
    this.inputCost = modelInfo.inputCost;
    this.cacheCost = modelInfo.cacheCost;
    this.outputCost = modelInfo.outputCost;
    this.longContextInputCost = modelInfo.longContextInputCost;
    this.longContextCacheCost = modelInfo.longContextCacheCost;
    this.longContextOutputCost = modelInfo.longContextOutputCost;
    this.description = modelInfo.description;
  }

  abstract sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatResponse>;

  countTokens(text: string | vscode.LanguageModelChatMessage, _token?: vscode.CancellationToken): Promise<number> {
    return Promise.resolve(this.estimateTokenCount(text));
  }

  private estimateTokenCount(text: string | vscode.LanguageModelChatMessage): number {
    const content = typeof text === 'string' ? text : this.readChatMessageTokenEstimateSource(text);
    if (content.length === 0) {
      return 0;
    }
    // Match custom-endpoint style approximate local counting instead of reusing the previous response usage.
    return Math.max(1, Math.ceil(content.length / 4));
  }

  private readChatMessageTokenEstimateSource(message: vscode.LanguageModelChatMessage): string {
    const parts: string[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push(part.value);
        continue;
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        parts.push(part.name, JSON.stringify(part.input ?? {}));
        continue;
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        parts.push(this.estimateToolResultContent(part.content));
        continue;
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        parts.push(this.readTokenEstimateFromDataPart(part));
      }
    }
    return parts.join('\n');
  }

  private readTokenEstimateFromDataPart(part: vscode.LanguageModelDataPart): string {
    if (part.mimeType.startsWith('text/') || part.mimeType.includes('json')) {
      try {
        return new TextDecoder().decode(part.data);
      } catch {
        return '';
      }
    }
    if (part.mimeType.startsWith('image/')) {
      return '[image]';
    }
    return '';
  }

  private estimateToolResultContent(content: unknown[]): string {
    return content
      .map((part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
          return part.value;
        }
        if (part instanceof vscode.LanguageModelDataPart) {
          return this.readTokenEstimateFromDataPart(part);
        }
        if (part && typeof part === 'object' && 'value' in (part as Record<string, unknown>)) {
          const value = (part as { value?: unknown }).value;
          return typeof value === 'string' ? value : '';
        }
        return '';
      })
      .join('');
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: ChatMessageContent;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export const INTERNAL_REASONING_CONTENT_MIME_TYPE = 'application/vnd.coding-plans.reasoning-content+json';
export const NATIVE_USAGE_MIME_TYPE = 'usage';

interface GenericModelListEntry {
  id?: unknown;
  model?: unknown;
  name?: unknown;
  max_tokens?: unknown;
  context_length?: unknown;
  max_input_tokens?: unknown;
  max_output_tokens?: unknown;
  input_token_limit?: unknown;
  output_token_limit?: unknown;
  tool_calling?: unknown;
  function_calling?: unknown;
  image_input?: unknown;
  vision?: unknown;
  capabilities?:
    | {
        tool_calling?: unknown;
        function_calling?: unknown;
        image_input?: unknown;
        vision?: unknown;
      }
    | unknown;
}

interface ResolvedModelRuntimeSettings {
  maxTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean | number;
  imageInput: boolean;
}

export abstract class BaseAIProvider implements vscode.Disposable {
  protected models: BaseLanguageModel[];
  protected disposables: vscode.Disposable[] = [];
  protected readonly modelChangedEmitter = new vscode.EventEmitter<void>();
  private modelDiscoveryUnsupported = false;
  private apiKey = '';
  private apiKeyInitializationPromise: Promise<void> | undefined;
  public readonly onDidChangeModels = this.modelChangedEmitter.event;

  constructor(protected context: vscode.ExtensionContext) {
    this.models = [];
  }

  abstract getVendor(): string;
  abstract getConfigSection(): string;
  abstract getBaseUrl(): string;
  abstract getApiKey(): string;
  abstract getPredefinedModels(): AIModelConfig[];
  abstract convertMessages(messages: vscode.LanguageModelChatMessage[]): ChatMessage[];
  abstract sendRequest(request: any, token?: vscode.CancellationToken): Promise<vscode.LanguageModelChatResponse>;

  async initialize(): Promise<void> {
    if (!this.apiKeyInitializationPromise) {
      this.apiKeyInitializationPromise = this.initializeApiKeyFromSecret();
    }
    await this.apiKeyInitializationPromise;
  }

  async setApiKey(apiKey: string): Promise<void> {
    await this.initialize();
    const normalized = apiKey.trim();
    const secretKey = this.getApiKeySecretStorageKey();

    this.apiKey = normalized;
    if (normalized.length > 0) {
      await this.context.secrets.store(secretKey, normalized);
    } else {
      await this.context.secrets.delete(secretKey);
    }
  }

  protected readApiKey(): string {
    return this.apiKey;
  }

  async refreshModels(): Promise<void> {
    await this.initialize();
    const apiKey = this.getApiKey();

    if (!apiKey) {
      this.models = [];
      this.modelDiscoveryUnsupported = false;
      this.modelChangedEmitter.fire();
      return;
    }

    try {
      this.modelDiscoveryUnsupported = false;
      const resolvedModels = await this.resolveModelConfigs();
      this.models = resolvedModels.map((model) => this.createModel(model));
      logger.info(`${this.getVendor()} models refreshed`, { modelIds: this.models.map((m) => m.id) });
      this.modelChangedEmitter.fire();
    } catch (error: any) {
      logger.error(`Failed to refresh ${this.getVendor()} models`, error);
      this.models = [];
      this.modelChangedEmitter.fire();
    }
  }

  protected async resolveModelConfigs(): Promise<AIModelConfig[]> {
    return this.getPredefinedModels();
  }

  protected getConfiguredModelIds(): string[] {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const configured = config.get<string[]>('models', [...DEFAULT_CONFIGURED_MODELS]);
    const deduped = new Set<string>();
    const models: string[] = [];

    for (const rawModelId of configured) {
      if (typeof rawModelId !== 'string') {
        continue;
      }
      const modelId = rawModelId.trim();
      if (modelId.length === 0) {
        continue;
      }

      const dedupeKey = modelId.toLowerCase();
      if (deduped.has(dedupeKey)) {
        continue;
      }
      deduped.add(dedupeKey);
      models.push(modelId);
    }

    return models;
  }

  protected buildConfiguredModelConfigs(
    describe: (modelId: string) => string,
    fallbackFamily: string,
  ): AIModelConfig[] {
    const modelSettings = this.readModelSettingsById();
    return this.getConfiguredModelIds().map((modelId) =>
      this.buildModelConfig(modelId, undefined, describe, fallbackFamily, modelSettings),
    );
  }

  protected async resolveModelConfigsFromGenericModelApi(
    fetchPayload: () => Promise<unknown>,
    describe: (modelId: string) => string,
    fallbackFamily: string,
  ): Promise<AIModelConfig[]> {
    try {
      const payload = await fetchPayload();
      const discoveredModels = this.buildModelConfigsFromGenericPayload(payload, describe, fallbackFamily);
      if (discoveredModels.length > 0) {
        return discoveredModels;
      }
    } catch (error) {
      logger.warn(`Failed to fetch model list from generic API for ${this.getVendor()}`, error);
    }

    return this.buildConfiguredModelConfigs(describe, fallbackFamily);
  }

  protected buildModelConfigsFromGenericPayload(
    payload: unknown,
    describe: (modelId: string) => string,
    fallbackFamily: string,
  ): AIModelConfig[] {
    const modelSettings = this.readModelSettingsById();
    const deduped = new Set<string>();
    const models: AIModelConfig[] = [];
    const entries = this.readGenericModelEntries(payload);

    for (const entry of entries) {
      const modelId = this.readModelId(entry);
      if (!modelId || !this.isLikelyChatModel(modelId)) {
        continue;
      }

      const dedupeKey = modelId.toLowerCase();
      if (deduped.has(dedupeKey)) {
        continue;
      }
      deduped.add(dedupeKey);

      models.push(
        this.buildModelConfig(
          modelId,
          this.readRuntimeFromGenericModelEntry(entry),
          describe,
          fallbackFamily,
          modelSettings,
        ),
      );
    }

    return models;
  }

  protected inferModelFamily(modelId: string, fallbackFamily: string): string {
    const parts = modelId.split('-').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}-${parts[1]}`;
    }
    return parts[0] || fallbackFamily;
  }

  protected isLikelyChatModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return (
      !lower.includes('embedding') &&
      !lower.includes('rerank') &&
      !lower.includes('speech') &&
      !lower.includes('tts') &&
      !lower.includes('asr') &&
      !lower.includes('audio')
    );
  }

  private buildModelConfig(
    modelId: string,
    discovered: Partial<ResolvedModelRuntimeSettings> | undefined,
    describe: (modelId: string) => string,
    fallbackFamily: string,
    modelSettings: Map<string, Partial<ResolvedModelRuntimeSettings>>,
  ): AIModelConfig {
    const runtime = this.resolveModelRuntimeSettings(modelId, discovered, modelSettings);
    return {
      id: modelId,
      vendor: this.getVendor(),
      family: this.inferModelFamily(modelId, fallbackFamily),
      name: modelId,
      version: MODEL_VERSION_LABEL,
      maxTokens: runtime.maxTokens,
      maxInputTokens: runtime.maxInputTokens,
      maxOutputTokens: runtime.maxOutputTokens,
      capabilities: {
        toolCalling: runtime.toolCalling,
        imageInput: runtime.imageInput,
      },
      description: describe(modelId),
    };
  }

  private resolveModelRuntimeSettings(
    modelId: string,
    discovered: Partial<ResolvedModelRuntimeSettings> | undefined,
    modelSettings: Map<string, Partial<ResolvedModelRuntimeSettings>>,
  ): ResolvedModelRuntimeSettings {
    const override = modelSettings.get(modelId.toLowerCase());
    const resolvedTokens = this.resolveTokenWindowLimits(
      override?.maxTokens ?? discovered?.maxTokens,
      override?.maxInputTokens ?? discovered?.maxInputTokens,
      override?.maxOutputTokens ?? discovered?.maxOutputTokens,
    );
    const toolCalling = override?.toolCalling ?? discovered?.toolCalling ?? true;
    const imageInput = override?.imageInput ?? discovered?.imageInput ?? true;

    return {
      maxTokens: resolvedTokens.maxTokens,
      maxInputTokens: resolvedTokens.maxInputTokens,
      maxOutputTokens: resolvedTokens.maxOutputTokens,
      toolCalling,
      imageInput,
    };
  }

  protected resolveTokenWindowLimits(
    contextSize: number | undefined,
    explicitMaxInputTokens: number | undefined,
    explicitMaxOutputTokens: number | undefined,
  ): Pick<ResolvedModelRuntimeSettings, 'maxTokens' | 'maxInputTokens' | 'maxOutputTokens'> {
    const normalizeTokenValue = (value: number | undefined): number | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (!Number.isFinite(value) || value <= 0) {
        return undefined;
      }
      return Math.max(1, Math.floor(value));
    };

    const normalizedContextSize = normalizeTokenValue(contextSize);
    if (normalizedContextSize !== undefined) {
      const maxOutputTokens = Math.max(1, Math.floor(normalizedContextSize * DEFAULT_RESERVED_OUTPUT_RATIO));
      return {
        maxTokens: normalizedContextSize,
        maxInputTokens: Math.max(1, normalizedContextSize - maxOutputTokens),
        maxOutputTokens,
      };
    }

    const maxInputTokens = normalizeTokenValue(explicitMaxInputTokens) ?? DEFAULT_CONTEXT_WINDOW_SIZE;
    const maxOutputTokens = normalizeTokenValue(explicitMaxOutputTokens) ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    return {
      maxTokens: Math.max(1, maxInputTokens + maxOutputTokens),
      maxInputTokens,
      maxOutputTokens,
    };
  }

  private readModelSettingsById(): Map<string, Partial<ResolvedModelRuntimeSettings>> {
    const settingsByModel = new Map<string, Partial<ResolvedModelRuntimeSettings>>();
    const config = vscode.workspace.getConfiguration('coding-plans');
    const modelSettingsRaw = config.get<Record<string, unknown>>('modelSettings', {});

    if (!modelSettingsRaw || typeof modelSettingsRaw !== 'object') {
      return settingsByModel;
    }

    for (const [rawModelId, rawValue] of Object.entries(modelSettingsRaw)) {
      const modelId = rawModelId.trim().toLowerCase();
      if (modelId.length === 0 || !rawValue || typeof rawValue !== 'object') {
        continue;
      }

      const parsed = rawValue as {
        maxInputTokens?: unknown;
        maxOutputTokens?: unknown;
        contextSize?: unknown;
        capabilities?:
          | {
              tools?: unknown;
              vision?: unknown;
              toolCalling?: unknown;
              imageInput?: unknown;
            }
          | unknown;
      };

      const legacyContextSize = this.readPositiveInteger(parsed.contextSize);
      const maxInputTokens = this.readPositiveInteger(parsed.maxInputTokens);
      const maxOutputTokens = this.readPositiveInteger(parsed.maxOutputTokens);

      const capabilities =
        parsed.capabilities && typeof parsed.capabilities === 'object'
          ? (parsed.capabilities as {
              tools?: unknown;
              vision?: unknown;
              toolCalling?: unknown;
              imageInput?: unknown;
            })
          : undefined;

      const toolCalling = this.readToolCallingValue(capabilities?.toolCalling ?? capabilities?.tools);
      const imageInput = this.readBooleanValue(capabilities?.imageInput ?? capabilities?.vision);

      const normalized: Partial<ResolvedModelRuntimeSettings> = {};
      if (legacyContextSize !== undefined || maxInputTokens !== undefined || maxOutputTokens !== undefined) {
        const resolvedTokens = this.resolveTokenWindowLimits(legacyContextSize, maxInputTokens, maxOutputTokens);
        normalized.maxTokens = resolvedTokens.maxTokens;
        normalized.maxInputTokens = resolvedTokens.maxInputTokens;
        normalized.maxOutputTokens = resolvedTokens.maxOutputTokens;
      }
      if (toolCalling !== undefined) {
        normalized.toolCalling = toolCalling;
      }
      if (imageInput !== undefined) {
        normalized.imageInput = imageInput;
      }

      if (Object.keys(normalized).length > 0) {
        settingsByModel.set(modelId, normalized);
      }
    }

    return settingsByModel;
  }

  protected readGenericModelEntries(payload: unknown): GenericModelListEntry[] {
    if (Array.isArray(payload)) {
      return payload as GenericModelListEntry[];
    }

    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const maybeData = (payload as { data?: unknown }).data;
    if (Array.isArray(maybeData)) {
      return maybeData as GenericModelListEntry[];
    }

    const maybeModels = (payload as { models?: unknown }).models;
    if (Array.isArray(maybeModels)) {
      return maybeModels as GenericModelListEntry[];
    }

    return [];
  }

  protected readModelId(entry: GenericModelListEntry): string | undefined {
    const candidates = [entry.id, entry.model, entry.name];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const normalized = candidate.trim();
        if (normalized.length > 0) {
          return normalized;
        }
      }
    }
    return undefined;
  }

  protected readRuntimeFromGenericModelEntry(entry: GenericModelListEntry): Partial<ResolvedModelRuntimeSettings> {
    const maxTokens = this.pickPositiveInteger([entry.context_length, entry.max_tokens]);
    const maxInputTokens = this.pickPositiveInteger([entry.max_input_tokens, entry.input_token_limit]);
    const maxOutputTokens = this.pickPositiveInteger([entry.max_output_tokens, entry.output_token_limit]);
    const toolCalling = this.readToolCallingValue(
      this.readFromCapabilities(entry, 'tool_calling') ??
        this.readFromCapabilities(entry, 'function_calling') ??
        entry.tool_calling ??
        entry.function_calling,
    );
    const imageInput = this.readBooleanValue(
      this.readFromCapabilities(entry, 'image_input') ??
        this.readFromCapabilities(entry, 'vision') ??
        entry.image_input ??
        entry.vision,
    );

    const runtime: Partial<ResolvedModelRuntimeSettings> = {};
    if (maxTokens !== undefined) {
      runtime.maxTokens = maxTokens;
    }
    if (maxInputTokens !== undefined) {
      runtime.maxInputTokens = maxInputTokens;
    }
    if (maxOutputTokens !== undefined) {
      runtime.maxOutputTokens = maxOutputTokens;
    }
    if (toolCalling !== undefined) {
      runtime.toolCalling = toolCalling;
    }
    if (imageInput !== undefined) {
      runtime.imageInput = imageInput;
    }

    return runtime;
  }

  protected readFromCapabilities(
    entry: GenericModelListEntry,
    key: 'tool_calling' | 'function_calling' | 'image_input' | 'vision',
  ): unknown {
    if (!entry.capabilities || typeof entry.capabilities !== 'object') {
      return undefined;
    }
    return (entry.capabilities as Record<string, unknown>)[key];
  }

  protected readToolCallingValue(value: unknown): boolean | number | undefined {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
      const parsed = Number(normalized);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    return undefined;
  }

  protected readBooleanValue(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
      const parsed = Number(normalized);
      if (Number.isFinite(parsed)) {
        return parsed > 0;
      }
    }
    return undefined;
  }

  private pickPositiveInteger(values: unknown[]): number | undefined {
    for (const value of values) {
      const parsed = this.readPositiveInteger(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  }

  private readPositiveInteger(value: unknown): number | undefined {
    const parsed = this.readPositiveNumber(value);
    if (parsed === undefined) {
      return undefined;
    }
    return Math.floor(parsed);
  }

  private readPositiveNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return undefined;
  }

  protected abstract createModel(modelInfo: AIModelConfig): BaseLanguageModel;

  getAvailableModels(): BaseLanguageModel[] {
    return this.models;
  }

  isModelDiscoveryUnsupported(): boolean {
    return this.modelDiscoveryUnsupported;
  }

  protected setModelDiscoveryUnsupported(unsupported: boolean): void {
    this.modelDiscoveryUnsupported = unsupported;
  }

  private getApiKeySecretStorageKey(): string {
    return `${this.getConfigSection()}.apiKey`;
  }

  private async initializeApiKeyFromSecret(): Promise<void> {
    const secretKey = this.getApiKeySecretStorageKey();
    const stored = await this.context.secrets.get(secretKey);
    this.apiKey = (stored || '').trim();
  }

  getModel(modelId: string): BaseLanguageModel | undefined {
    return this.models.find((m) => m.id === modelId);
  }

  protected toChatRole(role: vscode.LanguageModelChatMessageRole | string): 'user' | 'assistant' | 'system' {
    if (role === vscode.LanguageModelChatMessageRole.User || role === 'user') {
      return 'user';
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant || role === 'assistant') {
      return 'assistant';
    }
    return 'system';
  }

  protected readMessageContent(
    content: string | ReadonlyArray<vscode.LanguageModelInputPart | ChatContentPart | unknown>,
  ): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'type' in part && (part as { type?: unknown }).type === 'text') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') {
            return text;
          }
        }

        if (part instanceof vscode.LanguageModelTextPart) {
          return part.value;
        }

        if (part && typeof part === 'object' && 'value' in part) {
          const value = (part as { value?: unknown }).value;
          if (typeof value === 'string') {
            return value;
          }
        }

        return '';
      })
      .join('');
  }

  public toProviderMessages(messages: vscode.LanguageModelChatMessage[]): ChatMessage[] {
    const normalized: ChatMessage[] = [];

    for (const message of messages) {
      const contentParts: ChatContentPart[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      const toolResults: vscode.LanguageModelToolResultPart[] = [];
      let reasoningContent: string | undefined;

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          contentParts.push({ type: 'text', text: part.value });
        } else if (this.isThinkingPart(part)) {
          const thinkingText = this.readThinkingPartContent(part);
          if (thinkingText) {
            reasoningContent = thinkingText;
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push(part);
        } else if (part instanceof vscode.LanguageModelDataPart) {
          const encodedReasoningContent = this.readReasoningContentPart(part);
          if (encodedReasoningContent) {
            reasoningContent = encodedReasoningContent;
            continue;
          }
          const contentPart = this.readDataPartContent(part);
          if (contentPart) {
            contentParts.push(contentPart);
          }
        } else if (part && typeof part === 'object' && 'value' in part) {
          const value = (part as { value?: unknown }).value;
          if (typeof value === 'string') {
            contentParts.push({ type: 'text', text: value });
          }
        }
      }

      const content = this.compactMessageContent(contentParts);
      const textContent = this.readMessageContent(content);

      if (toolResults.length > 0) {
        for (const result of toolResults) {
          normalized.push({
            role: 'tool',
            tool_call_id: result.callId,
            content: this.stringifyToolResultContent(result.content),
          });
        }
        if (textContent.trim().length > 0) {
          normalized.push({
            role: 'user',
            content: textContent,
          });
        }
        continue;
      }

      if (toolCalls.length > 0) {
        normalized.push({
          role: 'assistant',
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          tool_calls: toolCalls.map((call) => ({
            id: call.callId || this.makeToolCallId(),
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {}),
            },
          })),
        });
        continue;
      }

      const role = this.toChatRole(message.role);
      normalized.push({
        role,
        content,
        ...(role === 'assistant' && reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
    }

    return normalized;
  }

  public buildToolDefinitions(options?: vscode.LanguageModelChatRequestOptions): ChatToolDefinition[] | undefined {
    if (!options?.tools || options.tools.length === 0) {
      return undefined;
    }

    return options.tools.map((tool) => {
      const name = readRuntimeToolName(tool);
      if (!name || name.trim().length === 0) {
        throw new Error('Invalid language model tool definition: missing tool name');
      }
      const sanitizedDescription = sanitizeToolMetadataValue(readRuntimeToolDescription(tool));
      const inputSchema = readRuntimeToolInputSchema(tool) ?? {
        type: 'object',
        properties: {},
        additionalProperties: true,
      };

      return {
        type: 'function',
        function: {
          name,
          description: typeof sanitizedDescription === 'string' ? sanitizedDescription : undefined,
          parameters: sanitizeToolMetadataValue(inputSchema) as object,
        },
      };
    });
  }

  public buildToolChoice(options?: vscode.LanguageModelChatRequestOptions): 'auto' | 'required' | undefined {
    if (!options?.tools || options.tools.length === 0) {
      return undefined;
    }

    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      return 'required';
    }

    return 'auto';
  }

  public buildResponseParts(
    content: string,
    toolCalls?: ChatToolCall[],
    reasoningContent?: string,
  ): Array<vscode.LanguageModelResponsePart | unknown> {
    const parts: Array<vscode.LanguageModelResponsePart | unknown> = [];

    if (content.trim().length > 0) {
      parts.push(new vscode.LanguageModelTextPart(content));
    }

    const trimmedReasoningContent = reasoningContent?.trim();
    if (trimmedReasoningContent) {
      parts.push(this.createReasoningResponsePart(trimmedReasoningContent));
    }

    for (const toolCall of toolCalls ?? []) {
      const name = toolCall.function?.name;
      if (!name) {
        continue;
      }

      parts.push(
        new vscode.LanguageModelToolCallPart(
          toolCall.id || this.makeToolCallId(),
          name,
          this.parseToolArguments(toolCall.function.arguments),
        ),
      );
    }

    return parts;
  }

  public createUsageResponsePart(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    outputBuffer?: number;
  }): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
      new TextEncoder().encode(
        JSON.stringify({
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
          ...(usage.outputBuffer === undefined ? {} : { output_buffer: usage.outputBuffer }),
        }),
      ),
      NATIVE_USAGE_MIME_TYPE,
    );
  }

  private readDataPartContent(part: vscode.LanguageModelDataPart): ChatContentPart | undefined {
    try {
      const decoder = new TextDecoder();
      if (part.mimeType === NATIVE_USAGE_MIME_TYPE) {
        return undefined;
      }
      if (part.mimeType.startsWith('text/') || part.mimeType.includes('json')) {
        return { type: 'text', text: decoder.decode(part.data) };
      }
      if (part.mimeType.startsWith('image/')) {
        return {
          type: 'image',
          mimeType: part.mimeType,
          data: this.encodeBase64(part.data),
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private compactMessageContent(parts: ChatContentPart[]): ChatMessageContent {
    const hasImage = parts.some((part) => part.type === 'image');
    if (!hasImage) {
      return parts
        .filter((part): part is ChatTextContentPart => part.type === 'text')
        .map((part) => part.text)
        .join('');
    }

    return parts.filter((part) => part.type === 'image' || part.text.length > 0);
  }

  private encodeBase64(data: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(data).toString('base64');
    }

    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  private createReasoningDataPart(reasoningContent: string): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
      new TextEncoder().encode(JSON.stringify({ reasoning_content: reasoningContent })),
      INTERNAL_REASONING_CONTENT_MIME_TYPE,
    );
  }

  private createReasoningResponsePart(reasoningContent: string): vscode.LanguageModelDataPart | unknown {
    const thinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: any[]) => unknown })
      .LanguageModelThinkingPart;
    if (thinkingCtor) {
      return new thinkingCtor(reasoningContent);
    }
    return this.createReasoningDataPart(reasoningContent);
  }

  private readReasoningContentPart(part: vscode.LanguageModelDataPart): string | undefined {
    if (part.mimeType !== INTERNAL_REASONING_CONTENT_MIME_TYPE) {
      return undefined;
    }

    try {
      const decoded = new TextDecoder().decode(part.data);
      const parsed = JSON.parse(decoded) as { reasoning_content?: unknown };
      return typeof parsed.reasoning_content === 'string' && parsed.reasoning_content.trim().length > 0
        ? parsed.reasoning_content
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isThinkingPart(part: unknown): boolean {
    const thinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: any[]) => unknown })
      .LanguageModelThinkingPart;
    if (thinkingCtor && part instanceof thinkingCtor) {
      return true;
    }
    return (
      !!part &&
      typeof part === 'object' &&
      (part as { constructor?: { name?: string } }).constructor?.name === 'FakeLanguageModelThinkingPart'
    );
  }

  private readThinkingPartContent(part: unknown): string | undefined {
    if (!part || typeof part !== 'object') {
      return undefined;
    }
    const value = (part as { value?: unknown }).value;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const joined = value.filter((entry): entry is string => typeof entry === 'string').join('');
      return joined.trim().length > 0 ? joined : undefined;
    }
    return undefined;
  }

  private stringifyToolResultContent(
    content: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown
    >,
  ): string {
    const resultParts = content
      .map((part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
          return part.value;
        }
        if (part instanceof vscode.LanguageModelDataPart) {
          const contentPart = this.readDataPartContent(part);
          return contentPart?.type === 'text' ? contentPart.text : '';
        }
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .filter((part) => part.length > 0);

    return resultParts.join('\n');
  }

  private parseToolArguments(rawArgs: string): object {
    if (!rawArgs) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object') {
        return parsed as object;
      }
      return { value: parsed };
    } catch {
      return { raw: rawArgs };
    }
  }

  private makeToolCallId(): string {
    return `tool_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.modelChangedEmitter.dispose();
  }
}
