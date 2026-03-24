import * as vscode from 'vscode';
import { ContextUsageState, LastContextUsageSnapshot } from '../contextUsageState';
import { BaseAIProvider, BaseLanguageModel, getCompactErrorMessage } from './baseProvider';
import { ConfigStore } from '../config/configStore';
import {
  MODEL_VERSION_LABEL,
  REQUEST_SOURCE_COMMIT_MESSAGE,
  REQUEST_SOURCE_MODEL_OPTION_KEY,
  RESPONSE_TRACE_ID_FIELD
} from '../constants';
import { getMessage } from '../i18n/i18n';
import { logger } from '../logging/outputChannelLogger';
import { NormalizedTokenUsage, readAttachedTokenUsage } from './tokenUsage';

let hasShownVendorNotConfiguredWarning = false;

interface ProviderPickerConfiguration {
  name?: unknown;
  vendorName?: unknown;
  apiKey?: unknown;
}

interface PrepareLanguageModelChatModelOptionsWithConfiguration extends vscode.PrepareLanguageModelChatModelOptions {
  group?: unknown;
  configuration?: ProviderPickerConfiguration;
}

interface CodingPlansRequestModelOptions {
  [REQUEST_SOURCE_MODEL_OPTION_KEY]?: unknown;
}

function toLanguageModelInfo(model: BaseLanguageModel): vscode.LanguageModelChatInformation {
  const info: vscode.LanguageModelChatInformation = {
    id: model.id,
    name: model.name,
    family: model.family,
    tooltip: model.description,
    detail: model.version,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities
  };
  return info;
}

function getProviderDisplayName(vendor: string): string {
  switch (vendor) {
    case 'coding-plans':
      return 'Coding Plan';
    default:
      return vendor;
  }
}

function getPlaceholderModelId(vendor: string): string {
  return `${vendor}__setup_api_key__`;
}

function getNoModelsPlaceholderModelId(vendor: string): string {
  return `${vendor}__no_models__`;
}

function getUnsupportedPlaceholderModelId(vendor: string): string {
  return `${vendor}__unsupported__`;
}

function getVendorNotConfiguredPlaceholderModelId(vendor: string): string {
  return `${vendor}__vendor_not_configured__`;
}

function isPlaceholderModel(vendor: string, modelId: string): boolean {
  return modelId === getPlaceholderModelId(vendor)
    || modelId === getNoModelsPlaceholderModelId(vendor)
    || modelId === getUnsupportedPlaceholderModelId(vendor)
    || modelId === getVendorNotConfiguredPlaceholderModelId(vendor);
}

function getPlaceholderModel(vendor: string): vscode.LanguageModelChatInformation {
  const providerName = getProviderDisplayName(vendor);
  const info: vscode.LanguageModelChatInformation = {
    id: getPlaceholderModelId(vendor),
    name: getMessage('setupModelName'),
    family: 'setup',
    tooltip: getMessage('setupModelTooltip', providerName),
    detail: getMessage('setupModelDetail'),
    version: MODEL_VERSION_LABEL,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    capabilities: {
      toolCalling: false,
      imageInput: false
    }
  };
  return info;
}

function getNoModelsPlaceholderModel(vendor: string): vscode.LanguageModelChatInformation {
  const providerName = getProviderDisplayName(vendor);
  const info: vscode.LanguageModelChatInformation = {
    id: getNoModelsPlaceholderModelId(vendor),
    name: getMessage('noModelName'),
    family: 'no-models',
    tooltip: getMessage('noModelTooltip', providerName),
    detail: getMessage('noModelDetail'),
    version: MODEL_VERSION_LABEL,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    capabilities: {
      toolCalling: false,
      imageInput: false
    }
  };
  return info;
}

function getUnsupportedPlaceholderModel(vendor: string): vscode.LanguageModelChatInformation {
  const providerName = getProviderDisplayName(vendor);
  const info: vscode.LanguageModelChatInformation = {
    id: getUnsupportedPlaceholderModelId(vendor),
    name: getMessage('unsupportedModelName'),
    family: 'unsupported',
    tooltip: getMessage('unsupportedModelTooltip', providerName),
    detail: getMessage('unsupportedModelDetail'),
    version: MODEL_VERSION_LABEL,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    capabilities: {
      toolCalling: false,
      imageInput: false
    }
  };
  return info;
}

function getVendorNotConfiguredPlaceholderModel(vendor: string): vscode.LanguageModelChatInformation {
  const info: vscode.LanguageModelChatInformation = {
    id: getVendorNotConfiguredPlaceholderModelId(vendor),
    name: getMessage('vendorNotConfiguredName'),
    family: 'vendor-not-configured',
    tooltip: getMessage('vendorNotConfiguredTooltip'),
    detail: getMessage('vendorNotConfiguredDetail'),
    version: MODEL_VERSION_LABEL,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    capabilities: {
      toolCalling: false,
      imageInput: false
    }
  };
  return info;
}

export class LMChatProviderAdapter implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly provider: BaseAIProvider,
    private readonly configStore?: ConfigStore,
    private readonly contextUsageState?: ContextUsageState
  ) {
    this.disposables.push(
      this.provider.onDidChangeModels(() => {
        this.onDidChangeLanguageModelChatInformationEmitter.fire();
      })
    );
  }

  public notifyLanguageModelInformationChanged(): void {
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const pickerOptions = options as PrepareLanguageModelChatModelOptionsWithConfiguration;
    const hasGroup = typeof pickerOptions.group === 'string' && pickerOptions.group.trim().length > 0;
    const hasConfigurationPayload = this.hasConfigurationPayload(pickerOptions.configuration);

    // Only return model information for explicitly added provider groups.
    // Base vendor calls are ignored to avoid all providers being listed by default.
    if (!hasGroup && !hasConfigurationPayload) {
      return [];
    }

    if (hasGroup || hasConfigurationPayload) {
      await this.applyPickerConfiguration(pickerOptions);
    }

    return this.buildModelInformation(pickerOptions.configuration);
  }

  private async buildModelInformation(
    configuration?: ProviderPickerConfiguration
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const requestedVendor = this.resolveRequestedVendorName(configuration);
    const resolvedVendor = this.resolveConfiguredVendorName(requestedVendor);
    if (requestedVendor && !resolvedVendor && this.configStore) {
      return [getVendorNotConfiguredPlaceholderModel(this.provider.getVendor())];
    }
    const vendorForFiltering = resolvedVendor || requestedVendor;
    let models = this.provider.getAvailableModels();
    let filteredModels = vendorForFiltering
      ? models.filter(model => model.family.toLowerCase() === vendorForFiltering.toLowerCase())
      : models;

    // Settings updates and model picker queries can race each other.
    // If we currently see nothing, refresh once and re-check before returning placeholders.
    if (filteredModels.length === 0) {
      await this.provider.refreshModels();
      models = this.provider.getAvailableModels();
      filteredModels = vendorForFiltering
        ? models.filter(model => model.family.toLowerCase() === vendorForFiltering.toLowerCase())
        : models;
    }

    if (filteredModels.length === 0) {
      if (vendorForFiltering && this.configStore) {
        const apiKey = (await this.configStore.getApiKey(vendorForFiltering)).trim();
        if (apiKey.length === 0) {
          return [getPlaceholderModel(this.provider.getVendor())];
        }
      } else {
        const apiKey = this.provider.getApiKey().trim();
        if (apiKey.length === 0) {
          return [getPlaceholderModel(this.provider.getVendor())];
        }
      }

      if (this.provider.isModelDiscoveryUnsupported()) {
        return [getUnsupportedPlaceholderModel(this.provider.getVendor())];
      }

      return [getNoModelsPlaceholderModel(this.provider.getVendor())];
    }

    return filteredModels.map(model => toLanguageModelInfo(model));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const vendor = this.provider.getVendor();
    if (isPlaceholderModel(vendor, model.id)) {
      const providerName = getProviderDisplayName(vendor);
      if (model.id === getUnsupportedPlaceholderModelId(vendor)) {
        progress.report(new vscode.LanguageModelTextPart(getMessage('unsupportedModelResponse', providerName)));
        return;
      }
      if (model.id === getNoModelsPlaceholderModelId(vendor)) {
        progress.report(new vscode.LanguageModelTextPart(getMessage('noModelResponse', providerName)));
        return;
      }
      if (model.id === getVendorNotConfiguredPlaceholderModelId(vendor)) {
        progress.report(new vscode.LanguageModelTextPart(getMessage('vendorNotConfiguredResponse')));
        return;
      }
      progress.report(new vscode.LanguageModelTextPart(getMessage('setupModelResponse', providerName)));
      return;
    }

    const targetModel = this.provider.getModel(model.id);
    if (!targetModel) {
      throw vscode.LanguageModelError.NotFound(`Model not found: ${model.id}`);
    }

    let traceId = this.generateTraceId('adapter');
    logger.info('Adapter received language model chat request', {
      traceId,
      provider: vendor,
      modelId: model.id,
      modelName: model.name,
      messageCount: messages.length,
      messages: messages.map(message => this.summarizeRequestMessage(message)),
      toolCount: options?.tools?.length ?? 0,
      toolMode: options?.toolMode
    });

    try {
      const forwardedOptions = this.toForwardedRequestOptions(options);
      const response = await targetModel.sendRequest(
        messages.map(message => this.toChatMessage(message)),
        forwardedOptions,
        token
      );
      const responseTraceId = (response as unknown as Record<string, unknown>)[RESPONSE_TRACE_ID_FIELD];
      if (typeof responseTraceId === 'string' && responseTraceId.trim().length > 0) {
        traceId = responseTraceId;
      }
      logger.info('Adapter received language model response object', {
        traceId,
        provider: vendor,
        modelId: model.id,
        hasStream: !!response.stream,
        hasText: !!response.text
      });
      this.reportUsageToProgress(progress, response, traceId, vendor, model, targetModel.maxTokens, options);

      let reportedPartCount = 0;
      for await (const part of response.stream as AsyncIterable<vscode.LanguageModelResponsePart>) {
        logger.debug('Adapter reporting response part to VS Code', {
          traceId,
          provider: vendor,
          modelId: model.id,
          index: reportedPartCount,
          part: this.summarizeResponsePart(part)
        });
        progress.report(part as vscode.LanguageModelResponsePart);
        reportedPartCount += 1;
      }
      logger.info('Adapter completed language model response stream', {
        traceId,
        provider: vendor,
        modelId: model.id,
        reportedPartCount
      });
      this.reportUsageToProgress(progress, response, traceId, vendor, model, targetModel.maxTokens, options);
    } catch (error) {
      logger.error('Adapter failed to provide language model chat response', {
        traceId,
        provider: vendor,
        modelId: model.id,
        error: this.summarizeError(error)
      });
      throw this.toCompactLanguageModelError(error);
    }
  }

  provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    if (isPlaceholderModel(this.provider.getVendor(), model.id)) {
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  private hasConfigurationPayload(configuration: ProviderPickerConfiguration | undefined): boolean {
    if (!configuration || typeof configuration !== 'object') {
      return false;
    }
    return Object.keys(configuration).length > 0;
  }

  private toChatMessage(message: vscode.LanguageModelChatRequestMessage): vscode.LanguageModelChatMessage {
    return new vscode.LanguageModelChatMessage(
      message.role,
      [...message.content] as vscode.LanguageModelInputPart[],
      message.name
    );
  }

  private async applyPickerConfiguration(options: PrepareLanguageModelChatModelOptionsWithConfiguration): Promise<void> {
    const rawConfig = options.configuration;
    if (!rawConfig || typeof rawConfig !== 'object') {
      return;
    }

    const normalized = this.normalizePickerConfiguration(rawConfig);
    if (!normalized) {
      return;
    }

    let changed = false;

    const vendorName = normalized.vendorName;
    if (vendorName && this.configStore) {
      const resolvedVendor = this.resolveConfiguredVendorName(vendorName);
      if (!resolvedVendor) {
        await this.warnVendorNotConfigured(vendorName);
        return;
      }
      if (normalized.apiKey !== undefined) {
        const nextApiKey = normalized.apiKey.trim();
        const currentApiKey = await this.configStore.getApiKey(resolvedVendor);
        if (currentApiKey !== nextApiKey) {
          await this.configStore.setApiKey(resolvedVendor, nextApiKey);
          changed = true;
        }
      }
    } else if (normalized.apiKey !== undefined) {
      const nextApiKey = normalized.apiKey.trim();
      if (this.provider.getApiKey() !== nextApiKey) {
        await this.provider.setApiKey(nextApiKey);
        changed = true;
      }
    }

    if (changed) {
      await this.provider.refreshModels();
    }
  }

  private normalizePickerConfiguration(raw: ProviderPickerConfiguration): {
    vendorName?: string;
    apiKey?: string;
  } | undefined {
    const normalized: {
      vendorName?: string;
      apiKey?: string;
    } = {};

    if (typeof raw.vendorName === 'string') {
      normalized.vendorName = raw.vendorName.trim();
    }
    if (typeof raw.apiKey === 'string') {
      normalized.apiKey = raw.apiKey.trim();
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private resolveRequestedVendorName(configuration?: ProviderPickerConfiguration): string {
    if (configuration && typeof configuration.vendorName === 'string') {
      const fromConfig = configuration.vendorName.trim();
      if (fromConfig.length > 0) {
        return fromConfig;
      }
    }

    return '';
  }

  private resolveConfiguredVendorName(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || !this.configStore) {
      return undefined;
    }

    const vendors = this.configStore.getVendors();
    const match = vendors.find(v => v.name.toLowerCase() === trimmed.toLowerCase());
    return match?.name;
  }

  private async warnVendorNotConfigured(vendorName: string): Promise<void> {
    if (hasShownVendorNotConfiguredWarning) {
      return;
    }
    hasShownVendorNotConfiguredWarning = true;

    const message = getMessage('vendorNotConfiguredMatch', vendorName.trim());
    const action = getMessage('manageActionOpenSettings');
    void vscode.window.showWarningMessage(message, action).then(picked => {
      if (picked) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'coding-plans.vendors');
      }
    });
  }

  private toCompactLanguageModelError(error: unknown): vscode.LanguageModelError {
    const compactMessage = getCompactErrorMessage(error) || getMessage('unknownError');
    const code = error instanceof vscode.LanguageModelError ? error.code : undefined;
    const inferredBlocked = /(?:rate\s*limit|quota|429|速率限制|配额|当前订阅套餐暂未开放)/i.test(compactMessage);

    let wrapped: vscode.LanguageModelError;
    if (code === vscode.LanguageModelError.Blocked.name || inferredBlocked) {
      wrapped = vscode.LanguageModelError.Blocked(compactMessage);
    } else if (code === vscode.LanguageModelError.NoPermissions.name) {
      wrapped = vscode.LanguageModelError.NoPermissions(compactMessage);
    } else if (code === vscode.LanguageModelError.NotFound.name) {
      wrapped = vscode.LanguageModelError.NotFound(compactMessage);
    } else {
      wrapped = new vscode.LanguageModelError(compactMessage);
    }

    return this.compactLanguageModelError(wrapped, compactMessage);
  }

  private compactLanguageModelError(error: vscode.LanguageModelError, compactMessage: string): vscode.LanguageModelError {
    const sanitizedMessage = compactMessage || getMessage('unknownError');
    this.overwriteErrorMessage(error, sanitizedMessage);
    this.overwriteErrorStack(error, `${error.name}: ${sanitizedMessage}`);
    this.clearErrorCause(error);
    return error;
  }

  private overwriteErrorMessage(error: Error, message: string): void {
    try {
      Object.defineProperty(error, 'message', {
        value: message,
        configurable: true,
        writable: true
      });
    } catch {
      // ignore: keep original message when runtime prevents overriding.
    }
  }

  private overwriteErrorStack(error: Error, stack: string): void {
    try {
      Object.defineProperty(error, 'stack', {
        value: stack,
        configurable: true,
        writable: true
      });
    } catch {
      // ignore: keep original stack when runtime prevents overriding.
    }
  }

  private clearErrorCause(error: Error): void {
    try {
      Object.defineProperty(error, 'cause', {
        value: undefined,
        configurable: true,
        writable: true
      });
    } catch {
      // ignore: some runtimes define cause as non-configurable.
    }
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.disposables.length = 0;
    this.onDidChangeLanguageModelChatInformationEmitter.dispose();
  }

  private generateTraceId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  }

  private summarizeRequestMessage(message: vscode.LanguageModelChatRequestMessage): Record<string, unknown> {
    return {
      role: message.role,
      name: message.name,
      partCount: message.content.length,
      parts: [...message.content].map(part => this.summarizeInputPart(part as vscode.LanguageModelInputPart))
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

  private summarizeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: getCompactErrorMessage(error)
      };
    }

    return {
      type: typeof error,
      message: getCompactErrorMessage(error)
    };
  }

  private reportUsageToProgress(
    _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    response: vscode.LanguageModelChatResponse,
    traceId: string,
    vendor: string,
    model: vscode.LanguageModelChatInformation,
    totalContextWindow: number,
    options?: vscode.ProvideLanguageModelChatResponseOptions
  ): void {
    if (!this.shouldTrackContextUsage(options)) {
      logger.debug('Adapter skipped CodingPlans Context usage update for excluded request', {
        traceId,
        provider: vendor,
        modelId: model.id
      });
      return;
    }

    const usage = readAttachedTokenUsage(response);
    if (!usage) {
      return;
    }

    this.updateContextUsageState(traceId, vendor, model, usage, totalContextWindow);
  }

  private updateContextUsageState(
    traceId: string,
    vendor: string,
    model: vscode.LanguageModelChatInformation,
    usage: NormalizedTokenUsage,
    totalContextWindow: number
  ): void {
    if (!this.contextUsageState) {
      return;
    }

    const snapshot: LastContextUsageSnapshot = {
      provider: vendor,
      modelId: model.id,
      modelName: model.name,
      totalContextWindow,
      traceId,
      recordedAt: Date.now(),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      outputBuffer: usage.outputBuffer
    };
    this.contextUsageState.update(snapshot);
    logger.info('Adapter cached last completed request usage for CodingPlans Context status bar', {
      traceId,
      provider: vendor,
      modelId: model.id,
      snapshot: this.summarizeSnapshot(snapshot)
    });
  }

  private summarizeSnapshot(snapshot: LastContextUsageSnapshot): Record<string, unknown> {
    return {
      provider: snapshot.provider,
      modelId: snapshot.modelId,
      modelName: snapshot.modelName,
      totalContextWindow: snapshot.totalContextWindow,
      promptTokens: snapshot.promptTokens,
      completionTokens: snapshot.completionTokens,
      totalTokens: snapshot.totalTokens,
      outputBuffer: snapshot.outputBuffer,
      recordedAt: new Date(snapshot.recordedAt).toISOString(),
      traceId: snapshot.traceId
    };
  }

  private shouldTrackContextUsage(options?: vscode.ProvideLanguageModelChatResponseOptions): boolean {
    return this.readRequestSource(options) !== REQUEST_SOURCE_COMMIT_MESSAGE;
  }

  private readRequestSource(options?: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
    const modelOptions = options?.modelOptions as CodingPlansRequestModelOptions | undefined;
    const source = modelOptions?.[REQUEST_SOURCE_MODEL_OPTION_KEY];
    return typeof source === 'string' && source.trim().length > 0 ? source.trim() : undefined;
  }

  private toForwardedRequestOptions(
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): vscode.LanguageModelChatRequestOptions {
    const modelOptions = options?.modelOptions;
    if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
      return options as unknown as vscode.LanguageModelChatRequestOptions;
    }

    const forwardedModelOptions = { ...modelOptions } as Record<string, unknown>;
    delete forwardedModelOptions[REQUEST_SOURCE_MODEL_OPTION_KEY];

    if (Object.keys(forwardedModelOptions).length === Object.keys(modelOptions).length) {
      return options as unknown as vscode.LanguageModelChatRequestOptions;
    }

    return {
      ...options,
      modelOptions: Object.keys(forwardedModelOptions).length > 0 ? forwardedModelOptions : undefined
    } as unknown as vscode.LanguageModelChatRequestOptions;
  }
}
