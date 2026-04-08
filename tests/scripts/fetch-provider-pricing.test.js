"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STALE_PROVIDER_NOTICE,
  extractInfiniRouteChunkUrls,
  extractProviderIdFromFailure,
  parseInfiniPlanFromBundle,
  parseInfiniServiceDetailsByTier,
  parseJdCloudCodingPlansFromPageHtml,
  restoreFailedProvidersFromSnapshot,
} = require("../../scripts/fetch-provider-pricing.js");

test("extractProviderIdFromFailure reads provider id prefix", () => {
  assert.equal(
    extractProviderIdFromFailure("jdcloud-ai: page.goto: Timeout 20000ms exceeded"),
    "jdcloud-ai",
  );
});

test("restoreFailedProvidersFromSnapshot keeps previous plans and marks them stale", () => {
  const currentProviders = [
    {
      provider: "kimi-ai",
      sourceUrls: ["https://kimi.com"],
      plans: [{ name: "K1", currentPriceText: "¥39/月" }],
    },
  ];
  const snapshotProviders = [
    {
      provider: "jdcloud-ai",
      sourceUrls: ["https://www.jdcloud.com/cn/pages/codingplan"],
      plans: [{ name: "Coding Plan Lite", currentPriceText: "¥7.9/月" }],
    },
  ];

  const restored = restoreFailedProvidersFromSnapshot(
    currentProviders,
    ["jdcloud-ai: page.goto: Timeout 20000ms exceeded"],
    snapshotProviders,
  );

  assert.equal(restored.length, 2);
  const fallback = restored.find((provider) => provider.provider === "jdcloud-ai");
  assert.ok(fallback);
  assert.deepEqual(fallback.plans, snapshotProviders[0].plans);
  assert.equal(fallback.staleReason, STALE_PROVIDER_NOTICE);
  assert.match(fallback.staleFailure, /Timeout 20000ms exceeded/);
});

test("restoreFailedProvidersFromSnapshot skips providers without snapshot data", () => {
  const restored = restoreFailedProvidersFromSnapshot([], ["jdcloud-ai: parse failed"], []);
  assert.deepEqual(restored, []);
});

test("parseJdCloudCodingPlansFromPageHtml reads SSR pricing models", () => {
  const html = String.raw`model:{activityId:"v4s0Aw5S7rtC104tC2Dp",title:"Coding  Plan Lite ",nameColor:Z,desc:"每天10:30开抢，每月最多18,000次请求，适合轻度开发者，满足日常基础代码辅助需求",descColor:H,productPrice:"7.9",productPriceColor:H,timeUnit:bb,timeUnitColor:Z,originalPrice:"原价：40元\u002F1个月",buyConditionsOne:"模型",buyConditionsOneDesc:"DeepSeek、GLM、MiniMax 、Qwen3-Coder、Kimi等",buyConditionsTwo:"工具",buyConditionsTwoDesc:"Claude Code、OpenCode、OpenClaw、Roo Code、Cursor"} model:{activityId:"f7v8GeJu99bqYi3OULpY",title:"Coding  Plan Pro ",nameColor:Z,desc:"每天10:30开抢，每月最多90,000次请求，适合重度开发者，享更高的调用额度与极速体验",descColor:H,productPrice:"39.9",productPriceColor:H,timeUnit:bb,timeUnitColor:Z,originalPrice:"原价：200元\u002F1个月",buyConditionsOne:"权益",buyConditionsOneDesc:"享受 Lite 套餐的全部能力与权益",buyConditionsTwo:"月用量",buyConditionsTwoDesc:" Lite 版的 5 倍用量"}`;

  const plans = parseJdCloudCodingPlansFromPageHtml(html);

  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      originalPriceText: plan.originalPriceText,
      serviceDetails: plan.serviceDetails,
    })),
    [
      {
        name: "Coding Plan Lite",
        currentPriceText: "¥7.9/月",
        originalPriceText: "¥40/月",
        serviceDetails: [
          "每天10:30开抢，每月最多18,000次请求，适合轻度开发者，满足日常基础代码辅助需求",
          "模型：DeepSeek、GLM、MiniMax 、Qwen3-Coder、Kimi等",
          "工具：Claude Code、OpenCode、OpenClaw、Roo Code、Cursor",
        ],
      },
      {
        name: "Coding Plan Pro",
        currentPriceText: "¥39.9/月",
        originalPriceText: "¥200/月",
        serviceDetails: [
          "每天10:30开抢，每月最多90,000次请求，适合重度开发者，享更高的调用额度与极速体验",
          "权益：享受 Lite 套餐的全部能力与权益",
          "月用量：Lite 版的 5 倍用量",
        ],
      },
    ],
  );
});

test("extractInfiniRouteChunkUrls narrows candidates to platform/ai route chunks", () => {
  const mainScriptText = String.raw`path:"platform/ai",name:"platformAi",component:()=>mt((()=>import("./Index.64f0ba2f.js")),["assets/js/Index.64f0ba2f.js","assets/js/Index.060fd627.js","assets/js/index.fef4e24a.js","assets/js/agent.08363d33.js"])`;

  const urls = extractInfiniRouteChunkUrls(
    mainScriptText,
    "https://content.cloud.infini-ai.com/platform-web-prod/assets/js/main.294f0a65.js",
  );

  assert.deepEqual(urls, [
    "https://content.cloud.infini-ai.com/platform-web-prod/assets/js/Index.64f0ba2f.js",
    "https://content.cloud.infini-ai.com/platform-web-prod/assets/js/Index.060fd627.js",
    "https://content.cloud.infini-ai.com/platform-web-prod/assets/js/index.fef4e24a.js",
    "https://content.cloud.infini-ai.com/platform-web-prod/assets/js/agent.08363d33.js",
  ]);
});

test("Infini bundle parsers handle current request-limit wording", () => {
  const bundleText = String.raw`Q("div",{class:"package-name"},"Infini Coding Lite"),Q("div",{class:"price"},[Q("span",{class:"currency"},"¥"),Q("span",{class:"amount"},"40"),Q("span",{class:"unit"},"/月")]),Q("div",{class:"features"},[Q("div",{class:"feature-title"},"1000次请求每5小时"),Q("div",{class:"feature-item"},[Q("span",null,"支持Minimax、GLM、DeepSeek、Kimi等最新模型，Day0上新")]),Q("div",{class:"feature-item"},[Q("span",null,"适配Claude Code、Cline等主流编程工具，持续更新...")])]) Q("div",{class:"package-name"},"Infini Coding Pro"),Q("div",{class:"price"},[Q("span",{class:"currency"},"¥"),Q("span",{class:"amount"},"200"),Q("span",{class:"unit"},"/月")]),Q("div",{class:"features"},[Q("div",{class:"feature-title"},"5000次请求每5小时"),Q("div",{class:"feature-item highlight"},[Q("span",null,"5倍Lite套餐用量")]),Q("div",{class:"feature-item"},[Q("span",null,"支持Minimax、GLM、DeepSeek、Kimi等最新模型，Day0上新")]),Q("div",{class:"feature-item"},[Q("span",null,"适配Claude Code、Cline等主流编程工具，持续更新...")])])`;

  const litePlan = parseInfiniPlanFromBundle(bundleText, "Lite");
  const proPlan = parseInfiniPlanFromBundle(bundleText, "Pro");
  const detailsByTier = parseInfiniServiceDetailsByTier(bundleText);

  assert.equal(litePlan.currentPriceText, "¥40/月");
  assert.equal(proPlan.currentPriceText, "¥200/月");
  assert.deepEqual(detailsByTier.get("Lite"), [
    "1000次请求每5小时",
    "支持Minimax、GLM、DeepSeek、Kimi等最新模型，Day0上新",
    "适配Claude Code、Cline等主流编程工具，持续更新...",
  ]);
  assert.deepEqual(detailsByTier.get("Pro"), [
    "5000次请求每5小时",
    "5倍Lite套餐用量",
    "支持Minimax、GLM、DeepSeek、Kimi等最新模型，Day0上新",
    "适配Claude Code、Cline等主流编程工具，持续更新...",
  ]);
});
