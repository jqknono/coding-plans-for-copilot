import * as vscode from 'vscode';
import { mergeConfiguredModelOverrides } from '../providers/genericProviderDiscovery';
import {
  AUTO_REFRESH_MODELS_SETTING_KEY,
  DEFAULT_AUTO_REFRESH_MODELS,
  DEFAULT_MODEL_CAPABILITIES_TOOLS,
  DEFAULT_MODEL_CAPABILITIES_VISION,
  VENDOR_API_KEY_PREFIX,
} from '../constants';
import {
  getRootConfigurationKeys,
  isConfigObject,
  isValidModelConfig,
  isVendorApiStyle,
  validateRootConfiguration,
  validateVendorConfiguration,
} from './configValidation';
import type {
  ValidatedVendor,
  VendorApiStyle,
  VendorConfig,
  VendorModelConfig,
  VendorValidationError,
} from './configValidation';

export type {
  VendorApiStyle,
  VendorAuthType,
  ReasoningEffortValue,
  ReasoningEffortFormat,
  VendorModelPriceConfig,
  VendorModelConfig,
  VendorConfig,
  VendorValidationError,
} from './configValidation';

export class ConfigStore implements vscode.Disposable {
  private readonly onDidChangeVendorsEmitter = new vscode.EventEmitter<void>();
  /** 厂商配置和密钥变化事件，与自动发现开关独立。 */
  public readonly onDidChange = this.onDidChangeVendorsEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly readyPromise: Promise<void>;
  private lastErrorSignature = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        const vendorsChanged = event.affectsConfiguration('coding-plans.vendors');
        if (vendorsChanged || event.affectsConfiguration('coding-plans')) {
          this.getVendors();
        }
        if (vendorsChanged) {
          this.onDidChangeVendorsEmitter.fire();
        }
      }),
    );
    this.readyPromise = Promise.resolve().then(() => {
      this.getVendors();
    });
  }

  /** 初始化仅校验和报告；设置写入由显式更新方法负责。 */
  async ready(): Promise<void> {
    await this.readyPromise;
  }

  isAutoRefreshModelsEnabled(): boolean {
    return (
      vscode.workspace
        .getConfiguration('coding-plans')
        .get<boolean>(AUTO_REFRESH_MODELS_SETTING_KEY, DEFAULT_AUTO_REFRESH_MODELS) === true
    );
  }

  getVendors(): VendorConfig[] {
    const result = this.readValidatedConfiguration();
    this.reportErrors(result.errors);
    return result.vendors.map((vendor) => this.normalizeVendor(vendor));
  }

  getVendor(name: string): VendorConfig | undefined {
    return this.getVendors().find((vendor) => vendor.name === name);
  }

  /** 密钥仅按厂商名称读取 SecretStorage，配置作用域与其他厂商保持隔离。 */
  async getApiKey(vendorName: string): Promise<string> {
    return ((await this.context.secrets.get(VENDOR_API_KEY_PREFIX + vendorName)) ?? '').trim();
  }

  async setApiKey(vendorName: string, apiKey: string): Promise<void> {
    const secretKey = VENDOR_API_KEY_PREFIX + vendorName;
    const normalized = apiKey.trim();
    const current = ((await this.context.secrets.get(secretKey)) ?? '').trim();
    if (current === normalized) {
      return;
    }
    if (normalized.length > 0) {
      await this.context.secrets.store(secretKey, normalized);
    } else {
      await this.context.secrets.delete(secretKey);
    }
    this.onDidChangeVendorsEmitter.fire();
  }

  async updateVendorModels(vendorName: string, models: VendorModelConfig[]): Promise<void> {
    // 发现适配器也遵循当前 schema，写回只接收完整合法的数据集。
    if (!Array.isArray(models) || !models.every(isValidModelConfig)) {
      return;
    }
    await this.updateVendor(vendorName, (raw, validated) => {
      const vendor = this.normalizeVendor(validated);
      const rawModels = (raw.models ?? []) as unknown[];
      const existingByName = new Map<string, VendorModelConfig>();
      const isolated: unknown[] = [];
      const isolatedNames = new Set<string>();
      for (const model of rawModels) {
        if (isValidModelConfig(model)) {
          const key = model.name.trim().toLowerCase();
          if (!existingByName.has(key)) {
            existingByName.set(key, model);
          }
        } else {
          // 隔离条目仍保留原始设置，由用户修正，发现流程仅更新有效模型。
          isolated.push(model);
          if (isConfigObject(model) && typeof model.name === 'string') {
            isolatedNames.add(model.name.trim().toLowerCase());
          }
        }
      }

      const next: VendorModelConfig[] = [];
      const seen = new Set<string>();
      for (const input of models) {
        const key = input.name.trim().toLowerCase();
        if (seen.has(key) || isolatedNames.has(key)) {
          continue;
        }
        seen.add(key);
        const existing = existingByName.get(key);
        const canonical = existing?.name.trim() ?? input.name.trim();
        const discovered = { ...input, name: canonical };
        const merged = existing
          ? mergeConfiguredModelOverrides(
              [this.storedModel(existing, vendor)],
              [discovered],
              vendor.defaultVision,
              vendor.name,
            )[0]
          : discovered;
        if (!isValidModelConfig(merged)) {
          return raw;
        }
        next.push(this.storedModel(merged, vendor));
      }
      const current = [...existingByName.values()].map((model) => this.storedModel(model, vendor));
      const sorted = this.sortModels(next);
      if (JSON.stringify(this.sortModels(current)) === JSON.stringify(sorted)) {
        return raw;
      }
      return { ...raw, models: [...sorted, ...isolated] };
    });
  }

  /** 原生 Add Models 显式保存到用户设置，不复制或改写工作区供应商数组。 */
  async savePickerVendor(vendorName: string, baseUrl: string): Promise<void> {
    const name = vendorName.trim();
    const normalizedUrl = baseUrl.trim();
    let url: URL;
    try {
      url = new URL(normalizedUrl);
    } catch {
      throw new Error('Base URL must be a valid HTTP(S) URL.');
    }
    if (!name || !/^https?:\/\//i.test(normalizedUrl) || !['http:', 'https:'].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(normalizedUrl)) {
      throw new Error('Provide a vendor name and an HTTP(S) Base URL without credentials, query or fragment.');
    }

    const config = vscode.workspace.getConfiguration('coding-plans');
    const inspected = config.inspect<unknown>('vendors');
    const raw = inspected?.globalValue ?? inspected?.defaultValue ?? [];
    if (!Array.isArray(raw)) {
      throw new Error('coding-plans.vendors in user settings must be an array.');
    }
    const vendors = [...raw];
    const index = vendors.findIndex((entry) => isConfigObject(entry) && typeof entry.name === 'string'
      && entry.name.trim() === name);
    if (index >= 0) {
      const existing = vendors[index] as Record<string, unknown>;
      if (existing.baseUrl === normalizedUrl && inspected?.globalValue !== undefined) {
        return;
      }
      vendors[index] = { ...existing, baseUrl: normalizedUrl };
    } else {
      vendors.push({ name, baseUrl: normalizedUrl, defaultApiStyle: 'chat-completions', useModelsEndpoint: true, models: [] });
    }
    await config.update('vendors', vendors, vscode.ConfigurationTarget.Global);
  }

  async updateVendorBaseUrl(vendorName: string, baseUrl: string): Promise<void> {
    const normalized = baseUrl.trim();
    if (normalized.length === 0) {
      return;
    }
    await this.updateVendor(vendorName, (raw, vendor) =>
      vendor.baseUrl.trim() === normalized ? raw : { ...raw, baseUrl: normalized },
    );
  }

  async updateVendorModelApiStyle(vendorName: string, modelName: string, apiStyle: VendorApiStyle): Promise<boolean> {
    const key = modelName.trim().toLowerCase();
    if (key.length === 0 || !isVendorApiStyle(apiStyle)) {
      return false;
    }
    return this.updateVendor(vendorName, (raw) => {
      let changed = false;
      const models = ((raw.models ?? []) as unknown[]).map((model) => {
        if (!isValidModelConfig(model) || model.name.trim().toLowerCase() !== key || model.apiStyle === apiStyle) {
          return model;
        }
        changed = true;
        return { ...model, apiStyle };
      });
      return changed ? { ...raw, models } : raw;
    });
  }

  /** 复用写入作用域与厂商级校验；模型级错误保留给对应更新方法处理。 */
  private async updateVendor(
    vendorName: string,
    update: (raw: Record<string, unknown>, vendor: ValidatedVendor) => Record<string, unknown>,
  ): Promise<boolean> {
    const name = vendorName.trim();
    const config = vscode.workspace.getConfiguration('coding-plans');
    const raw = config.get<unknown>('vendors', []);
    if (name.length === 0 || !Array.isArray(raw)) {
      return false;
    }
    let changed = false;
    const vendors = raw.map((entry: unknown) => {
      const validated = validateVendorConfiguration([entry]).vendors[0];
      if (!validated || validated.name.trim() !== name || !isConfigObject(entry)) {
        return entry;
      }
      const next = update(entry, validated);
      changed ||= next !== entry;
      return next;
    });
    if (changed) {
      await config.update('vendors', vendors, this.resolveVendorsConfigTarget(config));
    }
    return changed;
  }

  private normalizeVendor(vendor: ValidatedVendor): VendorConfig {
    const defaults: Pick<VendorConfig, 'defaultApiStyle' | 'defaultVision'> = {
      defaultApiStyle: vendor.defaultApiStyle ?? 'chat-completions',
      defaultVision: vendor.defaultVision ?? DEFAULT_MODEL_CAPABILITIES_VISION,
    };
    return {
      ...vendor,
      ...defaults,
      name: vendor.name.trim(),
      baseUrl: vendor.baseUrl.trim(),
      ...(vendor.usageUrl === undefined ? {} : { usageUrl: vendor.usageUrl.trim() }),
      models: vendor.models.map((model) => this.normalizeModel(model, defaults)),
    };
  }

  /** 仅接收 validator 已确认的当前结构；默认值只填补省略字段。 */
  private normalizeModel(
    model: VendorModelConfig,
    defaults: Pick<VendorConfig, 'defaultApiStyle' | 'defaultVision'>,
  ): VendorModelConfig {
    return {
      ...model,
      name: model.name.trim(),
      enabled: model.enabled ?? true,
      apiStyle: model.apiStyle ?? defaults.defaultApiStyle,
      limitSource: model.limitSource ?? 'configured',
      capabilities: {
        ...model.capabilities,
        tools: model.capabilities?.tools ?? DEFAULT_MODEL_CAPABILITIES_TOOLS,
        vision: model.capabilities?.vision ?? defaults.defaultVision,
      },
      ...(model.description === undefined ? {} : { description: model.description.trim() }),
      ...(model.contextBudget === undefined
        ? {}
        : {
            contextBudget: {
              ...model.contextBudget,
              ...(model.contextBudget.presets === undefined ? {} : { presets: [...model.contextBudget.presets] }),
            },
          }),
      ...(model.price === undefined ? {} : { price: { ...model.price } }),
      ...(model.editTools === undefined ? {} : { editTools: [...new Set(model.editTools.map((tool) => tool.trim()))] }),
      ...(model.supportsReasoningEffort === undefined
        ? {}
        : {
            supportsReasoningEffort: [...new Set(model.supportsReasoningEffort)],
          }),
    };
  }

  private storedModel(model: VendorModelConfig, vendor: VendorConfig): VendorModelConfig {
    const stored = this.normalizeModel(model, vendor);
    // 省略的协议继续继承厂商默认值，显式发现 metadata 保留其来源。
    if (model.apiStyle === undefined) {
      delete stored.apiStyle;
    }
    return stored;
  }

  private sortModels(models: VendorModelConfig[]): VendorModelConfig[] {
    return [...models].sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      return a < b ? -1 : a > b ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
  }

  private resolveVendorsConfigTarget(config: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
    const inspected = config.inspect<unknown>('vendors');
    if (inspected?.workspaceFolderValue !== undefined) {
      return vscode.ConfigurationTarget.WorkspaceFolder;
    }
    if (inspected?.workspaceValue !== undefined) {
      return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
  }

  private readValidatedConfiguration(): ReturnType<typeof validateVendorConfiguration> {
    const config = vscode.workspace.getConfiguration('coding-plans');
    const result = validateVendorConfiguration(config.get<unknown>('vendors', []));
    const rootErrors = this.readRootErrors(config);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      rootErrors.push(...this.readRootErrors(vscode.workspace.getConfiguration('coding-plans', folder.uri)));
    }
    const unique = new Map<string, VendorValidationError>();
    for (const error of [...rootErrors, ...result.errors]) {
      unique.set(JSON.stringify(error), error);
    }
    return { vendors: result.vendors, errors: [...unique.values()] };
  }

  /** 从公开配置视图枚举实际键，并以 inspect 读取显式作用域；全程使用 VS Code API。 */
  private readRootErrors(config: vscode.WorkspaceConfiguration): VendorValidationError[] {
    const errors: VendorValidationError[] = [];
    const keys = new Set(getRootConfigurationKeys());
    const collect = (value: unknown) => {
      if (isConfigObject(value)) {
        errors.push(...validateRootConfiguration(value));
        Object.keys(value).forEach((key) => keys.add(key));
      }
    };
    collect(config.get<unknown>(''));
    const enumerable: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(config)) {
      const value: unknown = config[key];
      // WorkspaceConfiguration 的 API 方法与实际设置值分开处理。
      if (['get', 'has', 'inspect', 'update'].includes(key) && typeof value === 'function') {
        continue;
      }
      enumerable[key] = value;
    }
    collect(enumerable);
    const scopes = [
      'globalValue',
      'workspaceValue',
      'workspaceFolderValue',
      'globalLanguageValue',
      'workspaceLanguageValue',
      'workspaceFolderLanguageValue',
    ] as const;
    const root = config.inspect<unknown>('');
    for (const scope of scopes) {
      collect(root?.[scope]);
    }
    for (const key of keys) {
      if (key === 'vendors') {
        continue;
      }
      const effective = config.get<unknown>(key);
      if (effective !== undefined) {
        errors.push(...validateRootConfiguration({ [key]: effective }));
      }
      const inspected = config.inspect<unknown>(key);
      for (const scope of scopes) {
        const value = inspected?.[scope];
        if (value !== undefined) {
          errors.push(...validateRootConfiguration({ [key]: value }));
        }
      }
    }
    return errors;
  }

  private reportErrors(errors: VendorValidationError[]): void {
    const signature = errors.length === 0 ? '' : JSON.stringify(errors.map((error) => JSON.stringify(error)).sort());
    if (signature === this.lastErrorSignature) {
      return;
    }
    this.lastErrorSignature = signature;
    if (errors.length === 0) {
      return;
    }
    const action = '打开设置 JSON';
    const details = errors.map((error) => `${error.path ?? error.field}: ${error.reason}`).join('\n');
    void vscode.window.showWarningMessage(`Coding Plans 配置校验提示：\n${details}`, action).then(
      (selected) => {
        if (selected === action) {
          return vscode.commands.executeCommand('workbench.action.openSettingsJson');
        }
        return undefined;
      },
      () => undefined,
    );
  }

  /** 对外保留错误数组契约；根错误使用 vendorIndex=-1，模型错误附带 modelIndex。 */
  validateVendorConfigs(): VendorValidationError[] {
    return this.readValidatedConfiguration().errors;
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.onDidChangeVendorsEmitter.dispose();
  }
}
