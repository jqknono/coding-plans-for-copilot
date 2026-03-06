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

// OpenRouter provider slug => provider-pricing.json provider id
const OPENROUTER_TO_PRICING_PROVIDER = {
  "z-ai": "zhipu-ai",
  moonshotai: "kimi-ai",
  minimax: "minimax-ai",
  streamlake: "kwaikat-ai",
  alibaba: "aliyun-ai",
  seed: "volcengine-ai",
};

// Extra fallback when OpenRouter policy/status links are missing.
const OFFICIAL_WEBSITE_OVERRIDES = {
  "io-net": "https://io.net",
  ionstream: "https://ionstream.ai",
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function getMetricsProviderNames(metricsData) {
  const models = Array.isArray(metricsData?.models) ? metricsData.models : [];
  const names = [];
  for (const model of models) {
    const endpoints = Array.isArray(model?.endpoints) ? model.endpoints : [];
    for (const endpoint of endpoints) {
      const name = String(endpoint?.providerName || "").trim();
      if (name) {
        names.push(name);
      }
    }
  }
  return unique(names).sort((left, right) => left.localeCompare(right));
}

function resolveOpenrouterProvider(metricsProviderName, providersByName, providersBySlug) {
  const byName = providersByName.get(normalizeName(metricsProviderName));
  if (byName) {
    return byName;
  }
  const bySlug = providersBySlug.get(normalizeName(metricsProviderName));
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
      /((?:US\$|USD|\$|¥)\s*[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?(?:\s*(?:\/|per)?\s*(?:mo|month|monthly|yr|year|yearly|annual|annually|月|年|day|daily|日|hour|hourly|h))?)/gi,
    ),
    ...text.matchAll(
      /([0-9]+(?:\.[0-9]+)?\s*(?:\/|per)\s*(?:mo|month|monthly|yr|year|yearly|annual|annually|月|年|day|daily|日|hour|hourly|h))/gi,
    ),
  ]
    .map((match) => normalizePriceToken(match[1]))
    .filter(Boolean);

  return unique(rawMatches).slice(0, 10);
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
  return /(subscription|per month|monthly|per year|yearly|annual|annually|month-to-month|membership|套餐|包月|月付|年付|会员)/i.test(text);
}

function isRecurringPriceToken(token) {
  return /(?:\/|per)?\s*(mo|month|monthly|yr|year|yearly|annual|annually|月|年)\b/i.test(String(token || ""));
}

function hasRecurringPriceToken(tokens) {
  return (tokens || []).some((token) => isRecurringPriceToken(token));
}

function buildHeuristicPlans(priceTokens, sourceUrl) {
  const recurringFirst = (priceTokens || []).filter((token) => isRecurringPriceToken(token));
  const selected = (recurringFirst.length > 0 ? recurringFirst : priceTokens).slice(0, 3);
  return selected.map((priceText, index) => ({
    name: index === 0 ? "官网价格参考" : `官网价格参考 ${index + 1}`,
    currentPrice: parsePriceAmount(priceText),
    currentPriceText: priceText,
    originalPrice: null,
    originalPriceText: null,
    unit: parsePriceUnit(priceText),
    notes: index === 0 ? `来源: ${sourceUrl}` : null,
    serviceDetails: null,
  }));
}

function buildTierHeuristicPlans(tierPlans, sourceUrl, recurringHint) {
  const ranked = (tierPlans || [])
    .filter((item) => item && Number.isFinite(item.price))
    .sort((left, right) => Number(left.price) - Number(right.price))
    .slice(0, 3);

  return ranked.map((item, index) => {
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

    const recurringPriceLike = hasRecurringPriceToken(priceTokens);
    if (priceTokens.length > 0 && planLike && recurringPriceLike) {
      return {
        plans: buildHeuristicPlans(priceTokens, candidateUrl),
        sourceUrls: unique(sourceUrls),
      };
    }
    if (tierPlans.filter((item) => Number.isFinite(item.price)).length >= 2) {
      return {
        plans: buildTierHeuristicPlans(tierPlans, candidateUrl, recurringPriceLike || subscriptionLike),
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
  const pathCandidates = PRICING_PATH_CANDIDATES
    .map((candidatePath) => absoluteUrl(candidatePath, homepageUrl))
    .filter(Boolean);

  const candidateUrls = unique([...linksFromHomepage, ...pathCandidates, homepageUrl]).slice(0, PRICING_PROBE_MAX_CANDIDATES);

  const visited = [];
  let runtimeProbeTried = false;
  for (const candidateUrl of candidateUrls) {
    try {
      const page = await fetchText(candidateUrl, {
        timeoutMs: PRICING_PROBE_TIMEOUT_MS,
        headers: HTML_HEADERS,
      });
      const tokens = extractPricingTokens(page.text);
      const planLike = hasPlanLikeSignal(page.text);
      const subscriptionLike = hasSubscriptionSignal(page.text);
      const recurringPriceLike = hasRecurringPriceToken(tokens);
      const tierLike = hasPlanTierSignal(page.text);
      const title = extractTitle(page.text);
      const candidateLooksPricing =
        /(pricing|price|plan|billing|subscription|套餐|定价)/i.test(page.url || candidateUrl)
        || /(pricing|price|plan|billing|subscription|套餐|定价)/i.test(title || "");
      visited.push(page.url || candidateUrl);
      if (tokens.length > 0 && planLike && recurringPriceLike && (candidateLooksPricing || subscriptionLike || tierLike)) {
        return {
          plans: buildHeuristicPlans(tokens, page.url || candidateUrl),
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
            plans: runtimeProbe.plans,
            sourceUrls: unique([officialWebsiteUrl, page.url || candidateUrl, ...(runtimeProbe.sourceUrls || [])]),
            pricingPageUrl: page.url || candidateUrl,
            blocked: false,
            reason: null,
            title,
          };
        }
      }
      if (!usageOnlyEvidence && tokens.length > 0) {
        usageOnlyEvidence = {
          url: page.url || candidateUrl,
          sampleTokens: tokens.slice(0, 3),
          subscriptionLike,
        };
      }
    } catch (error) {
      const message = String(error?.message || error || "unknown error");
      probeErrors.push(`${candidateUrl}: ${message}`);
      blocked = blocked || isAccessBlockedMessage(message);
    }
  }

  if (usageOnlyEvidence) {
    const reason = usageOnlyEvidence.subscriptionLike
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
    openrouterProviders.map((provider) => [normalizeName(provider?.slug || ""), provider]),
  );

  const pricingProviders = Array.isArray(providerPricingData?.providers) ? providerPricingData.providers : [];
  const pricingByProviderId = new Map(pricingProviders.map((provider) => [String(provider?.provider || ""), provider]));
  const pricingFailures = Array.isArray(providerPricingData?.failures) ? providerPricingData.failures : [];

  const metricsProviderNames = getMetricsProviderNames(metricsData);
  const unresolvedMetricsProviders = [];
  const targets = [];

  for (const metricsProviderName of metricsProviderNames) {
    const openrouterProvider = resolveOpenrouterProvider(metricsProviderName, providersByName, providersBySlug);
    if (!openrouterProvider) {
      unresolvedMetricsProviders.push(metricsProviderName);
      continue;
    }
    targets.push({
      metricsProviderName,
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
    const probeResult = await probeOfficialPricing(openrouterProvider, website.officialWebsiteUrl);
    if (probeResult.plans.length > 0) {
      return {
        type: "provider",
        value: makeProviderItem(openrouterProvider, providerId, probeResult.plans, {
          sourceUrls: probeResult.sourceUrls,
          pricingPageUrl: probeResult.pricingPageUrl,
          officialWebsiteUrl: website.officialWebsiteUrl,
          websiteSource: website.source,
          parseMode: "official-website-heuristic",
        }),
      };
    }

    return {
      type: "pending",
      value: makePendingItem(openrouterProvider, providerId, probeResult.reason, {
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

  for (const name of unresolvedMetricsProviders) {
    pending.push({
      slug: "",
      openrouterName: name,
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
      metricsProviderCount: metricsProviderNames.length,
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
    `[openrouter-plans] metricsProviders=${metricsProviderNames.length} providersWithPlans=${mappedProviders.length} pending=${pending.length} blockedPending=${output.summary.blockedPendingCount}`,
  );
}

main().catch((error) => {
  console.error("[openrouter-plans] fatal:", error && error.message ? error.message : error);
  process.exit(1);
});
