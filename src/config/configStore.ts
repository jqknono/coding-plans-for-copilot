import * as vscode from 'vscode';
import {
  ADVANCED_OPTIONS_SETTING_KEY,
  DEFAULT_ADVANCED_RESERVED_OUTPUT,
  DEFAULT_MODEL_CAPABILITIES_TOOLS,
  DEFAULT_MODEL_CAPABILITIES_VISION,
  VENDOR_API_KEY_PREFIX,
} from '../constants';

export type VendorApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic';
export type VendorApiType = 'chat' | 'responses' | 'anthropic';
export type ReasoningEffortValue = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReasoningEffortFormat = 'chat-completions' | 'responses';

export interface VendorModelConfig {
  name: string;
  enabled?: boolean;
  description?: string;
  apiStyle?: VendorApiStyle;
  apiType?: VendorApiType;
  temperature?: number;
  topP?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
  };
  toolCalling?: boolean | number;
  vision?: boolean;
  /**
   * Total context window size in tokens.
   */
  contextSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  thinking?: boolean;
  editTools?: string[];
  supportsReasoningEffort?: ReasoningEffortValue[];
  reasoningEffortFormat?: ReasoningEffortFormat;
  zeroDataRetentionEnabled?: boolean;
}

export interface VendorConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  usageUrl?: string;
  apiType?: VendorApiType;
  defaultApiStyle: VendorApiStyle;
  defaultTemperature?: number;
  defaultTopP?: number;
  useModelsEndpoint: boolean;
  defaultVision: boolean;
  models: VendorModelConfig[];
}

export interface AdvancedOptions {
  defaultReservedOutput: number;
}

export interface VendorValidationError {
  vendorIndex: number;
  vendorName: string;
  field: string;
  reason: string;
}
export class ConfigStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('coding-plans.vendors')) {
          this.onDidChangeEmitter.fire();
        }
      }),
    );
  }

  getAdvancedOptions(): AdvancedOptions {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<Record<string, unknown> | undefined>(ADVANCED_OPTIONS_SETTING_KEY, undefined);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { defaultReservedOutput: DEFAULT_ADVANCED_RESERVED_OUTPUT };
    }
    return {
      defaultReservedOutput: this.readNonNegativeInteger(raw.defaultReservedOutput) ?? DEFAULT_ADVANCED_RESERVED_OUTPUT,
    };
  }

  getVendors(): VendorConfig[] {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<unknown[]>('vendors', []);
    return this.normalizeVendors(raw);
  }

  getVendor(name: string): VendorConfig | undefined {
    return this.getVendors().find((v) => v.name === name);
  }

  async getApiKey(vendorName: string): Promise<string> {
    const configuredApiKey = this.getVendor(vendorName)?.apiKey?.trim() || '';
    if (configuredApiKey.length > 0) {
      return configuredApiKey;
    }
    const key = await this.context.secrets.get(VENDOR_API_KEY_PREFIX + vendorName);
    return (key || '').trim();
  }

  async setApiKey(vendorName: string, apiKey: string): Promise<void> {
    const secretKey = VENDOR_API_KEY_PREFIX + vendorName;
    const normalized = apiKey.trim();
    const current = ((await this.context.secrets.get(secretKey)) || '').trim();
    if (current === normalized) {
      return;
    }
    if (normalized.length > 0) {
      await this.context.secrets.store(secretKey, normalized);
    } else {
      await this.context.secrets.delete(secretKey);
    }
    this.onDidChangeEmitter.fire();
  }

  async updateVendorModels(vendorName: string, models: VendorModelConfig[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const rawVendors = config.get<unknown[]>('vendors', []);
    if (!Array.isArray(rawVendors)) {
      return;
    }

    const normalizedVendorName = vendorName.trim();
    if (normalizedVendorName.length === 0) {
      return;
    }

    // Model names discovered from `/models` are the source of truth for membership.
    const inputNames = models
      .map((model) => (typeof model?.name === 'string' ? model.name.trim() : ''))
      .filter((name) => name.length > 0);
    let changed = false;

    const updatedVendors = rawVendors.map((rawVendor) => {
      if (!rawVendor || typeof rawVendor !== 'object') {
        return rawVendor;
      }

      const vendorObj = rawVendor as Record<string, unknown>;
      const name = typeof vendorObj.name === 'string' ? vendorObj.name.trim() : '';
      if (name !== normalizedVendorName) {
        return rawVendor;
      }

      // Build a stable canonical casing from the currently stored config.
      // If the discovered list only differs by name casing, keep the existing casing to avoid flapping.
      const existingNameByKey = new Map<string, string>();
      const currentNames: string[] = [];
      if (Array.isArray(vendorObj.models)) {
        for (const rawModel of vendorObj.models) {
          const rawName = this.readModelName(rawModel);
          if (!rawName) {
            continue;
          }
          const key = rawName.toLowerCase();
          if (existingNameByKey.has(key)) {
            continue;
          }
          existingNameByKey.set(key, rawName);
          currentNames.push(rawName);
        }
      }

      const defaultVision = typeof vendorObj.defaultVision === 'boolean' ? vendorObj.defaultVision : false;
      const defaultApiStyle = this.normalizeApiStyle(vendorObj.defaultApiStyle ?? vendorObj.apiType);
      const nextModels = this.buildUpdatedModelEntries(
        inputNames,
        models,
        Array.isArray(vendorObj.models) ? vendorObj.models : [],
        existingNameByKey,
        defaultVision,
        defaultApiStyle,
      );
      const normalizedCurrentModels = this.sortModels(
        currentNames.map((currentName) => ({ name: existingNameByKey.get(currentName.toLowerCase()) ?? currentName })),
      );

      // Only compare names.
      const currentSignature = JSON.stringify(normalizedCurrentModels.map((m) => m.name));
      const nextSignature = JSON.stringify(nextModels.map((model) => model.name));
      if (currentSignature === nextSignature) {
        return rawVendor;
      }

      changed = true;
      return {
        ...vendorObj,
        models: nextModels,
      };
    });

    if (!changed) {
      return;
    }

    await config.update('vendors', updatedVendors, this.resolveVendorsConfigTarget());
  }

  async updateVendorBaseUrl(vendorName: string, baseUrl: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const rawVendors = config.get<unknown[]>('vendors', []);
    if (!Array.isArray(rawVendors)) {
      return;
    }

    const normalizedVendorName = vendorName.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (normalizedVendorName.length === 0 || normalizedBaseUrl.length === 0) {
      return;
    }

    let changed = false;
    const updatedVendors = rawVendors.map((rawVendor) => {
      if (!rawVendor || typeof rawVendor !== 'object') {
        return rawVendor;
      }

      const vendorObj = rawVendor as Record<string, unknown>;
      const name = typeof vendorObj.name === 'string' ? vendorObj.name.trim() : '';
      if (name !== normalizedVendorName) {
        return rawVendor;
      }

      const currentBaseUrl = typeof vendorObj.baseUrl === 'string' ? vendorObj.baseUrl.trim() : '';
      if (currentBaseUrl === normalizedBaseUrl) {
        return rawVendor;
      }

      changed = true;
      return {
        ...vendorObj,
        baseUrl: normalizedBaseUrl,
      };
    });

    if (!changed) {
      return;
    }

    await config.update('vendors', updatedVendors, this.resolveVendorsConfigTarget());
  }

  async updateVendorModelApiStyle(vendorName: string, modelName: string, apiStyle: VendorApiStyle): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const rawVendors = config.get<unknown[]>('vendors', []);
    if (!Array.isArray(rawVendors)) {
      return false;
    }

    const normalizedVendorName = vendorName.trim();
    const normalizedModelName = modelName.trim().toLowerCase();
    const normalizedApiStyle = this.normalizeApiStyle(apiStyle);
    if (normalizedVendorName.length === 0 || normalizedModelName.length === 0) {
      return false;
    }

    let changed = false;
    const updatedVendors = rawVendors.map((rawVendor) => {
      if (!rawVendor || typeof rawVendor !== 'object') {
        return rawVendor;
      }

      const vendorObj = rawVendor as Record<string, unknown>;
      const name = typeof vendorObj.name === 'string' ? vendorObj.name.trim() : '';
      if (name !== normalizedVendorName || !Array.isArray(vendorObj.models)) {
        return rawVendor;
      }

      let vendorChanged = false;
      const nextModels = vendorObj.models.map((rawModel) => {
        if (!rawModel || typeof rawModel !== 'object') {
          return rawModel;
        }

        const modelObj = rawModel as Record<string, unknown>;
        const currentModelName = typeof modelObj.name === 'string' ? modelObj.name.trim().toLowerCase() : '';
        if (currentModelName !== normalizedModelName) {
          return rawModel;
        }

        if (modelObj.apiStyle === normalizedApiStyle) {
          return rawModel;
        }

        vendorChanged = true;
        return {
          ...modelObj,
          apiStyle: normalizedApiStyle,
        };
      });

      if (!vendorChanged) {
        return rawVendor;
      }

      changed = true;
      return {
        ...vendorObj,
        models: nextModels,
      };
    });

    if (!changed) {
      return false;
    }

    await config.update('vendors', updatedVendors, this.resolveVendorsConfigTarget());
    return true;
  }

  private readModelName(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    return name.length > 0 ? name : undefined;
  }

  private cloneModelWithNormalizedName(
    raw: unknown,
    name: string,
    defaultVision: boolean,
    defaultApiStyle: VendorApiStyle,
  ): VendorModelConfig {
    if (!raw || typeof raw !== 'object') {
      return this.buildStoredModelEntry({ name }, name, defaultVision, defaultApiStyle);
    }
    return this.buildStoredModelEntry(raw, name, defaultVision, defaultApiStyle);
  }

  private buildStoredModelEntry(
    raw: unknown,
    name: string,
    defaultVision: boolean,
    defaultApiStyle: VendorApiStyle,
  ): VendorModelConfig {
    const rawObject = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const normalized = this.normalizeModel(raw, defaultVision, defaultApiStyle);
    if (!normalized) {
      const stored: VendorModelConfig = {
        name,
        enabled:
          rawObject && Object.prototype.hasOwnProperty.call(rawObject, 'enabled') ? rawObject.enabled !== false : true,
        capabilities: {
          tools: DEFAULT_MODEL_CAPABILITIES_TOOLS,
          vision: defaultVision,
        },
      };
      if (rawObject && Object.prototype.hasOwnProperty.call(rawObject, 'apiStyle')) {
        stored.apiStyle = this.normalizeApiStyle(rawObject.apiStyle, defaultApiStyle);
      }
      if (rawObject && Object.prototype.hasOwnProperty.call(rawObject, 'apiType')) {
        stored.apiType = this.normalizeApiType(rawObject.apiType);
        stored.apiStyle = this.normalizeApiStyle(rawObject.apiType, defaultApiStyle);
      }
      return stored;
    }

    const stored: VendorModelConfig = {
      name,
      enabled: normalized.enabled,
      description: normalized.description,
      apiType: normalized.apiType,
      temperature: normalized.temperature,
      topP: normalized.topP,
      contextSize: normalized.contextSize,
      maxInputTokens: normalized.maxInputTokens,
      maxOutputTokens: normalized.maxOutputTokens,
      capabilities: normalized.capabilities,
    };

    if (
      rawObject &&
      (Object.prototype.hasOwnProperty.call(rawObject, 'apiStyle') ||
        Object.prototype.hasOwnProperty.call(rawObject, 'apiType'))
    ) {
      stored.apiStyle = normalized.apiStyle;
    }
    if (normalized.streaming !== undefined) {
      stored.streaming = normalized.streaming;
    }
    if (normalized.thinking !== undefined) {
      stored.thinking = normalized.thinking;
    }
    if (normalized.editTools !== undefined) {
      stored.editTools = normalized.editTools;
    }
    if (normalized.supportsReasoningEffort !== undefined) {
      stored.supportsReasoningEffort = normalized.supportsReasoningEffort;
    }
    if (normalized.reasoningEffortFormat !== undefined) {
      stored.reasoningEffortFormat = normalized.reasoningEffortFormat;
    }
    if (normalized.zeroDataRetentionEnabled !== undefined) {
      stored.zeroDataRetentionEnabled = normalized.zeroDataRetentionEnabled;
    }
    return stored;
  }

  private buildUpdatedModelEntries(
    names: string[],
    inputModels: VendorModelConfig[],
    rawModels: unknown[],
    existingNameByKey: Map<string, string>,
    defaultVision: boolean,
    defaultApiStyle: VendorApiStyle,
  ): VendorModelConfig[] {
    const existingModelByKey = new Map<string, VendorModelConfig>();
    for (const rawModel of rawModels) {
      const rawName = this.readModelName(rawModel);
      if (!rawName) {
        continue;
      }

      const key = rawName.toLowerCase();
      if (existingModelByKey.has(key)) {
        continue;
      }
      existingModelByKey.set(key, rawModel as VendorModelConfig);
    }

    const inputModelByKey = new Map<string, VendorModelConfig>();
    for (const inputModel of inputModels) {
      const name = typeof inputModel?.name === 'string' ? inputModel.name.trim() : '';
      if (name.length === 0) {
        continue;
      }

      const key = name.toLowerCase();
      if (inputModelByKey.has(key)) {
        continue;
      }

      inputModelByKey.set(key, inputModel);
    }

    const seen = new Set<string>();
    const normalized: VendorModelConfig[] = [];

    for (const rawName of names) {
      const name = rawName.trim();
      if (name.length === 0) {
        continue;
      }

      const key = name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const existingModel = existingModelByKey.get(key);
      if (existingModel) {
        const canonical = existingNameByKey.get(key) ?? name;
        normalized.push(this.cloneModelWithNormalizedName(existingModel, canonical, defaultVision, defaultApiStyle));
        continue;
      }

      const canonical = existingNameByKey.get(key) ?? name;
      const inputModel = inputModelByKey.get(key);
      if (inputModel) {
        normalized.push(
          this.buildStoredModelEntry(
            {
              ...inputModel,
              temperature: undefined,
              topP: undefined,
              capabilities: {
                ...inputModel.capabilities,
                vision: defaultVision,
              },
            },
            canonical,
            defaultVision,
            defaultApiStyle,
          ),
        );
        continue;
      }

      normalized.push(this.buildStoredModelEntry({ name: canonical }, canonical, defaultVision, defaultApiStyle));
    }

    return this.sortRawModelsByName(normalized);
  }

  private sortRawModelsByName(models: VendorModelConfig[]): VendorModelConfig[] {
    return [...models].sort((left, right) => {
      const leftName = left.name.trim();
      const rightName = right.name.trim();
      const leftKey = leftName.toLowerCase();
      const rightKey = rightName.toLowerCase();
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      if (leftName < rightName) {
        return -1;
      }
      if (leftName > rightName) {
        return 1;
      }
      return 0;
    });
  }

  private normalizeVendors(raw: unknown): VendorConfig[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((v) => this.normalizeVendor(v)).filter((v): v is VendorConfig => v !== undefined);
  }

  private normalizeVendor(raw: unknown): VendorConfig | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      return undefined;
    }
    const baseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : '';
    const apiKey = typeof obj.apiKey === 'string' && obj.apiKey.trim().length > 0 ? obj.apiKey.trim() : undefined;
    const usageUrl =
      typeof obj.usageUrl === 'string' && obj.usageUrl.trim().length > 0 ? obj.usageUrl.trim() : undefined;
    const apiType = this.normalizeApiType(obj.apiType);
    const defaultApiStyle = this.normalizeApiStyle(obj.defaultApiStyle ?? obj.apiType);
    const defaultTemperature = this.readSamplingNumber(obj.defaultTemperature, 0, 2);
    const defaultTopP = this.readSamplingNumber(obj.defaultTopP, 0, 1);
    const useModelsEndpoint = typeof obj.useModelsEndpoint === 'boolean' ? obj.useModelsEndpoint : true;
    const defaultVision = typeof obj.defaultVision === 'boolean' ? obj.defaultVision : false;
    const models = Array.isArray(obj.models)
      ? obj.models
          .map((m) => this.normalizeModel(m, defaultVision, defaultApiStyle))
          .filter((m): m is VendorModelConfig => m !== undefined)
      : [];
    return {
      name,
      baseUrl,
      apiKey,
      usageUrl,
      apiType,
      defaultApiStyle,
      defaultTemperature,
      defaultTopP,
      useModelsEndpoint,
      defaultVision,
      models,
    };
  }

  private normalizeModel(
    raw: unknown,
    defaultVision = DEFAULT_MODEL_CAPABILITIES_VISION,
    defaultApiStyle: VendorApiStyle = 'openai-chat',
  ): VendorModelConfig | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      return undefined;
    }
    const description =
      typeof obj.description === 'string' && obj.description.trim().length > 0 ? obj.description.trim() : undefined;
    const contextSize = this.readPositiveNumber(obj.contextSize);
    const maxInputTokens = this.readPositiveNumber(obj.maxInputTokens);
    const maxOutputTokens = this.readPositiveNumber(obj.maxOutputTokens);
    const apiType = this.normalizeApiType(obj.apiType);
    const apiStyle = this.normalizeApiStyle(obj.apiStyle ?? obj.apiType, defaultApiStyle);
    const temperature = this.readSamplingNumber(obj.temperature, 0, 2);
    const topP = this.readSamplingNumber(obj.topP, 0, 1);
    const enabled = obj.enabled !== false;
    const toolCalling = this.readToolCallingValue(obj.toolCalling);
    const vision = this.readBooleanValue(obj.vision);
    const streaming = this.readBooleanValue(obj.streaming);
    const thinking = this.readBooleanValue(obj.thinking);
    const editTools = this.readStringArray(obj.editTools);
    const supportsReasoningEffort = this.readReasoningEffortArray(obj.supportsReasoningEffort);
    const reasoningEffortFormat = this.normalizeReasoningEffortFormat(obj.reasoningEffortFormat);
    const zeroDataRetentionEnabled = this.readBooleanValue(obj.zeroDataRetentionEnabled);
    let capabilities: VendorModelConfig['capabilities'];
    if (obj.capabilities && typeof obj.capabilities === 'object') {
      const cap = obj.capabilities as Record<string, unknown>;
      capabilities = {
        tools: typeof cap.tools === 'boolean' ? cap.tools : undefined,
        vision: typeof cap.vision === 'boolean' ? cap.vision : undefined,
      };
    }
    capabilities = {
      tools:
        typeof capabilities?.tools === 'boolean'
          ? capabilities.tools
          : typeof toolCalling === 'boolean'
            ? toolCalling
            : undefined,
      vision: typeof capabilities?.vision === 'boolean' ? capabilities.vision : vision,
    };

    return this.withModelDefaults(
      {
        name,
        enabled,
        description,
        apiStyle,
        apiType,
        temperature,
        topP,
        capabilities,
        contextSize: contextSize === undefined ? undefined : Math.max(2, Math.floor(contextSize)),
        maxInputTokens: maxInputTokens === undefined ? undefined : Math.max(1, Math.floor(maxInputTokens)),
        maxOutputTokens: maxOutputTokens === undefined ? undefined : Math.max(1, Math.floor(maxOutputTokens)),
        streaming,
        thinking,
        editTools,
        supportsReasoningEffort,
        reasoningEffortFormat,
        zeroDataRetentionEnabled,
      },
      defaultVision,
      defaultApiStyle,
    );
  }

  private withModelDefaults(
    model: VendorModelConfig,
    defaultVision = DEFAULT_MODEL_CAPABILITIES_VISION,
    defaultApiStyle: VendorApiStyle = 'openai-chat',
  ): VendorModelConfig {
    return {
      name: model.name,
      enabled: model.enabled !== false,
      description: model.description,
      apiStyle: this.normalizeApiStyle(model.apiStyle, defaultApiStyle),
      apiType: model.apiType,
      temperature: model.temperature,
      topP: model.topP,
      contextSize: model.contextSize,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {
        tools: model.capabilities?.tools ?? DEFAULT_MODEL_CAPABILITIES_TOOLS,
        vision: model.capabilities?.vision ?? defaultVision,
      },
      streaming: model.streaming,
      thinking: model.thinking,
      editTools: model.editTools,
      supportsReasoningEffort: model.supportsReasoningEffort,
      reasoningEffortFormat: model.reasoningEffortFormat,
      zeroDataRetentionEnabled: model.zeroDataRetentionEnabled,
    };
  }

  private normalizeApiStyle(value: unknown, fallback: VendorApiStyle = 'openai-chat'): VendorApiStyle {
    return value === 'anthropic'
      ? 'anthropic'
      : value === 'openai-responses' || value === 'responses'
        ? 'openai-responses'
        : value === 'openai-chat' || value === 'chat'
          ? 'openai-chat'
          : fallback;
  }

  private normalizeApiType(value: unknown): VendorApiType | undefined {
    return value === 'responses' || value === 'openai-responses'
      ? 'responses'
      : value === 'anthropic'
        ? 'anthropic'
        : value === 'chat' || value === 'openai-chat'
          ? 'chat'
          : undefined;
  }

  private normalizeReasoningEffortFormat(value: unknown): ReasoningEffortFormat | undefined {
    return value === 'responses' || value === 'chat-completions' ? value : undefined;
  }

  private resolveVendorsConfigTarget(): vscode.ConfigurationTarget {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const inspected = config.inspect<unknown[]>('vendors');
    if (inspected?.workspaceFolderValue !== undefined) {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspected?.workspaceValue !== undefined) {
      return vscode.ConfigurationTarget.Workspace;
    }
    if (inspected?.globalValue !== undefined) {
      return vscode.ConfigurationTarget.Global;
    }
    return vscode.ConfigurationTarget.Global;
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

  private readBooleanValue(value: unknown): boolean | undefined {
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

  private readToolCallingValue(value: unknown): boolean | number | undefined {
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

  private readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }
    return Array.from(new Set(normalized));
  }

  private readReasoningEffortArray(value: unknown): ReasoningEffortValue[] | undefined {
    const allowed = new Set<ReasoningEffortValue>(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    const values = this.readStringArray(value)
      ?.map((item) => item.toLowerCase())
      .filter((item): item is ReasoningEffortValue => allowed.has(item as ReasoningEffortValue));
    return values && values.length > 0 ? values : undefined;
  }

  private readNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
    }

    return undefined;
  }

  private readSamplingNumber(value: unknown, min: number, max: number): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized.length === 0 || normalized === 'inherit' || normalized === 'none') {
        return undefined;
      }
      const parsed = Number(normalized);
      if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
        return parsed;
      }
    }

    return undefined;
  }

  private sortModels(models: VendorModelConfig[]): VendorModelConfig[] {
    return [...models].sort((left, right) => {
      const leftKey = left.name.toLowerCase();
      const rightKey = right.name.toLowerCase();
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      if (left.name < right.name) {
        return -1;
      }
      if (left.name > right.name) {
        return 1;
      }
      return 0;
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.onDidChangeEmitter.dispose();
  }

  /**
   * Validates all configured vendors against required fields.
   * Returns an array of errors for vendors with missing required fields.
   */
  validateVendorConfigs(): VendorValidationError[] {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<unknown[]>('vendors', []);
    if (!Array.isArray(raw)) {
      return [];
    }

    const errors: VendorValidationError[] = [];
    for (let i = 0; i < raw.length; i++) {
      const rawVendor = raw[i];
      if (!rawVendor || typeof rawVendor !== 'object') {
        continue;
      }
      const obj = rawVendor as Record<string, unknown>;
      const vendorName = typeof obj.name === 'string' ? obj.name.trim() : `#${i + 1}`;

      if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
        errors.push({ vendorIndex: i, vendorName, field: 'name', reason: 'name is required' });
      }

      if (typeof obj.baseUrl !== 'string' || obj.baseUrl.trim().length === 0) {
        errors.push({ vendorIndex: i, vendorName, field: 'baseUrl', reason: 'baseUrl is required' });
      }

      if (typeof obj.useModelsEndpoint !== 'boolean') {
        errors.push({
          vendorIndex: i,
          vendorName,
          field: 'useModelsEndpoint',
          reason: 'useModelsEndpoint is required (boolean)',
        });
      }
    }

    return errors;
  }
}
