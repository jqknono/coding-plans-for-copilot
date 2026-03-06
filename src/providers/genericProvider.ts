import * as vscode from 'vscode';
import {
  BaseAIProvider,
  BaseLanguageModel,
  AIModelConfig,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  getCompactErrorMessage,
  normalizeHttpBaseUrl
} from './baseProvider';
import { ConfigStore, VendorConfig, VendorModelConfig } from '../config/configStore';
import { getMessage } from '../i18n/i18n';
import { logger } from '../logging/outputChannelLogger';

interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: 'auto' | 'required';
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatResponse {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface GenericChatRequest {
  modelId: string;
  messages: vscode.LanguageModelChatMessage[];
  options?: vscode.LanguageModelChatRequestOptions;
  capabilities: vscode.LanguageModelChatCapabilities;
}

interface ModelVendorMapping {
  vendor: VendorConfig;
  modelName: string;
}

interface ModelDiscoveryResult {
  models: AIModelConfig[];
  failed: boolean;
  status?: number;
}

interface VendorDiscoveryState {
  signature: string;
  suppressRetry: boolean;
  cachedModels: AIModelConfig[];
}

interface RefreshModelsOptions {
  forceDiscoveryRetry?: boolean;
}

const DEFAULT_CONTEXT_SIZE = 200000;
const DEFAULT_CONTEXT_WINDOW_SIZE = 400000;
const DEFAULT_MAX_TOKENS = 4000;
const DEFAULT_MODEL_TOOLS = true;
const DEFAULT_MODEL_VISION = true;
const NON_RETRYABLE_DISCOVERY_STATUS_CODES = new Set([400, 401, 403, 404]);

export class GenericLanguageModel extends BaseLanguageModel {
  constructor(provider: BaseAIProvider, modelInfo: AIModelConfig) {
    super(provider, modelInfo);
  }

  async sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const provider = this.provider as GenericAIProvider;
    const request: GenericChatRequest = {
      modelId: this.id,
      messages,
      options,
      capabilities: this.capabilities
    };

    try {
      return await provider.sendRequest(request, token);
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        throw error;
      }
      throw new vscode.LanguageModelError(getMessage('requestFailed', getCompactErrorMessage(error)));
    }
  }
}

export class GenericAIProvider extends BaseAIProvider {
  private modelVendorMap = new Map<string, ModelVendorMapping>();
  private readonly vendorDiscoveryState = new Map<string, VendorDiscoveryState>();
  private refreshModelsInFlight: Promise<void> | undefined;
  private refreshModelsPending = false;
  private forceDiscoveryRetryRequested = false;

  constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore
  ) {
    super(context);
    this.disposables.push(
      this.configStore.onDidChange(() => void this.refreshModels())
    );
  }

  async initialize(): Promise<void> {
    await this.refreshModels();
  }

  getVendor(): string {
    return 'coding-plans';
  }

  getConfigSection(): string {
    return 'coding-plans';
  }

  getBaseUrl(): string {
    const vendors = this.configStore.getVendors();
    return vendors[0]?.baseUrl || '';
  }

  getApiKey(): string {
    return this.configStore.getVendors().length > 0 ? 'configured' : '';
  }

  async setApiKey(_apiKey: string): Promise<void> {
    // Per-vendor API keys are managed via configStore.setApiKey(vendorName, apiKey)
  }

  getPredefinedModels(): AIModelConfig[] {
    return [];
  }

  convertMessages(messages: vscode.LanguageModelChatMessage[]): ChatMessage[] {
    return this.toProviderMessages(messages);
  }

  async refreshModels(options: RefreshModelsOptions = {}): Promise<void> {
    if (options.forceDiscoveryRetry) {
      this.forceDiscoveryRetryRequested = true;
    }

    if (this.refreshModelsInFlight) {
      this.refreshModelsPending = true;
      return this.refreshModelsInFlight;
    }

    const running = (async () => {
      do {
        const forceDiscoveryRetry = this.forceDiscoveryRetryRequested;
        this.forceDiscoveryRetryRequested = false;
        this.refreshModelsPending = false;
        await this.refreshModelsInternal({ forceDiscoveryRetry });
      } while (this.refreshModelsPending || this.forceDiscoveryRetryRequested);
    })();

    this.refreshModelsInFlight = running;
    try {
      await running;
    } finally {
      if (this.refreshModelsInFlight === running) {
        this.refreshModelsInFlight = undefined;
      }
    }
  }

  private async refreshModelsInternal(options: RefreshModelsOptions = {}): Promise<void> {
    const forceDiscoveryRetry = options.forceDiscoveryRetry === true;
    const vendors = this.configStore.getVendors();
    logger.info('Refreshing Coding Plans vendor models', { vendorCount: vendors.length });
    this.modelVendorMap.clear();
    const allModelConfigs: AIModelConfig[] = [];
    const activeVendorKeys = new Set(vendors.map(vendor => this.toVendorStateKey(vendor.name)));

    for (const vendorKey of Array.from(this.vendorDiscoveryState.keys())) {
      if (!activeVendorKeys.has(vendorKey)) {
        this.vendorDiscoveryState.delete(vendorKey);
      }
    }

    for (const vendor of vendors) {
      if (!vendor.baseUrl) {
        logger.warn('Skip vendor with empty baseUrl', { vendor: vendor.name });
        continue;
      }
      const vendorKey = this.toVendorStateKey(vendor.name);
      const configuredModels = this.buildConfiguredModelsForVendor(vendor);
      logger.info('Evaluating vendor models', {
        vendor: vendor.name,
        useModelsEndpoint: vendor.useModelsEndpoint,
        configuredCount: configuredModels.length
      });

      if (!vendor.useModelsEndpoint) {
        this.vendorDiscoveryState.delete(vendorKey);
        logger.info('Using settings models for vendor', {
          vendor: vendor.name,
          modelCount: configuredModels.length
        });
        this.appendResolvedModels(vendor, configuredModels, allModelConfigs);
        continue;
      }

      const apiKey = await this.configStore.getApiKey(vendor.name);
      if (!apiKey) {
        this.vendorDiscoveryState.delete(vendorKey);
        logger.warn('Missing API key; falling back to settings models', {
          vendor: vendor.name,
          fallbackCount: configuredModels.length
        });
        this.appendResolvedModels(vendor, configuredModels, allModelConfigs);
        continue;
      }

      const signature = this.buildVendorDiscoverySignature(vendor, apiKey);
      const previousState = this.vendorDiscoveryState.get(vendorKey);

      if (previousState && previousState.signature === signature && previousState.suppressRetry && !forceDiscoveryRetry) {
        const cached = previousState.cachedModels.length > 0 ? previousState.cachedModels : configuredModels;
        logger.warn('Using cached/settings models because discovery retry is suppressed', {
          vendor: vendor.name,
          cachedCount: previousState.cachedModels.length,
          fallbackCount: configuredModels.length,
          resolvedCount: cached.length
        });
        this.appendResolvedModels(vendor, cached, allModelConfigs);
        continue;
      }

      if (previousState && previousState.signature === signature && previousState.suppressRetry && forceDiscoveryRetry) {
        logger.info('Force refresh bypassed suppressed discovery retry', { vendor: vendor.name });
      }

      const discovered = await this.discoverModelsFromApi(vendor, apiKey);
      if (discovered.failed) {
        const fallbackModels =
          previousState && previousState.signature === signature && previousState.cachedModels.length > 0
            ? previousState.cachedModels
            : configuredModels;
        logger.warn('Model discovery failed; using fallback models', {
          vendor: vendor.name,
          status: discovered.status,
          cachedCount: previousState?.cachedModels.length ?? 0,
          configuredCount: configuredModels.length,
          resolvedCount: fallbackModels.length
        });
        this.vendorDiscoveryState.set(vendorKey, {
          signature,
          suppressRetry: this.shouldSuppressDiscoveryRetry(discovered.status),
          cachedModels: fallbackModels
        });
        this.appendResolvedModels(vendor, fallbackModels, allModelConfigs);
        continue;
      }

      // When useModelsEndpoint is enabled, discovered model names are the source of truth.
      // Runtime/token/capability overrides from settings are preserved per model.
      const discoveredVendorModels = this.toVendorModelConfigs(discovered.models);
      const mergedVendorModels = this.mergeConfiguredModelOverrides(vendor.models, discoveredVendorModels, vendor.defaultVision);
      const resolvedModels = this.buildConfiguredModelsFromVendorModels(vendor, mergedVendorModels);
      const discoveredSignature = this.buildVendorDiscoverySignature({ ...vendor, models: mergedVendorModels }, apiKey);
      logger.info('Using /models discovery results for vendor', {
        vendor: vendor.name,
        discoveredCount: discovered.models.length,
        normalizedCount: discoveredVendorModels.length,
        mergedCount: mergedVendorModels.length
      });

      try {
        await this.configStore.updateVendorModels(vendor.name, mergedVendorModels);
      } catch (error) {
        logger.warn(`Failed to update models config for ${vendor.name}.`, error);
      }

      this.vendorDiscoveryState.set(vendorKey, {
        signature: discoveredSignature,
        suppressRetry: false,
        cachedModels: resolvedModels
      });
      this.appendResolvedModels(vendor, resolvedModels, allModelConfigs);
    }

    this.models = allModelConfigs.map(m => this.createModel(m));
    logger.info('Coding Plans models refreshed', { modelIds: this.models.map(m => m.id) });
    this.modelChangedEmitter.fire();
  }

  async sendRequest(
    request: GenericChatRequest,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const mapping = this.modelVendorMap.get(request.modelId);
    if (!mapping) {
      throw new vscode.LanguageModelError(getMessage('vendorNotConfigured'));
    }

    const baseUrl = normalizeHttpBaseUrl(mapping.vendor.baseUrl);
    if (!baseUrl) {
      throw new vscode.LanguageModelError(getMessage('baseUrlInvalid'));
    }

    const apiKey = await this.configStore.getApiKey(mapping.vendor.name);
    if (!apiKey) {
      throw new vscode.LanguageModelError(getMessage('apiKeyRequired', mapping.vendor.name));
    }

    return this.sendOpenAIRequest(request, mapping.modelName, baseUrl, apiKey, token);
  }

  protected createModel(modelInfo: AIModelConfig): BaseLanguageModel {
    return new GenericLanguageModel(this, modelInfo);
  }

  private buildModelFromVendorConfig(
    model: VendorModelConfig,
    vendor: VendorConfig,
    compositeId: string
  ): AIModelConfig {
    const maxInputTokens = model.maxInputTokens ?? DEFAULT_CONTEXT_SIZE;
    const maxOutputTokens = model.maxOutputTokens ?? DEFAULT_CONTEXT_SIZE;
    const configuredContextSize = model.contextSize ?? DEFAULT_CONTEXT_WINDOW_SIZE;
    const contextSize = Math.max(configuredContextSize, maxInputTokens, maxOutputTokens);
    const toolCalling = model.capabilities?.tools ?? DEFAULT_MODEL_TOOLS;
    const imageInput = model.capabilities?.vision ?? DEFAULT_MODEL_VISION;

    return {
      id: compositeId,
      vendor: 'coding-plans',
      family: vendor.name,
      name: model.name,
      version: vendor.name,
      maxTokens: contextSize,
      contextSize,
      maxInputTokens,
      maxOutputTokens,
      capabilities: { toolCalling, imageInput },
      description: model.description || getMessage('genericDynamicModelDescription', vendor.name, model.name)
    };
  }

  private buildConfiguredModelsForVendor(vendor: VendorConfig): AIModelConfig[] {
    return this.buildConfiguredModelsFromVendorModels(vendor, vendor.models);
  }

  private buildConfiguredModelsFromVendorModels(vendor: VendorConfig, vendorModels: VendorModelConfig[]): AIModelConfig[] {
    const models: AIModelConfig[] = [];
    for (const model of vendorModels) {
      const compositeId = `${vendor.name}/${model.name}`;
      models.push(this.buildModelFromVendorConfig(model, vendor, compositeId));
    }
    return models;
  }

  private appendResolvedModels(
    vendor: VendorConfig,
    models: AIModelConfig[],
    target: AIModelConfig[]
  ): void {
    for (const model of models) {
      const actualName = model.id.includes('/') ? model.id.substring(model.id.indexOf('/') + 1) : model.id;
      this.modelVendorMap.set(model.id, { vendor, modelName: actualName });
    }
    target.push(...models);
  }

  private async discoverModelsFromApi(vendor: VendorConfig, apiKey: string): Promise<ModelDiscoveryResult> {
    try {
      const baseUrl = normalizeHttpBaseUrl(vendor.baseUrl);
      if (!baseUrl) {
        return { models: [], failed: false };
      }

      const response = await this.fetchJson<any>(`${baseUrl}/models`, {
        method: 'GET',
        ...this.buildRequestInit(apiKey)
      });
      const data = response.data;
      const entries: any[] = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];

      const models: AIModelConfig[] = [];
      const seen = new Set<string>();

      for (const entry of entries) {
        const modelId =
          typeof entry.id === 'string' ? entry.id.trim() :
          typeof entry.model === 'string' ? entry.model.trim() :
          typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!modelId || seen.has(modelId.toLowerCase())) {
          continue;
        }
        if (!this.isLikelyChatModel(modelId)) {
          continue;
        }
        seen.add(modelId.toLowerCase());

        const compositeId = `${vendor.name}/${modelId}`;
        models.push({
          id: compositeId,
          vendor: 'coding-plans',
          family: vendor.name,
          name: modelId,
          version: vendor.name,
          maxTokens: DEFAULT_CONTEXT_WINDOW_SIZE,
          contextSize: DEFAULT_CONTEXT_WINDOW_SIZE,
          maxInputTokens: DEFAULT_CONTEXT_SIZE,
          maxOutputTokens: DEFAULT_CONTEXT_SIZE,
          capabilities: { toolCalling: DEFAULT_MODEL_TOOLS },
          description: getMessage('genericDynamicModelDescription', vendor.name, modelId)
        });
      }

      return { models, failed: false };
    } catch (error) {
      logger.warn(`Failed to discover models from ${vendor.name}`, error);
      return {
        models: [],
        failed: true,
        status: typeof (error as { response?: { status?: unknown } })?.response?.status === 'number'
          ? ((error as { response: { status: number } }).response.status)
          : undefined
      };
    }
  }

  private shouldSuppressDiscoveryRetry(status: number | undefined): boolean {
    return typeof status === 'number' && NON_RETRYABLE_DISCOVERY_STATUS_CODES.has(status);
  }

  private toVendorModelConfigs(discoveredModels: AIModelConfig[]): VendorModelConfig[] {
    const normalized: VendorModelConfig[] = [];
    const seen = new Set<string>();

    for (const model of discoveredModels) {
      const discovered = this.toVendorModelConfig(model);
      if (!discovered) {
        continue;
      }

      const key = discovered.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      normalized.push(discovered);
    }

    return normalized;
  }

  private toVendorModelConfig(model: AIModelConfig): VendorModelConfig | undefined {
    const name = model.name.trim();
    if (name.length === 0) {
      return undefined;
    }

    const toolCalling = model.capabilities?.toolCalling;
    const tools = typeof toolCalling === 'number' ? toolCalling > 0 : (toolCalling ?? DEFAULT_MODEL_TOOLS);
    const imageInput = model.capabilities?.imageInput;
    const vision = typeof imageInput === 'boolean' ? imageInput : undefined;
    const contextSize = this.readPositiveTokenInteger(model.contextSize ?? model.maxTokens);

    return {
      name,
      description: model.description?.trim() || undefined,
      contextSize,
      maxInputTokens: this.readPositiveTokenInteger(model.maxInputTokens) ?? DEFAULT_CONTEXT_SIZE,
      maxOutputTokens: this.readPositiveTokenInteger(model.maxOutputTokens) ?? DEFAULT_CONTEXT_SIZE,
      capabilities: {
        tools,
        vision
      }
    };
  }

  private mergeConfiguredModelOverrides(
    currentModels: VendorModelConfig[],
    discoveredModels: VendorModelConfig[],
    defaultVisionForNewModels: boolean
  ): VendorModelConfig[] {
    const configuredByName = new Map<string, VendorModelConfig>();
    for (const model of currentModels) {
      const key = model.name.trim().toLowerCase();
      if (!key || configuredByName.has(key)) {
        continue;
      }
      configuredByName.set(key, model);
    }

    return discoveredModels.map(discovered => {
      const configured = configuredByName.get(discovered.name.trim().toLowerCase());
      if (!configured) {
        const discoveredVision = discovered.capabilities?.vision;
        if (typeof discoveredVision === 'boolean') {
          return discovered;
        }
        return {
          ...discovered,
          capabilities: {
            ...discovered.capabilities,
            vision: defaultVisionForNewModels
          }
        };
      }

      return {
        name: discovered.name,
        description: configured.description ?? discovered.description,
        contextSize: configured.contextSize ?? discovered.contextSize,
        maxInputTokens: configured.maxInputTokens ?? discovered.maxInputTokens,
        maxOutputTokens: configured.maxOutputTokens ?? discovered.maxOutputTokens,
        capabilities: {
          tools: configured.capabilities?.tools ?? discovered.capabilities?.tools,
          vision: configured.capabilities?.vision ?? discovered.capabilities?.vision
        }
      };
    });
  }

  private readPositiveTokenInteger(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  private toVendorStateKey(vendorName: string): string {
    return vendorName.trim().toLowerCase();
  }

  private buildVendorDiscoverySignature(vendor: VendorConfig, apiKey: string): string {
    const normalizedBaseUrl = normalizeHttpBaseUrl(vendor.baseUrl) || vendor.baseUrl.trim();
    const modelsSignature = this.hashText(JSON.stringify(vendor.models));
    const endpointFlag = vendor.useModelsEndpoint ? '1' : '0';
    return `${this.toVendorStateKey(vendor.name)}|${normalizedBaseUrl.toLowerCase()}|${endpointFlag}|${modelsSignature}|${this.hashText(apiKey.trim())}`;
  }

  private hashText(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  private async sendOpenAIRequest(
    request: GenericChatRequest,
    modelName: string,
    baseUrl: string,
    apiKey: string,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const messages = this.convertMessages(request.messages);
    const supportsToolCalling = !!request.capabilities.toolCalling;

    const payload: OpenAIChatRequest = {
      model: modelName,
      messages,
      tools: supportsToolCalling ? this.buildToolDefinitions(request.options) : undefined,
      tool_choice: supportsToolCalling ? this.buildToolChoice(request.options) : undefined,
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: DEFAULT_MAX_TOKENS
    };

    try {
      const requestInit = this.buildRequestInit(apiKey, token);
      const response = await this.postWithRetry(`${baseUrl}/chat/completions`, payload, requestInit);
      const responseMessage = response.choices[0]?.message;
      const content = responseMessage?.content || '';
      const usageData = response.usage;
      const responseParts = this.buildResponseParts(content, responseMessage?.tool_calls);

      async function* streamText(text: string): AsyncIterable<string> {
        if (text.trim().length > 0) {
          yield text;
        }
      }

      async function* streamParts(parts: vscode.LanguageModelResponsePart[]): AsyncIterable<vscode.LanguageModelResponsePart> {
        for (const part of parts) {
          yield part;
        }
      }

      const result: vscode.LanguageModelChatResponse = {
        stream: streamParts(responseParts),
        text: streamText(content)
      };

      if (usageData) {
        (result as any).promptTokens = usageData.prompt_tokens;
        (result as any).completionTokens = usageData.completion_tokens;
        (result as any).totalTokens = usageData.total_tokens;
      }

      return result;
    } catch (error: any) {
      throw this.toProviderError(error);
    }
  }

  private async postWithRetry(
    url: string,
    payload: OpenAIChatRequest,
    requestInit: RequestInit
  ): Promise<OpenAIChatResponse> {
    const maxRetries = 2;
    let attempt = 0;

    while (true) {
      try {
        const response = await this.fetchJson<OpenAIChatResponse>(url, {
          ...requestInit,
          method: 'POST',
          body: JSON.stringify(payload)
        });
        return response.data;
      } catch (error: any) {
        if (this.isAbortError(error)) {
          throw error;
        }

        const status = error?.response?.status;
        const shouldRetry = (status === 429 || (typeof status === 'number' && status >= 500)) && attempt < maxRetries;
        if (!shouldRetry) {
          throw error;
        }

        const delayMs = 800 * (attempt + 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }
  }

  private buildRequestInit(apiKey: string, token?: vscode.CancellationToken): RequestInit {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };
    const init: RequestInit = { headers };

    if (token) {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      init.signal = controller.signal;
    }

    return init;
  }

  private toProviderError(error: any): vscode.LanguageModelError {
    const detail = this.readApiErrorMessage(error);
    const compactDetail = detail ? getCompactErrorMessage(detail) : undefined;

    if (this.isAbortError(error)) {
      return new vscode.LanguageModelError(getMessage('requestCancelled'));
    }

    if (error.response?.status === 401 || error.response?.status === 403) {
      return new vscode.LanguageModelError(compactDetail || getMessage('apiKeyInvalid'));
    }
    if (error.response?.status === 429) {
      return vscode.LanguageModelError.Blocked(
        compactDetail ? `${getMessage('rateLimitExceeded')}: ${compactDetail}` : getMessage('rateLimitExceeded')
      );
    }
    if (error.response?.status === 400) {
      const invalidDetail = compactDetail || getCompactErrorMessage(error.response.data?.error?.message || '');
      return new vscode.LanguageModelError(getMessage('invalidRequest', invalidDetail));
    }

    const message = compactDetail || getCompactErrorMessage(error) || getMessage('unknownError');
    return new vscode.LanguageModelError(getMessage('requestFailed', message));
  }

  private readApiErrorMessage(error: any): string | undefined {
    const responseData = error?.response?.data;
    if (!responseData) {
      return undefined;
    }

    const message = responseData?.error?.message || responseData?.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }

    if (typeof responseData === 'string' && responseData.trim().length > 0) {
      return responseData.trim();
    }

    return undefined;
  }

  private isAbortError(error: any): boolean {
    return !!error && typeof error === 'object' && error.name === 'AbortError';
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<{ data: T; status: number }> {
    const response = await fetch(url, init);
    const data = await this.readResponseData(response);

    if (!response.ok) {
      const error: any = new Error(`Request failed with status ${response.status}`);
      error.response = { status: response.status, data };
      throw error;
    }

    return { data: data as T, status: response.status };
  }

  private async readResponseData(response: Response): Promise<any> {
    const text = await response.text();
    if (!text) {
      return undefined;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

