import * as vscode from 'vscode';

export interface VendorModelConfig {
  name: string;
  description?: string;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
  };
  /**
   * Context window size in tokens.
   */
  contextSize?: number;
  /**
   * @deprecated Use {@link VendorModelConfig.contextSize}.
   */
  maxInputTokens?: number;
  /**
   * @deprecated Use {@link VendorModelConfig.contextSize}.
   */
  maxOutputTokens?: number;
}

export interface VendorConfig {
  name: string;
  baseUrl: string;
  useModelsEndpoint: boolean;
  defaultVision: boolean;
  models: VendorModelConfig[];
}

const VENDOR_API_KEY_PREFIX = 'coding-plans.vendor.apiKey.';
const DEFAULT_MODEL_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 200000;
const DEFAULT_MODEL_CAPABILITIES_TOOLS = true;
const DEFAULT_MODEL_CAPABILITIES_VISION = false;

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

    // Persist only model names.
    // Rationale: when `useModelsEndpoint` is enabled, providers may re-discover models frequently,
    // and non-name fields (description/capabilities/token limits) can be unstable across requests.
    // Writing only sorted names makes config updates converge and avoids refresh loops.
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

      const nextModels = this.sortModels(this.dedupeAndCanonicalizeModelNames(inputNames, existingNameByKey));
      const normalizedCurrentModels = this.sortModels(
        this.dedupeAndCanonicalizeModelNames(currentNames, existingNameByKey)
      );

      // Only compare names.
      const currentSignature = JSON.stringify(normalizedCurrentModels.map(m => m.name));
      const nextSignature = JSON.stringify(nextModels.map(m => m.name));
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

  private readModelName(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    return name.length > 0 ? name : undefined;
  }

  private dedupeAndCanonicalizeModelNames(
    names: string[],
    existingNameByKey: Map<string, string>
  ): VendorModelConfig[] {
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

      const canonical = existingNameByKey.get(key) ?? name;
      normalized.push({ name: canonical });
    }

    return normalized;
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
    const useModelsEndpoint = typeof obj.useModelsEndpoint === 'boolean' ? obj.useModelsEndpoint : false;
    const defaultVision = typeof obj.defaultVision === 'boolean' ? obj.defaultVision : false;
    const models = Array.isArray(obj.models)
      ? obj.models
          .map(m => this.normalizeModel(m))
          .filter((m): m is VendorModelConfig => m !== undefined)
      : [];
    return { name, baseUrl, useModelsEndpoint, defaultVision, models };
  }

  private normalizeModel(raw: unknown): VendorModelConfig | undefined {
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
    const contextSize = this.readPositiveNumber(obj.contextSize);
    const maxInputTokens = this.readPositiveNumber(obj.maxInputTokens) ?? contextSize;
    const maxOutputTokens = this.readPositiveNumber(obj.maxOutputTokens) ?? contextSize;
    let capabilities: VendorModelConfig['capabilities'];
    if (obj.capabilities && typeof obj.capabilities === 'object') {
      const cap = obj.capabilities as Record<string, unknown>;
      capabilities = {
        tools: typeof cap.tools === 'boolean' ? cap.tools : undefined,
        vision: typeof cap.vision === 'boolean' ? cap.vision : undefined,
      };
    }

    return { name, description, capabilities, contextSize, maxInputTokens, maxOutputTokens };
  }

  private withModelDefaults(model: VendorModelConfig): VendorModelConfig {
    const maxInputTokens = model.maxInputTokens ?? DEFAULT_MODEL_MAX_INPUT_TOKENS;
    const maxOutputTokens = model.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
    return {
      name: model.name,
      description: model.description,
      contextSize: model.contextSize,
      maxInputTokens,
      maxOutputTokens,
      capabilities: {
        tools: model.capabilities?.tools ?? DEFAULT_MODEL_CAPABILITIES_TOOLS,
        vision: model.capabilities?.vision ?? DEFAULT_MODEL_CAPABILITIES_VISION
      }
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
