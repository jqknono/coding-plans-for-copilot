import * as vscode from 'vscode';
import {
  DEFAULT_CONFIGURED_MODELS,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_TOKEN_SIDE_LIMIT,
  MODEL_VERSION_LABEL,
  resolveImplicitReservedOutputTokens
} from '../constants';
import { logger } from '../logging/outputChannelLogger';

export { MODEL_VERSION_LABEL, DEFAULT_CONFIGURED_MODELS };

export interface ModelCapabilities {
  toolCalling?: boolean | number;
  imageInput?: boolean;
}

export interface AIModelConfig {
  id: string;
  vendor: string;
  family: string;
  name: string;
  apiStyle?: string;
  version?: string;
  /**
   * Total context window size in tokens.
   */
  maxTokens: number;
  /**
   * @deprecated Prefer the model total context window instead of per-direction limits when configuring models.
   */
  maxInputTokens?: number;
  /**
   * @deprecated Prefer the model total context window instead of per-direction limits when configuring models.
   */
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
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
    .map(part => part.trim())
    .filter(part => part.length > 0)
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

function sanitizeToolMetadataValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeUnresolvedPlaceholderText(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeToolMetadataValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, sanitizeToolMetadataValue(nestedValue)])
    );
  }

  return value;
}
export abstract class BaseLanguageModel implements vscode.LanguageModelChat {
  public readonly id: string;
  public readonly vendor: string;
  public readonly family: string;
  public readonly name: string;
  public readonly apiStyle?: string;
  public readonly version: string;
  public readonly maxTokens: number;
  public readonly maxInputTokens: number;
  public readonly maxOutputTokens: number;
  public readonly capabilities: vscode.LanguageModelChatCapabilities;
  public readonly description: string;

  constructor(
    protected provider: BaseAIProvider,
    modelInfo: AIModelConfig
  ) {
    this.id = modelInfo.id;
    this.vendor = modelInfo.vendor;
    this.family = modelInfo.family;
    this.name = modelInfo.name;
    this.apiStyle = typeof modelInfo.apiStyle === 'string' ? modelInfo.apiStyle : undefined;
    this.version = modelInfo.version || MODEL_VERSION_LABEL;
    this.maxTokens = Math.max(1, Math.floor(modelInfo.maxTokens));
    this.maxInputTokens = Math.max(1, Math.floor(modelInfo.maxInputTokens ?? DEFAULT_TOKEN_SIDE_LIMIT));
    this.maxOutputTokens = Math.max(1, Math.floor(modelInfo.maxOutputTokens ?? DEFAULT_TOKEN_SIDE_LIMIT));
    this.capabilities = modelInfo.capabilities ?? {
      toolCalling: true,
      imageInput: true
    };
    this.description = modelInfo.description;
  }

  abstract sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse>;

  countTokens(
    _text: string | vscode.LanguageModelChatMessage,
    _token?: vscode.CancellationToken
  ): Promise<number> {
    // Local token counting is intentionally disabled. Usage is sourced only from upstream API responses.
    return Promise.resolve(0);
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

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
  capabilities?: {
    tool_calling?: unknown;
    function_calling?: unknown;
    image_input?: unknown;
    vision?: unknown;
  } | unknown;
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
      this.models = resolvedModels.map(model => this.createModel(model));
      logger.info(`${this.getVendor()} models refreshed`, { modelIds: this.models.map(m => m.id) });
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
    fallbackFamily: string
  ): AIModelConfig[] {
    const modelSettings = this.readModelSettingsById();
    return this.getConfiguredModelIds().map(modelId => this.buildModelConfig(
      modelId,
      undefined,
      describe,
      fallbackFamily,
      modelSettings
    ));
  }

  protected async resolveModelConfigsFromGenericModelApi(
    fetchPayload: () => Promise<unknown>,
    describe: (modelId: string) => string,
    fallbackFamily: string
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
    fallbackFamily: string
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

      models.push(this.buildModelConfig(
        modelId,
        this.readRuntimeFromGenericModelEntry(entry),
        describe,
        fallbackFamily,
        modelSettings
      ));
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
    return !lower.includes('embedding')
      && !lower.includes('rerank')
      && !lower.includes('speech')
      && !lower.includes('tts')
      && !lower.includes('asr')
      && !lower.includes('audio');
  }

  private buildModelConfig(
    modelId: string,
    discovered: Partial<ResolvedModelRuntimeSettings> | undefined,
    describe: (modelId: string) => string,
    fallbackFamily: string,
    modelSettings: Map<string, Partial<ResolvedModelRuntimeSettings>>
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
        imageInput: runtime.imageInput
      },
      description: describe(modelId)
    };
  }

  private resolveModelRuntimeSettings(
    modelId: string,
    discovered: Partial<ResolvedModelRuntimeSettings> | undefined,
    modelSettings: Map<string, Partial<ResolvedModelRuntimeSettings>>
  ): ResolvedModelRuntimeSettings {
    const override = modelSettings.get(modelId.toLowerCase());
    const resolvedTokens = this.resolveTokenWindowLimits(
      override?.maxTokens ?? discovered?.maxTokens,
      override?.maxInputTokens ?? discovered?.maxInputTokens,
      override?.maxOutputTokens ?? discovered?.maxOutputTokens
    );
    const toolCalling = override?.toolCalling ?? discovered?.toolCalling ?? true;
    const imageInput = override?.imageInput ?? discovered?.imageInput ?? true;

    return {
      maxTokens: resolvedTokens.maxTokens,
      maxInputTokens: resolvedTokens.maxInputTokens,
      maxOutputTokens: resolvedTokens.maxOutputTokens,
      toolCalling,
      imageInput
    };
  }

  protected resolveTokenWindowLimits(
    totalContextWindow: number | undefined,
    explicitMaxInputTokens: number | undefined,
    explicitMaxOutputTokens: number | undefined
  ): Pick<ResolvedModelRuntimeSettings, 'maxTokens' | 'maxInputTokens' | 'maxOutputTokens'> {
    const hasExplicitTotalContextWindow = totalContextWindow !== undefined;
    const fallbackTotal = Math.max(2, Math.floor(totalContextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE));
    const defaultReservedOutputTokens = resolveImplicitReservedOutputTokens(fallbackTotal);
    const normalizeTokenValue = (value: number | undefined): number | undefined => {
      if (value === undefined) {
        return undefined;
      }
      const normalized = Math.max(1, Math.floor(value));
      return hasExplicitTotalContextWindow ? Math.min(normalized, fallbackTotal) : normalized;
    };
    const maxInputTokens = normalizeTokenValue(explicitMaxInputTokens);
    const maxOutputTokens = normalizeTokenValue(explicitMaxOutputTokens);

    if (maxInputTokens !== undefined && maxOutputTokens !== undefined) {
      return {
        maxTokens: hasExplicitTotalContextWindow ? fallbackTotal : Math.max(fallbackTotal, maxInputTokens + maxOutputTokens),
        maxInputTokens,
        maxOutputTokens
      };
    }

    if (maxInputTokens !== undefined) {
      const derivedMaxOutputTokens = hasExplicitTotalContextWindow
        ? Math.max(1, fallbackTotal - maxInputTokens)
        : defaultReservedOutputTokens;
      return {
        maxTokens: Math.max(maxInputTokens + derivedMaxOutputTokens, hasExplicitTotalContextWindow ? fallbackTotal : 0),
        maxInputTokens,
        maxOutputTokens: derivedMaxOutputTokens
      };
    }

    if (maxOutputTokens !== undefined) {
      const derivedMaxInputTokens = hasExplicitTotalContextWindow
        ? Math.max(1, fallbackTotal - maxOutputTokens)
        : Math.max(1, DEFAULT_CONTEXT_WINDOW_SIZE - maxOutputTokens);
      return {
        maxTokens: Math.max(derivedMaxInputTokens + maxOutputTokens, hasExplicitTotalContextWindow ? fallbackTotal : 0),
        maxInputTokens: derivedMaxInputTokens,
        maxOutputTokens
      };
    }

    const derivedMaxOutputTokens = defaultReservedOutputTokens;
    const derivedMaxInputTokens = Math.max(1, fallbackTotal - derivedMaxOutputTokens);
    return {
      maxTokens: derivedMaxInputTokens + derivedMaxOutputTokens,
      maxInputTokens: derivedMaxInputTokens,
      maxOutputTokens: derivedMaxOutputTokens
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
        capabilities?: {
          tools?: unknown;
          vision?: unknown;
          toolCalling?: unknown;
          imageInput?: unknown;
        } | unknown;
      };

      const legacyContextWindow = this.readPositiveInteger(parsed.contextSize);
      const maxInputTokens = this.readPositiveInteger(parsed.maxInputTokens);
      const maxOutputTokens = this.readPositiveInteger(parsed.maxOutputTokens);

      const capabilities = parsed.capabilities && typeof parsed.capabilities === 'object'
        ? parsed.capabilities as {
          tools?: unknown;
          vision?: unknown;
          toolCalling?: unknown;
          imageInput?: unknown;
        }
        : undefined;

      const toolCalling = this.readToolCallingValue(capabilities?.toolCalling ?? capabilities?.tools);
      const imageInput = this.readBooleanValue(capabilities?.imageInput ?? capabilities?.vision);

      const normalized: Partial<ResolvedModelRuntimeSettings> = {};
      if (legacyContextWindow !== undefined || maxInputTokens !== undefined || maxOutputTokens !== undefined) {
        const resolvedTokens = this.resolveTokenWindowLimits(legacyContextWindow, maxInputTokens, maxOutputTokens);
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
    const maxTokens = this.pickPositiveInteger([
      entry.context_length,
      entry.max_tokens
    ]);
    const maxInputTokens = this.pickPositiveInteger([
      entry.max_input_tokens,
      entry.input_token_limit
    ]);
    const maxOutputTokens = this.pickPositiveInteger([
      entry.max_output_tokens,
      entry.output_token_limit
    ]);
    const toolCalling = this.readToolCallingValue(
      this.readFromCapabilities(entry, 'tool_calling')
      ?? this.readFromCapabilities(entry, 'function_calling')
      ?? entry.tool_calling
      ?? entry.function_calling
    );
    const imageInput = this.readBooleanValue(
      this.readFromCapabilities(entry, 'image_input')
      ?? this.readFromCapabilities(entry, 'vision')
      ?? entry.image_input
      ?? entry.vision
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

  protected readFromCapabilities(entry: GenericModelListEntry, key: 'tool_calling' | 'function_calling' | 'image_input' | 'vision'): unknown {
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
    return this.models.find(m => m.id === modelId);
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

  protected readMessageContent(content: string | ReadonlyArray<vscode.LanguageModelInputPart | unknown>): string {
    if (typeof content === 'string') {
      return content;
    }

    return content.map(part => {
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
    }).join('');
  }

  public toProviderMessages(messages: vscode.LanguageModelChatMessage[]): ChatMessage[] {
    const normalized: ChatMessage[] = [];

    for (const message of messages) {
      const textParts: string[] = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      const toolResults: vscode.LanguageModelToolResultPart[] = [];

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push(part);
        } else if (part instanceof vscode.LanguageModelDataPart) {
          textParts.push(this.readDataPartContent(part));
        } else if (part && typeof part === 'object' && 'value' in part) {
          const value = (part as { value?: unknown }).value;
          if (typeof value === 'string') {
            textParts.push(value);
          }
        }
      }

      const textContent = textParts.join('');

      if (toolResults.length > 0) {
        for (const result of toolResults) {
          normalized.push({
            role: 'tool',
            tool_call_id: result.callId,
            content: this.stringifyToolResultContent(result.content)
          });
        }
        if (textContent.trim().length > 0) {
          normalized.push({
            role: 'user',
            content: textContent
          });
        }
        continue;
      }

      if (toolCalls.length > 0) {
        normalized.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls.map(call => ({
            id: call.callId || this.makeToolCallId(),
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {})
            }
          }))
        });
        continue;
      }

      normalized.push({
        role: this.toChatRole(message.role),
        content: textContent
      });
    }

    return normalized;
  }

  public buildToolDefinitions(
    options?: vscode.LanguageModelChatRequestOptions
  ): ChatToolDefinition[] | undefined {
    if (!options?.tools || options.tools.length === 0) {
      return undefined;
    }

    return options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: typeof sanitizeToolMetadataValue(tool.description) === 'string'
          ? sanitizeToolMetadataValue(tool.description) as string
          : undefined,
        parameters: sanitizeToolMetadataValue(tool.inputSchema || {
          type: 'object',
          properties: {},
          additionalProperties: true
        }) as object
      }
    }));
  }

  public buildToolChoice(
    options?: vscode.LanguageModelChatRequestOptions
  ): 'auto' | 'required' | undefined {
    if (!options?.tools || options.tools.length === 0) {
      return undefined;
    }

    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      return 'required';
    }

    return 'auto';
  }

  public buildResponseParts(content: string, toolCalls?: ChatToolCall[]): vscode.LanguageModelResponsePart[] {
    const parts: vscode.LanguageModelResponsePart[] = [];

    if (content.trim().length > 0) {
      parts.push(new vscode.LanguageModelTextPart(content));
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
          this.parseToolArguments(toolCall.function.arguments)
        )
      );
    }

    return parts;
  }

  private readDataPartContent(part: vscode.LanguageModelDataPart): string {
    try {
      const decoder = new TextDecoder();
      if (part.mimeType.startsWith('text/') || part.mimeType.includes('json')) {
        return decoder.decode(part.data);
      }
      return '';
    } catch {
      return '';
    }
  }

  private stringifyToolResultContent(content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>): string {
    const resultParts = content.map(part => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part instanceof vscode.LanguageModelDataPart) {
        return this.readDataPartContent(part);
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }).filter(part => part.length > 0);

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
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.modelChangedEmitter.dispose();
  }
}

