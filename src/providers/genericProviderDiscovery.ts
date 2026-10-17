import { AIModelConfig, normalizeHttpBaseUrl } from './baseProvider';
import type { VendorApiStyle, VendorConfig, VendorModelConfig } from '../config/configStore';
import { DEFAULT_MODEL_TOOLS, NON_RETRYABLE_DISCOVERY_STATUS_CODES } from '../constants';
import { readPositiveTokenInteger } from './contextBudget';

export interface ModelVendorMapping {
  vendor: VendorConfig;
  modelName: string;
  apiStyle: VendorApiStyle;
}

export interface ModelDiscoveryResult {
  models: AIModelConfig[];
  failed: boolean;
  status?: number;
}

export interface VendorDiscoveryState {
  signature: string;
  suppressRetry: boolean;
  cachedModels: AIModelConfig[];
}

export function shouldSuppressDiscoveryRetry(status: number | undefined): boolean {
  return typeof status === 'number' && NON_RETRYABLE_DISCOVERY_STATUS_CODES.has(status);
}

export function toVendorModelConfigs(discoveredModels: AIModelConfig[]): VendorModelConfig[] {
  const normalized: VendorModelConfig[] = [];
  const seen = new Set<string>();

  for (const model of discoveredModels) {
    const discovered = toVendorModelConfig(model);
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

export function mergeConfiguredModelOverrides(
  currentModels: VendorModelConfig[],
  discoveredModels: VendorModelConfig[],
  defaultVisionForNewModels: boolean,
  _vendorName?: string,
): VendorModelConfig[] {
  const configuredByName = new Map<string, VendorModelConfig>();
  for (const model of currentModels) {
    const key = model.name.trim().toLowerCase();
    if (!key || configuredByName.has(key)) {
      continue;
    }
    configuredByName.set(key, model);
  }

  return discoveredModels.map((discovered) => {
    const configured = configuredByName.get(discovered.name.trim().toLowerCase());
    if (!configured) {
      return {
        ...discovered,
        capabilities: {
          ...discovered.capabilities,
          vision: discovered.capabilities?.vision ?? defaultVisionForNewModels,
        },
      };
    }

    const automaticLimits = configured.limitSource === 'endpoint' || configured.limitSource === 'models.dev';
    const next = { ...configured };
    if (automaticLimits) {
      // 自动来源刷新模型能力；显式元数据与用户预算保持原值。
      next.capabilities = {
        ...configured.capabilities,
        ...Object.fromEntries(Object.entries(discovered.capabilities ?? {}).filter(([, value]) => value !== undefined)),
      };
      for (const key of [
        'description', 'streaming', 'editTools', 'supportsReasoningEffort',
        'reasoningEffortFormat', 'zeroDataRetentionEnabled',
      ] as const) {
        if (configured[key] === undefined && discovered[key] !== undefined) {
          Object.assign(next, { [key]: discovered[key] });
        }
      }
      if (discovered.price !== undefined) {
        next.price = { ...discovered.price, ...configured.price };
      }
    }
    if (automaticLimits && (discovered.limitSource === 'endpoint' || discovered.limitSource === 'models.dev')) {
      // 缺失数据沿用已知能力；预算和手动属性始终保留。
      for (const key of ['contextWindow', 'maxInputTokens', 'maxOutputTokens'] as const) {
        const value = readPositiveTokenInteger(discovered[key]);
        if (value !== undefined) {
          next[key] = value;
        }
      }
      next.limitSource = discovered.limitSource;
    }
    return next;
  });
}

export function toVendorStateKey(vendorName: string): string {
  return vendorName.trim().toLowerCase();
}

export function buildVendorDiscoverySignature(vendor: VendorConfig, apiKey: string): string {
  const normalizedBaseUrl = normalizeHttpBaseUrl(vendor.baseUrl) || vendor.baseUrl.trim();
  const modelsSignature = hashText(JSON.stringify(vendor.models));
  const endpointFlag = vendor.useModelsEndpoint ? '1' : '0';
  return `${toVendorStateKey(vendor.name)}|${normalizedBaseUrl.toLowerCase()}|${vendor.defaultApiStyle}|${vendor.authType ?? ''}|${endpointFlag}|${modelsSignature}|${hashText(apiKey.trim())}`;
}

function toVendorModelConfig(
  model: AIModelConfig & Pick<VendorModelConfig, 'contextWindow' | 'limitSource'>,
): VendorModelConfig | undefined {
  const name = model.name.trim();
  if (name.length === 0) {
    return undefined;
  }

  const toolCalling = model.capabilities?.toolCalling;
  const tools = typeof toolCalling === 'number' ? toolCalling > 0 : (toolCalling ?? DEFAULT_MODEL_TOOLS);
  const imageInput = model.capabilities?.imageInput;
  const vision = typeof imageInput === 'boolean' ? imageInput : undefined;
  return {
    name,
    enabled: true,
    description: model.description?.trim() || undefined,
    apiStyle: model.apiStyle,
    contextWindow: readPositiveTokenInteger(model.contextWindow),
    maxInputTokens: readPositiveTokenInteger(model.maxInputTokens),
    maxOutputTokens: readPositiveTokenInteger(model.maxOutputTokens),
    limitSource: model.limitSource ?? (model.modelsDevEnriched ? 'models.dev' : 'endpoint'),
    capabilities: {
      tools,
      vision,
      thinking: model.capabilities?.thinking,
    },
    streaming: model.streaming,
    editTools: model.editTools,
    supportsReasoningEffort: model.supportsReasoningEffort,
    reasoningEffortFormat: model.reasoningEffortFormat,
    zeroDataRetentionEnabled: model.zeroDataRetentionEnabled,
    price: buildPriceConfig(model),
  };
}

function buildPriceConfig(model: AIModelConfig): VendorModelConfig['price'] {
  const price: NonNullable<VendorModelConfig['price']> = {};
  if (model.inputCost !== undefined) {
    price.inputCost = model.inputCost;
  }
  if (model.cacheCost !== undefined) {
    price.cacheCost = model.cacheCost;
  }
  if (model.outputCost !== undefined) {
    price.outputCost = model.outputCost;
  }
  if (model.longContextInputCost !== undefined) {
    price.longContextInputCost = model.longContextInputCost;
  }
  if (model.longContextCacheCost !== undefined) {
    price.longContextCacheCost = model.longContextCacheCost;
  }
  if (model.longContextOutputCost !== undefined) {
    price.longContextOutputCost = model.longContextOutputCost;
  }
  return Object.values(price).some((entry) => entry !== undefined) ? price : undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
