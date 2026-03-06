#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const OUTPUT_FILE = path.resolve(__dirname, "..", "assets", "openrouter-provider-metrics.json");
const ENV_FILE = path.resolve(__dirname, "..", ".env");
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || "20000", 10);
const ENDPOINT_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OPENROUTER_ENDPOINT_CONCURRENCY || "4", 10));
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

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function normalizeProviderEndpoint(endpoint) {
  const providerName = String(endpoint?.provider_name || "").trim() || String(endpoint?.name || "").trim();
  if (!providerName) {
    return null;
  }
  return {
    providerName,
    tag: endpoint?.tag || null,
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
    const providerName = String(endpoint?.providerName || "").trim();
    if (!providerName) {
      continue;
    }
    const current = bestByProvider.get(providerName);
    if (!current || compareEndpointQuality(endpoint, current) < 0) {
      bestByProvider.set(providerName, endpoint);
    }
  }
  return [...bestByProvider.values()].sort((left, right) => left.providerName.localeCompare(right.providerName));
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
      const payload = await fetchJson(endpointUrl, { headers });
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

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`[metrics] wrote ${OUTPUT_FILE}`);
  console.log(`[metrics] organizations=${organizations.length} models=${modelEntries.length} providers=${endpointCount}`);
  if (failures.length > 0) {
    console.log(`[metrics] failures=${failures.length}`);
  }
}

main().catch((error) => {
  console.error("[metrics] fatal:", error && error.message ? error.message : error);
  process.exit(1);
});
