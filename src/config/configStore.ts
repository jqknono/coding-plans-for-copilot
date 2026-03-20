import * as vscode from 'vscode';
import {
  ADVANCED_OPTIONS_SETTING_KEY,
  DEFAULT_ADVANCED_RESERVED_OUTPUT,
  DEFAULT_MODEL_CAPABILITIES_TOOLS,
  DEFAULT_MODEL_CAPABILITIES_VISION,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  VENDOR_API_KEY_PREFIX
} from '../constants';

export type VendorApiStyle = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface VendorModelConfig {
  name: string;
  description?: string;
  apiStyle?: VendorApiStyle;
  temperature?: number;
  topP?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
  };
  /**
   * Total context window size in tokens.
   */
  contextSize?: number;
  /**
   * @deprecated Prefer contextSize for total model context. Keep this only for legacy per-direction overrides.
   */
  maxInputTokens?: number;
  /**
   * @deprecated Prefer contextSize for total model context. Keep this only for legacy output-cap overrides.
   */
  maxOutputTokens?: number;
}

export interface VendorConfig {
  name: string;
  baseUrl: string;
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

export class ConfigStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('coding-plans.vendors')) {
          this.onDidChangeEmitter.fire();
        }
      })
    );
  }

  getAdvancedOptions(): AdvancedOptions {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<Record<string, unknown> | undefined>(ADVANCED_OPTIONS_SETTING_KEY, undefined);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { defaultReservedOutput: DEFAULT_ADVANCED_RESERVED_OUTPUT };
    }
    return {
      defaultReservedOutput: this.readNonNegativeInteger(raw.defaultReservedOutput) ?? DEFAULT_ADVANCED_RESERVED_OUTPUT
    };
  }

  getVendors(): VendorConfig[] {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<unknown[]>('vendors', []);
    return this.normalizeVendors(raw);
  }

  getVendor(name: string): VendorConfig | undefined {
    return this.getVendors().find(v => v.name === name);
  }

  async getApiKey(vendorName: string): Promise<string> {
    const key = await this.context.secrets.get(VENDOR_API_KEY_PREFIX + vendorName);
    return (key || '').trim();
  }

  async setApiKey(vendorName: string, apiKey: string): Promise<void> {
    const secretKey = VENDOR_API_KEY_PREFIX + vendorName;
    const normalized = apiKey.trim();
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
    // For existing entries, preserve the original configured object verbatim and only add/remove by name.
    const inputNames = models
      .map(model => (typeof model?.name === 'string' ? model.name.trim() : ''))
      .filter(name => name.length > 0);
    let changed = false;

    const updatedVendors = rawVendors.map(rawVendor => {
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
      const defaultApiStyle = this.normalizeApiStyle(vendorObj.defaultApiStyle ?? vendorObj.apiStyle);
      const nextModels = this.buildUpdatedModelEntries(
        inputNames,
        models,
        Array.isArray(vendorObj.models) ? vendorObj.models : [],
        existingNameByKey,
        defaultVision,
        defaultApiStyle
      );
      const normalizedCurrentModels = this.sortModels(
        currentNames.map(currentName => ({ name: existingNameByKey.get(currentName.toLowerCase()) ?? currentName }))
      );

      // Only compare names.
      const currentSignature = JSON.stringify(normalizedCurrentModels.map(m => m.name));
      const nextSignature = JSON.stringify(nextModels.map(model => model.name));
      if (currentSignature === nextSignature) {
        return rawVendor;
      }

      changed = true;
      return {
        ...vendorObj,
        models: nextModels
      };
    });

    if (!changed) {
      return;
    }

    await config.update('vendors', updatedVendors, this.resolveVendorsConfigTarget());
    this.onDidChangeEmitter.fire();
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
    const updatedVendors = rawVendors.map(rawVendor => {
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
        baseUrl: normalizedBaseUrl
      };
    });

    if (!changed) {
      return;
    }

    await config.update('vendors', updatedVendors, this.resolveVendorsConfigTarget());
    this.onDidChangeEmitter.fire();
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
    defaultApiStyle: VendorApiStyle
  ): VendorModelConfig {
    const normalized = this.normalizeModel(raw, defaultVision, defaultApiStyle);
    if (!normalized) {
      return this.withModelDefaults({ name }, defaultVision, defaultApiStyle);
    }

    return {
      ...normalized,
      name
    };
  }

  private buildUpdatedModelEntries(
    names: string[],
    inputModels: VendorModelConfig[],
    rawModels: unknown[],
    existingNameByKey: Map<string, string>,
    defaultVision: boolean,
    defaultApiStyle: VendorApiStyle
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
        normalized.push(this.cloneModelWithNormalizedName({
          ...inputModel,
          temperature: undefined,
          topP: undefined
        }, canonical, defaultVision, defaultApiStyle));
        continue;
      }

      normalized.push(this.withModelDefaults({ name: canonical }, defaultVision, defaultApiStyle));
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
    return raw
      .map(v => this.normalizeVendor(v))
      .filter((v): v is VendorConfig => v !== undefined);
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
    const defaultApiStyle = this.normalizeApiStyle(obj.defaultApiStyle ?? obj.apiStyle);
    const defaultTemperature = this.readSamplingNumber(obj.defaultTemperature, 0, 2);
    const defaultTopP = this.readSamplingNumber(obj.defaultTopP, 0, 1);
    const useModelsEndpoint = typeof obj.useModelsEndpoint === 'boolean' ? obj.useModelsEndpoint : false;
    const defaultVision = typeof obj.defaultVision === 'boolean' ? obj.defaultVision : false;
    const models = Array.isArray(obj.models)
      ? obj.models
          .map(m => this.normalizeModel(m, defaultVision, defaultApiStyle))
          .filter((m): m is VendorModelConfig => m !== undefined)
      : [];
    return { name, baseUrl, defaultApiStyle, defaultTemperature, defaultTopP, useModelsEndpoint, defaultVision, models };
  }

  private normalizeModel(
    raw: unknown,
    defaultVision = DEFAULT_MODEL_CAPABILITIES_VISION,
    defaultApiStyle: VendorApiStyle = 'openai-chat'
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
      typeof obj.description === 'string' && obj.description.trim().length > 0
        ? obj.description.trim()
        : undefined;
    const legacyContextWindow = this.readPositiveNumber(obj.contextSize);
    const rawMaxInputTokens = this.readNonNegativeInteger(obj.maxInputTokens);
    const rawMaxOutputTokens = this.readNonNegativeInteger(obj.maxOutputTokens);
    const explicitMaxInputTokens = rawMaxInputTokens !== undefined && rawMaxInputTokens > 0 ? rawMaxInputTokens : undefined;
    const explicitMaxOutputTokens = rawMaxOutputTokens !== undefined && rawMaxOutputTokens > 0 ? rawMaxOutputTokens : undefined;
    const resolvedTokenWindow = explicitMaxInputTokens !== undefined || explicitMaxOutputTokens !== undefined
      ? this.resolveTokenWindow(
          legacyContextWindow,
          explicitMaxInputTokens,
          explicitMaxOutputTokens
        )
      : { maxInputTokens: undefined, maxOutputTokens: undefined };
    const apiStyle = this.normalizeApiStyle(obj.apiStyle, defaultApiStyle);
    const temperature = this.readSamplingNumber(obj.temperature, 0, 2);
    const topP = this.readSamplingNumber(obj.topP, 0, 1);
    let capabilities: VendorModelConfig['capabilities'];
    if (obj.capabilities && typeof obj.capabilities === 'object') {
      const cap = obj.capabilities as Record<string, unknown>;
      capabilities = {
        tools: typeof cap.tools === 'boolean' ? cap.tools : undefined,
        vision: typeof cap.vision === 'boolean' ? cap.vision : undefined,
      };
    }

    return this.withModelDefaults({
      name,
      description,
      apiStyle,
      temperature,
      topP,
      capabilities,
      contextSize: legacyContextWindow === undefined ? undefined : Math.max(2, Math.floor(legacyContextWindow)),
      maxInputTokens: rawMaxInputTokens === 0 ? 0 : resolvedTokenWindow.maxInputTokens,
      maxOutputTokens: rawMaxOutputTokens === 0 ? 0 : resolvedTokenWindow.maxOutputTokens
    }, defaultVision, defaultApiStyle);
  }

  private withModelDefaults(
    model: VendorModelConfig,
    defaultVision = DEFAULT_MODEL_CAPABILITIES_VISION,
    defaultApiStyle: VendorApiStyle = 'openai-chat'
  ): VendorModelConfig {
    return {
      name: model.name,
      description: model.description,
      apiStyle: this.normalizeApiStyle(model.apiStyle, defaultApiStyle),
      temperature: model.temperature,
      topP: model.topP,
      contextSize: model.contextSize,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens ?? 0,
      capabilities: {
        tools: model.capabilities?.tools ?? DEFAULT_MODEL_CAPABILITIES_TOOLS,
        vision: model.capabilities?.vision ?? defaultVision
      }
    };
  }

  private normalizeApiStyle(value: unknown, fallback: VendorApiStyle = 'openai-chat'): VendorApiStyle {
    return value === 'anthropic'
      ? 'anthropic'
      : value === 'openai-responses'
        ? 'openai-responses'
        : value === 'openai-chat'
          ? 'openai-chat'
          : fallback;
  }

  private resolveTokenWindow(
    legacyContextWindow: number | undefined,
    explicitMaxInputTokens: number | undefined,
    explicitMaxOutputTokens: number | undefined
  ): { maxInputTokens: number; maxOutputTokens: number } {
    const hasExplicitTotalContextWindow = legacyContextWindow !== undefined;
    const fallbackTotal = Math.max(2, Math.floor(legacyContextWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE));
    const defaultReservedOutputTokens = Math.max(1, Math.min(DEFAULT_RESERVED_OUTPUT_TOKENS, fallbackTotal - 1));
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
      return { maxInputTokens, maxOutputTokens };
    }

    if (maxInputTokens !== undefined) {
      return {
        maxInputTokens,
        maxOutputTokens: hasExplicitTotalContextWindow
          ? Math.max(1, fallbackTotal - maxInputTokens)
          : defaultReservedOutputTokens
      };
    }

    if (maxOutputTokens !== undefined) {
      return {
        maxInputTokens: hasExplicitTotalContextWindow
          ? Math.max(1, fallbackTotal - maxOutputTokens)
          : Math.max(1, DEFAULT_CONTEXT_WINDOW_SIZE - maxOutputTokens),
        maxOutputTokens
      };
    }

    return {
      maxInputTokens: Math.max(1, fallbackTotal - defaultReservedOutputTokens),
      maxOutputTokens: defaultReservedOutputTokens
    };
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

  private readSamplingNumber(value: unknown, min: number, max: number): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
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
    this.disposables.forEach(d => d.dispose());
    this.onDidChangeEmitter.dispose();
  }
}
