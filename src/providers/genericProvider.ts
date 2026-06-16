import * as vscode from 'vscode';
import {
  BaseAIProvider,
  BaseLanguageModel,
  AIModelConfig,
  ChatMessage,
  ChatToolCall,
  ReasoningEffortValue,
  ReasoningEffortFormat,
  getCompactErrorMessage,
  normalizeHttpBaseUrl,
} from './baseProvider';
import { ConfigStore, VendorApiStyle, VendorConfig, VendorModelConfig } from '../config/configStore';
import {
  ANTHROPIC_EFFORT_VALUES,
  AnthropicEffort,
  CHAT_THINKING_EFFORT_VALUES,
  ChatThinkingEffort,
  DEFAULT_MODEL_TOOLS,
  DEFAULT_REQUEST_MAX_TOKENS,
  DEFAULT_RESPONSES_PERSONALITY,
  DEFAULT_TOP_P,
  EFFORT_MODEL_OPTION_KEY,
  PERSONALITY_MODEL_OPTION_KEY,
  PERSONALITY_VALUES,
  RESPONSE_TRACE_ID_FIELD,
  RESPONSES_THINKING_EFFORT_VALUES,
  ResponsesThinkingEffort,
  ResponsesPersonality,
  TEMPERATURE_MODEL_OPTION_KEY,
  THINKING_EFFORT_MODEL_OPTION_KEY,
  THINKING_TYPE_MODEL_OPTION_KEY,
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
  toVendorStateKey,
} from './genericProviderDiscovery';
import {
  ModelsDevCatalog,
  fetchModelsDevCatalog,
  inferDefaultApiStyleForModel,
  resolveModelsDevModelConfig,
} from './modelsDevCatalog';
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
  readOpenAIChatMessageContentText,
  readOpenAIChatMessageReasoningText,
  summarizeAnthropicResponseForLogging,
  summarizeOpenAIChatResponse,
  summarizeOpenAIResponsesResponse,
  toAnthropicMessages,
  toOpenAIChatMessages,
  toOpenAIResponsesPayloadParts,
} from './genericProviderProtocols';
import { attachTokenUsage, normalizeTokenUsage, NormalizedTokenUsage } from './tokenUsage';

interface GenericChatRequest {
  modelId: string;
  messages: vscode.LanguageModelChatMessage[];
  options?: vscode.LanguageModelChatRequestOptions;
  capabilities: vscode.LanguageModelChatCapabilities;
}

interface RefreshModelsOptions {
  forceDiscoveryRetry?: boolean;
  discoverFromEndpoint?: boolean;
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
  temperature?: number;
  topP: number;
}

type TemperatureModelOption = number | 'none';

interface RequestModelOptions {
  [TEMPERATURE_MODEL_OPTION_KEY]?: unknown;
  [THINKING_EFFORT_MODEL_OPTION_KEY]?: unknown;
  [EFFORT_MODEL_OPTION_KEY]?: unknown;
  [THINKING_TYPE_MODEL_OPTION_KEY]?: unknown;
  [PERSONALITY_MODEL_OPTION_KEY]?: unknown;
}

interface ResolvedThinkingOptions<Effort extends string> {
  thinking?: {
    type: 'enabled' | 'disabled';
  };
  effort?: Effort;
}

interface ResolvedOpenAIResponsesReasoningOptions {
  reasoning: {
    effort: ResponsesThinkingEffort;
  };
}

interface ResolvedAnthropicThinkingOptions {
  thinking?: {
    type: 'adaptive' | 'disabled';
  };
  effort?: AnthropicEffort;
}

type OutputLimitProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';

interface ParsedSseEvent {
  event?: string;
  data: string;
}

interface StreamingCompletionResult {
  content: string;
  reasoningContent?: string;
  toolCalls: ChatToolCall[];
  usage?: Record<string, unknown>;
  responseId?: string;
}

const MAX_REASONING_CONTENT_CACHE_ENTRIES = 512;
const EMPTY_MODEL_RESPONSE_ERROR_CODE = 'coding-plans.empty-model-response';
const RESPONSES_PERSONALITY_INSTRUCTIONS: Record<ResponsesPersonality, string> = {
  pragmatic: 'Personality: pragmatic. Be concise, direct, practical, and focused on actionable results.',
  friendly: 'Personality: friendly. Be warm, clear, collaborative, and focused on useful next steps.',
};

function markEmptyModelResponseError(error: vscode.LanguageModelError): vscode.LanguageModelError {
  try {
    Object.defineProperty(error, 'code', {
      value: EMPTY_MODEL_RESPONSE_ERROR_CODE,
      configurable: true,
      writable: true,
    });
  } catch {
    // ignore when runtime prevents overriding the code field
  }
  return error;
}

export function isEmptyModelResponseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  return (error as { code?: unknown }).code === EMPTY_MODEL_RESPONSE_ERROR_CODE;
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
      },
    };
  }
}

const LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX = '[coding-plans][language-models-discovery]';

export class GenericLanguageModel extends BaseLanguageModel {
  constructor(provider: BaseAIProvider, modelInfo: AIModelConfig) {
    super(provider, modelInfo);
  }

  async sendRequest(
    messages: vscode.LanguageModelChatMessage[],
    options?: vscode.LanguageModelChatRequestOptions,
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatResponse> {
    const provider = this.provider as GenericAIProvider;
    const request: GenericChatRequest = {
      modelId: this.id,
      messages,
      options,
      capabilities: this.capabilities,
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
  private readonly disabledStreamingModelIds = new Set<string>();
  private readonly disabledOpenAIResponsesReasoningModelIds = new Set<string>();
  private readonly emptyOpenAIChatPromptedModelKeys = new Set<string>();
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private refreshModelsInFlight: Promise<void> | undefined;
  private refreshModelsPending = false;
  private forceDiscoveryRetryRequested = false;
  private endpointDiscoveryRequested = false;
  private modelsSnapshot = '';
  private modelsDevCatalogPromise: Promise<ModelsDevCatalog | undefined> | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly configStore: ConfigStore,
  ) {
    super(context);
    this.disposables.push(
      this.configStore.onDidChange(() => {
        if (!this.configStore.isAutoRefreshModelsEnabled()) {
          logger.info(
            `${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} automatic provider refresh skipped because coding-plans.autoRefreshModels is disabled`,
          );
          return;
        }
        void this.refreshModels();
      }),
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
    return this.hydrateOpenAIChatReasoningContent(this.toProviderMessages(messages));
  }

  async refreshModels(options: RefreshModelsOptions = {}): Promise<void> {
    if (options.forceDiscoveryRetry) {
      this.forceDiscoveryRetryRequested = true;
    }
    if (options.discoverFromEndpoint) {
      this.endpointDiscoveryRequested = true;
    }

    if (this.refreshModelsInFlight) {
      this.refreshModelsPending = true;
      return this.refreshModelsInFlight;
    }

    const running = (async () => {
      do {
        const forceDiscoveryRetry = this.forceDiscoveryRetryRequested;
        const discoverFromEndpoint = this.endpointDiscoveryRequested;
        this.forceDiscoveryRetryRequested = false;
        this.endpointDiscoveryRequested = false;
        this.refreshModelsPending = false;
        await this.refreshModelsInternal({ forceDiscoveryRetry, discoverFromEndpoint });
      } while (this.refreshModelsPending || this.forceDiscoveryRetryRequested || this.endpointDiscoveryRequested);
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
    const discoverFromEndpoint = options.discoverFromEndpoint === true;
    const vendors = this.configStore.getVendors();
    logger.info('Refreshing Coding Plans vendor models', {
      vendorCount: vendors.length,
      forceDiscoveryRetry,
      discoverFromEndpoint,
      vendors: vendors.map((vendor) => this.summarizeVendorForLog(vendor)),
    });
    logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} existing discovery state before refresh`, {
      states: Array.from(this.vendorDiscoveryState.entries()).map(([vendorKey, state]) => ({
        vendorKey,
        state: this.summarizeDiscoveryStateForLog(state),
      })),
    });
    this.modelVendorMap.clear();
    const allModelConfigs: AIModelConfig[] = [];
    const activeVendorKeys = new Set(vendors.map((vendor) => toVendorStateKey(vendor.name)));

    for (const vendorKey of Array.from(this.vendorDiscoveryState.keys())) {
      if (!activeVendorKeys.has(vendorKey)) {
        this.vendorDiscoveryState.delete(vendorKey);
      }
    }

    for (const vendor of vendors) {
      if (!vendor.baseUrl) {
        logger.warn('Skip vendor with empty baseUrl', {
          vendor: this.summarizeVendorForLog(vendor),
        });
        continue;
      }
      const vendorKey = toVendorStateKey(vendor.name);
      const configuredModels = this.buildConfiguredModelsForVendor(vendor);
      const apiKey = await this.configStore.getApiKey(vendor.name);
      const diagnosticSignature = apiKey ? buildVendorDiscoverySignature(vendor, apiKey) : undefined;
      const previousState = this.vendorDiscoveryState.get(vendorKey);
      logger.info('Evaluating vendor models', {
        vendor: vendor.name,
        useModelsEndpoint: vendor.useModelsEndpoint,
        configuredCount: configuredModels.length,
      });
      logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} vendor evaluation details`, {
        vendor: this.summarizeVendorForLog(vendor),
        vendorKey,
        configuredModels: this.summarizeResolvedModelsForLog(configuredModels),
        apiKeyPresent: apiKey.trim().length > 0,
        apiKeyLength: apiKey.length,
        signature: diagnosticSignature,
        previousState: this.summarizeDiscoveryStateForLog(previousState),
        forceDiscoveryRetry,
      });

      if (!vendor.useModelsEndpoint || !discoverFromEndpoint) {
        this.vendorDiscoveryState.delete(vendorKey);
        logger.info('Using settings models for vendor', {
          vendor: vendor.name,
          discoveryEnabled: vendor.useModelsEndpoint && discoverFromEndpoint,
          modelCount: configuredModels.length,
        });
        this.appendResolvedModels(vendor, configuredModels, allModelConfigs);
        continue;
      }

      const signature = buildVendorDiscoverySignature(vendor, apiKey);

      if (!apiKey) {
        this.vendorDiscoveryState.delete(vendorKey);
        logger.warn('Missing API key; falling back to settings models', {
          vendor: vendor.name,
          fallbackCount: configuredModels.length,
        });
        this.appendResolvedModels(vendor, configuredModels, allModelConfigs);
        continue;
      }

      if (
        previousState &&
        previousState.signature === signature &&
        previousState.suppressRetry &&
        !forceDiscoveryRetry
      ) {
        const cached = previousState.cachedModels.length > 0 ? previousState.cachedModels : configuredModels;
        logger.warn('Using cached/settings models because discovery retry is suppressed', {
          vendor: vendor.name,
          cachedCount: previousState.cachedModels.length,
          fallbackCount: configuredModels.length,
          resolvedCount: cached.length,
        });
        this.appendResolvedModels(vendor, cached, allModelConfigs);
        continue;
      }

      if (
        previousState &&
        previousState.signature === signature &&
        previousState.suppressRetry &&
        forceDiscoveryRetry
      ) {
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
          resolvedCount: fallbackModels.length,
        });
        this.vendorDiscoveryState.set(vendorKey, {
          signature,
          suppressRetry: shouldSuppressDiscoveryRetry(discovered.status),
          cachedModels: fallbackModels,
        });
        this.appendResolvedModels(vendor, fallbackModels, allModelConfigs);
        continue;
      }

      const currentVendor = await this.getCurrentVendorIfDiscoverySnapshotIsCurrent(vendor, signature);
      if (!currentVendor) {
        logger.info('Skip stale /models discovery write because vendor config changed during refresh', {
          vendor: vendor.name,
          signature,
        });
        this.refreshModelsPending = true;
        if (discoverFromEndpoint) {
          this.endpointDiscoveryRequested = true;
        }
        continue;
      }

      // When useModelsEndpoint is enabled, discovered model names are the source of truth.
      // User-authored overrides are preserved while models.dev metadata refreshes automatic fields.
      const discoveredVendorModels = toVendorModelConfigs(discovered.models);
      const mergedVendorModels = mergeConfiguredModelOverrides(
        currentVendor.models,
        discoveredVendorModels,
        currentVendor.defaultVision,
        currentVendor.name,
      );
      const resolvedModels = this.buildConfiguredModelsFromVendorModels(currentVendor, mergedVendorModels);
      const discoveredSignature = buildVendorDiscoverySignature({ ...currentVendor, models: mergedVendorModels }, apiKey);
      logger.info('Using /models discovery results for vendor', {
        vendor: vendor.name,
        discoveredCount: discovered.models.length,
        normalizedCount: discoveredVendorModels.length,
        mergedCount: mergedVendorModels.length,
      });
      logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} vendor discovery merge details`, {
        vendor: vendor.name,
        discoveredModels: this.summarizeResolvedModelsForLog(discovered.models),
        discoveredVendorModels: this.summarizeVendorModelConfigsForLog(discoveredVendorModels),
        mergedVendorModels: this.summarizeVendorModelConfigsForLog(mergedVendorModels),
        resolvedModels: this.summarizeResolvedModelsForLog(resolvedModels),
        discoveredSignature,
      });

      try {
        await this.configStore.updateVendorModels(currentVendor.name, mergedVendorModels);
      } catch (error) {
        logger.warn(`Failed to update models config for ${vendor.name}.`, error);
      }

      this.vendorDiscoveryState.set(vendorKey, {
        signature: discoveredSignature,
        suppressRetry: false,
        cachedModels: resolvedModels,
      });
      this.appendResolvedModels(currentVendor, resolvedModels, allModelConfigs);
    }

    const nextModelsSnapshot = this.buildModelsSnapshot(allModelConfigs);
    const modelsChanged = nextModelsSnapshot !== this.modelsSnapshot;
    this.modelsSnapshot = nextModelsSnapshot;
    this.models = allModelConfigs.map((m) => this.createModel(m));
    logger.info('Coding Plans models refreshed', {
      modelCount: this.models.length,
      modelIds: this.models.map((m) => m.id),
      modelsChanged,
      modelVendorMapCount: this.modelVendorMap.size,
    });
    logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} final refresh snapshot`, {
      models: this.summarizeResolvedModelsForLog(allModelConfigs),
      modelVendorMappings: Array.from(this.modelVendorMap.entries())
        .slice(0, 50)
        .map(([id, mapping]) => ({
          id,
          vendor: mapping.vendor.name,
          modelName: mapping.modelName,
          apiStyle: mapping.apiStyle,
        })),
      discoveryStates: Array.from(this.vendorDiscoveryState.entries()).map(([vendorKey, state]) => ({
        vendorKey,
        state: this.summarizeDiscoveryStateForLog(state),
      })),
    });
    if (modelsChanged) {
      this.modelChangedEmitter.fire();
    } else {
      logger.debug('Coding Plans model change event skipped because model information is unchanged');
    }
  }

  private async getCurrentVendorIfDiscoverySnapshotIsCurrent(
    vendor: VendorConfig,
    signature: string,
  ): Promise<VendorConfig | undefined> {
    const currentVendor = this.configStore.getVendor(vendor.name);
    if (!currentVendor) {
      return undefined;
    }

    const currentApiKey = await this.configStore.getApiKey(currentVendor.name);
    const currentSignature = buildVendorDiscoverySignature(currentVendor, currentApiKey);
    return currentSignature === signature ? currentVendor : undefined;
  }

  async sendRequest(
    request: GenericChatRequest,
    token?: vscode.CancellationToken,
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
      protocol: mapping.apiStyle,
    };
    this.attachCancellationLogging(token, trace);
    const requestSummary = this.summarizeGenericChatRequest(request);
    logger.info('Language model request start', {
      ...trace,
      baseUrl,
      messageCount: request.messages.length,
      toolCount: request.options?.tools?.length ?? 0,
      toolMode: request.options?.toolMode,
    });
    logger.debug('Language model request payload details', {
      ...trace,
      request: requestSummary,
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
    return vendor.models.find((model) => model.name.trim().toLowerCase() === normalizedModelName);
  }

  private resolveSamplingOptions(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
  ): ResolvedSamplingOptions {
    const model = this.findConfiguredModel(vendor, modelName);
    const requestTemperature = this.readTemperatureFromModelOptions(request.options?.modelOptions);
    return {
      temperature:
        requestTemperature === 'none'
          ? undefined
          : (requestTemperature ?? model?.temperature ?? vendor.defaultTemperature),
      topP: model?.topP ?? vendor.defaultTopP ?? DEFAULT_TOP_P,
    };
  }

  private resolveResponsesPersonality(request: GenericChatRequest): ResponsesPersonality {
    return this.readPersonalityFromModelOptions(request.options?.modelOptions) ?? DEFAULT_RESPONSES_PERSONALITY;
  }

  private buildChatThinkingOptions(
    request: GenericChatRequest,
  ): ResolvedThinkingOptions<Exclude<ChatThinkingEffort, 'none'>> | undefined {
    if (!this.isModelThinkingEnabled(request)) {
      return undefined;
    }

    const thinkingToggle = this.readChatThinkingFromModelOptions(request.options?.modelOptions);

    // Explicitly disabled → force disable
    if (thinkingToggle === 'disabled') {
      return {
        thinking: {
          type: 'disabled',
        },
      };
    }

    const thinkingEffort = this.readChatThinkingEffortFromModelOptions(request.options?.modelOptions);
    if (!thinkingEffort || !this.isReasoningEffortSupported(request, thinkingEffort)) {
      // Explicitly enabled but no effort → enable without reasoning_effort
      if (thinkingToggle === 'enabled') {
        return {
          thinking: {
            type: 'enabled',
          },
        };
      }
      return undefined;
    }

    if (thinkingEffort === 'none') {
      return {
        thinking: {
          type: 'disabled',
        },
      };
    }

    if (thinkingToggle === 'default') {
      return {
        effort: thinkingEffort,
      };
    }

    return {
      thinking: {
        type: 'enabled',
      },
      effort: thinkingEffort,
    };
  }

  private buildOpenAIResponsesReasoningOptions(
    request: GenericChatRequest,
  ): ResolvedOpenAIResponsesReasoningOptions | undefined {
    if (!this.isModelThinkingEnabled(request)) {
      return undefined;
    }
    if (this.disabledOpenAIResponsesReasoningModelIds.has(request.modelId)) {
      return undefined;
    }

    const effort = this.readOpenAIResponsesThinkingEffortFromModelOptions(request.options?.modelOptions);
    if (!effort || !this.isReasoningEffortSupported(request, effort)) {
      return undefined;
    }

    return {
      reasoning: {
        effort,
      },
    };
  }

  private buildAnthropicThinkingOptions(request: GenericChatRequest): ResolvedAnthropicThinkingOptions | undefined {
    if (!this.isModelThinkingEnabled(request)) {
      return undefined;
    }
    const modelOptions = request.options?.modelOptions;
    const thinking = this.readAnthropicThinkingFromModelOptions(modelOptions);
    const effort = this.readAnthropicEffortFromModelOptions(modelOptions);
    const supportedEffort = effort && this.isReasoningEffortSupported(request, effort) ? effort : undefined;
    if (thinking === undefined && !supportedEffort) {
      return undefined;
    }

    return {
      ...(thinking === undefined ? {} : { thinking: { type: thinking ? 'adaptive' : 'disabled' } as const }),
      ...(supportedEffort ? { effort: supportedEffort } : {}),
    };
  }

  private isModelThinkingEnabled(request: GenericChatRequest): boolean {
    return this.getModel(request.modelId)?.capabilities.thinking !== false;
  }

  private isReasoningEffortSupported(request: GenericChatRequest, effort: ReasoningEffortValue): boolean {
    const supported = this.getModel(request.modelId)?.supportsReasoningEffort;
    if (!supported || supported.length === 0) {
      return true;
    }
    return supported.includes(effort);
  }

  private readChatThinkingEffortFromModelOptions(modelOptions: unknown): ChatThinkingEffort | undefined {
    const normalized = this.readNormalizedModelOptionString(modelOptions, THINKING_EFFORT_MODEL_OPTION_KEY);
    if (!normalized) {
      return undefined;
    }
    if (normalized === 'disabled') {
      return 'none';
    }
    return CHAT_THINKING_EFFORT_VALUES.includes(normalized as ChatThinkingEffort)
      ? (normalized as ChatThinkingEffort)
      : undefined;
  }

  private readOpenAIResponsesThinkingEffortFromModelOptions(
    modelOptions: unknown,
  ): ResponsesThinkingEffort | undefined {
    const normalized = this.readNormalizedModelOptionString(modelOptions, THINKING_EFFORT_MODEL_OPTION_KEY);
    if (!normalized) {
      return undefined;
    }
    if (normalized === 'max') {
      return 'xhigh';
    }
    return RESPONSES_THINKING_EFFORT_VALUES.includes(normalized as ResponsesThinkingEffort)
      ? (normalized as ResponsesThinkingEffort)
      : undefined;
  }

  private readAnthropicEffortFromModelOptions(modelOptions: unknown): AnthropicEffort | undefined {
    const normalized =
      this.readNormalizedModelOptionString(modelOptions, EFFORT_MODEL_OPTION_KEY) ??
      this.readNormalizedModelOptionString(modelOptions, THINKING_EFFORT_MODEL_OPTION_KEY);
    if (!normalized) {
      return undefined;
    }
    if (normalized === 'none' || normalized === 'disabled') {
      return undefined;
    }
    return ANTHROPIC_EFFORT_VALUES.includes(normalized as AnthropicEffort)
      ? (normalized as AnthropicEffort)
      : undefined;
  }

  private readAnthropicThinkingFromModelOptions(modelOptions: unknown): boolean | undefined {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return undefined;
    }

    const raw = (modelOptions as RequestModelOptions)[THINKING_TYPE_MODEL_OPTION_KEY];
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (typeof raw !== 'string') {
      return undefined;
    }

    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'enabled' || normalized === 'adaptive' || normalized === 'think') {
      return true;
    }
    if (normalized === 'false' || normalized === 'disabled' || normalized === 'none' || normalized === 'non-think') {
      return false;
    }
    return undefined;
  }

  private readChatThinkingFromModelOptions(modelOptions: unknown): 'enabled' | 'disabled' | 'default' | undefined {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return undefined;
    }

    const raw = (modelOptions as RequestModelOptions)[THINKING_TYPE_MODEL_OPTION_KEY];
    if (typeof raw !== 'string') {
      return undefined;
    }

    const normalized = raw.trim().toLowerCase();
    if (normalized === 'enabled') {
      return 'enabled';
    }
    if (normalized === 'disabled') {
      return 'disabled';
    }
    if (normalized === 'default') {
      return 'default';
    }
    return undefined;
  }

  private readNormalizedModelOptionString(modelOptions: unknown, key: keyof RequestModelOptions): string | undefined {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return undefined;
    }

    const raw = (modelOptions as RequestModelOptions)[key];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().toLowerCase() : undefined;
  }

  private readPersonalityFromModelOptions(modelOptions: unknown): ResponsesPersonality | undefined {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return undefined;
    }

    const raw = (modelOptions as RequestModelOptions)[PERSONALITY_MODEL_OPTION_KEY];
    if (typeof raw !== 'string') {
      return undefined;
    }

    const normalized = raw.trim().toLowerCase();
    return PERSONALITY_VALUES.includes(normalized as ResponsesPersonality)
      ? (normalized as ResponsesPersonality)
      : undefined;
  }

  private readTemperatureFromModelOptions(modelOptions: unknown): TemperatureModelOption | undefined {
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return undefined;
    }

    const raw = (modelOptions as RequestModelOptions)[TEMPERATURE_MODEL_OPTION_KEY];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return this.normalizeModelOptionTemperature(raw);
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'inherit') {
        return undefined;
      }
      if (normalized === 'none') {
        return 'none';
      }
      return this.normalizeModelOptionTemperature(Number(normalized));
    }
    return undefined;
  }

  private normalizeModelOptionTemperature(value: number): TemperatureModelOption | undefined {
    if (!Number.isFinite(value)) {
      return undefined;
    }

    if (Math.abs(value) < 1e-9) {
      return 'none';
    }

    const supportedTemperatures = [0.1, 0.4, 0.7, 1];
    return supportedTemperatures.find((candidate) => Math.abs(candidate - value) < 1e-9);
  }

  private buildOpenAIResponsesInstructions(
    baseInstructions: string | undefined,
    personality: ResponsesPersonality,
  ): string {
    return [baseInstructions?.trim(), RESPONSES_PERSONALITY_INSTRUCTIONS[personality]]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n');
  }

  private shouldSendOutputTokenLimit(
    _vendor: VendorConfig,
    _modelName: string,
    protocol: OutputLimitProtocol,
  ): boolean {
    if (protocol === 'anthropic') {
      // Anthropic-compatible endpoints require max_tokens in request payloads.
      return true;
    }
    return false;
  }

  protected createModel(modelInfo: AIModelConfig): BaseLanguageModel {
    return new GenericLanguageModel(this, modelInfo);
  }

  private buildModelFromVendorConfig(
    model: VendorModelConfig,
    vendor: VendorConfig,
    compositeId: string,
  ): AIModelConfig {
    const resolvedTokens = this.resolveTokenWindowLimits(
      model.contextSize,
      model.maxInputTokens,
      model.maxOutputTokens,
    );
    const toolCalling = model.toolCalling ?? model.capabilities?.tools ?? DEFAULT_MODEL_TOOLS;
    const imageInput = model.vision ?? model.capabilities?.vision ?? vendor.defaultVision;
    const thinking = model.capabilities?.thinking;
    const apiStyle = model.apiStyle ?? vendor.defaultApiStyle;

    return {
      id: compositeId,
      vendor: 'coding-plans',
      family: vendor.name,
      name: model.name,
      version: vendor.name,
      maxTokens: resolvedTokens.maxTokens,
      maxInputTokens: resolvedTokens.maxInputTokens,
      maxOutputTokens: resolvedTokens.maxOutputTokens,
      capabilities: { toolCalling, imageInput, ...(typeof thinking === 'boolean' ? { thinking } : {}) },
      apiStyle,
      apiType: model.apiType ?? this.apiStyleToApiType(apiStyle),
      streaming: model.streaming,
      editTools: model.editTools,
      supportsReasoningEffort: model.supportsReasoningEffort,
      reasoningEffortFormat: model.reasoningEffortFormat ?? this.apiStyleToReasoningEffortFormat(apiStyle),
      zeroDataRetentionEnabled: model.zeroDataRetentionEnabled,
      inputCost: model.price?.inputCost,
      cacheCost: model.price?.cacheCost,
      outputCost: model.price?.outputCost,
      longContextInputCost: model.price?.longContextInputCost,
      longContextCacheCost: model.price?.longContextCacheCost,
      longContextOutputCost: model.price?.longContextOutputCost,
      description: model.description || getMessage('genericDynamicModelDescription', vendor.name, model.name),
    };
  }

  private apiStyleToApiType(apiStyle: VendorApiStyle): 'chat' | 'responses' | 'anthropic' {
    return apiStyle === 'openai-responses' ? 'responses' : apiStyle === 'anthropic' ? 'anthropic' : 'chat';
  }

  private apiStyleToReasoningEffortFormat(apiStyle: VendorApiStyle): ReasoningEffortFormat | undefined {
    if (apiStyle === 'openai-responses') {
      return 'responses';
    }
    if (apiStyle === 'openai-chat') {
      return 'chat-completions';
    }
    // anthropic style does not use reasoningEffortFormat
    return undefined;
  }

  private buildConfiguredModelsForVendor(vendor: VendorConfig): AIModelConfig[] {
    return this.buildConfiguredModelsFromVendorModels(vendor, vendor.models);
  }

  private hydrateOpenAIChatReasoningContent(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (
        message.role !== 'assistant' ||
        (message.tool_calls?.length ?? 0) === 0 ||
        message.reasoning_content?.trim()
      ) {
        return message;
      }

      const reasoningContent = this.resolveCachedReasoningContentForToolCalls(message.tool_calls ?? []);
      if (!reasoningContent) {
        return message;
      }

      return {
        ...message,
        reasoning_content: reasoningContent,
      };
    });
  }

  private resolveCachedReasoningContentForToolCalls(toolCalls: ChatToolCall[]): string | undefined {
    const distinctReasoningContents = new Set<string>();
    for (const toolCall of toolCalls) {
      const callId = typeof toolCall.id === 'string' ? toolCall.id.trim() : '';
      if (!callId) {
        continue;
      }
      const reasoningContent = this.reasoningContentByToolCallId.get(callId);
      if (reasoningContent?.trim()) {
        distinctReasoningContents.add(reasoningContent);
      }
    }

    if (distinctReasoningContents.size === 0) {
      return undefined;
    }

    if (distinctReasoningContents.size > 1) {
      logger.warn('Conflicting cached reasoning_content detected for assistant tool continuation', {
        toolCallIds: toolCalls
          .map((toolCall) => toolCall.id)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      });
    }

    return distinctReasoningContents.values().next().value;
  }

  private cacheReasoningContentForToolCalls(
    toolCalls: ChatToolCall[] | undefined,
    reasoningContent: string | undefined,
  ): void {
    const normalizedReasoningContent = reasoningContent?.trim();
    if (!normalizedReasoningContent || !toolCalls?.length) {
      return;
    }

    for (const toolCall of toolCalls) {
      const callId = typeof toolCall.id === 'string' ? toolCall.id.trim() : '';
      if (!callId) {
        continue;
      }
      this.reasoningContentByToolCallId.delete(callId);
      this.reasoningContentByToolCallId.set(callId, normalizedReasoningContent);
    }

    while (this.reasoningContentByToolCallId.size > MAX_REASONING_CONTENT_CACHE_ENTRIES) {
      const oldestKey = this.reasoningContentByToolCallId.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.reasoningContentByToolCallId.delete(oldestKey);
    }
  }

  private buildConfiguredModelsFromVendorModels(
    vendor: VendorConfig,
    vendorModels: VendorModelConfig[],
  ): AIModelConfig[] {
    const models: AIModelConfig[] = [];
    for (const model of vendorModels) {
      if (model.enabled === false) {
        continue;
      }
      const compositeId = `${vendor.name}/${model.name}`;
      models.push(this.buildModelFromVendorConfig(model, vendor, compositeId));
    }
    return models;
  }

  private appendResolvedModels(vendor: VendorConfig, models: AIModelConfig[], target: AIModelConfig[]): void {
    const configuredApiStyleByName = new Map<string, VendorApiStyle>();
    for (const vendorModel of vendor.models) {
      configuredApiStyleByName.set(
        vendorModel.name.trim().toLowerCase(),
        vendorModel.apiStyle ?? vendor.defaultApiStyle,
      );
    }
    logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} append resolved models`, {
      vendor: vendor.name,
      incomingCount: models.length,
      incomingModels: this.summarizeResolvedModelsForLog(models),
      configuredApiStyles: Array.from(configuredApiStyleByName.entries())
        .slice(0, 20)
        .map(([name, apiStyle]) => ({
          name,
          apiStyle,
        })),
    });

    for (const model of models) {
      const actualName = model.id.includes('/') ? model.id.substring(model.id.indexOf('/') + 1) : model.id;
      const apiStyle = configuredApiStyleByName.get(actualName.trim().toLowerCase()) ?? vendor.defaultApiStyle;
      this.modelVendorMap.set(model.id, { vendor, modelName: actualName, apiStyle });
    }
    target.push(...models);
  }

  private buildModelsSnapshot(models: AIModelConfig[]): string {
    return JSON.stringify(
      models.map((model) => ({
        id: model.id,
        vendor: model.vendor,
        family: model.family,
        name: model.name,
        apiStyle: model.apiStyle,
        version: model.version,
        maxTokens: model.maxTokens,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: model.capabilities,
        inputCost: model.inputCost,
        cacheCost: model.cacheCost,
        outputCost: model.outputCost,
        longContextInputCost: model.longContextInputCost,
        longContextCacheCost: model.longContextCacheCost,
        longContextOutputCost: model.longContextOutputCost,
        description: model.description,
      })),
    );
  }

  private async getModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
    if (!this.modelsDevCatalogPromise) {
      this.modelsDevCatalogPromise = fetchModelsDevCatalog().then((catalog) => {
        if (!catalog) {
          this.modelsDevCatalogPromise = undefined;
        }
        return catalog;
      }).catch((error) => {
        logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} models.dev catalog unavailable`, {
          error: this.summarizeError(error),
        });
        this.modelsDevCatalogPromise = undefined;
        return undefined;
      });
    }
    return this.modelsDevCatalogPromise;
  }

  private async discoverModelsFromApi(vendor: VendorConfig, apiKey: string): Promise<ModelDiscoveryResult> {
    try {
      const baseUrl = normalizeHttpBaseUrl(vendor.baseUrl);
      if (!baseUrl) {
        logger.warn(
          `${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} skip /models discovery because normalized baseUrl is empty`,
          {
            vendor: this.summarizeVendorForLog(vendor),
          },
        );
        return { models: [], failed: false };
      }
      logger.info(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} starting /models discovery`, {
        vendor: vendor.name,
        baseUrl,
        defaultApiStyle: vendor.defaultApiStyle,
        configuredModelCount: vendor.models.length,
        apiKeyPresent: apiKey.trim().length > 0,
        apiKeyLength: apiKey.length,
      });

      const resolved = await this.withOptionalV1Retry(vendor, baseUrl, async (retryBaseUrl) => {
        const response = await this.fetchJson<any>(`${retryBaseUrl}/models`, {
          method: 'GET',
          ...this.buildRequestInit(apiKey, vendor.defaultApiStyle),
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
      const modelsDevCatalog = entries.length > 0 ? await this.getModelsDevCatalog() : undefined;
      logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} raw /models response`, {
        vendor: vendor.name,
        requestedBaseUrl: baseUrl,
        resolvedBaseUrl: resolved.baseUrl,
        status: response.status,
        modelsDevCatalogAvailable: modelsDevCatalog !== undefined,
        topLevelType: Array.isArray(data) ? 'array' : typeof data,
        topLevelKeys:
          data && typeof data === 'object' && !Array.isArray(data)
            ? Object.keys(data as Record<string, unknown>).slice(0, 20)
            : [],
        entryCount: entries.length,
        entryPreview: entries.slice(0, 10).map((entry) => this.summarizeRawDiscoveryEntryForLog(entry)),
      });

      const models: AIModelConfig[] = [];
      const seen = new Set<string>();
      let skippedMissingIdCount = 0;
      let skippedDuplicateCount = 0;
      let skippedNonChatCount = 0;
      const skippedPreview: Array<Record<string, unknown>> = [];

      for (const entry of entries) {
        const modelId = this.readModelId(entry);
        if (!modelId) {
          skippedMissingIdCount += 1;
          if (skippedPreview.length < 10) {
            skippedPreview.push({
              reason: 'missing-id',
              entry: this.summarizeRawDiscoveryEntryForLog(entry),
            });
          }
          continue;
        }
        if (seen.has(modelId.toLowerCase())) {
          skippedDuplicateCount += 1;
          if (skippedPreview.length < 10) {
            skippedPreview.push({
              reason: 'duplicate',
              modelId,
            });
          }
          continue;
        }
        if (!this.isLikelyChatModel(modelId)) {
          skippedNonChatCount += 1;
          if (skippedPreview.length < 10) {
            skippedPreview.push({
              reason: 'non-chat-model',
              modelId,
            });
          }
          continue;
        }
        seen.add(modelId.toLowerCase());

        const modelsDevConfig = resolveModelsDevModelConfig(modelsDevCatalog, modelId);
        const inferredApiStyle = modelsDevConfig?.apiStyle ?? inferDefaultApiStyleForModel(modelId);
        const runtime = this.readRuntimeFromGenericModelEntry(entry);
        const resolvedTokens = this.resolveTokenWindowLimits(
          modelsDevConfig?.contextSize ?? runtime.maxTokens,
          runtime.maxInputTokens,
          runtime.maxOutputTokens,
        );
        const compositeId = `${vendor.name}/${modelId}`;
        const modelsDevToolCalling = modelsDevConfig?.capabilities?.tools;
        const modelsDevVision = modelsDevConfig?.capabilities?.vision;
        const modelsDevThinking = modelsDevConfig?.capabilities?.thinking;
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
            toolCalling: modelsDevToolCalling ?? runtime.toolCalling ?? DEFAULT_MODEL_TOOLS,
            imageInput: modelsDevVision ?? vendor.defaultVision,
            ...(typeof modelsDevThinking === 'boolean' ? { thinking: modelsDevThinking } : {}),
          },
          apiStyle: inferredApiStyle,
          inputCost: modelsDevConfig?.price?.inputCost,
          cacheCost: modelsDevConfig?.price?.cacheCost,
          outputCost: modelsDevConfig?.price?.outputCost,
          longContextInputCost: modelsDevConfig?.price?.longContextInputCost,
          longContextCacheCost: modelsDevConfig?.price?.longContextCacheCost,
          longContextOutputCost: modelsDevConfig?.price?.longContextOutputCost,
          modelsDevEnriched: modelsDevConfig !== undefined,
          description: modelsDevConfig?.description ?? getMessage('genericDynamicModelDescription', vendor.name, modelId),
        });
      }

      logger.info(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} completed /models discovery`, {
        vendor: vendor.name,
        resolvedBaseUrl: resolved.baseUrl,
        status: response.status,
        entryCount: entries.length,
        acceptedCount: models.length,
        skippedMissingIdCount,
        skippedDuplicateCount,
        skippedNonChatCount,
      });
      logger.debug(`${LANGUAGE_MODELS_DISCOVERY_LOG_PREFIX} /models discovery details`, {
        vendor: vendor.name,
        models: this.summarizeResolvedModelsForLog(models),
        skippedPreview,
      });

      return { models, failed: false };
    } catch (error) {
      logger.warn(`Failed to discover models from ${vendor.name}`, {
        vendor: this.summarizeVendorForLog(vendor),
        error: this.summarizeError(error),
      });
      return {
        models: [],
        failed: true,
        status:
          typeof (error as { response?: { status?: unknown } })?.response?.status === 'number'
            ? (error as { response: { status: number } }).response.status
            : undefined,
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
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatResponse> {
    const providerMessages = this.convertMessages(request.messages);
    const messages = toOpenAIChatMessages(providerMessages);
    const supportsToolCalling = !!request.capabilities.toolCalling;
    const sampling = this.resolveSamplingOptions(request, vendor, modelName);
    const thinkingOptions = this.buildChatThinkingOptions(request);
    const tools = supportsToolCalling ? this.buildToolDefinitions(request.options) : undefined;
    const toolChoice = supportsToolCalling ? this.buildToolChoice(request.options) : undefined;
    const streamAllowed = this.isStreamingAllowed(request);
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName, 'openai-chat')
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxTokens = requestedOutputLimit;

    const payload: OpenAIChatRequest = {
      model: modelName,
      messages,
      tools,
      tool_choice: toolChoice,
      stream: streamAllowed,
      ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
      ...(sampling.topP > 0 ? { top_p: sampling.topP } : {}),
      ...(thinkingOptions?.thinking ? { thinking: thinkingOptions.thinking } : {}),
      ...(thinkingOptions?.effort ? { reasoning_effort: thinkingOptions.effort } : {}),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    };

    try {
      logger.debug('Prepared OpenAI chat payload', {
        ...trace,
        baseUrl,
        payload: {
          temperature: payload.temperature,
          topP: payload.top_p,
          thinking: payload.thinking,
          reasoningEffort: payload.reasoning_effort,
          maxTokens: payload.max_tokens,
          stream: payload.stream,
          toolChoice: payload.tool_choice,
          toolCount: payload.tools?.length ?? 0,
          messages: this.summarizeProviderMessages(providerMessages),
        },
      });
      const requestInit = this.buildRequestInit(apiKey, 'openai-chat', token);
      const response = await this.withOptionalV1Retry(
        vendor,
        baseUrl,
        (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/chat/completions`, payload, requestInit, trace),
        trace,
      );
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'openai-chat',
          request,
          vendor,
          modelName,
          payload.max_tokens,
          async (queue) => {
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
            this.cacheReasoningContentForToolCalls(finalized.toolCalls, finalized.reasoningContent);
            this.logUpstreamResponseSummary('openai-chat', vendor, modelName, {
              mode: 'stream',
              responseId: state.responseId,
              contentLength: finalized.content.length,
              toolCallCount: finalized.toolCalls.length,
              usage: finalized.usage,
            });
            return {
              content: finalized.content,
              reasoningContent: finalized.reasoningContent,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId,
            };
          },
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
        payload.max_tokens,
      );
    } catch (error: any) {
      if (this.shouldFallbackToNonStream(error)) {
        this.disableStreamingForSession(request.modelId, 'anthropic_stream_unsupported', trace);
        logger.warn('OpenAI chat stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(error),
        });
        try {
          const fallbackPayload: OpenAIChatRequest = { ...payload, stream: false };
          const requestInit = this.buildRequestInit(apiKey, 'openai-chat', token);
          const fallbackResponse = await this.withOptionalV1Retry(
            vendor,
            baseUrl,
            (retryBaseUrl) =>
              this.postWithRetry(`${retryBaseUrl}/chat/completions`, fallbackPayload, requestInit, trace),
            trace,
          );
          const parsedFallback = await this.readParsedResponse<OpenAIChatResponse>(fallbackResponse);
          return this.buildOpenAIChatResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens,
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('OpenAI chat fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message,
          });
          throw providerError;
        }
      }

      if (payload.max_tokens === undefined && this.shouldRetryWithRequiredMaxTokens(error)) {
        logger.warn('OpenAI chat request requires explicit max_tokens; retrying with fallback output limit', {
          ...trace,
          error: this.summarizeError(error),
        });
        try {
          const fallbackPayload: OpenAIChatRequest = {
            ...payload,
            stream: false,
            max_tokens: this.resolveRequiredOutputLimit(request),
          };
          const requestInit = this.buildRequestInit(apiKey, 'openai-chat', token);
          const fallbackResponse = await this.withOptionalV1Retry(
            vendor,
            baseUrl,
            (retryBaseUrl) =>
              this.postWithRetry(`${retryBaseUrl}/chat/completions`, fallbackPayload, requestInit, trace),
            trace,
          );
          const parsedFallback = await this.readParsedResponse<OpenAIChatResponse>(fallbackResponse);
          return this.buildOpenAIChatResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens,
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('OpenAI chat max_tokens recovery retry failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message,
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(error);
      logger.error('OpenAI chat request failed', {
        ...trace,
        error: this.summarizeError(error),
        translatedError: providerError.message,
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
    maxTokens: number | undefined,
  ): vscode.LanguageModelChatResponse {
    const responseMessage = response.choices[0]?.message;
    const directContent = readOpenAIChatMessageContentText(responseMessage);
    const reasoningContent = readOpenAIChatMessageReasoningText(responseMessage);
    const content = directContent || ((responseMessage?.tool_calls?.length ?? 0) > 0 ? '' : reasoningContent);
    const usageData = response.usage;
    this.cacheReasoningContentForToolCalls(responseMessage?.tool_calls, reasoningContent);
    this.ensureNonEmptyCompletion('openai-chat', trace, vendor, modelName, content, responseMessage?.tool_calls);
    this.logUpstreamResponseSummary('openai-chat', vendor, modelName, summarizeOpenAIChatResponse(response));
    logger.debug('Parsed OpenAI chat response', {
      ...trace,
      responseId: response.id,
      content,
      contentLength: content.length,
      reasoningContentLength: reasoningContent.length,
      toolCallCount: responseMessage?.tool_calls?.length ?? 0,
      usage: usageData,
    });
    const responseParts = this.buildResponseParts(content, responseMessage?.tool_calls, reasoningContent);
    const result = this.buildLoggedChatResponse(trace, content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'openai-chat',
      usageData as Record<string, unknown> | undefined,
      maxTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxTokens),
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
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatResponse> {
    const providerMessages = this.convertMessages(request.messages);
    const sampling = this.resolveSamplingOptions(request, vendor, modelName);
    const reasoningOptions = this.buildOpenAIResponsesReasoningOptions(request);
    const personality = this.resolveResponsesPersonality(request);
    const tools = request.capabilities.toolCalling
      ? buildOpenAIResponsesToolDefinitions(this.buildToolDefinitions(request.options))
      : undefined;
    const toolChoice = request.capabilities.toolCalling ? this.buildToolChoice(request.options) : undefined;
    const responsesToolChoice = toolChoice === 'required' ? toolChoice : undefined;
    const streamAllowed = this.isStreamingAllowed(request);
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName, 'openai-responses')
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxOutputTokens = requestedOutputLimit;
    const responsesPayloadParts = toOpenAIResponsesPayloadParts(providerMessages, () => this.generateToolCallId());
    const instructions = this.buildOpenAIResponsesInstructions(responsesPayloadParts.instructions, personality);
    const payload: OpenAIResponsesRequest = {
      model: modelName,
      ...responsesPayloadParts,
      ...(instructions.length > 0 ? { instructions } : {}),
      tools,
      tool_choice: responsesToolChoice,
      ...(sampling.topP > 0 ? { top_p: sampling.topP } : {}),
      ...(reasoningOptions?.reasoning ? { reasoning: reasoningOptions.reasoning } : {}),
      stream: streamAllowed,
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    };

    const sendPayload = async (nextPayload: OpenAIResponsesRequest): Promise<vscode.LanguageModelChatResponse> => {
      logger.debug('Prepared OpenAI responses payload', {
        ...trace,
        baseUrl,
        payload: {
          personality,
          topP: nextPayload.top_p,
          reasoning: nextPayload.reasoning,
          maxOutputTokens: nextPayload.max_output_tokens,
          toolChoice: nextPayload.tool_choice,
          toolCount: nextPayload.tools?.length ?? 0,
          providerMessages: this.summarizeProviderMessages(providerMessages),
          instructionsLength: nextPayload.instructions?.length ?? 0,
          input: this.summarizeOpenAIResponsesInput(nextPayload.input),
        },
      });
      const requestInit = this.buildRequestInit(apiKey, 'openai-responses', token);
      const response = await this.withOptionalV1Retry(
        vendor,
        baseUrl,
        (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/responses`, nextPayload, requestInit, trace),
        trace,
      );
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'openai-responses',
          request,
          vendor,
          modelName,
          nextPayload.max_output_tokens,
          async (queue) => {
            const state = createOpenAIResponsesStreamState();
            for await (const event of this.readSseEvents(response)) {
              if (event.data === '[DONE]') {
                break;
              }
              const streamEvent = this.tryParseJson<OpenAIResponsesStreamEvent>(event.data);
              if (!streamEvent) {
                continue;
              }
              const update = applyOpenAIResponsesStreamEvent(state, event.event, streamEvent, () =>
                this.generateToolCallId(),
              );
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
              usage: finalized.usage,
            });
            return {
              content: finalized.content,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId,
            };
          },
        );
      }

      logger.warn(
        'OpenAI responses stream request returned non-SSE response; falling back to non-stream parsing',
        trace,
      );
      const parsedResponse = await this.readParsedResponse<OpenAIResponsesResponse>(response);
      return this.buildOpenAIResponsesResponseFromPayload(
        request,
        vendor,
        modelName,
        trace,
        parsedResponse,
        nextPayload.max_output_tokens,
      );
    };

    let effectivePayload = payload;
    try {
      return await sendPayload(effectivePayload);
    } catch (error: any) {
      let handledError = error;
      if (this.shouldRetryOpenAIResponsesWithoutReasoning(handledError, effectivePayload)) {
        effectivePayload = this.withoutOpenAIResponsesReasoning(effectivePayload);
        this.disableOpenAIResponsesReasoningForSession(request.modelId, 'unsupported_parameter', trace);
        logger.warn('OpenAI responses reasoning parameters are unsupported upstream; retrying without reasoning', {
          ...trace,
          error: this.summarizeError(handledError),
        });
        try {
          return await sendPayload(effectivePayload);
        } catch (retryError) {
          handledError = retryError;
        }
      }

      if (this.shouldFallbackToNonStream(handledError)) {
        this.disableStreamingForSession(request.modelId, 'anthropic_stream_unsupported', trace);
        logger.warn('OpenAI responses stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(handledError),
        });
        try {
          const fallbackPayload: OpenAIResponsesRequest = { ...effectivePayload, stream: false };
          return await sendPayload(fallbackPayload);
        } catch (fallbackError) {
          if (this.shouldRetryOpenAIResponsesWithoutReasoning(fallbackError, effectivePayload)) {
            const fallbackPayload = this.withoutOpenAIResponsesReasoning({ ...effectivePayload, stream: false });
            this.disableOpenAIResponsesReasoningForSession(request.modelId, 'unsupported_parameter', trace);
            logger.warn(
              'OpenAI responses reasoning parameters are unsupported on non-stream retry; retrying without reasoning',
              {
                ...trace,
                error: this.summarizeError(fallbackError),
              },
            );
            try {
              return await sendPayload(fallbackPayload);
            } catch (reasoningFallbackError) {
              fallbackError = reasoningFallbackError;
            }
          }
          const providerError = this.toProviderError(fallbackError);
          logger.error('OpenAI responses fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message,
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(handledError);
      logger.error('OpenAI responses request failed', {
        ...trace,
        error: this.summarizeError(handledError),
        translatedError: providerError.message,
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
    maxOutputTokens: number | undefined,
  ): vscode.LanguageModelChatResponse {
    this.logUpstreamResponseSummary('openai-responses', vendor, modelName, summarizeOpenAIResponsesResponse(response));
    const parsed = parseOpenAIResponsesResponse(response, () => this.generateToolCallId());
    this.ensureNonEmptyCompletion('openai-responses', trace, vendor, modelName, parsed.content, parsed.toolCalls);
    logger.debug('Parsed OpenAI responses payload', {
      ...trace,
      responseId: response.id,
      outputCount: response.output?.length ?? 0,
      outputText: response.output_text,
      outputTextLength: typeof response.output_text === 'string' ? response.output_text.length : 0,
      parsedContent: parsed.content,
      parsedContentLength: parsed.content.length,
      parsedToolCallCount: parsed.toolCalls.length,
      parsedToolCalls: parsed.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        argumentsLength: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments.length : 0,
      })),
      usage: response.usage,
    });
    const responseParts = this.buildResponseParts(parsed.content, parsed.toolCalls);
    logger.debug('Built OpenAI responses result parts', {
      ...trace,
      responseParts: this.summarizeResponseParts(responseParts),
    });
    const result = this.buildLoggedChatResponse(trace, parsed.content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'openai-responses',
      response.usage as Record<string, unknown> | undefined,
      maxOutputTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxOutputTokens),
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
    token?: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatResponse> {
    const providerMessages = this.convertMessages(request.messages);
    const sampling = this.resolveSamplingOptions(request, vendor, modelName);
    const thinkingOptions = this.buildAnthropicThinkingOptions(request);
    const { system, messages } = toAnthropicMessages(providerMessages, () => this.generateToolCallId());
    const tools = request.capabilities.toolCalling
      ? buildAnthropicToolDefinitions(this.buildToolDefinitions(request.options))
      : undefined;
    const streamAllowed = this.isStreamingAllowed(request);
    const requestedOutputLimit = this.shouldSendOutputTokenLimit(vendor, modelName, 'anthropic')
      ? this.resolveRequestedOutputLimit(request)
      : undefined;
    const maxTokens = requestedOutputLimit;
    const payload: AnthropicChatRequest = {
      model: modelName,
      system: system || undefined,
      messages,
      tools,
      tool_choice: tools ? buildAnthropicToolChoice(request.options) : undefined,
      ...(thinkingOptions?.thinking ? { thinking: thinkingOptions.thinking } : {}),
      ...(thinkingOptions?.effort ? { output_config: { effort: thinkingOptions.effort } } : {}),
      ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
      stream: streamAllowed,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    };

    try {
      logger.debug('Prepared Anthropic payload', {
        ...trace,
        baseUrl,
        payload: {
          maxTokens: payload.max_tokens,
          thinking: payload.thinking,
          outputConfig: payload.output_config,
          temperature: payload.temperature,
          topP: payload.top_p,
          stream: payload.stream,
          toolChoice: payload.tool_choice,
          toolCount: payload.tools?.length ?? 0,
          systemLength: typeof payload.system === 'string' ? payload.system.length : 0,
          providerMessages: this.summarizeProviderMessages(providerMessages),
          messageCount: payload.messages.length,
        },
      });
      const requestInit = this.buildRequestInit(apiKey, 'anthropic', token);
      const response = await this.withOptionalV1Retry(
        vendor,
        baseUrl,
        (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/messages`, payload, requestInit, trace),
        trace,
      );
      if (this.isSseResponse(response)) {
        return this.buildStreamingChatResponse(
          trace,
          'anthropic',
          request,
          vendor,
          modelName,
          payload.max_tokens,
          async (queue) => {
            const state = createAnthropicStreamState();
            const streamEventSummaries: Array<Record<string, unknown>> = [];
            for await (const event of this.readSseEvents(response)) {
              if (event.data === '[DONE]') {
                break;
              }
              const streamEvent = this.tryParseJson<AnthropicStreamEvent>(event.data);
              if (!streamEvent) {
                continue;
              }
              const eventSummary = this.summarizeAnthropicStreamEvent(event.event, streamEvent);
              if (streamEventSummaries.length < 40) {
                streamEventSummaries.push(eventSummary);
              }
              logger.debug('Anthropic stream event received', {
                ...trace,
                event: eventSummary,
              });
              if (this.isAnthropicErrorStreamEvent(event.event, streamEvent)) {
                logger.warn('Anthropic stream returned error event', {
                  ...trace,
                  event: eventSummary,
                });
                throw this.toProviderError(this.buildAnthropicStreamError(streamEvent));
              }
              const update = applyAnthropicStreamEvent(state, event.event, streamEvent);
              if (update.textDelta.length > 0) {
                queue.push(new vscode.LanguageModelTextPart(update.textDelta));
              }
            }
            const finalized = finalizeAnthropicStreamState(state, () => this.generateToolCallId());
            if (finalized.content.trim().length === 0 && finalized.toolCalls.length === 0) {
              logger.warn('Anthropic stream finalized without text or tool calls', {
                ...trace,
                responseId: state.responseId,
                stopReason: state.stopReason,
                usage: state.usage,
                recentEvents: streamEventSummaries,
              });
            }
            if (this.hasMalformedAnthropicStreamToolArguments(finalized.toolCalls)) {
              this.disableStreamingForSession(request.modelId, 'anthropic_malformed_tool_arguments', trace);
              logger.warn('Anthropic stream produced malformed tool arguments; retrying without stream', {
                ...trace,
                responseId: state.responseId,
                toolCallCount: finalized.toolCalls.length,
              });
              const fallbackPayload: AnthropicChatRequest = { ...payload, stream: false };
              const fallbackResponse = await this.withOptionalV1Retry(
                vendor,
                baseUrl,
                (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/messages`, fallbackPayload, requestInit, trace),
                trace,
              );
              const parsedFallback = await this.readParsedResponse<AnthropicChatResponse>(fallbackResponse);
              return this.parseAnthropicCompletion(vendor, modelName, trace, parsedFallback);
            }
            this.logUpstreamResponseSummary('anthropic', vendor, modelName, {
              mode: 'stream',
              responseId: state.responseId,
              contentLength: finalized.content.length,
              toolCallCount: finalized.toolCalls.length,
              usage: finalized.usage,
              stopReason: state.stopReason,
            });
            return {
              content: finalized.content,
              toolCalls: finalized.toolCalls,
              usage: finalized.usage as Record<string, unknown> | undefined,
              responseId: state.responseId,
            };
          },
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
        payload.max_tokens,
      );
    } catch (error: any) {
      if (this.shouldFallbackToNonStream(error)) {
        this.disableStreamingForSession(request.modelId, 'anthropic_stream_unsupported', trace);
        logger.warn('Anthropic stream is unsupported upstream; retrying without stream', {
          ...trace,
          error: this.summarizeError(error),
        });
        try {
          const fallbackPayload: AnthropicChatRequest = { ...payload, stream: false };
          const requestInit = this.buildRequestInit(apiKey, 'anthropic', token);
          const fallbackResponse = await this.withOptionalV1Retry(
            vendor,
            baseUrl,
            (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/messages`, fallbackPayload, requestInit, trace),
            trace,
          );
          const parsedFallback = await this.readParsedResponse<AnthropicChatResponse>(fallbackResponse);
          return this.buildAnthropicResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens,
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('Anthropic fallback request failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message,
          });
          throw providerError;
        }
      }

      if (payload.max_tokens === undefined && this.shouldRetryWithRequiredMaxTokens(error)) {
        logger.warn('Anthropic request requires explicit max_tokens; retrying with fallback output limit', {
          ...trace,
          error: this.summarizeError(error),
        });
        try {
          const fallbackPayload: AnthropicChatRequest = {
            ...payload,
            stream: false,
            max_tokens: this.resolveRequiredOutputLimit(request),
          };
          const requestInit = this.buildRequestInit(apiKey, 'anthropic', token);
          const fallbackResponse = await this.withOptionalV1Retry(
            vendor,
            baseUrl,
            (retryBaseUrl) => this.postWithRetry(`${retryBaseUrl}/messages`, fallbackPayload, requestInit, trace),
            trace,
          );
          const parsedFallback = await this.readParsedResponse<AnthropicChatResponse>(fallbackResponse);
          return this.buildAnthropicResponseFromPayload(
            request,
            vendor,
            modelName,
            trace,
            parsedFallback,
            fallbackPayload.max_tokens,
          );
        } catch (fallbackError) {
          const providerError = this.toProviderError(fallbackError);
          logger.error('Anthropic max_tokens recovery retry failed', {
            ...trace,
            error: this.summarizeError(fallbackError),
            translatedError: providerError.message,
          });
          throw providerError;
        }
      }

      const providerError = this.toProviderError(error);
      logger.error('Anthropic request failed', {
        ...trace,
        error: this.summarizeError(error),
        translatedError: providerError.message,
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
    maxTokens: number | undefined,
  ): vscode.LanguageModelChatResponse {
    const finalized = this.parseAnthropicCompletion(vendor, modelName, trace, response);
    const responseParts = this.buildResponseParts(finalized.content, finalized.toolCalls);
    const result = this.buildLoggedChatResponse(trace, finalized.content, responseParts);
    const normalizedUsage = normalizeTokenUsage(
      'anthropic',
      finalized.usage,
      maxTokens === undefined ? undefined : this.resolveOutputBuffer(request, maxTokens),
    );
    attachTokenUsage(result as unknown as Record<string, unknown>, normalizedUsage);
    this.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
    return result;
  }

  private parseAnthropicCompletion(
    vendor: VendorConfig,
    modelName: string,
    trace: RequestTraceContext,
    response: AnthropicChatResponse,
  ): StreamingCompletionResult {
    this.logUpstreamResponseSummary('anthropic', vendor, modelName, summarizeAnthropicResponseForLogging(response));
    logger.debug('Anthropic raw response shape', {
      ...trace,
      responseShape: this.summarizeRawResponseShape(response),
      responseContent: response.content,
    });
    const parsed = parseAnthropicResponse(response, () => this.generateToolCallId());
    this.ensureNonEmptyCompletion('anthropic', trace, vendor, modelName, parsed.content, parsed.toolCalls);
    logger.debug('Parsed Anthropic response', {
      ...trace,
      responseId: response.id,
      parsedContent: parsed.content,
      parsedContentLength: parsed.content.length,
      parsedToolCallCount: parsed.toolCalls.length,
      usage: response.usage,
    });
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      usage: response.usage as Record<string, unknown> | undefined,
      responseId: response.id,
    };
  }

  private async postWithRetry(
    url: string,
    payload: unknown,
    requestInit: RequestInit,
    trace?: RequestTraceContext,
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
        payloadSize: JSON.stringify(payload).length,
      });
      try {
        const response = await this.fetchResponse(url, {
          ...requestInit,
          method: 'POST',
          body: JSON.stringify(payload),
        });
        logger.info('Upstream POST attempt success', {
          ...trace,
          attempt: attempt + 1,
          url,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
        return response;
      } catch (error: any) {
        if (this.isAbortError(error)) {
          logger.warn('Upstream POST aborted', {
            ...trace,
            attempt: attempt + 1,
            url,
            durationMs: Date.now() - startedAt,
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
          error: this.summarizeError(error),
        });
        if (!shouldRetry) {
          throw error;
        }

        const delayMs = 800 * (attempt + 1);
        logger.info('Scheduling upstream POST retry', {
          ...trace,
          nextAttempt: attempt + 2,
          delayMs,
          url,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }
  }

  private logUpstreamResponseSummary(
    protocol: 'openai-chat' | 'openai-responses' | 'anthropic',
    vendor: VendorConfig,
    modelName: string,
    summary: Record<string, unknown>,
  ): void {
    logger.debug('Language model upstream response summary', {
      protocol,
      vendor: vendor.name,
      modelName,
      ...summary,
    });
  }

  private logModelTokenUsage(
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    usage: NormalizedTokenUsage | undefined,
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
      contextWindowPercentage:
        totalContextWindow && usage ? Number(((usage.totalTokens / totalContextWindow) * 100).toFixed(4)) : undefined,
    });
  }

  private resolveRequestedOutputLimit(request: GenericChatRequest): number {
    const advanced = this.configStore.getAdvancedOptions();
    const model = this.getModel(request.modelId);

    if (advanced.defaultReservedOutput > 0) {
      const desired = Math.max(1, Math.floor(advanced.defaultReservedOutput));
      if (!model) {
        return desired;
      }
      return Math.max(1, Math.min(desired, Math.floor(model.maxOutputTokens)));
    }

    if (!model) {
      return DEFAULT_REQUEST_MAX_TOKENS;
    }
    return Math.max(1, Math.floor(model.maxOutputTokens));
  }

  private resolveRequiredOutputLimit(request: GenericChatRequest): number {
    const requested = this.resolveRequestedOutputLimit(request);
    if (requested > 1) {
      return requested;
    }

    const model = this.getModel(request.modelId);
    if (!model) {
      return requested;
    }

    const contextWindow = Math.max(1, Math.floor(model.maxTokens));
    const fallback = Math.max(1, Math.min(contextWindow, 4096));
    return Math.max(requested, fallback);
  }

  private resolveOutputBuffer(
    request: GenericChatRequest,
    requestedOutputLimit: number | undefined,
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
    trace?: RequestTraceContext,
  ): Promise<T> {
    let currentBaseUrl = baseUrl;
    let retriedWithV1 = false;

    while (true) {
      try {
        logger.debug('Executing upstream request', {
          ...trace,
          baseUrl: currentBaseUrl,
          retriedWithV1,
        });
        return await execute(currentBaseUrl);
      } catch (error: any) {
        logger.warn('Upstream request failed before optional /v1 retry handling', {
          ...trace,
          baseUrl: currentBaseUrl,
          retriedWithV1,
          status: error?.response?.status,
          error: this.summarizeError(error),
        });
        if (retriedWithV1 || !this.shouldOfferV1Retry(currentBaseUrl, error)) {
          throw error;
        }

        logger.info('Attempting optional /v1 retry flow', {
          ...trace,
          baseUrl: currentBaseUrl,
        });
        const retryTarget = await this.promptToAppendV1(vendor, currentBaseUrl);
        if (!retryTarget) {
          logger.warn('Optional /v1 retry declined or unavailable', {
            ...trace,
            baseUrl: currentBaseUrl,
          });
          throw error;
        }

        currentBaseUrl = retryTarget.baseUrl;
        vendor = retryTarget.vendor;
        retriedWithV1 = true;
        logger.info('Optional /v1 retry accepted', {
          ...trace,
          nextBaseUrl: currentBaseUrl,
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
      .map((segment) => segment.trim().toLowerCase())
      .filter((segment) => segment.length > 0);

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
      action,
    );

    if (picked !== action) {
      return undefined;
    }

    await this.configStore.updateVendorBaseUrl(vendor.name, nextBaseUrl);
    return {
      baseUrl: nextBaseUrl,
      vendor: {
        ...vendor,
        baseUrl: nextBaseUrl,
      },
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

  private buildRequestInit(apiKey: string, apiStyle: VendorApiStyle, token?: vscode.CancellationToken): RequestInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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

    if (
      error.response?.status === 401 ||
      error.response?.status === 403 ||
      apiErrorType === 'authentication_error' ||
      apiErrorType === 'permission_error'
    ) {
      return new vscode.LanguageModelError(compactDetail || getMessage('apiKeyInvalid'));
    }
    if (error.response?.status === 429 || apiErrorType === 'rate_limit_error') {
      return vscode.LanguageModelError.Blocked(
        compactDetail ? `${getMessage('rateLimitExceeded')}: ${compactDetail}` : getMessage('rateLimitExceeded'),
      );
    }
    if (error.response?.status === 400 || apiErrorType === 'invalid_request_error') {
      const invalidDetail = compactDetail || getCompactErrorMessage(error.response.data?.error?.message || '');
      return new vscode.LanguageModelError(getMessage('invalidRequest', invalidDetail));
    }

    const message = compactDetail || getCompactErrorMessage(error) || getMessage('unknownError');
    return new vscode.LanguageModelError(getMessage('requestFailed', message));
  }

  private shouldRetryWithRequiredMaxTokens(error: any): boolean {
    const detail = this.readApiErrorMessage(error) || getCompactErrorMessage(error);
    const normalized = detail.trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }

    if (normalized.includes('missing field max_tokens')) {
      return true;
    }

    const mentionsMaxTokens = /max[_\s-]?tokens/.test(normalized);
    const indicatesRequired = /(required|missing|must provide|expected)/.test(normalized);
    return mentionsMaxTokens && indicatesRequired;
  }

  private readApiErrorMessage(error: any): string | undefined {
    const responseData = error?.response?.data;
    if (!responseData) {
      return undefined;
    }

    const message =
      responseData?.error?.message || responseData?.message || this.readApiDetailMessage(responseData?.detail);
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim();
    }

    if (typeof responseData === 'string' && responseData.trim().length > 0) {
      return responseData.trim();
    }

    return undefined;
  }

  private readApiDetailMessage(detail: unknown): string | undefined {
    if (typeof detail === 'string' && detail.trim().length > 0) {
      return detail.trim();
    }

    if (Array.isArray(detail)) {
      const messages = detail
        .map((entry) => this.formatApiDetailEntry(entry))
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      return messages.length > 0 ? messages.join('; ') : undefined;
    }

    if (detail && typeof detail === 'object') {
      return this.formatApiDetailEntry(detail);
    }

    return undefined;
  }

  private formatApiDetailEntry(entry: unknown): string | undefined {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      return entry.trim();
    }

    if (!entry || typeof entry !== 'object') {
      return undefined;
    }

    const source = entry as Record<string, unknown>;
    const message = this.readFirstString(source, ['message', 'msg', 'error', 'detail', 'reason']);
    const location = Array.isArray(source.loc)
      ? source.loc.filter((part) => typeof part === 'string' || typeof part === 'number').join('.')
      : undefined;
    const type = typeof source.type === 'string' && source.type.trim().length > 0 ? source.type.trim() : undefined;

    const parts = [
      location ? `${location}:` : undefined,
      message,
      type && type !== message ? `(${type})` : undefined,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

    if (parts.length > 0) {
      return parts.join(' ');
    }

    return undefined;
  }

  private readFirstString(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
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
      messages: request.messages.map((message) => ({
        role: message.role,
        name: message.name,
        partCount: message.content.length,
        parts: message.content.map((part) => this.summarizeInputPart(part)),
      })),
      toolCount: request.options?.tools?.length ?? 0,
      toolMode: request.options?.toolMode,
      capabilities: request.capabilities,
    };
  }

  private summarizeInputPart(part: vscode.LanguageModelInputPart): Record<string, unknown> {
    if (part instanceof vscode.LanguageModelTextPart) {
      return {
        type: 'text',
        length: part.value.length,
      };
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return {
        type: 'tool_call',
        callId: part.callId,
        name: part.name,
        inputKeys: part.input && typeof part.input === 'object' ? Object.keys(part.input as object) : [],
      };
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      return {
        type: 'tool_result',
        callId: part.callId,
        partCount: part.content.length,
      };
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      return {
        type: 'data',
        mimeType: part.mimeType,
        bytes: part.data.byteLength,
      };
    }

    const unknownPart = part as unknown as { constructor?: { name?: string } };
    return {
      type: unknownPart.constructor?.name ?? typeof part,
    };
  }

  private summarizeProviderMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => ({
      role: message.role,
      contentLength: message.content.length,
      reasoningContentLength: message.reasoning_content?.length ?? 0,
      toolCallCount: message.tool_calls?.length ?? 0,
      toolCalls: (message.tool_calls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        argumentsLength: typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments.length : 0,
      })),
      toolCallId: message.tool_call_id,
    }));
  }

  private summarizeOpenAIResponsesInput(input: OpenAIResponsesInputItem[]): Array<Record<string, unknown>> {
    return input.map((item) => {
      if (item.type === 'function_call') {
        return {
          type: item.type,
          callId: item.call_id,
          name: item.name,
          argumentsLength: typeof item.arguments === 'string' ? item.arguments.length : 0,
        };
      }

      if (item.type === 'function_call_output') {
        return {
          type: item.type,
          callId: item.call_id,
          outputLength: typeof item.output === 'string' ? item.output.length : 0,
        };
      }

      return {
        type: item.type ?? 'message',
        role: item.role,
        contentKind: Array.isArray(item.content) ? 'array' : typeof item.content,
        contentLength:
          typeof item.content === 'string'
            ? item.content.length
            : Array.isArray(item.content)
              ? item.content.reduce(
                  (total, part) => total + ('text' in part && typeof part.text === 'string' ? part.text.length : 0),
                  0,
                )
              : 0,
        imagePartCount: Array.isArray(item.content)
          ? item.content.filter((part) => part.type === 'input_image').length
          : 0,
      };
    });
  }

  private summarizeResponseParts(parts: vscode.LanguageModelResponsePart[]): Array<Record<string, unknown>> {
    return parts.map((part) => this.summarizeResponsePart(part));
  }

  private summarizeAnthropicStreamEvent(
    eventType: string | undefined,
    payload: AnthropicStreamEvent,
  ): Record<string, unknown> {
    const payloadRecord = payload as unknown as Record<string, unknown>;
    const payloadError =
      payloadRecord.error && typeof payloadRecord.error === 'object'
        ? (payloadRecord.error as Record<string, unknown>)
        : undefined;
    return {
      eventType,
      payloadType: payload.type,
      index: payload.index,
      hasMessage: !!payload.message,
      messageContentBlocks: Array.isArray(payload.message?.content) ? payload.message?.content.length : undefined,
      deltaType: payload.delta?.type,
      deltaTextLength: typeof payload.delta?.text === 'string' ? payload.delta.text.length : 0,
      hasPartialJson: typeof payload.delta?.partial_json === 'string' && payload.delta.partial_json.length > 0,
      contentBlockType: payload.content_block?.type,
      contentBlockName: payload.content_block?.name,
      contentBlockTextLength: typeof payload.content_block?.text === 'string' ? payload.content_block.text.length : 0,
      hasContentBlockInput: payload.content_block?.input !== undefined,
      usage: payload.usage,
      errorType: typeof payloadError?.type === 'string' ? payloadError.type : undefined,
      errorMessage:
        typeof payloadError?.message === 'string'
          ? payloadError.message
          : typeof payloadRecord.message === 'string'
            ? payloadRecord.message
            : undefined,
      requestId: typeof payloadRecord.request_id === 'string' ? payloadRecord.request_id : undefined,
    };
  }

  private isStreamingDisabledForSession(modelId: string): boolean {
    return this.disabledStreamingModelIds.has(modelId);
  }

  private isStreamingAllowed(request: GenericChatRequest): boolean {
    return this.getModel(request.modelId)?.streaming !== false && !this.isStreamingDisabledForSession(request.modelId);
  }

  private disableStreamingForSession(modelId: string, reason: string, trace?: RequestTraceContext): void {
    if (this.disabledStreamingModelIds.has(modelId)) {
      return;
    }

    this.disabledStreamingModelIds.add(modelId);
    logger.warn('Disabled streaming for current session', {
      ...trace,
      modelId,
      reason,
    });
  }

  private isAnthropicErrorStreamEvent(eventType: string | undefined, payload: AnthropicStreamEvent): boolean {
    if (eventType === 'error' || payload.type === 'error') {
      return true;
    }

    const payloadRecord = payload as unknown as Record<string, unknown>;
    return !!payloadRecord.error;
  }

  private buildAnthropicStreamError(
    payload: AnthropicStreamEvent,
  ): Error & { response?: { status?: number; data: unknown } } {
    const payloadRecord = payload as unknown as Record<string, unknown>;
    const payloadError =
      payloadRecord.error && typeof payloadRecord.error === 'object'
        ? (payloadRecord.error as Record<string, unknown>)
        : undefined;
    const message =
      (typeof payloadError?.message === 'string' && payloadError.message.trim().length > 0
        ? payloadError.message.trim()
        : undefined) ??
      (typeof payloadRecord.message === 'string' && payloadRecord.message.trim().length > 0
        ? payloadRecord.message.trim()
        : undefined) ??
      'Anthropic stream returned an error event.';
    const status = this.readAnthropicStreamErrorStatus(payloadRecord, payloadError);
    const error: Error & { response?: { status?: number; data: unknown } } = new Error(message);
    error.response = {
      ...(status === undefined ? {} : { status }),
      data: payloadRecord,
    };
    return error;
  }

  private readAnthropicStreamErrorStatus(
    payload: Record<string, unknown>,
    payloadError?: Record<string, unknown>,
  ): number | undefined {
    const directStatus =
      typeof payload.status === 'number' && Number.isFinite(payload.status) ? payload.status : undefined;
    if (directStatus !== undefined) {
      return directStatus;
    }

    const nestedStatus =
      typeof payloadError?.status === 'number' && Number.isFinite(payloadError.status)
        ? payloadError.status
        : undefined;
    if (nestedStatus !== undefined) {
      return nestedStatus;
    }

    const errorType = typeof payloadError?.type === 'string' ? payloadError.type.trim().toLowerCase() : '';
    if (errorType === 'overloaded_error') {
      return 529;
    }

    return undefined;
  }

  private summarizeResponsePart(part: vscode.LanguageModelResponsePart): Record<string, unknown> {
    if (part instanceof vscode.LanguageModelTextPart) {
      return {
        type: 'text',
        length: part.value.length,
      };
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      return {
        type: 'tool_call',
        callId: part.callId,
        name: part.name,
        inputKeys: part.input && typeof part.input === 'object' ? Object.keys(part.input as object) : [],
      };
    }

    const unknownPart = part as unknown as { constructor?: { name?: string } };
    return {
      type: unknownPart.constructor?.name ?? typeof part,
    };
  }

  private buildLoggedChatResponse(
    trace: RequestTraceContext,
    content: string,
    responseParts: vscode.LanguageModelResponsePart[],
  ): vscode.LanguageModelChatResponse {
    const provider = this;

    async function* streamText(text: string): AsyncIterable<string> {
      logger.debug('Language model response.text iterator start', {
        ...trace,
        textLength: text.length,
      });
      if (text.trim().length > 0) {
        logger.debug('Language model response.text iterator yield', {
          ...trace,
          textLength: text.length,
        });
        yield text;
      }
      logger.debug('Language model response.text iterator complete', {
        ...trace,
        yielded: text.trim().length > 0,
      });
    }

    async function* streamParts(
      parts: vscode.LanguageModelResponsePart[],
    ): AsyncIterable<vscode.LanguageModelResponsePart> {
      logger.debug('Language model response.stream iterator start', {
        ...trace,
        partCount: parts.length,
        parts: provider.summarizeResponseParts(parts),
      });
      for (const [index, part] of parts.entries()) {
        logger.debug('Language model response.stream iterator yield', {
          ...trace,
          index,
          part: provider.summarizeResponsePart(part),
        });
        yield part;
      }
      logger.debug('Language model response.stream iterator complete', {
        ...trace,
        yieldedPartCount: parts.length,
      });
    }

    const result = {
      stream: streamParts(responseParts),
      text: streamText(content),
    } as vscode.LanguageModelChatResponse & Record<string, unknown>;
    result[RESPONSE_TRACE_ID_FIELD] = trace.traceId;
    logger.info('Language model request response created', {
      ...trace,
      contentLength: content.length,
      responsePartCount: responseParts.length,
    });
    return result;
  }

  private ensureNonEmptyCompletion(
    protocol: VendorApiStyle,
    trace: RequestTraceContext,
    vendor: VendorConfig,
    modelName: string,
    content: string,
    toolCalls: ChatToolCall[] | undefined,
  ): void {
    if (content.trim().length > 0 || (toolCalls?.length ?? 0) > 0) {
      return;
    }

    logger.warn('Language model returned empty completion', {
      ...trace,
      protocol,
      vendor: vendor.name,
      modelName,
    });
    if (protocol === 'openai-chat') {
      this.promptToSwitchModelToResponsesApi(vendor, modelName, trace);
    }
    throw markEmptyModelResponseError(
      new vscode.LanguageModelError(getMessage('requestFailed', getMessage('emptyModelResponse'))),
    );
  }

  private promptToSwitchModelToResponsesApi(vendor: VendorConfig, modelName: string, trace: RequestTraceContext): void {
    const promptKey = `${vendor.name}\u0000${modelName}`;
    if (this.emptyOpenAIChatPromptedModelKeys.has(promptKey)) {
      return;
    }

    const model = this.findConfiguredModel(vendor, modelName);
    if (model?.apiStyle === 'openai-responses') {
      return;
    }

    this.emptyOpenAIChatPromptedModelKeys.add(promptKey);
    const action = getMessage('switchToResponsesApiAction');
    void Promise.resolve(
      vscode.window.showWarningMessage(getMessage('switchToResponsesApiPrompt', vendor.name, modelName), action),
    )
      .then(async (picked) => {
        if (picked !== action) {
          return;
        }

        const changed = await this.configStore.updateVendorModelApiStyle(vendor.name, modelName, 'openai-responses');
        if (!changed) {
          logger.warn('Failed to switch model to Responses API because the model config was not found', {
            ...trace,
            vendor: vendor.name,
            modelName,
          });
          return;
        }

        logger.info('Switched model to Responses API after empty OpenAI chat completion', {
          ...trace,
          vendor: vendor.name,
          modelName,
        });
        await this.refreshModels();
      })
      .catch((error: unknown) => {
        logger.warn('Failed to prompt for Responses API switch after empty OpenAI chat completion', {
          ...trace,
          vendor: vendor.name,
          modelName,
          error: this.summarizeError(error),
        });
      });
  }

  private disableOpenAIResponsesReasoningForSession(
    modelId: string,
    reason: string,
    trace?: RequestTraceContext,
  ): void {
    if (this.disabledOpenAIResponsesReasoningModelIds.has(modelId)) {
      return;
    }

    this.disabledOpenAIResponsesReasoningModelIds.add(modelId);
    logger.warn('Disabled OpenAI responses reasoning parameters for current session', {
      ...trace,
      modelId,
      reason,
    });
  }

  private buildStreamingChatResponse(
    trace: RequestTraceContext,
    protocol: VendorApiStyle,
    request: GenericChatRequest,
    vendor: VendorConfig,
    modelName: string,
    requestedOutputLimit: number | undefined,
    execute: (queue: AsyncIterableQueue<vscode.LanguageModelResponsePart>) => Promise<StreamingCompletionResult>,
  ): vscode.LanguageModelChatResponse {
    const provider = this;
    const queue = new AsyncIterableQueue<vscode.LanguageModelResponsePart>();
    const result = {} as vscode.LanguageModelChatResponse & Record<string, unknown>;
    result[RESPONSE_TRACE_ID_FIELD] = trace.traceId;

    const completion = (async () => {
      try {
        const finalized = await execute(queue);
        provider.ensureNonEmptyCompletion(protocol, trace, vendor, modelName, finalized.content, finalized.toolCalls);
        for (const part of provider.buildResponseParts('', finalized.toolCalls, finalized.reasoningContent)) {
          queue.push(part);
        }

        const normalizedUsage = normalizeTokenUsage(
          protocol,
          finalized.usage,
          requestedOutputLimit === undefined ? undefined : provider.resolveOutputBuffer(request, requestedOutputLimit),
        );
        attachTokenUsage(result, normalizedUsage);
        provider.logModelTokenUsage(request, vendor, modelName, normalizedUsage);
        logger.info('Language model streaming response completed', {
          ...trace,
          responseId: finalized.responseId,
          contentLength: finalized.content.length,
          reasoningContentLength: finalized.reasoningContent?.length ?? 0,
          toolCallCount: finalized.toolCalls.length,
          usage: normalizedUsage,
        });
        queue.close();
        return finalized;
      } catch (error) {
        provider.disableStreamingForSession(request.modelId, `${protocol}_stream_error`, trace);
        const providerError = error instanceof vscode.LanguageModelError ? error : provider.toProviderError(error);
        logger.error('Language model streaming response failed', {
          ...trace,
          error: provider.summarizeError(error),
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
      typeof error?.response?.data === 'string' ? error.response.data : undefined,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    return (
      /(stream|streaming|sse|event-stream)/i.test(detail) &&
      /(unsupported|not support|not supported|invalid|unknown|only|expect)/i.test(detail)
    );
  }

  private shouldRetryOpenAIResponsesWithoutReasoning(error: any, payload: OpenAIResponsesRequest): boolean {
    if (!payload.reasoning) {
      return false;
    }

    const status = typeof error?.response?.status === 'number' ? error.response.status : undefined;
    if (status !== 400 && status !== 422) {
      return false;
    }

    const detail = [
      this.readApiErrorMessage(error),
      typeof error?.response?.data === 'string' ? error.response.data : undefined,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    return (
      /(unsupported|unknown|unrecognized|invalid|not support|not supported)/.test(detail) &&
      /(reasoning|reasoning[_\s-]?effort|reasoning\.effort)/.test(detail)
    );
  }

  private withoutOpenAIResponsesReasoning(payload: OpenAIResponsesRequest): OpenAIResponsesRequest {
    const nextPayload: OpenAIResponsesRequest = { ...payload };
    delete nextPayload.reasoning;
    return nextPayload;
  }

  private hasMalformedAnthropicStreamToolArguments(toolCalls: ChatToolCall[]): boolean {
    return toolCalls.some((toolCall) => this.isRawToolArgumentsPayload(toolCall.function.arguments));
  }

  private isRawToolArgumentsPayload(rawArguments: string): boolean {
    const parsed = this.tryParseJson<Record<string, unknown>>(rawArguments);
    if (!parsed || Array.isArray(parsed)) {
      return false;
    }

    const keys = Object.keys(parsed);
    return keys.length === 1 && keys[0] === 'raw' && typeof parsed.raw === 'string';
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

  private summarizeVendorForLog(vendor: VendorConfig): Record<string, unknown> {
    return {
      name: vendor.name,
      baseUrl: vendor.baseUrl,
      normalizedBaseUrl: normalizeHttpBaseUrl(vendor.baseUrl),
      defaultApiStyle: vendor.defaultApiStyle,
      useModelsEndpoint: vendor.useModelsEndpoint,
      defaultVision: vendor.defaultVision,
      configuredModelCount: vendor.models.length,
      configuredModels: this.summarizeVendorModelConfigsForLog(vendor.models),
    };
  }

  private summarizeVendorModelConfigsForLog(models: readonly VendorModelConfig[]): Array<Record<string, unknown>> {
    return models.slice(0, 20).map((model) => ({
      name: model.name,
      enabled: model.enabled !== false,
      apiStyle: model.apiStyle,
      description: model.description,
      contextSize: model.contextSize,
      capabilities: model.capabilities,
      price: model.price,
    }));
  }

  private summarizeResolvedModelsForLog(models: readonly AIModelConfig[]): Array<Record<string, unknown>> {
    return models.slice(0, 20).map((model) => ({
      id: model.id,
      vendor: model.vendor,
      family: model.family,
      name: model.name,
      apiStyle: model.apiStyle,
      version: model.version,
      maxTokens: model.maxTokens,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      inputCost: model.inputCost,
      cacheCost: model.cacheCost,
      outputCost: model.outputCost,
    }));
  }

  private summarizeDiscoveryStateForLog(state: VendorDiscoveryState | undefined): Record<string, unknown> | undefined {
    if (!state) {
      return undefined;
    }
    return {
      signature: state.signature,
      suppressRetry: state.suppressRetry,
      cachedModelCount: state.cachedModels.length,
      cachedModels: this.summarizeResolvedModelsForLog(state.cachedModels),
    };
  }

  private summarizeRawDiscoveryEntryForLog(entry: unknown): Record<string, unknown> {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
    const genericEntry = raw as any;
    const runtime = genericEntry ? this.readRuntimeFromGenericModelEntry(genericEntry) : undefined;
    return {
      id: genericEntry ? this.readModelId(genericEntry) : undefined,
      keys: raw ? Object.keys(raw).slice(0, 20) : [],
      runtime,
      name: typeof raw?.name === 'string' ? raw.name : undefined,
      model: typeof raw?.model === 'string' ? raw.model : undefined,
    };
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
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !line.startsWith(':'));
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
      data: dataLines.join('\n'),
    };
  }

  private summarizeError(error: any): Record<string, unknown> {
    return {
      name: error?.name,
      message: getCompactErrorMessage(error),
      status: error?.response?.status,
      response: this.summarizeErrorResponseData(error?.response?.data),
    };
  }

  private summarizeErrorResponseData(data: unknown): unknown {
    if (typeof data === 'string') {
      return {
        type: 'string',
        length: data.length,
        preview: data.slice(0, 200),
      };
    }

    if (data && typeof data === 'object') {
      const source = data as Record<string, unknown>;
      return {
        keys: Object.keys(source),
        errorType:
          typeof source.error === 'object' && source.error ? (source.error as Record<string, unknown>).type : undefined,
        errorCode:
          typeof source.error === 'object' && source.error ? (source.error as Record<string, unknown>).code : undefined,
        message: this.readApiErrorMessage({ response: { data } }),
      };
    }

    return data;
  }

  private summarizeRawResponseShape(response: unknown): Record<string, unknown> {
    if (typeof response === 'string') {
      return {
        type: 'string',
        rawPreview: this.truncateForLog(response, 100),
      };
    }

    if (!response || typeof response !== 'object') {
      return {
        type: typeof response,
      };
    }

    const source = response as Record<string, unknown>;
    return {
      keys: Object.keys(source),
      contentType: Array.isArray(source.content) ? 'array' : typeof source.content,
      contentBlockCount: Array.isArray(source.content) ? source.content.length : undefined,
      contentPreview: this.extractContentPreview(source, 100),
      usageKeys:
        source.usage && typeof source.usage === 'object'
          ? Object.keys(source.usage as Record<string, unknown>)
          : undefined,
    };
  }

  private extractContentPreview(source: Record<string, unknown>, maxLength: number): string | undefined {
    if (typeof source.content === 'string') {
      return this.truncateForLog(source.content, maxLength);
    }

    if (Array.isArray(source.content)) {
      const text = source.content
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return '';
          }

          const block = item as Record<string, unknown>;
          return typeof block.text === 'string' ? block.text : '';
        })
        .filter((textPart) => textPart.length > 0)
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
