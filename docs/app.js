const DATA_PATH = "./provider-pricing.json";

const PROVIDER_LABELS = {
  "zhipu-ai": "智谱 z.ai",
  "kimi-ai": "Kimi",
  "volcengine-ai": "火山引擎",
  "minimax-ai": "MiniMax",
  "aliyun-ai": "阿里云通义千问",
  "baidu-qianfan-ai": "百度智能云千帆",
  "kwaikat-ai": "快手 KwaiKAT",
  "x-aio": "X-AIO",
  "compshare-ai": "优云智算",
  "infini-ai": "无问芯穹",
};

const PROVIDER_BUY_URLS = {
  "zhipu-ai": "https://bigmodel.cn/glm-coding",
  "kimi-ai": "https://www.kimi.com/code/zh",
  "volcengine-ai": "https://www.volcengine.com/activity/codingplan",
  "minimax-ai": "https://platform.minimaxi.com/subscribe/coding-plan",
  "aliyun-ai": "https://common-buy.aliyun.com/?commodityCode=sfm_codingplan_public_cn#/buy",
  "baidu-qianfan-ai": "https://cloud.baidu.com/product/codingplan.html",
  "kwaikat-ai": "https://www.streamlake.com/marketing/coding-plan",
  "x-aio": "https://code.x-aio.com/",
  "compshare-ai": "https://www.compshare.cn/docs/modelverse/package_plan/package",
  "infini-ai": "https://cloud.infini-ai.com/platform/ai",
};

const reloadButtonEl = document.querySelector("#reloadButton");
const providerGridEl = document.querySelector("#providerGrid");
const errorBannerEl = document.querySelector("#errorBanner");
const generatedAtEl = document.querySelector("#generatedAt");
const providerCountEl = document.querySelector("#providerCount");
const planCountEl = document.querySelector("#planCount");

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

function setError(message) {
  if (!message) {
    errorBannerEl.classList.add("hidden");
    errorBannerEl.textContent = "";
    return;
  }
  errorBannerEl.classList.remove("hidden");
  errorBannerEl.textContent = message;
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
  const normalized = [...new Set(rawList.map((item) => String(item || "").trim()).filter(Boolean))];
  return normalized;
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
  const hasMonthlyUnit = /\/\s*月|每月|月/.test(rawText);
  return `${symbol}${amount}${hasMonthlyUnit ? "/月" : "/月"}`;
}

function getPlanOffer(provider, plan) {
  const fallbackSymbol = getPlanCurrencySymbol(plan);

  if (plan && plan.offerName) {
    const explicitPriceText = formatOfferPriceText(plan.offerPriceText || plan.offerPrice || "", fallbackSymbol);
    if (explicitPriceText) {
      return {
        title: String(plan.offerName),
        priceText: explicitPriceText,
      };
    }
  }

  if (plan && plan.firstMonthPriceText) {
    const firstMonthPriceText = formatOfferPriceText(plan.firstMonthPriceText, fallbackSymbol);
    if (firstMonthPriceText) {
      return {
        title: "首月特惠",
        priceText: firstMonthPriceText,
      };
    }
  }
  if (plan && Number.isFinite(plan.firstMonthPrice)) {
    return {
      title: "首月特惠",
      priceText: `${fallbackSymbol}${plan.firstMonthPrice}/月`,
    };
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
    return {
      title: String(matched[1]).replace(/\s+/g, ""),
      priceText,
    };
  }

  const labelOnlyMatch = notesText.match(/(新人专享|新客专享|新用户专享|新客首月|新人首月)/i);
  if (labelOnlyMatch && plan?.currentPriceText && plan?.originalPriceText) {
    const currentAsOffer = formatOfferPriceText(plan.currentPriceText, fallbackSymbol);
    if (currentAsOffer) {
      return {
        title: String(labelOnlyMatch[1]).replace(/\s+/g, ""),
        priceText: currentAsOffer,
      };
    }
  }

  return null;
}

function getProviderPurchaseUrl(provider) {
  if (provider && Array.isArray(provider.plans)) {
    const planWithBuyUrl = provider.plans.find((plan) => plan && plan.buyUrl);
    if (planWithBuyUrl && planWithBuyUrl.buyUrl) {
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

function renderProviders(data) {
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const visibleProviders = providers.filter((provider) => (provider.plans || []).length > 0);

  providerGridEl.replaceChildren();

  if (visibleProviders.length === 0) {
    providerGridEl.append(createElement("article", "empty", "暂无可展示的标准月费数据。"));
    providerCountEl.textContent = "0";
    planCountEl.textContent = "0";
    return;
  }

  let totalPlans = 0;
  for (const provider of visibleProviders) {
    totalPlans += provider.plans.length;

    const card = createElement("article", "provider-card");
    const head = createElement("header", "provider-head");
    const title = createElement("h2", "provider-title", PROVIDER_LABELS[provider.provider] || provider.provider);
    head.append(title);

    const providerBuyUrl = getProviderPurchaseUrl(provider);
    if (providerBuyUrl) {
      const buyLink = createElement("a", "buy-link", "前往了解");
      buyLink.href = providerBuyUrl;
      buyLink.target = "_blank";
      buyLink.rel = "noopener noreferrer";
      head.append(buyLink);
    }

    const planList = createElement("ul", "plan-list");
    for (const plan of provider.plans) {
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

      if (plan.unit) {
        priceRow.append(createElement("span", "unit-tag", normalizeUnit(plan.unit)));
      }

      item.append(name, priceRow);

      const offerInfo = getPlanOffer(provider, plan);
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

      if (plan.notes) {
        item.append(createElement("p", "plan-notes", plan.notes));
      }

      planList.append(item);
    }

    card.append(head, planList);

    providerGridEl.append(card);
  }

  providerCountEl.textContent = String(visibleProviders.length);
  planCountEl.textContent = String(totalPlans);
}

function renderFailures(data) {
  const failures = Array.isArray(data.failures) ? data.failures : [];
  if (failures.length === 0) {
    setError("");
    return;
  }
  setError(`抓取存在 ${failures.length} 个失败项：${failures.join("；")}`);
}

async function loadData() {
  setError("");
  reloadButtonEl.disabled = true;
  reloadButtonEl.textContent = "加载中...";
  try {
    const response = await fetch(DATA_PATH, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    generatedAtEl.textContent = formatDate(data.generatedAt);
    renderProviders(data);
    renderFailures(data);
  } catch (error) {
    providerGridEl.replaceChildren();
    providerGridEl.append(createElement("article", "empty", "加载失败，请稍后重试。"));
    generatedAtEl.textContent = "--";
    providerCountEl.textContent = "0";
    planCountEl.textContent = "0";
    setError(`无法读取 ${DATA_PATH}：${error.message}`);
  } finally {
    reloadButtonEl.disabled = false;
    reloadButtonEl.textContent = "重新加载";
  }
}

reloadButtonEl.addEventListener("click", () => {
  loadData();
});

loadData();
