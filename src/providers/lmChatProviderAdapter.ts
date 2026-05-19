import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextUsageState, LastContextUsageSnapshot } from '../contextUsageState';
import { BaseAIProvider, BaseLanguageModel, getCompactErrorMessage } from './baseProvider';
import { ConfigStore } from '../config/configStore';
import { isEmptyModelResponseError } from './genericProvider';
import {
  REQUEST_SOURCE_COMMIT_MESSAGE,
  REQUEST_SOURCE_MODEL_OPTION_KEY,
  RESPONSE_TRACE_ID_FIELD,
  TEMPERATURE_MODEL_OPTION_KEY,
  THINKING_EFFORT_MODEL_OPTION_KEY
} from '../constants';
import { getMessage } from '../i18n/i18n';
import { logger } from '../logging/outputChannelLogger';
import { NormalizedTokenUsage, readAttachedTokenUsage } from './tokenUsage';

const MAX_EMPTY_MODEL_RESPONSE_RETRIES = 2;
const LM_INFO_LOG_PATH = path.join(process.cwd(), 'temp', 'lm-info-log.jsonl');
const LANGUAGE_MODELS_PICKER_LOG_PREFIX = '[coding-plans][language-models-picker]';

interface CodingPlansRequestModelOptions {
  [REQUEST_SOURCE_MODEL_OPTION_KEY]?: unknown;
}

interface ProviderPickerConfiguration {
  vendorName?: unknown;
  apiKey?: unknown;
}

interface PrepareLanguageModelChatModelOptionsWithConfiguration extends vscode.PrepareLanguageModelChatModelOptions {
  group?: unknown;
  configuration?: ProviderPickerConfiguration;
}

type LanguageModelConfigurationSchemaProperty = {
  type: 'string' | 'number';
  title: string;
  description?: string;
  enum?: Array<string | number>;
  default?: string | number;
  group?: 'navigation';
};

type LanguageModelConfigurationSchema = {
  type: 'object';
  properties: Record<string, LanguageModelConfigurationSchemaProperty>;
};

type LanguageModelChatInformationWithHiddenFields = vscode.LanguageModelChatInformation & {
  configurationSchema?: LanguageModelConfigurationSchema;
  isUserSelectable?: boolean;
};

function createModelConfigurationSchema(): LanguageModelConfigurationSchema {
  return {
    type: 'object',
    properties: {
      [THINKING_EFFORT_MODEL_OPTION_KEY]: {
        type: 'string',
        title: getMessage('thinkingEffortTitle'),
        description: getMessage('thinkingEffortDescription'),
        enum: ['none', 'high', 'max'],
        default: 'max',
        group: 'navigation'
      },
      [TEMPERATURE_MODEL_OPTION_KEY]: {
        type: 'number',
        title: getMessage('temperatureTitle'),
        description: getMessage('temperatureDescription'),
        enum: [0, 0.1, 0.4, 0.7, 1],
        default: 0.1
      }
    }
  };
}

function toLanguageModelInfo(model: BaseLanguageModel): vscode.LanguageModelChatInformation {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    tooltip: model.description,
    detail: model.version,
    version: model.version,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: { ...model.capabilities },
    configurationSchema: createModelConfigurationSchema(),
    // isUserSelectable is an internal VS Code field not yet in public typings.
    // Without it the chat model picker filters the model out (AIo() filter).
    ...({ isUserSelectable: true } as object)
  } as LanguageModelChatInformationWithHiddenFields;
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
        this.logLanguageModelInformationDiagnostic('provider-models-changed', {
          providerVendor: this.provider.getVendor(),
          availableModels: this.summarizeBaseLanguageModels(this.provider.getAvailableModels())
        });
        this.onDidChangeLanguageModelChatInformationEmitter.fire();
      })
    );
  }

  public notifyLanguageModelInformationChanged(): void {
    this.logLanguageModelInformationDiagnostic('notifyLanguageModelInformationChanged', {
      providerVendor: this.provider.getVendor(),
      availableModels: this.summarizeBaseLanguageModels(this.provider.getAvailableModels())
    });
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const pickerOptions = options as PrepareLanguageModelChatModelOptionsWithConfiguration;
    const pickerGroup = this.normalizePickerGroup(pickerOptions.group);
    const normalizedConfiguration = this.normalizePickerConfiguration(pickerOptions.configuration);
    this.logLanguageModelInformationRequest('start', options, undefined, {
      group: pickerGroup,
      configuration: this.summarizePickerConfiguration(normalizedConfiguration),
      configuredVendors: this.summarizeConfiguredVendors(),
      availableModels: this.summarizeBaseLanguageModels(this.provider.getAvailableModels())
    });

    // Hide the contributed provider root in "Manage Language Models".
    // VS Code will query explicit user-added groups with an internal `group` payload.
    if (!pickerGroup && !normalizedConfiguration) {
      this.logLanguageModelInformationRequest('skipped-unscoped-root', options, [], {
        group: pickerGroup
      });
      return [];
    }

    await this.applyPickerConfiguration(normalizedConfiguration);
    const result = await this.buildModelInformation(normalizedConfiguration?.vendorName);
    this.logLanguageModelInformationRequest('resolved', options, result, {
      group: pickerGroup,
      resultCount: result.length,
      resultPreview: this.summarizeLanguageModelInfos(result)
    });
    return result;
  }

  private async buildModelInformation(vendorName?: string): Promise<vscode.LanguageModelChatInformation[]> {
    this.logLanguageModelInformationDiagnostic('build-model-information-start', {
      providerVendor: this.provider.getVendor(),
      optionsShape: 'vscode-1.120',
      vendorName,
      configuredVendors: this.summarizeConfiguredVendors()
    });
    let models = this.provider.getAvailableModels();
    let scopedModels = this.scopeModels(models, vendorName);
    this.logLanguageModelInformationDiagnostic('build-model-information-before-refresh', {
      providerVendor: this.provider.getVendor(),
      vendorName,
      availableModels: this.summarizeBaseLanguageModels(models),
      scopedModels: this.summarizeBaseLanguageModels(scopedModels)
    });

    // Settings updates and model picker queries can race each other.
    // If we currently see nothing, refresh once and re-check before returning.
    if (scopedModels.length === 0) {
      logger.info(`${LANGUAGE_MODELS_PICKER_LOG_PREFIX} filtered model set is empty before refresh; refreshing provider models once`, {
        providerVendor: this.provider.getVendor(),
        vendorName
      });
      this.logLanguageModelInformationDiagnostic('build-model-information-trigger-refresh', {
        providerVendor: this.provider.getVendor(),
        vendorName
      });
      await this.provider.refreshModels();
      models = this.provider.getAvailableModels();
      scopedModels = this.scopeModels(models, vendorName);
      this.logLanguageModelInformationDiagnostic('build-model-information-after-refresh', {
        providerVendor: this.provider.getVendor(),
        vendorName,
        availableModels: this.summarizeBaseLanguageModels(models),
        scopedModels: this.summarizeBaseLanguageModels(scopedModels)
      });
    }

    if (scopedModels.length === 0) {
      logger.info(`${LANGUAGE_MODELS_PICKER_LOG_PREFIX} returning empty real-model list`, {
        providerVendor: this.provider.getVendor(),
        vendorName
      });
      this.logLanguageModelInformationDiagnostic('build-model-information-empty', {
        providerVendor: this.provider.getVendor(),
        vendorName
      });
      return [];
    }

    const infos = scopedModels.map(model => toLanguageModelInfo(model));
    this.logLanguageModelInformationDiagnostic('build-model-information-success', {
      providerVendor: this.provider.getVendor(),
      vendorName,
      models: this.summarizeBaseLanguageModels(scopedModels),
      infos: this.summarizeLanguageModelInfos(infos)
    });
    return infos;
  }

  private scopeModels(models: readonly BaseLanguageModel[], vendorName?: string): BaseLanguageModel[] {
    const normalizedVendorName = vendorName?.trim().toLowerCase();
    if (!normalizedVendorName) {
      return [...models];
    }

    return models.filter(model => model.family.toLowerCase() === normalizedVendorName);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const vendor = this.provider.getVendor();
    const targetModel = this.provider.getModel(model.id);
    if (!targetModel) {
      throw vscode.LanguageModelError.NotFound(`Model not found: ${model.id}`);
    }

    let traceId = this.generateTraceId('adapter');
    const requestMessageSummaries = messages.map(message => this.summarizeRequestMessage(message));
    logger.info('Adapter received language model chat request', {
      traceId,
      provider: vendor,
      modelId: model.id,
      modelName: model.name,
      messageCount: messages.length,
      toolCount: options?.tools?.length ?? 0,
      toolMode: options?.toolMode
    });
    logger.debug('Adapter request message details', {
      traceId,
      provider: vendor,
      modelId: model.id,
      messages: requestMessageSummaries
    });

    const forwardedOptions = this.toForwardedRequestOptions(options);

    try {
      for (let attempt = 0; ; attempt += 1) {
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
          hasText: !!response.text,
          attempt: attempt + 1
        });
        this.reportUsageToProgress(progress, response, traceId, vendor, model, targetModel.maxTokens, options);

        let reportedPartCount = 0;
        try {
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
        } catch (error) {
          const shouldRetry = reportedPartCount === 0
            && isEmptyModelResponseError(error)
            && attempt < MAX_EMPTY_MODEL_RESPONSE_RETRIES
            && !token.isCancellationRequested;
          logger.warn('Adapter response stream failed', {
            traceId,
            provider: vendor,
            modelId: model.id,
            attempt: attempt + 1,
            reportedPartCount,
            shouldRetry,
            error: this.summarizeError(error)
          });
          if (shouldRetry) {
            continue;
          }
          throw error;
        }

        logger.info('Adapter completed language model response stream', {
          traceId,
          provider: vendor,
          modelId: model.id,
          reportedPartCount,
          attempt: attempt + 1
        });
        this.reportUsageToProgress(progress, response, traceId, vendor, model, targetModel.maxTokens, options);
        return;
      }
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
    _model: vscode.LanguageModelChatInformation,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Thenable<number> {
    return Promise.resolve(0);
  }

  private toChatMessage(message: vscode.LanguageModelChatRequestMessage): vscode.LanguageModelChatMessage {
    return new vscode.LanguageModelChatMessage(
      message.role,
      [...message.content] as vscode.LanguageModelInputPart[],
      message.name
    );
  }

  private normalizePickerConfiguration(
    configuration?: ProviderPickerConfiguration
  ): { vendorName?: string; apiKey?: string } | undefined {
    if (!configuration || typeof configuration !== 'object') {
      return undefined;
    }

    const normalized: { vendorName?: string; apiKey?: string } = {};
    if (typeof configuration.vendorName === 'string' && configuration.vendorName.trim().length > 0) {
      normalized.vendorName = configuration.vendorName.trim();
    }
    if (typeof configuration.apiKey === 'string' && configuration.apiKey.trim().length > 0) {
      normalized.apiKey = configuration.apiKey.trim();
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private async applyPickerConfiguration(
    configuration?: { vendorName?: string; apiKey?: string }
  ): Promise<void> {
    if (!configuration?.vendorName || !configuration.apiKey || !this.configStore) {
      return;
    }

    const vendor = this.configStore.getVendor(configuration.vendorName);
    if (!vendor) {
      return;
    }

    const currentApiKey = await this.configStore.getApiKey(vendor.name);
    if (currentApiKey === configuration.apiKey) {
      return;
    }

    await this.configStore.setApiKey(vendor.name, configuration.apiKey);
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

  private logLanguageModelInformationRequest(
    stage: string,
    options: vscode.PrepareLanguageModelChatModelOptions,
    result: vscode.LanguageModelChatInformation[] | undefined,
    extra: Record<string, unknown> = {}
  ): void {
    this.logLanguageModelInformationDiagnostic(stage, {
      providerVendor: this.provider.getVendor(),
      options: this.summarizePickerOptions(options),
      result: this.summarizeLanguageModelInfos(result ?? []),
      ...extra
    });
  }

  private logLanguageModelInformationDiagnostic(stage: string, payload: Record<string, unknown>): void {
    const entry = {
      at: new Date().toISOString(),
      stage,
      ...payload
    };
    logger.debug(`${LANGUAGE_MODELS_PICKER_LOG_PREFIX} ${stage}`, entry);
    try {
      fs.mkdirSync(path.dirname(LM_INFO_LOG_PATH), { recursive: true });
      fs.appendFileSync(LM_INFO_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // ignore diagnostic logging failures
    }
  }

  private summarizePickerOptions(
    options: vscode.PrepareLanguageModelChatModelOptions
  ): Record<string, unknown> {
    const pickerOptions = options as PrepareLanguageModelChatModelOptionsWithConfiguration;
    return {
      silent: options.silent,
      group: this.normalizePickerGroup(pickerOptions.group),
      configuration: this.summarizePickerConfiguration(this.normalizePickerConfiguration(pickerOptions.configuration))
    };
  }

  private normalizePickerGroup(group: unknown): string | undefined {
    if (typeof group !== 'string') {
      return undefined;
    }

    const normalized = group.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private summarizePickerConfiguration(
    configuration?: { vendorName?: string; apiKey?: string }
  ): Record<string, unknown> | undefined {
    if (!configuration) {
      return undefined;
    }

    return {
      vendorName: configuration.vendorName,
      hasApiKey: typeof configuration.apiKey === 'string' && configuration.apiKey.length > 0
    };
  }

  private summarizeConfiguredVendors(): Array<Record<string, unknown>> {
    if (!this.configStore) {
      return [];
    }
    return this.configStore.getVendors().map(vendor => ({
      name: vendor.name,
      baseUrl: vendor.baseUrl,
      defaultApiStyle: vendor.defaultApiStyle,
      useModelsEndpoint: vendor.useModelsEndpoint,
      defaultVision: vendor.defaultVision,
      modelCount: vendor.models.length,
      modelNamesPreview: vendor.models.slice(0, 20).map(model => model.name)
    }));
  }

  private summarizeBaseLanguageModels(models: readonly BaseLanguageModel[]): Array<Record<string, unknown>> {
    return models.slice(0, 20).map(model => ({
      id: model.id,
      vendor: model.vendor,
      family: model.family,
      name: model.name,
      apiStyle: model.apiStyle,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities
    }));
  }

  private summarizeLanguageModelInfos(
    models: readonly vscode.LanguageModelChatInformation[]
  ): Array<Record<string, unknown>> {
    return models.slice(0, 20).map(model => ({
      id: model.id,
      name: model.name,
      family: model.family,
      detail: model.detail,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities
    }));
  }
}
