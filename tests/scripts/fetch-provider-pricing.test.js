'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STALE_PROVIDER_NOTICE,
  buildKimiCodePlansFromGoodsPayload,
  extractProviderIdFromFailure,
  parseChutesPlansFromText,
  parseAliyunServiceDetailsFromDocsHtml,
  parseAliyunTokenPlansFromDocsHtml,
  parseHuaweiTokenPlans,
  parseCompshareCodingPlansFromHtml,
  parseKimiDomesticMembershipPlansFromText,
  parseJdCloudCodingPlansFromDocsText,
  parseJdCloudCodingPlansFromPageHtml,
  parseJdCloudCodingPlansFromText,
  parseStepfunPlansFromRenderedText,
  parseXfyunCodingPlansFromHtml,
  parseBaiduCodingPlansFromHtml,
  buildXAioPlansFromBundle,
  isRetryableFetchError,
  navigateTencentCodingPlanPage,
  restoreFailedProvidersFromSnapshot,
} = require('../../scripts/fetch-provider-pricing.js');

test('extractProviderIdFromFailure reads provider id prefix', () => {
  assert.equal(extractProviderIdFromFailure('jdcloud-ai: page.goto: Timeout 20000ms exceeded'), 'jdcloud-ai');
});

test('restoreFailedProvidersFromSnapshot keeps previous plans and marks them stale', () => {
  const currentProviders = [
    {
      provider: 'kimi-ai',
      sourceUrls: ['https://kimi.com'],
      plans: [{ name: 'K1', currentPriceText: '¥39/月' }],
    },
  ];
  const snapshotProviders = [
    {
      provider: 'jdcloud-ai',
      sourceUrls: ['https://www.jdcloud.com/cn/pages/codingplan'],
      plans: [{ name: 'Coding Plan Lite', currentPriceText: '¥7.9/月' }],
    },
  ];

  const restored = restoreFailedProvidersFromSnapshot(
    currentProviders,
    ['jdcloud-ai: page.goto: Timeout 20000ms exceeded'],
    snapshotProviders,
  );

  assert.equal(restored.length, 2);
  const fallback = restored.find((provider) => provider.provider === 'jdcloud-ai');
  assert.ok(fallback);
  assert.deepEqual(fallback.plans, snapshotProviders[0].plans);
  assert.equal(fallback.staleReason, STALE_PROVIDER_NOTICE);
  assert.match(fallback.staleFailure, /Timeout 20000ms exceeded/);
});

test('restoreFailedProvidersFromSnapshot skips providers without snapshot data', () => {
  const restored = restoreFailedProvidersFromSnapshot([], ['jdcloud-ai: parse failed'], []);
  assert.deepEqual(restored, []);
});

test('isRetryableFetchError identifies transient network failures', () => {
  assert.equal(isRetryableFetchError(new Error('fetch failed')), true);
  assert.equal(isRetryableFetchError(new Error('Request timed out after 15000ms: https://example.com')), true);
  assert.equal(isRetryableFetchError(new Error('Request failed: https://example.com -> 502')), true);
  assert.equal(isRetryableFetchError(new Error('Unable to locate Aliyun entry script')), false);
});

test('Tencent Coding Plan fallback navigation avoids domcontentloaded timeout regression', async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push({ url, options });
      if (options.waitUntil === 'domcontentloaded' && options.timeout <= 8_000) {
        throw new Error('page.goto: Timeout 8000ms exceeded');
      }
    },
  };

  await navigateTencentCodingPlanPage(page, 'https://cloud.tencent.com/document/product/1823/130092');

  assert.deepEqual(calls, [
    {
      url: 'https://cloud.tencent.com/document/product/1823/130092',
      options: {
        waitUntil: 'commit',
        timeout: 12_000,
      },
    },
  ]);
});

test('parseJdCloudCodingPlansFromPageHtml reads SSR pricing models', () => {
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
        name: 'Coding Plan Lite',
        currentPriceText: '¥7.9/月',
        originalPriceText: '¥40/月',
        serviceDetails: [
          '每天10:30开抢，每月最多18,000次请求，适合轻度开发者，满足日常基础代码辅助需求',
          '模型：DeepSeek、GLM、MiniMax 、Qwen3-Coder、Kimi等',
          '工具：Claude Code、OpenCode、OpenClaw、Roo Code、Cursor',
        ],
      },
      {
        name: 'Coding Plan Pro',
        currentPriceText: '¥39.9/月',
        originalPriceText: '¥200/月',
        serviceDetails: [
          '每天10:30开抢，每月最多90,000次请求，适合重度开发者，享更高的调用额度与极速体验',
          '权益：享受 Lite 套餐的全部能力与权益',
          '月用量：Lite 版的 5 倍用量',
        ],
      },
    ],
  );
});

test('parseJdCloudCodingPlansFromDocsText reads PackageOverview usage details', () => {
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
        name: 'Coding Plan Lite',
        currentPriceText: null,
        unit: '月',
        notes: '价格未在套餐概览页公开；计价币种: 人民币（CNY）',
        serviceDetails: [
          '适用人群：中等强度的开发者，适合大多数开发者。',
          '用量限制：每5小时：最多约 1,200 次请求。 每周：最多约 9,000 次请求。 每订阅月：最多约 18,000 次请求。',
          '支持模型：DeepSeek-V3.2、GLM-5、GLM-4.7、MiniMax-M2.5、Kimi-K2.5、Kimi-K2-Turbo、Qwen3-Coder',
          '适配工具：完美适配多种开发场景，支持 Claude Code、OpenCode、OpenClaw、Roo Code、Cursor等主流 AI 编码工具，多工具之间套餐额度共享',
        ],
      },
      {
        name: 'Coding Plan Pro',
        currentPriceText: null,
        unit: '月',
        notes: '价格未在套餐概览页公开；计价币种: 人民币（CNY）',
        serviceDetails: [
          '适用人群：复杂项目开发，适合高强度工作的开发者。',
          '用量限制：Lite套餐的5倍用量。 每5小时：最多约 6,000 次请求。 每周：最多约 45,000 次请求。 每订阅月：最多约 90,000 次请求。',
          '支持模型：DeepSeek-V3.2、GLM-5、GLM-4.7、MiniMax-M2.5、Kimi-K2.5、Kimi-K2-Turbo、Qwen3-Coder',
          '适配工具：完美适配多种开发场景，支持 Claude Code、OpenCode、OpenClaw、Roo Code、Cursor等主流 AI 编码工具，多工具之间套餐额度共享',
        ],
      },
    ],
  );
});

test('parseJdCloudCodingPlansFromText reads current rendered activity page pricing', () => {
  const pageText = `
    Coding Plan Lite
    产品首购
    可购1个
    每天10:30开抢，每月最多18,000次请求，适合轻度开发者，满足日常基础代码辅助需求
    19.9
    元
    /
    1个月
    原价：40元/1个月
    模型：DeepSeek、GLM、MiniMax 、Qwen3-Coder、Kimi等
    工具：Claude Code、OpenCode、OpenClaw、Roo Code、Cursor
    立即抢购
    Coding Plan Pro
    产品首购
    可购1个
    每天10:30开抢，每月最多90,000次请求，适合重度开发者，享更高的调用额度与极速体验
    99.9
    元
    /
    1个月
    原价：200元/1个月
    权益：享受 Lite 套餐的全部能力与权益
    月用量： Lite 版的 5 倍用量
    立即抢购
  `;

  const plans = parseJdCloudCodingPlansFromText(pageText);

  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      originalPriceText: plan.originalPriceText,
      serviceDetails: plan.serviceDetails,
    })),
    [
      {
        name: 'Coding Plan Lite',
        currentPriceText: '¥19.9/月',
        originalPriceText: '¥40/月',
        serviceDetails: [
          '每天10:30开抢，每月最多18,000次请求，适合轻度开发者，满足日常基础代码辅助需求',
          '模型：DeepSeek、GLM、MiniMax 、Qwen3-Coder、Kimi等',
          '工具：Claude Code、OpenCode、OpenClaw、Roo Code、Cursor',
        ],
      },
      {
        name: 'Coding Plan Pro',
        currentPriceText: '¥99.9/月',
        originalPriceText: '¥200/月',
        serviceDetails: [
          '每天10:30开抢，每月最多90,000次请求，适合重度开发者，享更高的调用额度与极速体验',
          '权益：享受 Lite 套餐的全部能力与权益',
          '月用量：Lite 版的 5 倍用量',
        ],
      },
    ],
  );
});

test('parseCompshareCodingPlansFromHtml reads comparison columns as plans', () => {
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
        name: 'Lite 基础版',
        currentPriceText: '¥49/月',
        currentPrice: 49,
        serviceDetails: [
          '调用次数 / 5小时: 约 600 次',
          '调用次数 / 每月: 约 9,000 次',
          'OpenClaw Agent: ✗',
          '适合人群: 轻度使用，每日编程 1-2 小时',
        ],
      },
      {
        name: 'Pro 高级版',
        currentPriceText: '¥199/月',
        currentPrice: 199,
        serviceDetails: [
          '调用次数 / 5小时: 约 3,000 次',
          '调用次数 / 每月: 约 45,000 次',
          'OpenClaw Agent: ✓',
          '适合人群: 重度使用，全职 AI 辅助开发',
        ],
      },
    ],
  );
});

test('Kimi parsers keep mainland RMB plans and overseas USD plans separate', () => {
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
        title: 'Moderato',
        useRegion: 'REGION_OVERSEA',
        membershipLevel: 'LEVEL_BASIC',
        amounts: [{ currency: 'USD', priceInCents: '1900' }],
        billingCycle: { timeUnit: 'TIME_UNIT_MONTH' },
      },
      {
        title: 'Moderato',
        useRegion: 'REGION_OVERSEA',
        membershipLevel: 'LEVEL_BASIC',
        amounts: [{ currency: 'USD', priceInCents: '18000' }],
        billingCycle: { timeUnit: 'TIME_UNIT_YEAR' },
      },
    ],
  };

  const domesticPlans = parseKimiDomesticMembershipPlansFromText(domesticText);
  const overseasPlans = buildKimiCodePlansFromGoodsPayload(overseasPayload);

  assert.equal(domesticPlans.length, 5);
  assert.deepEqual(
    domesticPlans.map((plan) => plan.currentPriceText),
    ['¥0/月', '¥49/月', '¥99/月', '¥199/月', '¥699/月'],
  );
  assert.match(domesticPlans[1].serviceDetails.join('\n'), /计价币种: 人民币（CNY）/);
  assert.match(domesticPlans[1].serviceDetails.join('\n'), /Kimi Code 1 倍额度/);

  assert.equal(overseasPlans.length, 1);
  assert.equal(overseasPlans[0].name, 'Moderato（海外）');
  assert.equal(overseasPlans[0].currentPriceText, '$19/月');
  assert.match(overseasPlans[0].serviceDetails.join('\n'), /计价币种: 美元（USD）/);
});

test('parseChutesPlansFromText tolerates home page plans without Base tier', () => {
  const pageText = `
    Pricing
    Choose a plan that fits your needs.
    Plus
    $10
    per month
    5X the value of pay-as-you-go
    6% off PAYG pricing
    PAYG requests beyond limit
    View limits
    Get Started
    Best Value
    Pro
    $20
    per month
    5X the value of pay-as-you-go
    10% off PAYG pricing
    PAYG requests beyond limit
    View limits
    Get Started
    Enterprise
    Contact us
    Custom billing only
  `;

  const plans = parseChutesPlansFromText(pageText);

  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      notes: plan.notes,
      serviceDetails: plan.serviceDetails,
    })),
    [
      {
        name: 'Plus',
        currentPriceText: '$10/月',
        notes: null,
        serviceDetails: ['5X the value of pay-as-you-go', '6% off PAYG pricing', 'PAYG requests beyond limit'],
      },
      {
        name: 'Pro',
        currentPriceText: '$20/月',
        notes: 'Best Value',
        serviceDetails: ['5X the value of pay-as-you-go', '10% off PAYG pricing', 'PAYG requests beyond limit'],
      },
    ],
  );
});

test('parseAliyunServiceDetailsFromDocsHtml marks Lite as discontinued', () => {
  const html = `
    <p>套餐详情</p>
    <p>说明 Lite 套餐自 2026 年 3 月 20 日 00:00:00（UTC+08:00）起停止新购（详见公告）；4 月 13 日 18:00:00（UTC+08:00）起停止续费与升级（详见公告）。Lite 套餐支持所有套餐模型。</p>
    <h3>Lite 版为什么停止新购？</h3>
    <p>因产品升级需要，Coding Plan Lite 基础版本已于 2026 年 3 月 20 日起停止新购，并于 4 月 13 日起停止续费与升级。已购买的用户可继续使用至服务到期。</p>
    <h3>已购买 Lite 版的用户权益是否受影响？</h3>
    <p>已购买 Coding Plan Lite 基础套餐的用户可继续使用至服务到期。</p>
  `;

  const detailsByTier = parseAliyunServiceDetailsFromDocsHtml(html);
  const liteDetails = detailsByTier.get('Lite') || [];

  assert.match(liteDetails.join('\n'), /停止新购/);
  assert.match(liteDetails.join('\n'), /停止续费与升级/);
  assert.match(liteDetails.join('\n'), /继续使用至服务到期/);
});

test('parseXfyunCodingPlansFromHtml reads monthly plans and skips offline/quarterly rows', () => {
  const html = `
    <table>
      <tr><th>套餐类型</th><th>价格</th><th>支持模型</th><th>用量限制</th></tr>
      <tr>
        <td>无忧版 （已下线）</td>
        <td>¥19 / 月</td>
        <td>讯飞星辰 MaaS 平台套餐订阅页面展示为准</td>
        <td>请求次数不限</td>
      </tr>
      <tr>
        <td>专业版</td>
        <td>¥39 / 月</td>
        <td>讯飞星辰 MaaS 平台套餐订阅页面展示为准</td>
        <td>每 5 小时：最多约 1,200 次请求；每周：最多约 9,000 次请求；每订阅月：最多约 18,000 次请求</td>
      </tr>
      <tr>
        <td>高效版</td>
        <td>¥199 / 月</td>
        <td>讯飞星辰 MaaS 平台套餐订阅页面展示为准</td>
        <td>每 5 小时：最多约 6,000 次请求；每周：最多约 45,000 次请求；每订阅月：最多约 90,000 次请求</td>
      </tr>
    </table>
    <p>按季订购</p>
    <table>
      <tr><th>套餐类型</th><th>价格</th><th>支持模型</th><th>用量限制</th></tr>
      <tr><td>专业版</td><td>¥111 / 季（日常折扣95折）</td><td>展示为准</td><td>每订阅月：最多约 18,000 次请求</td></tr>
    </table>
    <p>流控方式调整为 请求次数 维度：</p>
    <table>
      <tr><th>流控维度</th><th>说明</th></tr>
      <tr><td>5 小时流控</td><td>周期为5小时</td></tr>
      <tr><td>周流控</td><td>周期为7日</td></tr>
      <tr><td>月流控</td><td>31天后为套餐失效时间</td></tr>
    </table>
    <p>选择专业版 / 高效版，完成首购或叠加购买</p>
  `;

  const plans = parseXfyunCodingPlansFromHtml(html);

  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      currentPrice: plan.currentPrice,
      unit: plan.unit,
    })),
    [
      {
        name: 'Astron Coding Plan 专业版',
        currentPriceText: '¥39/月',
        currentPrice: 39,
        unit: '月',
      },
      {
        name: 'Astron Coding Plan 高效版',
        currentPriceText: '¥199/月',
        currentPrice: 199,
        unit: '月',
      },
    ],
  );
  assert.match(plans[0].notes || '', /流控按 5 小时\/周\/月请求次数计量/);
  assert.match(plans[0].serviceDetails.join('\n'), /用量限制: 每 5 小时：最多约 1,200 次请求/);
  assert.match(plans[0].serviceDetails.join('\n'), /支持升级与同档位叠加购买/);
  assert.ok(!plans.some((plan) => /无忧版|季/.test(plan.name + plan.currentPriceText)));
});

test('parseBaiduCodingPlansFromHtml reads Token Plan personal cards', () => {
  const html = `
    <h2>选择适合你的套餐</h2>
    <p>适配 Cursor、Windsurf、Cline 等主流 AI Coding 工具及 Agent 框架，兼容 OpenAI 与 Anthropic 协议</p>
    <p>支持 GLM、DeepSeek、Kimi 等主流顶尖模型一键无缝切换</p>
    <p>完全取消 Coding Plan 原有的三层限流体系</p>
    <ul>
      <li>
        <h3>Mini 尝鲜版</h3>
        <p>新用户、轻度尝鲜、低门槛体验</p>
        <div>限时5折</div>
        <p>商品类型 Token Plan 个人版</p>
        <p>额度规格 1000万 Token</p>
        <p>使用期限 1个月</p>
        <div><i>￥</i><span>4.9</span><i>/月</i></div>
        <div>￥<!-- -->9.9<!-- -->/月</div>
      </li>
      <li>
        <h3>Lite 标准版</h3>
        <p>日常编码、稳定使用的个人开发者</p>
        <div>限时5折</div>
        <p>额度规格 4200万 Token</p>
        <p>使用期限 1个月</p>
        <div><i>￥</i><span>19.9</span><i>/月</i></div>
        <div>￥<!-- -->40<!-- -->/月</div>
      </li>
      <li>
        <h3>Pro 进阶版</h3>
        <p>高频 Coding 用户、进阶开发者</p>
        <div>限时5折</div>
        <p>额度规格 2.3亿 Token</p>
        <p>使用期限 1个月</p>
        <div><i>￥</i><span>99.9</span><i>/月</i></div>
        <div>￥<!-- -->200<!-- -->/月</div>
      </li>
      <li>
        <h3>Max 专业版</h3>
        <p>重度开发用户、Agent 深度使用者</p>
        <div>限时5折</div>
        <p>额度规格 7亿 Token</p>
        <p>使用期限 1个月</p>
        <div><i>￥</i><span>299.9</span><i>/月</i></div>
        <div>￥<!-- -->600<!-- -->/月</div>
      </li>
    </ul>
    <h2>应用场景</h2>
  `;

  const plans = parseBaiduCodingPlansFromHtml(html);

  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      originalPriceText: plan.originalPriceText,
    })),
    [
      {
        name: 'Token Plan Mini',
        currentPriceText: '¥4.9/月',
        originalPriceText: '¥9.9/月',
      },
      {
        name: 'Token Plan Lite',
        currentPriceText: '¥19.9/月',
        originalPriceText: '¥40/月',
      },
      {
        name: 'Token Plan Pro',
        currentPriceText: '¥99.9/月',
        originalPriceText: '¥200/月',
      },
      {
        name: 'Token Plan Max',
        currentPriceText: '¥299.9/月',
        originalPriceText: '¥600/月',
      },
    ],
  );
  assert.match(plans[0].serviceDetails.join('\n'), /额度规格: 1000万 Token/);
  assert.match(plans[0].serviceDetails.join('\n'), /使用期限: 1个月/);
  assert.match(plans[0].serviceDetails.join('\n'), /适配工具: Cursor、Windsurf、Cline/);
  assert.match(plans[0].serviceDetails.join('\n'), /支持模型: GLM、DeepSeek、Kimi 等主流顶尖模型/);
  assert.match(plans[0].notes || '', /限时5折/);
  assert.match(plans[0].notes || '', /新用户、轻度尝鲜、低门槛体验/);
  assert.ok(!/立即购买|额度规$/.test(plans[0].notes || ''));
  assert.ok(!plans[0].serviceDetails.some((item) => /立即购买|￥/.test(item)));
});

test('parseAliyunTokenPlansFromDocsHtml reads the current column-oriented team pricing table', () => {
  const html = `
    <table id="tp-ov-tbl-team">
      <tr><td></td><td>标准座席 Standard</td><td>高级座席 Pro</td><td>尊享座席 Max</td><td>共享用量包 Extra Bundle</td></tr>
      <tr><td>定价</td><td>原价 198 元/座席/月 限时 150 元/座席/月</td><td>原价 698 元/座席/月 限时 550 元/座席/月</td><td>1,398 元/座席/月</td><td>5,000 元/个/月</td></tr>
      <tr><td>每月总额度</td><td>25,000 Credits/座席/月</td><td>100,000 Credits/座席/月</td><td>250,000 Credits/座席/月</td><td>625,000 Credits/个</td></tr>
      <tr><td>5 小时限额</td><td colspan="4">无限制</td></tr>
      <tr><td>7 天限额</td><td colspan="4">无限制</td></tr>
      <tr><td>模型</td><td colspan="4">qwen3.8-max-preview、qwen3.7-max、deepseek-v4-pro、wan2.7-image 等</td></tr>
    </table>
  `;

  const result = parseAliyunTokenPlansFromDocsHtml(html);

  assert.equal(result.provider, 'aliyun-token-plan');
  assert.deepEqual(
    result.plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      currentPrice: plan.currentPrice,
      unit: plan.unit,
    })),
    [
      {
        name: 'Token Plan 标准座席',
        currentPriceText: '¥150/座席/月',
        currentPrice: 150,
        unit: '座席/月',
      },
      {
        name: 'Token Plan 高级座席',
        currentPriceText: '¥550/座席/月',
        currentPrice: 550,
        unit: '座席/月',
      },
      {
        name: 'Token Plan 尊享座席',
        currentPriceText: '¥1,398/座席/月',
        currentPrice: 1398,
        unit: '座席/月',
      },
      {
        name: 'Token Plan 共享用量包',
        currentPriceText: '¥5,000/个/月',
        currentPrice: 5000,
        unit: '个/月',
      },
    ],
  );
  assert.equal(result.plans[0].originalPriceText, '¥198/座席/月');
  assert.equal(result.plans[0].originalPrice, 198);
  assert.equal(result.plans[1].originalPriceText, '¥698/座席/月');
  assert.equal(result.plans[1].originalPrice, 698);
  assert.match(result.plans[0].serviceDetails.join('\n'), /25,000 Credits\/座席\/月/);
  assert.match(result.plans[0].serviceDetails.join('\n'), /qwen3\.8-max-preview/);
  assert.match(result.plans[3].serviceDetails.join('\n'), /625,000 Credits\/个/);
});

test('parseHuaweiTokenPlans returns the four 华为云 Token Plan tiers', async () => {
  const result = await parseHuaweiTokenPlans();

  assert.equal(result.provider, 'huawei-token-plan');
  assert.deepEqual(
    result.sourceUrls,
    [
      'https://www.huaweicloud.com/agentorchard/tokenplan.html',
      'https://console.huaweicloud.com/modelarts/?region=cn-southwest-2#/model-studio/resourcePlanManagement',
    ],
  );
  assert.deepEqual(
    result.plans.map((plan) => ({ name: plan.name, currentPrice: plan.currentPrice, unit: plan.unit })),
    [
      { name: 'Token Plan Lite', currentPrice: 59, unit: '月' },
      { name: 'Token Plan Standard', currentPrice: 149, unit: '月' },
      { name: 'Token Plan Pro', currentPrice: 399, unit: '月' },
      { name: 'Token Plan Max', currentPrice: 799, unit: '月' },
    ],
  );
  const allDetails = result.plans.map((p) => p.serviceDetails.join('\n')).join('\n');
  assert.match(allDetails, /GLM 全系/);
  assert.match(allDetails, /Kimi 全系/);
  assert.match(allDetails, /DeepSeek 全系/);
  assert.match(allDetails, /OpenClaw、Claude Code、Cline、Cursor/);
  assert.match(allDetails, /限购 1 套/);
  assert.match(result.plans[3].serviceDetails.join('\n'), /8\.8 亿 Tokens/);
});

test('buildXAioPlansFromBundle reads monthly plan prices from app chunk', () => {
  const snippet = String.raw`{id:"lite",name:"Lite",nameCN:"入门版",price:{monthly:72,firstOrder:{monthly:36},description:"适合个人开发者的轻量级使用",features:["主流开源 AI 模型访问权限"]}{id:"pro",name:"Pro",nameCN:"专业版",price:{monthly:360,firstOrder:{monthly:180},description:"适合专业团队",features:["稳定的响应速度"]}`;
  const plans = buildXAioPlansFromBundle(snippet);
  assert.equal(plans.length, 2);
  assert.deepEqual(
    plans.map((plan) => ({ name: plan.name, currentPriceText: plan.currentPriceText, notes: plan.notes })),
    [
      { name: 'Lite（入门版）', currentPriceText: '¥72/月', notes: '首购优惠：¥36/月' },
      { name: 'Pro（专业版）', currentPriceText: '¥360/月', notes: '首购优惠：¥180/月' },
    ],
  );
});

test('parseStepfunPlansFromRenderedText reads single-price Credit tiers', () => {
  const pageText = `
    Step Plan 套餐方案 月付 Flash Mini ¥49 适合刚开始体验 AI 的入门用户 新用户 15 天内免费体验 400M Credits月使用量
    Flash Plus ¥99 适合日常使用 AI 提效的用户 首三月专享 1600M Credits月使用量 优先 API 速率
    Flash Pro ¥199 适合高频使用 AI 的深度用户 8000M Credits月使用量
    Flash Max ¥699 适合高强度使用 AI 的专业用户 40000M Credits月使用量 统一 Credit 额度体系
  `;
  const plans = parseStepfunPlansFromRenderedText(pageText);
  assert.equal(plans.length, 4);
  assert.deepEqual(
    plans.map((plan) => ({
      name: plan.name,
      currentPriceText: plan.currentPriceText,
      originalPriceText: plan.originalPriceText,
    })),
    [
      { name: 'Flash Mini', currentPriceText: '¥49/月', originalPriceText: null },
      { name: 'Flash Plus', currentPriceText: '¥99/月', originalPriceText: null },
      { name: 'Flash Pro', currentPriceText: '¥199/月', originalPriceText: null },
      { name: 'Flash Max', currentPriceText: '¥699/月', originalPriceText: null },
    ],
  );
  assert.match(plans[0].notes, /15 天内免费体验/);
  assert.match(plans[0].serviceDetails.join('\n'), /400M Credits/);
  assert.match(plans[1].notes, /首三月专享/);
});

test('parseStepfunPlansFromRenderedText still reads legacy dual-price layout', () => {
  const pageText =
    'Step Plan Flash Mini ¥25 ¥49 每 5 小时 100 次 Prompt Flash Plus ¥49 ¥99 Flash Pro ¥99 ¥199 Flash Max ¥349 ¥699 开发者评价';
  const plans = parseStepfunPlansFromRenderedText(pageText);
  assert.equal(plans.length, 4);
  assert.equal(plans[0].currentPrice, 25);
  assert.equal(plans[0].originalPrice, 49);
});
