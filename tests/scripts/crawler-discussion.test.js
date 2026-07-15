'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildCanonicalLabels,
  normalizeLabelSegment,
  buildDiscussionBody,
  ensureLabel,
} = require('../../scripts/crawler/github-discussion');

const { removeTagLineFromBody } = require('../../scripts/discussions/migrate-discussion-labels');
const { buildExpectedState } = require('../../scripts/discussions/verify-discussion-labels');

const {
  validateAnalysis,
  parseAndValidateAnalysis,
  setAvailableCategories,
} = require('../../scripts/crawler/analyzer');

const { summarizeAnalysisOutcomes } = require('../../scripts/crawler/index');
const { KEYWORDS, matchesKeywords } = require('../../scripts/crawler/keywords');

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function loadWorkflowText() {
  return fs.readFileSync(
    path.resolve(__dirname, '..', '..', '.github', 'workflows', 'crawl-community-posts.yml'),
    'utf8',
  );
}

function loadPackageJson() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
}

// ─── keywords ───

test('keywords include legacy filters and vendor names', () => {
  for (const keyword of [
    '套餐',
    'coding',
    'plan',
    'claude',
    'gpt',
    'openai',
    'kimi',
    'zhipu',
    'moonshot',
    'qwen',
    'glm',
    'deepseek',
  ]) {
    assert.ok(KEYWORDS.includes(keyword), `missing keyword: ${keyword}`);
  }
});

test('matchesKeywords is case-insensitive for vendor names', () => {
  assert.equal(matchesKeywords('Claude Code 体验'), true);
  assert.equal(matchesKeywords('OpenAI GPT-5.6'), true);
  assert.equal(matchesKeywords('DeepSeek coding plan'), true);
  assert.equal(matchesKeywords('今天天气不错'), false);
});

// ─── normalizeLabelSegment ───

test('normalizeLabelSegment: trims whitespace', () => {
  assert.equal(normalizeLabelSegment('  pricing  '), 'pricing');
});

test('normalizeLabelSegment: collapses internal spaces to single dash', () => {
  assert.equal(normalizeLabelSegment('coding plan'), 'coding-plan');
});

test('normalizeLabelSegment: collapses multiple spaces to single dash', () => {
  assert.equal(normalizeLabelSegment('GPT   Plus'), 'GPT-Plus');
});

test('normalizeLabelSegment: handles already-normalized input', () => {
  assert.equal(normalizeLabelSegment('pricing'), 'pricing');
});

// ─── buildCanonicalLabels ───

test('buildCanonicalLabels: generates all label types', () => {
  const analysis = {
    supplier: 'OpenAI',
    sentiment: 'positive',
    language: 'en',
    topics: ['pricing', 'comparison'],
  };
  const labels = buildCanonicalLabels(analysis);
  assert.deepEqual(labels.sort(), [
    'lang:en',
    'sentiment:positive',
    'supplier:OpenAI',
    'topic:comparison',
    'topic:pricing',
  ]);
});

test('buildCanonicalLabels: normalizes topic with spaces', () => {
  const analysis = { topics: ['coding plan', 'GPT Plus'] };
  const labels = buildCanonicalLabels(analysis);
  assert.ok(labels.includes('topic:coding-plan'));
  assert.ok(labels.includes('topic:GPT-Plus'));
});

test('buildCanonicalLabels: deduplicates identical labels', () => {
  const analysis = { topics: ['pricing', 'pricing'] };
  const labels = buildCanonicalLabels(analysis);
  const pricingCount = labels.filter((l) => l === 'topic:pricing').length;
  assert.equal(pricingCount, 1);
});

test('buildCanonicalLabels: handles empty analysis', () => {
  const labels = buildCanonicalLabels({});
  assert.equal(labels.length, 0);
});

test('buildCanonicalLabels: handles partial analysis', () => {
  const analysis = { sentiment: 'neutral', language: 'zh' };
  const labels = buildCanonicalLabels(analysis);
  assert.deepEqual(labels.sort(), ['lang:zh', 'sentiment:neutral']);
});

// ─── buildDiscussionBody ───

test('buildDiscussionBody: does not contain legacy tag line', () => {
  const post = {
    url: 'https://example.com/post/1',
    source: 'v2ex',
    author: 'testuser',
    createdAt: '2025-01-01',
    content: 'Test content',
    replies: [],
  };
  const analysis = {
    supplier: 'TestSupplier',
    sentiment: 'neutral',
    language: 'zh',
    topics: ['pricing'],
    summary: 'Test summary',
  };
  const body = buildDiscussionBody(post, analysis, '2025-01-01T00:00:00Z');
  assert.ok(!body.includes('**标签**'), 'Body should not contain legacy tag line');
  assert.ok(!body.includes('标签:'), 'Body should not contain legacy tag line variant');
});

test('buildDiscussionBody: contains expected sections', () => {
  const post = {
    url: 'https://example.com/post/1',
    source: 'linuxdo',
    author: 'testuser',
    createdAt: '2025-01-01',
    content: 'Test content',
    replies: [{ author: 'replier', content: 'Reply text' }],
  };
  const analysis = {
    supplier: 'TestSupplier',
    sentiment: 'positive',
    language: 'en',
    topics: ['comparison'],
    summary: 'A summary',
  };
  const body = buildDiscussionBody(post, analysis, '2025-01-01T00:00:00Z');
  assert.ok(body.includes('Linux.do'), 'Should contain source label');
  assert.ok(body.includes('testuser'), 'Should contain author');
  assert.ok(body.includes('TestSupplier'), 'Should contain supplier');
  assert.ok(body.includes('A summary'), 'Should contain summary');
  assert.ok(body.includes('Test content'), 'Should contain content');
  assert.ok(body.includes('replier'), 'Should contain reply author');
  assert.ok(body.includes('社区爬虫自动生成'), 'Should contain generation marker');
});

// ─── removeTagLineFromBody ───

test('removeTagLineFromBody: removes legacy tag line', () => {
  const body = 'Some intro\n> **标签**: supplier:OpenAI sentiment:neutral\nMore content';
  const cleaned = removeTagLineFromBody(body);
  assert.ok(!cleaned.includes('**标签**'), 'Should remove tag line');
  assert.ok(cleaned.includes('Some intro'), 'Should preserve other content');
  assert.ok(cleaned.includes('More content'), 'Should preserve other content');
});

test('removeTagLineFromBody: returns body unchanged when no tag line', () => {
  const body = 'Some intro\nMore content\nNo tags here';
  const cleaned = removeTagLineFromBody(body);
  assert.equal(cleaned, body);
});

// ─── Category selection (indirect via module structure) ───
// The category selection logic is tested via integration since it requires
// GitHub API calls. The key behavior is:
// - General category must exist → selected
// - General category missing → error (no fallback)
// This is enforced in createDiscussionForPost's code path.

// ─── Migration script: only uses analysis, not body ───
// This is verified by the migrate-discussion-labels.js implementation
// which only calls buildCanonicalLabels(analysis) and never parses body tags.

// ─── validateAnalysis ───

test('validateAnalysis: passes valid complete analysis', () => {
  const obj = {
    isRelevant: true,
    isCodingPlan: true,
    relevance: 0.9,
    supplier: 'OpenAI',
    supplierCategory: 'international-provider',
    sentiment: 'positive',
    sentimentConfidence: 0.8,
    summary: 'A post about pricing',
    topics: ['pricing', 'copilot'],
    planMentioned: 'Pro',
    language: 'en',
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test('validateAnalysis: passes valid minimal analysis', () => {
  const obj = {
    isRelevant: false,
    isCodingPlan: false,
    relevance: 0.1,
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test('validateAnalysis: rejects non-boolean isRelevant', () => {
  const errors = validateAnalysis({ isRelevant: 'yes', isCodingPlan: true, relevance: 0.5 });
  assert.ok(errors.some((e) => e.includes('isRelevant')));
});

test('validateAnalysis: rejects out-of-range relevance', () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 1.5 });
  assert.ok(errors.some((e) => e.includes('relevance')));
});

test('validateAnalysis: rejects invalid sentiment', () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, sentiment: 'happy' });
  assert.ok(errors.some((e) => e.includes('sentiment')));
});

test('validateAnalysis: rejects invalid language', () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, language: 'fr' });
  assert.ok(errors.some((e) => e.includes('language')));
});

test('validateAnalysis: rejects non-array topics', () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, topics: 'pricing' });
  assert.ok(errors.some((e) => e.includes('topics')));
});

test('validateAnalysis: rejects invalid supplierCategory', () => {
  const errors = validateAnalysis({
    isRelevant: true,
    isCodingPlan: true,
    relevance: 0.5,
    supplierCategory: 'unknown',
  });
  assert.ok(errors.some((e) => e.includes('supplierCategory')));
});

test('validateAnalysis: accepts null optional fields', () => {
  const obj = {
    isRelevant: false,
    isCodingPlan: false,
    relevance: 0.2,
    supplier: null,
    supplierCategory: null,
    sentiment: 'neutral',
    language: 'zh',
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test('validateAnalysis: rejects missing isCodingPlan', () => {
  const errors = validateAnalysis({ isRelevant: true, relevance: 0.5 });
  assert.ok(errors.some((e) => e.includes('isCodingPlan')));
});

test('validateAnalysis: requires category when categories are configured', () => {
  setAvailableCategories([{ name: '社区资讯' }]);
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.8 });
  assert.ok(errors.some((e) => e.includes('category')));
  setAvailableCategories([]);
});

// ─── parseAndValidateAnalysis ───

test('parseAndValidateAnalysis: parses valid JSON string', () => {
  const json = '{"isRelevant":true,"isCodingPlan":true,"relevance":0.8,"sentiment":"neutral","language":"zh"}';
  const result = parseAndValidateAnalysis(json);
  assert.equal(result.isRelevant, true);
  assert.equal(result.isCodingPlan, true);
  assert.equal(result.relevance, 0.8);
});

test('parseAndValidateAnalysis: throws on invalid JSON', () => {
  assert.throws(() => parseAndValidateAnalysis('not json at all'), /invalid JSON/);
});

test('parseAndValidateAnalysis: throws on valid JSON but invalid schema', () => {
  const json = '{"isRelevant":"yes","relevance":0.5}';
  assert.throws(() => parseAndValidateAnalysis(json), /schema validation failed/);
});

// ─── Workflow/package regression guards ───

test('workflow uses publish crawler command', () => {
  const workflow = loadWorkflowText();
  assert.match(workflow, /npm run crawler:run:publish/);
});

test('workflow verifies discussion labels without migration step', () => {
  const workflow = loadWorkflowText();
  assert.doesNotMatch(workflow, /npm run crawler:migrate-discussion-labels/);
  assert.match(workflow, /verify_discussions:[\s\S]*run:\s*npm run crawler:verify-discussion-labels/);
});

test('workflow verifies system Chrome before crawling linuxdo', () => {
  const workflow = loadWorkflowText();
  assert.match(workflow, /PLAYWRIGHT_BROWSER_CHANNEL:\s*"chrome"/);
  assert.match(
    workflow,
    /jobs:\s*crawl:[\s\S]*Verify system Chrome[\s\S]*google-chrome --version[\s\S]*Run community crawler/,
  );
});

test('cleanup npm script stays in dry-run mode by default', () => {
  const pkg = loadPackageJson();
  assert.equal(pkg.scripts['crawler:cleanup-discussions'], 'node ./scripts/discussions/cleanup-discussions.js');
});

test('buildExpectedState preserves analysis category instead of hard-coding General', () => {
  const expected = buildExpectedState({
    analysis: {
      supplier: 'OpenAI',
      sentiment: 'neutral',
      language: 'zh',
      topics: ['pricing'],
      category: '社区资讯',
    },
  });

  assert.equal(expected.expectedCategory, '社区资讯');
  assert.deepEqual(expected.labels.sort(), ['lang:zh', 'sentiment:neutral', 'supplier:OpenAI', 'topic:pricing']);
});

// ─── Linux.do fallback regression ───

function makePlaywrightMock(handler) {
  return async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async (url) => {
          const result = await handler(url);
          return {
            status: () => result.status || 200,
            text: async () => result.text || '',
          };
        },
        evaluate: async () => '',
        close: async () => {},
      }),
      close: async () => {},
    }),
    close: async () => {},
  });
}

function loadLinuxDoModule() {
  const modulePath = require.resolve('../../scripts/crawler/sources/linuxdo');
  delete require.cache[modulePath];
  return require('../../scripts/crawler/sources/linuxdo');
}

test('parseRssItems extracts topic metadata from Discourse RSS', () => {
  const { parseRssItems, parseTopicIdFromUrl } = loadLinuxDoModule();
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
  <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel>
      <item>
        <title><![CDATA[LinuxDo coding plan 体验]]></title>
        <link>https://linux.do/t/topic/2587604</link>
        <description><![CDATA[<p>coding plan details</p>]]></description>
        <dc:creator><![CDATA[tester]]></dc:creator>
        <category>前沿快讯</category>
        <guid>linux.do-topic-2587604</guid>
        <pubDate>Wed, 15 Jul 2026 04:48:43 +0000</pubDate>
      </item>
    </channel>
  </rss>`;

  assert.equal(parseTopicIdFromUrl('https://linux.do/t/topic/2587604'), 2587604);
  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 2587604);
  assert.equal(items[0].title, 'LinuxDo coding plan 体验');
  assert.equal(items[0].author, 'tester');
  assert.match(items[0].excerpt, /coding plan details/);
  assert.equal(items[0].created_at, '2026-07-15T04:48:43.000Z');
});

test('fetchLinuxDoPosts prefers RSS list then fetches JSON detail via Playwright', async () => {
  const originalFetch = global.fetch;
  const playwright = require('playwright');
  const originalLaunch = playwright.chromium.launch;

  let fetchCalls = 0;
  let gotoUrls = [];

  global.fetch = async (url) => {
    fetchCalls += 1;
    if (String(url).includes('/latest.rss')) {
      return {
        ok: false,
        status: 403,
        text: async () => '<html><title>Just a moment...</title></html>',
      };
    }
    throw new Error(`unexpected direct fetch: ${url}`);
  };

  playwright.chromium.launch = makePlaywrightMock(async (url) => {
    gotoUrls.push(url);
    if (url.includes('/latest.rss')) {
      return {
        status: 200,
        text: `<?xml version="1.0" encoding="UTF-8" ?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <item>
              <title>LinuxDo coding plan post</title>
              <link>https://linux.do/t/topic/123</link>
              <description><![CDATA[<p>coding plan summary</p>]]></description>
              <dc:creator>rss-author</dc:creator>
              <guid>linux.do-topic-123</guid>
              <pubDate>Sun, 05 Apr 2026 00:00:00 +0000</pubDate>
            </item>
          </channel>
        </rss>`,
      };
    }
    if (url.includes('/t/123.json')) {
      return {
        status: 200,
        text: JSON.stringify({
          post_stream: {
            posts: [
              {
                cooked: '<p>coding plan details</p>',
                username: 'tester',
                created_at: '2026-04-05T00:00:00.000Z',
              },
            ],
          },
        }),
      };
    }
    return { status: 404, text: 'not found' };
  });

  try {
    const posts = await withEnv('CRAWLER_LINUXDO_PAGES', '1', async () =>
      withEnv('CRAWLER_LINUXDO_DELAY_MS', '0', async () => {
        const { fetchLinuxDoPosts } = loadLinuxDoModule();
        return fetchLinuxDoPosts({ failures: [] });
      }),
    );

    assert.equal(fetchCalls, 1);
    assert.ok(gotoUrls.some((url) => url.includes('/latest.rss')));
    assert.ok(gotoUrls.some((url) => url.includes('/t/123.json')));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, 'linuxdo-123');
    assert.equal(posts[0].author, 'tester');
    assert.match(posts[0].content, /coding plan details/);
  } finally {
    playwright.chromium.launch = originalLaunch;
    global.fetch = originalFetch;
    delete require.cache[require.resolve('../../scripts/crawler/sources/linuxdo')];
  }
});

test('fetchLinuxDoPosts falls back to JSON list when RSS fails', async () => {
  const originalFetch = global.fetch;
  const playwright = require('playwright');
  const originalLaunch = playwright.chromium.launch;

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 403,
      text: async () => '<html><title>Just a moment...</title></html>',
    };
  };

  playwright.chromium.launch = makePlaywrightMock(async (url) => {
    if (url.includes('/latest.rss')) {
      return { status: 429, text: 'Too Many Requests' };
    }
    if (url.includes('/latest.json')) {
      return {
        status: 200,
        text: JSON.stringify({
          topic_list: {
            topics: [
              {
                id: 456,
                title: 'LinuxDo coding plan post',
                excerpt: 'coding plan',
                slug: 'linuxdo-coding-plan-post',
                created_at: '2026-04-05T00:00:00.000Z',
              },
            ],
          },
        }),
      };
    }
    if (url.includes('/t/456.json')) {
      return {
        status: 200,
        text: JSON.stringify({
          post_stream: {
            posts: [
              {
                cooked: '<p>coding plan details</p>',
                username: 'tester',
                created_at: '2026-04-05T00:00:00.000Z',
              },
            ],
          },
        }),
      };
    }
    return { status: 404, text: 'not found' };
  });

  try {
    const posts = await withEnv('CRAWLER_LINUXDO_PAGES', '1', async () =>
      withEnv('CRAWLER_LINUXDO_DELAY_MS', '0', async () =>
        withEnv('CRAWLER_LINUXDO_MAX_RETRIES', '1', async () =>
          withEnv('CRAWLER_LINUXDO_RETRY_BASE_MS', '1', async () => {
            const { fetchLinuxDoPosts } = loadLinuxDoModule();
            return fetchLinuxDoPosts({ failures: [] });
          }),
        ),
      ),
    );

    assert.ok(fetchCalls >= 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, 'linuxdo-456');
  } finally {
    playwright.chromium.launch = originalLaunch;
    global.fetch = originalFetch;
    delete require.cache[require.resolve('../../scripts/crawler/sources/linuxdo')];
  }
});

test('fetchLinuxDoPosts retries Playwright 429 with backoff before succeeding', async () => {
  const originalFetch = global.fetch;
  const playwright = require('playwright');
  const originalLaunch = playwright.chromium.launch;

  let rssAttempts = 0;
  global.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => '<html><title>Just a moment...</title></html>',
  });

  playwright.chromium.launch = makePlaywrightMock(async (url) => {
    if (url.includes('/latest.rss')) {
      rssAttempts += 1;
      if (rssAttempts < 3) {
        return { status: 429, text: 'Too Many Requests' };
      }
      return {
        status: 200,
        text: `<?xml version="1.0" encoding="UTF-8" ?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <item>
              <title>LinuxDo coding plan post</title>
              <link>https://linux.do/t/topic/789</link>
              <description><![CDATA[<p>coding plan summary</p>]]></description>
              <dc:creator>rss-author</dc:creator>
              <guid>linux.do-topic-789</guid>
              <pubDate>Sun, 05 Apr 2026 00:00:00 +0000</pubDate>
            </item>
          </channel>
        </rss>`,
      };
    }
    if (url.includes('/t/789.json')) {
      return {
        status: 200,
        text: JSON.stringify({
          post_stream: {
            posts: [
              {
                cooked: '<p>coding plan details</p>',
                username: 'tester',
                created_at: '2026-04-05T00:00:00.000Z',
              },
            ],
          },
        }),
      };
    }
    return { status: 404, text: 'not found' };
  });

  try {
    const posts = await withEnv('CRAWLER_LINUXDO_PAGES', '1', async () =>
      withEnv('CRAWLER_LINUXDO_DELAY_MS', '0', async () =>
        withEnv('CRAWLER_LINUXDO_MAX_RETRIES', '3', async () =>
          withEnv('CRAWLER_LINUXDO_RETRY_BASE_MS', '1', async () => {
            const { fetchLinuxDoPosts } = loadLinuxDoModule();
            return fetchLinuxDoPosts({ failures: [] });
          }),
        ),
      ),
    );

    assert.equal(rssAttempts, 3);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, 'linuxdo-789');
  } finally {
    playwright.chromium.launch = originalLaunch;
    global.fetch = originalFetch;
    delete require.cache[require.resolve('../../scripts/crawler/sources/linuxdo')];
  }
});

test('summarizeAnalysisOutcomes groups selected and skipped posts', () => {
  const summary = summarizeAnalysisOutcomes(
    [
      {
        post: { id: 'a' },
        analysis: { isCodingPlan: true, isRelevant: true, relevance: 0.9 },
      },
      {
        post: { id: 'b' },
        analysis: { isCodingPlan: false, isRelevant: false, relevance: 0.2 },
      },
      {
        post: { id: 'c' },
        analysis: { isCodingPlan: true, isRelevant: false, relevance: 0.8 },
      },
      {
        post: { id: 'd' },
        analysis: { isCodingPlan: true, isRelevant: true, relevance: 0.4 },
      },
      {
        post: { id: 'e' },
        analysis: { analysisError: true, error: 'timeout' },
      },
    ],
    0.7,
  );

  assert.deepEqual(summary, {
    totalAnalyzed: 5,
    selected: 1,
    analysisErrors: 1,
    notCodingPlan: 1,
    notRelevant: 1,
    belowThreshold: 1,
  });
});

// ─── ensureLabel pagination / conflict recovery ───

test('ensureLabel pages through more than 100 existing labels', async () => {
  const originalFetch = global.fetch;
  let labelListCalls = 0;

  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const query = body.query || '';

    if (query.includes('labels(first: 100')) {
      labelListCalls += 1;
      if (labelListCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            data: {
              repository: {
                labels: {
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                  nodes: Array.from({ length: 100 }, (_, i) => ({
                    id: `L${i}`,
                    name: `topic:page1-${i}`,
                  })),
                },
              },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              labels: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'L-huoshan', name: 'supplier:火山引擎' }],
              },
            },
          },
        }),
      };
    }

    throw new Error(`unexpected GraphQL query: ${query.slice(0, 80)}`);
  };

  try {
    process.env.COMMUNITY_CRAWLER_TOKEN = process.env.COMMUNITY_CRAWLER_TOKEN || 'test-token';
    const cache = new Map();
    const labelId = await ensureLabel(cache, 'supplier:火山引擎');
    assert.equal(labelId, 'L-huoshan');
    assert.equal(labelListCalls, 2);
    assert.equal(cache.get('supplier:火山引擎'), 'L-huoshan');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ensureLabel reuses existing label when create returns already taken', async () => {
  const originalFetch = global.fetch;
  let createCalls = 0;
  let lookupCalls = 0;

  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const query = body.query || '';

    if (query.includes('labels(first: 100')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              labels: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        }),
      };
    }

    if (query.includes('mutation CreateLabel') || query.includes('createLabel')) {
      createCalls += 1;
      return {
        ok: true,
        json: async () => ({
          errors: [{ message: 'Name has already been taken' }],
        }),
      };
    }

    if (query.includes('label(name:') || query.includes('$labelName')) {
      lookupCalls += 1;
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              label: { id: 'L-existing', name: 'supplier:火山引擎' },
            },
          },
        }),
      };
    }

    if (query.includes('repository(owner:') && query.includes('id')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: { id: 'R_repo' },
          },
        }),
      };
    }

    throw new Error(`unexpected GraphQL query: ${query.slice(0, 120)}`);
  };

  try {
    process.env.COMMUNITY_CRAWLER_TOKEN = process.env.COMMUNITY_CRAWLER_TOKEN || 'test-token';
    const cache = new Map();
    const labelId = await ensureLabel(cache, 'supplier:火山引擎');
    assert.equal(labelId, 'L-existing');
    assert.equal(createCalls, 1);
    assert.equal(lookupCalls, 1);
    assert.equal(cache.get('supplier:火山引擎'), 'L-existing');
  } finally {
    global.fetch = originalFetch;
  }
});

