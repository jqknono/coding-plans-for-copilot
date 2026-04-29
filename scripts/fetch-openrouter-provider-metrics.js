#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const OUTPUT_FILE = path.resolve(__dirname, "..", "assets", "openrouter-provider-metrics.json");
const ENV_FILE = path.resolve(__dirname, "..", ".env");
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || "20000", 10);
const ENDPOINT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OPENROUTER_ENDPOINT_CONCURRENCY || "4", 10));
const ENDPOINT_REQUEST_RETRY_COUNT = 2;
const ENDPOINT_REQUEST_RETRY_DELAY_MS = 750;
const DEFAULT_ORGANIZATIONS = [
  "deepseek",
  "qwen",
  "moonshotai",
  "z-ai",
  "minimax",
  "bytedance",
  "bytedance-seed",
  "kwaipilot",
  "meituan",
  "mistralai",
  "stepfun",
];
const DEFAULT_MODELS_PER_ORG = 5;
const DEFAULT_MODEL_MAX_AGE_DAYS = 180;

function parseDotEnv(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function loadEnvFileIfPresent() {
  try {
    const text = await fs.readFile(ENV_FILE, "utf8");
    const parsed = parseDotEnv(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function readOrganizations() {
  const raw = String(process.env.OPENROUTER_MODEL_ORGS || "").trim();
  if (!raw) {
    return [...DEFAULT_ORGANIZATIONS];
  }
  const normalized = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  return normalized.length > 0 ? normalized : [...DEFAULT_ORGANIZATIONS];
}

function readModelLimit() {
  const raw = Number.parseInt(process.env.OPENROUTER_MODEL_LIMIT || String(DEFAULT_MODELS_PER_ORG), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MODELS_PER_ORG;
  }
  return raw;
}

function readModelMaxAgeDays() {
  const raw = Number.parseInt(process.env.OPENROUTER_MODEL_MAX_AGE_DAYS || String(DEFAULT_MODEL_MAX_AGE_DAYS), 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_MODEL_MAX_AGE_DAYS;
  }
  return raw;
}

function toModelCreatedSeconds(model) {
  const created = Number(model?.created);
  return Number.isFinite(created) ? created : null;
}

function isModelInAgeWindow(model, maxAgeDays, nowSeconds) {
  if (maxAgeDays <= 0) {
    return true;
  }
  const createdSeconds = toModelCreatedSeconds(model);
  if (!createdSeconds) {
    return false;
  }
  const maxAgeSeconds = maxAgeDays * 24 * 60 * 60;
  return nowSeconds - createdSeconds <= maxAgeSeconds;
}

function parseModelId(modelId) {
  const normalized = String(modelId || "").trim();
  const separatorIndex = normalized.indexOf("/");
  if (!normalized || separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
    return null;
  }
  return {
    author: normalized.slice(0, separatorIndex),
    slug: normalized.slice(separatorIndex + 1),
  };
}

function formatBeijingTime(isoText) {
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function sleep(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readHttpStatusFromError(error) {
  const message = String(error?.message || "");
  const matched = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (!matched) {
    return null;
  }
  const status = Number.parseInt(matched[1], 10);
  return Number.isFinite(status) ? status : null;
}

function isRetryableFetchError(error) {
  const status = readHttpStatusFromError(error);
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  return (
    message.includes("request timeout")
    || message.includes("timed out")
    || code === "ETIMEDOUT"
    || code === "ECONNRESET"
    || code === "UND_ERR_CONNECT_TIMEOUT"
  );
}

async function fetchJson(url, options = {}) {
  const {
    timeoutMs = REQUEST_TIMEOUT_MS,
    retryCount = 0,
    retryDelayMs = 0,
    ...fetchOptions
  } = options;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      const normalizedError = controller.signal.aborted
        ? new Error(`Request timeout after ${timeoutMs}ms`)
        : error;
      const shouldRetry = attempt < retryCount && isRetryableFetchError(normalizedError);
      if (!shouldRetry) {
        throw normalizedError;
      }
      await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Unreachable fetchJson retry state");
}

function sortByCreatedDesc(left, right) {
  const leftCreated = Number(left?.created) || 0;
  const rightCreated = Number(right?.created) || 0;
  if (rightCreated !== leftCreated) {
    return rightCreated - leftCreated;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function uniqueByModelId(models) {
  const seen = new Set();
  const result = [];
  for (const model of models || []) {
    const id = String(model?.id || "").trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(model);
  }
  return result;
}

function buildHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "coding-plans-for-copilot-metrics-fetcher/1.0",
  };
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseProviderSlugFromTag(tag) {
  const raw = String(tag || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const slashIndex = raw.indexOf("/");
  const slug = slashIndex >= 0 ? raw.slice(0, slashIndex) : raw;
  return slug || null;
}

function normalizeProviderEndpoint(endpoint) {
  const providerName = String(endpoint?.provider_name || "").trim() || String(endpoint?.name || "").trim();
  const tag = String(endpoint?.tag || "").trim() || null;
  const providerSlug = parseProviderSlugFromTag(tag);
  if (!providerName && !providerSlug) {
    return null;
  }
  return {
    providerName: providerName || providerSlug || "--",
    providerSlug,
    tag,
    quantization: endpoint?.quantization || null,
    status: toFiniteNumberOrNull(endpoint?.status),
    uptime_last_30m: toFiniteNumberOrNull(endpoint?.uptime_last_30m),
    latency_last_30m: endpoint?.latency_last_30m || null,
    throughput_last_30m: endpoint?.throughput_last_30m || null,
    context_length: toFiniteNumberOrNull(endpoint?.context_length),
    max_completion_tokens: toFiniteNumberOrNull(endpoint?.max_completion_tokens),
  };
}

function readMetricP50(metric) {
  return toFiniteNumberOrNull(metric?.p50);
}

function hasPercentileStats(metric) {
  if (!metric || typeof metric !== "object") {
    return false;
  }
  return ["p50", "p75", "p90", "p99"].every((key) => toFiniteNumberOrNull(metric[key]) !== null);
}

function getMetricsValidationErrors(output) {
  const errors = [];
  const models = Array.isArray(output?.models) ? output.models : [];
  const failures = Array.isArray(output?.failures) ? output.failures : [];
  const endpoints = models.flatMap((model) => (Array.isArray(model?.endpoints) ? model.endpoints : []));
  const latencyCount = endpoints.filter((endpoint) => hasPercentileStats(endpoint?.latency_last_30m)).length;
  const throughputCount = endpoints.filter((endpoint) => hasPercentileStats(endpoint?.throughput_last_30m)).length;
  const uptimeCount = endpoints.filter((endpoint) => (
    toFiniteNumberOrNull(endpoint?.uptime_last_5m) !== null
    || toFiniteNumberOrNull(endpoint?.uptime_last_30m) !== null
    || toFiniteNumberOrNull(endpoint?.uptime_last_1d) !== null
  )).length;

  if (models.length === 0) {
    errors.push("No OpenRouter models matched the configured organization and age filters.");
  }
  if (endpoints.length === 0) {
    errors.push("No OpenRouter provider endpoints were fetched.");
  }
  if (failures.length > 0) {
    const preview = failures.slice(0, 5).join("; ");
    errors.push(`OpenRouter endpoint fetch failures: ${failures.length}${preview ? ` (${preview})` : ""}`);
  }
  if (endpoints.length > 0 && uptimeCount === 0) {
    errors.push("OpenRouter provider availability metrics are empty for every endpoint.");
  }
  if (endpoints.length > 0 && latencyCount === 0) {
    errors.push("OpenRouter provider latency metrics are empty for every endpoint. Check that CODING_PLANS_FOR_COPILOT is an API key allowed to view endpoint performance metrics.");
  }
  if (endpoints.length > 0 && throughputCount === 0) {
    errors.push("OpenRouter provider throughput metrics are empty for every endpoint. Check that CODING_PLANS_FOR_COPILOT is an API key allowed to view endpoint performance metrics.");
  }

  return errors;
}

async function writeJsonFileAtomically(filePath, data) {
  const directory = path.dirname(filePath);
  const temporaryFile = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(temporaryFile, filePath);
  } catch (error) {
    try {
      await fs.unlink(temporaryFile);
    } catch (unlinkError) {
      if (!unlinkError || unlinkError.code !== "ENOENT") {
        // Preserve the original write failure; cleanup failure is secondary.
      }
    }
    throw error;
  }
}

function compareEndpointQuality(left, right) {
  const leftStatusPenalty = left?.status === 0 ? 0 : 1;
  const rightStatusPenalty = right?.status === 0 ? 0 : 1;
  if (leftStatusPenalty !== rightStatusPenalty) {
    return leftStatusPenalty - rightStatusPenalty;
  }

  const leftUptime = toFiniteNumberOrNull(left?.uptime_last_30m) ?? -1;
  const rightUptime = toFiniteNumberOrNull(right?.uptime_last_30m) ?? -1;
  if (leftUptime !== rightUptime) {
    return rightUptime - leftUptime;
  }

  const leftLatency = readMetricP50(left?.latency_last_30m);
  const rightLatency = readMetricP50(right?.latency_last_30m);
  if (leftLatency !== null || rightLatency !== null) {
    if (leftLatency === null) {
      return 1;
    }
    if (rightLatency === null) {
      return -1;
    }
    if (leftLatency !== rightLatency) {
      return leftLatency - rightLatency;
    }
  }

  const leftThroughput = readMetricP50(left?.throughput_last_30m);
  const rightThroughput = readMetricP50(right?.throughput_last_30m);
  if (leftThroughput !== null || rightThroughput !== null) {
    if (leftThroughput === null) {
      return 1;
    }
    if (rightThroughput === null) {
      return -1;
    }
    if (leftThroughput !== rightThroughput) {
      return rightThroughput - leftThroughput;
    }
  }

  return String(left?.tag || "").localeCompare(String(right?.tag || ""));
}

function keepBestEndpointPerProvider(endpoints) {
  const bestByProvider = new Map();
  for (const endpoint of endpoints || []) {
    const providerSlug = String(endpoint?.providerSlug || "").trim().toLowerCase();
    const providerName = String(endpoint?.providerName || "").trim();
    const providerKey = providerSlug || providerName.toLowerCase();
    if (!providerKey) {
      continue;
    }
    const current = bestByProvider.get(providerKey);
    if (!current || compareEndpointQuality(endpoint, current) < 0) {
      bestByProvider.set(providerKey, endpoint);
    }
  }
  return [...bestByProvider.values()].sort((left, right) => {
    const leftName = String(left?.providerName || "");
    const rightName = String(right?.providerName || "");
    const byName = leftName.localeCompare(rightName);
    if (byName !== 0) {
      return byName;
    }
    return String(left?.providerSlug || "").localeCompare(String(right?.providerSlug || ""));
  });
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function runWorker() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= values.length) {
        return;
      }
      results[current] = await mapper(values[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

async function main() {
  await loadEnvFileIfPresent();

  const apiKey = String(process.env.CODING_PLANS_FOR_COPILOT || "").trim();
  if (!apiKey) {
    throw new Error("Missing environment variable CODING_PLANS_FOR_COPILOT");
  }

  const organizations = readOrganizations();
  const modelsPerOrganization = readModelLimit();
  const modelMaxAgeDays = readModelMaxAgeDays();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const headers = buildHeaders(apiKey);
  const failures = [];

  const allModelsPayload = await fetchJson(`${OPENROUTER_BASE_URL}/models`, { headers });
  const allModelsRaw = Array.isArray(allModelsPayload?.data) ? allModelsPayload.data : [];
  const allModels = uniqueByModelId(allModelsRaw);

  const selectedModels = [];
  for (const organization of organizations) {
    const orgModels = allModels
      .filter((model) => String(model?.id || "").toLowerCase().startsWith(`${organization}/`))
      .filter((model) => isModelInAgeWindow(model, modelMaxAgeDays, nowSeconds))
      .sort(sortByCreatedDesc)
      .slice(0, modelsPerOrganization);
    for (const model of orgModels) {
      selectedModels.push({
        organization,
        id: String(model?.id || ""),
        name: String(model?.name || model?.id || ""),
        created: Number.isFinite(Number(model?.created)) ? Number(model.created) : null,
      });
    }
  }

  const modelEntries = await mapWithConcurrency(selectedModels, ENDPOINT_CONCURRENCY, async (model) => {
    const parsed = parseModelId(model.id);
    if (!parsed) {
      const failure = `${model.id}: invalid model id`;
      failures.push(failure);
      return {
        ...model,
        createdAt: null,
        endpoints: [],
        providerCount: 0,
      };
    }

    const endpointUrl = `${OPENROUTER_BASE_URL}/models/${encodeURIComponent(parsed.author)}/${encodeURIComponent(parsed.slug)}/endpoints`;
    try {
      const payload = await fetchJson(endpointUrl, {
        headers,
        retryCount: ENDPOINT_REQUEST_RETRY_COUNT,
        retryDelayMs: ENDPOINT_REQUEST_RETRY_DELAY_MS,
      });
      const endpointList = Array.isArray(payload?.data?.endpoints) ? payload.data.endpoints : [];
      const normalized = keepBestEndpointPerProvider(endpointList
        .map((entry) => normalizeProviderEndpoint(entry))
        .filter(Boolean));

      return {
        ...model,
        createdAt: model.created ? new Date(model.created * 1000).toISOString() : null,
        endpoints: normalized,
        providerCount: normalized.length,
      };
    } catch (error) {
      const message = error?.message || String(error || "unknown error");
      failures.push(`${model.id}: ${message}`);
      return {
        ...model,
        createdAt: model.created ? new Date(model.created * 1000).toISOString() : null,
        endpoints: [],
        providerCount: 0,
      };
    }
  });

  const endpointCount = modelEntries.reduce((total, model) => total + model.providerCount, 0);
  const generatedAt = new Date().toISOString();
  const cutoffSeconds = modelMaxAgeDays > 0 ? nowSeconds - modelMaxAgeDays * 24 * 60 * 60 : null;
  const output = {
    generatedAt,
    generatedAtBeijing: formatBeijingTime(generatedAt),
    captureWindow: {
      timezone: "Asia/Shanghai",
      targetLocalTime: "16:00",
      note: "Data should be refreshed daily at 16:00 Beijing time.",
    },
    config: {
      organizations,
      modelsPerOrganization,
      modelMaxAgeDays,
      modelCreatedAfter: cutoffSeconds ? new Date(cutoffSeconds * 1000).toISOString() : null,
      endpointConcurrency: ENDPOINT_CONCURRENCY,
      baseUrl: OPENROUTER_BASE_URL,
    },
    summary: {
      organizationCount: organizations.length,
      modelCount: modelEntries.length,
      providerEndpointCount: endpointCount,
    },
    models: modelEntries,
    failures,
  };

  const validationErrors = getMetricsValidationErrors(output);
  if (validationErrors.length > 0) {
    throw new Error(`OpenRouter provider metrics validation failed: ${validationErrors.join(" | ")}`);
  }

  await writeJsonFileAtomically(OUTPUT_FILE, output);

  console.log(`[metrics] wrote ${OUTPUT_FILE}`);
  console.log(`[metrics] organizations=${organizations.length} models=${modelEntries.length} providers=${endpointCount}`);
}

function printHelp() {
  console.log("Usage: node scripts/fetch-openrouter-provider-metrics.js [-h|--help]");
  console.log("");
  console.log("Fetches OpenRouter provider endpoint metrics into assets/openrouter-provider-metrics.json.");
  console.log("The output file is updated only after endpoint fetches and performance metrics pass validation.");
  console.log("");
  console.log("Environment variables:");
  console.log("  CODING_PLANS_FOR_COPILOT         OpenRouter API key");
  console.log(`  OPENROUTER_BASE_URL              API base URL (default: ${OPENROUTER_BASE_URL})`);
  console.log(`  OPENROUTER_REQUEST_TIMEOUT_MS    Per-request timeout in ms (default: ${REQUEST_TIMEOUT_MS})`);
  console.log(`  OPENROUTER_ENDPOINT_CONCURRENCY  Concurrent endpoint fetches (default: ${ENDPOINT_CONCURRENCY})`);
}

if (require.main === module) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  main().catch((error) => {
    console.error("[metrics] fatal:", error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  fetchJson,
  getMetricsValidationErrors,
  hasPercentileStats,
  isRetryableFetchError,
};
