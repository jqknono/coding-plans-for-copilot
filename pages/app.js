const PRICING_DATA_PATH = "./provider-pricing.json";
const METRICS_DATA_PATH = "./openrouter-provider-metrics.json";
const OPENROUTER_PROVIDER_PLANS_DATA_PATH = "./openrouter-provider-plans.json";

const PROVIDER_LABELS = {
  "zhipu-ai": "智谱 z.ai",
  "kimi-ai": "Moonshot Kimi",
  "xfyun-ai": "讯飞星辰 MaaS",
  "volcengine-ai": "火山引擎",
  "minimax-ai": "MiniMax",
  "aliyun-ai": "阿里云通义千问",
  "aliyun-token-plan": "阿里云 Token Plan",
  "baidu-qianfan-ai": "百度智能云千帆",
  "tencent-cloud-ai": "腾讯云 Coding Plan",
  "tencent-cloud-token-plan": "腾讯云 Token Plan",
  "jdcloud-ai": "京东云 Coding Plan",
  "kwaikat-ai": "快手 KwaiKAT",
  "x-aio": "X-AIO",
  "compshare-ai": "优云智算",
  "infini-ai": "无问芯穹",
  "xiaomi-mimo": "小米 MiMo",
  "opencode": "OpenCode",
};

const MODEL_ORG_LABELS = {
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "MoonshotAI",
  "z-ai": "z.ai",
  minimax: "MiniMax",
  bytedance: "ByteDance",
  "bytedance-seed": "ByteDance Seed",
  kwaipilot: "KwaiPilot",
  meituan: "Meituan",
  mistralai: "Mistral AI",
  stepfun: "StepFun",
};

const PROVIDER_BUY_URLS = {
  "zhipu-ai": "https://bigmodel.cn/glm-coding",
  "kimi-ai": "https://www.kimi.com/code/zh",
  "xfyun-ai": "https://maas.xfyun.cn/modelSquare",
  "volcengine-ai": "https://www.volcengine.com/activity/codingplan",
  "minimax-ai": "https://platform.minimaxi.com/subscribe/token-plan",
  "aliyun-ai": "https://common-buy.aliyun.com/?commodityCode=sfm_codingplan_public_cn#/buy",
  "aliyun-token-plan": "https://common-buy.aliyun.com/token-plan/",
  "baidu-qianfan-ai": "https://cloud.baidu.com/product/codingplan.html",
  "tencent-cloud-ai": "https://buy.cloud.tencent.com/hunyuan",
  "tencent-cloud-token-plan": "https://cloud.tencent.com/act/pro/tokenplan",
  "jdcloud-ai": "https://www.jdcloud.com/cn/pages/codingplan",
  "kwaikat-ai": "https://www.streamlake.com/marketing/coding-plan",
  "x-aio": "https://code.x-aio.com/",
  "compshare-ai": "https://www.compshare.cn/docs/modelverse/package_plan/package",
  "infini-ai": "https://cloud.infini-ai.com/platform/ai",
};

const PROVIDER_CURRENCY_BUY_URLS = {
  "kimi-ai": {
    "¥": "https://www.kimi.com/zh-cn/help/membership/membership-pricing",
    "$": "https://www.kimi.com/code",
  },
};

const reloadButtonEl = document.querySelector("#reloadButton");
const tabIntroTitleEl = document.querySelector("#tabIntroTitle");
const tabIntroDescEl = document.querySelector("#tabIntroDesc");

const domesticTabButtonEl = document.querySelector("#domesticTabButton");
const overseasTabButtonEl = document.querySelector("#overseasTabButton");
const metricsTabButtonEl = document.querySelector("#metricsTabButton");

const domesticPanelEl = document.querySelector("#domesticPanel");
const overseasPanelEl = document.querySelector("#overseasPanel");
const metricsPanelEl = document.querySelector("#metricsPanel");

const domesticGridEl = document.querySelector("#domesticGrid");
const overseasGridEl = document.querySelector("#overseasGrid");
const domesticErrorBannerEl = document.querySelector("#domesticErrorBanner");
const overseasErrorBannerEl = document.querySelector("#overseasErrorBanner");
const overseasPendingEl = document.querySelector("#overseasPending");
const overseasPendingCountEl = document.querySelector("#overseasPendingCount");
const overseasPendingListEl = document.querySelector("#overseasPendingList");

const metricsTableContainerEl = document.querySelector("#metricsTableContainer");
const metricsOrgFilterInputEl = document.querySelector("#metricsOrgFilterInput");
const metricsModelFilterInputEl = document.querySelector("#metricsModelFilterInput");
const metricsProviderFilterInputEl = document.querySelector("#metricsProviderFilterInput");
const metricsOrgFilterDatalistEl = null;
const metricsModelFilterDatalistEl = null;
const metricsProviderFilterDatalistEl = null;
const metricsErrorBannerEl = document.querySelector("#metricsErrorBanner");
const metricsFailuresEl = document.querySelector("#metricsFailures");
const metricsFailuresCountEl = document.querySelector("#metricsFailuresCount");
const metricsFailuresListEl = document.querySelector("#metricsFailuresList");
const metricsGeneratedAtEl = document.querySelector("#metricsGeneratedAt");
const metricsCaptureWindowEl = document.querySelector("#metricsCaptureWindow");
const metricsToolbarHintInlineEl = document.querySelector("#metricsToolbarHintInline");

const providerCountEl = document.querySelector("#providerCount");
const planCountEl = document.querySelector("#planCount");
const primaryCountLabelEl = document.querySelector("#primaryCountLabel");
const secondaryCountLabelEl = document.querySelector("#secondaryCountLabel");
const generatedAtEl = document.querySelector("#generatedAt");

let activeTab = "domestic";

const appState = {
  mergedProviders: [],
  pricingGeneratedAt: null,
  openrouterPlansGeneratedAt: null,
  openrouterPendingData: [],
  pricingFailures: [],
  dataLoaded: false,
};

const metricsState = {
  rawData: null,
  org: ["all"],
  model: ["all"],
  provider: ["all"],
  sortKey: "organization",
  sortOrder: "asc",
};

const providerPlanLookup = new Map();
const FILTER_ALL_VALUE = "all";

// ─── Utilities ───────────────────────────────────────────────

function normalizeFilterValues(values) {
  const list = Array.isArray(values) ? values : [values];
  const normalized = [];
  for (const item of list) {
    const value = String(item || "").trim();
    if (!value || normalized.includes(value)) {
      continue;
    }
    normalized.push(value);
  }
  return normalized.length > 0 ? normalized : [FILTER_ALL_VALUE];
}

function isAllFilterSelected(values) {
  return normalizeFilterValues(values).includes(FILTER_ALL_VALUE);
}

function matchesFilterValue(candidate, selectedValues) {
  const normalized = normalizeFilterValues(selectedValues);
  if (normalized.includes(FILTER_ALL_VALUE)) {
    return true;
  }
  return normalized.includes(String(candidate || "").trim());
}

function getFilterSelectableValues(options) {
  return options
    .map((option) => String(option?.value || "").trim())
    .filter((value) => value && value !== FILTER_ALL_VALUE);
}

function normalizeSelectedFilterValues(options, selectedValues) {
  const optionValueSet = new Set(options.map((option) => String(option?.value || "").trim()).filter(Boolean));
  const normalized = normalizeFilterValues(selectedValues).filter((value) => optionValueSet.has(value));
  const selectableValues = getFilterSelectableValues(options);
  const selectedNonAll = normalized.filter((value) => value !== FILTER_ALL_VALUE);
  if (normalized.includes(FILTER_ALL_VALUE) || selectedNonAll.length === 0) {
    return [FILTER_ALL_VALUE];
  }
  if (selectableValues.length > 0 && selectedNonAll.length >= selectableValues.length) {
    return [FILTER_ALL_VALUE];
  }
  return selectableValues.filter((value) => selectedNonAll.includes(value));
}

function toggleSelectedFilterValue(options, selectedValues, toggledValue) {
  const value = String(toggledValue || "").trim();
  if (!value) {
    return [FILTER_ALL_VALUE];
  }
  if (value === FILTER_ALL_VALUE) {
    return [FILTER_ALL_VALUE];
  }

  const base = normalizeSelectedFilterValues(options, selectedValues);
  let next = base.includes(FILTER_ALL_VALUE) ? [] : [...base];
  if (next.includes(value)) {
    next = next.filter((item) => item !== value);
  } else {
    next.push(value);
  }
  return normalizeSelectedFilterValues(options, next);
}

function readSelectedFilterValues(inputEl) {
  if (!inputEl) {
    return [FILTER_ALL_VALUE];
  }
  const rawValues = String(inputEl.dataset.values || "").trim();
  if (rawValues) {
    try {
      const parsed = JSON.parse(rawValues);
      return normalizeFilterValues(parsed);
    } catch {
      return normalizeFilterValues(rawValues.split(","));
    }
  }
  return normalizeFilterValues(inputEl.dataset.value || FILTER_ALL_VALUE);
}

function writeSelectedFilterValues(inputEl, values) {
  if (!inputEl) {
    return;
  }
  const normalized = normalizeFilterValues(values);
  inputEl.dataset.values = JSON.stringify(normalized);
  inputEl.dataset.value = normalized[0] || FILTER_ALL_VALUE;
}

function summarizeSelectedFilterText(options, selectedValues) {
  const normalized = normalizeSelectedFilterValues(options, selectedValues);
  const allOption = options.find((option) => option.value === FILTER_ALL_VALUE);
  if (normalized.includes(FILTER_ALL_VALUE)) {
    return allOption?.text || "全部";
  }
  const labels = options
    .filter((option) => normalized.includes(option.value))
    .map((option) => option.text);
  if (labels.length <= 2) {
    return labels.join("、");
  }
  return `已选 ${labels.length} 项`;
}

function formatDate(isoText) {
  if (!isoText) {
    return "--";
  }
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDateInBeijing(isoText) {
  if (!isoText) {
    return "--";
  }
  const date = new Date(isoText);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function createElement(tagName, className, textContent) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (textContent !== undefined && textContent !== null) {
    element.textContent = textContent;
  }
  return element;
}

function setError(target, message) {
  if (!target) {
    return;
  }
  if (!message) {
    target.classList.add("hidden");
    target.textContent = "";
    return;
  }
  target.classList.remove("hidden");
  target.textContent = message;
}

function setStats(labelOne, countOne, labelTwo, countTwo, generatedAt) {
  primaryCountLabelEl.textContent = labelOne;
  secondaryCountLabelEl.textContent = labelTwo;
  providerCountEl.textContent = String(countOne);
  planCountEl.textContent = String(countTwo);
  generatedAtEl.textContent = generatedAt || "--";
}

function normalizeUnit(unit) {
  return String(unit || "").trim() || "未标注";
}

function detectCurrencySymbol(text, fallbackSymbol = "$") {
  const value = String(text || "");
  if (/[¥￥]|人民币|\b(?:CNY|RMB)\b|元/i.test(value)) {
    return "¥";
  }
  if (/\$|美元|\b(?:USD|US\$)\b|dollar/i.test(value)) {
    return "$";
  }
  return fallbackSymbol;
}

function getPlanCurrencySymbol(plan) {
  const hintText = [plan?.currentPriceText, plan?.originalPriceText, plan?.notes]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(" | ");
  return detectCurrencySymbol(hintText, "$");
}

function displayPrice(plan) {
  return plan.currentPriceText
    || (Number.isFinite(plan.currentPrice) ? `${getPlanCurrencySymbol(plan)}${plan.currentPrice}` : "价格待确认");
}

function getPlanServices(plan) {
  const rawList = Array.isArray(plan?.serviceDetails)
    ? plan.serviceDetails
    : plan?.serviceDetails
      ? [plan.serviceDetails]
      : [];
  return [...new Set(rawList.map((item) => String(item || "").trim()).filter(Boolean))];
}

function formatOfferPriceText(rawValue, fallbackSymbol = "$") {
  const rawText = String(rawValue || "").trim();
  if (!rawText) {
    return null;
  }
  const numberMatch = rawText.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!numberMatch) {
    return null;
  }
  const amount = numberMatch[1];
  const symbol = detectCurrencySymbol(rawText, fallbackSymbol);
  return `${symbol}${amount}/月`;
}

function getPlanOffer(plan) {
  const fallbackSymbol = getPlanCurrencySymbol(plan);

  if (plan && plan.offerName) {
    const explicitPriceText = formatOfferPriceText(plan.offerPriceText || plan.offerPrice || "", fallbackSymbol);
    if (explicitPriceText) {
      return { title: String(plan.offerName), priceText: explicitPriceText };
    }
  }

  if (plan && plan.firstMonthPriceText) {
    const firstMonthPriceText = formatOfferPriceText(plan.firstMonthPriceText, fallbackSymbol);
    if (firstMonthPriceText) {
      return { title: "首月特惠", priceText: firstMonthPriceText };
    }
  }
  if (plan && Number.isFinite(plan.firstMonthPrice)) {
    return { title: "首月特惠", priceText: `${fallbackSymbol}${plan.firstMonthPrice}/月` };
  }

  const notesText = String(plan?.notes || "");
  const offerPatterns = [
    /((?:新客|新人|新用户)?\s*首月(?:特惠|优惠)?)[^0-9¥￥$]*((?:USD|US\$)?\s*[¥￥$]?\s*[0-9]+(?:\.[0-9]+)?(?:\s*元)?(?:\s*\/\s*(?:月|month|monthly))?)/i,
    /((?:首购优惠|首购特惠))[:：]?\s*((?:USD|US\$)?\s*[¥￥$]?\s*[0-9]+(?:\.[0-9]+)?(?:\s*元)?(?:\s*\/\s*(?:月|month|monthly))?)/i,
    /((?:新人专享|新客专享|新用户专享))[^0-9¥￥$]*((?:USD|US\$)?\s*[¥￥$]?\s*[0-9]+(?:\.[0-9]+)?(?:\s*元)?(?:\s*\/\s*(?:月|month|monthly))?)/i,
  ];
  for (const pattern of offerPatterns) {
    const matched = notesText.match(pattern);
    if (!matched) {
      continue;
    }
    const priceText = formatOfferPriceText(matched[2], fallbackSymbol);
    if (!priceText) {
      continue;
    }
    return { title: String(matched[1]).replace(/\s+/g, ""), priceText };
  }

  const labelOnlyMatch = notesText.match(/(新人专享|新客专享|新用户专享|新客首月|新人首月)/i);
  if (labelOnlyMatch && plan?.currentPriceText && plan?.originalPriceText) {
    const currentAsOffer = formatOfferPriceText(plan.currentPriceText, fallbackSymbol);
    if (currentAsOffer) {
      return { title: String(labelOnlyMatch[1]).replace(/\s+/g, ""), priceText: currentAsOffer };
    }
  }

  return null;
}

// ─── Data Merging ────────────────────────────────────────────

function getProviderBuyUrl(provider) {
  if (provider && Array.isArray(provider.plans)) {
    const planWithBuyUrl = provider.plans.find((p) => p && p.buyUrl);
    if (planWithBuyUrl) {
      return String(planWithBuyUrl.buyUrl);
    }
  }
  if (provider && PROVIDER_BUY_URLS[provider.provider]) {
    return PROVIDER_BUY_URLS[provider.provider];
  }
  if (provider && Array.isArray(provider.sourceUrls) && provider.sourceUrls.length > 0) {
    return provider.sourceUrls[0];
  }
  return null;
}

function getOpenrouterBuyUrl(provider) {
  if (provider && provider.pricingPageUrl) {
    return provider.pricingPageUrl;
  }
  if (provider && Array.isArray(provider.sourceUrls) && provider.sourceUrls.length > 0) {
    return provider.sourceUrls[0];
  }
  return null;
}

function getPricingFailureBuyUrl(failureItem) {
  const text = String(failureItem || "").trim();
  if (!text) {
    return null;
  }
  const colonIndex = text.indexOf(":");
  const providerId = (colonIndex >= 0 ? text.slice(0, colonIndex) : text).trim();
  return PROVIDER_BUY_URLS[providerId] || null;
}

function mergeAllProviderData(pricingData, openrouterData) {
  const providerMap = new Map();
  const refMap = new Map();

  const orProviders = Array.isArray(openrouterData?.providers) ? openrouterData.providers : [];
  for (const p of orProviders) {
    const key = p.providerId || p.slug;
    const entry = {
      id: p.providerId || p.slug,
      slug: p.slug,
      openrouterName: p.openrouterName || p.slug,
      displayName: PROVIDER_LABELS[p.providerId] || p.openrouterName || p.slug,
      plans: [...(p.plans || [])],
      sourceUrls: p.sourceUrls || [],
      buyUrl: PROVIDER_BUY_URLS[p.providerId] || getOpenrouterBuyUrl(p),
      pricingPageUrl: p.pricingPageUrl,
    };
    providerMap.set(key, entry);
    refMap.set(key, entry);
    if (p.providerId && p.providerId !== p.slug) {
      refMap.set(p.providerId, entry);
    }
  }

  const ppProviders = Array.isArray(pricingData?.providers) ? pricingData.providers : [];
  for (const p of ppProviders) {
    if (refMap.has(p.provider)) {
      const existing = refMap.get(p.provider);
      const existingNames = new Set(existing.plans.map((pl) => pl.name));
      for (const plan of p.plans || []) {
        if (!existingNames.has(plan.name)) {
          existing.plans.push(plan);
        }
      }
      existing.sourceUrls = Array.from(new Set([...(existing.sourceUrls || []), ...(p.sourceUrls || [])]));
      existing.staleReason = p.staleReason || existing.staleReason || null;
      existing.staleFailure = p.staleFailure || existing.staleFailure || null;
      if (!existing.buyUrl) {
        existing.buyUrl = getProviderBuyUrl(p);
      }
    } else {
      const entry = {
        id: p.provider,
        slug: null,
        openrouterName: null,
        displayName: PROVIDER_LABELS[p.provider] || p.provider,
        plans: [...(p.plans || [])],
        sourceUrls: p.sourceUrls || [],
        buyUrl: PROVIDER_BUY_URLS[p.provider] || getProviderBuyUrl(p),
        pricingPageUrl: null,
        staleReason: p.staleReason || null,
        staleFailure: p.staleFailure || null,
      };
      providerMap.set(p.provider, entry);
      refMap.set(p.provider, entry);
    }
  }

  const seen = new Set();
  const result = [];
  for (const value of providerMap.values()) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildProviderPlanLookup(providers) {
  providerPlanLookup.clear();
  for (const p of providers) {
    if ((p.plans || []).length === 0) {
      continue;
    }
    const hasCNY = p.plans.some((plan) => getPlanCurrencySymbol(plan) === "¥");
    const hasUSD = p.plans.some((plan) => getPlanCurrencySymbol(plan) === "$");
    const tab = hasUSD ? "overseas" : hasCNY ? "domestic" : "overseas";
    const regionLabel = tab === "domestic" ? "大陆套餐" : "海外套餐";
    const cardId = `provider-card-${p.slug || p.id}`;
    const info = { tab, cardId, displayName: p.displayName, regionLabel };
    if (p.openrouterName) {
      providerPlanLookup.set(p.openrouterName.toLowerCase(), info);
    }
    if (p.slug) {
      providerPlanLookup.set(p.slug.toLowerCase(), info);
    }
    if (p.id) {
      providerPlanLookup.set(p.id.toLowerCase(), info);
    }
    if (p.displayName) {
      providerPlanLookup.set(p.displayName.toLowerCase(), info);
    }
  }
}

function findProviderPlanLink(providerName, providerSlug) {
  const slugKey = String(providerSlug || "").toLowerCase().trim();
  if (slugKey && providerPlanLookup.has(slugKey)) {
    return providerPlanLookup.get(slugKey) || null;
  }
  const key = String(providerName || "").toLowerCase().trim();
  return providerPlanLookup.get(key) || null;
}

// ─── Plan Card Building ─────────────────────────────────────

function normalizePlanNotes(plan, options = {}) {
  const { hideSourceUrl = false } = options;
  const raw = String(plan?.notes || "").trim();
  if (!raw) {
    return null;
  }
  if (!hideSourceUrl) {
    return raw;
  }

  // Some overseas plans include an auto-injected “来源: https://...” note.
  // Keep other meaningful notes, only strip pure source attribution.
  let cleaned = raw;
  cleaned = cleaned.replace(/(?:^|\s*[|；;,，]\s*|\n)\s*(来源|source)\s*[:：]\s*https?:\/\/\S+/gi, "");
  cleaned = cleaned.replace(/^[|；;,，\s]+/, "").replace(/[|；;,，\s]+$/, "").trim();
  return cleaned || null;
}

function buildPlanList(plans, options = {}) {
  const planList = createElement("ul", "plan-list");
  for (const plan of plans) {
    const item = createElement("li", "plan-item");
    const name = createElement("h3", "plan-name", plan.name || "未命名套餐");
    const priceRow = createElement("p", "price-row");

    const isDiscount =
      plan.originalPriceText &&
      plan.originalPriceText !== plan.currentPriceText &&
      String(plan.originalPriceText).trim() !== "";

    if (isDiscount) {
      priceRow.append(createElement("span", "price-original", `原价 ${plan.originalPriceText}`));
      priceRow.append(createElement("span", "price-discount", `优惠价 ${displayPrice(plan)}`));
    } else {
      priceRow.append(createElement("span", "price-now", displayPrice(plan)));
    }

    // Unit tag is usually redundant because most price texts already contain “/月”.
    // Only show when the unit is NOT month-like.
    if (plan.unit) {
      const unitText = normalizeUnit(plan.unit);
      const isMonthLike = /月|month|monthly/i.test(unitText);
      if (!isMonthLike) {
        priceRow.append(createElement("span", "unit-tag", unitText));
      }
    }

    item.append(name, priceRow);

    const offerInfo = getPlanOffer(plan);
    if (offerInfo) {
      const offerCard = createElement("div", "offer-card");
      offerCard.append(
        createElement("span", "offer-name", offerInfo.title),
        createElement("span", "offer-price", offerInfo.priceText),
      );
      item.append(offerCard);
    }

    const serviceItems = getPlanServices(plan);
    if (serviceItems.length > 0) {
      const serviceBlock = createElement("section", "plan-services");
      serviceBlock.append(createElement("p", "plan-services-title", "服务内容"));
      const serviceList = createElement("ul", "plan-service-list");
      for (const serviceText of serviceItems) {
        serviceList.append(createElement("li", "plan-service-item", serviceText));
      }
      serviceBlock.append(serviceList);
      item.append(serviceBlock);
    }

    const notesText = normalizePlanNotes(plan, options);
    if (notesText) {
      item.append(createElement("p", "plan-notes", notesText));
    }

    planList.append(item);
  }
  return planList;
}

function getProviderBuyUrlForCurrency(provider, primaryPlans, primarySymbol) {
  const regionalUrls = PROVIDER_CURRENCY_BUY_URLS[provider?.id] || PROVIDER_CURRENCY_BUY_URLS[provider?.provider];
  if (regionalUrls && regionalUrls[primarySymbol]) {
    return regionalUrls[primarySymbol];
  }

  const planWithBuyUrl = (primaryPlans || []).find((plan) => plan && plan.buyUrl);
  if (planWithBuyUrl) {
    return String(planWithBuyUrl.buyUrl);
  }

  return provider?.buyUrl || null;
}

// ─── Tab Rendering: Domestic / Overseas ──────────────────────

function renderCurrencyFilteredTab(gridEl, providers, primarySymbol, foldedLabel) {
  gridEl.replaceChildren();

  const hideSourceUrlNotes = primarySymbol === "$";

  const relevant = providers.filter((p) =>
    (p.plans || []).some((plan) => getPlanCurrencySymbol(plan) === primarySymbol),
  );

  if (relevant.length === 0) {
    gridEl.append(createElement("article", "empty", "暂无可展示的套餐数据。"));
    return { providerCount: 0, planCount: 0 };
  }

  let totalPlans = 0;
  for (const provider of relevant) {
    const primaryPlans = (provider.plans || []).filter((plan) => getPlanCurrencySymbol(plan) === primarySymbol);
    const secondaryPlans = (provider.plans || []).filter((plan) => getPlanCurrencySymbol(plan) !== primarySymbol);
    totalPlans += primaryPlans.length;

    const card = createElement("article", "provider-card");
    card.id = `provider-card-${provider.slug || provider.id}`;

    const head = createElement("header", "provider-head");
    head.append(createElement("h2", "provider-title", provider.displayName));

    const buyUrl = getProviderBuyUrlForCurrency(provider, primaryPlans, primarySymbol);
    if (buyUrl) {
      const buyLink = createElement("a", "buy-link", "前往了解");
      buyLink.href = buyUrl;
      buyLink.target = "_blank";
      buyLink.rel = "noopener noreferrer";
      head.append(buyLink);
    }

    card.append(head);

    if (primaryPlans.length > 0) {
      card.append(buildPlanList(primaryPlans, { hideSourceUrl: hideSourceUrlNotes }));
    }

    if (secondaryPlans.length > 0) {
      const details = createElement("details", "folded-plans");
      const summary = createElement("summary", "");
      summary.textContent = `${foldedLabel} (${secondaryPlans.length})`;
      details.append(summary, buildPlanList(secondaryPlans, { hideSourceUrl: hideSourceUrlNotes }));
      card.append(details);
    }

    if (provider.staleReason) {
      const staleNote = createElement("p", "provider-stale-note", provider.staleReason);
      if (provider.staleFailure) {
        staleNote.title = provider.staleFailure;
      }
      card.append(staleNote);
    }

    gridEl.append(card);
  }

  return { providerCount: relevant.length, planCount: totalPlans };
}

function renderDomesticTab() {
  const { providerCount, planCount } = renderCurrencyFilteredTab(
    domesticGridEl,
    appState.mergedProviders,
    "¥",
    "其他币种套餐",
  );

  // 失败项不要用 banner 打断阅读：放入折叠区（默认收起）。
  setError(domesticErrorBannerEl, "");
  renderPricingFailures();

  if (activeTab === "domestic") {
    setStats("提供商", providerCount, "套餐数", planCount, formatDate(appState.pricingGeneratedAt));
  }
}

function renderPricingFailures() {
  const failures = Array.isArray(appState.pricingFailures) ? appState.pricingFailures : [];
  const panel = document.getElementById("pricingFailures");
  const countEl = document.getElementById("pricingFailuresCount");
  const listEl = document.getElementById("pricingFailuresList");
  if (!panel || !countEl || !listEl) {
    return;
  }

  countEl.textContent = String(failures.length);
  listEl.replaceChildren();

  if (failures.length === 0) {
    panel.classList.add("hidden");
    panel.removeAttribute("open");
    return;
  }

  for (const item of failures) {
    const line = createElement("li", "", "");
    line.append(document.createTextNode(String(item)));

    const buyUrl = getPricingFailureBuyUrl(item);
    if (buyUrl) {
      line.append(document.createTextNode(" "));
      const link = createElement("a", "buy-link", "价格官网");
      link.href = buyUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      line.append(link);
    }

    listEl.append(line);
  }
  panel.classList.remove("hidden");
  panel.removeAttribute("open");
}

function renderOverseasTab() {
  const { providerCount, planCount } = renderCurrencyFilteredTab(
    overseasGridEl,
    appState.mergedProviders,
    "$",
    "人民币计价套餐",
  );

  renderOverseasPending();

  if (activeTab === "overseas") {
    const genAt = appState.openrouterPlansGeneratedAt
      || formatDateInBeijing(appState.pricingGeneratedAt);
    setStats("提供商", providerCount, "套餐数", planCount, genAt);
  }
}

function renderOverseasPending() {
  const pending = appState.openrouterPendingData;
  overseasPendingListEl.replaceChildren();
  overseasPendingCountEl.textContent = String(pending.length);

  if (pending.length === 0) {
    overseasPendingEl.classList.add("hidden");
    overseasPendingEl.removeAttribute("open");
    return;
  }

  for (const item of pending) {
    const line = createElement("li", "", "");
    const providerLabel = `${item.openrouterName || item.slug || "未命名 Provider"} (${item.slug || "--"})`;
    const statusLabel = item.blocked ? "访问可能被拦截" : "待解析";
    const reasonText = String(item.reason || "套餐页面暂无可解析的标准月费数据");
    line.textContent = `${providerLabel}：${statusLabel}；${reasonText}`;

    const pendingLink = item.pricingPageUrl || item.officialWebsiteUrl || null;
    if (pendingLink) {
      const link = createElement("a", "buy-link", item.pricingPageUrl ? "价格页" : "官网");
      link.href = pendingLink;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.style.marginLeft = "0.5rem";
      line.append(link);
    }
    overseasPendingListEl.append(line);
  }

  overseasPendingEl.classList.remove("hidden");
  overseasPendingEl.removeAttribute("open");
}

// ─── Tab Rendering: Metrics ──────────────────────────────────

function formatMetricNumber(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "--";
  }
  if (Number.isInteger(amount)) {
    return String(amount);
  }
  return amount.toFixed(2).replace(/\.?0+$/, "");
}

function formatLatencySeconds(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return "--";
  }
  const seconds = amount / 1000;
  if (seconds >= 10) {
    return formatMetricNumber(seconds);
  }
  return seconds.toFixed(3).replace(/\.?0+$/, "");
}

function readMetricValue(metric, key) {
  if (!metric || typeof metric !== "object") {
    return "--";
  }
  return formatMetricNumber(metric[key]);
}

function readLatencySeconds(metric, key) {
  if (!metric || typeof metric !== "object") {
    return "--";
  }
  return formatLatencySeconds(metric[key]);
}

function createMetricFilterOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function createDatalistOption(text) {
  const option = document.createElement("option");
  option.value = text;
  return option;
}

// Global map to store current options for lookup
const currentFilterOptions = {
  org: [],
  model: [],
  provider: []
};

const dropdownControllers = new WeakMap();

function ensureFilterDropdown(inputEl, filterKey) {
  if (!inputEl) {
    return null;
  }
  if (dropdownControllers.has(inputEl)) {
    return dropdownControllers.get(inputEl);
  }

  const host = inputEl.closest(".searchable-select") || inputEl.parentElement;

  // Watermark: always visible to indicate "click to open" (not a placeholder).
  const watermarkEl = document.createElement("span");
  watermarkEl.className = "searchable-select-watermark";
  watermarkEl.textContent = "点击展开，可多选";
  host.append(watermarkEl);

  const dropdownEl = document.createElement("div");
  dropdownEl.className = "searchable-select-dropdown hidden";
  dropdownEl.setAttribute("role", "listbox");
  dropdownEl.setAttribute("aria-multiselectable", "true");
  dropdownEl.setAttribute("aria-label", "筛选候选项");
  host.append(dropdownEl);

  const dropdownSearchEl = document.createElement("input");
  dropdownSearchEl.type = "text";
  dropdownSearchEl.className = "searchable-select-dropdown-search";
  dropdownSearchEl.setAttribute("aria-label", "搜索筛选项");
  dropdownSearchEl.placeholder = "输入关键词过滤，可多选...";

  const dividerEl = document.createElement("div");
  dividerEl.className = "searchable-select-dropdown-divider";

  const optionsWrapEl = document.createElement("div");
  optionsWrapEl.className = "searchable-select-options";

  dropdownEl.append(dropdownSearchEl, dividerEl, optionsWrapEl);

  let isOpen = false;
  let activeIndex = -1;
  let lastCommittedText = String(inputEl.value || "");
  let lastRenderOptions = [];

  function getOptions() {
    return currentFilterOptions[filterKey] || [];
  }

  function filterOptions(query) {
    const q = String(query || "").trim().toLowerCase();
    const options = getOptions();
    if (!q) {
      return options;
    }
    return options.filter((opt) => String(opt.text || "").toLowerCase().includes(q));
  }

  function render(query) {
    const selectedValues = normalizeSelectedFilterValues(getOptions(), readSelectedFilterValues(inputEl));
    const selectedValueSet = new Set(selectedValues);
    const options = filterOptions(query);
    optionsWrapEl.replaceChildren();
    lastRenderOptions = options;
    activeIndex = -1;

    if (options.length === 0) {
      optionsWrapEl.append(createElement("div", "searchable-select-empty", "无匹配项"));
      activeIndex = -1;
      return;
    }

    options.forEach((opt, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "searchable-select-option";
      btn.textContent = opt.text;
      btn.dataset.value = opt.value;
      btn.setAttribute("role", "option");
      const isSelected = selectedValueSet.has(opt.value);
      btn.setAttribute("aria-selected", isSelected ? "true" : "false");
      btn.classList.toggle("is-selected", isSelected);
      if (opt.value === FILTER_ALL_VALUE) {
        btn.classList.add("is-all-option");
      }

      // Use mousedown so selection works even if input would blur first.
      btn.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      btn.addEventListener("click", () => {
        const nextSelectedValues = toggleSelectedFilterValue(getOptions(), readSelectedFilterValues(inputEl), opt.value);
        writeSelectedFilterValues(inputEl, nextSelectedValues);
        const nextText = summarizeSelectedFilterText(getOptions(), nextSelectedValues);
        inputEl.value = nextText;
        lastCommittedText = nextText;
        render(dropdownSearchEl.value);
        handleMetricsFilterChange();
        dropdownSearchEl.focus();
      });

      optionsWrapEl.append(btn);

      if (opt.value === selectedValues[0]) {
        activeIndex = index;
      }
    });

    if (activeIndex < 0) {
      activeIndex = 0;
    }
  }

  function open() {
    if (isOpen) {
      return;
    }
    isOpen = true;
    dropdownEl.classList.remove("hidden");
    watermarkEl.classList.add("hidden");
    dropdownSearchEl.value = "";
    render("");
    // Focus search box for filtering.
    dropdownSearchEl.focus();
    dropdownSearchEl.select();
  }

  function close() {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    dropdownEl.classList.add("hidden");
    activeIndex = -1;
    watermarkEl.classList.remove("hidden");

    if (lastCommittedText) {
      inputEl.value = lastCommittedText;
    }
  }

  function moveActive(delta) {
    const buttons = Array.from(optionsWrapEl.querySelectorAll(".searchable-select-option"));
    if (buttons.length === 0) {
      return;
    }
    activeIndex = Math.max(0, Math.min(buttons.length - 1, activeIndex + delta));
    buttons.forEach((btn, idx) => {
      btn.classList.toggle("is-active", idx === activeIndex);
    });
    buttons[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function commitActive() {
    const buttons = Array.from(optionsWrapEl.querySelectorAll(".searchable-select-option"));
    if (buttons.length === 0) {
      return;
    }
    const idx = activeIndex >= 0 ? activeIndex : 0;
    const btn = buttons[idx];
    const value = String(btn.dataset.value || "all");
    const nextSelectedValues = toggleSelectedFilterValue(getOptions(), readSelectedFilterValues(inputEl), value);
    writeSelectedFilterValues(inputEl, nextSelectedValues);
    inputEl.value = summarizeSelectedFilterText(getOptions(), nextSelectedValues);
    lastCommittedText = inputEl.value;
    render(dropdownSearchEl.value);
    handleMetricsFilterChange();
  }

  function onDocumentPointerDown(event) {
    const target = event.target;
    if (target === inputEl || dropdownEl.contains(target) || host.contains(target)) {
      return;
    }
    close();
  }

  document.addEventListener("pointerdown", onDocumentPointerDown);

  // Main input is for display/trigger only; search lives in dropdown.
  inputEl.readOnly = true;
  inputEl.addEventListener("focus", () => {
    // Keep watermark visible until user explicitly opens.
  });

  inputEl.addEventListener("click", () => {
    open();
  });

  inputEl.addEventListener("keydown", (event) => {
    if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      open();
    }
    if (!isOpen) {
      if (event.key === "Enter") {
        event.preventDefault();
        open();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commitActive();
    }
  });

  dropdownSearchEl.addEventListener("input", () => {
    render(dropdownSearchEl.value);
  });

  dropdownSearchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      // Return focus to trigger.
      inputEl.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commitActive();
    }
  });

  // Close when focus leaves both trigger and dropdown (with small delay to
  // allow click selection).
  const scheduleCloseOnFocusOut = () => {
    setTimeout(() => {
      const active = document.activeElement;
      if (active === inputEl) {
        return;
      }
      if (dropdownEl.contains(active)) {
        return;
      }
      close();
    }, 120);
  };

  inputEl.addEventListener("blur", scheduleCloseOnFocusOut);
  dropdownSearchEl.addEventListener("blur", scheduleCloseOnFocusOut);

  const controller = {
    open,
    close,
    render,
    isOpen: () => isOpen,
    syncCommittedText: (text) => {
      lastCommittedText = String(text || "");
    },
  };

  dropdownControllers.set(inputEl, controller);
  return controller;
}

function setSearchableFilterOptions(filter, options, selectedValue, filterKey) {
  // Update global options store
  if (filterKey) {
    currentFilterOptions[filterKey] = options;
  }

  const candidate = normalizeSelectedFilterValues(options, selectedValue);
  
  // datalist 已移除，使用自定义下拉列表。
  
  if (filter.inputEl) {
    const selectedText = summarizeSelectedFilterText(options, candidate);
    
    // Always update the input value and dataset value to ensure consistency
    // But we need to be careful not to disrupt user interaction if this is called during typing.
    // In our case, this is called on data load and filter change (which happens on 'change' event).
    // So it should be safe to update.
    
    const currentValues = JSON.stringify(readSelectedFilterValues(filter.inputEl));
    const nextValues = JSON.stringify(candidate);
    if (currentValues !== nextValues || filter.inputEl.value !== selectedText) {
         filter.inputEl.value = selectedText;
         writeSelectedFilterValues(filter.inputEl, candidate);
    }

    const controller = ensureFilterDropdown(filter.inputEl, filterKey);
    if (controller) {
      controller.syncCommittedText(selectedText);
      if (controller.isOpen()) {
        controller.render("");
      }
    }
  }
  return candidate;
}

function bindSearchableFilterInput(inputEl, filterKey) {
  if (!inputEl) {
    return;
  }
  ensureFilterDropdown(inputEl, filterKey);
}



function metricOrgLabel(org) {
  const key = String(org || "").trim();
  return MODEL_ORG_LABELS[key] || key || "--";
}

function getProviderSlugFromEndpointTag(tag) {
  const raw = String(tag || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  const slashIndex = raw.indexOf("/");
  return (slashIndex >= 0 ? raw.slice(0, slashIndex) : raw).trim();
}

function getMetricProviderDisplayName(providerName, providerSlug) {
  const name = String(providerName || "").trim();
  if (name) {
    return name;
  }
  const slug = String(providerSlug || "").trim().toLowerCase();
  return slug || "--";
}

function buildMetricsRows(data, filters) {
  const models = Array.isArray(data?.models) ? data.models : [];
  const rows = [];
  for (const model of models) {
    const org = String(model?.organization || "").trim();
    if (!matchesFilterValue(org, filters.org)) {
      continue;
    }
    const modelId = String(model?.id || "").trim();
    if (!matchesFilterValue(modelId, filters.model)) {
      continue;
    }
    const endpoints = Array.isArray(model?.endpoints) ? model.endpoints : [];
    for (const endpoint of endpoints) {
      const providerName = String(endpoint?.providerName || "").trim();
      const providerSlug = String(endpoint?.providerSlug || "").trim().toLowerCase()
        || getProviderSlugFromEndpointTag(endpoint?.tag);
      const providerDisplayName = getMetricProviderDisplayName(providerName, providerSlug);
      if (!matchesFilterValue(providerDisplayName, filters.provider)) {
        continue;
      }
      rows.push({
        organization: org,
        organizationLabel: metricOrgLabel(org),
        modelId,
        modelName: String(model?.name || modelId || "未命名模型"),
        providerName: providerDisplayName,
        providerSlug,
        uptime: Number.isFinite(Number(endpoint?.uptime_last_30m)) ? Number(endpoint.uptime_last_30m) : 0,
        latencyP50: readLatencySeconds(endpoint?.latency_last_30m, "p50"),
        latencyP90: readLatencySeconds(endpoint?.latency_last_30m, "p90"),
        latencyP99: readLatencySeconds(endpoint?.latency_last_30m, "p99"),
        throughputP50: readMetricValue(endpoint?.throughput_last_30m, "p50"),
        throughputP90: readMetricValue(endpoint?.throughput_last_30m, "p90"),
        throughputP99: readMetricValue(endpoint?.throughput_last_30m, "p99"),
      });
    }
  }

  const { sortKey, sortOrder } = metricsState;
  const direction = sortOrder === "asc" ? 1 : -1;

  const NUMERIC_SORT_KEYS = new Set([
    "latencyP50",
    "latencyP90",
    "latencyP99",
    "throughputP50",
    "throughputP90",
    "throughputP99",
    "uptime",
  ]);

  const toSortableNumber = (value) => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    const text = String(value || "").trim();
    if (!text || text === "--") {
      return null;
    }
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return rows.sort((left, right) => {
    let a = left[sortKey];
    let b = right[sortKey];

    if (sortKey === "organization") {
      a = left.organizationLabel;
      b = right.organizationLabel;
    }

    if (NUMERIC_SORT_KEYS.has(sortKey)) {
      const an = toSortableNumber(a);
      const bn = toSortableNumber(b);
      if (an === null && bn === null) {
        return 0;
      }
      // Always push missing values ("--") to the bottom.
      if (an === null) {
        return 1;
      }
      if (bn === null) {
        return -1;
      }
      return (an - bn) * direction;
    }

    // String sorting with numeric-aware compare (e.g. v2 < v10).
    return String(a || "").localeCompare(String(b || ""), "zh-CN", { numeric: true, sensitivity: "base" }) * direction;
  });
}

function navigateToProviderCard(tab, cardId) {
  selectTab(tab);
  requestAnimationFrame(() => {
    const cardEl = document.getElementById(cardId);
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
      cardEl.classList.add("highlight-card");
      setTimeout(() => cardEl.classList.remove("highlight-card"), 1800);
    }
  });
}

function renderMetricsTableRows(rows) {
  metricsTableContainerEl.replaceChildren();
  if (rows.length === 0) {
    metricsTableContainerEl.append(createElement("article", "empty", "当前筛选条件下没有可展示的数据。"));
    return;
  }

  const tableWrap = createElement("div", "metric-table-wrap");
  const table = createElement("table", "metric-table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const headers = [
    { key: "organization", text: "厂商" },
    { key: "modelName", text: "模型" },
    { key: "providerName", text: "Provider" },
    { key: "latencyP50", text: "延迟 p50(s)" },
    { key: "latencyP90", text: "延迟 p90(s)" },
    { key: "latencyP99", text: "延迟 p99(s)" },
    { key: "throughputP50", text: "吞吐 p50(tok/s)" },
    { key: "throughputP90", text: "吞吐 p90(tok/s)" },
    { key: "throughputP99", text: "吞吐 p99(tok/s)" },
    { key: "uptime", text: "可用率(30m)" },
  ];

  for (const { key, text } of headers) {
    const th = createElement("th", "sortable-header", text);
    if (metricsState.sortKey === key) {
      th.classList.add("active-sort");
      th.textContent += metricsState.sortOrder === "asc" ? " ↑" : " ↓";
    }
    th.addEventListener("click", () => {
      if (metricsState.sortKey === key) {
        metricsState.sortOrder = metricsState.sortOrder === "asc" ? "desc" : "asc";
      } else {
        metricsState.sortKey = key;
        metricsState.sortOrder = "asc";
      }
      renderMetricsFromState();
    });
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const item of rows) {
    const row = document.createElement("tr");
    row.append(createElement("td", "metric-value", item.organizationLabel));
    row.append(createElement("td", "metric-model-cell", `${item.modelName} (${item.modelId})`));

    const providerCell = createElement("td", "metric-provider");
    providerCell.textContent = item.providerName;

    const planLink = findProviderPlanLink(item.providerName, item.providerSlug);
    if (planLink) {
      const metaRow = createElement("div", "metric-provider-meta");
      const badge = createElement("span", `region-badge ${planLink.tab}`, planLink.regionLabel);
      metaRow.append(badge);

      const linkBtn = createElement("button", "plan-jump-btn", "查看套餐");
      linkBtn.type = "button";
      linkBtn.addEventListener("click", () => navigateToProviderCard(planLink.tab, planLink.cardId));
      metaRow.append(linkBtn);
      
      providerCell.append(metaRow);
    }
    row.append(providerCell);

    row.append(createElement("td", "metric-value", item.latencyP50));
    row.append(createElement("td", "metric-value", item.latencyP90));
    row.append(createElement("td", "metric-value", item.latencyP99));
    row.append(createElement("td", "metric-value", item.throughputP50));
    row.append(createElement("td", "metric-value", item.throughputP90));
    row.append(createElement("td", "metric-value", item.throughputP99));
    row.append(
      createElement(
        "td",
        "metric-value",
        Number.isFinite(Number(item.uptime)) ? `${formatMetricNumber(item.uptime)}%` : "--",
      ),
    );
    tbody.append(row);
  }

  table.append(thead, tbody);
  tableWrap.append(table);
  metricsTableContainerEl.append(tableWrap);
}

function updateMetricFilterOptions(data) {
  const allModels = Array.isArray(data?.models) ? data.models : [];
  const orgOptions = [
    { value: FILTER_ALL_VALUE, text: "全部厂商" },
    ...[...new Set(allModels.map((item) => String(item?.organization || "").trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
      .map((org) => ({ value: org, text: metricOrgLabel(org) })),
  ];
  metricsState.org = setSearchableFilterOptions(
    {
      inputEl: metricsOrgFilterInputEl,
      datalistEl: metricsOrgFilterDatalistEl,
    },
    orgOptions,
    metricsState.org,
    "org"
  );

  const modelsForOrg = allModels.filter((item) => matchesFilterValue(item.organization, metricsState.org));

  const modelOptionsMap = new Map();
  for (const item of modelsForOrg) {
    const value = String(item?.id || "").trim();
    if (value && !modelOptionsMap.has(value)) {
      modelOptionsMap.set(value, {
        value,
        text: String(item?.name || item?.id || "").trim(),
      });
    }
  }

  const modelOptions = [
    { value: FILTER_ALL_VALUE, text: "全部模型" },
    ...Array.from(modelOptionsMap.values()).sort((left, right) => left.text.localeCompare(right.text)),
  ];
  metricsState.model = setSearchableFilterOptions(
    {
      inputEl: metricsModelFilterInputEl,
      datalistEl: metricsModelFilterDatalistEl,
    },
    modelOptions,
    metricsState.model,
    "model"
  );

  const modelsForProvider = allModels.filter((item) => {
    if (!matchesFilterValue(item.organization, metricsState.org)) {
      return false;
    }
    if (!matchesFilterValue(item.id, metricsState.model)) {
      return false;
    }
    return true;
  });
  const providerOptions = [
    { value: FILTER_ALL_VALUE, text: "全部供应商" },
    ...[
      ...new Set(
        modelsForProvider.flatMap((model) =>
          (Array.isArray(model?.endpoints) ? model.endpoints : [])
            .map((endpoint) => {
              const providerName = String(endpoint?.providerName || "").trim();
              const providerSlug = String(endpoint?.providerSlug || "").trim().toLowerCase()
                || getProviderSlugFromEndpointTag(endpoint?.tag);
              return getMetricProviderDisplayName(providerName, providerSlug);
            })
            .filter(Boolean),
        ),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map((provider) => ({ value: provider, text: provider })),
  ];
  metricsState.provider = setSearchableFilterOptions(
    {
      inputEl: metricsProviderFilterInputEl,
      datalistEl: metricsProviderFilterDatalistEl,
    },
    providerOptions,
    metricsState.provider,
    "provider"
  );
}

function renderMetricsFromState() {
  if (!metricsState.rawData) {
    metricsTableContainerEl.replaceChildren();
    metricsTableContainerEl.append(createElement("article", "empty", "暂无模型 Provider 性能数据。"));
    setStats("模型数", 0, "Provider 数", 0, "--");
    return;
  }

  const rows = buildMetricsRows(metricsState.rawData, metricsState);
  renderMetricsTableRows(rows);
  const modelIds = new Set(rows.map((row) => row.modelId));
  const providerNames = new Set(rows.map((row) => row.providerName));
  setStats(
    "模型数",
    modelIds.size,
    "Provider 数",
    providerNames.size,
    formatDateInBeijing(metricsState.rawData.generatedAt),
  );
}

function handleMetricsFilterChange() {
  if (!metricsState.rawData) {
    return;
  }
  metricsState.org = readSelectedFilterValues(metricsOrgFilterInputEl);
  metricsState.model = readSelectedFilterValues(metricsModelFilterInputEl);
  metricsState.provider = readSelectedFilterValues(metricsProviderFilterInputEl);
  updateMetricFilterOptions(metricsState.rawData);
  renderMetricsFromState();
}

bindSearchableFilterInput(metricsOrgFilterInputEl, "org");
bindSearchableFilterInput(metricsModelFilterInputEl, "model");
bindSearchableFilterInput(metricsProviderFilterInputEl, "provider");

function renderMetricsFailures(data) {
  const failures = Array.isArray(data?.failures) ? data.failures : [];
  if (!metricsFailuresEl || !metricsFailuresCountEl || !metricsFailuresListEl) {
    return;
  }

  metricsFailuresCountEl.textContent = String(failures.length);
  metricsFailuresListEl.replaceChildren();

  if (failures.length === 0) {
    metricsFailuresEl.classList.add("hidden");
    metricsFailuresEl.removeAttribute("open");
    return;
  }

  for (const item of failures) {
    metricsFailuresListEl.append(createElement("li", "", String(item)));
  }

  metricsFailuresEl.classList.remove("hidden");
  metricsFailuresEl.removeAttribute("open");
}

function readCaptureWindowText(data) {
  const timezone = String(data?.captureWindow?.timezone || "Asia/Shanghai");
  const target = String(data?.captureWindow?.targetLocalTime || "16:00");
  return `每日 ${target} (${timezone === "Asia/Shanghai" ? "UTC+8" : timezone})`;
}

// ─── Tab Management ──────────────────────────────────────────

function setTabButtonState(button, selected) {
  button.classList.toggle("active", selected);
  button.setAttribute("aria-selected", selected ? "true" : "false");
}

function getMetricsToolbarHint() {
  const days = Number(metricsState.rawData?.config?.modelMaxAgeDays);
  if (Number.isFinite(days) && days > 0) {
    return `仅展示最近 ${days} 天内发布的模型；可按厂商、模型与 provider 多选过滤。`;
  }
  return "模型发布时间不过滤；可按厂商、模型与 provider 多选过滤。";
}

function syncMetricsHintText() {
  if (!metricsToolbarHintInlineEl) {
    return;
  }
  metricsToolbarHintInlineEl.textContent = metricsState.rawData ? getMetricsToolbarHint() : "";
}

function normalizeTabName(tab) {
  return tab === "overseas" || tab === "metrics" ? tab : "domestic";
}

function readTabFromHash() {
  const hashValue = window.location.hash.replace(/^#/, "").trim().toLowerCase();
  return normalizeTabName(hashValue);
}

function syncHashForTab(tab, mode = "push") {
  const nextHash = `#${normalizeTabName(tab)}`;
  if (window.location.hash === nextHash) {
    return;
  }
  if (mode === "replace" && window.history && typeof window.history.replaceState === "function") {
    window.history.replaceState(null, "", nextHash);
    return;
  }
  window.location.hash = nextHash;
}

function loadDataForActiveTab() {
  if (activeTab === "metrics") {
    if (!metricsState.rawData) {
      loadMetricsData();
    }
    if (!appState.dataLoaded) {
      loadAllPlanData();
    }
    return;
  }
  if (!appState.dataLoaded) {
    loadAllPlanData();
  }
}

function applyTabFromHash() {
  switchTab(readTabFromHash());
  loadDataForActiveTab();
}

function selectTab(tab) {
  const nextTab = normalizeTabName(tab);
  const nextHash = `#${nextTab}`;
  if (window.location.hash === nextHash) {
    switchTab(nextTab);
    loadDataForActiveTab();
    return;
  }
  syncHashForTab(nextTab);
}

function switchTab(tab) {
  const nextTab = tab === "overseas" || tab === "metrics" ? tab : "domestic";
  activeTab = nextTab;
  const isDomestic = activeTab === "domestic";
  const isOverseas = activeTab === "overseas";
  const isMetrics = activeTab === "metrics";

  domesticPanelEl.classList.toggle("hidden", !isDomestic);
  overseasPanelEl.classList.toggle("hidden", !isOverseas);
  metricsPanelEl.classList.toggle("hidden", !isMetrics);

  setTabButtonState(domesticTabButtonEl, isDomestic);
  setTabButtonState(overseasTabButtonEl, isOverseas);
  setTabButtonState(metricsTabButtonEl, isMetrics);

  if (isDomestic) {
    if (tabIntroTitleEl) tabIntroTitleEl.textContent = "大陆套餐供应商";
    if (tabIntroDescEl) tabIntroDescEl.textContent = "筛选规则：仅标准月费（不含年费、季费与首月特惠价），仅显示人民币计价套餐。";
    if (appState.dataLoaded) {
      renderDomesticTab();
    }
    return;
  }
  if (isOverseas) {
    if (tabIntroTitleEl) tabIntroTitleEl.textContent = "海外供应商";
    if (tabIntroDescEl) tabIntroDescEl.textContent = "展示海外供应商美元计价套餐；若价格页访问受限或解析失败，会放入 Pending 折叠区。";
    if (appState.dataLoaded) {
      renderOverseasTab();
    }
    return;
  }
  if (tabIntroTitleEl) tabIntroTitleEl.textContent = "Provider 性能指标";
  if (tabIntroDescEl) tabIntroDescEl.textContent = "查看 OpenRouter 模型 provider 的最近 30 分钟可用率、延迟与吞吐，并支持筛选与跳转套餐。";
  syncMetricsHintText();
  if (metricsState.rawData) {
    renderMetricsFromState();
  }
}

// ─── Data Loading ────────────────────────────────────────────

async function loadAllPlanData() {
  setError(domesticErrorBannerEl, "");
  setError(overseasErrorBannerEl, "");
  if (reloadButtonEl) {
    reloadButtonEl.disabled = true;
    reloadButtonEl.textContent = "加载中...";
  }

  let pricingData = { providers: [], failures: [] };
  let openrouterData = { providers: [], pending: [] };

  try {
    const [pricingRes, openrouterRes] = await Promise.allSettled([
      fetch(PRICING_DATA_PATH, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(OPENROUTER_PROVIDER_PLANS_DATA_PATH, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ]);

    if (pricingRes.status === "fulfilled") {
      pricingData = pricingRes.value;
    } else {
      setError(domesticErrorBannerEl, `无法读取 ${PRICING_DATA_PATH}：${pricingRes.reason?.message || "未知错误"}`);
    }

    if (openrouterRes.status === "fulfilled") {
      openrouterData = openrouterRes.value;
    } else {
      setError(overseasErrorBannerEl, `无法读取 ${OPENROUTER_PROVIDER_PLANS_DATA_PATH}：${openrouterRes.reason?.message || "未知错误"}`);
    }

    appState.mergedProviders = mergeAllProviderData(pricingData, openrouterData);
    appState.pricingGeneratedAt = pricingData.generatedAt || null;
    appState.openrouterPlansGeneratedAt = openrouterData.generatedAtBeijing
      || formatDateInBeijing(openrouterData.generatedAt);
    appState.openrouterPendingData = Array.isArray(openrouterData.pending) ? openrouterData.pending : [];
    appState.pricingFailures = Array.isArray(pricingData.failures) ? pricingData.failures : [];
    appState.dataLoaded = true;

    buildProviderPlanLookup(appState.mergedProviders);

    if (activeTab === "domestic") {
      renderDomesticTab();
    } else if (activeTab === "overseas") {
      renderOverseasTab();
    } else if (activeTab === "metrics" && metricsState.rawData) {
      renderMetricsFromState();
    }
  } catch (error) {
    appState.dataLoaded = false;
    domesticGridEl.replaceChildren();
    domesticGridEl.append(createElement("article", "empty", "加载失败，请稍后重试。"));
    overseasGridEl.replaceChildren();
    overseasGridEl.append(createElement("article", "empty", "加载失败，请稍后重试。"));
    setStats("提供商", 0, "套餐数", 0, "--");
  } finally {
    if (reloadButtonEl) {
      reloadButtonEl.disabled = false;
      reloadButtonEl.textContent = "重新加载";
    }
  }
}

async function loadMetricsData() {
  setError(metricsErrorBannerEl, "");
  renderMetricsFailures({ failures: [] });
  reloadButtonEl.disabled = true;
  reloadButtonEl.textContent = "加载中...";
  try {
    const response = await fetch(METRICS_DATA_PATH, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    metricsState.rawData = data;
    metricsGeneratedAtEl.textContent = data.generatedAtBeijing || formatDateInBeijing(data.generatedAt);
    metricsCaptureWindowEl.textContent = readCaptureWindowText(data);
    syncMetricsHintText();
    updateMetricFilterOptions(data);
    renderMetricsFromState();
    renderMetricsFailures(data);
  } catch (error) {
    metricsState.rawData = null;
    metricsTableContainerEl.replaceChildren();
    metricsTableContainerEl.append(createElement("article", "empty", "加载失败，请稍后重试。"));
    renderMetricsFailures({ failures: [] });
    metricsGeneratedAtEl.textContent = "--";
    metricsCaptureWindowEl.textContent = "每日 16:00 (UTC+8)";
    setStats("模型数", 0, "Provider 数", 0, "--");
    setError(metricsErrorBannerEl, `无法读取 ${METRICS_DATA_PATH}：${error.message}`);
    syncMetricsHintText();
  } finally {
    reloadButtonEl.disabled = false;
    reloadButtonEl.textContent = "重新加载";
  }
}

// ─── Event Listeners ─────────────────────────────────────────

domesticTabButtonEl.addEventListener("click", () => {
  selectTab("domestic");
});

overseasTabButtonEl.addEventListener("click", () => {
  selectTab("overseas");
});

metricsTabButtonEl.addEventListener("click", () => {
  selectTab("metrics");
});

// metricsOrgFilterEl.addEventListener("change", handleMetricsFilterChange);
// metricsModelFilterEl.addEventListener("change", handleMetricsFilterChange);
// metricsProviderFilterEl.addEventListener("change", handleMetricsFilterChange);

reloadButtonEl.addEventListener("click", () => {
  if (activeTab === "metrics") {
    loadMetricsData();
    return;
  }
  loadAllPlanData();
});

window.addEventListener("hashchange", () => {
  applyTabFromHash();
});

// ─── Init ────────────────────────────────────────────────────

const initialTab = readTabFromHash();
syncHashForTab(initialTab, "replace");
switchTab(initialTab);
loadDataForActiveTab();
