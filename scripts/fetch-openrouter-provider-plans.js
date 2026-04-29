#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const OUTPUT_FILE = path.resolve(__dirname, "..", "assets", "openrouter-provider-plans.json");
const PRICING_SOURCE_FILE = path.resolve(__dirname, "..", "assets", "provider-pricing.json");
const METRICS_SOURCE_FILE = path.resolve(__dirname, "..", "assets", "openrouter-provider-metrics.json");
const ENV_FILE = path.resolve(__dirname, "..", ".env");
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || "20000", 10);
const PRICING_PROBE_TIMEOUT_MS = Number.parseInt(process.env.OPENROUTER_PRICING_PROBE_TIMEOUT_MS || "9000", 10);
const PRICING_PROBE_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OPENROUTER_PRICING_PROBE_CONCURRENCY || "4", 10));
const PRICING_PROBE_MAX_CANDIDATES = Math.max(
  1,
  Number.parseInt(process.env.OPENROUTER_PRICING_PROBE_MAX_CANDIDATES || "6", 10),
);
const PRICING_BUNDLE_PROBE_ENABLED = String(process.env.OPENROUTER_PRICING_BUNDLE_PROBE_ENABLED || "1").trim() !== "0";
const PRICING_BUNDLE_PROBE_MAX_FILES = Math.max(
  1,
  Number.parseInt(process.env.OPENROUTER_PRICING_BUNDLE_PROBE_MAX_FILES || "80", 10),
);

const HEURISTIC_MIN_SUBSCRIPTION_PRICE = 3;
const HEURISTIC_MAX_SUBSCRIPTION_PRICE = 10000;

// OpenRouter provider slug => provider-pricing.json provider id
const OPENROUTER_TO_PRICING_PROVIDER = {
  moonshotai: "kimi-ai",
  minimax: "minimax-ai",
  streamlake: "kwaikat-ai",
  alibaba: "aliyun-ai",
  seed: "volcengine-ai",
  baidu: "baidu-qianfan-ai",
  qianfan: "baidu-qianfan-ai",
  tencent: "tencent-cloud-ai",
  hunyuan: "tencent-cloud-ai",
};

// Extra fallback when OpenRouter policy/status links are missing.
const OFFICIAL_WEBSITE_OVERRIDES = {
  "io-net": "https://io.net",
  ionstream: "https://ionstream.ai",
  venice: "https://venice.ai",
  "z-ai": "https://z.ai",
};

// Provider-specific pricing pages that should be probed first.
const PRICING_PAGE_OVERRIDES = {
  cloudflare: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  mistral: "https://mistral.ai/pricing",
  venice: "https://venice.ai/pricing",
  chutes: "https://chutes.ai/pricing",
  "z-ai": "https://z.ai/subscribe",
};

const PROVIDER_PENDING_OVERRIDES = {
  gmicloud: "仅提供 GPU 云计算按时计费（$/GPU-hour），无套餐订阅",
  "google-vertex": "云平台按量计费 + $300 免费试用额度，无套餐订阅",
};

const PRICING_PATH_CANDIDATES = [
  "/pricing",
  "/prices",
  "/plans",
  "/plan",
  "/billing",
  "/subscription",
  "/subscriptions",
  "/api-pricing",
];

const HTML_HEADERS = {
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
};

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

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function parseProviderSlugFromTag(tag) {
  const raw = normalizeSlug(tag);
  if (!raw) {
    return null;
  }
  const slashIndex = raw.indexOf("/");
  const slug = slashIndex >= 0 ? raw.slice(0, slashIndex) : raw;
  return slug || null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function loadPlaywrightChromium(label) {
  let chromium;
  try {
    ({ chromium } = require("@playwright/test"));
  } catch {
    throw new Error(`Playwright is unavailable for ${label}`);
  }
  return chromium;
}

async function blockNonEssentialPlaywrightRequests(page) {
  await page.route("**/*", (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();
    if (["image", "font", "media"].includes(resourceType)) {
      return route.abort();
    }
    if (/google-analytics|googletagmanager|hm\.baidu|sentry|adjust|twitter|qiyukf|datasink/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
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

async function fetchText(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      redirect: "follow",
      headers: options.headers || HTML_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return {
      url: response.url || url,
      text,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
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

function isAccessBlockedMessage(message) {
  const text = String(message || "").toLowerCase();
  if (!text) {
    return false;
  }
  return [
    "403",
    "429",
    "forbidden",
    "access denied",
    "blocked",
    "captcha",
    "cloudflare",
    "timeout",
    "timed out",
    "request aborted",
  ].some((keyword) => text.includes(keyword));
}

function extractFailureReasonByProvider(failures, providerId) {
  const entry = (failures || []).find((item) => String(item || "").startsWith(`${providerId}:`));
  if (!entry) {
    return null;
  }
  const [_, ...rest] = String(entry).split(":");
  return rest.join(":").trim() || String(entry);
}

function getMetricsProviders(metricsData) {
  const models = Array.isArray(metricsData?.models) ? metricsData.models : [];
  const providers = [];
  const seen = new Set();
  for (const model of models) {
    const endpoints = Array.isArray(model?.endpoints) ? model.endpoints : [];
    for (const endpoint of endpoints) {
      const name = String(endpoint?.providerName || "").trim();
      const slug = normalizeSlug(endpoint?.providerSlug) || parseProviderSlugFromTag(endpoint?.tag);
      const key = slug ? `slug:${slug}` : `name:${normalizeName(name)}`;
      if (!name && !slug) {
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      providers.push({
        name,
        slug: slug || null,
      });
    }
  }
  return providers.sort((left, right) => {
    const leftName = left.name || left.slug || "";
    const rightName = right.name || right.slug || "";
    return leftName.localeCompare(rightName);
  });
}

function resolveOpenrouterProvider(metricsProvider, providersByName, providersBySlug) {
  const byProviderSlug = providersBySlug.get(normalizeSlug(metricsProvider?.slug));
  if (byProviderSlug) {
    return byProviderSlug;
  }
  const byName = providersByName.get(normalizeName(metricsProvider?.name));
  if (byName) {
    return byName;
  }
  const bySlug = providersBySlug.get(normalizeSlug(metricsProvider?.name));
  if (bySlug) {
    return bySlug;
  }
  return null;
}

function toOrigin(urlText) {
  try {
    return new URL(String(urlText)).origin;
  } catch {
    return null;
  }
}

function inferOfficialWebsite(openrouterProvider) {
  const slug = String(openrouterProvider?.slug || "").trim();
  if (slug && OFFICIAL_WEBSITE_OVERRIDES[slug]) {
    return {
      officialWebsiteUrl: OFFICIAL_WEBSITE_OVERRIDES[slug],
      source: "override",
    };
  }

  const termsOrigin = toOrigin(openrouterProvider?.terms_of_service_url);
  if (termsOrigin) {
    return {
      officialWebsiteUrl: termsOrigin,
      source: "terms_of_service_url",
    };
  }
  const privacyOrigin = toOrigin(openrouterProvider?.privacy_policy_url);
  if (privacyOrigin) {
    return {
      officialWebsiteUrl: privacyOrigin,
      source: "privacy_policy_url",
    };
  }
  const statusOrigin = toOrigin(openrouterProvider?.status_page_url);
  if (statusOrigin) {
    return {
      officialWebsiteUrl: statusOrigin,
      source: "status_page_url",
    };
  }
  return {
    officialWebsiteUrl: null,
    source: "unavailable",
  };
}

function absoluteUrl(urlText, baseUrl) {
  try {
    return new URL(urlText, baseUrl).toString();
  } catch {
    return null;
  }
}

function isSameOrSubdomain(urlText, baseUrl) {
  try {
    const candidateHost = new URL(urlText).hostname.toLowerCase();
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    return candidateHost === baseHost || candidateHost.endsWith(`.${baseHost}`);
  } catch {
    return false;
  }
}

function compactText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtmlTags(value) {
  return compactText(String(value || "").replace(/<[^>]+>/g, " "));
}

function extractTitle(htmlText) {
  const matched = String(htmlText || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!matched) {
    return null;
  }
  return compactText(matched[1]) || null;
}

function extractPricingLinks(htmlText, baseUrl) {
  const links = [];
  const matches = String(htmlText || "").matchAll(/href\s*=\s*["']([^"']+)["']/gi);
  for (const match of matches) {
    const href = String(match[1] || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      continue;
    }
    const absolute = absoluteUrl(href, baseUrl);
    if (!absolute) {
      continue;
    }
    if (!/(pricing|price|plan|billing|subscription|subscribe|套餐|定价|cost)/i.test(absolute)) {
      continue;
    }
    links.push(absolute);
  }
  return unique(links);
}

function extractRuntimeJsEntryUrls(htmlText, baseUrl) {
  const urls = [];
  const text = String(htmlText || "");
  const importMatches = text.matchAll(/import\(\s*["']([^"']+\.js(?:\?[^"']*)?)["']\s*\)/gi);
  for (const match of importMatches) {
    const absolute = absoluteUrl(match[1], baseUrl);
    if (absolute) {
      urls.push(absolute);
    }
  }

  const scriptMatches = text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+\.js(?:\?[^"']*)?)["']/gi);
  for (const match of scriptMatches) {
    const absolute = absoluteUrl(match[1], baseUrl);
    if (absolute) {
      urls.push(absolute);
    }
  }
  return unique(urls);
}

function extractModuleJsUrls(jsText, baseUrl) {
  const urls = [];
  const text = String(jsText || "");
  const importMatches = text.matchAll(/(?:import\(\s*|from\s*)["']([^"']+\.js(?:\?[^"']*)?)["']/gi);
  for (const match of importMatches) {
    const absolute = absoluteUrl(match[1], baseUrl);
    if (absolute) {
      urls.push(absolute);
    }
  }
  return unique(urls);
}

function extractViteMapDepUrls(jsText, baseUrl, limit = Number.POSITIVE_INFINITY) {
  const urls = [];
  const text = String(jsText || "");
  const depMatches = text.matchAll(/["'](\.\.\/(?:nodes|chunks)\/[A-Za-z0-9._-]+\.js)["']/g);
  for (const match of depMatches) {
    const absolute = absoluteUrl(match[1], baseUrl);
    if (absolute) {
      urls.push(absolute);
    }
    if (urls.length >= limit) {
      break;
    }
  }
  return unique(urls);
}

function extractTierPlansFromScript(jsText) {
  const text = String(jsText || "");
  const plans = [];
  const matched = text.matchAll(/id:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*,\s*price:\s*(null|[0-9]+(?:\.[0-9]+)?)/gi);
  for (const match of matched) {
    const id = String(match[1] || "").trim().toLowerCase();
    const name = String(match[2] || "").trim();
    const rawPrice = String(match[3] || "").trim().toLowerCase();
    const isTierName = /^(free|basic|starter|base|plus|pro|team|business|premium|enterprise)$/.test(id)
      || /^(free|basic|starter|base|plus|pro|team|business|premium|enterprise)$/i.test(name);
    if (!isTierName) {
      continue;
    }
    const price = rawPrice === "null" ? null : Number.parseFloat(rawPrice);
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 100000)) {
      continue;
    }
    plans.push({
      id,
      name,
      price,
    });
  }

  const deduped = [];
  const keys = new Set();
  for (const item of plans) {
    const key = `${item.id}|${item.name}|${item.price === null ? "null" : item.price}`;
    if (keys.has(key)) {
      continue;
    }
    keys.add(key);
    deduped.push(item);
  }
  return deduped;
}

function extractEnrichedTierPlans(jsText) {
  const text = String(jsText || "");
  const tierPattern = /^(free|basic|starter|base|plus|pro|team|business|premium|enterprise)$/i;
  const results = [];
  const seen = new Set();

  const planRegex = /id:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*,\s*price:\s*(null|[0-9]+(?:\.[0-9]+)?)/g;
  let match;
  while ((match = planRegex.exec(text)) !== null) {
    const id = match[1].trim();
    const name = match[2].trim();
    const priceRaw = match[3];
    if (!tierPattern.test(id) && !tierPattern.test(name)) {
      continue;
    }
    const key = `${id}|${name}|${priceRaw}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const price = priceRaw === "null" ? null : Number.parseFloat(priceRaw);
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > 100000)) {
      continue;
    }

    const contextEnd = Math.min(text.length, match.index + match[0].length + 4000);
    const context = text.slice(match.index + match[0].length, contextEnd);
    let features = [];
    const featuresMatch = context.match(/,\s*features:\s*\[((?:[^\]]*?))\]/);
    if (featuresMatch) {
      features = [...featuresMatch[1].matchAll(/"([^"]{3,200})"/g)]
        .map((m) => m[1].trim())
        .filter(Boolean);
    }

    let description = null;
    const descMatch = context.match(/,\s*description:\s*"([^"]{5,200})"/);
    if (descMatch) {
      description = descMatch[1].trim();
    }
    results.push({ id, name, price, features: unique(features), description });
  }
  return results;
}

function normalizePriceToken(rawToken) {
  return String(rawToken || "")
    .replace(/[￥]/g, "¥")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceAmount(token) {
  const matched = String(token || "").match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
  if (!matched) {
    return null;
  }
  const amount = Number(matched[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function parsePriceUnit(token) {
  const text = String(token || "").toLowerCase();
  if (/(?:\/|per)?\s*(month|monthly|mo|月)\b/.test(text)) {
    return "月";
  }
  if (/(?:\/|per)?\s*(year|yearly|yr|annual|annually|年)\b/.test(text)) {
    return "年";
  }
  if (/(?:\/|per)?\s*(day|daily|日)\b/.test(text)) {
    return "日";
  }
  if (/(?:\/|per)?\s*(hour|hourly|hr|h|小时)\b/.test(text)) {
    return "小时";
  }
  return null;
}

function extractPricingTokens(htmlText) {
  const text = compactText(htmlText);
  if (!text) {
    return [];
  }

  const rawMatches = [
    ...text.matchAll(
      /((?:€|US\$|USD|\$|¥)\s*[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:\s*(?:USD|EUR|CNY|RMB|GBP|JPY|AUD|CAD|HKD|SGD))?(?:\s*(?:\/|per)\s*(?:mo|month|monthly|yr|year|yearly|annual|annually|月|年|day|daily|日|hour|hourly|h))?)/gi,
    ),
  ]
    .map((match) => normalizePriceToken(match[1]))
    .filter(Boolean);

  return unique(rawMatches).slice(0, 10);
}

function extractTierNamedPriceTokens(htmlText, requireRecurringSuffix = true) {
  const text = compactText(htmlText);
  if (!text) {
    return [];
  }

  const tiers = "free|basic|starter|base|plus|pro|team|business|premium|enterprise|student|students";
  const recurringSuffix = requireRecurringSuffix
    ? `(?:\\s*(?:\\/|per)\\s*(?:mo|month|monthly|yr|year|yearly|annual|annually|月|年)|\\s*(?:monthly|yearly|annual|annually))`
    : `(?:(?:\\s*(?:\\/|per)\\s*(?:mo|month|monthly|yr|year|yearly|annual|annually|月|年)|\\s*(?:monthly|yearly|annual|annually)))?`;
  const regex = new RegExp(
    `\\b(${tiers})\\b((?:(?!\\b(?:${tiers})\\b)[\\s\\S]){0,120}?)((?:€|US\\$|USD|\\$|¥)\\s*[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?(?:\\s*(?:USD|EUR|CNY|RMB|GBP|JPY|AUD|CAD|HKD|SGD))?${recurringSuffix})`,
    "gi",
  );
  const results = [];
  for (const match of text.matchAll(regex)) {
    const tierName = String(match[1] || "").trim();
    const rawPrice = normalizePriceToken(match[3] || "");
    const amount = parsePriceAmount(rawPrice);
    if (!tierName || !rawPrice || !Number.isFinite(amount)) {
      continue;
    }
    if (amount < HEURISTIC_MIN_SUBSCRIPTION_PRICE || amount > HEURISTIC_MAX_SUBSCRIPTION_PRICE) {
      continue;
    }
    results.push({
      name: tierName.charAt(0).toUpperCase() + tierName.slice(1).toLowerCase(),
      priceText: rawPrice,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const item of results) {
    const key = `${item.name.toLowerCase()}|${item.priceText}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 4);
}

function extractServiceDetailCandidates(htmlText, limit = 6) {
  const details = [];
  const seen = new Set();
  const source = String(htmlText || "");
  const anchorMatch = source.match(
    /(pricing|plan|subscription|monthly|yearly|annual|per\s*month|\/\s*month|\/\s*mo|\/\s*月|\/\s*年|套餐|包月)/i,
  );
  const anchorIndex = anchorMatch ? anchorMatch.index : -1;
  const focusHtml = anchorIndex >= 0
    ? source.slice(Math.max(0, anchorIndex - 25_000), anchorIndex + 35_000)
    : source;

  const shouldKeep = (value) => {
    const text = compactText(value);
    if (!text) {
      return false;
    }
    if (text.length < 8 || text.length > 180) {
      return false;
    }
    const hasCjk = /[\u4e00-\u9fff]/.test(text);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (!hasCjk && wordCount < 3 && !/\d/.test(text)) {
      return false;
    }
    const lower = text.toLowerCase();
    if (
      /^(pricing|plans?|contact sales|sign up|start for free|learn more|read more|request quote|free trial|book demo|buy now|login|log in|cookie|privacy|terms|faq|support|documentation|docs)$/i.test(
        lower,
      )
    ) {
      return false;
    }
    if (/copyright|all rights reserved|subscribe to|newsletter|cookies?/i.test(lower)) {
      return false;
    }
    if (/\b(?:gpu-hour|per\s*gpu-hour|\/\s*h(?:r|our)?|hourly)\b/i.test(lower)) {
      return false;
    }
    if (/^(resources?|features?|analytics|security|integrations?|changelog|home|about|token|pricing)$/i.test(lower)) {
      return false;
    }
    const detailSignal = /[\u4e00-\u9fff]|\d|support|model|models|prompt|request|quota|limit|storage|api|private|unlimited|access|credit|image|text|code|encrypt|upscal|tool|兼容|支持|额度|请求|模型|每月|每周|每天|小时/i;
    if (!detailSignal.test(text)) {
      return false;
    }
    return true;
  };

  const addDetail = (value) => {
    const text = compactText(value);
    if (!shouldKeep(text)) {
      return;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    details.push(text);
  };

  const listMatches = focusHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi);
  for (const match of listMatches) {
    addDetail(stripHtmlTags(match[1]));
    if (details.length >= limit) {
      return details;
    }
  }

  const rowMatches = focusHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const match of rowMatches) {
    const cells = [...String(match[1] || "").matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((item) => stripHtmlTags(item[1]));
    if (cells.length < 2) {
      continue;
    }
    const label = compactText(cells[0]);
    const value = compactText(cells.slice(1).join(" "));
    if (!label || !value) {
      continue;
    }
    addDetail(`${label}: ${value}`);
    if (details.length >= limit) {
      return details;
    }
  }

  const paragraphMatches = focusHtml.matchAll(/<(?:p|h3|h4|h5)[^>]*>([\s\S]*?)<\/(?:p|h3|h4|h5)>/gi);
  for (const match of paragraphMatches) {
    addDetail(stripHtmlTags(match[1]));
    if (details.length >= limit) {
      return details;
    }
  }

  return details;
}

function enrichPlansWithServiceDetails(plans, fallbackServiceDetails) {
  const normalizedFallback = Array.isArray(fallbackServiceDetails)
    ? unique(fallbackServiceDetails.map((item) => compactText(item)).filter(Boolean))
    : [];
  return (plans || []).map((plan) => {
    const existing = Array.isArray(plan?.serviceDetails)
      ? unique(plan.serviceDetails.map((item) => compactText(item)).filter(Boolean))
      : [];
    const merged = unique([...existing, ...normalizedFallback]);
    return {
      ...plan,
      serviceDetails: merged.length > 0 ? merged : null,
    };
  });
}

function filterSubscriptionPriceTokens(tokens) {
  return (tokens || []).filter((token) => {
    const amount = parsePriceAmount(token);
    return amount !== null
      && amount >= HEURISTIC_MIN_SUBSCRIPTION_PRICE
      && amount <= HEURISTIC_MAX_SUBSCRIPTION_PRICE;
  });
}

function hasPlanLikeSignal(htmlText) {
  const text = compactText(htmlText).toLowerCase();
  return /(plan|pricing|subscription|starter|basic|pro|team|enterprise|套餐|包月|会员)/i.test(text);
}

function hasPlanTierSignal(htmlText) {
  const text = compactText(htmlText).toLowerCase();
  return /\b(base|basic|starter|plus|pro|team|enterprise|business|premium|free)\b/i.test(text);
}

function hasSubscriptionSignal(htmlText) {
  const text = compactText(htmlText).toLowerCase();
  return /(subscription|per month|monthly|per year|yearly|annual|annually|month-to-month|membership|套餐|包月|月付|年付|会员|\/\s*mo\b)/i.test(text);
}

function isRecurringPriceToken(token) {
  return /(?:\/|per)?\s*(mo|month|monthly|yr|year|yearly|annual|annually|月|年)\b/i.test(String(token || ""));
}

function hasRecurringPriceToken(tokens) {
  return (tokens || []).some((token) => isRecurringPriceToken(token));
}

function buildHeuristicPlans(priceTokens, sourceUrl, serviceDetails = null) {
  const valid = filterSubscriptionPriceTokens(priceTokens);
  const recurringFirst = valid.filter((token) => isRecurringPriceToken(token));
  const selected = (recurringFirst.length > 0 ? recurringFirst : valid).slice(0, 3);
  const plans = selected.map((priceText, index) => ({
    name: index === 0 ? "官网价格参考" : `官网价格参考 ${index + 1}`,
    currentPrice: parsePriceAmount(priceText),
    currentPriceText: priceText,
    originalPrice: null,
    originalPriceText: null,
    unit: parsePriceUnit(priceText),
    notes: index === 0 ? `来源: ${sourceUrl}` : null,
    serviceDetails: null,
  }));
  return enrichPlansWithServiceDetails(plans, serviceDetails);
}

function buildNamedHeuristicPlans(namedPrices, sourceUrl, serviceDetails = null, fallbackUnit = null) {
  const plans = (namedPrices || []).slice(0, 3).map((item, index) => ({
    name: item.name || (index === 0 ? "官网套餐参考" : `官网套餐参考 ${index + 1}`),
    currentPrice: parsePriceAmount(item.priceText),
    currentPriceText: item.priceText,
    originalPrice: null,
    originalPriceText: null,
    unit: parsePriceUnit(item.priceText) || fallbackUnit,
    notes: index === 0 ? `来源: ${sourceUrl}` : null,
    serviceDetails: null,
  }));
  return enrichPlansWithServiceDetails(plans, serviceDetails);
}

function buildTierHeuristicPlans(tierPlans, sourceUrl, recurringHint, serviceDetails = null) {
  const ranked = (tierPlans || [])
    .filter((item) => item && Number.isFinite(item.price)
      && item.price >= HEURISTIC_MIN_SUBSCRIPTION_PRICE
      && item.price <= HEURISTIC_MAX_SUBSCRIPTION_PRICE)
    .sort((left, right) => Number(left.price) - Number(right.price))
    .slice(0, 3);

  const plans = ranked.map((item, index) => {
    const amount = Number(item.price);
    const amountText = Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.00$/, "");
    const unitSuffix = recurringHint ? "/month" : "";
    return {
      name: item.name || (index === 0 ? "官网套餐参考" : `官网套餐参考 ${index + 1}`),
      currentPrice: amount,
      currentPriceText: `$${amountText}${unitSuffix}`,
      originalPrice: null,
      originalPriceText: null,
      unit: recurringHint ? "月" : null,
      notes: index === 0 ? `来源: ${sourceUrl}` : null,
      serviceDetails: null,
    };
  });
  return enrichPlansWithServiceDetails(plans, serviceDetails);
}

async function probePricingFromRuntimeAssets(candidateUrl, htmlText, officialWebsiteUrl) {
  if (!PRICING_BUNDLE_PROBE_ENABLED) {
    return null;
  }

  const entryUrls = extractRuntimeJsEntryUrls(htmlText, candidateUrl)
    .filter((url) => isSameOrSubdomain(url, officialWebsiteUrl || candidateUrl));
  if (entryUrls.length === 0) {
    return null;
  }

  const queue = [...entryUrls];
  const queued = new Set(queue);
  const visited = new Set();
  const sourceUrls = [candidateUrl];
  const priceTokens = [];
  const tierPlans = [];

  let planLike = false;
  let subscriptionLike = false;
  let tierLike = false;

  while (queue.length > 0 && visited.size < PRICING_BUNDLE_PROBE_MAX_FILES) {
    const jsUrl = queue.shift();
    if (!jsUrl || visited.has(jsUrl)) {
      continue;
    }
    visited.add(jsUrl);

    let scriptText = "";
    try {
      const fetched = await fetchText(jsUrl, {
        timeoutMs: PRICING_PROBE_TIMEOUT_MS,
        headers: HTML_HEADERS,
      });
      scriptText = String(fetched.text || "");
      sourceUrls.push(fetched.url || jsUrl);
    } catch {
      continue;
    }

    const tokens = extractPricingTokens(scriptText);
    for (const token of tokens) {
      if (!priceTokens.includes(token)) {
        priceTokens.push(token);
      }
    }

    const tiers = extractTierPlansFromScript(scriptText);
    for (const tier of tiers) {
      if (!tierPlans.some((item) => item.id === tier.id && item.name === tier.name && item.price === tier.price)) {
        tierPlans.push(tier);
      }
    }

    planLike = planLike || hasPlanLikeSignal(scriptText);
    subscriptionLike = subscriptionLike || hasSubscriptionSignal(scriptText);
    tierLike = tierLike || hasPlanTierSignal(scriptText);

    const validPriceTokens = filterSubscriptionPriceTokens(priceTokens);
    const validRecurringPriceLike = hasRecurringPriceToken(validPriceTokens);
    if (validPriceTokens.length > 0 && planLike && validRecurringPriceLike) {
      return {
        plans: buildHeuristicPlans(validPriceTokens, candidateUrl),
        sourceUrls: unique(sourceUrls),
      };
    }
    const validTierPlans = tierPlans.filter((item) =>
      Number.isFinite(item.price)
      && item.price >= HEURISTIC_MIN_SUBSCRIPTION_PRICE
      && item.price <= HEURISTIC_MAX_SUBSCRIPTION_PRICE);
    if (validTierPlans.length >= 2) {
      return {
        plans: buildTierHeuristicPlans(validTierPlans, candidateUrl, validRecurringPriceLike || subscriptionLike),
        sourceUrls: unique(sourceUrls),
      };
    }

    const discoveredUrls = unique([
      ...extractViteMapDepUrls(scriptText, jsUrl, Math.max(20, Math.floor(PRICING_BUNDLE_PROBE_MAX_FILES / 2))),
      ...extractModuleJsUrls(scriptText, jsUrl).slice(0, 24),
    ])
      .filter((url) => isSameOrSubdomain(url, officialWebsiteUrl || candidateUrl));

    for (const discoveredUrl of discoveredUrls) {
      if (queued.has(discoveredUrl) || visited.has(discoveredUrl)) {
        continue;
      }
      if (queued.size + visited.size >= PRICING_BUNDLE_PROBE_MAX_FILES * 2) {
        break;
      }
      queue.push(discoveredUrl);
      queued.add(discoveredUrl);
    }
  }

  return null;
}

function makePendingItem(provider, providerId, reason, extra = {}) {
  return {
    slug: String(provider?.slug || ""),
    openrouterName: provider?.name || provider?.slug || "--",
    providerId: providerId || null,
    officialWebsiteUrl: extra.officialWebsiteUrl || null,
    pricingPageUrl: extra.pricingPageUrl || null,
    reason: reason || "暂无可解析的套餐数据",
    blocked: Boolean(extra.blocked || isAccessBlockedMessage(reason)),
  };
}

function makeProviderItem(provider, providerId, plans, extra = {}) {
  return {
    slug: String(provider?.slug || ""),
    openrouterName: provider?.name || provider?.slug || "--",
    providerId: providerId || null,
    plans: Array.isArray(plans) ? plans : [],
    sourceUrls: Array.isArray(extra.sourceUrls) ? extra.sourceUrls : [],
    pricingPageUrl: extra.pricingPageUrl || null,
    officialWebsiteUrl: extra.officialWebsiteUrl || null,
    websiteSource: extra.websiteSource || null,
    privacyPolicyUrl: provider?.privacy_policy_url || null,
    termsOfServiceUrl: provider?.terms_of_service_url || null,
    statusPageUrl: provider?.status_page_url || null,
    parseMode: extra.parseMode || "unknown",
  };
}

function normalizePlanServiceDetails(plans) {
  const list = Array.isArray(plans) ? plans : [];
  const sharedDetails =
    list.find((plan) => Array.isArray(plan?.serviceDetails) && plan.serviceDetails.length > 0)?.serviceDetails || null;
  return list.map((plan) => {
    const current = Array.isArray(plan?.serviceDetails) ? plan.serviceDetails.filter(Boolean) : [];
    if (current.length > 0) {
      return {
        ...plan,
        serviceDetails: unique(current.map((item) => compactText(item)).filter(Boolean)),
      };
    }
    if (Array.isArray(sharedDetails) && sharedDetails.length > 0) {
      return {
        ...plan,
        serviceDetails: unique(sharedDetails.map((item) => compactText(item)).filter(Boolean)),
      };
    }
    return {
      ...plan,
      serviceDetails: null,
    };
  });
}

function hasAnyPlanServiceDetails(plans) {
  return (plans || []).some((plan) => Array.isArray(plan?.serviceDetails) && plan.serviceDetails.length > 0);
}

function extractTextSection(text, startPattern, endPattern) {
  const source = String(text || "");
  const startMatch = source.match(startPattern);
  if (!startMatch || startMatch.index === undefined) {
    return "";
  }
  const startIndex = startMatch.index + startMatch[0].length;
  const rest = source.slice(startIndex);
  const endMatch = rest.match(endPattern);
  return endMatch && endMatch.index !== undefined ? rest.slice(0, endMatch.index).trim() : rest.trim();
}

function selectPresentDetails(text, candidates) {
  const source = compactText(text);
  return candidates.filter((item) => source.includes(item));
}

async function parseMistralCustomPricing() {
  const pricingUrl = "https://mistral.ai/pricing";
  const { text: html, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: HTML_HEADERS,
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const plainText = compactText(html);

  const proPrice = Number.parseFloat(plainText.match(/\bPro\b[^$]{0,30}\$([0-9]+(?:\.[0-9]+)?)/i)?.[1] || "") || null;
  const teamPrice = Number.parseFloat(plainText.match(/\bTeam\b[^$]{0,30}\$([0-9]+(?:\.[0-9]+)?)/i)?.[1] || "") || null;
  if (!proPrice && !teamPrice) {
    return null;
  }

  const extractBulletFeatures = (headerName) => {
    const features = [];
    const headerRegex = new RegExp(`>\\s*${headerName}\\s*<\\/`, "gi");
    let headerMatch;
    while ((headerMatch = headerRegex.exec(html)) !== null) {
      const section = html.slice(headerMatch.index, headerMatch.index + 6000);
      const nextIdx = section.slice(1).search(/<h[2-4][^>]*>/i);
      const bounded = nextIdx >= 0 ? section.slice(0, nextIdx + 1) : section;
      for (const li of bounded.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const text = stripHtmlTags(li[1]).trim();
        if (text && text.length >= 5 && text.length < 200) {
          features.push(text);
        }
      }
      if (features.length >= 3) {
        break;
      }
    }
    return unique(features);
  };

  const extractTableFeatures = (columnName) => {
    const features = [];
    const rows = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((c) => stripHtmlTags(c[1]).trim());
      if (cells.length >= 3) {
        rows.push(cells);
      }
    }
    const headerRow = rows.find((r) => {
      const joined = r.join(" ").toLowerCase();
      return /feature/i.test(joined) && new RegExp(`\\b${columnName}\\b`, "i").test(joined);
    });
    if (!headerRow) {
      return features;
    }
    const colIdx = headerRow.findIndex((c) => c.trim().toLowerCase() === columnName.toLowerCase());
    if (colIdx < 0) {
      return features;
    }
    for (const row of rows) {
      if (row === headerRow) {
        continue;
      }
      const label = (row[0] || "").trim();
      const value = (row[colIdx] || "").trim();
      if (!label || label.length < 2 || !value || value === "-") {
        continue;
      }
      if (/^\*\s|^customer service$/i.test(label) || /^team and enterprise/i.test(label)) {
        continue;
      }
      features.push(/^[✓✔☑✅]$/.test(value) || value === label ? label : `${label}: ${value}`);
    }
    return unique(features);
  };

  const plans = [];
  if (proPrice) {
    const details = unique([...extractBulletFeatures("Pro"), ...extractTableFeatures("Pro")]).slice(0, 15);
    plans.push({
      name: "Pro",
      currentPrice: proPrice,
      currentPriceText: `$${proPrice}/month`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: `来源: ${sourceUrl}`,
      serviceDetails: details.length > 0 ? details : null,
    });
  }
  if (teamPrice) {
    const details = unique([...extractBulletFeatures("Team"), ...extractTableFeatures("Team")]).slice(0, 15);
    plans.push({
      name: "Team",
      currentPrice: teamPrice,
      currentPriceText: `$${teamPrice}/month`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: null,
      serviceDetails: details.length > 0 ? details : null,
    });
  }
  return plans.length > 0 ? { plans, sourceUrls: [sourceUrl], pricingPageUrl: sourceUrl } : null;
}

function extractCloudflareLlmExamples(markdownText, limit = 6) {
  const section = extractTextSection(markdownText, /##\s+LLM model pricing/i, /##\s+(?:Embeddings|Image|Audio|Other) model pricing/i);
  const rows = [];
  for (const line of String(section || "").split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("| @cf/")) {
      continue;
    }
    const cells = trimmed
      .split("|")
      .map((cell) => compactText(cell))
      .filter(Boolean);
    if (cells.length < 3) {
      continue;
    }
    rows.push(`${cells[0]}: ${cells[1]}`);
    if (rows.length >= limit) {
      break;
    }
  }
  return rows;
}

async function parseCloudflareCustomPricing() {
  const pricingUrl = "https://developers.cloudflare.com/workers-ai/platform/pricing/index.md";
  const { text: markdown, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: {
      ...HTML_HEADERS,
      accept: "text/markdown,text/plain;q=0.9,*/*;q=0.8",
    },
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const text = compactText(markdown);
  const neuronPriceText =
    text.match(/\$0\.011\s*\/\s*1,000\s*Neurons/i)?.[0]
    || text.match(/\$0\.011\s+per\s+1,000\s+Neurons/i)?.[0]
    || "$0.011 / 1,000 Neurons";
  const llmExamples = extractCloudflareLlmExamples(markdown);

  return {
    plans: [
      {
        name: "Workers AI Free allocation",
        currentPrice: 0,
        currentPriceText: "$0 (10,000 Neurons/day)",
        originalPrice: null,
        originalPriceText: null,
        unit: "日",
        notes: `来源: ${sourceUrl}`,
        serviceDetails: [
          "Workers AI is included in Free and Paid Workers plans",
          "10,000 Neurons per day at no charge",
          "Limits reset daily at 00:00 UTC",
          "Neurons measure GPU compute for AI model outputs",
        ],
      },
      {
        name: "Workers AI Paid usage",
        currentPrice: 0.011,
        currentPriceText: neuronPriceText.replace(/\s+per\s+/i, " / "),
        originalPrice: null,
        originalPriceText: null,
        unit: "用量",
        notes: "超过每日免费额度后按 Neurons 计费",
        serviceDetails: unique([
          "10,000 Neurons per day included before overage",
          "Price in Tokens is equivalent to Price in Neurons for comparison",
          ...llmExamples,
        ]).slice(0, 10),
      },
    ],
    sourceUrls: [
      "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      sourceUrl,
      "https://developers.cloudflare.com/workers/platform/pricing/#workers",
    ],
    pricingPageUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  };
}

function extractNextRscPayload(html) {
  const chunks = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)) {
    chunks.push(m[1]);
  }
  return chunks.join("").replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

function extractRscPlanFeatures(rscPayload, planTitle) {
  const titleEsc = planTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const planPattern = new RegExp(
    `"_title":"${titleEsc}"[^}]*"priceMonthly":"([^"]+)"`,
  );
  const planMatch = rscPayload.match(planPattern);
  if (!planMatch) return null;

  const priceText = planMatch[1].trim();
  const priceAmount = Number.parseFloat(priceText.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(priceAmount) || priceAmount <= 0) return null;

  const afterPlan = rscPayload.slice(planMatch.index + planMatch[0].length);
  const itemsSection = afterPlan.match(/"items":\[(\{[^]*?\})\]/);
  const features = [];
  if (itemsSection) {
    for (const fm of itemsSection[1].matchAll(/"_title":"([^"]+)"/g)) {
      const text = fm[1]
        .replace(/\\u0026/g, "&")
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .trim();
      if (text.length >= 5 && text.length <= 200) {
        features.push(text);
      }
    }
  }

  return { name: planTitle, price: priceAmount, priceText, features };
}

async function parseVeniceCustomPricing() {
  const pricingUrl = "https://venice.ai/pricing";
  const { text: html, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: HTML_HEADERS,
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const plainText = compactText(html);
  const planSpecs = [
    {
      name: "Pro",
      pricePattern: /\bPro\s+\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*mo/i,
      sectionStart: /\bPro\s+\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*mo/i,
      sectionEnd: /MOST POPULAR\s+Pro Plus\s+\$\s*[0-9]+|Pro Plus\s+\$\s*[0-9]+/i,
      details: [
        "All Pro models access",
        "Unlimited text prompts and 1,000 images per day",
        "Generate video, music, and use frontier image and text models with credits",
        "Image superpowers: upscale, remove backgrounds, create variants, and more",
        "Create and share custom characters",
        "Extended context windows for deep work and longer running conversations",
        "Encrypted chat backup and restore",
        "100 credits / month for video, music, premium models, and API",
      ],
    },
    {
      name: "Pro Plus",
      pricePattern: /\bPro Plus\s+\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*mo/i,
      sectionStart: /\bPro Plus\s+\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*mo/i,
      sectionEnd: /\bMax\s+\$\s*[0-9]+/i,
      details: [
        "Everything in Pro",
        "Higher image generation limits on Venice Pro models",
        "7,500 credits / month for video, music, frontier image generation, LLMs, and API",
        "2-month credit banking - unused credits roll forward",
      ],
    },
    {
      name: "Max",
      pricePattern: /\bMax\s+\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*mo/i,
      sectionStart: /\bMax\s+\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*mo/i,
      sectionEnd: /API Pricing|What are Credits\?/i,
      details: [
        "Everything in Plus",
        "Highest image generation limits on Venice Pro models",
        "22,500 credits / month for video, music, frontier image generation, frontier LLMs, and API",
        "3-month credit banking",
      ],
    },
  ];

  const directPlans = [];
  for (const spec of planSpecs) {
    const price = Number.parseFloat(plainText.match(spec.pricePattern)?.[1] || "");
    if (!Number.isFinite(price)) {
      continue;
    }
    const section = extractTextSection(plainText, spec.sectionStart, spec.sectionEnd);
    const details = selectPresentDetails(section || plainText, spec.details);
    directPlans.push({
      name: spec.name,
      currentPrice: price,
      currentPriceText: `$${price}/mo`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: directPlans.length === 0 ? `来源: ${sourceUrl}` : null,
      serviceDetails: details.length > 0 ? details : null,
    });
  }

  if (directPlans.length > 0 && hasAnyPlanServiceDetails(directPlans)) {
    return { plans: directPlans, sourceUrls: [sourceUrl], pricingPageUrl: sourceUrl };
  }

  const rscPayload = extractNextRscPayload(html);

  const proPlan = extractRscPlanFeatures(rscPayload, "Pro");
  if (!proPlan || proPlan.features.length === 0) {
    return null;
  }

  const plans = [{
    name: "Pro",
    currentPrice: proPlan.price,
    currentPriceText: `$${proPlan.price} USD/month`,
    originalPrice: null,
    originalPriceText: null,
    unit: "月",
    notes: `来源: ${sourceUrl}`,
    serviceDetails: unique(proPlan.features).slice(0, 12),
  }];
  return { plans, sourceUrls: [sourceUrl], pricingPageUrl: sourceUrl };
}

async function parseWandbCustomPricing() {
  const pricingUrl = "https://site.wandb.ai/pricing/";
  const { text: html, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: HTML_HEADERS,
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const text = compactText(html);

  const proPrice = Number.parseFloat(
    text.match(/\bPro\b[\s\S]{0,220}?Starts at\s+\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*month/i)?.[1] || "",
  );
  const inferencePrice = Number.parseFloat(
    text.match(/\bInference\b[\s\S]{0,260}?\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*mo/i)?.[1] || "",
  );

  const plans = [];
  if (Number.isFinite(proPrice)) {
    const proDetails = selectPresentDetails(text, [
      "Professionals working to optimize AI applications and models",
      "All features from Free +",
      "Unlimited teams for collaboration",
      "Team-based access controls",
      "Service Accounts",
      "Priority email & chat support",
    ]);
    if (/Model seats[\s\S]{0,80}Up to 10/i.test(text)) {
      proDetails.push("Model seats: up to 10");
    }
    if (/Storage[\s\S]{0,120}100 GB\/mo/i.test(text)) {
      proDetails.push("Storage: 100 GB/mo");
    }
    if (/Weave data ingestion[\s\S]{0,140}1\.5 GB\/mo/i.test(text)) {
      proDetails.push("Weave data ingestion: 1.5 GB/mo");
    }

    plans.push({
      name: "Pro",
      currentPrice: proPrice,
      currentPriceText: `$${proPrice}/month`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: `来源: ${sourceUrl}`,
      serviceDetails: unique(proDetails),
    });
  }

  if (Number.isFinite(inferencePrice)) {
    plans.push({
      name: "Inference add-on",
      currentPrice: inferencePrice,
      currentPriceText: `$${inferencePrice}/mo`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: "W&B pricing comparison table",
      serviceDetails: selectPresentDetails(text, [
        "Run open source AI models. View per model pricing.",
        "Free credit for a limited time",
        "Additional inference billed monthly",
        "Develop GenAI applications",
        "Monitor and analyze the performance of your GenAI models during development and in production, capturing inputs, outputs, and metadata for each inference.",
        "Compare different recipes including fine-tuning, RAG, LLMs, and datasets, side-by-side for accuracy, latency, and token usage.",
        "Monitor the Performance, Cost, and Health of Your LLM Applications.",
      ]),
    });
  }

  const normalized = normalizePlanServiceDetails(plans);
  return normalized.length > 0 ? { plans: normalized, sourceUrls: [sourceUrl], pricingPageUrl: sourceUrl } : null;
}

function extractSveltePlanObjects(jsText) {
  const text = String(jsText || "");
  const tierPattern = /^(free|basic|starter|base|plus|pro|team|business|premium|enterprise)$/i;
  const results = [];
  const planRegex = /name:"([^"]+)",price:"([^"]*)",subtitle:"([^"]*)",description:"([^"]*)"/g;
  let match;
  while ((match = planRegex.exec(text)) !== null) {
    const name = match[1].trim();
    if (!tierPattern.test(name)) continue;
    const priceText = match[2].trim();
    const priceAmount = parseFloat(priceText.replace(/[^0-9.]/g, ""));
    const subtitle = match[3].trim();
    const description = match[4].trim();
    const afterMatch = text.slice(match.index + match[0].length, match.index + match[0].length + 2000);
    const featuresMatch = afterMatch.match(/features:\[([^\]]*)\]/);
    const features = [];
    if (featuresMatch) {
      for (const fm of featuresMatch[1].matchAll(/"([^"]{3,200})"/g)) {
        features.push(fm[1].trim());
      }
    }
    const allDetails = [];
    if (description) allDetails.push(description);
    allDetails.push(...features);
    results.push({
      name,
      price: Number.isFinite(priceAmount) ? priceAmount : null,
      priceText: priceText + (subtitle ? ` ${subtitle}` : ""),
      features: allDetails,
      description,
    });
  }
  return results;
}

function extractChutesTierInfoFromText(plainText) {
  const text = compactText(plainText);
  if (!text) {
    return new Map();
  }

  const tierNames = ["Base", "Plus", "Pro"];
  const frontierRequirement =
    text.match(/Frontier models[^.]{0,260}require a Plus plan or higher\.?/i)?.[0] || null;
  const tierMap = new Map();

  for (let i = 0; i < tierNames.length; i += 1) {
    const tier = tierNames[i];
    const nextTier = tierNames[i + 1] || "Enterprise";
    const blockRegex = new RegExp(
      `\\b${tier}\\b([\\s\\S]{0,900}?)(?=\\b${nextTier}\\b|$)`,
      "i",
    );
    const blockMatch = text.match(blockRegex);
    if (!blockMatch) {
      continue;
    }

    const block = blockMatch[1];
    const nearTierPriceMatch = text.match(
      new RegExp(`\\b${tier}\\b[\\s\\S]{0,80}?\\$\\s*([0-9]+(?:\\.[0-9]+)?)`, "i"),
    );
    const fallbackPriceMatch = block.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/i);
    const price = Number.parseFloat((nearTierPriceMatch?.[1] || fallbackPriceMatch?.[1] || ""));
    const details = [];

    const valueMatch = block.match(/([0-9]+X\s+the value of pay-as-you-go)/i);
    if (valueMatch) {
      details.push(valueMatch[1]);
    }
    const discountMatch = block.match(/([0-9]+%\s+off\s+PAYG\s+pricing)/i);
    if (discountMatch) {
      details.push(discountMatch[1]);
    }
    if (/PAYG requests beyond limit/i.test(block)) {
      details.push("PAYG requests beyond limit");
    }
    if (/Frontier models not included/i.test(block)) {
      details.push("Frontier models not included");
    }
    if (/Access to frontier models/i.test(block)) {
      details.push("Access to frontier models");
    }
    if (frontierRequirement && /(plus|pro)/i.test(tier)) {
      details.push(frontierRequirement);
    }

    tierMap.set(tier.toLowerCase(), {
      price: Number.isFinite(price) ? price : null,
      details: unique(details.map((item) => compactText(item)).filter(Boolean)),
    });
  }

  return tierMap;
}

function parseChutesPlansFromPricingText(plainText, sourceUrl) {
  const tierInfo = extractChutesTierInfoFromText(plainText);
  const plans = [];
  for (const tier of ["Base", "Plus", "Pro"]) {
    const info = tierInfo.get(tier.toLowerCase());
    if (!info || !Number.isFinite(info.price)) {
      continue;
    }

    plans.push({
      name: tier,
      currentPrice: info.price,
      currentPriceText: `$${Number.isInteger(info.price) ? String(info.price) : String(info.price)}/month`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: plans.length === 0 ? `来源: ${sourceUrl}` : null,
      serviceDetails: info.details.length > 0 ? info.details : null,
    });
  }

  if (plans.length >= 3) {
    return {
      plans,
      sourceUrls: [sourceUrl],
      pricingPageUrl: sourceUrl,
    };
  }
  return null;
}

async function parseChutesCustomPricing() {
  const pricingUrl = "https://chutes.ai/pricing";
  const { text: html, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: HTML_HEADERS,
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const allSourceUrls = [sourceUrl];
  const directParsed = parseChutesPlansFromPricingText(html, sourceUrl);
  if (directParsed && directParsed.plans.length > 0) {
    return directParsed;
  }

  const nodeIdsMatch = html.match(/node_ids:\s*\[([0-9,\s]+)\]/);
  const pageNodeIds = nodeIdsMatch
    ? nodeIdsMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const entryUrls = extractRuntimeJsEntryUrls(html, sourceUrl)
    .filter((url) => isSameOrSubdomain(url, "https://chutes.ai"));
  const appEntryUrl = entryUrls.find((u) => /\/app\.[^/]+\.js/i.test(u));

  const tryExtract = (jsText) => {
    const tierInfo = extractChutesTierInfoFromText(jsText);
    const sveltePlans = extractSveltePlanObjects(jsText);
    const enriched = (sveltePlans.length > 0 ? sveltePlans : extractEnrichedTierPlans(jsText)).map((plan) => {
      const info = tierInfo.get(String(plan?.name || "").toLowerCase());
      const existingFeatures = Array.isArray(plan?.features) ? plan.features : [];
      return {
        ...plan,
        price: Number.isFinite(plan?.price) ? plan.price : info?.price ?? null,
        features: existingFeatures.length > 0 ? existingFeatures : (info?.details || []),
      };
    });

    const normalized = enriched.filter(
      (p) =>
        Number.isFinite(p.price) &&
        p.price >= HEURISTIC_MIN_SUBSCRIPTION_PRICE &&
        p.price <= HEURISTIC_MAX_SUBSCRIPTION_PRICE,
    );

    if (normalized.length > 0) {
      return normalized;
    }

    return ["base", "plus", "pro"]
      .map((tierKey) => {
        const info = tierInfo.get(tierKey);
        if (!info || !Number.isFinite(info.price)) {
          return null;
        }
        return {
          id: tierKey,
          name: tierKey.charAt(0).toUpperCase() + tierKey.slice(1),
          price: info.price,
          features: info.details,
          description: null,
        };
      })
      .filter(Boolean);
  };

  const buildResult = (validPlans) => {
    if (validPlans.length < 2 || !validPlans.some((p) => p.features.length > 0)) {
      return null;
    }
    const plans = validPlans
      .sort((a, b) => (a.price || 0) - (b.price || 0))
      .map((p, i) => ({
        name: p.name,
        currentPrice: p.price,
        currentPriceText: `$${p.price}/month`,
        originalPrice: null,
        originalPriceText: null,
        unit: "月",
        notes: i === 0 ? `来源: ${sourceUrl}` : null,
        serviceDetails: p.features.length > 0 ? p.features : p.description ? [p.description] : null,
      }));
    return { plans, sourceUrls: unique(allSourceUrls), pricingPageUrl: sourceUrl };
  };

  if (appEntryUrl && pageNodeIds.length > 0) {
    try {
      const appFetched = await fetchText(appEntryUrl, {
        timeoutMs: PRICING_PROBE_TIMEOUT_MS,
        headers: HTML_HEADERS,
      });
      const appText = String(appFetched.text || "");
      allSourceUrls.push(appFetched.url || appEntryUrl);

      const nodeUrls = [];
      for (const nodeId of pageNodeIds) {
        const nodePattern = new RegExp(`["']([^"']*nodes/${nodeId}\\.[^"']+\\.js)["']`, "g");
        for (const m of appText.matchAll(nodePattern)) {
          const resolved = absoluteUrl(m[1], appEntryUrl);
          if (resolved && isSameOrSubdomain(resolved, "https://chutes.ai")) {
            nodeUrls.push(resolved);
          }
        }
      }

      for (const nodeUrl of unique(nodeUrls)) {
        try {
          const nodeFetched = await fetchText(nodeUrl, {
            timeoutMs: PRICING_PROBE_TIMEOUT_MS,
            headers: HTML_HEADERS,
          });
          const nodeText = String(nodeFetched.text || "");
          allSourceUrls.push(nodeFetched.url || nodeUrl);

          const result = buildResult(tryExtract(nodeText));
          if (result) return result;

          const chunkUrls = extractModuleJsUrls(nodeText, nodeUrl)
            .filter((url) => isSameOrSubdomain(url, "https://chutes.ai"));
          for (const chunkUrl of chunkUrls) {
            try {
              const chunkFetched = await fetchText(chunkUrl, {
                timeoutMs: PRICING_PROBE_TIMEOUT_MS,
                headers: HTML_HEADERS,
              });
              const chunkText = String(chunkFetched.text || "");
              allSourceUrls.push(chunkFetched.url || chunkUrl);

              const chunkResult = buildResult(tryExtract(chunkText));
              if (chunkResult) return chunkResult;
            } catch {
              /* skip unreachable chunk */
            }
          }
        } catch {
          /* skip unreachable node */
        }
      }
    } catch {
      /* fall through to generic traversal */
    }
  }

  const queue = [...entryUrls];
  const queued = new Set(queue);
  const visited = new Set();

  while (queue.length > 0 && visited.size < PRICING_BUNDLE_PROBE_MAX_FILES) {
    const jsUrl = queue.shift();
    if (!jsUrl || visited.has(jsUrl)) continue;
    visited.add(jsUrl);
    let scriptText;
    try {
      const fetched = await fetchText(jsUrl, {
        timeoutMs: PRICING_PROBE_TIMEOUT_MS,
        headers: HTML_HEADERS,
      });
      scriptText = String(fetched.text || "");
      allSourceUrls.push(fetched.url || jsUrl);
    } catch {
      continue;
    }

    const result = buildResult(tryExtract(scriptText));
    if (result) return result;

    const discovered = unique([
      ...extractViteMapDepUrls(scriptText, jsUrl, 40),
      ...extractModuleJsUrls(scriptText, jsUrl).slice(0, 24),
    ]).filter((url) => isSameOrSubdomain(url, "https://chutes.ai"));
    for (const url of discovered) {
      if (!queued.has(url) && !visited.has(url)) {
        queue.push(url);
        queued.add(url);
      }
    }
  }
  return null;
}

async function parseRedpillCustomPricing() {
  const pricingUrl = "https://www.redpill.ai/pricing";
  const { text: html, url: resolvedUrl } = await fetchText(pricingUrl, {
    timeoutMs: PRICING_PROBE_TIMEOUT_MS,
    headers: HTML_HEADERS,
  });
  const sourceUrl = resolvedUrl || pricingUrl;
  const text = compactText(html);

  const proSectionMatch = text.match(
    /Pro\s+For individuals(?:\s*&\s*|\s+and\s+)professionals([\s\S]{0,1800}?)Enterprise\s+For teams(?:\s*&\s*|\s+and\s+)organizations/i,
  );
  const proSection = proSectionMatch?.[1] || "";
  const displayedPriceToken =
    proSection.match(/(\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*month)/i)?.[1]
    || text.match(/Pro\s+For individuals(?:\s*&\s*|\s+and\s+)professionals[\s\S]{0,600}?(\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*month)/i)?.[1]
    || null;
  const displayedPrice = parsePriceAmount(displayedPriceToken);
  if (!Number.isFinite(displayedPrice)) {
    return null;
  }

  const annualSavePercent = Number.parseFloat(text.match(/Annually\s*Save\s*([0-9]+(?:\.[0-9]+)?)%/i)?.[1] || "");
  const inferredMonthlyPrice = Number.isFinite(annualSavePercent) && annualSavePercent > 0 && annualSavePercent < 100
    ? Number((displayedPrice / (1 - annualSavePercent / 100)).toFixed(2))
    : displayedPrice;
  const monthlyPrice = inferredMonthlyPrice > displayedPrice ? inferredMonthlyPrice : displayedPrice;

  const knownFeatureCandidates = [
    "50+ latest models including DeepSeek V3, Qwen, GLM-4",
    "Unlimited messaging",
    "Private RAG - upload & query documents",
    "10 GB file storage",
    "30 Deep Research queries/month",
    "Unlimited web search",
    "Priority support",
  ];
  const serviceDetails = knownFeatureCandidates.filter((item) => text.includes(item));
  const notes = [];
  notes.push(`来源: ${sourceUrl}`);
  if (monthlyPrice > displayedPrice && Number.isFinite(annualSavePercent)) {
    notes.push(`页面展示年付折算价 $${displayedPrice}/month（Save ${annualSavePercent}%），换算月付价 $${monthlyPrice}/month`);
  }

  return {
    plans: [{
      name: "Pro",
      currentPrice: monthlyPrice,
      currentPriceText: `$${monthlyPrice}/month`,
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: notes.join("；"),
      serviceDetails: serviceDetails.length > 0 ? serviceDetails : null,
    }],
    sourceUrls: [sourceUrl],
    pricingPageUrl: sourceUrl,
  };
}

async function parseZAiCustomPricing() {
  const sourceUrl = "https://z.ai/subscribe";
  const docsUrl = "https://docs.z.ai/devpack/overview";
  const chromium = await loadPlaywrightChromium("z.ai parser");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await blockNonEssentialPlaywrightRequests(page);
    await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    await page.waitForFunction(
      () => {
        const text = String(document.body?.innerText || "");
        return /GLM Coding Plan/i.test(text) && /Subscribe/i.test(text);
      },
      { timeout: 8_000 },
    );
    await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const monthlyTab = Array.from(document.querySelectorAll("*")).find((node) => normalize(node.textContent) === "Monthly");
      if (monthlyTab) {
        monthlyTab.click();
      }
    });
    await page.waitForFunction(
      () => /\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*month from 2nd month/i.test(String(document.body?.innerText || "")),
      { timeout: 5_000 },
    );

    const extractedPlans = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cleanup = (value) => normalize(value).replace(/^[^A-Za-z0-9\u4e00-\u9fa5$]+/, "");
      const seen = new Set();
      const cards = [];
      const subscribeButtons = Array.from(document.querySelectorAll("button")).filter((node) => /Subscribe/i.test(normalize(node.textContent)));

      for (const button of subscribeButtons) {
        const card = button.parentElement?.parentElement || button.parentElement;
        if (!card) {
          continue;
        }
        const texts = Array.from(card.querySelectorAll("*"))
          .map((node) => cleanup(node.textContent))
          .filter(Boolean);
        const tier = texts.find((text) => /^(Lite|Pro|Max)$/.test(text));
        if (!tier || seen.has(tier)) {
          continue;
        }
        seen.add(tier);

        const priceText = texts.find((text) => /^\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*month$/i.test(text)) || null;
        const renewalText = texts.find((text) => /^\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*month from 2nd month$/i.test(text)) || null;
        const featureTitle =
          texts
            .filter((text) => /usage of the Claude Pro plan|Lite plan usage|Pro plan benefits/i.test(text))
            .sort((left, right) => left.length - right.length)[0]
          || null;
        const serviceDetails = Array.from(card.querySelectorAll("li"))
          .map((node) => cleanup(node.textContent))
          .filter((text) => text && !/Subscribe/i.test(text) && !/\$\s*[0-9]+(?:\.[0-9]+)?/i.test(text));

        cards.push({
          tier,
          priceText,
          renewalText,
          serviceDetails: featureTitle ? [featureTitle, ...serviceDetails] : serviceDetails,
        });
      }

      return cards;
    });

    if (!Array.isArray(extractedPlans) || extractedPlans.length === 0) {
      throw new Error("Unable to parse z.ai subscribe plans via Playwright");
    }

    const plans = extractedPlans.map((plan) => ({
      name: `GLM Coding ${plan.tier}`,
      currentPrice: parsePriceAmount(plan.priceText),
      currentPriceText: String(plan.priceText || "").replace(/\s+/g, ""),
      originalPrice: null,
      originalPriceText: null,
      unit: "月",
      notes: compactText(plan.renewalText),
      serviceDetails: unique((plan.serviceDetails || []).map((item) => compactText(item)).filter(Boolean)),
    }));

    return {
      plans,
      sourceUrls: unique([sourceUrl, docsUrl]),
      pricingPageUrl: sourceUrl,
    };
  } finally {
    await browser.close();
  }
}

const PROVIDER_CUSTOM_PARSERS = {
  cloudflare: parseCloudflareCustomPricing,
  mistral: parseMistralCustomPricing,
  chutes: parseChutesCustomPricing,
  venice: parseVeniceCustomPricing,
  wandb: parseWandbCustomPricing,
  phala: parseRedpillCustomPricing,
  "z-ai": parseZAiCustomPricing,
};

async function probeOfficialPricing(openrouterProvider, officialWebsiteUrl) {
  if (!officialWebsiteUrl) {
    return {
      plans: [],
      sourceUrls: [],
      pricingPageUrl: null,
      blocked: false,
      reason: "OpenRouter 元数据中缺少可用官网地址",
    };
  }

  let homepageUrl = officialWebsiteUrl;
  let homepageText = "";
  const probeErrors = [];
  let blocked = false;
  let usageOnlyEvidence = null;

  try {
    const homepage = await fetchText(officialWebsiteUrl, {
      timeoutMs: PRICING_PROBE_TIMEOUT_MS,
      headers: HTML_HEADERS,
    });
    homepageUrl = homepage.url || officialWebsiteUrl;
    homepageText = homepage.text || "";
  } catch (error) {
    const message = String(error?.message || error || "unknown error");
    probeErrors.push(`homepage: ${message}`);
    blocked = blocked || isAccessBlockedMessage(message);
  }

  const linksFromHomepage = extractPricingLinks(homepageText, homepageUrl)
    .filter((link) => isSameOrSubdomain(link, officialWebsiteUrl));
  const providerSlug = String(openrouterProvider?.slug || "").trim().toLowerCase();
  const preferredPricingUrl = providerSlug && PRICING_PAGE_OVERRIDES[providerSlug]
    ? PRICING_PAGE_OVERRIDES[providerSlug]
    : null;
  const pathCandidates = PRICING_PATH_CANDIDATES
    .map((candidatePath) => absoluteUrl(candidatePath, homepageUrl))
    .filter(Boolean);

  const candidateUrls = unique([preferredPricingUrl, ...pathCandidates, ...linksFromHomepage, homepageUrl])
    .slice(0, PRICING_PROBE_MAX_CANDIDATES);

  const visited = [];
  let runtimeProbeTried = false;
  for (const candidateUrl of candidateUrls) {
    try {
      const page = await fetchText(candidateUrl, {
        timeoutMs: PRICING_PROBE_TIMEOUT_MS,
        headers: HTML_HEADERS,
      });
      const tokens = extractPricingTokens(page.text);
      const validTokens = filterSubscriptionPriceTokens(tokens);
      const planLike = hasPlanLikeSignal(page.text);
      const subscriptionLike = hasSubscriptionSignal(page.text);
      const validRecurringPriceLike = hasRecurringPriceToken(validTokens);
      const tierLike = hasPlanTierSignal(page.text);
      const serviceDetails = extractServiceDetailCandidates(page.text);
      const title = extractTitle(page.text);
      const candidateLooksPricing =
        /(pricing|price|plan|billing|subscription|套餐|定价)/i.test(page.url || candidateUrl)
        || /(pricing|price|plan|billing|subscription|套餐|定价)/i.test(title || "");
      visited.push(page.url || candidateUrl);
      if (validTokens.length > 0 && planLike && validRecurringPriceLike && (candidateLooksPricing || subscriptionLike || tierLike)) {
        return {
          plans: buildHeuristicPlans(validTokens, page.url || candidateUrl, serviceDetails),
          sourceUrls: unique([officialWebsiteUrl, page.url || candidateUrl]),
          pricingPageUrl: page.url || candidateUrl,
          blocked: false,
          reason: null,
          title,
        };
      }
      if (!runtimeProbeTried && candidateLooksPricing && planLike) {
        runtimeProbeTried = true;
        const runtimeProbe = await probePricingFromRuntimeAssets(page.url || candidateUrl, page.text, officialWebsiteUrl);
        if (runtimeProbe && runtimeProbe.plans.length > 0) {
          return {
            plans: enrichPlansWithServiceDetails(runtimeProbe.plans, serviceDetails),
            sourceUrls: unique([officialWebsiteUrl, page.url || candidateUrl, ...(runtimeProbe.sourceUrls || [])]),
            pricingPageUrl: page.url || candidateUrl,
            blocked: false,
            reason: null,
            title,
          };
        }
      }
      if (candidateLooksPricing && planLike && tierLike) {
        const namedTierPrices = extractTierNamedPriceTokens(page.text);
        if (namedTierPrices.length > 0) {
          return {
            plans: buildNamedHeuristicPlans(namedTierPrices, page.url || candidateUrl, serviceDetails),
            sourceUrls: unique([officialWebsiteUrl, page.url || candidateUrl]),
            pricingPageUrl: page.url || candidateUrl,
            blocked: false,
            reason: null,
            title,
          };
        }
        if (subscriptionLike && validTokens.length > 0) {
          const relaxedNamedTierPrices = extractTierNamedPriceTokens(page.text, false);
          if (relaxedNamedTierPrices.length > 0) {
            return {
              plans: buildNamedHeuristicPlans(relaxedNamedTierPrices, page.url || candidateUrl, serviceDetails, "月"),
              sourceUrls: unique([officialWebsiteUrl, page.url || candidateUrl]),
              pricingPageUrl: page.url || candidateUrl,
              blocked: false,
              reason: null,
              title,
            };
          }
        }
      }
      if (!usageOnlyEvidence && tokens.length > 0) {
        usageOnlyEvidence = {
          url: page.url || candidateUrl,
          sampleTokens: tokens.slice(0, 3),
          subscriptionLike,
          recurringLike: hasRecurringPriceToken(tokens),
        };
      }
    } catch (error) {
      const message = String(error?.message || error || "unknown error");
      probeErrors.push(`${candidateUrl}: ${message}`);
      blocked = blocked || isAccessBlockedMessage(message);
    }
  }

  if (usageOnlyEvidence) {
    const reason = usageOnlyEvidence.subscriptionLike && usageOnlyEvidence.recurringLike
      ? `检测到套餐页线索，但未解析到月/年订阅价格（样例: ${usageOnlyEvidence.sampleTokens.join(" / ")}）`
      : `仅检测到按量计费价格，未识别到套餐订阅价格（样例: ${usageOnlyEvidence.sampleTokens.join(" / ")}）`;
    return {
      plans: [],
      sourceUrls: unique([officialWebsiteUrl, usageOnlyEvidence.url]),
      pricingPageUrl: usageOnlyEvidence.url,
      blocked: false,
      reason,
    };
  }

  const reason = probeErrors.length > 0
    ? `官网价格页探测失败：${probeErrors[0]}`
    : "官网未发现可解析的套餐价格页";

  return {
    plans: [],
    sourceUrls: unique([officialWebsiteUrl, ...visited]),
    pricingPageUrl: visited[0] || null,
    blocked,
    reason,
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) {
        return;
      }
      results[index] = await mapper(values[index], index);
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

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "coding-plans-for-copilot-openrouter-provider-plans/2.0",
  };

  const [openrouterProvidersPayload, providerPricingData, metricsData] = await Promise.all([
    fetchJson(`${OPENROUTER_BASE_URL}/providers`, { headers }),
    readJsonFile(PRICING_SOURCE_FILE),
    readJsonFile(METRICS_SOURCE_FILE),
  ]);

  const openrouterProviders = Array.isArray(openrouterProvidersPayload?.data) ? openrouterProvidersPayload.data : [];
  const providersByName = new Map(
    openrouterProviders.map((provider) => [normalizeName(provider?.name || ""), provider]),
  );
  const providersBySlug = new Map(
    openrouterProviders.map((provider) => [normalizeSlug(provider?.slug || ""), provider]),
  );

  const pricingProviders = Array.isArray(providerPricingData?.providers) ? providerPricingData.providers : [];
  const pricingByProviderId = new Map(pricingProviders.map((provider) => [String(provider?.provider || ""), provider]));
  const pricingFailures = Array.isArray(providerPricingData?.failures) ? providerPricingData.failures : [];

  const metricsProviders = getMetricsProviders(metricsData);
  const unresolvedMetricsProviders = [];
  const targets = [];

  for (const metricsProvider of metricsProviders) {
    const openrouterProvider = resolveOpenrouterProvider(metricsProvider, providersByName, providersBySlug);
    if (!openrouterProvider) {
      unresolvedMetricsProviders.push(metricsProvider);
      continue;
    }
    targets.push({
      metricsProvider,
      openrouterProvider,
      providerId: OPENROUTER_TO_PRICING_PROVIDER[String(openrouterProvider?.slug || "").trim()] || null,
    });
  }

  const mappedProviders = [];
  const providersNeedingProbe = [];
  const pending = [];

  for (const item of targets) {
    const { openrouterProvider, providerId } = item;
    const website = inferOfficialWebsite(openrouterProvider);
    const pricingProvider = providerId ? pricingByProviderId.get(providerId) : null;
    const pricingPlans = Array.isArray(pricingProvider?.plans) ? pricingProvider.plans : [];

    if (pricingPlans.length > 0) {
      mappedProviders.push(
        makeProviderItem(openrouterProvider, providerId, pricingPlans, {
          sourceUrls: unique([
            ...(Array.isArray(pricingProvider?.sourceUrls) ? pricingProvider.sourceUrls : []),
            website.officialWebsiteUrl,
          ]),
          pricingPageUrl:
            (Array.isArray(pricingProvider?.sourceUrls) && pricingProvider.sourceUrls[0]) || website.officialWebsiteUrl,
          officialWebsiteUrl: website.officialWebsiteUrl,
          websiteSource: website.source,
          parseMode: "provider-pricing-structured",
        }),
      );
      continue;
    }

    if (providerId) {
      const failureReason = extractFailureReasonByProvider(pricingFailures, providerId);
      if (failureReason && isAccessBlockedMessage(failureReason)) {
        pending.push(
          makePendingItem(openrouterProvider, providerId, failureReason, {
            officialWebsiteUrl: website.officialWebsiteUrl,
            pricingPageUrl: website.officialWebsiteUrl,
            blocked: true,
          }),
        );
        continue;
      }
    }

    providersNeedingProbe.push({
      openrouterProvider,
      providerId,
      website,
    });
  }

  const probed = await mapWithConcurrency(providersNeedingProbe, PRICING_PROBE_CONCURRENCY, async (item) => {
    const { openrouterProvider, providerId, website } = item;
    const slug = String(openrouterProvider?.slug || "").trim().toLowerCase();

    if (PROVIDER_PENDING_OVERRIDES[slug]) {
      return {
        type: "pending",
        value: makePendingItem(openrouterProvider, providerId, PROVIDER_PENDING_OVERRIDES[slug], {
          officialWebsiteUrl: website.officialWebsiteUrl,
          pricingPageUrl: website.officialWebsiteUrl,
        }),
      };
    }

    const customParser = PROVIDER_CUSTOM_PARSERS[slug];
    if (customParser) {
      try {
        const customResult = await customParser();
        if (customResult && customResult.plans.length > 0) {
          return {
            type: "provider",
            value: makeProviderItem(openrouterProvider, providerId, normalizePlanServiceDetails(customResult.plans), {
              sourceUrls: unique([...(customResult.sourceUrls || []), website.officialWebsiteUrl]),
              pricingPageUrl: customResult.pricingPageUrl,
              officialWebsiteUrl: website.officialWebsiteUrl,
              websiteSource: website.source,
              parseMode: "official-website-heuristic",
            }),
          };
        }
      } catch (error) {
        console.warn(`[openrouter-plans] custom parser for ${slug} failed: ${error?.message || error}`);
      }
    }

    const probeResult = await probeOfficialPricing(openrouterProvider, website.officialWebsiteUrl);
    const normalizedPlans = normalizePlanServiceDetails(probeResult.plans);
    if (normalizedPlans.length > 0) {
      return {
        type: "provider",
        value: makeProviderItem(openrouterProvider, providerId, normalizedPlans, {
          sourceUrls: probeResult.sourceUrls,
          pricingPageUrl: probeResult.pricingPageUrl,
          officialWebsiteUrl: website.officialWebsiteUrl,
          websiteSource: website.source,
          parseMode: "official-website-heuristic",
        }),
      };
    }

    const fallbackReason = normalizedPlans.length > 0
      ? "检测到套餐价格，但未提取到有效服务详情"
      : probeResult.reason;

    return {
      type: "pending",
      value: makePendingItem(openrouterProvider, providerId, fallbackReason, {
        officialWebsiteUrl: website.officialWebsiteUrl,
        pricingPageUrl: probeResult.pricingPageUrl || website.officialWebsiteUrl,
        blocked: probeResult.blocked,
      }),
    };
  });

  for (const item of probed) {
    if (!item || !item.value) {
      continue;
    }
    if (item.type === "provider") {
      mappedProviders.push(item.value);
    } else {
      pending.push(item.value);
    }
  }

  for (const item of unresolvedMetricsProviders) {
    const fallbackName = item?.name || item?.slug || "--";
    pending.push({
      slug: item?.slug || "",
      openrouterName: fallbackName,
      providerId: null,
      officialWebsiteUrl: null,
      pricingPageUrl: null,
      reason: "无法在 OpenRouter /providers 中定位该 provider",
      blocked: false,
    });
  }

  mappedProviders.sort((left, right) => left.openrouterName.localeCompare(right.openrouterName));
  pending.sort((left, right) => left.openrouterName.localeCompare(right.openrouterName));

  const generatedAt = new Date().toISOString();
  const output = {
    generatedAt,
    generatedAtBeijing: formatBeijingTime(generatedAt),
    sourceGeneratedAt: providerPricingData?.generatedAt || null,
    sourceGeneratedAtBeijing: formatBeijingTime(providerPricingData?.generatedAt || ""),
    sourceMetricsGeneratedAt: metricsData?.generatedAt || null,
    sourceMetricsGeneratedAtBeijing: formatBeijingTime(metricsData?.generatedAt || ""),
    summary: {
      openrouterProviderCount: openrouterProviders.length,
      metricsProviderCount: metricsProviders.length,
      resolvedMetricsProviderCount: targets.length,
      unresolvedMetricsProviderCount: unresolvedMetricsProviders.length,
      structuredProviderCount: mappedProviders.filter((item) => item.parseMode === "provider-pricing-structured").length,
      heuristicProviderCount: mappedProviders.filter((item) => item.parseMode === "official-website-heuristic").length,
      providersWithPlans: mappedProviders.length,
      pendingCount: pending.length,
      blockedPendingCount: pending.filter((item) => item.blocked).length,
      probeConcurrency: PRICING_PROBE_CONCURRENCY,
      probeMaxCandidates: PRICING_PROBE_MAX_CANDIDATES,
    },
    providers: mappedProviders,
    pending,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`[openrouter-plans] wrote ${OUTPUT_FILE}`);
  console.log(
    `[openrouter-plans] metricsProviders=${metricsProviders.length} providersWithPlans=${mappedProviders.length} pending=${pending.length} blockedPending=${output.summary.blockedPendingCount}`,
  );
}

main().catch((error) => {
  console.error("[openrouter-plans] fatal:", error && error.message ? error.message : error);
  process.exit(1);
});
