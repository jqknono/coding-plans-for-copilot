import * as vscode from 'vscode';
import {
  BaseAIProvider,
  BaseLanguageModel,
  AIModelConfig,
  ChatMessage,
  ChatToolCall,
  getCompactErrorMessage,
  normalizeHttpBaseUrl
} from './baseProvider';
import { ConfigStore, VendorApiStyle, VendorConfig, VendorModelConfig } from '../config/configStore';
import {
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_MODEL_TOOLS,
  DEFAULT_REQUEST_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  RESPONSE_TRACE_ID_FIELD
} from '../constants';
import { getMessage, isChinese } from '../i18n/i18n';
import { logger } from '../logging/outputChannelLogger';
import {
  ModelDiscoveryResult,
  ModelVendorMapping,
  VendorDiscoveryState,
  buildVendorDiscoverySignature,
  mergeConfiguredModelOverrides,
  shouldSuppressDiscoveryRetry,
  toVendorModelConfigs,
  toVendorStateKey
} from './genericProviderDiscovery';
import {
  AnthropicStreamEvent,
  AnthropicChatRequest,
  AnthropicChatResponse,
  OpenAIChatStreamChunk,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIResponsesInputItem,
  OpenAIResponsesStreamEvent,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  applyAnthropicStreamEvent,
  applyOpenAIChatStreamChunk,
  applyOpenAIResponsesStreamEvent,
  buildAnthropicToolChoice,
  buildAnthropicToolDefinitions,
  buildOpenAIResponsesToolDefinitions,
  createAnthropicStreamState,
  createOpenAIChatStreamState,
  createOpenAIResponsesStreamState,
  finalizeAnthropicStreamState,
  finalizeOpenAIChatStreamState,
  finalizeOpenAIResponsesStreamState,
  parseAnthropicResponse,
  parseOpenAIResponsesResponse,
  summarizeAnthropicResponseForLogging,
  summarizeOpenAIChatResponse,
  summarizeOpenAIResponsesResponse,
  toAnthropicMessages,
  toOpenAIResponsesInput
} from './genericProviderProtocols';
import {
  attachTokenUsage,
  normalizeTokenUsage,
  NormalizedTokenUsage
} from './tokenUsage';

interface GenericChatRequest {
  modelId: string;
  messages: vscode.LanguageModelChatMessage[];
  options?: vscode.LanguageModelChatRequestOptions;
  capabilities: vscode.LanguageModelChatCapabilities;
}

interface RefreshModelsOptions {
  forceDiscoveryRetry?: boolean;
}

interface RetryWithV1PromptResult {
  baseUrl: string;
  vendor: VendorConfig;
}

interface RequestTraceContext {
  traceId: string;
  vendorName: string;
  modelId: string;
  modelName: string;
  protocol: VendorApiStyle;
}

interface ResolvedSamplingOptions {
  temperature: number;
  topP: number;
}

interface ParsedSseEvent {
  event?: string;
  data: string;
}

interface StreamingCompletionResult {
  content: string;
  toolCalls: ChatToolCall[];
  usage?: Record<string, unknown>;
  responseId?: string;
}

class AsyncIterableQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(item: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure) {
      return;
    }
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          const value = this.items.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      }
    };
  }
}

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
    const activeVendorKeys = new Set(vendors.map(vendor => toVendorStateKey(vendor.name)));

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
      const vendorKey = toVendorStateKey(vendor.name);
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

      const signature = buildVendorDiscoverySignature(vendor, apiKey);
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
          suppressRetry: shouldSuppressDiscoveryRetry(discovered.status),
          cachedModels: fallbackModels
        });
        this.appendResolvedModels(vendor, fallbackModels, allModelConfigs);
        continue;
      }

      // When useModelsEndpoint is enabled, discovered model names are the source of truth.
      // Existing configured entries are preserved verbatim; only newly discovered names are appended.
      const discoveredVendorModels = toVendorModelConfigs(discovered.models);
      const mergedVendorModels = mergeConfiguredModelOverrides(vendor.models, discoveredVendorModels, vendor.defaultVision);
      const resolvedModels = this.buildConfiguredModelsFromVendorModels(vendor, mergedVendorModels);
      const discoveredSignature = buildVendorDiscoverySignature({ ...vendor, models: mergedVendorModels }, apiKey);
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

    const traceId = this.generateTraceId('lmreq');
    const trace: RequestTraceContext = {
      traceId,
      vendorName: mapping.vendor.name,
      modelId: request.modelId,
      modelName: mapping.modelName,
      protocol: mapping.apiStyle
    };
    this.attachCancellationLogging(token, trace);
    logger.info('Language model request start', {
      ...trace,
      baseUrl,
      request: this.summarizeGenericChatRequest(request)
    });

    if (mapping.apiStyle === 'anthropic') {
      return this.sendAnthropicRequest(request, mapping.vendor, mapping.modelName, baseUrl, apiKey, trace, token);
    }

    if (mapping.apiStyle === 'openai-responses') {
      return this.sendOpenAIResponsesRequest(request, mapping.vendor, mapping.modelName, baseUrl, apiKey, trace, token);
    }

    return this.sendOpenAIChatRequest(request, mapping.vendor, mapping.modelName, baseUrl, apiKey, trace, token);
  }

  private findConfiguredModel(vendor: VendorConfig, modelName: string): VendorModelConfig | undefined {
    const normalizedModelName = modelName.trim().toLowerCase();
    return vendor.models.find(model => model.name.trim().toLowerCase() === normalizedModelName);
  }

  private resolveSamplingOptions(vendor: VendorConfig, modelName: string): ResolvedSamplingOptions {
    const model = this.findConfiguredModel(vendor, modelName);
    return {
      temperature: model?.temperature ?? vendor.defaultTemperature ?? DEFAULT_TEMPERATURE,
      topP: model?.topP ?? vendor.defaultTopP ?? DEFAULT_TOP_P
    };
  }

  private shouldSendOutputTokenLimit(vendor: VendorConfig, modelName: string): boolean {
    const model = this.findConfiguredModel(vendor, modelName);
    return model?.maxOutputTokens !== 0;
  }

  protected createModel(modelInfo: AIModelConfig): BaseLanguageModel {
    return new GenericLanguageModel(this, modelInfo);
  }

  private buildModelFromVendorConfig(
    model: VendorModelConfig,
    vendor: VendorConfig,
    compositeId: string
  ): AIModelConfig {
    const explicitMaxInputTokens = model.maxInputTokens !== undefined && model.maxInputTokens > 0
      ? model.maxInputTokens
      : undefined;
    const explicitMaxOutputTokens = model.maxOutputTokens !== undefined && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : undefined;
    const resolvedTokens = this.resolveTokenWindowLimits(
      model.contextSize
        ?? (explicitMaxInputTokens !== undefined && explicitMaxOutputTokens !== undefined
          ? explicitMaxInputTokens + explicitMaxOutputTokens
          : DEFAULT_CONTEXT_WINDOW_SIZE),
      explicitMaxInputTokens,
      explicitMaxOutputTokens
    );
    const toolCalling = model.capabilities?.tools ?? DEFAULT_MODEL_TOOLS;
    const imageInput = model.capabilities?.vision ?? vendor.defaultVision;

    return {
      id: compositeId,
      vendor: 'coding-plans',
      family: vendor.name,
      name: model.name,
      version: vendor.name,
      maxTokens: resolvedTokens.maxTokens,
      maxInputTokens: resolvedTokens.maxInputTokens,
      maxOutputTokens: resolvedTokens.maxOutputTokens,
      capabilities: { toolCalling, imageInput },
      apiStyle: model.apiStyle ?? vendor.defaultApiStyle,
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
    const configuredApiStyleByName = new Map<string, VendorApiStyle>();
    for (const vendorModel of vendor.models) {
      configuredApiStyleByName.set(vendorModel.name.trim().toLowerCase(), vendorModel.apiStyle ?? vendor.defaultApiStyle);
    }

    for (const model of models) {
      const actualName = model.id.includes('/') ? model.id.substring(model.id.indexOf('/') + 1) : model.id;
      const apiStyle = configuredApiStyleByName.get(actualName.trim().toLowerCase()) ?? vendor.defaultApiStyle;
      this.modelVendorMap.set(model.id, { vendor, modelName: actualName, apiStyle });
    }
    target.push(...models);
  }

  private async discoverModelsFromApi(vendor: VendorConfig, apiKey: string): Promise<ModelDiscoveryResult> {
    try {
      const baseUrl = normalizeHttpBaseUrl(vendor.baseUrl);
      if (!baseUrl) {
        return { models: [], failed: false };
      }

      const resolved = await this.withOptionalV1Retry(vendor, baseUrl, async retryBaseUrl => {
        const response = await this.fetchJson<any>(`${retryBaseUrl}/models`, {
          method: 'GET',
          ...this.buildRequestInit(apiKey, vendor.defaultApiStyle)
        });
        return { response, baseUrl: retryBaseUrl };
      });
      const response = resolved.response;
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
        const modelId = this.readModelId(entry);
        if (!modelId || seen.has(modelId.toLowerCase())) {
          continue;
        }
        if (!this.isLikelyChatModel(modelId)) {
          continue;
        }
        seen.add(modelId.toLowerCase());

        const runtime = this.readRuntimeFromGenericModelEntry(entry);
        const resolvedTokens = this.resolveTokenWindowLimits(
          runtime.maxTokens,
          runtime.maxInputTokens,
          runtime.maxOutputTokens
        );
        const compositeId = `${vendor.name}/${modelId}`;
        models.push({
          id: compositeId,
          vendor: 'coding-plans',
          family: vendor.name,
          name: modelId,
          version: vendor.name,
          maxTokens: resolvedTokens.maxTokens,
          maxInputTokens: resolvedTokens.maxInputTokens,
          maxOutputTokens: resolvedTokens.maxOutputTokens,
          capabilities: {
            toolCalling: runtime.toolCalling ?? DEFAULT_MODEL_TOOLS,
            imageInput: runtime.imageInput ?? vendor.defaultVision
          },
          apiStyle: vendor.defaultApiStyle,
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

  private async sendOpenAIChatRequest(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    baseUrl: string,
    apiKey: string,
    trace: RequestTraceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const messages = this.convertMessages(request.messages);
    const supportsToolCalling = !!request.capabilities.toolCalling;
    const sampling = this.resolveSamplingOptions(vendor, modelName);
    const tools = supportsToolCalling ? this.buildToolDefinitions(request.options) : undefined;
    const toolChoice = supportsToolCalling ? this.buildToolChoice(request.options) : undefined;
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName)
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxTokens = requestedOutputLimit;

    const payload: OpenAIChatRequest = {
      model: modelName,
      messages,
      tools,
      tool_choice: toolChoice,
      stream: true,
      temperature: sampling.temperature,
      top_p: sampling.topP,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens })
    };

    try {
      logger.debug('Prepared OpenAI chat payload', {
        ...trace,
        baseUrl,
        payload: {
          temperature: payload.temperature,
          topP: payload.top_p,
          maxTokens: payload.max_tokens,
          stream: payload.stream,
          toolChoice: payload.tool_choice,
          toolCount: payload.tools?.length ?? 0,
          messages: this.summarizeProviderMessages(messages)
        }
      });
      const requestInit = this.buildRequestInit(apiKey, 'openai-chat', token);
      const response = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
        this.postWithRetry(`${retryBaseUrl}/chat/completions`, payload, requestInit, trace)
      ), trace);
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'openai-chat',
          request,
          vendor,
          modelName,
          payload.max_tokens,
          async queue => {
            const state = createOpenAIChatStreamState();
            for await (const event of this.readSseEvents(response)) {
              if (event.data === '[DONE]') {
                break;
              }
              const chunk = this.tryParseJson<OpenAIChatStreamChunk>(event.data);
              if (!chunk) {
                continue;
              }
              const update = applyOpenAIChatStreamChunk(state, chunk, () => this.generateToolCallId());
              if (update.textDelta.length > 0) {
                queue.push(new vscode.LanguageModelTextPart(update.textDelta));
              }
            }
            const finalized = finalizeOpenAIChatStreamState(state, () => this.generateToolCallId());
            this.logUpstreamResponseSummary('openai-chat', vendor, modelName, {
              mode: 'stream',
              responseId: state.responseId,
              contentLength: finalized.content.length,
              toolCallCount: finalized.toolCalls.length,
              usage: finalized.usage
            });
            return {
              content: finalized.content,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId
            };
          }
        );
      }

      logger.warn('OpenAI chat stream request returned non-SSE response; falling back to non-stream parsing', trace);
      const parsedResponse = await this.readParsedResponse<OpenAIChatResponse>(response);
      return this.buildOpenAIChatResponseFromPayload(
        request,
        vendor,
        modelName,
        trace,
        parsedResponse,
        payload.max_tokens
      );
    } catch (error: any) {
      if (this.shouldFallbackToNonStream(error)) {
        logger.warn('OpenAI chat stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(error)
        });
        try {
          const fallbackPayload: OpenAIChatRequest = { ...payload, stream: false };
          const requestInit = this.buildRequestInit(apiKey, 'openai-chat', token);
          const fallbackResponse = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
            this.postWithRetry(`${retryBaseUrl}/chat/completions`, fallbackPayload, requestInit, trace)
          ), trace);
          const parsedFallback = await this.readParsedResponse<OpenAIChatResponse>(fallbackResponse);
          return this.buildOpenAIChatResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('OpenAI chat fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(error);
      logger.error('OpenAI chat request failed', {
        ...trace,
        error: this.summarizeError(error),
        translatedError: providerError.message
      });
      throw providerError;
    }
  }

  private buildOpenAIChatResponseFromPayload(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    trace: RequestTraceContext,
    response: OpenAIChatResponse,
    maxTokens: number | undefined
  ): vscode.LanguageModelChatResponse {
    const responseMessage = response.choices[0]?.message;
    const content = responseMessage?.content || '';
    const usageData = response.usage;
    this.ensureNonEmptyCompletion('openai-chat', trace, vendor, modelName, content, responseMessage?.tool_calls);
    this.logUpstreamResponseSummary('openai-chat', vendor, modelName, summarizeOpenAIChatResponse(response));
    logger.debug('Parsed OpenAI chat response', {
      ...trace,
      responseId: response.id,
      contentLength: content.length,
      toolCallCount: responseMessage?.tool_calls?.length ?? 0,
      usage: usageData
    });
    const responseParts = this.buildResponseParts(content, responseMessage?.tool_calls);
    const result = this.buildLoggedChatResponse(trace, content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'openai-chat',
      usageData as Record<string, unknown> | undefined,
      maxTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxTokens)
    );
    attachTokenUsage(result as unknown as Record<string, unknown>, normalizedUsage);
    this.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
    return result;
  }

  private async sendOpenAIResponsesRequest(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    baseUrl: string,
    apiKey: string,
    trace: RequestTraceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const providerMessages = this.convertMessages(request.messages);
    const sampling = this.resolveSamplingOptions(vendor, modelName);
    const tools = request.capabilities.toolCalling
      ? buildOpenAIResponsesToolDefinitions(this.buildToolDefinitions(request.options))
      : undefined;
    const toolChoice = request.capabilities.toolCalling ? this.buildToolChoice(request.options) : undefined;
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName)
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxOutputTokens = requestedOutputLimit;
    const payload: OpenAIResponsesRequest = {
      model: modelName,
      input: toOpenAIResponsesInput(providerMessages, () => this.generateToolCallId()),
      tools,
      tool_choice: toolChoice,
      temperature: sampling.temperature,
      top_p: sampling.topP,
      stream: true,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens })
    };

    try {
      logger.debug('Prepared OpenAI responses payload', {
        ...trace,
        baseUrl,
        payload: {
          temperature: payload.temperature,
          topP: payload.top_p,
          maxOutputTokens: payload.max_output_tokens,
          toolChoice: payload.tool_choice,
          toolCount: payload.tools?.length ?? 0,
          providerMessages: this.summarizeProviderMessages(providerMessages),
          input: this.summarizeOpenAIResponsesInput(payload.input)
        }
      });
      const requestInit = this.buildRequestInit(apiKey, 'openai-responses', token);
      const response = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
        this.postWithRetry(`${retryBaseUrl}/responses`, payload, requestInit, trace)
      ), trace);
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'openai-responses',
          request,
          vendor,
          modelName,
          payload.max_output_tokens,
          async queue => {
            const state = createOpenAIResponsesStreamState();
            for await (const event of this.readSseEvents(response)) {
              if (event.data === '[DONE]') {
                break;
              }
              const streamEvent = this.tryParseJson<OpenAIResponsesStreamEvent>(event.data);
              if (!streamEvent) {
                continue;
              }
              const update = applyOpenAIResponsesStreamEvent(state, event.event, streamEvent, () => this.generateToolCallId());
              if (update.textDelta.length > 0) {
                queue.push(new vscode.LanguageModelTextPart(update.textDelta));
              }
            }
            const finalized = finalizeOpenAIResponsesStreamState(state, () => this.generateToolCallId());
            this.logUpstreamResponseSummary('openai-responses', vendor, modelName, {
              mode: 'stream',
              responseId: state.responseId,
              contentLength: finalized.content.length,
              toolCallCount: finalized.toolCalls.length,
              usage: finalized.usage
            });
            return {
              content: finalized.content,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId
            };
          }
        );
      }

      logger.warn('OpenAI responses stream request returned non-SSE response; falling back to non-stream parsing', trace);
      const parsedResponse = await this.readParsedResponse<OpenAIResponsesResponse>(response);
      return this.buildOpenAIResponsesResponseFromPayload(
        request,
        vendor,
        modelName,
        trace,
        parsedResponse,
        payload.max_output_tokens
      );
    } catch (error: any) {
      if (this.shouldFallbackToNonStream(error)) {
        logger.warn('OpenAI responses stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(error)
        });
        try {
          const fallbackPayload: OpenAIResponsesRequest = { ...payload, stream: false };
          const requestInit = this.buildRequestInit(apiKey, 'openai-responses', token);
          const fallbackResponse = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
            this.postWithRetry(`${retryBaseUrl}/responses`, fallbackPayload, requestInit, trace)
          ), trace);
          const parsedFallback = await this.readParsedResponse<OpenAIResponsesResponse>(fallbackResponse);
          return this.buildOpenAIResponsesResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_output_tokens
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('OpenAI responses fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(error);
      logger.error('OpenAI responses request failed', {
        ...trace,
        error: this.summarizeError(error),
        translatedError: providerError.message
      });
      throw providerError;
    }
  }

  private buildOpenAIResponsesResponseFromPayload(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    trace: RequestTraceContext,
    response: OpenAIResponsesResponse,
    maxOutputTokens: number | undefined
  ): vscode.LanguageModelChatResponse {
    this.logUpstreamResponseSummary('openai-responses', vendor, modelName, summarizeOpenAIResponsesResponse(response));
    const parsed = parseOpenAIResponsesResponse(response, () => this.generateToolCallId());
    this.ensureNonEmptyCompletion('openai-responses', trace, vendor, modelName, parsed.content, parsed.toolCalls);
    logger.debug('Parsed OpenAI responses payload', {
      ...trace,
      responseId: response.id,
      outputCount: response.output?.length ?? 0,
      outputTextLength: typeof response.output_text === 'string' ? response.output_text.length : 0,
      parsedContentLength: parsed.content.length,
      parsedToolCallCount: parsed.toolCalls.length,
      parsedToolCalls: parsed.toolCalls.map(toolCall => ({
        id: toolCall.id,
        name: toolCall.function.name,
        argumentsLength: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments.length : 0
      })),
      usage: response.usage
    });
    const responseParts = this.buildResponseParts(parsed.content, parsed.toolCalls);
    logger.debug('Built OpenAI responses result parts', {
      ...trace,
      responseParts: this.summarizeResponseParts(responseParts)
    });
    const result = this.buildLoggedChatResponse(trace, parsed.content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'openai-responses',
      response.usage as Record<string, unknown> | undefined,
      maxOutputTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxOutputTokens)
    );
    attachTokenUsage(result as unknown as Record<string, unknown>, normalizedUsage);
    this.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
    return result;
  }

  private async sendAnthropicRequest(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    baseUrl: string,
    apiKey: string,
    trace: RequestTraceContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatResponse> {
    const providerMessages = this.convertMessages(request.messages);
    const sampling = this.resolveSamplingOptions(vendor, modelName);
    const { system, messages } = toAnthropicMessages(providerMessages, () => this.generateToolCallId());
    const tools = request.capabilities.toolCalling ? buildAnthropicToolDefinitions(this.buildToolDefinitions(request.options)) : undefined;
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName)
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxTokens = requestedOutputLimit;
    const payload: AnthropicChatRequest = {
      model: modelName,
      system: system || undefined,
      messages,
      tools,
      tool_choice: tools ? buildAnthropicToolChoice(request.options) : undefined,
      temperature: sampling.temperature,
      top_p: sampling.topP,
      stream: true,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens })
    };

    try {
      logger.debug('Prepared Anthropic payload', {
        ...trace,
        baseUrl,
        payload: {
          maxTokens: payload.max_tokens,
          temperature: payload.temperature,
          topP: payload.top_p,
          stream: payload.stream,
          toolChoice: payload.tool_choice,
          toolCount: payload.tools?.length ?? 0,
          systemLength: typeof payload.system === 'string' ? payload.system.length : 0,
          providerMessages: this.summarizeProviderMessages(providerMessages),
          messageCount: payload.messages.length
        }
      });
      const requestInit = this.buildRequestInit(apiKey, 'anthropic', token);
      const response = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
        this.postWithRetry(`${retryBaseUrl}/messages`, payload, requestInit, trace)
      ), trace);
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'anthropic',
          request,
          vendor,
          modelName,
          payload.max_tokens,
          async queue => {
            const state = createAnthropicStreamState();
            for await (const event of this.readSseEvents(response)) {
              if (event.data === '[DONE]') {
                break;
              }
              const streamEvent = this.tryParseJson<AnthropicStreamEvent>(event.data);
              if (!streamEvent) {
                continue;
              }
              const update = applyAnthropicStreamEvent(state, event.event, streamEvent);
              if (update.textDelta.length > 0) {
                queue.push(new vscode.LanguageModelTextPart(update.textDelta));
              }
            }
            const finalized = finalizeAnthropicStreamState(state, () => this.generateToolCallId());
            this.logUpstreamResponseSummary('anthropic', vendor, modelName, {
              mode: 'stream',
              responseId: state.responseId,
              contentLength: finalized.content.length,
              toolCallCount: finalized.toolCalls.length,
              usage: finalized.usage,
              stopReason: state.stopReason
            });
            return {
              content: finalized.content,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId
            };
          }
        );
      }

      logger.warn('Anthropic stream request returned non-SSE response; falling back to non-stream parsing', trace);
      const parsedResponse = await this.readParsedResponse<AnthropicChatResponse>(response);
      return this.buildAnthropicResponseFromPayload(
        request,
        vendor,
        modelName,
        trace,
        parsedResponse,
        payload.max_tokens
      );
    } catch (error: any) {
      if (this.shouldFallbackToNonStream(error)) {
        logger.warn('Anthropic stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(error)
        });
        try {
          const fallbackPayload: AnthropicChatRequest = { ...payload, stream: false };
          const requestInit = this.buildRequestInit(apiKey, 'anthropic', token);
          const fallbackResponse = await this.withOptionalV1Retry(vendor, baseUrl, retryBaseUrl => (
            this.postWithRetry(`${retryBaseUrl}/messages`, fallbackPayload, requestInit, trace)
          ), trace);
          const parsedFallback = await this.readParsedResponse<AnthropicChatResponse>(fallbackResponse);
          return this.buildAnthropicResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('Anthropic fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(error);
      logger.error('Anthropic request failed', {
        ...trace,
        error: this.summarizeError(error),
        translatedError: providerError.message
      });
      throw providerError;
    }
  }

  private buildAnthropicResponseFromPayload(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    trace: RequestTraceContext,
    response: AnthropicChatResponse,
    maxTokens: number | undefined
  ): vscode.LanguageModelChatResponse {
    this.logUpstreamResponseSummary('anthropic', vendor, modelName, summarizeAnthropicResponseForLogging(response));
    logger.debug('Anthropic raw response shape', {
      ...trace,
      responseShape: this.summarizeRawResponseShape(response)
    });
    const parsed = parseAnthropicResponse(response, () => this.generateToolCallId());
    this.ensureNonEmptyCompletion('anthropic', trace, vendor, modelName, parsed.content, parsed.toolCalls);
    logger.debug('Parsed Anthropic response', {
      ...trace,
      responseId: response.id,
      parsedContentLength: parsed.content.length,
      parsedToolCallCount: parsed.toolCalls.length,
      usage: response.usage
    });
    const responseParts = this.buildResponseParts(parsed.content, parsed.toolCalls);
    const result = this.buildLoggedChatResponse(trace, parsed.content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'anthropic',
      response.usage as Record<string, unknown> | undefined,
      maxTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxTokens)
    );
    attachTokenUsage(result as unknown as Record<string, unknown>, normalizedUsage);
    this.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
    return result;
  }

  private async postWithRetry(
    url: string,
    payload: unknown,
    requestInit: RequestInit,
    trace?: RequestTraceContext
  ): Promise<Response> {
    const maxRetries = 2;
    let attempt = 0;

    while (true) {
      const startedAt = Date.now();
      logger.debug('Upstream POST attempt start', {
        ...trace,
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        url,
        payloadSize: JSON.stringify(payload).length
      });
      try {
        const response = await this.fetchResponse(url, {
          ...requestInit,
          method: 'POST',
          body: JSON.stringify(payload)
        });
        logger.info('Upstream POST attempt success', {
          ...trace,
          attempt: attempt + 1,
          url,
          status: response.status,
          durationMs: Date.now() - startedAt
        });
        return response;
      } catch (error: any) {
        if (this.isAbortError(error)) {
          logger.warn('Upstream POST aborted', {
            ...trace,
            attempt: attempt + 1,
            url,
            durationMs: Date.now() - startedAt
          });
          throw error;
        }

        const status = error?.response?.status;
        const shouldRetry = (status === 429 || (typeof status === 'number' && status >= 500)) && attempt < maxRetries;
        logger.warn('Upstream POST attempt failed', {
          ...trace,
          attempt: attempt + 1,
          url,
          status,
          durationMs: Date.now() - startedAt,
          shouldRetry,
          error: this.summarizeError(error)
        });
        if (!shouldRetry) {
          throw error;
        }

        const delayMs = 800 * (attempt + 1);
        logger.info('Scheduling upstream POST retry', {
          ...trace,
          nextAttempt: attempt + 2,
          delayMs,
          url
        });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }
  }

  private logUpstreamResponseSummary(
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic',
    vendor: VendorConfig,
    modelName: string,
    summary: Record<string, unknown>
  ): void {
    logger.debug('Language model upstream response summary', {
      protocol,
      vendor: vendor.name,
      modelName,
      ...summary
    });
  }

  private logModelTokenUsage(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    usage: NormalizedTokenUsage | undefined
  ): void {
    const model = this.getModel(request.modelId);
    const totalContextWindow = model?.maxTokens;
    logger.debug('Language model token usage', {
      vendor: vendor.name,
      modelId: request.modelId,
      modelName,
      maxTokens: model?.maxTokens,
      maxInputTokens: model?.maxInputTokens,
      maxOutputTokens: model?.maxOutputTokens,
      totalContextWindow,
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
      outputBuffer: usage?.outputBuffer,
      contextWindowPercentage: totalContextWindow && usage
        ? Number(((usage.totalTokens / totalContextWindow) * 100).toFixed(4))
        : undefined
    });
  }

  private resolveRequestedOutputLimit(request: GenericChatRequest): number {
    const advanced = this.configStore.getAdvancedOptions();
    if (advanced.defaultReservedOutput > 0) {
      return advanced.defaultReservedOutput;
    }
    const model = this.getModel(request.modelId);
    if (!model) {
      return DEFAULT_REQUEST_MAX_TOKENS;
    }
    return Math.max(1, Math.floor(model.maxOutputTokens));
  }

  private resolveOutputBuffer(
    request: GenericChatRequest,
    requestedOutputLimit: number | undefined
  ): number | undefined {
    const model = this.getModel(request.modelId);
    if (!model) {
      return requestedOutputLimit;
    }

    if (requestedOutputLimit === undefined) {
      return model.maxOutputTokens;
    }

    return Math.max(0, Math.min(model.maxOutputTokens, Math.floor(requestedOutputLimit)));
  }

  private async withOptionalV1Retry<T>(
    vendor: VendorConfig,
    baseUrl: string,
    execute: (resolvedBaseUrl: string) => Promise<T>,
    trace?: RequestTraceContext
  ): Promise<T> {
    let currentBaseUrl = baseUrl;
    let retriedWithV1 = false;

    while (true) {
      try {
        logger.debug('Executing upstream request', {
          ...trace,
          baseUrl: currentBaseUrl,
          retriedWithV1
        });
        return await execute(currentBaseUrl);
      } catch (error: any) {
        logger.warn('Upstream request failed before optional /v1 retry handling', {
          ...trace,
          baseUrl: currentBaseUrl,
          retriedWithV1,
          status: error?.response?.status,
          error: this.summarizeError(error)
        });
        if (retriedWithV1 || !this.shouldOfferV1Retry(currentBaseUrl, error)) {
          throw error;
        }

        logger.info('Attempting optional /v1 retry flow', {
          ...trace,
          baseUrl: currentBaseUrl
        });
        const retryTarget = await this.promptToAppendV1(vendor, currentBaseUrl);
        if (!retryTarget) {
          logger.warn('Optional /v1 retry declined or unavailable', {
            ...trace,
            baseUrl: currentBaseUrl
          });
          throw error;
        }

        currentBaseUrl = retryTarget.baseUrl;
        vendor = retryTarget.vendor;
        retriedWithV1 = true;
        logger.info('Optional /v1 retry accepted', {
          ...trace,
          nextBaseUrl: currentBaseUrl
        });
      }
    }
  }

  private shouldOfferV1Retry(baseUrl: string, error: any): boolean {
    if (error?.response?.status !== 404) {
      return false;
    }

    try {
      const url = new URL(baseUrl);
      return this.canAppendV1ToBaseUrl(url);
    } catch {
      return false;
    }
  }

  private canAppendV1ToBaseUrl(url: URL): boolean {
    const segments = url.pathname
      .split('/')
      .map(segment => segment.trim().toLowerCase())
      .filter(segment => segment.length > 0);

    if (segments.includes('v1')) {
      return false;
    }

    return segments.length === 0 || (segments.length === 1 && segments[0] === 'api');
  }

  private buildBaseUrlWithV1(baseUrl: string): string {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/$/, '');
    url.pathname = pathname + '/v1';
    return url.toString().replace(/\/$/, '');
  }

  private async promptToAppendV1(vendor: VendorConfig, baseUrl: string): Promise<RetryWithV1PromptResult | undefined> {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return undefined;
    }

    if (!this.canAppendV1ToBaseUrl(url)) {
      return undefined;
    }

    const nextBaseUrl = this.buildBaseUrlWithV1(baseUrl);
    const action = this.getRetryWithV1ActionLabel();
    const picked = await vscode.window.showWarningMessage(
      this.getRetryWithV1PromptText(vendor.name, nextBaseUrl),
      action
    );

    if (picked !== action) {
      return undefined;
    }

    await this.configStore.updateVendorBaseUrl(vendor.name, nextBaseUrl);
    return {
      baseUrl: nextBaseUrl,
      vendor: {
        ...vendor,
        baseUrl: nextBaseUrl
      }
    };
  }

  private getRetryWithV1PromptText(vendorName: string, nextBaseUrl: string): string {
    const message = getMessage('retryWithV1Prompt', vendorName, nextBaseUrl);
    if (message !== 'retryWithV1Prompt') {
      return message;
    }

    if (isChinese()) {
      return `${vendorName} 请求返回 404，当前 baseUrl 可能缺少 /v1。是否改为 ${nextBaseUrl} 并立即重试？`;
    }

    return `${vendorName} returned 404. The current baseUrl may be missing /v1. Update it to ${nextBaseUrl} and retry now?`;
  }

  private getRetryWithV1ActionLabel(): string {
    const action = getMessage('retryWithV1Action');
    if (action !== 'retryWithV1Action') {
      return action;
    }

    return isChinese() ? '添加 /v1 并重试' : 'Add /v1 and retry';
  }

  private buildRequestInit(
    apiKey: string,
    apiStyle: VendorApiStyle,
    token?: vscode.CancellationToken
  ): RequestInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    };

    if (apiStyle === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

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
    const apiErrorType = this.readApiErrorType(error);

    if (this.isAbortError(error)) {
      return new vscode.LanguageModelError(getMessage('requestCancelled'));
    }

    if (error.response?.status === 401 || error.response?.status === 403 || apiErrorType === 'authentication_error' || apiErrorType === 'permission_error') {
      return new vscode.LanguageModelError(compactDetail || getMessage('apiKeyInvalid'));
    }
    if (error.response?.status === 429 || apiErrorType === 'rate_limit_error') {
      return vscode.LanguageModelError.Blocked(
        compactDetail ? `${getMessage('rateLimitExceeded')}: ${compactDetail}` : getMessage('rateLimitExceeded')
      );
    }
    if (error.response?.status === 400 || apiErrorType === 'invalid_request_error') {
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

  private readApiErrorType(error: any): string | undefined {
    const type = error?.response?.data?.error?.type;
    if (typeof type === 'string' && type.trim().length > 0) {
      return type.trim();
    }
    return undefined;
  }

  private generateToolCallId(): string {
    return `tool_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  }

  private generateTraceId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  }

  private attachCancellationLogging(token: vscode.CancellationToken | undefined, trace: RequestTraceContext): void {
    if (!token) {
      return;
    }

    if (token.isCancellationRequested) {
      logger.warn('Language model request already cancelled before dispatch', trace);
      return;
    }

    token.onCancellationRequested(() => {
      logger.warn('Language model cancellation requested', trace);
    });
  }

  private summarizeGenericChatRequest(request: GenericChatRequest): Record<string, unknown> {
    return {
      messageCount: request.messages.length,
      messages: request.messages.map(message => ({
        role: message.role,
        name: message.name,
        partCount: message.content.length,
        parts: message.content.map(part => this.summarizeInputPart(part))
      })),
      toolCount: request.options?.tools?.length ?? 0,
      toolMode: request.options?.toolMode,
      capabilities: request.capabilities
    };
  }

  private summarizeInputPart(part: vscode.LanguageModelInputPart): Record<string, unknown> {
    if (part instanceof vscode.LanguageModelTextPart) {
      return {
        type: 'text',
        length: part.value.length
      };
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return {
        type: 'tool_call',
        callId: part.callId,
        name: part.name,
        inputKeys: part.input && typeof part.input === 'object' ? Object.keys(part.input as object) : []
      };
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      return {
        type: 'tool_result',
        callId: part.callId,
        partCount: part.content.length
      };
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      return {
        type: 'data',
        mimeType: part.mimeType,
        bytes: part.data.byteLength
      };
    }

    const unknownPart = part as unknown as { constructor?: { name?: string } };
    return {
      type: unknownPart.constructor?.name ?? typeof part
    };
  }

  private summarizeProviderMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map(message => ({
      role: message.role,
      contentLength: message.content.length,
      toolCallCount: message.tool_calls?.length ?? 0,
      toolCalls: (message.tool_calls ?? []).map(toolCall => ({
        id: toolCall.id,
        name: toolCall.function.name,
        argumentsLength: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments.length : 0
      })),
      toolCallId: message.tool_call_id
    }));
  }

  private summarizeOpenAIResponsesInput(input: OpenAIResponsesInputItem[]): Array<Record<string, unknown>> {
    return input.map(item => {
      if (item.type === 'function_call') {
        return {
          type: item.type,
          callId: item.call_id,
          name: item.name,
          argumentsLength: typeof item.arguments === 'string' ? item.arguments.length : 0
        };
      }

      if (item.type === 'function_call_output') {
        return {
          type: item.type,
          callId: item.call_id,
          outputLength: typeof item.output === 'string' ? item.output.length : 0
        };
      }

      return {
        type: item.type ?? 'message',
        role: item.role,
        contentKind: Array.isArray(item.content) ? 'array' : typeof item.content,
        contentLength: typeof item.content === 'string'
          ? item.content.length
          : Array.isArray(item.content)
            ? item.content.reduce((total, part) => total + (typeof part.text === 'string' ? part.text.length : 0), 0)
            : 0
      };
    });
  }

  private summarizeResponseParts(parts: vscode.LanguageModelResponsePart[]): Array<Record<string, unknown>> {
    return parts.map(part => this.summarizeResponsePart(part));
  }

  private summarizeResponsePart(part: vscode.LanguageModelResponsePart): Record<string, unknown> {
    if (part instanceof vscode.LanguageModelTextPart) {
      return {
        type: 'text',
        length: part.value.length
      };
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return {
        type: 'tool_call',
        callId: part.callId,
        name: part.name,
        inputKeys: part.input && typeof part.input === 'object' ? Object.keys(part.input as object) : []
      };
    }

    const unknownPart = part as unknown as { constructor?: { name?: string } };
    return {
      type: unknownPart.constructor?.name ?? typeof part
    };
  }

  private buildLoggedChatResponse(
    trace: RequestTraceContext,
    content: string,
    responseParts: vscode.LanguageModelResponsePart[]
  ): vscode.LanguageModelChatResponse {
    const provider = this;

    async function* streamText(text: string): AsyncIterable<string> {
      logger.debug('Language model response.text iterator start', {
        ...trace,
        textLength: text.length
      });
      if (text.trim().length > 0) {
        logger.debug('Language model response.text iterator yield', {
          ...trace,
          textLength: text.length
        });
        yield text;
      }
      logger.debug('Language model response.text iterator complete', {
        ...trace,
        yielded: text.trim().length > 0
      });
    }

    async function* streamParts(parts: vscode.LanguageModelResponsePart[]): AsyncIterable<vscode.LanguageModelResponsePart> {
      logger.debug('Language model response.stream iterator start', {
        ...trace,
        partCount: parts.length,
        parts: provider.summarizeResponseParts(parts)
      });
      for (const [index, part] of parts.entries()) {
        logger.debug('Language model response.stream iterator yield', {
          ...trace,
          index,
          part: provider.summarizeResponsePart(part)
        });
        yield part;
      }
      logger.debug('Language model response.stream iterator complete', {
        ...trace,
        yieldedPartCount: parts.length
      });
    }

    const result = {
      stream: streamParts(responseParts),
      text: streamText(content)
    } as vscode.LanguageModelChatResponse & Record<string, unknown>;
    result[RESPONSE_TRACE_ID_FIELD] = trace.traceId;
    logger.info('Language model request response created', {
      ...trace,
      contentLength: content.length,
      responsePartCount: responseParts.length
    });
    return result;
  }

  private ensureNonEmptyCompletion(
    protocol: VendorApiStyle,
    trace: RequestTraceContext,
    vendor: VendorConfig,
    modelName: string,
    content: string,
    toolCalls: ChatToolCall[] | undefined
  ): void {
    if (content.trim().length > 0 || (toolCalls?.length ?? 0) > 0) {
      return;
    }

    logger.warn('Language model returned empty completion', {
      ...trace,
      protocol,
      vendor: vendor.name,
      modelName
    });
    throw new vscode.LanguageModelError(getMessage('requestFailed', getMessage('emptyModelResponse')));
  }

  private buildStreamingChatResponse(
    trace: RequestTraceContext,
    protocol: VendorApiStyle,
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    requestedOutputLimit: number | undefined,
    execute: (queue: AsyncIterableQueue<vscode.LanguageModelResponsePart>) => Promise<StreamingCompletionResult>
  ): vscode.LanguageModelChatResponse {
    const provider = this;
    const queue = new AsyncIterableQueue<vscode.LanguageModelResponsePart>();
    const result = {} as vscode.LanguageModelChatResponse & Record<string, unknown>;
    result[RESPONSE_TRACE_ID_FIELD] = trace.traceId;

    const completion = (async () => {
      try {
        const finalized = await execute(queue);
        provider.ensureNonEmptyCompletion(protocol, trace, vendor, modelName, finalized.content, finalized.toolCalls);
        for (const part of provider.buildResponseParts('', finalized.toolCalls)) {
          queue.push(part);
        }

        const normalizedUsage = normalizeTokenUsage(
          protocol,
          finalized.usage,
          provider.resolveOutputBuffer(request, requestedOutputLimit)
        );
        attachTokenUsage(result, normalizedUsage);
        provider.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
        logger.info('Language model streaming response completed', {
          ...trace,
          responseId: finalized.responseId,
          contentLength: finalized.content.length,
          toolCallCount: finalized.toolCalls.length,
          usage: normalizedUsage
        });
        queue.close();
        return finalized;
      } catch (error) {
        const providerError = error instanceof vscode.LanguageModelError ? error : provider.toProviderError(error);
        logger.error('Language model streaming response failed', {
          ...trace,
          error: provider.summarizeError(error)
        });
        queue.fail(providerError);
        throw providerError;
      }
    })();

    result.stream = queue;
    result.text = (async function* streamText(): AsyncIterable<string> {
      const finalized = await completion;
      if (finalized.content.trim().length > 0) {
        yield finalized.content;
      }
    })();

    logger.info('Language model streaming response created', trace);
    return result;
  }

  private isSseResponse(response: Response): boolean {
    const contentType = response.headers.get('content-type') || '';
    return contentType.toLowerCase().includes('text/event-stream');
  }

  private shouldFallbackToNonStream(error: any): boolean {
    const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
    if (status !== 400 && status !== 404 && status !== 415 && status !== 422 && status !== 501) {
      return false;
    }

    const detail = [
      this.readApiErrorMessage(error),
      typeof error?.response?.data === 'string' ? error.response.data : undefined
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    return /(stream|streaming|sse|event-stream)/i.test(detail)
      && /(unsupported|not support|not supported|invalid|unknown|only|expect)/i.test(detail);
  }

  private tryParseJson<T>(raw: string): T | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return undefined;
    }
  }

  private async readParsedResponse<T>(response: Response): Promise<T> {
    const data = await this.readResponseData(response);
    return data as T;
  }

  private async *readSseEvents(response: Response): AsyncIterable<ParsedSseEvent> {
    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) {
          break;
        }
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = this.parseSseEventBlock(block);
        if (parsed) {
          yield parsed;
        }
      }

      if (done) {
        break;
      }
    }

    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const parsed = this.parseSseEventBlock(trailing);
      if (parsed) {
        yield parsed;
      }
    }
  }

  private parseSseEventBlock(block: string): ParsedSseEvent | undefined {
    const lines = block
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line.length > 0 && !line.startsWith(':'));
    if (lines.length === 0) {
      return undefined;
    }

    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
        continue;
      }
      dataLines.push(line);
    }

    return {
      event,
      data: dataLines.join('\n')
    };
  }

  private summarizeError(error: any): Record<string, unknown> {
    return {
      name: error?.name,
      message: getCompactErrorMessage(error),
      status: error?.response?.status,
      response: this.summarizeErrorResponseData(error?.response?.data)
    };
  }

  private summarizeErrorResponseData(data: unknown): unknown {
    if (typeof data === 'string') {
      return {
        type: 'string',
        length: data.length,
        preview: data.slice(0, 200)
      };
    }

    if (data && typeof data === 'object') {
      const source = data as Record<string, unknown>;
      return {
        keys: Object.keys(source),
        errorType: typeof source.error === 'object' && source.error
          ? (source.error as Record<string, unknown>).type
          : undefined,
        errorCode: typeof source.error === 'object' && source.error
          ? (source.error as Record<string, unknown>).code
          : undefined,
        message: this.readApiErrorMessage({ response: { data } })
      };
    }

    return data;
  }

  private summarizeRawResponseShape(response: unknown): Record<string, unknown> {
    if (typeof response === 'string') {
      return {
        type: 'string',
        rawPreview: this.truncateForLog(response, 100)
      };
    }

    if (!response || typeof response !== 'object') {
      return {
        type: typeof response
      };
    }

    const source = response as Record<string, unknown>;
    return {
      keys: Object.keys(source),
      contentType: Array.isArray(source.content) ? 'array' : typeof source.content,
      contentBlockCount: Array.isArray(source.content) ? source.content.length : undefined,
      contentPreview: this.extractContentPreview(source, 100),
      usageKeys: source.usage && typeof source.usage === 'object'
        ? Object.keys(source.usage as Record<string, unknown>)
        : undefined
    };
  }

  private extractContentPreview(source: Record<string, unknown>, maxLength: number): string | undefined {
    if (typeof source.content === 'string') {
      return this.truncateForLog(source.content, maxLength);
    }

    if (Array.isArray(source.content)) {
      const text = source.content
        .map(item => {
          if (!item || typeof item !== 'object') {
            return '';
          }

          const block = item as Record<string, unknown>;
          return typeof block.text === 'string' ? block.text : '';
        })
        .filter(textPart => textPart.length > 0)
        .join('');
      return text.length > 0 ? this.truncateForLog(text, maxLength) : undefined;
    }

    if (typeof source.output_text === 'string') {
      return this.truncateForLog(source.output_text, maxLength);
    }

    return undefined;
  }

  private truncateForLog(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}...`;
  }

  private isAbortError(error: any): boolean {
    return !!error && typeof error === 'object' && error.name === 'AbortError';
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<{ data: T; status: number }> {
    const response = await this.fetchResponse(url, init);
    const data = await this.readResponseData(response);
    return { data: data as T, status: response.status };
  }

  private async fetchResponse(url: string, init: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const data = await this.readResponseData(response);
      const error: any = new Error(`Request failed with status ${response.status}`);
      error.response = { status: response.status, data };
      throw error;
    }
    return response;
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
