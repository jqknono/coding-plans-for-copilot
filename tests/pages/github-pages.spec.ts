import { expect, test, type Locator, type Page } from '@playwright/test';

async function waitForDomesticCards(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: '编码套餐看板' })).toBeVisible();
  await expect(page.locator('#generatedAt')).not.toHaveText(/加载中|--/);
  await expect.poll(async () => page.locator('#domesticGrid .provider-card').count()).toBeGreaterThan(0);
}

async function waitForOverseasCards(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: '编码套餐看板' })).toBeVisible();
  await expect(page.locator('#generatedAt')).not.toHaveText(/加载中|--/);
  await expect.poll(async () => page.locator('#overseasGrid .provider-card').count()).toBeGreaterThan(0);
}

async function waitForMetricsRows(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: '指标解释' })).toBeVisible();
  await expect.poll(async () => page.locator('#metricsTableContainer tbody tr').count()).toBeGreaterThan(0);
}

async function openOrgFilter(page: Page): Promise<Locator> {
  const filter = page.locator('[data-filter="org"]');
  await filter.getByRole('textbox', { name: '厂商筛选' }).click();
  await expect(filter.locator('.searchable-select-dropdown')).toBeVisible();
  await expect.poll(async () => filter.locator('.searchable-select-option:not(.is-all-option)').count()).toBeGreaterThan(1);
  return filter;
}

test('首页渲染与 Tab 切换正常', async ({ page }) => {
  await page.goto('/');
  await waitForDomesticCards(page);

  const hero = page.locator('.hero');
  const topLinks = hero.getByRole('navigation', { name: '页面快捷链接' }).getByRole('link');
  await expect(topLinks).toHaveCount(2);
  const projectLink = hero.getByRole('link', { name: '查看本工程 GitHub' });
  const discussionLink = hero.getByRole('link', { name: '打开讨论' });
  await expect(projectLink).toBeVisible();
  await expect(projectLink).toHaveText('');
  await expect(projectLink).toHaveAttribute(
    'href',
    'https://github.com/jqknono/chinese-llm-for-copilot',
  );
  await expect(discussionLink).toBeVisible();
  await expect(discussionLink).toHaveText('');
  await expect(discussionLink).toHaveAttribute(
    'href',
    'https://github.com/jqknono/coding-plans-for-copilot/discussions',
  );
  const [heroBox, linkBox, titleBox] = await Promise.all([
    hero.boundingBox(),
    discussionLink.boundingBox(),
    page.getByRole('heading', { level: 1, name: '编码套餐看板' }).boundingBox(),
  ]);
  expect(heroBox).not.toBeNull();
  expect(linkBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(heroBox!.x + heroBox!.width);
  expect(linkBox!.y).toBeGreaterThanOrEqual(heroBox!.y);
  expect(linkBox!.y + linkBox!.height).toBeLessThan(titleBox!.y + titleBox!.height);
  await expect(hero.getByRole('link')).toHaveCount(2);
  const pluginIntroFollowsDomesticPanel = await page.evaluate(() => {
    const domesticPanel = document.querySelector('#domesticPanel');
    const pluginIntro = document.querySelector('.plugin-intro');
    return Boolean(
      domesticPanel
        && pluginIntro
        && (domesticPanel.compareDocumentPosition(pluginIntro) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
  });
  expect(pluginIntroFollowsDomesticPanel).toBe(true);

  await expect(page.getByRole('tab', { name: '大陆套餐' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#domesticPanel')).not.toHaveClass(/hidden/);
  await expect(page.locator('#providerCount')).not.toHaveText('0');
  await expect(page.locator('#planCount')).not.toHaveText('0');

  await page.getByRole('tab', { name: '海外套餐' }).click();
  await expect(page).toHaveURL(/#overseas$/);
  await expect(page.locator('#overseasPanel')).not.toHaveClass(/hidden/);
  await expect(page.locator('#domesticPanel')).toHaveClass(/hidden/);

  await page.getByRole('tab', { name: '供应商性能指标' }).click();
  await expect(page).toHaveURL(/#metrics$/);
  await expect(page.locator('#metricsPanel')).not.toHaveClass(/hidden/);
  await expect(page.locator('#overseasPanel')).toHaveClass(/hidden/);
  await waitForMetricsRows(page);
});

test('大陆套餐展示阿里云 Token Plan', async ({ page }) => {
  await page.goto('/#domestic');
  await waitForDomesticCards(page);

  const card = page.locator('#provider-card-aliyun-token-plan');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: '阿里云 Token Plan' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Token Plan 标准坐席' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Token Plan 高级坐席' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Token Plan 尊享坐席' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Token Plan 共享用量包' })).toBeVisible();
  await expect(card.getByRole('link', { name: '前往了解' })).toHaveAttribute(
    'href',
    'https://common-buy.aliyun.com/token-plan/',
  );
});

test('Moonshot Kimi 海内外套餐按人民币和美元分开展示', async ({ page }) => {
  await page.goto('/#domestic');
  await waitForDomesticCards(page);

  const domesticCard = page.locator('#domesticPanel #provider-card-moonshotai');
  await expect(domesticCard).toBeVisible();
  await expect(domesticCard.getByRole('heading', { name: 'Moonshot Kimi' })).toBeVisible();
  await expect(domesticCard.getByRole('heading', { name: 'Andante（大陆）' })).toBeVisible();
  await expect(domesticCard.getByText('¥49/月')).toBeVisible();
  await expect(domesticCard.getByText('计价币种: 人民币（CNY）').first()).toBeVisible();
  await expect(domesticCard.getByRole('link', { name: '前往了解' })).toHaveAttribute(
    'href',
    'https://www.kimi.com/zh-cn/help/membership/membership-pricing',
  );

  await page.getByRole('tab', { name: '海外套餐' }).click();
  await waitForOverseasCards(page);

  const overseasCard = page.locator('#overseasPanel #provider-card-moonshotai');
  await expect(overseasCard).toBeVisible();
  await expect(overseasCard.getByRole('heading', { name: 'Moderato（海外）' })).toBeVisible();
  await expect(overseasCard.getByText('$19/月')).toBeVisible();
  await expect(overseasCard.getByText('计价币种: 美元（USD）').first()).toBeVisible();
  await expect(overseasCard.getByRole('link', { name: '前往了解' })).toHaveAttribute(
    'href',
    'https://www.kimi.com/code',
  );
});

test('海外套餐展示 Venice WandB 与 Cloudflare 的服务详情', async ({ page }) => {
  await page.goto('/#overseas');
  await waitForOverseasCards(page);
  await expect(page.locator('#overseasPanel')).not.toHaveClass(/hidden/);

  const veniceCard = page.locator('#provider-card-venice');
  await expect(veniceCard).toBeVisible();
  await expect(veniceCard.getByRole('heading', { name: 'Pro Plus' })).toBeVisible();
  await expect(veniceCard.getByText('7,500 credits / month for video, music, frontier image generation, LLMs, and API')).toBeVisible();

  const wandbCard = page.locator('#provider-card-wandb');
  await expect(wandbCard).toBeVisible();
  await expect(wandbCard.getByRole('heading', { name: 'Inference add-on' })).toBeVisible();
  await expect(wandbCard.getByText('Run open source AI models. View per model pricing.')).toBeVisible();

  const cloudflareCard = page.locator('#provider-card-cloudflare');
  await expect(cloudflareCard).toBeVisible();
  await expect(cloudflareCard.getByRole('heading', { name: 'Workers AI Paid usage' })).toBeVisible();
  await expect(cloudflareCard.getByText('@cf/meta/llama-3.2-1b-instruct')).toBeVisible();
});

test('指标页支持厂商多选与全部恢复', async ({ page }) => {
  await page.goto('/#metrics');
  await waitForMetricsRows(page);

  const initialRowCount = await page.locator('#metricsTableContainer tbody tr').count();
  expect(initialRowCount).toBeGreaterThan(1);

  const filter = await openOrgFilter(page);
  const optionLocator = filter.locator('.searchable-select-option:not(.is-all-option)');
  const firstLabel = (await optionLocator.nth(0).textContent())?.trim() || '';
  const secondLabel = (await optionLocator.nth(1).textContent())?.trim() || '';

  await optionLocator.nth(0).click();
  await optionLocator.nth(1).click();

  const input = filter.getByRole('textbox', { name: '厂商筛选' });
  await expect(input).toHaveValue(`${firstLabel}、${secondLabel}`);
  await expect.poll(async () => page.locator('#metricsTableContainer tbody tr').count()).toBeLessThan(initialRowCount);

  await filter.locator('.searchable-select-option.is-all-option').click();
  await expect(input).toHaveValue('全部厂商');
  await expect.poll(async () => page.locator('#metricsTableContainer tbody tr').count()).toBe(initialRowCount);
});

test('指标页展示 1M 输入缓存与输出价格', async ({ page }) => {
  await page.goto('/#metrics');
  await waitForMetricsRows(page);

  await expect(page.getByRole('columnheader', { name: /1M价格/ })).toBeVisible();
  await expect(page.getByText('北京时间采集时间')).toHaveCount(0);
  await expect(page.getByText('目标采集窗口')).toHaveCount(0);
  await expect(page.getByText('美元人民币汇率')).toHaveCount(0);
  await expect(page.locator('#metricsTableContainer .metric-price').first()).toContainText('输入');
  await expect(page.locator('#metricsTableContainer .metric-price').first()).toContainText('输出');
  await expect.poll(async () => page.locator('#metricsTableContainer .metric-price').filter({ hasText: '¥' }).count()).toBeGreaterThan(0);
  await expect(page.locator('#metricsTableContainer .metric-price').first()).not.toContainText('$');
  await expect.poll(async () => page.locator('#metricsTableContainer .metric-cache-badge').count()).toBeGreaterThan(0);
});

test('指标页价格排序优先使用缓存命中价格', async ({ page }) => {
  await page.route('**/openrouter-provider-metrics.json', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        generatedAt: '2026-04-29T08:00:00.000Z',
        generatedAtBeijing: '2026年4月29日 16:00:00',
        captureWindow: {
          timezone: 'Asia/Shanghai',
          targetLocalTime: '16:00',
        },
        config: {
          modelMaxAgeDays: 180,
        },
        exchangeRates: {
          USD_CNY: {
            rate: 7,
          },
        },
        models: [
          {
            organization: 'deepseek',
            id: 'deepseek/test-sort-model',
            name: 'DeepSeek Test Sort Model',
            endpoints: [
              {
                providerName: 'No Cache A',
                providerSlug: 'no-cache-a',
                tag: 'no-cache-a',
                uptime_last_30m: 100,
                latency_last_30m: { p50: 1000, p90: 1200, p99: 1500 },
                throughput_last_30m: { p50: 10, p90: 12, p99: 15 },
                pricing: {
                  prompt: 5e-7,
                  input_cache_read: null,
                  completion: 1e-6,
                  has_input_cache_read_discount: false,
                  input_cache_read_discount_rate: null,
                  cny: {
                    prompt: 0.0000035,
                    input_cache_read: null,
                    completion: 0.000007,
                  },
                },
              },
              {
                providerName: 'Cache B',
                providerSlug: 'cache-b',
                tag: 'cache-b',
                uptime_last_30m: 100,
                latency_last_30m: { p50: 1000, p90: 1200, p99: 1500 },
                throughput_last_30m: { p50: 10, p90: 12, p99: 15 },
                pricing: {
                  prompt: 9e-7,
                  input_cache_read: 1e-7,
                  completion: 1e-6,
                  has_input_cache_read_discount: true,
                  input_cache_read_discount_rate: 0.8888888888888888,
                  cny: {
                    prompt: 0.0000063,
                    input_cache_read: 0.0000007,
                    completion: 0.000007,
                  },
                },
              },
              {
                providerName: 'Cache C',
                providerSlug: 'cache-c',
                tag: 'cache-c',
                uptime_last_30m: 100,
                latency_last_30m: { p50: 1000, p90: 1200, p99: 1500 },
                throughput_last_30m: { p50: 10, p90: 12, p99: 15 },
                pricing: {
                  prompt: 2e-7,
                  input_cache_read: 3e-8,
                  completion: 1e-6,
                  has_input_cache_read_discount: true,
                  input_cache_read_discount_rate: 0.85,
                  cny: {
                    prompt: 0.0000014,
                    input_cache_read: 0.00000021,
                    completion: 0.000007,
                  },
                },
              },
            ],
          },
        ],
        failures: [],
      }),
    });
  });

  await page.goto('/#metrics');
  await waitForMetricsRows(page);
  await page.getByRole('columnheader', { name: /1M价格/ }).click();

  const providerNames = await page.locator('#metricsTableContainer tbody tr .metric-provider').allTextContents();
  expect(providerNames.map((text) => text.trim()).slice(0, 3)).toEqual([
    'Cache C',
    'Cache B',
    'No Cache A',
  ]);
});

test('指标页支持缓存优惠筛选', async ({ page }) => {
  await page.goto('/#metrics');
  await waitForMetricsRows(page);

  const filter = page.locator('[data-filter="cacheDiscount"]');
  await filter.getByRole('textbox', { name: '缓存优惠筛选' }).click();
  await expect(filter.locator('.searchable-select-dropdown')).toBeVisible();
  await filter.getByText('支持缓存优惠', { exact: true }).click();

  await expect(filter.getByRole('textbox', { name: '缓存优惠筛选' })).toHaveValue('支持缓存优惠');
  await expect.poll(async () => page.locator('#metricsTableContainer tbody tr').count()).toBeGreaterThan(0);
  const visibleRows = page.locator('#metricsTableContainer tbody tr');
  const rowCount = await visibleRows.count();
  for (let index = 0; index < Math.min(rowCount, 10); index += 1) {
    await expect(visibleRows.nth(index).locator('.metric-cache-badge')).toContainText(/缓存折扣\s+\d/);
  }
});

test('指标页支持 URL 携带筛选条件', async ({ page }) => {
  await page.goto('/?metricsOrg=deepseek&metricsCacheDiscount=yes#metrics');
  await waitForMetricsRows(page);

  await expect(page.getByRole('textbox', { name: '厂商筛选' })).toHaveValue('DeepSeek');
  await expect(page.getByRole('textbox', { name: '缓存优惠筛选' })).toHaveValue('支持缓存优惠');
  await expect.poll(async () => page.locator('#metricsTableContainer tbody tr').count()).toBeGreaterThan(0);

  const rows = page.locator('#metricsTableContainer tbody tr');
  const rowCount = await rows.count();
  for (let index = 0; index < Math.min(rowCount, 10); index += 1) {
    await expect(rows.nth(index)).toContainText('DeepSeek');
    await expect(rows.nth(index).locator('.metric-cache-badge')).toContainText(/缓存折扣\s+\d/);
  }

  const filter = page.locator('[data-filter="provider"]');
  await filter.getByRole('textbox', { name: 'Provider 筛选' }).click();
  await expect(filter.locator('.searchable-select-dropdown')).toBeVisible();
  await filter.locator('.searchable-select-option:not(.is-all-option)').first().click();
  await expect(page).toHaveURL(/metricsProvider=/);
});

test('指标筛选有内容时隐藏展开水印', async ({ page }) => {
  await page.goto('/?metricsOrg=deepseek#metrics');
  await waitForMetricsRows(page);

  const filter = page.locator('[data-filter="org"]');
  await expect(filter.getByRole('textbox', { name: '厂商筛选' })).toHaveValue('DeepSeek');
  await expect(filter.locator('.searchable-select-watermark')).toHaveClass(/hidden/);
});

test('指标页套餐标记和查看套餐跳转正常', async ({ page }) => {
  await page.goto('/#metrics');
  await waitForMetricsRows(page);
  await expect.poll(async () => page.getByRole('button', { name: '查看套餐' }).count()).toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as Window & { __lastNavigateArgs?: { tab: string; cardId: string } | null }).__lastNavigateArgs = null;
    const original = (window as Window & typeof globalThis).navigateToProviderCard;
    if (typeof original === 'function') {
      (window as Window & typeof globalThis).navigateToProviderCard = ((tab: string, cardId: string) => {
        (window as Window & { __lastNavigateArgs?: { tab: string; cardId: string } | null }).__lastNavigateArgs = { tab, cardId };
        return original(tab, cardId);
      }) as typeof original;
    }
  });

  const jumpButton = page.getByRole('button', { name: '查看套餐' }).first();
  await jumpButton.click();

  const navigateArgs = await page.evaluate(() =>
    (window as Window & { __lastNavigateArgs?: { tab: string; cardId: string } | null }).__lastNavigateArgs ?? null
  );
  expect(navigateArgs).not.toBeNull();

  const expectedHash = navigateArgs?.tab === 'domestic' ? /#domestic$/ : /#overseas$/;
  const expectedPanel = navigateArgs?.tab === 'domestic' ? '#domesticPanel' : '#overseasPanel';

  await expect(page).toHaveURL(expectedHash);
  await expect(page.locator(expectedPanel)).not.toHaveClass(/hidden/);
  await expect(page.locator(`#${navigateArgs?.cardId}`)).toHaveCount(1);
  await expect(page.getByRole('tab', { name: navigateArgs?.tab === 'domestic' ? '大陆套餐' : '海外套餐' })).toHaveAttribute('aria-selected', 'true');
});

