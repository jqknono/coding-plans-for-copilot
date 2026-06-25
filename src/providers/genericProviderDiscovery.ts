import { AIModelConfig, normalizeHttpBaseUrl } from './baseProvider';
import { VendorApiStyle, VendorConfig, VendorModelConfig } from '../config/configStore';
import { DEFAULT_MODEL_TOOLS, NON_RETRYABLE_DISCOVERY_STATUS_CODES } from '../constants';
import { isGrokModel } from './modelsDevCatalog';

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
  vendorName?: string,
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

    if (isGeneratedFallbackModelConfig(configured, discovered, vendorName)) {
      return {
        ...discovered,
        enabled: configured.enabled,
      };
    }

    if (shouldAdoptDiscoveredApiStyle(configured, discovered)) {
      return {
        ...configured,
        apiStyle: discovered.apiStyle,
      };
    }

    return configured;
  });
}

export function toVendorStateKey(vendorName: string): string {
  return vendorName.trim().toLowerCase();
}

export function buildVendorDiscoverySignature(vendor: VendorConfig, apiKey: string): string {
  const normalizedBaseUrl = normalizeHttpBaseUrl(vendor.baseUrl) || vendor.baseUrl.trim();
  const modelsSignature = hashText(JSON.stringify(vendor.models));
  const endpointFlag = vendor.useModelsEndpoint ? '1' : '0';
  return `${toVendorStateKey(vendor.name)}|${normalizedBaseUrl.toLowerCase()}|${vendor.defaultApiStyle}|${endpointFlag}|${modelsSignature}|${hashText(apiKey.trim())}`;
}

function toVendorModelConfig(model: AIModelConfig): VendorModelConfig | undefined {
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
    apiStyle: readVendorApiStyle(model.apiStyle),
    contextSize: readPositiveTokenInteger(model.maxTokens),
    capabilities: {
      tools,
      vision,
      thinking: model.capabilities?.thinking,
    },
    vision: model.modelsDevEnriched && typeof vision === 'boolean' ? vision : undefined,
    streaming: model.streaming,
    editTools: model.editTools,
    supportsReasoningEffort: model.supportsReasoningEffort,
    reasoningEffortFormat: model.reasoningEffortFormat,
    zeroDataRetentionEnabled: model.zeroDataRetentionEnabled,
    price: buildPriceConfig(model),
  };
}

function readVendorApiStyle(value: unknown): VendorApiStyle | undefined {
  return value === 'openai-responses' || value === 'anthropic' || value === 'openai-chat' ? value : undefined;
}

function shouldAdoptDiscoveredApiStyle(
  configured: VendorModelConfig,
  discovered: VendorModelConfig,
): boolean {
  return (
    discovered.apiStyle === 'openai-responses' &&
    configured.apiStyle === 'openai-chat' &&
    isGrokModel(configured.name)
  );
}

function isGeneratedFallbackModelConfig(
  configured: VendorModelConfig,
  discovered: VendorModelConfig,
  vendorName: string | undefined,
): boolean {
  if (!isEnrichedDiscoveredModel(discovered)) {
    return false;
  }
  if (configured.price !== undefined) {
    return false;
  }
  if (
    configured.temperature !== undefined ||
    configured.topP !== undefined ||
    configured.streaming !== undefined ||
    configured.editTools !== undefined ||
    configured.supportsReasoningEffort !== undefined ||
    configured.reasoningEffortFormat !== undefined ||
    configured.zeroDataRetentionEnabled !== undefined
  ) {
    return false;
  }

  return isGeneratedFallbackDescription(configured.description, configured.name, vendorName);
}

function isEnrichedDiscoveredModel(model: VendorModelConfig): boolean {
  return (
    model.price !== undefined ||
    model.apiStyle !== undefined ||
    typeof model.capabilities?.thinking === 'boolean' ||
    isNonGeneratedDescription(model.description, model.name)
  );
}

function isNonGeneratedDescription(description: string | undefined, modelName: string): boolean {
  return description !== undefined && !isGeneratedFallbackDescription(description, modelName, undefined);
}

function isGeneratedFallbackDescription(
  description: string | undefined,
  modelName: string,
  vendorName: string | undefined,
): boolean {
  const normalizedDescription = description?.trim();
  const normalizedModelName = modelName.trim();
  if (!normalizedDescription || !normalizedModelName) {
    return false;
  }

  const candidates = [
    `${vendorName ?? ''} model: ${normalizedModelName}`,
    `${vendorName ?? ''} 可用模型: ${normalizedModelName}`,
  ].filter((candidate) => !candidate.startsWith(' '));
  if (vendorName !== undefined && vendorName.trim().length > 0) {
    return candidates.includes(normalizedDescription);
  }
  return (
    normalizedDescription.endsWith(` model: ${normalizedModelName}`) ||
    normalizedDescription.endsWith(` 可用模型: ${normalizedModelName}`)
  );
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

function readPositiveTokenInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
