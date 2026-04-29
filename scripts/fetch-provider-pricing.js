#!/usr/bin/env node

"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs/promises");
const path = require("node:path");

const OUTPUT_FILE = path.resolve(__dirname, "..", "assets", "provider-pricing.json");
const REQUEST_TIMEOUT_MS = 15_000;
const TASK_TIMEOUT_MS = 30_000;

const PROVIDER_IDS = {
  ZHIPU: "zhipu-ai",
  KIMI: "kimi-ai",
  XFYUN: "xfyun-ai",
  VOLCENGINE: "volcengine-ai",
  MINIMAX: "minimax-ai",
  ALIYUN: "aliyun-ai",
  ALIYUN_TOKEN: "aliyun-token-plan",
  BAIDU: "baidu-qianfan-ai",
  TENCENT: "tencent-cloud-ai",
  TENCENT_TOKEN: "tencent-cloud-token-plan",
  JDCLOUD: "jdcloud-ai",
  KWAIKAT: "kwaikat-ai",
  XAIO: "x-aio",
  COMPSHARE: "compshare-ai",
  INFINI: "infini-ai",
  XIAOMI: "xiaomi-mimo",
  OPENCODE: "opencode",
  ROOCODE: "roocode",
  GITHUB_COPILOT: "github-copilot",
  MTHREADS: "mthreads-coding-plan",
  STEPFUN: "stepfun-step-plan",
  CUCLOUD: "cucloud-coding-plan",
  SCNET: "scnet-coding-plan",
  CEREBRAS_CODE: "cerebras-code",
  SYNTHETIC: "synthetic-ai",
  CHUTES: "chutes-ai",
  KILO_PASS: "kilo-pass",
};

const KIMI_MEMBERSHIP_LEVEL_LABELS = {
  LEVEL_FREE: "免费试用",
  LEVEL_BASIC: "基础会员",
  LEVEL_INTERMEDIATE: "进阶会员",
  LEVEL_ADVANCED: "高级会员",
  LEVEL_STANDARD: "旗舰会员",
};

const KIMI_DOMESTIC_MEMBERSHIP_URL = "https://www.kimi.com/zh-cn/help/membership/membership-pricing";
const KIMI_OVERSEAS_CODE_URL = "https://www.kimi.com/code";
const KIMI_GOODS_API_URL = "https://www.kimi.com/apiv2/kimi.gateway.order.v1.GoodsService/ListGoods";
const KIMI_DOMESTIC_PLAN_NAMES = ["Adagio", "Andante", "Moderato", "Allegretto", "Allegro"];
const KIMI_REGION_LABELS = {
  REGION_MAINLAND: "大陆",
  REGION_OVERSEA: "海外",
};
const KIMI_CURRENCY_LABELS = {
  CNY: "人民币（CNY）",
  RMB: "人民币（CNY）",
  USD: "美元（USD）",
};

const COMMON_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8",
};
const REQUEST_CONTEXT = new AsyncLocalStorage();

const HTML_ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": "\"",
  "&#39;": "'",
  "&nbsp;": " ",
};

const CNY_CURRENCY_HINT = /(¥|￥|元|人民币|\b(?:CNY|RMB)\b)/i;
const USD_CURRENCY_HINT = /(\$|\b(?:USD|US\$)\b|美元|dollar)/i;
const STALE_PROVIDER_NOTICE = "最近一次抓取解析失败，当前展示的是上次成功抓取结果，可能信息已过时。";

function decodeHtml(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (match) => HTML_ENTITIES[match] || match)
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "));
}

function normalizeText(value) {
  return decodeHtml(decodeUnicodeLiteral(String(value || "")).replace(/\s+/g, " ")).trim();
}

function decodeUnicodeLiteral(value) {
  return String(value || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function isPriceLike(text) {
  const value = normalizeText(text);
  if (!value) {
    return false;
  }
  if (/(免费|free|0\s*成本)/i.test(value)) {
    return true;
  }
  if (!/\d/.test(value)) {
    return false;
  }
  return /(¥|￥|元|首月|\/\s*[年月日次])/i.test(value);
}

function parsePriceText(text) {
  const value = normalizeText(text);
  if (!value) {
    return {
      amount: null,
      text: null,
      unit: null,
    };
  }
  if (/(免费|free|0\s*成本)/i.test(value)) {
    return {
      amount: 0,
      text: value,
      unit: null,
    };
  }
  const numberMatch = value.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
  const amount = numberMatch ? Number(numberMatch[1].replace(/,/g, "")) : null;
  const unitMatch = value.match(/\/\s*([^\s)）]+)/);
  const unit = unitMatch ? unitMatch[1].trim() : null;
  return {
    amount: Number.isFinite(amount) ? amount : null,
    text: value,
    unit,
  };
}

function compactInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function detectCurrencyFromText(text, fallback = "USD") {
  const value = compactInlineText(text);
  if (!value) {
    return fallback;
  }
  if (CNY_CURRENCY_HINT.test(value)) {
    return "CNY";
  }
  if (USD_CURRENCY_HINT.test(value)) {
    return "USD";
  }
  return fallback;
}

function normalizeMoneyTextByCurrency(rawValue, fallbackCurrency = "USD") {
  const text = compactInlineText(rawValue);
  if (!text) {
    return null;
  }
  if (/(免费|free)/i.test(text)) {
    return text;
  }
  if (!/[0-9]/.test(text)) {
    return text;
  }

  const currency = detectCurrencyFromText(text, fallbackCurrency);
  const normalizedText = text.replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();

  if (currency === "CNY") {
    let normalized = normalizedText
      .replace(/[￥]/g, "¥")
      .replace(/人民币/gi, "")
      .replace(/\s*元(?=\s*\/|\s*$)/g, "")
      .trim();
    if (!/^¥/.test(normalized) && /^[0-9]/.test(normalized)) {
      normalized = `¥${normalized}`;
    }
    return normalized.replace(/^¥\s+/, "¥");
  }

  let normalized = normalizedText
    .replace(/[￥¥]/g, "")
    .replace(/人民币|元/g, "")
    .replace(/\b(?:USD|US\$)\b/gi, "")
    .trim();
  if (!/^\$/.test(normalized) && /^[0-9]/.test(normalized)) {
    normalized = `$${normalized}`;
  }
  return normalized.replace(/^\$\s+/, "$");
}

function normalizePlanCurrencySymbols(plan) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }
  const currencyHintText = [plan.currentPriceText, plan.originalPriceText, plan.notes]
    .map((value) => compactInlineText(value))
    .filter(Boolean)
    .join(" | ");
  const fallbackCurrency = detectCurrencyFromText(currencyHintText, "USD");

  return {
    ...plan,
    currentPriceText: normalizeMoneyTextByCurrency(plan.currentPriceText, fallbackCurrency),
    originalPriceText: normalizeMoneyTextByCurrency(plan.originalPriceText, fallbackCurrency),
    notes:
      typeof plan.notes === "string" && plan.notes.trim()
        ? plan.notes
            .split(/([；;])/)
            .map((part) => {
              if (part === "；" || part === ";") {
                return part;
              }
              return normalizeMoneyTextByCurrency(part, fallbackCurrency) || compactInlineText(part);
            })
            .join("")
            .replace(/\s+/g, " ")
            .trim()
        : plan.notes || null,
  };
}

function normalizeProviderCurrencySymbols(providers) {
  return (providers || []).map((provider) => ({
    ...provider,
    plans: (provider?.plans || []).map((plan) => normalizePlanCurrencySymbols(plan)),
  }));
}

function dedupePlans(plans) {
  const seen = new Set();
  const result = [];
  for (const plan of plans) {
    const key = [
      String(plan.name || "").toLowerCase(),
      String(plan.currentPriceText || "").toLowerCase(),
      String(plan.originalPriceText || "").toLowerCase(),
      String(plan.notes || "").toLowerCase(),
      (Array.isArray(plan.serviceDetails) ? plan.serviceDetails : [])
        .map((item) => String(item || "").toLowerCase())
        .join("|"),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(plan);
  }
  return result;
}

async function fetchText(url, options = {}) {
  const context = REQUEST_CONTEXT.getStore() || {};
  const { timeoutMs: timeoutOverride, signal: optionSignal, ...fetchOptions } = options;
  const timeoutMs = Number.isFinite(timeoutOverride) ? timeoutOverride : context.timeoutMs || REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const linkedSignals = [context.signal, optionSignal].filter(Boolean);
  const linkedAbortHandlers = [];
  let timedOut = false;

  for (const linkedSignal of linkedSignals) {
    if (linkedSignal.aborted) {
      controller.abort();
      break;
    }
    const onAbort = () => controller.abort();
    linkedSignal.addEventListener("abort", onAbort, { once: true });
    linkedAbortHandlers.push({ linkedSignal, onAbort });
  }
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      headers: COMMON_HEADERS,
      ...fetchOptions,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Request failed: ${url} -> ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    if (controller.signal.aborted) {
      throw new Error(`Request aborted: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    for (const { linkedSignal, onAbort } of linkedAbortHandlers) {
      linkedSignal.removeEventListener("abort", onAbort);
    }
  }
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}`);
  }
}

function extractRows(html) {
  const rows = [];
  const matches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const match of matches) {
    const cells = [...match[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  return rows;
}

function formatAmount(amount) {
  if (!Number.isFinite(amount)) {
    return null;
  }
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/\.?0+$/, "");
}

function parseAmountFromPriceText(value) {
  const match = normalizeText(value).match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function normalizeServiceDetails(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  const normalized = unique(
    list
      .flatMap((value) => String(value || "").split(/[\r\n;；]+/))
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
  return normalized.length > 0 ? normalized : null;
}

function buildServiceDetailsFromRows(rows, column, options = {}) {
  const excludeLabels = new Set(
    (options.excludeLabels || []).map((value) => normalizeText(value).toLowerCase()).filter(Boolean),
  );
  const details = [];
  for (const row of rows || []) {
    const label = normalizeText(row?.[0] || "");
    const value = normalizeText(row?.[column] || "");
    if (!label || !value) {
      continue;
    }
    if (excludeLabels.has(label.toLowerCase())) {
      continue;
    }
    details.push(`${label}: ${value}`);
  }
  return normalizeServiceDetails(details);
}

function parseTierPriceBreakdown(rawValue) {
  const text = normalizeText(rawValue);
  if (!text) {
    return {
      text: null,
      firstMonthAmount: null,
      secondMonthAmount: null,
      monthlyAmount: null,
    };
  }

  const readAmount = (regex) => {
    const matched = text.match(regex);
    if (!matched) {
      return null;
    }
    const amount = Number(String(matched[1] || "").replace(/,/g, ""));
    return Number.isFinite(amount) ? amount : null;
  };

  const firstMonthAmount = readAmount(/首月[^0-9]{0,12}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
  const secondMonthAmount = readAmount(/(?:自动续费)?次月[^0-9]{0,12}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
  const thirdMonthAmount = readAmount(/第三(?:个)?月(?:起|后|恢复)?[^0-9]{0,16}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
  const renewalAmount = readAmount(
    /(?:续费|恢复)[^0-9]{0,16}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)(?:\s*元)?\s*\/\s*月/i,
  );
  const monthlyAmount =
    thirdMonthAmount
    ?? renewalAmount
    ?? readAmount(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)\s*元?\s*\/\s*月/i);

  return {
    text,
    firstMonthAmount,
    secondMonthAmount,
    monthlyAmount,
  };
}

function buildTierPriceNotes(priceInfo) {
  const notes = [];
  if (Number.isFinite(priceInfo?.firstMonthAmount)) {
    notes.push(`首月特惠 ¥${formatAmount(priceInfo.firstMonthAmount)}`);
  }
  if (Number.isFinite(priceInfo?.secondMonthAmount)) {
    notes.push(`次月续费 ¥${formatAmount(priceInfo.secondMonthAmount)}`);
  }
  return notes.length > 0 ? notes.join("；") : null;
}

function parseFirstPurchaseAndAddonPrices(rawValue) {
  const text = normalizeText(rawValue);
  if (!text) {
    return {
      text: null,
      firstPurchaseAmount: null,
      addonAmount: null,
    };
  }

  const readAmount = (regex) => {
    const matched = text.match(regex);
    if (!matched) {
      return null;
    }
    const amount = Number(String(matched[1] || "").replace(/,/g, ""));
    return Number.isFinite(amount) ? amount : null;
  };

  return {
    text,
    firstPurchaseAmount: readAmount(/首购[^0-9]{0,12}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i),
    addonAmount: readAmount(/叠加购买[^0-9]{0,12}([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i),
  };
}

function parseTencentPromoDetails(text) {
  const value = normalizeText(text);
  const details = new Map();
  if (!value) {
    return details;
  }

  for (const tier of ["Lite", "Pro"]) {
    const blockMatch = value.match(
      new RegExp(
        `${tier}\\s*套餐特惠价[\\s\\S]{0,80}?首月\\s*([0-9]+(?:\\.[0-9]+)?)\\s*元\\s*\/\\s*月[\\s\\S]{0,80}?次月\\s*([0-9]+(?:\\.[0-9]+)?)\\s*元\\s*\/\\s*月[\\s\\S]{0,80}?原价\\s*([0-9]+(?:\\.[0-9]+)?)\\s*元\\s*\/\\s*月`,
        "i",
      ),
    );
    if (!blockMatch) {
      continue;
    }
    details.set(tier, {
      firstMonthAmount: Number(blockMatch[1]),
      secondMonthAmount: Number(blockMatch[2]),
      monthlyAmount: Number(blockMatch[3]),
    });
  }

  return details;
}

function asPlan({
  name,
  currentPriceText,
  currentPrice = null,
  originalPriceText = null,
  originalPrice = null,
  unit = null,
  notes = null,
  serviceDetails = null,
}) {
  const current = parsePriceText(currentPriceText);
  const original = parsePriceText(originalPriceText);
  return {
    name: normalizeText(name),
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : current.amount,
    currentPriceText: current.text,
    originalPrice: Number.isFinite(originalPrice) ? originalPrice : original.amount,
    originalPriceText: original.text,
    unit: unit || current.unit || original.unit || null,
    notes: normalizeText(notes) || null,
    serviceDetails: normalizeServiceDetails(serviceDetails),
  };
}

function absoluteUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseJdCloudCodingPlansFromPageHtml(html) {
  const decodedHtml = decodeUnicodeLiteral(String(html || ""));
  const planMatches = decodedHtml.matchAll(
    /model:\{activityId:"[^"]+",title:"Coding\s+Plan\s+(Lite|Pro)\s*",[\s\S]{0,200}?desc:"([^"]+)",[\s\S]{0,120}?productPrice:"([^"]+)",[\s\S]{0,120}?originalPrice:"([^"]+)",[\s\S]{0,220}?buyConditionsOne:"([^"]+)",buyConditionsOneDesc:"([^"]+)",buyConditionsTwo:"([^"]+)",buyConditionsTwoDesc:"([^"]+)"/g,
  );
  const plans = [];

  for (const match of planMatches) {
    const tier = normalizeText(match[1]);
    const description = normalizeText(match[2]);
    const currentAmount = Number(String(match[3] || "").replace(/,/g, ""));
    const originalPrice = parsePriceText(normalizeText(match[4])).amount;
    const detailOneLabel = normalizeText(match[5]);
    const detailOneValue = normalizeText(match[6]);
    const detailTwoLabel = normalizeText(match[7]);
    const detailTwoValue = normalizeText(match[8]);

    plans.push(
      asPlan({
        name: `Coding Plan ${tier}`,
        currentPriceText: Number.isFinite(currentAmount) ? `¥${formatAmount(currentAmount)}/月` : null,
        currentPrice: Number.isFinite(currentAmount) ? currentAmount : null,
        originalPriceText: Number.isFinite(originalPrice) ? `¥${formatAmount(originalPrice)}/月` : null,
        originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
        unit: "月",
        serviceDetails: [
          description || null,
          detailOneLabel && detailOneValue ? `${detailOneLabel}：${detailOneValue}` : null,
          detailTwoLabel && detailTwoValue ? `${detailTwoLabel}：${detailTwoValue}` : null,
        ],
      }),
    );
  }

  if (plans.length > 0) {
    return dedupePlans(plans);
  }

  return parseJdCloudCodingPlansFromDocsText(decodedHtml);
}

async function loadExistingPricingSnapshot(outputFile = OUTPUT_FILE) {
  try {
    const raw = await fs.readFile(outputFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      providers: Array.isArray(parsed?.providers) ? parsed.providers : [],
      failures: Array.isArray(parsed?.failures) ? parsed.failures : [],
    };
  } catch {
    return {
      providers: [],
      failures: [],
    };
  }
}

function extractProviderIdFromFailure(failureMessage) {
  const matched = String(failureMessage || "").match(/^([^:]+):/);
  return matched ? matched[1].trim() : "";
}

function buildStaleProviderFallback(provider, failureMessage) {
  if (!provider || typeof provider !== "object") {
    return null;
  }

  return {
    ...provider,
    sourceUrls: unique(provider.sourceUrls || []),
    staleReason: STALE_PROVIDER_NOTICE,
    staleFailure: normalizeText(String(failureMessage || "")) || null,
  };
}

function restoreFailedProvidersFromSnapshot(providers, failures, snapshotProviders) {
  const restored = [...(providers || [])];
  const existingIds = new Set(restored.map((provider) => String(provider?.provider || "").trim()).filter(Boolean));
  const snapshotMap = new Map(
    (snapshotProviders || [])
      .filter((provider) => provider && typeof provider === "object")
      .map((provider) => [String(provider.provider || "").trim(), provider]),
  );

  for (const failure of failures || []) {
    const providerId = extractProviderIdFromFailure(failure);
    if (!providerId || existingIds.has(providerId) || !snapshotMap.has(providerId)) {
      continue;
    }

    const fallback = buildStaleProviderFallback(snapshotMap.get(providerId), failure);
    if (!fallback) {
      continue;
    }

    restored.push(fallback);
    existingIds.add(providerId);
  }

  return restored;
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
    if (/google-analytics|googletagmanager|hm\.baidu|sentry|qiyukf|datasink/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

async function fetchRenderedPageText(pageUrl, label, options = {}) {
  const chromium = await loadPlaywrightChromium(label);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await blockNonEssentialPlaywrightRequests(page);
    await page.goto(pageUrl, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: options.timeoutMs || 15_000,
    });
    if (options.waitForText) {
      await page.waitForFunction(
        (patternSource) => {
          const text = String(document.body?.innerText || "");
          return new RegExp(patternSource, "i").test(text);
        },
        options.waitForText.source || String(options.waitForText),
        { timeout: options.waitForTimeoutMs || 12_000 },
      );
    } else if (options.settleMs) {
      await page.waitForTimeout(options.settleMs);
    }

    const text = await page.evaluate(() => String(document.body?.innerText || ""));
    return {
      text: normalizeText(text),
      url: page.url(),
    };
  } finally {
    await browser.close();
  }
}

async function fetchRenderedPageHtml(pageUrl, label, options = {}) {
  const chromium = await loadPlaywrightChromium(label);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await blockNonEssentialPlaywrightRequests(page);
    await page.goto(pageUrl, {
      waitUntil: options.waitUntil || "domcontentloaded",
      timeout: options.timeoutMs || 15_000,
    });
    if (options.waitForText) {
      await page.waitForFunction(
        (patternSource) => {
          const text = String(document.body?.innerText || "");
          return new RegExp(patternSource, "i").test(text);
        },
        options.waitForText.source || String(options.waitForText),
        { timeout: options.waitForTimeoutMs || 12_000 },
      );
    } else if (options.settleMs) {
      await page.waitForTimeout(options.settleMs);
    }

    const [html, text] = await Promise.all([
      page.evaluate(() => String(document.documentElement?.outerHTML || "")),
      page.evaluate(() => String(document.body?.innerText || "")),
    ]);
    return {
      html,
      text: normalizeText(text),
      url: page.url(),
    };
  } finally {
    await browser.close();
  }
}

function timeUnitLabel(value) {
  if (value === "TIME_UNIT_MONTH") {
    return "月";
  }
  if (value === "TIME_UNIT_YEAR") {
    return "年";
  }
  if (value === "TIME_UNIT_DAY") {
    return "日";
  }
  return null;
}

function isMonthlyUnit(value) {
  const unit = normalizeText(value).toLowerCase();
  if (!unit) {
    return false;
  }
  return /^(月|month|monthly)$/.test(unit);
}

function isMonthlyPriceText(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  if (/首月|first\s*month/i.test(text)) {
    return false;
  }
  return /\/\s*(月|month|monthly)/i.test(text);
}

function isStandardMonthlyPlan(plan) {
  const priceText = normalizeText(plan?.currentPriceText || "");
  const hasMonthlyUnit = isMonthlyUnit(plan?.unit);
  const hasMonthlyPriceText = isMonthlyPriceText(priceText);
  if (priceText && /首月|first\s*month/i.test(priceText)) {
    return false;
  }
  if (!hasMonthlyUnit && !hasMonthlyPriceText) {
    return false;
  }
  if (priceText && /\/\s*(年|季|quarter|year|day|日)/i.test(priceText)) {
    return false;
  }
  return true;
}

function keepStandardMonthlyPlans(plans) {
  return dedupePlans((plans || []).filter((plan) => isStandardMonthlyPlan(plan)));
}

function stripSimpleMarkdown(text) {
  return normalizeText(text)
    .replace(/<label>\s*([^<]+)\s*<\/label>/gi, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "")
    .trim();
}

function parseKimiFeatureCandidates(bundleText) {
  const candidates = [];
  const planRegex = /title:"([^"]+)",price:([0-9]+),features:\{"zh-CN":\[((?:\{text:"[^"]*"(?:,group:!0)?\},?)*)\]/g;
  let planMatch;
  while ((planMatch = planRegex.exec(bundleText)) !== null) {
    const title = normalizeText(planMatch[1]);
    const price = Number(planMatch[2]);
    const featureBlob = planMatch[3] || "";
    const features = unique(
      [...featureBlob.matchAll(/text:"([^"]+)"/g)]
        .map((item) => stripSimpleMarkdown(item[1]))
        .filter(Boolean),
    );
    if (!title || features.length === 0) {
      continue;
    }
    candidates.push({
      title,
      price: Number.isFinite(price) ? price : null,
      features,
    });
  }
  return candidates;
}

function pickKimiFeaturesByTitleAndPrice(candidates, title, currentPrice) {
  const normalizedTitle = normalizeText(title).toLowerCase();
  const matches = (candidates || []).filter((item) => normalizeText(item.title).toLowerCase() === normalizedTitle);
  if (matches.length === 0) {
    return null;
  }
  const exact = matches.find((item) => Number.isFinite(item.price) && Number.isFinite(currentPrice) && item.price === currentPrice);
  if (exact) {
    return exact.features;
  }
  return matches[0].features;
}

function getKimiCurrencySymbol(currency) {
  const normalized = normalizeText(currency).toUpperCase();
  if (normalized === "CNY" || normalized === "RMB") {
    return "¥";
  }
  return "$";
}

function getKimiCurrencyLabel(currency) {
  const normalized = normalizeText(currency).toUpperCase();
  return KIMI_CURRENCY_LABELS[normalized] || normalized || "未标注";
}

function getKimiRegionLabel(region) {
  return KIMI_REGION_LABELS[normalizeText(region)] || normalizeText(region) || "未标注";
}

function formatKimiPlanName(title, regionLabel) {
  const normalizedTitle = normalizeText(title);
  return regionLabel ? `${normalizedTitle}（${regionLabel}）` : normalizedTitle;
}

function parseKimiDomesticMembershipPlansFromText(pageText) {
  const text = String(pageText || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const rowByName = new Map();
  const rowPattern = new RegExp(
    `^(${KIMI_DOMESTIC_PLAN_NAMES.join("|")})\\s+(.+?)\\s+(¥[0-9,]+(?:\\.[0-9]+)?\\s*\\/\\s*月|¥0\\s*\\/\\s*月)\\s+`,
  );

  for (const line of lines) {
    const matched = line.match(rowPattern);
    if (!matched) {
      continue;
    }
    rowByName.set(matched[1], {
      title: matched[1],
      position: normalizeText(matched[2]),
      priceText: normalizeText(matched[3]).replace(/\s*\/\s*/g, "/"),
    });
  }

  const plans = [];
  for (let index = 0; index < KIMI_DOMESTIC_PLAN_NAMES.length; index += 1) {
    const title = KIMI_DOMESTIC_PLAN_NAMES[index];
    const row = rowByName.get(title);
    if (!row) {
      continue;
    }

    const nextTitles = KIMI_DOMESTIC_PLAN_NAMES.slice(index + 1).join("|");
    const nextPlanBoundary = nextTitles ? `\\n(?:${nextTitles})\\s*[—-]|` : "";
    const sectionPattern = new RegExp(
      `${title}\\s*[—-]\\s*[^\\n]+\\n([\\s\\S]*?)(?=${nextPlanBoundary}\\n以上\\s*Agent|\\n额度说明|$)`,
    );
    const sectionMatch = text.match(sectionPattern);
    const detailLines = sectionMatch
      ? sectionMatch[1]
          .split("\n")
          .map((line) => normalizeText(line))
          .filter((line) => line && !/^在\s+.+基础上[:：]?$/.test(line))
      : [];
    const currentPrice = parseAmountFromPriceText(row.priceText);

    plans.push(
      asPlan({
        name: formatKimiPlanName(title, "大陆"),
        currentPriceText: row.priceText,
        currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        unit: "月",
        notes: title === "Adagio" ? "免费体验" : null,
        serviceDetails: [
          "计价币种: 人民币（CNY）",
          "适用区域: 大陆",
          row.position ? `套餐定位: ${row.position}` : null,
          ...detailLines,
        ],
      }),
    );
  }

  return dedupePlans(plans);
}

function parseJdCloudCodingPlansFromDocsText(pageText) {
  const rawText = decodeUnicodeLiteral(String(pageText || ""));
  const text = /<[^>]+>/.test(rawText) ? normalizeText(stripTags(rawText)) : normalizeText(rawText);
  if (!/Coding\s*Plan/i.test(text) || !/套餐详情/.test(text)) {
    return [];
  }

  const modelsMatch = text.match(/模型自由切换：[^。]*?包括：([^。]+)。/);
  const toolsMatch = text.match(/兼容主流工具：([^。]+)。/);
  const modelsText = normalizeText(modelsMatch?.[1] || "");
  const toolsText = normalizeText(toolsMatch?.[1] || "");
  const sharedQuotaText =
    /多工具之间套餐额度共享/.test(text) && !/多工具之间套餐额度共享/.test(toolsText)
      ? "多工具之间套餐额度共享"
      : null;
  const priceNote = "价格未在套餐概览页公开；计价币种: 人民币（CNY）";

  const plans = [];
  for (const tier of ["Lite", "Pro"]) {
    const tierPattern = new RegExp(
      `${tier}\\s*套餐\\s+(.+?)\\s+((?:Lite\\s*套餐的\\s*5\\s*倍用量。\\s*)?每\\s*5\\s*小时：最多约\\s*[0-9,，]+\\s*次请求。\\s*每周：最多约\\s*[0-9,，]+\\s*次请求。\\s*每订阅月：最多约\\s*[0-9,，]+\\s*次请求。)`,
      "i",
    );
    const tierMatch = text.match(tierPattern);
    if (!tierMatch) {
      continue;
    }

    const audience = normalizeText(tierMatch[1]);
    const usageLimit = normalizeText(tierMatch[2]).replace(/，/g, ",");
    plans.push(
      asPlan({
        name: `Coding Plan ${tier}`,
        unit: "月",
        notes: priceNote,
        serviceDetails: [
          audience ? `适用人群：${audience}` : null,
          usageLimit ? `用量限制：${usageLimit}` : null,
          modelsText ? `支持模型：${modelsText}` : null,
          toolsText ? `适配工具：${toolsText}` : null,
          sharedQuotaText,
        ],
      }),
    );
  }

  return dedupePlans(plans);
}

function mergeJdCloudPricingAndDocsPlans(pricingPlans, docsPlans) {
  const docsByTier = new Map(
    (docsPlans || []).map((plan) => [normalizeText(plan?.name || "").replace(/^Coding\s+Plan\s+/i, "").toLowerCase(), plan]),
  );

  return dedupePlans(
    (pricingPlans || []).map((plan) => {
      const tier = normalizeText(plan?.name || "").replace(/^Coding\s+Plan\s+/i, "").toLowerCase();
      const docsPlan = docsByTier.get(tier);
      if (!docsPlan) {
        return plan;
      }

      return {
        ...plan,
        serviceDetails: normalizeServiceDetails(docsPlan.serviceDetails || plan.serviceDetails),
      };
    }),
  );
}

function buildKimiCodePlansFromGoodsPayload(payload, options = {}) {
  const { featureCandidates = [], defaultRegion = "REGION_OVERSEA" } = options;
  const plans = [];

  for (const goods of payload?.goods || []) {
    const title = normalizeText(goods?.title || "");
    if (!title) {
      continue;
    }
    const unitLabel = timeUnitLabel(goods?.billingCycle?.timeUnit);
    if (unitLabel !== "月") {
      continue;
    }

    const region = normalizeText(goods?.useRegion || defaultRegion);
    const regionLabel = getKimiRegionLabel(region);
    const membershipLevel = normalizeText(goods?.membershipLevel || "");
    const membershipLabel = KIMI_MEMBERSHIP_LEVEL_LABELS[membershipLevel] || membershipLevel;
    const amounts = Array.isArray(goods?.amounts) ? goods.amounts : [];
    for (const amount of amounts) {
      const cents = Number(amount?.priceInCents);
      if (!Number.isFinite(cents)) {
        continue;
      }
      const currency = normalizeText(amount?.currency || (region === "REGION_MAINLAND" ? "CNY" : "USD")).toUpperCase();
      const value = cents / 100;
      const symbol = getKimiCurrencySymbol(currency);
      const planFeatures = pickKimiFeaturesByTitleAndPrice(featureCandidates, title, value);
      const isTrialPlan = /^adagio$/i.test(title) || value === 0;

      plans.push(
        asPlan({
          name: formatKimiPlanName(title, regionLabel),
          currentPriceText: `${symbol}${formatAmount(value)}/${unitLabel}`,
          currentPrice: value,
          unit: unitLabel,
          notes: isTrialPlan ? "试用计划" : null,
          serviceDetails: [
            `计价币种: ${getKimiCurrencyLabel(currency)}`,
            `适用区域: ${regionLabel}`,
            membershipLabel ? `会员等级: ${membershipLabel}` : null,
            ...(planFeatures || []),
            !planFeatures && isTrialPlan ? "Kimi Code 试用套餐权益" : null,
            !planFeatures && !isTrialPlan ? "Kimi Code 月度订阅权益" : null,
          ],
        }),
      );
    }
  }

  return dedupePlans(plans);
}

async function fetchKimiDomesticMembershipTextWithPlaywright() {
  const chromium = await loadPlaywrightChromium("Kimi domestic membership parser");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await blockNonEssentialPlaywrightRequests(page);
    await page.goto(KIMI_DOMESTIC_MEMBERSHIP_URL, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForFunction(
      () => {
        const text = String(document.body?.innerText || "");
        return /订阅方式与价格/.test(text) && /Kimi Code/.test(text) && /人民币|¥/.test(text);
      },
      { timeout: 20_000 },
    );
    return await page.evaluate(() => String(document.body?.innerText || ""));
  } finally {
    await browser.close();
  }
}

async function parseKimiCodingPlans() {
  const domesticHelpText = await fetchKimiDomesticMembershipTextWithPlaywright();
  const domesticPlans = parseKimiDomesticMembershipPlansFromText(domesticHelpText);

  const pageHtml = await fetchText(KIMI_OVERSEAS_CODE_URL);
  const commonScriptRaw =
    pageHtml.match(/\/\/statics\.moonshot\.cn\/kimi-web-seo\/assets\/common-[^"'\s]+\.js/i)?.[0] || null;
  const commonScriptUrl = commonScriptRaw ? absoluteUrl(commonScriptRaw, KIMI_OVERSEAS_CODE_URL) : null;
  let featureCandidates = [];
  if (commonScriptUrl) {
    try {
      const commonScriptText = await fetchText(commonScriptUrl);
      featureCandidates = parseKimiFeatureCandidates(commonScriptText);
    } catch {
      featureCandidates = [];
    }
  }
  const payload = await fetchJson(KIMI_GOODS_API_URL, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: "https://www.kimi.com",
      referer: KIMI_OVERSEAS_CODE_URL,
    },
    body: "{}",
  });
  const overseasPlans = buildKimiCodePlansFromGoodsPayload(payload, { featureCandidates });
  const plans = dedupePlans([...domesticPlans, ...overseasPlans]);
  if (plans.length === 0) {
    throw new Error("Unable to build Kimi domestic or overseas plans");
  }

  return {
    provider: PROVIDER_IDS.KIMI,
    sourceUrls: unique([KIMI_DOMESTIC_MEMBERSHIP_URL, KIMI_OVERSEAS_CODE_URL, KIMI_GOODS_API_URL, commonScriptUrl]),
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

async function parseXfyunCodingPlans() {
  const pageUrl = "https://maas.xfyun.cn/modelSquare";
  const docUrl = "https://www.xfyun.cn/doc/spark/CodingPlan.html";
  const html = await fetchText(docUrl);
  const rows = extractRows(html);

  const pricingHeaderIndex = rows.findIndex(
    (row) => normalizeText(row?.[0] || "") === "套餐类型" && normalizeText(row?.[1] || "") === "价格",
  );
  if (pricingHeaderIndex < 0) {
    throw new Error("Unable to locate XFYun coding plan pricing table");
  }

  const pricingRows = [];
  for (let index = pricingHeaderIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const name = normalizeText(row?.[0] || "");
    if (!name || !/版$/.test(name)) {
      break;
    }
    pricingRows.push(row);
  }

  if (pricingRows.length === 0) {
    throw new Error("Unable to parse XFYun coding plan pricing rows");
  }

  const flowHeaderIndex = rows.findIndex(
    (row) => normalizeText(row?.[0] || "") === "流控维度" && normalizeText(row?.[1] || "") === "说明",
  );
  const flowDetails = [];
  if (flowHeaderIndex >= 0) {
    for (let index = flowHeaderIndex + 1; index < rows.length; index += 1) {
      const row = rows[index] || [];
      const label = normalizeText(row?.[0] || "");
      const value = normalizeText(row?.[1] || "");
      if (!label || !value || /^版本$/.test(label)) {
        break;
      }
      flowDetails.push(`${label}: ${value}`);
    }
  }

  const hasIteratedVersion = /价格与支持模型[^。；]*保持一致[\s\S]*?流控方式将调整为[^。；]*请求次数/i.test(html);
  const plans = pricingRows.map((row) => {
    const name = normalizeText(row?.[0] || "");
    const priceInfo = parseFirstPurchaseAndAddonPrices(row?.[1] || "");
    const currentAmount = priceInfo.addonAmount ?? priceInfo.firstPurchaseAmount;
    const notes = [
      Number.isFinite(priceInfo.firstPurchaseAmount) && Number.isFinite(priceInfo.addonAmount)
        ? `首购优惠：¥${formatAmount(priceInfo.firstPurchaseAmount)}/月`
        : null,
      hasIteratedVersion ? "次月迭代版价格与支持模型不变，流控将改为 5 小时/周/月请求次数" : null,
    ]
      .filter(Boolean)
      .join("；");

    return asPlan({
      name: `Astron Coding Plan ${name}`,
      currentPriceText: Number.isFinite(currentAmount) ? `¥${formatAmount(currentAmount)}/月` : priceInfo.text,
      currentPrice: Number.isFinite(currentAmount) ? currentAmount : null,
      unit: "月",
      notes,
      serviceDetails: [
        normalizeText(row?.[2] || "") ? `支持模型: ${normalizeText(row[2])}` : null,
        normalizeText(row?.[3] || "") ? `日 Tokens 上限: ${normalizeText(row[3])}` : null,
        normalizeText(row?.[4] || "") ? `QPS: ${normalizeText(row[4])}` : null,
        /支持升级|叠加购买/i.test(html) ? "支持升级与同档位叠加购买" : null,
      ],
    });
  });

  return {
    provider: PROVIDER_IDS.XFYUN,
    sourceUrls: [pageUrl, docUrl],
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseTencentCodingPlansWithPlaywright(pageUrl) {
  let chromium;
  try {
    ({ chromium } = require("@playwright/test"));
  } catch {
    throw new Error("Playwright is unavailable for Tencent fallback");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    await page.waitForSelector("table", { timeout: 5_000 });

    const tableData = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const tables = Array.from(document.querySelectorAll("table"));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
          Array.from(row.querySelectorAll("th,td")).map((cell) => normalize(cell.textContent)),
        );
        const header = rows.find(
          (row) => row.some((cell) => /Lite\s*套餐/i.test(cell)) && row.some((cell) => /Pro\s*套餐/i.test(cell)),
        );
        if (header) {
          return rows;
        }
      }
      return [];
    });

    if (!Array.isArray(tableData) || tableData.length === 0) {
      throw new Error("Unable to locate Tencent coding plan table via Playwright");
    }

    const pageText = await page.evaluate(() => String(document.body?.innerText || ""));
    const buyHref = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll("a")).find((anchor) => /购买页/.test(String(anchor.textContent || "")));
      return link ? link.href : null;
    });

    return {
      rows: tableData,
      plainText: pageText,
      buyUrl: buyHref || null,
    };
  } finally {
    await browser.close();
  }
}

async function parseZhipuCodingPlansWithPlaywright() {
  const pageUrl = "https://bigmodel.cn/glm-coding";
  const docsUrl = "https://docs.bigmodel.cn/cn/coding-plan/overview";
  const chromium = await loadPlaywrightChromium("Zhipu parser");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await blockNonEssentialPlaywrightRequests(page);
    await page.goto(pageUrl, {
      waitUntil: "commit",
      timeout: 20_000,
    });
    await page.waitForFunction(
      () => {
        const text = String(document.body?.innerText || "");
        return /即刻与\s*GLM\s*一起\s*Coding/.test(text) && /连续包[月季年]/.test(text) && /特惠订阅/.test(text);
      },
      { timeout: 20_000 },
    );
    await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const monthlyTab =
        Array.from(document.querySelectorAll(".switch-tab-item")).find((node) => /连续包月/.test(normalize(node.textContent)))
        || Array.from(document.querySelectorAll("*")).find((node) => normalize(node.textContent) === "连续包月");
      const clickable = monthlyTab?.closest?.(".switch-tab-item") || monthlyTab?.parentElement || monthlyTab;
      if (clickable && typeof clickable.click === "function") {
        clickable.click();
      }
    });
    await page.waitForFunction(
      () => {
        const activeTabText = String(document.querySelector(".switch-tab-item.active")?.textContent || "");
        const cards = Array.from(document.querySelectorAll(".claude-code-package-box .package-card"));
        return /连续包月/.test(activeTabText) && cards.length >= 3;
      },
      { timeout: 10_000 },
    );

    const extracted = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cleanup = (value) => normalize(value).replace(/^[^A-Za-z0-9\u4e00-\u9fa5¥￥]+/, "");
      const cards = Array.from(document.querySelectorAll(".claude-code-package-box .package-card")).map((card) => {
        const tier = cleanup(card.querySelector(".package-card-title .font-prompt")?.textContent || "");
        const currentPriceText = cleanup(card.querySelector(".package-card-sale-price")?.textContent || "");
        const originalPriceText = cleanup(card.querySelector(".package-card-original-price")?.textContent || "");
        const notes = cleanup(card.querySelector(".package-card-next-price-box")?.textContent || "");
        const featureTitle = cleanup(card.querySelector(".package-card-attr-title span")?.textContent || "");
        const serviceDetails = Array.from(card.querySelectorAll(".package-card-attr-item"))
          .map((node) => cleanup(node.textContent))
          .filter(Boolean);

        return {
          tier,
          currentPriceText,
          originalPriceText,
          notes,
          serviceDetails: featureTitle ? [featureTitle, ...serviceDetails] : serviceDetails,
        };
      });

      return {
        activeTabText: normalize(document.querySelector(".switch-tab-item.active")?.textContent || ""),
        cards,
      };
    });

    if (!/连续包月/.test(extracted?.activeTabText || "")) {
      throw new Error(`Unable to switch Zhipu pricing page to monthly tab (active: ${extracted?.activeTabText || "unknown"})`);
    }

    const extractedPlans = Array.isArray(extracted?.cards)
      ? extracted.cards.filter(
          (plan) =>
            /^(Lite|Pro|Max)$/.test(plan?.tier || "")
            && /^￥\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*月$/.test(plan?.currentPriceText || ""),
        )
      : [];

    if (extractedPlans.length === 0) {
      throw new Error("Unable to parse Zhipu coding pricing cards via Playwright");
    }

    return {
      provider: PROVIDER_IDS.ZHIPU,
      sourceUrls: unique([pageUrl, docsUrl]),
      fetchedAt: new Date().toISOString(),
      plans: dedupePlans(
        extractedPlans.map((plan) =>
          asPlan({
            name: `GLM Coding ${plan.tier}`,
            currentPriceText: plan.currentPriceText,
            originalPriceText: plan.originalPriceText,
            notes: plan.notes,
            serviceDetails: plan.serviceDetails,
          }),
        ),
      ),
    };
  } finally {
    await browser.close();
  }
}

async function parseZhipuCodingPlansFromLegacyBundle() {
  const pageUrl = "https://bigmodel.cn/glm-coding";
  const html = await fetchText(pageUrl);
  const appPath = html.match(/\/js\/app\.[0-9a-f]+\.js/i)?.[0];
  if (!appPath) {
    throw new Error("Unable to locate Zhipu app script");
  }
  const appUrl = absoluteUrl(appPath, pageUrl);
  const appJs = await fetchText(appUrl);
  const pricingChunkHash = appJs.match(/"chunk-0d4f69d1"\s*:\s*"([0-9a-f]+)"/i)?.[1];
  if (!pricingChunkHash) {
    throw new Error("Unable to locate Zhipu coding pricing chunk");
  }
  const pricingChunkUrl = absoluteUrl(`/js/chunk-0d4f69d1.${pricingChunkHash}.js`, pageUrl);
  const pricingChunkText = await fetchText(pricingChunkUrl);
  const moduleStart = pricingChunkText.indexOf('"566a":function');
  if (moduleStart < 0) {
    throw new Error("Unable to locate Zhipu coding pricing module");
  }
  const nextModuleMatch = pricingChunkText.slice(moduleStart + 1).match(/},\"[0-9a-z]{4,6}\":function/i);
  const moduleEnd = nextModuleMatch ? moduleStart + 1 + nextModuleMatch.index : pricingChunkText.length;
  const moduleSection = pricingChunkText.slice(moduleStart, moduleEnd);

  const extractStringField = (body, key) => {
    const match = body.match(new RegExp(`${key}:"([^"]*)"`));
    return match ? match[1] : null;
  };
  const extractNumberField = (body, key) => {
    const match = body.match(new RegExp(`${key}:([0-9]+(?:\\.[0-9]+)?)`));
    return match ? Number(match[1]) : null;
  };

  const cardRegex = /Object\(i\["a"\]\)\(\{([\s\S]*?)\},n\.(lite|pro|max)\)/g;
  const cardItems = [];
  let cardMatch;
  while ((cardMatch = cardRegex.exec(moduleSection)) !== null) {
    const body = cardMatch[1];
    const productName = extractStringField(body, "productName");
    if (!productName || !/^GLM Coding (Lite|Pro|Max)$/.test(productName)) {
      continue;
    }
    cardItems.push({
      productId: extractStringField(body, "productId"),
      productName,
      salePrice: extractNumberField(body, "salePrice"),
      originalPrice: extractNumberField(body, "originalPrice"),
      renewAmount: extractNumberField(body, "renewAmount"),
      unit: extractStringField(body, "unit"),
      unitText: extractStringField(body, "unitText"),
      tagText: extractStringField(body, "tagText"),
      version: extractStringField(body, "version"),
    });
  }
  if (cardItems.length === 0) {
    throw new Error("Unable to parse Zhipu coding pricing cards");
  }

  const selectedCards = (() => {
    const v2Cards = cardItems.filter((item) => item.version === "v2");
    return v2Cards.length >= 3 ? v2Cards : cardItems;
  })();

  const unitOrder = { month: 0, quarter: 1, year: 2 };
  const tierOrder = { Lite: 0, Pro: 1, Max: 2 };
  const sortedCards = [...selectedCards]
    .filter(
      (item) =>
        item.productName && item.unitText && Number.isFinite(item.salePrice) && String(item.unit).toLowerCase() === "month",
    )
    .sort((left, right) => {
      const leftUnit = unitOrder[left.unit] ?? 99;
      const rightUnit = unitOrder[right.unit] ?? 99;
      if (leftUnit !== rightUnit) {
        return leftUnit - rightUnit;
      }
      const leftTier = left.productName.replace("GLM Coding ", "");
      const rightTier = right.productName.replace("GLM Coding ", "");
      return (tierOrder[leftTier] ?? 99) - (tierOrder[rightTier] ?? 99);
    });

  const renewLabelByUnit = {
    month: "下个月度续费金额",
    quarter: "下个季度续费金额",
    year: "下个年度续费金额",
  };
  const docsUrl = "https://docs.bigmodel.cn/cn/coding-plan/overview";
  const serviceDetailsByTier = new Map();
  try {
    const docsHtml = await fetchText(docsUrl);
    const docsRows = extractRows(docsHtml);
    const headerRow = docsRows.find((row) => normalizeText(row?.[0] || "") === "套餐类型" && row.length >= 3) || null;
    if (headerRow) {
      for (const row of docsRows) {
        const tierMatch = normalizeText(row?.[0] || "").match(/^(Lite|Pro|Max)\s*套餐$/i);
        if (!tierMatch) {
          continue;
        }
        const serviceDetails = [];
        for (let column = 1; column < Math.min(headerRow.length, row.length); column += 1) {
          const label = normalizeText(headerRow[column]);
          const value = normalizeText(row[column]);
          if (!label || !value) {
            continue;
          }
          serviceDetails.push(`${label}: ${value}`);
        }
        serviceDetailsByTier.set(tierMatch[1], normalizeServiceDetails(serviceDetails));
      }
    }
  } catch {
    // Keep pricing fetch resilient when docs service metadata is temporarily unavailable.
  }
  const plans = [];
  const seen = new Set();
  for (const card of sortedCards) {
    const uniqueKey = `${card.productName}|${card.unit}`;
    if (seen.has(uniqueKey)) {
      continue;
    }
    seen.add(uniqueKey);
    const currentPriceText = `¥${formatAmount(card.salePrice)}/${card.unitText}`;
    const originalPriceText =
      Number.isFinite(card.originalPrice) && card.originalPrice > card.salePrice
        ? `¥${formatAmount(card.originalPrice)}/${card.unitText}`
        : null;
    const renewText = Number.isFinite(card.renewAmount)
      ? `${renewLabelByUnit[card.unit] || "续费金额"}：¥${formatAmount(card.renewAmount)}`
      : null;
    const tier = card.productName.replace("GLM Coding ", "");
    plans.push(
      asPlan({
        name: `${card.productName} (${card.unitText})`,
        currentPriceText,
        currentPrice: card.salePrice,
        originalPriceText,
        originalPrice: Number.isFinite(card.originalPrice) ? card.originalPrice : null,
        unit: card.unitText,
        notes: [card.tagText || "", renewText || ""].filter(Boolean).join("；"),
        serviceDetails: serviceDetailsByTier.get(tier) || null,
      }),
    );
  }
  if (plans.length === 0) {
    throw new Error("Unable to build Zhipu coding plans");
  }

  return {
    provider: PROVIDER_IDS.ZHIPU,
    sourceUrls: unique([pageUrl, appUrl, pricingChunkUrl, docsUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseZhipuCodingPlansFromClaudeCodeBundle() {
  const pageUrl = "https://bigmodel.cn/glm-coding";
  const docsUrl = "https://docs.bigmodel.cn/cn/coding-plan/overview";
  const html = await fetchText(pageUrl);
  const appPath = html.match(/\/js\/app\.[0-9a-f]+\.js/i)?.[0];
  if (!appPath) {
    throw new Error("Unable to locate Zhipu app script");
  }

  const appUrl = absoluteUrl(appPath, pageUrl);
  const appJs = await fetchText(appUrl);
  const claudeCodeChunkHash =
    appJs.match(/(?:^|[,\{])ClaudeCode:"([0-9a-f]+)"/i)?.[1]
    || appJs.match(/"ClaudeCode":"([0-9a-f]+)"/i)?.[1];
  if (!claudeCodeChunkHash) {
    throw new Error("Unable to locate Zhipu ClaudeCode chunk");
  }

  const pricingChunkUrl = absoluteUrl(`/js/ClaudeCode.${claudeCodeChunkHash}.js`, pageUrl);
  const pricingChunkText = await fetchText(pricingChunkUrl);

  const extractStringField = (body, key) => {
    const match = body.match(new RegExp(`${key}:"([^"]*)"`));
    return match ? match[1] : null;
  };
  const extractNumberField = (body, key) => {
    const match = body.match(new RegExp(`${key}:([0-9]+(?:\.[0-9]+)?)`));
    return match ? Number(match[1]) : null;
  };

  const cardRegex = /Object\(i\["a"\]\)\(\{([\s\S]*?)\},n\.(lite|pro|max)\)/g;
  const cardItems = [];
  let cardMatch;
  while ((cardMatch = cardRegex.exec(pricingChunkText)) !== null) {
    const body = cardMatch[1];
    const productName = extractStringField(body, "productName");
    const unit = extractStringField(body, "unit");
    if (!productName || !unit || !/^(Lite|Pro|Max)$/.test(productName)) {
      continue;
    }
    cardItems.push({
      productId: extractStringField(body, "productId"),
      productName,
      salePrice: extractNumberField(body, "salePrice"),
      originalPrice: extractNumberField(body, "originalPrice"),
      renewAmount: extractNumberField(body, "renewAmount"),
      tagText: extractStringField(body, "tagText"),
      attrTitle: extractStringField(body, "attrTitle"),
      unit,
      unitText: extractStringField(body, "unitText") || timeUnitLabel(unit),
      monthStep: extractNumberField(body, "monthStep"),
      stepUnit: extractStringField(body, "stepUnit"),
      version: extractStringField(body, "version"),
      tierHint: cardMatch[2],
    });
  }

  if (cardItems.length === 0) {
    throw new Error("Unable to locate Zhipu coding plan cards in ClaudeCode chunk");
  }

  const serviceDetailsByTier = new Map();
  try {
    const docsHtml = await fetchText(docsUrl);
    const docsRows = extractRows(docsHtml);
    const headerRow = docsRows.find((row) => normalizeText(row?.[0] || "") === "套餐类型" && row.length >= 3) || null;
    if (headerRow) {
      for (const row of docsRows) {
        const tierMatch = normalizeText(row?.[0] || "").match(/^(Lite|Pro|Max)\s*套餐$/i);
        if (!tierMatch) {
          continue;
        }
        const serviceDetails = [];
        for (let column = 1; column < Math.min(headerRow.length, row.length); column += 1) {
          const label = normalizeText(headerRow[column]);
          const value = normalizeText(row[column]);
          if (!label || !value) {
            continue;
          }
          serviceDetails.push(`${label}: ${value}`);
        }
        serviceDetailsByTier.set(tierMatch[1], normalizeServiceDetails(serviceDetails));
      }
    }
  } catch {
    // Keep pricing fetch resilient when docs service metadata is temporarily unavailable.
  }

  const versionedMonthlyCards = cardItems.filter((item) => item.version === "v2" && item.unit === "month");
  const versionedCards = cardItems.filter((item) => item.version === "v2");
  const monthlyCards = cardItems.filter((item) => item.unit === "month");
  const cardsToBuild =
    versionedMonthlyCards.length > 0
      ? versionedMonthlyCards
      : versionedCards.length > 0
        ? versionedCards
        : monthlyCards.length > 0
          ? monthlyCards
          : cardItems;

  const renewLabelByUnit = {
    month: "下个月度续费金额",
    quarter: "下个季度续费金额",
    year: "下个年度续费金额",
  };
  const unitOrder = { month: 0, quarter: 1, year: 2 };
  const tierOrder = { Lite: 0, Pro: 1, Max: 2 };
  const plans = dedupePlans(
    cardsToBuild
      .filter((card) => Number.isFinite(card.salePrice) && card.unitText)
      .sort((left, right) => {
        const unitCompare = (unitOrder[left.unit] ?? 99) - (unitOrder[right.unit] ?? 99);
        if (unitCompare !== 0) {
          return unitCompare;
        }
        return (tierOrder[left.productName] ?? 99) - (tierOrder[right.productName] ?? 99);
      })
      .map((card) => {
        const monthlyAmount = Number.isFinite(card.monthStep) && card.monthStep > 0 ? card.salePrice / card.monthStep : card.salePrice;
        const monthlyOriginalAmount =
          Number.isFinite(card.originalPrice) && Number.isFinite(card.monthStep) && card.monthStep > 0
            ? card.originalPrice / card.monthStep
            : card.originalPrice;
        const unitLabel = card.stepUnit || card.unitText;
        const notes = [
          card.tagText || "",
          Number.isFinite(card.renewAmount) ? `${renewLabelByUnit[card.unit] || "续费金额"}：¥${formatAmount(card.renewAmount)}` : "",
        ]
          .filter(Boolean)
          .join("；");
        const serviceDetails = serviceDetailsByTier.get(card.productName);
        const normalizedServiceDetails = normalizeServiceDetails(serviceDetails || [card.attrTitle || ""].filter(Boolean));

        return asPlan({
          name: `GLM Coding ${card.productName}`,
          currentPriceText: `¥${formatAmount(monthlyAmount)}/${unitLabel}`,
          currentPrice: monthlyAmount,
          originalPriceText:
            Number.isFinite(monthlyOriginalAmount) && monthlyOriginalAmount > monthlyAmount
              ? `¥${formatAmount(monthlyOriginalAmount)}/${unitLabel}`
              : null,
          originalPrice: Number.isFinite(monthlyOriginalAmount) ? monthlyOriginalAmount : null,
          unit: unitLabel,
          notes,
          serviceDetails: normalizedServiceDetails,
        });
      }),
  );

  if (plans.length === 0) {
    throw new Error("Unable to build Zhipu coding plans from ClaudeCode chunk");
  }

  return {
    provider: PROVIDER_IDS.ZHIPU,
    sourceUrls: unique([pageUrl, appUrl, pricingChunkUrl, docsUrl]),
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

async function parseZhipuCodingPlans() {
  let playwrightError = null;
  try {
    return await parseZhipuCodingPlansWithPlaywright();
  } catch (error) {
    playwrightError = error;
  }

  let bundleError = null;
  try {
    return await parseZhipuCodingPlansFromClaudeCodeBundle();
  } catch (error) {
    bundleError = error;
  }

  let legacyError = null;
  try {
    return await parseZhipuCodingPlansFromLegacyBundle();
  } catch (error) {
    legacyError = error;
  }

  try {
    throw new Error("Unreachable");
  } catch {
    const reasons = [];
    if (playwrightError) {
      reasons.push(`Playwright parse failed: ${playwrightError.message || playwrightError}`);
    }
    if (bundleError) {
      reasons.push(`Pure JS parse failed: ${bundleError.message || bundleError}`);
    }
    if (legacyError) {
      reasons.push(`Legacy JS parse failed: ${legacyError.message || legacyError}`);
    }
    throw new Error(reasons.join("; "));
  }
}

async function parseMinimaxCodingPlans() {
  const pageUrl = "https://platform.minimaxi.com/subscribe/token-plan";
  const docsUrl = "https://platform.minimaxi.com/docs/token-plan/intro";
  const apiUrl = "https://www.minimaxi.com/public/api/openplatform/charge/combo/products?cycle_type=1&biz_line=2&resource_package_type=7";
  const data = await fetchJson(apiUrl);
  const packages = Array.isArray(data?.cycle_resource_packages) ? data.cycle_resource_packages : [];
  const plans = dedupePlans(
    packages
      .filter((item) => item && item.visible !== false)
      .map((item) => {
        const priceTag = normalizeText(item?.price_data?.price_tag || "");
        const originalPriceTag = normalizeText(item?.price_data?.original_price_tag || "");
        const renewPriceTag = normalizeText(item?.price_data?.renew_price_tag || "");
        const currentPrice = priceTag ? Number(priceTag) : null;
        const originalPrice = originalPriceTag ? Number(originalPriceTag) : null;
        const renewPrice = renewPriceTag ? Number(renewPriceTag) : null;
        const usageText = normalizeText(Array.isArray(item.credit_benefit) ? item.credit_benefit[0] : "");

        return asPlan({
          name: item.title,
          currentPriceText: Number.isFinite(currentPrice) ? `¥${formatAmount(currentPrice)}/月` : normalizeText(item.instruction),
          currentPrice,
          originalPriceText:
            Number.isFinite(originalPrice) && Number.isFinite(currentPrice) && originalPrice > currentPrice
              ? `¥${formatAmount(originalPrice)}/月`
              : null,
          originalPrice:
            Number.isFinite(originalPrice) && Number.isFinite(currentPrice) && originalPrice > currentPrice ? originalPrice : null,
          unit: "月",
          notes: usageText ? `用量: ${usageText}` : Number.isFinite(renewPrice) ? `续费金额：¥${formatAmount(renewPrice)}/月` : null,
          serviceDetails: normalizeServiceDetails([
            ...(Array.isArray(item.credit_benefit) ? item.credit_benefit : []),
            ...(item.feature_title ? [item.feature_title] : []),
            ...(Array.isArray(item.feature_benefit) ? item.feature_benefit : []),
          ]),
        });
      }),
  );

  if (plans.length === 0) {
    throw new Error("Unable to build MiniMax token plans from combo products API");
  }

  return {
    provider: PROVIDER_IDS.MINIMAX,
    sourceUrls: unique([pageUrl, docsUrl, apiUrl]),
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

async function parseBaiduCodingPlans() {
  const pageUrl = "https://cloud.baidu.com/product/codingplan.html";
  const html = await fetchText(pageUrl);

  const rows = extractRows(html);
  const planHeaderIndex = rows.findIndex(
    (row) => /coding\s*plan\s*lite/i.test(row.join(" ")) && /coding\s*plan\s*pro/i.test(row.join(" ")),
  );
  if (planHeaderIndex < 0) {
    throw new Error("Unable to locate Baidu coding plan table");
  }
  const planHeaderRow = rows[planHeaderIndex];
  const tierColumns = new Map();
  for (let column = 0; column < planHeaderRow.length; column += 1) {
    const value = normalizeText(planHeaderRow[column]);
    if (/coding\s*plan\s*lite/i.test(value)) {
      tierColumns.set("Lite", column);
    } else if (/coding\s*plan\s*pro/i.test(value)) {
      tierColumns.set("Pro", column);
    }
  }
  const serviceRows = [];
  for (let rowIndex = planHeaderIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const rowLabel = normalizeText(rows[rowIndex]?.[0] || "");
    if (rowLabel === "开始使用") {
      break;
    }
    serviceRows.push(rows[rowIndex]);
  }
  const priceRow = serviceRows.find((row) => {
    const label = normalizeText(row?.[0] || "");
    return label === "套餐价格" || label === "价格";
  });
  if (!priceRow) {
    throw new Error("Unable to locate Baidu coding plan price row");
  }
  const promoPriceRow = serviceRows.find((row) =>
    /(?:限时)?特惠价格|优惠价格|活动价格/i.test(normalizeText(row?.[0] || "")),
  );
  const usageRow = serviceRows.find((row) =>
    /每月限额|月用量|用量限制/i.test(normalizeText(row?.[0] || "")),
  );
  const modelRow = serviceRows.find((row) =>
    /支持模型/i.test(normalizeText(row?.[0] || "")),
  );
  const plainText = stripTags(html);
  const toolIntro = normalizeText(
    plainText.match(/适配\s*(Claude\s*Code[^\s,，。；\n]*)/i)?.[1]
      || plainText.match(/适配工具[：:]*\s*([^\n。；,，]{2,40}?)(?:\s+模型|\s*$)/i)?.[1]
      || "",
  );
  const promoDetailsByTier = parseTencentPromoDetails(plainText);

  const firstMonthByTier = new Map();
  const firstMonthRegex =
    /Coding\s*Plan\s*(Lite|Pro)[\s\S]{0,500}?<span[^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/span>[\s\S]{0,120}?\/首月/gi;
  let firstMonthMatch;
  while ((firstMonthMatch = firstMonthRegex.exec(html)) !== null) {
    firstMonthByTier.set(firstMonthMatch[1], Number(firstMonthMatch[2]));
  }
  const renewalByFirstMonth = new Map();
  const renewalRegex =
    /新客\s*([0-9]+(?:\.[0-9]+)?)\s*元\s*\/\s*首月\s*[，,]\s*续费\s*([0-9]+(?:\.[0-9]+)?)\s*元\s*\/\s*月/gi;
  let renewalMatch;
  while ((renewalMatch = renewalRegex.exec(html)) !== null) {
    renewalByFirstMonth.set(Number(renewalMatch[1]), Number(renewalMatch[2]));
  }

  const plans = [];
  for (const tier of ["Lite", "Pro"]) {
    const column = tierColumns.get(tier);
    if (!Number.isInteger(column)) {
      continue;
    }
    const basePriceInfo = parseTierPriceBreakdown(priceRow[column]);
    const promoPriceInfo = parseTierPriceBreakdown(promoPriceRow?.[column] || "");
    const promoDetails = promoDetailsByTier.get(tier) || null;
    const priceInfo = Number.isFinite(promoPriceInfo.monthlyAmount)
      ? promoPriceInfo
      : promoDetails && Number.isFinite(promoDetails.monthlyAmount)
        ? promoDetails
        : basePriceInfo;
    if (!Number.isFinite(priceInfo.monthlyAmount)) {
      continue;
    }

    const originalMonthlyAmount =
      Number.isFinite(basePriceInfo.monthlyAmount) && basePriceInfo.monthlyAmount > priceInfo.monthlyAmount
        ? basePriceInfo.monthlyAmount
        : null;
    const usageText = normalizeText(usageRow?.[column] || "").replace(/(\d)\s*,\s*(\d{3})/g, "$1,$2");

    plans.push(
      asPlan({
        name: `Coding Plan ${tier}`,
        currentPriceText: `¥${formatAmount(priceInfo.monthlyAmount)}/月`,
        currentPrice: priceInfo.monthlyAmount,
        originalPriceText: Number.isFinite(originalMonthlyAmount) ? `¥${formatAmount(originalMonthlyAmount)}/月` : null,
        originalPrice: originalMonthlyAmount,
        unit: "月",
        notes: buildTierPriceNotes({
          ...priceInfo,
          firstMonthAmount: Number.isFinite(priceInfo.firstMonthAmount)
            ? priceInfo.firstMonthAmount
            : promoDetails?.firstMonthAmount ?? null,
          secondMonthAmount: Number.isFinite(priceInfo.secondMonthAmount)
            ? priceInfo.secondMonthAmount
            : promoDetails?.secondMonthAmount ?? null,
        }),
        serviceDetails: normalizeServiceDetails([
          usageText ? `用量限制: ${usageText}` : null,
          modelRow ? `支持模型: ${normalizeText(modelRow[column] || "")}` : null,
          toolIntro ? `适配工具: ${toolIntro}` : null,
        ]),
      }),
    );
  }

  if (plans.length === 0) {
    throw new Error("Unable to parse Baidu coding plan standard monthly prices");
  }

  return {
    provider: PROVIDER_IDS.BAIDU,
    sourceUrls: [pageUrl],
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseTencentCodingPlans() {
  const pageUrl = "https://cloud.tencent.com/document/product/1772/128947";
  let html = "";
  let rows = [];
  let plainText = "";
  let buyUrlFromPage = null;
  let primaryError = null;

  try {
    html = await fetchText(pageUrl);
    rows = extractRows(html);
    plainText = stripTags(html);
  } catch (error) {
    primaryError = error;
  }

  const ensureFallbackData = async () => {
    const fallback = await parseTencentCodingPlansWithPlaywright(pageUrl).catch((error) => {
      if (primaryError) {
        throw new Error(`${primaryError.message}; Playwright fallback failed: ${error.message}`);
      }
      throw error;
    });
    rows = fallback.rows;
    plainText = fallback.plainText || plainText;
    buyUrlFromPage = fallback.buyUrl || buyUrlFromPage;
  };

  if (rows.length === 0) {
    await ensureFallbackData();
  }

  let planHeaderIndex = rows.findIndex(
    (row) => /lite\s*套餐/i.test(row.join(" ")) && /pro\s*套餐/i.test(row.join(" ")),
  );
  if (planHeaderIndex < 0) {
    await ensureFallbackData();
    planHeaderIndex = rows.findIndex(
      (row) => /lite\s*套餐/i.test(row.join(" ")) && /pro\s*套餐/i.test(row.join(" ")),
    );
  }
  if (planHeaderIndex < 0) {
    throw new Error("Unable to locate Tencent coding plan table");
  }

  const planHeaderRow = rows[planHeaderIndex];
  const tierColumns = new Map();
  for (let column = 0; column < planHeaderRow.length; column += 1) {
    const value = normalizeText(planHeaderRow[column]);
    if (/lite\s*套餐/i.test(value)) {
      tierColumns.set("Lite", column);
    } else if (/pro\s*套餐/i.test(value)) {
      tierColumns.set("Pro", column);
    }
  }

  const pricingRowLabels = new Set(["价格", "套餐价格", "刊例价", "原价", "限时特惠价格", "特惠价格", "优惠价格", "活动价格", "用量限制"]);
  const collectPricingRows = () => {
    const pricingTableRows = [];
    for (let rowIndex = planHeaderIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row || row.length < planHeaderRow.length) {
        continue;
      }
      const label = normalizeText(row[0] || "");
      if (label === "模型" || label === "AI 工具") {
        break;
      }
      if (pricingRowLabels.has(label)) {
        pricingTableRows.push(row);
      }
    }
    return pricingTableRows;
  };

  let pricingTableRows = collectPricingRows();
  let priceRow = pricingTableRows.find((row) => ["价格", "套餐价格", "刊例价", "原价"].includes(normalizeText(row?.[0] || "")));
  if (!priceRow) {
    await ensureFallbackData();
    planHeaderIndex = rows.findIndex(
      (row) => /lite\s*套餐/i.test(row.join(" ")) && /pro\s*套餐/i.test(row.join(" ")),
    );
    if (planHeaderIndex < 0) {
      throw new Error("Unable to locate Tencent coding plan table");
    }
    pricingTableRows = collectPricingRows();
    priceRow = pricingTableRows.find((row) => ["价格", "套餐价格", "刊例价", "原价"].includes(normalizeText(row?.[0] || "")));
  }
  if (!priceRow) {
    throw new Error("Unable to locate Tencent coding plan price row");
  }

  const promoPriceRow = pricingTableRows.find((row) => /(?:限时)?特惠价格|优惠价格|活动价格/i.test(normalizeText(row?.[0] || "")));
  const usageRow = pricingTableRows.find((row) => normalizeText(row?.[0] || "") === "用量限制");
  const modelIntro = normalizeText(plainText.match(/支持模型[：:]\s*([^。；\n]+)/i)?.[1] || "");
  const toolIntro = normalizeText(plainText.match(/适配工具[：:]\s*([^。；\n]+)/i)?.[1] || "");
  const buyUrl = buyUrlFromPage
    || html.match(/https:\/\/buy\.cloud\.tencent\.com\/hunyuan[^\s"'<>]*/i)?.[0]
    || html.match(/https:\/\/cloud\.tencent\.com\/act\/pro\/codingplan[^\s"'<>]*/i)?.[0]
    || "https://buy.cloud.tencent.com/hunyuan";

  const promoDetailsByTier = parseTencentPromoDetails(plainText);

  const plans = [];
  for (const tier of ["Lite", "Pro"]) {
    const column = tierColumns.get(tier);
    if (!Number.isInteger(column)) {
      continue;
    }
    const basePriceInfo = parseTierPriceBreakdown(priceRow[column]);
    const promoPriceInfo = parseTierPriceBreakdown(promoPriceRow?.[column] || "");
    const promoDetails = promoDetailsByTier.get(tier) || null;
    const priceInfo = Number.isFinite(promoPriceInfo.monthlyAmount)
      ? promoPriceInfo
      : promoDetails && Number.isFinite(promoDetails.monthlyAmount)
        ? promoDetails
        : basePriceInfo;
    if (!Number.isFinite(priceInfo.monthlyAmount)) {
      continue;
    }

    const originalMonthlyAmount =
      Number.isFinite(basePriceInfo.monthlyAmount) && basePriceInfo.monthlyAmount > priceInfo.monthlyAmount
        ? basePriceInfo.monthlyAmount
        : null;
    const usageText = normalizeText(usageRow?.[column] || "").replace(/(\d)\s*,\s*(\d{3})/g, "$1,$2");

    plans.push(
      asPlan({
        name: `Coding Plan ${tier}`,
        currentPriceText: `¥${formatAmount(priceInfo.monthlyAmount)}/月`,
        currentPrice: priceInfo.monthlyAmount,
        originalPriceText: Number.isFinite(originalMonthlyAmount) ? `¥${formatAmount(originalMonthlyAmount)}/月` : null,
        originalPrice: originalMonthlyAmount,
        unit: "月",
        notes: buildTierPriceNotes({
          ...priceInfo,
          firstMonthAmount: Number.isFinite(priceInfo.firstMonthAmount)
            ? priceInfo.firstMonthAmount
            : promoDetails?.firstMonthAmount ?? null,
          secondMonthAmount: Number.isFinite(priceInfo.secondMonthAmount)
            ? priceInfo.secondMonthAmount
            : promoDetails?.secondMonthAmount ?? null,
        }),
        serviceDetails: normalizeServiceDetails([
          usageText ? `用量限制: ${usageText}` : null,
          modelIntro ? `支持模型: ${modelIntro}` : null,
          toolIntro ? `适配工具: ${toolIntro}` : null,
        ]),
      }),
    );
  }

  if (plans.length === 0) {
    throw new Error("Unable to parse Tencent coding plan standard monthly prices");
  }

  return {
    provider: PROVIDER_IDS.TENCENT,
    sourceUrls: unique([pageUrl, buyUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseJdCloudCodingPlans() {
  const priceUrl = "https://www.jdcloud.com/cn/pages/codingplan";
  const docsUrl = "https://docs.jdcloud.com/cn/jdaip/PackageOverview";
  const errors = [];
  let pricingPlans = [];
  let docsPlans = [];

  try {
    const rendered = await fetchRenderedPageHtml(priceUrl, "JD Cloud Coding Plan price parser", {
      waitForText: /Coding\s*Plan\s*(Lite|Pro)|原价/,
      waitForTimeoutMs: 12_000,
      timeoutMs: 20_000,
    });
    pricingPlans = parseJdCloudCodingPlansFromPageHtml(rendered.html);
  } catch (error) {
    errors.push(`Playwright price parse failed: ${error.message || error}`);
  }

  if (pricingPlans.length === 0) {
    try {
      const html = await fetchText(priceUrl);
      pricingPlans = parseJdCloudCodingPlansFromPageHtml(html);
    } catch (error) {
      errors.push(`price HTML fetch failed: ${error.message || error}`);
    }
  }

  try {
    const rendered = await fetchRenderedPageText(docsUrl, "JD Cloud Coding Plan docs parser", {
      waitForText: /套餐详情|Lite套餐/,
      waitForTimeoutMs: 12_000,
      timeoutMs: 20_000,
    });
    docsPlans = parseJdCloudCodingPlansFromDocsText(rendered.text);
  } catch (error) {
    errors.push(`Playwright docs parse failed: ${error.message || error}`);
  }

  if (docsPlans.length === 0) {
    try {
      const html = await fetchText(docsUrl);
      docsPlans = parseJdCloudCodingPlansFromDocsText(html);
    } catch (error) {
      errors.push(`docs HTML fetch failed: ${error.message || error}`);
    }
  }

  const plans =
    pricingPlans.length > 0
      ? mergeJdCloudPricingAndDocsPlans(pricingPlans, docsPlans)
      : docsPlans;

  if (plans.length === 0) {
    const reasonText = errors.length > 0 ? ` (${errors.join("; ")})` : "";
    throw new Error(`Unable to parse JD Cloud coding plan details${reasonText}`);
  }

  return {
    provider: PROVIDER_IDS.JDCLOUD,
    sourceUrls: unique([priceUrl, docsPlans.length > 0 ? docsUrl : null]),
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

async function parseKwaikatCodingPlans() {
  const pageUrl = "https://www.streamlake.com/marketing/coding-plan";
  const configUrl =
    "https://www.streamlake.com/api/get-kconf-content?key=website_kat_coder_coding_plan&name=platform_web&folder=streamlake";
  const detailUrl = "https://console.streamlake.com/api/common/describe-product-detail";

  const configPayload = await fetchJson(configUrl);
  const monthPackages = Array.isArray(configPayload?.monthPackages)
    ? configPayload.monthPackages
    : Array.isArray(configPayload?.data?.monthPackages)
      ? configPayload.data.monthPackages
      : [];
  if (monthPackages.length === 0) {
    throw new Error("Unable to parse KwaiKAT month package config");
  }

  const skuIdList = unique(monthPackages.map((item) => item?.skuId));
  const detailPayload = await fetchJson(detailUrl, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: "https://www.streamlake.com",
      referer: pageUrl,
    },
    body: JSON.stringify({
      productType: "standard",
      productCategory: "kat_coder_coding_plan",
      skuIdList,
    }),
  });

  const discountList = Array.isArray(detailPayload?.data?.data?.productDiscountList)
    ? detailPayload.data.data.productDiscountList
    : Array.isArray(detailPayload?.data?.productDiscountList)
      ? detailPayload.data.productDiscountList
      : Array.isArray(detailPayload?.productDiscountList)
        ? detailPayload.productDiscountList
        : [];
  if (discountList.length === 0) {
    throw new Error("Unable to parse KwaiKAT monthly discount list");
  }

  const packageBySkuId = new Map(monthPackages.map((item) => [item?.skuId, item]));
  const orderBySkuId = new Map(monthPackages.map((item, index) => [item?.skuId, index]));

  const plans = discountList
    .map((item) => {
      const packageMeta = packageBySkuId.get(item?.skuId) || {};
      const specUnit = normalizeText(item?.resourcePackBases?.[0]?.resourcePackSpecUnit || "");
      if (!isMonthlyUnit(specUnit)) {
        return null;
      }
      const discountPrice = Number(item?.discountPrice);
      const originalPrice = Number(item?.originalPrice);
      const level = normalizeText(packageMeta?.level || packageMeta?.skuName || "");
      const name = level ? `KAT Coding ${level}` : normalizeText(item?.skuName || "KAT Coding");
      const serviceItems = [packageMeta?.desc, ...(Array.isArray(packageMeta?.descList) ? packageMeta.descList : [])]
        .filter(Boolean)
        .map((value) => normalizeText(value));
      return {
        order: orderBySkuId.get(item?.skuId) ?? 999,
        plan: asPlan({
          name,
          currentPriceText: Number.isFinite(discountPrice) ? `¥${formatAmount(discountPrice)}/月` : null,
          currentPrice: Number.isFinite(discountPrice) ? discountPrice : null,
          originalPriceText:
            Number.isFinite(originalPrice) && Number.isFinite(discountPrice) && originalPrice > discountPrice
              ? `¥${formatAmount(originalPrice)}/月`
              : null,
          originalPrice: Number.isFinite(originalPrice) ? originalPrice : null,
          unit: "月",
          notes: serviceItems.join("；"),
          serviceDetails: serviceItems,
        }),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.plan);

  if (plans.length === 0) {
    throw new Error("Unable to parse KwaiKAT standard monthly plans");
  }

  return {
    provider: PROVIDER_IDS.KWAIKAT,
    sourceUrls: [pageUrl, configUrl, detailUrl],
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

function buildXAioPlanName(name, nameCn) {
  return nameCn ? `${name}（${nameCn}）` : name;
}

function extractXAioQuotedValues(value) {
  const items = [];
  let quote = null;
  let current = "";
  let escaping = false;

  for (const char of String(value || "")) {
    if (!quote) {
      if (char === '"' || char === "'") {
        quote = char;
        current = "";
        escaping = false;
      }
      continue;
    }
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === quote) {
      const normalized = normalizeText(current);
      if (normalized) {
        items.push(normalized);
      }
      quote = null;
      current = "";
      continue;
    }
    current += char;
  }

  return unique(items);
}

function buildXAioPlansFromBundle(appJs) {
  const planRegex =
    /\{id:"([^"]+)",name:"([^"]+)",nameCN:"([^"]+)"[\s\S]*?price:\{monthly:([0-9]+(?:\.[0-9]+)?)[\s\S]*?firstOrder:\{monthly:([0-9]+(?:\.[0-9]+)?)[\s\S]*?description:"([^"]*)"[\s\S]*?features:\[([^\]]*)\]/g;
  const plans = [];
  const seenIds = new Set();
  let match;
  while ((match = planRegex.exec(appJs)) !== null) {
    const planId = match[1];
    if (seenIds.has(planId)) {
      continue;
    }
    seenIds.add(planId);
    const name = normalizeText(match[2]);
    const nameCn = normalizeText(match[3]);
    const monthlyPrice = Number(match[4]);
    const firstOrderPrice = Number(match[5]);
    const description = normalizeText(match[6]);
    const featureBlock = String(match[7] || "");
    const features = extractXAioQuotedValues(featureBlock).map((item) =>
      item === "贾维斯" && /OpenClaw/.test(featureBlock)
        ? `激活开箱即用的OpenClaw！可领取一台属于自己的"贾维斯"！`
        : item,
    );
    if (!Number.isFinite(monthlyPrice)) {
      continue;
    }
    plans.push(
      asPlan({
        name: buildXAioPlanName(name, nameCn),
        currentPriceText: `¥${formatAmount(monthlyPrice)}/月`,
        currentPrice: monthlyPrice,
        unit: "月",
        notes: [
          Number.isFinite(firstOrderPrice) && firstOrderPrice < monthlyPrice
            ? `首购优惠：¥${formatAmount(firstOrderPrice)}/月`
            : null,
        ]
          .filter(Boolean)
          .join("；"),
        serviceDetails: [description ? `适用场景: ${description}` : null, ...features],
      }),
    );
  }
  return dedupePlans(plans);
}

async function waitForMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchXAioTextWithRetry(url, options = {}, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(url, options);
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error || "unknown error");
      const isRetryable = /(?:\b5\d{2}\b)|fetch failed|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message);
      if (!isRetryable || attempt >= attempts) {
        break;
      }
      await waitForMs(400 * attempt);
    }
  }
  throw lastError;
}

async function parseXAioCodingPlansWithPlaywright(pageUrl) {
  let chromium;
  try {
    ({ chromium } = require("@playwright/test"));
  } catch {
    throw new Error("Playwright is unavailable for X-AIO fallback");
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 6_000,
    });
    await page.waitForFunction(
      () => Array.from(document.scripts).some((script) => /\/assets\/index-[^"'\s]+\.js/i.test(script.src || "")),
      undefined,
      { timeout: 3_000 },
    );
    const appUrl = await page.evaluate(() =>
      Array.from(document.scripts)
        .map((script) => script.src)
        .find((src) => /\/assets\/index-[^"'\s]+\.js/i.test(src || "")) || null,
    );
    if (!appUrl) {
      throw new Error("Unable to locate X-AIO app script via Playwright");
    }
    const appJs = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`Request failed: ${url} -> ${response.status}`);
      }
      return await response.text();
    }, appUrl);
    return {
      appUrl,
      plans: buildXAioPlansFromBundle(appJs),
    };
  } finally {
    await browser.close();
  }
}

async function parseXAioCodingPlans() {
  const pageUrl = "https://code.x-aio.com/";

  let plans = [];
  let resolvedAppUrl = null;
  let bundleError = null;
  try {
    const html = await fetchXAioTextWithRetry(pageUrl, { timeoutMs: 4_000 }, 2);
    const appPath = html.match(/\/assets\/index-[^"'\s]+\.js/i)?.[0];
    if (!appPath) {
      throw new Error("Unable to locate X-AIO app script");
    }
    resolvedAppUrl = absoluteUrl(appPath, pageUrl);
    const appJs = await fetchXAioTextWithRetry(resolvedAppUrl, { timeoutMs: 6_000 }, 2);
    plans = buildXAioPlansFromBundle(appJs);
  } catch (error) {
    bundleError = error;
  }

  if (plans.length === 0) {
    const fallback = await parseXAioCodingPlansWithPlaywright(pageUrl).catch((error) => {
      if (bundleError) {
        throw new Error(`${bundleError.message}; Playwright fallback failed: ${error.message}`);
      }
      throw error;
    });
    plans = fallback.plans;
    resolvedAppUrl = fallback.appUrl || resolvedAppUrl;
  }

  if (plans.length === 0) {
    throw new Error("Unable to parse X-AIO coding plan standard monthly prices");
  }

  return {
    provider: PROVIDER_IDS.XAIO,
    sourceUrls: unique([pageUrl, resolvedAppUrl]),
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

function parseCompshareCodingPlansFromHtml(html) {
  const rows = extractRows(html);
  const comparisonHeaderRow =
    rows.find((row) => {
      const cells = (row || []).map((cell) => normalizeText(cell));
      return cells.length >= 3 && /Lite|基础版/i.test(cells.join(" ")) && /Pro|高级版/i.test(cells.join(" "));
    }) || null;
  const priceRow =
    rows.find((row) => {
      const label = normalizeText(row?.[0] || "");
      return /^(月费|价格|套餐价格)$/.test(label) && (row || []).some((cell, index) => index > 0 && isMonthlyPriceText(cell));
    }) || null;

  if (comparisonHeaderRow && priceRow) {
    const plans = [];
    for (let column = 1; column < comparisonHeaderRow.length; column += 1) {
      const name = normalizeText(comparisonHeaderRow[column]);
      const rawPrice = normalizeText(priceRow[column]);
      if (!name || !rawPrice || !isMonthlyPriceText(rawPrice)) {
        continue;
      }
      const amount = parsePriceText(rawPrice).amount;
      const serviceDetails = [];
      for (const row of rows) {
        const label = normalizeText(row?.[0] || "");
        const value = normalizeText(row?.[column] || "");
        if (!label || !value || row === comparisonHeaderRow || row === priceRow) {
          continue;
        }
        serviceDetails.push(`${label}: ${value}`);
      }
      plans.push(
        asPlan({
          name,
          currentPriceText: rawPrice,
          currentPrice: Number.isFinite(amount) ? amount : null,
          unit: "月",
          serviceDetails,
        }),
      );
    }

    return dedupePlans(plans);
  }

  const rowPlanHeaderRow = rows.find((row) => normalizeText(row?.[0] || "") === "套餐名称" && row.length >= 5) || null;
  const plans = [];
  for (const row of rows) {
    const rawName = normalizeText(row?.[0] || "");
    const rawPrice = normalizeText(row?.[1] || "");
    if (!rawName || !rawPrice || !isMonthlyPriceText(rawPrice)) {
      continue;
    }
    const amount = parsePriceText(rawPrice).amount;
    const serviceDetails = [];
    for (let column = 2; column < row.length; column += 1) {
      const value = normalizeText(row[column]);
      if (!value) {
        continue;
      }
      const label = normalizeText(rowPlanHeaderRow?.[column] || "");
      serviceDetails.push(label ? `${label}: ${value}` : value);
    }
    plans.push(
      asPlan({
        name: rawName,
        currentPriceText: rawPrice,
        currentPrice: Number.isFinite(amount) ? amount : null,
        unit: "月",
        serviceDetails,
      }),
    );
  }

  return dedupePlans(plans);
}

async function parseCompshareCodingPlans() {
  const pageUrl = "https://www.compshare.cn/docs/modelverse/package_plan/package";
  const html = await fetchText(pageUrl);
  const plans = parseCompshareCodingPlansFromHtml(html);

  if (plans.length === 0) {
    throw new Error("Unable to parse Compshare standard monthly plans");
  }

  return {
    provider: PROVIDER_IDS.COMPSHARE,
    sourceUrls: [pageUrl],
    fetchedAt: new Date().toISOString(),
    plans,
  };
}

function parseInfiniPlanFromBundle(bundleText, tier) {
  const marker = `Infini Coding ${tier}`;
  const markerIndex = bundleText.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const snippet = bundleText.slice(markerIndex, markerIndex + 3600);
  const currentMatch = snippet.match(/class:"amount"\}\s*,\s*"([0-9]+(?:\.[0-9]+)?)"/i);
  if (!currentMatch) {
    return null;
  }
  const originalMatch = snippet.match(/class:"strike"\}\s*,\s*"¥\s*([0-9]+(?:\.[0-9]+)?)\/月"/i);
  const currentAmount = Number(currentMatch[1]);
  const originalAmount = originalMatch ? Number(originalMatch[1]) : null;
  if (!Number.isFinite(currentAmount)) {
    return null;
  }
  return asPlan({
    name: `Infini Coding ${tier}`,
    currentPriceText: `¥${formatAmount(currentAmount)}/月`,
    currentPrice: currentAmount,
    originalPriceText: Number.isFinite(originalAmount) ? `¥${formatAmount(originalAmount)}/月` : null,
    originalPrice: Number.isFinite(originalAmount) ? originalAmount : null,
    unit: "月",
  });
}

function extractInfiniRouteChunkUrls(mainScriptText, mainScriptUrl) {
  const resolveChunkUrl = (chunkPath) => {
    if (/^assets\//i.test(chunkPath)) {
      return new URL(`../../${chunkPath}`, mainScriptUrl).toString();
    }
    return absoluteUrl(chunkPath, mainScriptUrl);
  };
  const routeMatch = String(mainScriptText || "").match(
    /path:"platform\/ai",name:"platformAi",component:\(\)=>mt\(\(\(\)=>import\("\.\/([^"]+)"\)\),\[([^\]]+)\]\)/,
  );
  if (!routeMatch) {
    return [];
  }

  const primaryChunkUrl = resolveChunkUrl(routeMatch[1]);
  const preloadChunkUrls = [...routeMatch[2].matchAll(/"([^"]+\.js)"/g)]
    .map((match) => resolveChunkUrl(match[1]));

  return unique([primaryChunkUrl, ...preloadChunkUrls]);
}

function parseInfiniServiceDetailsByTier(bundleText) {
  const detailsByTier = new Map();
  const liteMarker = bundleText.indexOf("Infini Coding Lite");
  const proMarker = bundleText.indexOf("Infini Coding Pro");
  if (liteMarker < 0 && proMarker < 0) {
    return detailsByTier;
  }
  const regionStart = Math.max(0, Math.min(...[liteMarker, proMarker].filter((value) => value >= 0)) - 1200);
  const regionEnd = Math.min(bundleText.length, Math.max(liteMarker, proMarker) + 12000);
  const section = decodeUnicodeLiteral(bundleText.slice(regionStart, regionEnd));

  const titleMatches = [...section.matchAll(/class:"feature-title"}\s*,\s*"([^"]+)"/g)];
  const blocks = [];
  for (let index = 0; index < titleMatches.length; index += 1) {
    const match = titleMatches[index];
    const blockStart = match.index ?? 0;
    const blockEnd = titleMatches[index + 1]?.index ?? section.length;
    const blockText = section.slice(blockStart, blockEnd);
    const title = normalizeText(match[1]);
    const items = [...blockText.matchAll(/class:"feature-item[^"]*"}[\s\S]{0,260}?[A-Z]\("span",null,"([^"]+)"\)/g)]
      .map((item) => normalizeText(item[1]))
      .filter(Boolean);
    const details = normalizeServiceDetails([title, ...items]);
    if (details && details.length > 0) {
      blocks.push(details);
    }
  }

  for (const details of blocks) {
    const text = details.join(" ");
    if (/5,?000次(?:请求)?(?:\/|每)5小时|30,?000次\/7天|60,?000次\/1个月|5倍Lite套餐用量/.test(text)) {
      detailsByTier.set("Pro", details);
      continue;
    }
    if (/1,?000次(?:请求)?(?:\/|每)5小时|6,?000次\/7天|12,?000次\/1个月/.test(text)) {
      detailsByTier.set("Lite", details);
    }
  }
  if (!detailsByTier.get("Lite") && blocks[0]) {
    detailsByTier.set("Lite", blocks[0]);
  }
  if (!detailsByTier.get("Pro") && blocks[1]) {
    detailsByTier.set("Pro", blocks[1]);
  }
  return detailsByTier;
}

function buildInfiniStaticFallbackPlans() {
  return [
    asPlan({
      name: "Infini Coding Lite",
      currentPriceText: "¥40/月",
      currentPrice: 40,
      unit: "月",
      notes: "暂不可购买；价格来自上次成功抓取，当前页面仍保留 Infini Coding Plan 入口",
      serviceDetails: [
        "1000次请求每5小时",
        "支持Minimax、GLM、DeepSeek、Kimi等热门模型，持续上新",
        "适配Claude Code、Cline等主流编程工具，持续更新...",
        "当前状态: 暂不可购买",
      ],
    }),
    asPlan({
      name: "Infini Coding Pro",
      currentPriceText: "¥200/月",
      currentPrice: 200,
      unit: "月",
      notes: "暂不可购买；价格来自上次成功抓取，当前页面仍保留 Infini Coding Plan 入口",
      serviceDetails: [
        "5000次请求每5小时",
        "5倍Lite套餐用量",
        "支持Minimax、GLM、DeepSeek、Kimi等热门模型，持续上新",
        "适配Claude Code、Cline等主流编程工具，持续更新...",
        "当前状态: 暂不可购买",
      ],
    }),
  ];
}

async function parseInfiniCodingPlans() {
  const pageUrl = "https://cloud.infini-ai.com/platform/ai";
  const canPurchaseUrl = "https://cloud.infini-ai.com/api/maas/system/coding_plan/can_purchase";
  const html = await fetchText(pageUrl);
  const mainScriptUrl =
    html.match(/https:\/\/content\.cloud\.infini-ai\.com\/platform-web-prod\/assets\/js\/main\.[^"'\s]+\.js/i)?.[0] ||
    null;
  if (!mainScriptUrl) {
    throw new Error("Unable to locate Infini main script");
  }
  const mainScriptText = await fetchText(mainScriptUrl);
  const candidateChunkUrls = extractInfiniRouteChunkUrls(mainScriptText, mainScriptUrl);

  let selectedChunkUrl = null;
  let selectedPlans = [];
  for (const chunkUrl of candidateChunkUrls) {
    let chunkText;
    try {
      chunkText = await fetchText(chunkUrl);
    } catch {
      continue;
    }
    if (!/Infini Coding (Lite|Pro)/i.test(chunkText)) {
      continue;
    }
    const serviceDetailsByTier = parseInfiniServiceDetailsByTier(chunkText);
    const liteBase = parseInfiniPlanFromBundle(chunkText, "Lite");
    const proBase = parseInfiniPlanFromBundle(chunkText, "Pro");
    const litePlan = liteBase ? { ...liteBase, serviceDetails: serviceDetailsByTier.get("Lite") || null } : null;
    const proPlan = proBase ? { ...proBase, serviceDetails: serviceDetailsByTier.get("Pro") || null } : null;
    const plans = [litePlan, proPlan].filter(Boolean);
    if (plans.length === 0) {
      continue;
    }
    selectedChunkUrl = chunkUrl;
    selectedPlans = plans;
    if (plans.some((plan) => plan.originalPriceText)) {
      break;
    }
  }
  if (selectedPlans.length === 0) {
    const rendered = await fetchRenderedPageText(pageUrl, "Infini fallback parser", {
      waitForText: /Infini\s+Coding\s+Plan|无穹编码套餐/,
    }).catch(() => null);
    if (!/Infini\s+Coding\s+Plan|无穹编码套餐/i.test(rendered?.text || "")) {
      throw new Error("Infini page does not expose standard monthly coding plan prices");
    }
    selectedPlans = buildInfiniStaticFallbackPlans();
  }

  let canPurchaseItems = [];
  try {
    const payload = await fetchJson(canPurchaseUrl, {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        origin: "https://cloud.infini-ai.com",
        referer: pageUrl,
      },
      body: "{}",
    });
    if (Array.isArray(payload)) {
      canPurchaseItems = payload;
    }
  } catch {
    canPurchaseItems = [];
  }
  const canBuyByTier = new Map();
  for (const item of canPurchaseItems) {
    const name = normalizeText(item?.name || "");
    if (!name) {
      continue;
    }
    if (/lite/i.test(name)) {
      canBuyByTier.set("Lite", Boolean(item?.can_buy));
    } else if (/pro/i.test(name)) {
      canBuyByTier.set("Pro", Boolean(item?.can_buy));
    }
  }
  const plans = selectedPlans.map((plan) => {
    const tier = /lite/i.test(plan.name) ? "Lite" : /pro/i.test(plan.name) ? "Pro" : null;
    const canBuy = tier ? canBuyByTier.get(tier) : null;
    const notes = canBuy === false ? "暂不可购买" : null;
    const serviceDetails = normalizeServiceDetails([
      ...(plan.serviceDetails || []),
      canBuy === false ? "当前状态: 暂不可购买" : null,
    ]);
    return {
      ...plan,
      notes: notes || plan.notes || null,
      serviceDetails: serviceDetails || null,
    };
  });

  return {
    provider: PROVIDER_IDS.INFINI,
    sourceUrls: unique([pageUrl, mainScriptUrl, selectedChunkUrl, canPurchaseUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

function parseAliyunServiceDetailsFromPageHtml(html) {
  const featureMatches = [
    {
      label: "能力",
      titlePattern: /支持<em>\s*更多模型\s*<\/em>|支持\s*更多模型/,
      descPattern:
        /支持千问系列模型[\s\S]*?Qwen3\.5-Plus[\s\S]*?更多模型持续接入中。/,
    },
    {
      label: "工具",
      titlePattern: /适配更多\s*AI\s*工具/,
      descPattern:
        /支持\s*Qwen Code、Qoder、OpenClaw、OpenCode、Claude Code、Claude Code IDE插件、Codex、Cline、Cursor、Kilo CLI、Kilo Code IDE 插件等工具。/,
    },
    {
      label: "权益",
      titlePattern: /价格更加优惠/,
      descPattern: /更大容量，更快、更稳，专为 AI Coding 场景打造。/,
    },
  ];

  const details = [];
  for (const item of featureMatches) {
    const titleMatch = html.match(item.titlePattern);
    const descMatch = html.match(item.descPattern);
    if (!titleMatch || !descMatch) {
      continue;
    }
    const desc = normalizeText(stripTags(descMatch[0]));
    if (!desc) {
      continue;
    }
    details.push(`${item.label}: ${desc}`);
  }

  const normalized = normalizeServiceDetails(details);
  const detailsByTier = new Map();
  if (normalized) {
    detailsByTier.set("Lite", normalized);
    detailsByTier.set("Pro", normalized);
  }
  return detailsByTier;
}

function parseAliyunServiceDetailsFromDocsHtml(html) {
  const detailsByTier = new Map();
  const rows = extractRows(html);
  const cleanupDocsValue = (value) =>
    normalizeText(
      String(value || "")
        .replace(/\\+&nbsp;?/gi, " ")
        .replace(/\\+/g, " ")
        .replace(/\s+/g, " "),
    );
  const proColumn =
    rows.find((row) => row.some((cell) => /Pro\s*高级套餐/i.test(cleanupDocsValue(cell || ""))))?.findIndex((cell) =>
      /Pro\s*高级套餐/i.test(cleanupDocsValue(cell || "")),
    ) ?? -1;

  if (proColumn > 0) {
    const proDetails = [];
    for (const row of rows) {
      const label = cleanupDocsValue(row?.[0] || "");
      const value = cleanupDocsValue(row?.[proColumn] || "");
      if (!label || !value || label === "价格") {
        continue;
      }
      proDetails.push(`${label}: ${value}`);
    }
    const normalizedProDetails = normalizeServiceDetails(proDetails);
    if (normalizedProDetails) {
      detailsByTier.set("Pro", normalizedProDetails);
    }
  }

  const liteDiscontinuedMatch = html.match(
    /Lite\s*基础套餐将停止接受新购订单[\s\S]*?已购买用户的使用、续费及套餐升级权益保持不变/,
  );
  if (liteDiscontinuedMatch) {
    detailsByTier.set(
      "Lite",
      normalizeServiceDetails([
        `状态: ${normalizeText(stripTags(liteDiscontinuedMatch[0]))}`,
      ]),
    );
  }

  return detailsByTier;
}

async function parseAliyunCodingPlans() {
  const pageUrl = "https://www.aliyun.com/benefit/scene/codingplan";
  const docsUrl = "https://help.aliyun.com/zh/model-studio/coding-plan";
  const html = await fetchText(pageUrl);
  const serviceDetailsByTier = parseAliyunServiceDetailsFromPageHtml(html);
  try {
    const docsHtml = await fetchText(docsUrl);
    const docsDetailsByTier = parseAliyunServiceDetailsFromDocsHtml(docsHtml);
    for (const [tier, details] of docsDetailsByTier.entries()) {
      const merged = normalizeServiceDetails([...(serviceDetailsByTier.get(tier) || []), ...(details || [])]);
      if (merged) {
        serviceDetailsByTier.set(tier, merged);
      }
    }
  } catch {
    // Keep pricing fetch resilient when docs metadata is temporarily unavailable.
  }
  const rawEntryUrl = html.match(/(?:https?:)?\/\/cloud-assets\.alicdn\.com\/lowcode\/entry\/prod\/[^"'\s]+\.js/i)?.[0];
  const entryUrl = rawEntryUrl
    ? absoluteUrl(rawEntryUrl.startsWith("//") ? `https:${rawEntryUrl}` : rawEntryUrl, pageUrl)
    : null;
  if (!entryUrl) {
    throw new Error("Unable to locate Aliyun entry script");
  }
  const queryPriceUrl = "https://t.aliyun.com/abs/promotion/queryPrice";
  const planDefs = [
    {
      tier: "Lite",
      commodityId: 10000019802,
      subscriptionTypeName: "Lite 基础套餐",
      subscriptionTypeValue: "lite",
    },
    {
      tier: "Pro",
      commodityId: 10000019803,
      subscriptionTypeName: "Pro 高级套餐",
      subscriptionTypeValue: "pro",
    },
  ];
  const buildAliyunPriceParam = (planDef) => ({
    commodityId: planDef.commodityId,
    commodities: [
      {
        couponNum: "default",
        orderType: "BUY",
        components: [
          {
            componentCode: "subscription_type",
            instanceProperty: [
              {
                code: "subscription_type",
                name: planDef.subscriptionTypeName,
                value: planDef.subscriptionTypeValue,
              },
            ],
            componentName: "订阅套餐",
          },
        ],
        quantity: 1,
        specCode: "sfm_codingplan_public_cn",
        chargeType: "PREPAY",
        pricingCycleTitle: "月",
        duration: "1",
        orderParams: {
          queryGetCouponActivity: true,
          order_created_by: "merak",
          pricing_trigger_type: "default",
        },
        chargeTypeTitle: "预付费",
        commodityCode: "sfm_codingplan_public_cn",
        autoRenew: false,
        pricingCycle: "Month",
        commodityName: "阿里云百炼 Coding Plan",
        uniqLabel: `sfm_codingplan_public_cn.${planDef.commodityId}.0`,
      },
    ],
  });
  const centToYuan = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
      return null;
    }
    return amount / 100;
  };

  const plans = [];
  for (const planDef of planDefs) {
    const payload = await fetchJson(queryPriceUrl, {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: "https://www.aliyun.com",
        referer: pageUrl,
      },
      body: `param=${encodeURIComponent(JSON.stringify(buildAliyunPriceParam(planDef)))}`,
    });
    if (!payload || payload.success !== true || String(payload.code) !== "200") {
      continue;
    }
    const articleItem = payload?.data?.articleItemResults?.[0] || null;
    if (!articleItem) {
      continue;
    }
    const moduleResult =
      articleItem?.moduleResults?.find((item) => item?.moduleCode === "subscription_type") ||
      articleItem?.moduleResults?.[0] ||
      null;
    const discountedCents = Number(
      moduleResult?.price?.discountedUnitPrice ??
        moduleResult?.price?.discountedPrice ??
        articleItem?.price?.discountedUnitPrice ??
        articleItem?.price?.discountedPrice,
    );
    const listCents = Number(
      moduleResult?.price?.unitPrice ??
        moduleResult?.depreciateInfo?.listPrice ??
        articleItem?.price?.unitPrice ??
        articleItem?.depreciateInfo?.listPrice,
    );
    const currentAmount = centToYuan(discountedCents);
    const originalAmount = centToYuan(listCents);
    if (!Number.isFinite(currentAmount)) {
      continue;
    }
    const promoLabel = normalizeText(payload?.data?.promotionLabelInfo?.common?.display?.join(" ")) || null;
    const activityName =
      normalizeText(moduleResult?.depreciateInfo?.finalActivity?.activityName || articleItem?.name || "") || null;
    plans.push(
      asPlan({
        name: `Coding Plan ${planDef.tier}`,
        currentPriceText: `¥${formatAmount(currentAmount)}/月`,
        currentPrice: currentAmount,
        originalPriceText:
          Number.isFinite(originalAmount) && originalAmount > currentAmount
            ? `¥${formatAmount(originalAmount)}/月`
            : null,
        originalPrice: Number.isFinite(originalAmount) ? originalAmount : null,
        unit: "月",
        notes: promoLabel || null,
        serviceDetails: serviceDetailsByTier.get(planDef.tier) || (activityName ? [activityName] : null),
      }),
    );
  }

  if (plans.length === 0) {
    throw new Error("Aliyun page currently does not expose coding plan prices");
  }

  return {
    provider: PROVIDER_IDS.ALIYUN,
    sourceUrls: unique([pageUrl, entryUrl, queryPriceUrl, docsUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

function parseAliyunTokenPlansFromDocsHtml(html) {
  const docsUrl = "https://help.aliyun.com/zh/model-studio/token-plan-overview";
  const cleanupDocsCell = (value) => normalizeText(value).replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  const compactDocsCell = (value) => cleanupDocsCell(value).replace(/\s+/g, "");
  const rows = extractRows(html).map((row) => row.map((cell) => cleanupDocsCell(cell)));
  const bodyText = normalizeText(stripTags(html));
  const textModels = rows.find((row) => row[0] === "文本生成")?.[1] || null;
  const imageModels = rows.find((row) => row[0] === "图像生成")?.[1] || null;
  const supportedModels = normalizeServiceDetails([
    textModels ? `文本生成模型: ${textModels}` : null,
    imageModels ? `图像生成模型: ${imageModels}` : null,
  ]);
  const commonDetails = normalizeServiceDetails([
    "计费方式: 按 Token 消耗抵扣 Credits",
    "使用频次: 无每 5 小时/每周限额",
    "数据安全: 不使用对话数据训练模型",
    "服务地域: 华北2（北京）",
    ...(supportedModels || []),
  ]);

  const tierRows = rows.filter((row) => /^(标准|高级|尊享)坐席$/.test(row[0] || ""));
  const plans = tierRows.map((row) => {
    const seatType = row[0];
    const priceText = row[1];
    const credits = row[2];
    const scenario = row[3];
    const priceMatch = priceText.match(/¥\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;
    return asPlan({
      name: `Token Plan ${seatType}`,
      currentPriceText: compactDocsCell(priceText),
      currentPrice: Number.isFinite(price) ? price : null,
      unit: "坐席/月",
      notes: scenario || null,
      serviceDetails: normalizeServiceDetails([
        credits ? `额度: ${credits}` : null,
        scenario ? `适用场景: ${scenario}` : null,
        ...(commonDetails || []),
      ]),
    });
  });

  const sharedPackageRow = rows.find((row) => /Token\s*Plan\s*团队版\s*-\s*共享用量包/i.test(row[0] || ""));
  if (sharedPackageRow) {
    const priceText = sharedPackageRow[1];
    const credits = sharedPackageRow[2];
    const priceMatch = priceText.match(/¥\s*([0-9]+(?:,[0-9]{3})*(?:\.\d+)?)/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;
    const packageRuleMatch = bodyText.match(
      /跨坐席共享的弹性用量包[\s\S]{0,120}?优先抵扣最近到期的用量包。/,
    );
    plans.push(
      asPlan({
        name: "Token Plan 共享用量包",
        currentPriceText: compactDocsCell(priceText),
        currentPrice: Number.isFinite(price) ? price : null,
        unit: "月",
        notes: "有效期 1 个月，到期未使用额度自动清零",
        serviceDetails: normalizeServiceDetails([
          credits ? `额度: ${credits}` : null,
          packageRuleMatch ? normalizeText(packageRuleMatch[0]) : "跨坐席共享的弹性用量包",
        ]),
      }),
    );
  }

  const normalizedPlans = dedupePlans(plans);
  if (normalizedPlans.length === 0) {
    throw new Error("Aliyun Token Plan docs do not expose plan prices");
  }

  return {
    provider: PROVIDER_IDS.ALIYUN_TOKEN,
    sourceUrls: unique([
      "https://www.aliyun.com/benefit/scene/tokenplan",
      "https://common-buy.aliyun.com/token-plan/",
      docsUrl,
    ]),
    fetchedAt: new Date().toISOString(),
    plans: normalizedPlans,
  };
}

async function parseAliyunTokenPlans() {
  const docsUrl = "https://help.aliyun.com/zh/model-studio/token-plan-overview";
  const docsHtml = await fetchText(docsUrl);
  return parseAliyunTokenPlansFromDocsHtml(docsHtml);
}

function normalizeVolcCurrentPriceText(rawText) {
  const value = normalizeText(rawText);
  if (!value) {
    return null;
  }
  if (/免费|0\s*成本/i.test(value)) {
    return "免费";
  }
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    return `¥${value}/月`;
  }
  if (/^[0-9]+(?:\.[0-9]+)?\s*\/\s*月$/.test(value)) {
    return `¥${value.replace(/\s+/g, "")}`;
  }
  const normalized = value.replace(/元\s*\/\s*月/g, "/月").replace(/元\/月/g, "/月");
  if (!/[¥￥]/.test(normalized) && /^[0-9]/.test(normalized)) {
    return `¥${normalized}`;
  }
  return normalized;
}

function normalizeVolcOriginalPriceText(rawText) {
  const value = normalizeText(rawText);
  if (!value) {
    return null;
  }
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    return `¥${value}/月`;
  }
  const normalized = value.replace(/元\s*\/\s*月/g, "/月").replace(/元\/月/g, "/月");
  if (!/[¥￥]/.test(normalized) && /^[0-9]/.test(normalized)) {
    return `¥${normalized}`;
  }
  return normalized;
}

function parseVolcServiceDetails(decodedSnippet) {
  const details = [];
  const itemRegex = /title:"([^"]+)"\s*,\s*rightContents:\[\[\{text:"([^"]+)"/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(decodedSnippet)) !== null) {
    const title = normalizeText(itemMatch[1]);
    const text = normalizeText(itemMatch[2]);
    if (!title || !text) {
      continue;
    }
    if (/^[^：:]{1,12}[：:]/.test(text)) {
      details.push(text);
    } else {
      details.push(`${title}: ${text}`);
    }
  }
  return normalizeServiceDetails(details);
}

function parseVolcPlanFromBundle(bundleText, configurationCode) {
  const marker = `configurationCode:"${configurationCode}"`;
  const isLite = configurationCode.includes("Lite");
  const candidates = [];
  let index = bundleText.indexOf(marker);
  while (index >= 0) {
    const snippet = bundleText.slice(Math.max(0, index - 2600), index + 6200);
    const decoded = decodeUnicodeLiteral(snippet);
    const currentPriceText = normalizeVolcCurrentPriceText(decoded.match(/discountAmount:"([^"]+)"/)?.[1] || null);
    const originalPriceText = normalizeVolcOriginalPriceText(decoded.match(/originalAmount:"([^"]+)"/)?.[1] || null);
    const serviceDetails = parseVolcServiceDetails(decoded);
    const detailText = (serviceDetails || []).join(" ");

    const plan = asPlan({
      name: isLite ? "Coding Plan Lite 月套餐" : "Coding Plan Pro 月套餐",
      currentPriceText,
      originalPriceText,
      unit: "月",
      notes: null,
      serviceDetails,
    });
    const score =
      (plan.currentPriceText ? 4 : 0) +
      (plan.originalPriceText ? 3 : 0) +
      ((plan.serviceDetails || []).length >= 3 ? 3 : (plan.serviceDetails || []).length) +
      (/续费/.test(plan.originalPriceText || "") ? 2 : 0) +
      (isLite && /能力[:：].*Doubao.*GLM.*DeepSeek.*Kimi/i.test(detailText) ? 2 : 0) +
      (!isLite && /能力[:：].*Lite.*适配[:：].*高阶.*(升级[:：]|用量)/i.test(detailText) ? 2 : 0) +
      (!isLite && /Claude Max/i.test(detailText) ? 1 : 0);
    if (score > 0) {
      candidates.push({ index, score, plan });
    }

    index = bundleText.indexOf(marker, index + marker.length);
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => right.score - left.score || right.index - left.index);
  return candidates[0].plan;
}

function volcBundleId(url) {
  const match = String(url).match(/fes2_app_(\d+)\//);
  return match ? Number(match[1]) : 0;
}

function volcBundleVersion(url) {
  const match = String(url).match(/\/(\d+\.\d+\.\d+\.\d+)\/index\.js/);
  if (!match) {
    return 0;
  }
  const parts = match[1].split(".").map((value) => Number(value));
  return parts.reduce((total, value) => total * 1_000 + (Number.isFinite(value) ? value : 0), 0);
}

function extractVolcBundleCandidatesFromHtml(html, pageUrl) {
  const scriptMatch = html.match(/window\.gfdatav1\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
  const urls = [];
  if (scriptMatch) {
    try {
      const payload = JSON.parse(scriptMatch[1]);
      const modules = Array.isArray(payload?.garrModules?.data) ? payload.garrModules.data : [];
      for (const item of modules) {
        const name = normalizeText(item?.name || "");
        const modulePath = normalizeText(item?.path || "");
        if (!/activity\/codingplan/i.test(`${name} ${modulePath}`)) {
          continue;
        }
        const sourceUrl = normalizeText(item?.source_url || "");
        if (!sourceUrl) {
          continue;
        }
        const normalized = sourceUrl.startsWith("//") ? `https:${sourceUrl}` : absoluteUrl(sourceUrl, pageUrl);
        urls.push(normalized);
      }
    } catch {
      // Keep fallback extraction below.
    }
  }

  if (urls.length === 0) {
    const fallbackMatches = html.match(/https?:\/\/[^"'\s]+fes2_app_[0-9]+\/[0-9.]+\/bundles\/js\/main\.js/gi) || [];
    urls.push(...fallbackMatches);
  }

  return unique(
    urls
      .map((url) => url.replace("/bundles/js/main.js", "/index.js"))
      .filter((url) => /\/index\.js$/i.test(url)),
  ).sort((left, right) => volcBundleVersion(right) - volcBundleVersion(left) || volcBundleId(right) - volcBundleId(left));
}

async function parseVolcengineCodingPlans() {
  const pageUrl = "https://www.volcengine.com/activity/codingplan";
  const html = await fetchText(pageUrl);
  const candidates = extractVolcBundleCandidatesFromHtml(html, pageUrl);
  if (candidates.length === 0) {
    throw new Error("Unable to locate Volcengine coding plan bundle");
  }

  const fallbackIndexUrl =
    "https://lf6-cdn2-tos.bytegoofy.com/gftar/toutiao/fe_arch/fes2_app_1761224550685339/1.0.0.156/index.js";

  let selectedSourceUrl = null;
  let selectedPlans = [];
  for (const candidate of unique([...candidates.slice(0, 2), fallbackIndexUrl])) {
    let bundleText;
    try {
      bundleText = await fetchText(candidate);
    } catch {
      continue;
    }
    const lite = parseVolcPlanFromBundle(bundleText, "Coding_Plan_Lite_monthly");
    const pro = parseVolcPlanFromBundle(bundleText, "Coding_Plan_Pro_monthly");
    const plans = [lite, pro].filter(Boolean);
    if (plans.length < 2) {
      continue;
    }
    selectedSourceUrl = candidate;
    selectedPlans = plans;
    if (plans.every((plan) => plan.currentPriceText && plan.originalPriceText && (plan.serviceDetails || []).length >= 3)) {
      break;
    }
  }

  if (selectedPlans.length === 0) {
    throw new Error("Unable to parse Volcengine coding plan bundle");
  }

  return {
    provider: PROVIDER_IDS.VOLCENGINE,
    sourceUrls: unique([pageUrl, selectedSourceUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(selectedPlans),
  };
}

async function runTaskWithTimeout(task) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS}ms`));
    }, TASK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      REQUEST_CONTEXT.run(
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal: controller.signal,
        },
        () => task(),
      ),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function parseTencentTokenPlans() {
  const pageUrl = "https://cloud.tencent.com/document/product/1772/129449";
  const actUrl = "https://cloud.tencent.com/act/pro/tokenplan";

  // Tencent Token Plan pricing from official documentation
  // Source: https://cloud.tencent.com/document/product/1772/129449
  const plans = [
    asPlan({
      name: "Token Plan Lite",
      currentPriceText: "¥39/月",
      currentPrice: 39,
      unit: "月",
      notes: null,
      serviceDetails: [
        "用量限制: 每订阅月 3,500 万 Tokens",
        "新手尝鲜，入门首选。适合首次体验龙虾能力",
        "支持模型: Tencent HY 2.0 Instruct、Tencent HY 2.0 Think、Kimi-K2.5、MiniMax-M2.5、GLM-5、Hunyuan-T1、Hunyuan-TurboS",
        "适配工具: OpenClaw、Claude Code、OpenCode、Cline、Cursor、Roo Code、Kilo Code、Codex CLI",
      ],
    }),
    asPlan({
      name: "Token Plan Standard",
      currentPriceText: "¥99/月",
      currentPrice: 99,
      unit: "月",
      notes: null,
      serviceDetails: [
        "用量限制: 每订阅月 1 亿 Tokens",
        "日常使用，高性价比。适合日常用龙虾办公和轻量开发",
        "支持模型: Tencent HY 2.0 Instruct、Tencent HY 2.0 Think、Kimi-K2.5、MiniMax-M2.5、GLM-5、Hunyuan-T1、Hunyuan-TurboS",
        "适配工具: OpenClaw、Claude Code、OpenCode、Cline、Cursor、Roo Code、Kilo Code、Codex CLI",
      ],
    }),
    asPlan({
      name: "Token Plan Pro",
      currentPriceText: "¥299/月",
      currentPrice: 299,
      unit: "月",
      notes: null,
      serviceDetails: [
        "用量限制: 每订阅月 3.2 亿 Tokens",
        "高频 AI 开发，Token 配额提升至 3 倍",
        "支持模型: Tencent HY 2.0 Instruct、Tencent HY 2.0 Think、Kimi-K2.5、MiniMax-M2.5、GLM-5、Hunyuan-T1、Hunyuan-TurboS",
        "适配工具: OpenClaw、Claude Code、OpenCode、Cline、Cursor、Roo Code、Kilo Code、Codex CLI",
      ],
    }),
    asPlan({
      name: "Token Plan Max",
      currentPriceText: "¥599/月",
      currentPrice: 599,
      unit: "月",
      notes: null,
      serviceDetails: [
        "用量限制: 每订阅月 6.5 亿 Tokens",
        "更多额度加持，重度 AI 开发首选",
        "支持模型: Tencent HY 2.0 Instruct、Tencent HY 2.0 Think、Kimi-K2.5、MiniMax-M2.5、GLM-5、Hunyuan-T1、Hunyuan-TurboS",
        "适配工具: OpenClaw、Claude Code、OpenCode、Cline、Cursor、Roo Code、Kilo Code、Codex CLI",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.TENCENT_TOKEN,
    sourceUrls: unique([pageUrl, actUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseXiaomiMimoTokenPlans() {
  const pageUrl = "https://mimo.xiaomi.com";
  const newsUrl = "https://www.ithome.com/0/935/666.htm";

  // MiMo Token Plan pricing from official announcement
  // Source: IT之家 2026-04-03 report and official announcement
  const plans = [
    asPlan({
      name: "MiMo Token Plan Lite",
      currentPriceText: "¥39/月",
      currentPrice: 39,
      unit: "月",
      notes: "首次购买享 88 折优惠",
      serviceDetails: [
        "Credits: 0.6 亿（60M）Credits/月",
        "可执行约 120 个中等~复杂任务",
        "适合刚接触 AI 开发的探索者",
        "支持模型: MiMo-V2-Omni（1x）、MiMo-V2-Pro（2x/4x）、MiMo-V2-TTS（0x 限时免费）",
        "无 5 小时 token 使用限额，支持集中消耗",
      ],
    }),
    asPlan({
      name: "MiMo Token Plan Standard",
      currentPriceText: "¥99/月",
      currentPrice: 99,
      unit: "月",
      notes: "首次购买享 88 折优惠",
      serviceDetails: [
        "Credits: 2 亿（200M）Credits/月",
        "可执行约 400 个中等~复杂任务",
        "为日常依赖 AI 提效的办公与开发者用户打造的主力方案",
        "支持模型: MiMo-V2-Omni（1x）、MiMo-V2-Pro（2x/4x）、MiMo-V2-TTS（0x 限时免费）",
        "无 5 小时 token 使用限额，支持集中消耗",
      ],
    }),
    asPlan({
      name: "MiMo Token Plan Pro",
      currentPriceText: "¥329/月",
      currentPrice: 329,
      unit: "月",
      notes: "首次购买享 88 折优惠",
      serviceDetails: [
        "Credits: 7 亿（700M）Credits/月",
        "可执行约 1,400 个中等~复杂任务",
        "面向将 AI 深度嵌入工作流的专业用户",
        "支持模型: MiMo-V2-Omni（1x）、MiMo-V2-Pro（2x/4x）、MiMo-V2-TTS（0x 限时免费）",
        "无 5 小时 token 使用限额，支持集中消耗",
      ],
    }),
    asPlan({
      name: "MiMo Token Plan Max",
      currentPriceText: "¥659/月",
      currentPrice: 659,
      unit: "月",
      notes: "首次购买享 88 折优惠",
      serviceDetails: [
        "Credits: 16 亿（1600M）Credits/月",
        "可执行约 3,200 个中等~复杂任务",
        "为全天候高强度使用的开发者准备，近乎无限制的使用体验",
        "支持模型: MiMo-V2-Omni（1x）、MiMo-V2-Pro（2x/4x）、MiMo-V2-TTS（0x 限时免费）",
        "无 5 小时 token 使用限额，支持集中消耗",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.XIAOMI,
    sourceUrls: unique([pageUrl, newsUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseOpenCodePlans() {
  const goPageUrl = "https://opencode.ai/go";
  const mainPageUrl = "https://opencode.ai";

  // OpenCode Go pricing from official page
  const plans = [
    asPlan({
      name: "OpenCode Go",
      currentPriceText: "$10/月",
      currentPrice: 10,
      unit: "月",
      notes: "首月 $5",
      serviceDetails: [
        "首月 $5，之后 $10/月",
        "支持模型: GLM-5、Kimi K2.5、MiMo-V2-Pro、MiMo-V2-Omni、MiniMax M2.5、MiniMax M2.7",
        "每 5 小时请求数: 1,150~20,000（按模型不同）",
        "可充值 Credit，随时取消",
        "适配任何 AI 编程工具",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.OPENCODE,
    sourceUrls: unique([goPageUrl, mainPageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseGithubCopilotPlans() {
  const pageUrl = "https://github.com/features/copilot/plans";

  // GitHub Copilot pricing from official page (2026-04-07)
  const plans = [
    asPlan({
      name: "GitHub Copilot Free",
      currentPriceText: "$0/月",
      currentPrice: 0,
      unit: "月",
      notes: "个人免费计划",
      serviceDetails: [
        "50 agent mode 或 chat requests/月",
        "2,000 completions/月",
        "支持模型: Haiku 4.5、GPT-5 mini 等",
        "Copilot CLI",
        "无需信用卡",
      ],
    }),
    asPlan({
      name: "GitHub Copilot Pro",
      currentPriceText: "$10/月",
      currentPrice: 10,
      unit: "月",
      notes: "最受欢迎",
      serviceDetails: [
        "300 premium requests/月（可额外购买）",
        "无限 agent mode 和 chat（GPT-5 mini）",
        "无限 inline suggestions",
        "Copilot cloud agent",
        "Copilot code review",
        "Claude 和 Codex on GitHub & VS Code",
        "支持模型: Anthropic、Google、OpenAI 等，含 Opus 4.6",
      ],
    }),
    asPlan({
      name: "GitHub Copilot Pro+",
      currentPriceText: "$39/月",
      currentPrice: 39,
      unit: "月",
      notes: "个人最高级计划",
      serviceDetails: [
        "1,500 premium requests/月（可额外购买）",
        "全部模型访问，含 Claude Opus 4.6 等",
        "GitHub Spark 访问",
        "包含 Pro 全部功能",
      ],
    }),
    asPlan({
      name: "GitHub Copilot Business",
      currentPriceText: "$19/月/用户",
      currentPrice: 19,
      unit: "月/用户",
      notes: "团队计划",
      serviceDetails: [
        "300 premium requests/用户/月（可额外购买）",
        "无限 agent mode 和 chat（GPT-5 mini）",
        "无限 inline suggestions",
        "Copilot cloud agent",
        "Copilot code review",
        "Claude 和 Codex on GitHub & VS Code",
        "用户管理与使用指标",
        "IP 赔偿与数据隐私",
        "Copilot CLI",
      ],
    }),
    asPlan({
      name: "GitHub Copilot Enterprise",
      currentPriceText: "$39/月/用户",
      currentPrice: 39,
      unit: "月/用户",
      notes: "企业计划",
      serviceDetails: [
        "1,000 premium requests/用户/月（可额外购买）",
        "全部模型访问，含 Claude Opus 4.6 等",
        "GitHub Spark 访问",
        "包含 Business 全部功能",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.GITHUB_COPILOT,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

function buildMonthlyEquivalentPlan({ name, monthlyPrice, currency = "¥", originalText, notes, serviceDetails }) {
  return asPlan({
    name,
    currentPriceText: `${currency}${formatAmount(monthlyPrice)}/月`,
    currentPrice: monthlyPrice,
    unit: "月",
    notes: normalizeServiceDetails([originalText, notes]).join("；"),
    serviceDetails,
  });
}

function extractPlanSegment(text, startLabel, nextLabels) {
  const value = normalizeText(text);
  const start = value.indexOf(startLabel);
  if (start < 0) {
    return "";
  }
  let end = value.length;
  for (const label of nextLabels || []) {
    const index = value.indexOf(label, start + startLabel.length);
    if (index >= 0 && index < end) {
      end = index;
    }
  }
  return value.slice(start, end).trim();
}

async function parseMthreadsCodingPlans() {
  const pageUrl = "https://code.mthreads.com/";
  const docsUrl = "https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/";
  const { text } = await fetchRenderedPageText(pageUrl, "MThreads Coding Plan parser", {
    waitForText: /摩尔线程\s*AI\s*Coding\s*Plan|Lite\s*Plan/,
  });
  if (!/摩尔线程\s*AI\s*Coding\s*Plan/i.test(text) || !/Lite\s*Plan/i.test(text)) {
    throw new Error("Unable to locate MThreads coding plan pricing text");
  }

  const plans = [
    asPlan({
      name: "Free Trial",
      currentPriceText: "¥0/月",
      currentPrice: 0,
      unit: "月",
      notes: "限时 30 天免费体验；每日限量 100 名开发者",
      serviceDetails: [
        "与 Lite Plan 套餐用量相当",
        "面向轻量工作负载的开发者",
        "支持最新 GLM 4.7 开源模型",
        "适用于 Claude Code、Cursor、OpenCode、Cline、Kilo Code、Roo Code 等工具",
        "领取成功之日起 30 天内有效",
      ],
    }),
    buildMonthlyEquivalentPlan({
      name: "Lite Plan",
      monthlyPrice: 40,
      originalText: "原始售价 ¥120/季度，按月折算展示",
      serviceDetails: [
        "Claude Pro 套餐的 3 倍用量",
        "面向中量工作负载的开发者",
        "支持最新 GLM 4.7 开源模型",
        "订阅期间享受最新版本模型更新服务",
      ],
    }),
    buildMonthlyEquivalentPlan({
      name: "Pro Plan",
      monthlyPrice: 200,
      originalText: "原始售价 ¥600/季度，按月折算展示",
      serviceDetails: [
        "Lite Plan 的 5 倍用量",
        "面向复杂工作负载的开发者",
        "享受 Lite Plan 的完整权益",
        "生成速度高于 Lite Plan",
      ],
    }),
    buildMonthlyEquivalentPlan({
      name: "Max Plan",
      monthlyPrice: 400,
      originalText: "原始售价 ¥1200/季度，按月折算展示",
      serviceDetails: [
        "Pro Plan 的 4 倍用量",
        "面向海量工作负载的开发者",
        "享受 Pro Plan 的完整权益",
        "优先保障用量高峰",
        "抢先体验新功能",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.MTHREADS,
    sourceUrls: unique([pageUrl, docsUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseStepfunStepPlans() {
  const pageUrl = "https://platform.stepfun.com/step-plan?channel=step-dev";
  const { text } = await fetchRenderedPageText(pageUrl, "StepFun Step Plan parser", {
    waitForText: /Flash\s+Mini[\s\S]*¥\s*25[\s\S]*Flash\s+Max[\s\S]*¥\s*349/,
  });
  if (!/Step\s*Plan/i.test(text) || !/Flash\s+Mini/i.test(text)) {
    throw new Error("Unable to locate StepFun Step Plan pricing text");
  }

  const tierSpecs = [
    ["Flash Mini", ["Flash Plus", "Flash Pro", "Flash Max"]],
    ["Flash Plus", ["Flash Pro", "Flash Max"]],
    ["Flash Pro", ["Flash Max"]],
    ["Flash Max", ["Prompt 是", "开发者评价"]],
  ];
  const plans = [];
  for (const [tier, nextLabels] of tierSpecs) {
    const segment = extractPlanSegment(text, tier, nextLabels);
    const priceMatch = segment.match(/¥\s*([0-9]+(?:\.[0-9]+)?)\s*¥\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!priceMatch) {
      continue;
    }
    const currentPrice = Number(priceMatch[1]);
    const originalPrice = Number(priceMatch[2]);
    const promptMatch = segment.match(/每\s*5\s*小时\s*([0-9,]+)\s*次\s*Prompt/i);
    const callMatch = segment.match(/[（(]\s*[～~]?\s*([0-9,]+)\s*次模型调用\s*[）)]/);
    plans.push(
      asPlan({
        name: tier,
        currentPriceText: `¥${formatAmount(currentPrice)}/月`,
        currentPrice,
        originalPriceText: `¥${formatAmount(originalPrice)}/月`,
        originalPrice,
        unit: "月",
        notes: /已售罄/.test(segment) ? "当前页面显示已售罄" : "限时优惠",
        serviceDetails: [
          "支持所有旗舰模型",
          "支持智能路由",
          promptMatch ? `每 5 小时 ${promptMatch[1]} 次 Prompt` : null,
          callMatch ? `约 ${callMatch[1]} 次模型调用` : null,
          "覆盖多款 MCP 工具",
          /优先 API 速率/.test(segment) ? "优先 API 速率" : null,
          /优先技术支持/.test(segment) ? "优先技术支持" : null,
          /多设备登录/.test(segment) ? "多设备登录" : null,
        ],
      }),
    );
  }
  if (plans.length === 0) {
    throw new Error("Unable to parse StepFun monthly plan cards");
  }

  return {
    provider: PROVIDER_IDS.STEPFUN,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseCucloudCodingPlans() {
  const pageUrl = "https://www.cucloud.cn/activity/kickoffseason.html";
  const { text } = await fetchRenderedPageText(pageUrl, "CUCloud Coding Plan parser", {
    waitForText: /Coding\s*Plan免费领|万份Coding\s*Plan/,
  });
  if (!/Coding\s*Plan免费领|万份Coding\s*Plan/i.test(text)) {
    throw new Error("Unable to locate CUCloud coding plan activity text");
  }

  const plans = [
    asPlan({
      name: "Coding Plan Lite 免费体验",
      currentPriceText: "¥0/月",
      currentPrice: 0,
      unit: "月",
      notes: "活动限量免费名额，先到先得",
      serviceDetails: [
        "特供 Lite 套餐",
        "1.8 万次/月",
        "与 AI 云桌面、AI 云主机、AI 云容器活动联动",
      ],
    }),
    asPlan({
      name: "Coding Plan Pro 免费体验",
      currentPriceText: "¥0/月",
      currentPrice: 0,
      unit: "月",
      notes: "活动限量免费名额，先到先得",
      serviceDetails: [
        "特供 Pro 套餐",
        "最高 9 万次/月",
        "Lite 与 Pro 共计 12000 个专属免费名额",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.CUCLOUD,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseScnetCodingPlans() {
  const pageUrl = "https://www.scnet.cn/ui/console/index.html#/llm/coding-plan";
  const docUrl = "https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/codingplan/subscriptionnotice.html";
  const html = await fetchText(docUrl);
  const rows = extractRows(html);
  const planRows = rows.filter((row) => row.length >= 3);
  const priceRow = planRows.find((row) => normalizeText(row[0]) === "价格");
  if (!priceRow || !/¥\s*20\s*\/\s*月/.test(priceRow[1] || "") || !/¥\s*100\s*\/\s*月/.test(priceRow[2] || "")) {
    throw new Error("Unable to parse SCNet Coding Plan pricing table");
  }
  const liteDetails = buildServiceDetailsFromRows(planRows, 1, { excludeLabels: ["套餐项", "价格"] });
  const proDetails = buildServiceDetailsFromRows(planRows, 2, { excludeLabels: ["套餐项", "价格"] });
  const modelRows = rows.filter((row) => row.length >= 2 && /^(MiniMax|Qwen)/i.test(normalizeText(row[0])));
  const modelDetails = modelRows.map((row) => `支持模型: ${normalizeText(row[0])} - ${normalizeText(row[1])}`);
  const sharedDetails = [
    "请求次数为模型调用的预估数值，通常一次用户提问会触发多次模型调用",
    "Lite 套餐和 Pro 套餐使用相同的模型资源和推理服务，区别仅在调用次数额度",
    "Anthropic 暂时只有 MiniMax-M2.5 模型支持",
    ...modelDetails,
  ];

  const plans = [
    asPlan({
      name: "Coding Plan Lite",
      currentPriceText: priceRow[1],
      unit: "月",
      notes: "国家超算互联网官方 Coding Plan 文档",
      serviceDetails: [...(liteDetails || []), ...sharedDetails],
    }),
    asPlan({
      name: "Coding Plan Pro",
      currentPriceText: priceRow[2],
      unit: "月",
      notes: "国家超算互联网官方 Coding Plan 文档",
      serviceDetails: [...(proDetails || []), ...sharedDetails],
    }),
  ];

  return {
    provider: PROVIDER_IDS.SCNET,
    sourceUrls: unique([docUrl, pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseCerebrasCodePlans() {
  const pageUrl = "https://www.cerebras.ai/blog/introducing-cerebras-code";
  const { text } = await fetchRenderedPageText(pageUrl, "Cerebras Code parser", {
    waitForText: /Cerebras\s+Code\s+Pro|Code\s+Max/,
  });
  if (!/Cerebras\s+Code\s+Pro/i.test(text) || !/Code\s+Max/i.test(text)) {
    throw new Error("Unable to locate Cerebras Code pricing text");
  }

  const plans = [
    asPlan({
      name: "Cerebras Code Pro",
      currentPriceText: "$50/月",
      currentPrice: 50,
      unit: "月",
      notes: "速率限制可能调整",
      serviceDetails: [
        "Qwen3-Coder access with fast, high-context completions",
        "最高 24 million tokens/day",
        "适合 indie devs、simple agentic workflows、weekend projects",
        "OpenAI-compatible inference endpoint",
        "131k-token context window",
      ],
    }),
    asPlan({
      name: "Cerebras Code Max",
      currentPriceText: "$200/月",
      currentPrice: 200,
      unit: "月",
      notes: "速率限制可能调整",
      serviceDetails: [
        "Qwen3-Coder access for heavy coding workflows",
        "最高 120 million tokens/day",
        "适合 full-time development、IDE integrations、code refactoring、multi-agent systems",
        "OpenAI-compatible inference endpoint",
        "131k-token context window",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.CEREBRAS_CODE,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseSyntheticPlans() {
  const pageUrl = "https://synthetic.new/pricing";
  const { text } = await fetchRenderedPageText(pageUrl, "Synthetic pricing parser", {
    waitForText: /Subscription\s+Packs|Standard\s+models/,
  });
  if (!/Subscription\s+Packs/i.test(text) || !/\$30\/mo/i.test(text)) {
    throw new Error("Unable to locate Synthetic subscription pack pricing text");
  }

  const plans = [
    asPlan({
      name: "Subscription Pack",
      currentPriceText: "$30/月",
      currentPrice: 30,
      unit: "月",
      notes: "也支持 usage-based $1/day",
      serviceDetails: [
        "500 messages/5hr",
        "3x higher rate limits than Claude's $20/month plan",
        "1 concurrent request per model; buy more packs to increase",
        "UI and API access",
        "No per-token billing for included always-on models",
        "Included models: DeepSeek、MiniMax M2.5、Kimi K2.5、Qwen3 Coder、GLM 等",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.SYNTHETIC,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseChutesPlans() {
  const pageUrl = "https://chutes.ai/";
  const pricingUrl = "https://chutes.ai/pricing";
  const { text } = await fetchRenderedPageText(pageUrl, "Chutes pricing parser", {
    waitForText: /Choose a plan that fits your needs|Base\s+\$3/,
  });
  if (!/Base\s+\$3\s+per month/i.test(text) || !/Plus\s+\$10\s+per month/i.test(text)) {
    throw new Error("Unable to locate Chutes subscription plan pricing text");
  }

  const plans = [
    asPlan({
      name: "Base",
      currentPriceText: "$3/月",
      currentPrice: 3,
      unit: "月",
      notes: "Frontier models not included",
      serviceDetails: ["5X the value of pay-as-you-go", "3% off PAYG pricing", "PAYG requests beyond limit"],
    }),
    asPlan({
      name: "Plus",
      currentPriceText: "$10/月",
      currentPrice: 10,
      unit: "月",
      notes: null,
      serviceDetails: ["5X the value of pay-as-you-go", "6% off PAYG pricing", "PAYG requests beyond limit", "Access to frontier models"],
    }),
    asPlan({
      name: "Pro",
      currentPriceText: "$20/月",
      currentPrice: 20,
      unit: "月",
      notes: "Best Value",
      serviceDetails: ["5X the value of pay-as-you-go", "10% off PAYG pricing", "PAYG requests beyond limit", "Access to frontier models"],
    }),
  ];

  return {
    provider: PROVIDER_IDS.CHUTES,
    sourceUrls: unique([pageUrl, pricingUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function parseKiloPassPlans() {
  const pageUrl = "https://kilo.ai/features/kilo-pass";
  const { text } = await fetchRenderedPageText(pageUrl, "Kilo Pass parser", {
    waitForText: /Kilo\s+Pass|Starter\s+\$19\/mo/,
  });
  if (!/Kilo\s+Pass/i.test(text) || !/Starter\s+\$19\/mo/i.test(text)) {
    throw new Error("Unable to locate Kilo Pass pricing text");
  }

  const plans = [
    asPlan({
      name: "Kilo Pass Starter",
      currentPriceText: "$19/月",
      currentPrice: 19,
      unit: "月",
      notes: "最高 $26.60/月 credits",
      serviceDetails: [
        "月度 AI token subscription",
        "最多 50% bonus credits",
        "月付首月 50% extra credits，连续订阅最高 40%",
        "余额可用于 KiloClaw、IDE、CLI、Cloud Agents、Kilo Gateway",
        "Access to 500+ AI models",
      ],
    }),
    asPlan({
      name: "Kilo Pass Pro",
      currentPriceText: "$49/月",
      currentPrice: 49,
      unit: "月",
      notes: "最高 $68.60/月 credits",
      serviceDetails: [
        "月度 AI token subscription",
        "最多 50% bonus credits",
        "月付首月 50% extra credits，连续订阅最高 40%",
        "余额可用于 KiloClaw、IDE、CLI、Cloud Agents、Kilo Gateway",
        "Access to 500+ AI models",
      ],
    }),
    asPlan({
      name: "Kilo Pass Expert",
      currentPriceText: "$199/月",
      currentPrice: 199,
      unit: "月",
      notes: "最高 $278.60/月 credits",
      serviceDetails: [
        "月度 AI token subscription",
        "最多 50% bonus credits",
        "月付首月 50% extra credits，连续订阅最高 40%",
        "余额可用于 KiloClaw、IDE、CLI、Cloud Agents、Kilo Gateway",
        "Access to 500+ AI models",
      ],
    }),
  ];

  return {
    provider: PROVIDER_IDS.KILO_PASS,
    sourceUrls: unique([pageUrl]),
    fetchedAt: new Date().toISOString(),
    plans: dedupePlans(plans),
  };
}

async function main() {
  const existingSnapshot = await loadExistingPricingSnapshot();
  const providers = [];
  const failures = [];
  const tasks = [
    { provider: PROVIDER_IDS.ZHIPU, fn: parseZhipuCodingPlans },
    { provider: PROVIDER_IDS.KIMI, fn: parseKimiCodingPlans },
    { provider: PROVIDER_IDS.XFYUN, fn: parseXfyunCodingPlans },
    { provider: PROVIDER_IDS.VOLCENGINE, fn: parseVolcengineCodingPlans },
    { provider: PROVIDER_IDS.MINIMAX, fn: parseMinimaxCodingPlans },
    { provider: PROVIDER_IDS.BAIDU, fn: parseBaiduCodingPlans },
    { provider: PROVIDER_IDS.TENCENT, fn: parseTencentCodingPlans },
    { provider: PROVIDER_IDS.TENCENT_TOKEN, fn: parseTencentTokenPlans },
    { provider: PROVIDER_IDS.JDCLOUD, fn: parseJdCloudCodingPlans },
    { provider: PROVIDER_IDS.KWAIKAT, fn: parseKwaikatCodingPlans },
    { provider: PROVIDER_IDS.XAIO, fn: parseXAioCodingPlans },
    { provider: PROVIDER_IDS.COMPSHARE, fn: parseCompshareCodingPlans },
    { provider: PROVIDER_IDS.ALIYUN, fn: parseAliyunCodingPlans },
    { provider: PROVIDER_IDS.ALIYUN_TOKEN, fn: parseAliyunTokenPlans },
    { provider: PROVIDER_IDS.INFINI, fn: parseInfiniCodingPlans },
    { provider: PROVIDER_IDS.XIAOMI, fn: parseXiaomiMimoTokenPlans },
    { provider: PROVIDER_IDS.OPENCODE, fn: parseOpenCodePlans },
    { provider: PROVIDER_IDS.GITHUB_COPILOT, fn: parseGithubCopilotPlans },
    { provider: PROVIDER_IDS.MTHREADS, fn: parseMthreadsCodingPlans },
    { provider: PROVIDER_IDS.STEPFUN, fn: parseStepfunStepPlans },
    { provider: PROVIDER_IDS.CUCLOUD, fn: parseCucloudCodingPlans },
    { provider: PROVIDER_IDS.SCNET, fn: parseScnetCodingPlans },
    { provider: PROVIDER_IDS.CEREBRAS_CODE, fn: parseCerebrasCodePlans },
    { provider: PROVIDER_IDS.SYNTHETIC, fn: parseSyntheticPlans },
    { provider: PROVIDER_IDS.CHUTES, fn: parseChutesPlans },
    { provider: PROVIDER_IDS.KILO_PASS, fn: parseKiloPassPlans },
  ];

  const results = await Promise.allSettled(tasks.map((task) => runTaskWithTimeout(task.fn)));
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const result = results[index];
    if (result.status === "rejected") {
      const message = result.reason?.message || String(result.reason || "unknown error");
      const failureMessage = `${task.provider}: ${message}`;
      failures.push(failureMessage);
      console.warn(`[pricing] ${task.fn.name} failed: ${message}`);
      continue;
    }

    try {
      const data = result.value;
      const { fetchedAt: _ignoredFetchedAt, ...providerWithoutFetchedAt } = data;
      const monthlyPlans = keepStandardMonthlyPlans(data.plans || [])
        .map((plan) => {
          const serviceDetails = plan.serviceDetails || normalizeServiceDetails(plan.notes);
          return {
            ...plan,
            serviceDetails,
          };
        })
        .filter((plan) => plan.name && (plan.currentPriceText || plan.notes || (plan.serviceDetails || []).length > 0));
      if (monthlyPlans.length === 0) {
        throw new Error(`${data.provider}: no standard monthly plans found`);
      }
      providers.push({
        ...providerWithoutFetchedAt,
        plans: monthlyPlans,
      });
    } catch (error) {
      const message = error?.message || String(error || "unknown error");
      const failureMessage = `${task.provider}: ${message}`;
      failures.push(failureMessage);
      console.warn(`[pricing] ${task.fn.name} failed: ${message}`);
    }
  }

  const providersWithFallback = restoreFailedProvidersFromSnapshot(
    providers,
    failures,
    existingSnapshot.providers,
  );

  const normalizedProviders = normalizeProviderCurrencySymbols(providersWithFallback);
  normalizedProviders.sort((left, right) =>
    String(left?.provider || "").localeCompare(String(right?.provider || "")),
  );

  const output = {
    generatedAt: new Date().toISOString(),
    providers: normalizedProviders,
    failures,
  };

  const outputText = `${JSON.stringify(output, null, 2)}\n`;

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, outputText, "utf8");

  const summary = providersWithFallback.map((provider) => `${provider.provider}: ${provider.plans.length}`).join(", ");
  console.log(`[pricing] wrote ${OUTPUT_FILE}`);
  console.log(`[pricing] plans -> ${summary}`);
  if (failures.length > 0) {
    console.log(`[pricing] failures -> ${failures.length}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[pricing] fatal:", error);
    process.exit(1);
  });
}

module.exports = {
  STALE_PROVIDER_NOTICE,
  buildStaleProviderFallback,
  extractProviderIdFromFailure,
  extractInfiniRouteChunkUrls,
  buildKimiCodePlansFromGoodsPayload,
  parseInfiniPlanFromBundle,
  parseInfiniServiceDetailsByTier,
  parseAliyunTokenPlansFromDocsHtml,
  parseCompshareCodingPlansFromHtml,
  parseKimiDomesticMembershipPlansFromText,
  parseJdCloudCodingPlansFromDocsText,
  parseJdCloudCodingPlansFromPageHtml,
  restoreFailedProvidersFromSnapshot,
};
