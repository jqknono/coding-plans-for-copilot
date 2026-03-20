import { AIModelConfig, normalizeHttpBaseUrl } from './baseProvider';
import { VendorApiStyle, VendorConfig, VendorModelConfig } from '../config/configStore';
import {
  DEFAULT_TOKEN_SIDE_LIMIT,
  DEFAULT_MODEL_TOOLS,
  NON_RETRYABLE_DISCOVERY_STATUS_CODES
} from '../constants';

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
  defaultVisionForNewModels: boolean
): VendorModelConfig[] {
  const configuredByName = new Map<string, VendorModelConfig>();
  for (const model of currentModels) {
    const key = model.name.trim().toLowerCase();
    if (!key || configuredByName.has(key)) {
      continue;
    }
    configuredByName.set(key, model);
  }

  return discoveredModels.map(discovered => {
    const configured = configuredByName.get(discovered.name.trim().toLowerCase());
    if (!configured) {
      const discoveredVision = discovered.capabilities?.vision;
      if (typeof discoveredVision === 'boolean') {
        return discovered;
      }
      return {
        ...discovered,
        capabilities: {
          ...discovered.capabilities,
          vision: defaultVisionForNewModels
        }
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
    description: model.description?.trim() || undefined,
    contextSize: readPositiveTokenInteger(model.maxTokens),
    maxInputTokens: readPositiveTokenInteger(model.maxInputTokens) ?? DEFAULT_TOKEN_SIDE_LIMIT,
    maxOutputTokens: readPositiveTokenInteger(model.maxOutputTokens) ?? DEFAULT_TOKEN_SIDE_LIMIT,
    capabilities: {
      tools,
      vision
    }
  };
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
