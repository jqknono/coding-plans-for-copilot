import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { VendorConfig, VendorModelConfig } from '../config/configStore';
import { resolveModelBudget } from '../providers/contextBudget';
import { mergeConfiguredModelOverrides, toVendorModelConfigs } from '../providers/genericProviderDiscovery';
import { normalizeModelsDevCatalog, resolveModelsDevModelConfig } from '../providers/modelsDevCatalog';
import type { AIModelConfig } from '../providers/baseProvider';
import { toChatLanguageModelsModelConfig } from '../config/chatLanguageModelsConfig';

/** 由现有单元测试 runner 在安装 vscode mock 后调用，无需桌面宿主或网络。 */
export function runContextConfigTests(): void {
  runManifestValidationTests();
  const budget = { inputTokens: 180000, outputTokens: 12000, presets: [64000, 128000] };
  const catalog = normalizeModelsDevCatalog({
    models: {
      'lab/model': { id: 'lab/model', limit: { context: 400000, input: 300000, output: 60000 } },
    },
  });
  const resolved = resolveModelsDevModelConfig(catalog, 'lab/model');
  assert.equal(resolved?.contextWindow, 400000);
  assert.equal(resolved?.maxInputTokens, 300000);
  assert.equal(resolved?.maxOutputTokens, 60000);
  assert.equal(resolved?.limitSource, 'models.dev');

  const discovered: VendorModelConfig = { name: 'model', ...resolved };
  const automatic: VendorModelConfig = {
    name: 'MODEL',
    enabled: false,
    limitSource: 'endpoint',
    contextWindow: 200000,
    maxInputTokens: 160000,
    maxOutputTokens: 40000,
    contextBudget: budget,
    description: '手动描述',
    price: { inputCost: 2 },
  };
  const refreshed = mergeConfiguredModelOverrides([automatic], [discovered], false)[0];
  assert.equal(refreshed.contextWindow, 400000);
  assert.equal(refreshed.maxInputTokens, 300000);
  assert.equal(refreshed.maxOutputTokens, 60000);
  assert.equal(refreshed.limitSource, 'models.dev');
  assert.deepEqual(refreshed.contextBudget, budget);
  assert.equal(refreshed.enabled, false);
  assert.equal(refreshed.description, '手动描述');
  assert.deepEqual(refreshed.price, { inputCost: 2 });
  assert.equal(refreshed.name, 'MODEL');
  assert.equal(automatic.contextWindow, 200000);

  const placeholder: VendorModelConfig = {
    name: 'model',
    enabled: false,
    description: 'vendor model: model',
    apiStyle: 'chat-completions',
    limitSource: 'endpoint',
    contextWindow: 200000,
    contextBudget: budget,
    capabilities: { tools: true, vision: false },
  };
  const enriched: VendorModelConfig = {
    ...discovered,
    description: 'model | lab | family | Open | 2026-01-01',
    apiStyle: 'chat-completions',
    capabilities: { tools: true, vision: true, thinking: true },
    price: { inputCost: 1, outputCost: 3 },
  };
  const upgraded = mergeConfiguredModelOverrides([placeholder], [enriched], false, 'vendor')[0];
  assert.equal(upgraded.description, placeholder.description);
  assert.deepEqual(upgraded.capabilities, enriched.capabilities);
  assert.deepEqual(upgraded.price, enriched.price);
  assert.equal(upgraded.contextWindow, 400000);
  assert.equal(upgraded.maxInputTokens, 300000);
  assert.equal(upgraded.maxOutputTokens, 60000);
  assert.equal(upgraded.limitSource, 'models.dev');
  assert.deepEqual(upgraded.contextBudget, budget);
  assert.equal(upgraded.enabled, false);
  assert.equal(placeholder.description, 'vendor model: model');

  const described = { ...placeholder, description: '手工模型描述' };
  const preserved = mergeConfiguredModelOverrides([described], [enriched], false, 'vendor')[0];
  assert.equal(preserved.description, '手工模型描述');
  assert.deepEqual(preserved.capabilities, enriched.capabilities);
  assert.deepEqual(preserved.contextBudget, budget);
  assert.equal(preserved.contextWindow, 400000);
  assert.equal(preserved.limitSource, 'models.dev');
  assert.equal(preserved.enabled, false);

  for (const limitSource of ['configured', undefined] as const) {
    const manual = { ...automatic, limitSource, description: 'model | lab | family | Open | 2026-01-01' };
    assert.deepEqual(mergeConfiguredModelOverrides([manual], [discovered], true)[0], manual);
  }
  const partial = mergeConfiguredModelOverrides(
    [automatic],
    [{ name: 'model', limitSource: 'endpoint', contextWindow: 250000 }],
    false,
  )[0];
  assert.equal(partial.maxInputTokens, 160000);
  assert.equal(partial.maxOutputTokens, 40000);

  const runtime = {
    id: 'vendor/model',
    vendor: 'vendor',
    family: 'model',
    name: 'model',
    description: '',
    maxTokens: 180000,
    contextWindow: 400000,
    maxInputTokens: 300000,
    maxOutputTokens: 60000,
    limitSource: 'endpoint',
  } as AIModelConfig;
  const stored = toVendorModelConfigs([runtime])[0];
  assert.equal(stored.contextWindow, 400000);
  assert.equal(stored.maxInputTokens, 300000);
  assert.equal(stored.maxOutputTokens, 60000);
  assert.equal(stored.limitSource, 'endpoint');

  const exportModel = { ...discovered, contextBudget: budget };
  const resolvedBudget = resolveModelBudget(exportModel, budget);
  const exported = toChatLanguageModelsModelConfig(contextConfigTestVendor, exportModel);
  assert.equal(exported.contextWindow, resolvedBudget.inputTokens + resolvedBudget.outputTokens);
  assert.equal(exported.maxOutputTokens, resolvedBudget.outputTokens);
  assert.deepEqual(exported.editTools, ['apply-patch', 'find-replace', 'multi-find-replace']);
}

/** 使用真实 get('') 形状验证只读初始化、SecretStorage 与显式作用域写回。 */
export async function runContextConfigStoreTests(): Promise<void> {
  type Scope = { globalValue?: unknown[]; workspaceValue?: unknown[]; workspaceFolderValue?: unknown[] };
  const configurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  let scope: Scope = {};
  const updates: Array<{ target: number; value: unknown[] }> = [];
  const warnings: string[] = [];
  const secrets = new Map<string, string>();
  const vscodeMock = {
    ConfigurationTarget: configurationTarget,
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    window: { showWarningMessage: async (message: string) => { warnings.push(message); } },
    workspace: {
      workspaceFolders: [{ uri: 'folder' }],
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => {
        const effective = () => scope.workspaceFolderValue ?? scope.workspaceValue ?? scope.globalValue ?? [];
        return {
          get: (key: string, fallback?: unknown) => key === '' ? { vendors: effective() }
            : key === 'vendors' ? effective() : fallback,
          inspect: (key: string) => key === 'vendors' ? scope : key === ''
            ? Object.fromEntries(Object.entries(scope).map(([key, vendors]) => [key, { vendors }])) : undefined,
          update: async (_key: string, value: unknown[], target: number) => {
            updates.push({ target, value });
            const key = target === 1 ? 'globalValue' : target === 2 ? 'workspaceValue' : 'workspaceFolderValue';
            scope[key] = value;
          },
        };
      },
    },
  };
  const loader = require('node:module') as Record<string, (request: string, ...args: unknown[]) => unknown>;
  const originalLoad = loader['_load'];
  const modulePath = createRequire(__filename).resolve('../config/configStore');
  const previousModule = require.cache[modulePath];
  let ConfigStore: typeof import('../config/configStore').ConfigStore;
  try {
    delete require.cache[modulePath];
    loader['_load'] = (request, ...args) => request === 'vscode' ? vscodeMock : originalLoad(request, ...args);
    ConfigStore = (require('../config/configStore') as typeof import('../config/configStore')).ConfigStore;
  } finally {
    loader['_load'] = originalLoad;
    if (previousModule) { require.cache[modulePath] = previousModule; } else { delete require.cache[modulePath]; }
  }
  const context = { secrets: {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); },
  } } as unknown as import('vscode').ExtensionContext;
  for (const [scopeKey, target] of Object.entries({ globalValue: 1, workspaceValue: 2, workspaceFolderValue: 3 })) {
    const vendors = [{
      ...contextConfigTestVendor, name: ' vendor ', baseUrl: ' https://example.test/v1 ',
      usageUrl: ' https://example.test/usage ', defaultApiStyle: 'messages', defaultVision: true,
      models: [{ name: ' model ', limitSource: 'endpoint', contextWindow: 200000,
        maxInputTokens: 160000, maxOutputTokens: 40000,
        contextBudget: { inputTokens: 120000, outputTokens: 12000 } }],
    }];
    scope = { [scopeKey]: vendors };
    updates.length = 0;
    const before = JSON.stringify(vendors);
    const store = new ConfigStore(context);
    try {
      await store.ready();
      await store.ready();
      assert.equal(updates.length, 0);
      assert.equal(JSON.stringify(vendors), before);
      assert.deepEqual(store.validateVendorConfigs(), []);
      const vendor = store.getVendors()[0];
      assert.equal(vendor.name, 'vendor');
      assert.equal(vendor.baseUrl, 'https://example.test/v1');
      assert.equal(vendor.usageUrl, 'https://example.test/usage');
      assert.equal(vendor.models[0].name, 'model');
      assert.equal(vendor.models[0].apiStyle, 'messages');
      assert.equal(vendor.models[0].enabled, true);
      assert.deepEqual(vendor.models[0].capabilities, { tools: true, vision: true });
      await store.setApiKey('vendor', ' mock-secret ');
      assert.equal(await store.getApiKey('vendor'), 'mock-secret');
      assert.equal(secrets.get('coding-plans.vendor.apiKey.vendor'), 'mock-secret');
      assert.equal(updates.length, 0);
      await store.updateVendorModels('vendor', [
        { name: 'model', contextWindow: 400000, maxInputTokens: 300000, maxOutputTokens: 60000, limitSource: 'models.dev' },
        { name: 'inherited' },
        { name: 'explicit', apiStyle: 'chat-completions', capabilities: { vision: false } },
      ]);
      assert.deepEqual(updates.map((update) => update.target), [target]);
      const saved = store.getVendors()[0].models;
      const refreshed = saved.find((model) => model.name === 'model')!;
      assert.equal(refreshed.contextWindow, 400000);
      assert.equal(refreshed.maxInputTokens, 300000);
      assert.equal(refreshed.maxOutputTokens, 60000);
      assert.deepEqual(refreshed.contextBudget, { inputTokens: 120000, outputTokens: 12000 });
      assert.equal(saved.find((model) => model.name === 'inherited')?.apiStyle, 'messages');
      assert.equal(saved.find((model) => model.name === 'explicit')?.apiStyle, 'chat-completions');
      assert.equal(saved.find((model) => model.name === 'explicit')?.capabilities?.vision, false);
    } finally { store.dispose(); }
  }
  assert.deepEqual(warnings, []);
}

/** manifest 的全部合法字段与 validator 使用同一当前契约。 */
export function runManifestValidationTests(): void {
  const { validateRootConfiguration, validateVendorConfiguration, isValidModelConfig, isVendorApiStyle,
    getRootConfigurationKeys } = require('../config/configValidation') as typeof import('../config/configValidation');
  type Schema = { type?: string; enum?: unknown[]; default?: unknown; minimum?: number;
    properties?: Record<string, Schema>; items?: Schema };
  const manifest = require('../../package.json');
  const properties = manifest.contributes.configuration.properties as Record<string, Schema>;
  const sample = (schema: Schema): unknown => {
    if (schema.enum) { return schema.enum[0]; }
    if (schema.type === 'object') { return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, sample(child)])); }
    if (schema.type === 'array') { return [sample(schema.items!)]; }
    if (schema.type === 'boolean') { return true; }
    if (schema.type === 'number' || schema.type === 'integer') { return Math.max(schema.minimum ?? 0, 2); }
    return 'fixture';
  };
  const root = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key.replace('coding-plans.', ''), sample(schema)]));
  assert.deepEqual(validateRootConfiguration(root), []);
  const vendorSchema = properties['coding-plans.vendors'].items!;
  const modelSchema = vendorSchema.properties!.models.items!;
  const vendor = sample(vendorSchema) as VendorConfig;
  assert.deepEqual(validateVendorConfiguration([vendor]).errors, []);
  assert.equal(isValidModelConfig(sample(modelSchema)), true);
  const styles = ['chat-completions', 'responses', 'messages'];
  assert.deepEqual(vendorSchema.properties!.defaultApiStyle.enum, styles);
  assert.deepEqual(modelSchema.properties!.apiStyle.enum, styles);
  for (const style of styles) {
    assert.equal(isVendorApiStyle(style), true);
    assert.deepEqual(validateVendorConfiguration([{ ...vendor, defaultApiStyle: style,
      models: [{ ...vendor.models[0], apiStyle: style }] }]).errors, []);
  }
  const knownKeys = getRootConfigurationKeys();
  const manifestKeys = new Set<string>();
  const collectKeys = (key: string, schema: Schema): void => {
    const parts = key.split('.');
    for (let length = 1; length <= parts.length; length += 1) {
      manifestKeys.add(parts.slice(0, length).join('.'));
    }
    for (const [childKey, child] of Object.entries(schema.properties ?? {})) {
      collectKeys(`${key}.${childKey}`, child);
    }
  };
  for (const [key, schema] of Object.entries(properties)) {
    collectKeys(key.replace('coding-plans.', ''), schema);
  }
  assert.deepEqual([...knownKeys].sort(), [...manifestKeys].sort());
  for (const [key, schema] of Object.entries(properties)) {
    if (schema.default !== undefined) {
      const name = key.replace('coding-plans.', '');
      assert.deepEqual(validateRootConfiguration({ [name]: schema.default }), [], key);
    }
  }
  const native = manifest.contributes.languageModelChatProviders[0].configuration.properties.apiKey;
  assert.equal(native.type, 'string');
  assert.equal(native.secret, true);
}

/** 可供配置导出测试复用的最小供应商，使用独立测试配置。 */
export const contextConfigTestVendor: VendorConfig = {
  name: 'vendor',
  baseUrl: 'https://example.test/v1',
  defaultApiStyle: 'chat-completions',
  useModelsEndpoint: true,
  defaultVision: false,
  models: [],
};
