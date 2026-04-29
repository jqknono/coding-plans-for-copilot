"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STALE_PROVIDER_NOTICE,
  buildKimiCodePlansFromGoodsPayload,
  extractInfiniRouteChunkUrls,
  extractProviderIdFromFailure,
  parseInfiniPlanFromBundle,
  parseInfiniServiceDetailsByTier,
  parseAliyunTokenPlansFromDocsHtml,
  parseCompshareCodingPlansFromHtml,
  parseKimiDomesticMembershipPlansFromText,
  parseJdCloudCodingPlansFromDocsText,
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

test("parseJdCloudCodingPlansFromDocsText reads PackageOverview usage details", () => {
  const pageText = `
    Coding Plan 是一款为开发者量身定制的 AI 编程订阅服务。
    模型自由切换：一次订阅即可在多种主流 Code 模型间按需切换，包括：DeepSeek-V3.2、GLM-5、GLM-4.7、MiniMax-M2.5、Kimi-K2.5、Kimi-K2-Turbo、Qwen3-Coder。
    兼容主流工具：完美适配多种开发场景，支持 Claude Code、OpenCode、OpenClaw、Roo Code、Cursor等主流 AI 编码工具，多工具之间套餐额度共享。
    套餐详情
    套餐用量说明：
    套餐 适用人群 用量限制
    Lite套餐 中等强度的开发者，适合大多数开发者。
    每5小时：最多约 1,200 次请求。
    每周：最多约 9,000 次请求。
    每订阅月：最多约 18,000 次请求。
    Pro套餐 复杂项目开发，适合高强度工作的开发者。 Lite套餐的5倍用量。
    每5小时：最多约 6,000 次请求。
    每周：最多约 45,000 次请求。
    每订阅月：最多约 90,000 次请求。
  `;

  const plans = parseJdCloudCodingPlansFromDocsText(pageText);

  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      unit: plan.unit,
      notes: plan.notes,
      serviceDetails: plan.serviceDetails,
    })),
    [
      {
        name: "Coding Plan Lite",
        currentPriceText: null,
        unit: "月",
        notes: "价格未在套餐概览页公开；计价币种: 人民币（CNY）",
        serviceDetails: [
          "适用人群：中等强度的开发者，适合大多数开发者。",
          "用量限制：每5小时：最多约 1,200 次请求。 每周：最多约 9,000 次请求。 每订阅月：最多约 18,000 次请求。",
          "支持模型：DeepSeek-V3.2、GLM-5、GLM-4.7、MiniMax-M2.5、Kimi-K2.5、Kimi-K2-Turbo、Qwen3-Coder",
          "适配工具：完美适配多种开发场景，支持 Claude Code、OpenCode、OpenClaw、Roo Code、Cursor等主流 AI 编码工具，多工具之间套餐额度共享",
        ],
      },
      {
        name: "Coding Plan Pro",
        currentPriceText: null,
        unit: "月",
        notes: "价格未在套餐概览页公开；计价币种: 人民币（CNY）",
        serviceDetails: [
          "适用人群：复杂项目开发，适合高强度工作的开发者。",
          "用量限制：Lite套餐的5倍用量。 每5小时：最多约 6,000 次请求。 每周：最多约 45,000 次请求。 每订阅月：最多约 90,000 次请求。",
          "支持模型：DeepSeek-V3.2、GLM-5、GLM-4.7、MiniMax-M2.5、Kimi-K2.5、Kimi-K2-Turbo、Qwen3-Coder",
          "适配工具：完美适配多种开发场景，支持 Claude Code、OpenCode、OpenClaw、Roo Code、Cursor等主流 AI 编码工具，多工具之间套餐额度共享",
        ],
      },
    ],
  );
});

test("parseCompshareCodingPlansFromHtml reads comparison columns as plans", () => {
  const html = `
    <table>
      <tr><th></th><th>Lite 基础版</th><th>Pro 高级版</th></tr>
      <tr><td>月费</td><td>¥49/月</td><td>¥199/月</td></tr>
      <tr><td>调用次数 / 5小时</td><td>约 600 次</td><td>约 3,000 次</td></tr>
      <tr><td>调用次数 / 每月</td><td>约 9,000 次</td><td>约 45,000 次</td></tr>
      <tr><td>OpenClaw Agent</td><td>✗</td><td>✓</td></tr>
      <tr><td>适合人群</td><td>轻度使用，每日编程 1-2 小时</td><td>重度使用，全职 AI 辅助开发</td></tr>
    </table>
  `;

  const plans = parseCompshareCodingPlansFromHtml(html);

  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      currentPrice: plan.currentPrice,
      serviceDetails: plan.serviceDetails,
    })),
    [
      {
        name: "Lite 基础版",
        currentPriceText: "¥49/月",
        currentPrice: 49,
        serviceDetails: [
          "调用次数 / 5小时: 约 600 次",
          "调用次数 / 每月: 约 9,000 次",
          "OpenClaw Agent: ✗",
          "适合人群: 轻度使用，每日编程 1-2 小时",
        ],
      },
      {
        name: "Pro 高级版",
        currentPriceText: "¥199/月",
        currentPrice: 199,
        serviceDetails: [
          "调用次数 / 5小时: 约 3,000 次",
          "调用次数 / 每月: 约 45,000 次",
          "OpenClaw Agent: ✓",
          "适合人群: 重度使用，全职 AI 辅助开发",
        ],
      },
    ],
  );
});

test("Kimi parsers keep mainland RMB plans and overseas USD plans separate", () => {
  const domesticText = `
    订阅方式与价格
    套餐	定位	连续包月	连续包年
    Adagio	免费体验	¥0/月	—
    Andante	日常使用	¥49/月	年付更优惠
    Moderato	效率升级	¥99/月	年付更优惠
    Allegretto	专业优选	¥199/月	年付更优惠
    Allegro	全能尊享	¥699/月	年付更优惠

    各套餐权益详情
    Adagio — 免费
    Agent 用量约 6 个
    Andante — ¥49/月
    Agent 用量约 30 个
    Kimi Code 1 倍额度
    Moderato — ¥99/月
    在 Andante 基础上：
    Agent 用量约 60 个
    Kimi Code 4 倍额度
    Allegretto — ¥199/月
    在 Moderato 基础上：
    Agent 用量约 150 个
    Kimi Code 20 倍额度
    Allegro — ¥699/月
    在 Allegretto 基础上：
    Agent 用量约 360 个
    Kimi Code 60 倍额度
    以上 Agent 用量数值基于常见任务 token 消耗估算。
  `;
  const overseasPayload = {
    goods: [
      {
        title: "Moderato",
        useRegion: "REGION_OVERSEA",
        membershipLevel: "LEVEL_BASIC",
        amounts: [{ currency: "USD", priceInCents: "1900" }],
        billingCycle: { timeUnit: "TIME_UNIT_MONTH" },
      },
      {
        title: "Moderato",
        useRegion: "REGION_OVERSEA",
        membershipLevel: "LEVEL_BASIC",
        amounts: [{ currency: "USD", priceInCents: "18000" }],
        billingCycle: { timeUnit: "TIME_UNIT_YEAR" },
      },
    ],
  };

  const domesticPlans = parseKimiDomesticMembershipPlansFromText(domesticText);
  const overseasPlans = buildKimiCodePlansFromGoodsPayload(overseasPayload);

  assert.equal(domesticPlans.length, 5);
  assert.deepEqual(
    domesticPlans.map((plan) => plan.currentPriceText),
    ["¥0/月", "¥49/月", "¥99/月", "¥199/月", "¥699/月"],
  );
  assert.match(domesticPlans[1].serviceDetails.join("\n"), /计价币种: 人民币（CNY）/);
  assert.match(domesticPlans[1].serviceDetails.join("\n"), /Kimi Code 1 倍额度/);

  assert.equal(overseasPlans.length, 1);
  assert.equal(overseasPlans[0].name, "Moderato（海外）");
  assert.equal(overseasPlans[0].currentPriceText, "$19/月");
  assert.match(overseasPlans[0].serviceDetails.join("\n"), /计价币种: 美元（USD）/);
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

test("parseAliyunTokenPlansFromDocsHtml reads team seat and shared credit package pricing", () => {
  const html = `
    <table>
      <tr><th>模态</th><th>模型</th></tr>
      <tr><td>文本生成</td><td>qwen3.6-plus、glm-5、MiniMax-M2.5、deepseek-v3.2</td></tr>
      <tr><td>图像生成</td><td>qwen-image-2.0、wan2.7-image-pro</td></tr>
    </table>
    <table>
      <tr><th>坐席类型</th><th>价格</th><th>额度</th><th>适用场景</th></tr>
      <tr><td>标准坐席</td><td>¥198/坐席/月</td><td>25,000 Credits/坐席/月</td><td>轻度使用 AI 辅助的团队成员</td></tr>
      <tr><td>高级坐席</td><td>¥698/坐席/月</td><td>100,000 Credits/坐席/月</td><td>日常高频使用 AI 编码的团队成员</td></tr>
      <tr><td>尊享坐席</td><td>¥1,398/坐席/月</td><td>250,000 Credits/坐席/月</td><td>重度依赖 AI 编码的核心开发者</td></tr>
    </table>
    <p>跨坐席共享的弹性用量包，当个别坐席用量超出套餐额度时，可从共享用量包中抵扣。每个共享用量包有效期为 1 个月，到期未使用的额度自动清零。持有多个共享用量包时，优先抵扣最近到期的用量包。</p>
    <table>
      <tr><th>档位</th><th>价格</th><th>额度</th></tr>
      <tr><td>Token Plan 团队版 - 共享用量包</td><td>¥5,000/个</td><td>625,000 Credits/个</td></tr>
    </table>
  `;

  const result = parseAliyunTokenPlansFromDocsHtml(html);

  assert.equal(result.provider, "aliyun-token-plan");
  assert.deepEqual(
    result.plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      currentPrice: plan.currentPrice,
      unit: plan.unit,
    })),
    [
      {
        name: "Token Plan 标准坐席",
        currentPriceText: "¥198/坐席/月",
        currentPrice: 198,
        unit: "坐席/月",
      },
      {
        name: "Token Plan 高级坐席",
        currentPriceText: "¥698/坐席/月",
        currentPrice: 698,
        unit: "坐席/月",
      },
      {
        name: "Token Plan 尊享坐席",
        currentPriceText: "¥1,398/坐席/月",
        currentPrice: 1398,
        unit: "坐席/月",
      },
      {
        name: "Token Plan 共享用量包",
        currentPriceText: "¥5,000/个",
        currentPrice: 5000,
        unit: "月",
      },
    ],
  );
  assert.match(result.plans[0].serviceDetails.join("\n"), /25,000 Credits\/坐席\/月/);
  assert.match(result.plans[0].serviceDetails.join("\n"), /qwen3\.6-plus/);
  assert.match(result.plans[3].serviceDetails.join("\n"), /625,000 Credits\/个/);
});
