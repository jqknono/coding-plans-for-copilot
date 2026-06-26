import { VendorApiStyle, VendorModelConfig } from '../config/configStore';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
export const MODELS_DEV_API_URL = 'https://models.dev/api.json';

export interface ModelsDevProvider {
  id: string;
  name?: string;
  api?: string;
  models: Record<string, ModelsDevModel>;
}

export interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  open_weights?: boolean;
  release_date?: unknown;
  last_updated?: unknown;
  knowledge?: unknown;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: {
    input?: unknown;
    output?: unknown;
  };
  limit?: {
    context?: unknown;
    output?: unknown;
  };
  cost?: {
    input?: unknown;
    output?: unknown;
    cache_read?: unknown;
    context_over_200k?: unknown;
  };
}

export interface ModelsDevCatalog {
  models: Record<string, ModelsDevModel>;
  providers: Record<string, ModelsDevProvider>;
}

export async function fetchModelsDevCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelsDevCatalog | undefined> {
  const catalog = await fetchModelsDevJson(fetchImpl, MODELS_DEV_CATALOG_URL);
  const normalizedCatalog = normalizeModelsDevCatalog(catalog);
  if (normalizedCatalog) {
    return normalizedCatalog;
  }

  const apiCatalog = await fetchModelsDevJson(fetchImpl, MODELS_DEV_API_URL);
  return normalizeModelsDevCatalog(apiCatalog);
}

async function fetchModelsDevJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as unknown;
}

export function normalizeModelsDevCatalog(payload: unknown): ModelsDevCatalog | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }

  const source = payload as Record<string, unknown>;
  const rawProviders =
    source.providers && typeof source.providers === 'object' && !Array.isArray(source.providers)
      ? (source.providers as Record<string, unknown>)
      : source;
  const rawModels =
    source.models && typeof source.models === 'object' && !Array.isArray(source.models)
      ? (source.models as Record<string, unknown>)
      : undefined;

  const providers: Record<string, ModelsDevProvider> = {};
  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (!rawProvider || typeof rawProvider !== 'object' || Array.isArray(rawProvider)) {
      continue;
    }

    const source = rawProvider as Record<string, unknown>;
    const rawModels = source.models;
    if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) {
      continue;
    }

    const id = readNonEmptyString(source.id) ?? providerId;
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, rawModel] of Object.entries(rawModels as Record<string, unknown>)) {
      if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
        continue;
      }
      models[modelId] = rawModel as ModelsDevModel;
    }

    if (Object.keys(models).length === 0) {
      continue;
    }

    providers[providerId] = {
      id,
      name: readNonEmptyString(source.name),
      api: readNonEmptyString(source.api),
      models,
    };
  }

  const models = normalizeModelsDevModels(rawModels) ?? {};
  if (Object.keys(providers).length === 0 && Object.keys(models).length === 0) {
    return undefined;
  }

  return { models, providers };
}

export function resolveModelsDevModelConfig(
  catalog: ModelsDevCatalog | undefined,
  modelName: string,
): Partial<VendorModelConfig> | undefined {
  const matches = resolveModelsDevModelMatches(catalog, modelName);
  const bestMatch = pickBestModelsDevModelMatch(matches);
  const globalMatch = resolveModelsDevGlobalModel(catalog, modelName);
  const model = globalMatch?.model ?? bestMatch?.model;
  if (!model) {
    return undefined;
  }

  const limit = readModelsDevLimit(model);
  const price = resolveModelsDevPrice(matches);
  const modelKey = pickModelsDevDescriptionModelKey(globalMatch?.modelKey, readMatchedModelKey(bestMatch), modelName);
  const description = buildModelsDevDescription(
    model,
    modelKey,
  );
  const apiStyle = inferDefaultApiStyleForModel(modelName, model, modelKey);
  const tools = readModelsDevBooleanCapability(model, matches, 'tool_call');
  const reasoning = readModelsDevBooleanCapability(model, matches, 'reasoning');
  const vision = readsImageInputFromModels(model, matches);
  const capabilities =
    tools !== undefined || vision !== undefined || reasoning !== undefined
      ? {
          ...(tools === undefined ? {} : { tools }),
          ...(vision === undefined ? {} : { vision }),
          ...(reasoning === undefined ? {} : { thinking: reasoning }),
        }
      : undefined;

  const normalized: Partial<VendorModelConfig> = {
    ...(limit.contextSize === undefined ? {} : { contextSize: limit.contextSize }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(price === undefined ? {} : { price }),
    ...(description === undefined ? {} : { description }),
    apiStyle,
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function isGrokModel(modelName: string, model?: ModelsDevModel, modelKey?: string): boolean {
  const suffix = normalizeComparableText(readModelSuffix(modelName));
  if (suffix.startsWith('grok')) {
    return true;
  }

  const lab = model ? readModelsDevLab(model, modelKey) : readModelProviderPrefix(modelName);
  if (normalizeComparableText(lab ?? '') === 'xai') {
    return true;
  }

  const family = readNonEmptyString(model?.family);
  return family !== undefined && normalizeComparableText(family).startsWith('grok');
}

export function inferDefaultApiStyleForModel(
  modelName: string,
  model?: ModelsDevModel,
  modelKey?: string,
): VendorApiStyle {
  const lab = model ? readModelsDevLab(model, modelKey) : readModelProviderPrefix(modelName);
  const normalizedLab = normalizeComparableText(lab ?? '');
  if (normalizedLab === 'openai') {
    return 'openai-responses';
  }
  if (normalizedLab === 'anthropic') {
    return 'anthropic';
  }
  if (isGrokModel(modelName, model, modelKey)) {
    return 'openai-responses';
  }

  return 'openai-chat';
}

function resolveModelsDevModelMatches(
  catalog: ModelsDevCatalog | undefined,
  modelName: string,
): ModelsDevModelMatch[] {
  if (!catalog) {
    return [];
  }

  const matches: ModelsDevModelMatch[] = [];
  for (const [providerKey, provider] of Object.entries(catalog.providers)) {
    const entry = resolveModelsDevModelEntry(provider, modelName);
    if (!entry) {
      continue;
    }

    matches.push({
      providerKey,
      provider,
      model: entry.model,
      score: entry.score,
    });
  }

  return matches;
}

function normalizeModelsDevModels(rawModels: Record<string, unknown> | undefined): Record<string, ModelsDevModel> | undefined {
  if (!rawModels) {
    return undefined;
  }

  const models: Record<string, ModelsDevModel> = {};
  for (const [modelId, rawModel] of Object.entries(rawModels)) {
    if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
      continue;
    }
    models[modelId] = rawModel as ModelsDevModel;
  }

  return Object.keys(models).length > 0 ? models : undefined;
}

interface ModelsDevModelMatch {
  providerKey: string;
  provider: ModelsDevProvider;
  model: ModelsDevModel;
  score: number;
}

interface ModelsDevGlobalModelMatch {
  modelKey: string;
  model: ModelsDevModel;
  score: number;
}

function resolveModelsDevGlobalModel(
  catalog: ModelsDevCatalog | undefined,
  modelName: string,
): ModelsDevGlobalModelMatch | undefined {
  if (!catalog) {
    return undefined;
  }

  return resolveModelsDevModelFromRecord(catalog.models, modelName);
}

function pickBestModelsDevModelMatch(matches: readonly ModelsDevModelMatch[]): ModelsDevModelMatch | undefined {
  let best: { match: ModelsDevModelMatch; score: number } | undefined;
  for (const match of matches) {
    const score = match.score;
    if (!best || score > best.score) {
      best = { match, score };
    }
  }

  return best?.match;
}

function resolveModelsDevModelEntry(
  provider: ModelsDevProvider,
  modelName: string,
): { model: ModelsDevModel; score: number } | undefined {
  const match = resolveModelsDevModelFromRecord(provider.models, modelName);
  return match ? { model: match.model, score: match.score } : undefined;
}

function resolveModelsDevModelFromRecord(
  models: Record<string, ModelsDevModel>,
  modelName: string,
): ModelsDevGlobalModelMatch | undefined {
  const normalizedName = normalizeModelLookupText(modelName);
  if (normalizedName.length === 0) {
    return undefined;
  }

  const exact = models[modelName] ?? models[normalizedName];
  if (exact) {
    return { modelKey: modelName, model: exact, score: 100 };
  }

  const comparableName = normalizeComparableText(normalizedName);
  const suffixName = normalizeComparableText(readModelSuffix(normalizedName));
  let best: ModelsDevGlobalModelMatch | undefined;
  for (const [modelKey, model] of Object.entries(models)) {
    const candidates = [
      modelKey,
      model.id ?? '',
      model.name ?? '',
      readModelSuffix(modelKey),
      typeof model.id === 'string' ? readModelSuffix(model.id) : '',
    ];
    const rawCandidates = candidates.map((candidate) => normalizeModelLookupText(candidate)).filter((candidate) => candidate.length > 0);
    let score = 0;
    if (rawCandidates.some((candidate) => candidate === normalizedName)) {
      score = 100;
    } else if (candidates.some((candidate) => normalizeComparableText(candidate) === comparableName)) {
      score = 90;
    } else if (suffixName.length > 0 && candidates.some((candidate) => normalizeComparableText(candidate) === suffixName)) {
      score = 80;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { modelKey, model, score };
    }
  }

  return best;
}

function readModelProviderPrefix(modelName: string): string | undefined {
  const normalized = normalizeModelLookupText(modelName);
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) {
    return undefined;
  }

  const prefix = normalizeComparableText(normalized.slice(0, slashIndex));
  return prefix.length > 0 ? prefix : undefined;
}

function readModelsDevLimit(model: ModelsDevModel): {
  contextSize?: number;
} {
  const contextSize = readPositiveInteger(model.limit?.context);
  return {
    contextSize,
  };
}

function buildModelsDevDescription(model: ModelsDevModel, modelKey: string | undefined): string | undefined {
  const modelId = readNonEmptyString(model.id) ?? modelKey ?? '';
  const lab = readModelsDevLab(model, modelKey) ?? '';
  const family = readNonEmptyString(model.family) ?? '';
  const weights = typeof model.open_weights === 'boolean' ? (model.open_weights ? 'Open' : 'Closed') : '';
  const releaseDate = readNonEmptyString(model.release_date) ?? '';
  const parts = [modelId, lab, family, weights, releaseDate];
  return parts.some((part) => part.length > 0) ? parts.join(' | ') : undefined;
}

function pickModelsDevDescriptionModelKey(...keys: Array<string | undefined>): string | undefined {
  const normalizedKeys = keys.map((key) => readNonEmptyString(key)).filter((key): key is string => key !== undefined);
  return normalizedKeys.find((key) => normalizeModelLookupText(key).includes('/')) ?? normalizedKeys[0];
}

function readModelsDevLab(model: ModelsDevModel, modelKey: string | undefined): string | undefined {
  for (const candidate of [modelKey, readNonEmptyString(model.id)]) {
    if (!candidate) {
      continue;
    }

    const normalized = normalizeModelLookupText(candidate);
    const slashIndex = normalized.indexOf('/');
    if (slashIndex <= 0) {
      continue;
    }

    const lab = normalized.slice(0, slashIndex);
    if (lab.length > 0) {
      return lab;
    }
  }

  return undefined;
}

function readMatchedModelKey(match: ModelsDevModelMatch | undefined): string | undefined {
  if (!match) {
    return undefined;
  }
  for (const [modelKey, model] of Object.entries(match.provider.models)) {
    if (model === match.model) {
      return modelKey;
    }
  }
  return undefined;
}

function readModelsDevBooleanCapability(
  model: ModelsDevModel,
  matches: readonly ModelsDevModelMatch[],
  key: 'reasoning' | 'tool_call' | 'temperature',
): boolean | undefined {
  const values = [
    model[key],
    ...matches.map((match) => match.model[key]),
  ].filter((value): value is boolean => typeof value === 'boolean');
  if (values.some((value) => value)) {
    return true;
  }
  if (values.length > 0) {
    return false;
  }

  return undefined;
}

function readsImageInputFromModels(model: ModelsDevModel, matches: readonly ModelsDevModelMatch[]): boolean | undefined {
  const modelImageInput = readsImageInput(model);
  if (modelImageInput !== undefined) {
    return modelImageInput;
  }

  const values = [
    ...matches.map((match) => readsImageInput(match.model)),
  ].filter((value): value is boolean => typeof value === 'boolean');
  if (values.some((value) => value)) {
    return true;
  }
  if (values.length > 0) {
    return false;
  }

  return undefined;
}

function readModelsDevPrice(model: ModelsDevModel): VendorModelConfig['price'] {
  const cost = model.cost;
  if (!cost || typeof cost !== 'object') {
    return undefined;
  }

  const price: NonNullable<VendorModelConfig['price']> = {};
  const inputCost = readNonNegativeNumber(cost.input);
  const cacheCost = readNonNegativeNumber(cost.cache_read);
  const outputCost = readNonNegativeNumber(cost.output);
  const longContextCost =
    cost.context_over_200k && typeof cost.context_over_200k === 'object'
      ? (cost.context_over_200k as Record<string, unknown>)
      : undefined;
  const longContextInputCost = readNonNegativeNumber(longContextCost?.input);
  const longContextCacheCost = readNonNegativeNumber(longContextCost?.cache_read);
  const longContextOutputCost = readNonNegativeNumber(longContextCost?.output);

  if (inputCost !== undefined) {
    price.inputCost = inputCost;
  }
  if (cacheCost !== undefined) {
    price.cacheCost = cacheCost;
  }
  if (outputCost !== undefined) {
    price.outputCost = outputCost;
  }
  if (longContextInputCost !== undefined) {
    price.longContextInputCost = longContextInputCost;
  }
  if (longContextCacheCost !== undefined) {
    price.longContextCacheCost = longContextCacheCost;
  }
  if (longContextOutputCost !== undefined) {
    price.longContextOutputCost = longContextOutputCost;
  }

  return Object.keys(price).length > 0 ? price : undefined;
}

function resolveModelsDevPrice(matches: readonly ModelsDevModelMatch[]): VendorModelConfig['price'] {
  return readMedianModelsDevPrice(matches);
}

function readMedianModelsDevPrice(matches: readonly ModelsDevModelMatch[]): VendorModelConfig['price'] {
  const prices = matches.map((match) => readModelsDevPrice(match.model)).filter((price): price is NonNullable<VendorModelConfig['price']> => price !== undefined);
  if (prices.length === 0) {
    return undefined;
  }

  const medianPrice: NonNullable<VendorModelConfig['price']> = {};
  const priceKeys = [
    'inputCost',
    'cacheCost',
    'outputCost',
    'longContextInputCost',
    'longContextCacheCost',
    'longContextOutputCost',
  ] as const;

  for (const key of priceKeys) {
    const median = readMedian(prices.map((price) => price[key]).filter((value): value is number => value !== undefined));
    if (median !== undefined) {
      medianPrice[key] = median;
    }
  }

  return Object.keys(medianPrice).length > 0 ? medianPrice : undefined;
}

function readMedian(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return roundPriceNumber((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function roundPriceNumber(value: number): number {
  return Number(value.toFixed(12));
}

function readsImageInput(model: ModelsDevModel): boolean | undefined {
  const input = model.modalities?.input;
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === 'image');
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readPositiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function readPositiveNumber(value: unknown): number | undefined {
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

function readNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeModelLookupText(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const slashIndex = normalized.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : '';
  const suffix = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const colonIndex = suffix.indexOf(':');
  return colonIndex >= 0 ? `${prefix}${suffix.slice(0, colonIndex)}` : normalized;
}

function readModelSuffix(value: string): string {
  const normalized = normalizeModelLookupText(value);
  const parts = normalized.split('/').filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : normalized;
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
