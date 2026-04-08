"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildCanonicalLabels,
  normalizeLabelSegment,
  buildDiscussionBody,
} = require("../../scripts/crawler/github-discussion");

const { removeTagLineFromBody } = require("../../scripts/discussions/migrate-discussion-labels");
const { buildExpectedState } = require("../../scripts/discussions/verify-discussion-labels");

const {
  validateAnalysis,
  parseAndValidateAnalysis,
  setAvailableCategories,
} = require("../../scripts/crawler/analyzer");

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
    path.resolve(__dirname, "..", "..", ".github", "workflows", "crawl-community-posts.yml"),
    "utf8",
  );
}

function loadPackageJson() {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"),
  );
}

// ─── normalizeLabelSegment ───

test("normalizeLabelSegment: trims whitespace", () => {
  assert.equal(normalizeLabelSegment("  pricing  "), "pricing");
});

test("normalizeLabelSegment: collapses internal spaces to single dash", () => {
  assert.equal(normalizeLabelSegment("coding plan"), "coding-plan");
});

test("normalizeLabelSegment: collapses multiple spaces to single dash", () => {
  assert.equal(normalizeLabelSegment("GPT   Plus"), "GPT-Plus");
});

test("normalizeLabelSegment: handles already-normalized input", () => {
  assert.equal(normalizeLabelSegment("pricing"), "pricing");
});

// ─── buildCanonicalLabels ───

test("buildCanonicalLabels: generates all label types", () => {
  const analysis = {
    supplier: "OpenAI",
    sentiment: "positive",
    language: "en",
    topics: ["pricing", "comparison"],
  };
  const labels = buildCanonicalLabels(analysis);
  assert.deepEqual(labels.sort(), [
    "lang:en",
    "sentiment:positive",
    "supplier:OpenAI",
    "topic:comparison",
    "topic:pricing",
  ]);
});

test("buildCanonicalLabels: normalizes topic with spaces", () => {
  const analysis = { topics: ["coding plan", "GPT Plus"] };
  const labels = buildCanonicalLabels(analysis);
  assert.ok(labels.includes("topic:coding-plan"));
  assert.ok(labels.includes("topic:GPT-Plus"));
});

test("buildCanonicalLabels: deduplicates identical labels", () => {
  const analysis = { topics: ["pricing", "pricing"] };
  const labels = buildCanonicalLabels(analysis);
  const pricingCount = labels.filter((l) => l === "topic:pricing").length;
  assert.equal(pricingCount, 1);
});

test("buildCanonicalLabels: handles empty analysis", () => {
  const labels = buildCanonicalLabels({});
  assert.equal(labels.length, 0);
});

test("buildCanonicalLabels: handles partial analysis", () => {
  const analysis = { sentiment: "neutral", language: "zh" };
  const labels = buildCanonicalLabels(analysis);
  assert.deepEqual(labels.sort(), ["lang:zh", "sentiment:neutral"]);
});

// ─── buildDiscussionBody ───

test("buildDiscussionBody: does not contain legacy tag line", () => {
  const post = {
    url: "https://example.com/post/1",
    source: "v2ex",
    author: "testuser",
    createdAt: "2025-01-01",
    content: "Test content",
    replies: [],
  };
  const analysis = {
    supplier: "TestSupplier",
    sentiment: "neutral",
    language: "zh",
    topics: ["pricing"],
    summary: "Test summary",
  };
  const body = buildDiscussionBody(post, analysis, "2025-01-01T00:00:00Z");
  assert.ok(!body.includes("**标签**"), "Body should not contain legacy tag line");
  assert.ok(!body.includes("标签:"), "Body should not contain legacy tag line variant");
});

test("buildDiscussionBody: contains expected sections", () => {
  const post = {
    url: "https://example.com/post/1",
    source: "linuxdo",
    author: "testuser",
    createdAt: "2025-01-01",
    content: "Test content",
    replies: [{ author: "replier", content: "Reply text" }],
  };
  const analysis = {
    supplier: "TestSupplier",
    sentiment: "positive",
    language: "en",
    topics: ["comparison"],
    summary: "A summary",
  };
  const body = buildDiscussionBody(post, analysis, "2025-01-01T00:00:00Z");
  assert.ok(body.includes("Linux.do"), "Should contain source label");
  assert.ok(body.includes("testuser"), "Should contain author");
  assert.ok(body.includes("TestSupplier"), "Should contain supplier");
  assert.ok(body.includes("A summary"), "Should contain summary");
  assert.ok(body.includes("Test content"), "Should contain content");
  assert.ok(body.includes("replier"), "Should contain reply author");
  assert.ok(body.includes("社区爬虫自动生成"), "Should contain generation marker");
});

// ─── removeTagLineFromBody ───

test("removeTagLineFromBody: removes legacy tag line", () => {
  const body = "Some intro\n> **标签**: supplier:OpenAI sentiment:neutral\nMore content";
  const cleaned = removeTagLineFromBody(body);
  assert.ok(!cleaned.includes("**标签**"), "Should remove tag line");
  assert.ok(cleaned.includes("Some intro"), "Should preserve other content");
  assert.ok(cleaned.includes("More content"), "Should preserve other content");
});

test("removeTagLineFromBody: returns body unchanged when no tag line", () => {
  const body = "Some intro\nMore content\nNo tags here";
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

test("validateAnalysis: passes valid complete analysis", () => {
  const obj = {
    isRelevant: true,
    isCodingPlan: true,
    relevance: 0.9,
    supplier: "OpenAI",
    supplierCategory: "international-provider",
    sentiment: "positive",
    sentimentConfidence: 0.8,
    summary: "A post about pricing",
    topics: ["pricing", "copilot"],
    planMentioned: "Pro",
    language: "en",
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test("validateAnalysis: passes valid minimal analysis", () => {
  const obj = {
    isRelevant: false,
    isCodingPlan: false,
    relevance: 0.1,
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test("validateAnalysis: rejects non-boolean isRelevant", () => {
  const errors = validateAnalysis({ isRelevant: "yes", isCodingPlan: true, relevance: 0.5 });
  assert.ok(errors.some((e) => e.includes("isRelevant")));
});

test("validateAnalysis: rejects out-of-range relevance", () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 1.5 });
  assert.ok(errors.some((e) => e.includes("relevance")));
});

test("validateAnalysis: rejects invalid sentiment", () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, sentiment: "happy" });
  assert.ok(errors.some((e) => e.includes("sentiment")));
});

test("validateAnalysis: rejects invalid language", () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, language: "fr" });
  assert.ok(errors.some((e) => e.includes("language")));
});

test("validateAnalysis: rejects non-array topics", () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, topics: "pricing" });
  assert.ok(errors.some((e) => e.includes("topics")));
});

test("validateAnalysis: rejects invalid supplierCategory", () => {
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.5, supplierCategory: "unknown" });
  assert.ok(errors.some((e) => e.includes("supplierCategory")));
});

test("validateAnalysis: accepts null optional fields", () => {
  const obj = {
    isRelevant: false,
    isCodingPlan: false,
    relevance: 0.2,
    supplier: null,
    supplierCategory: null,
    sentiment: "neutral",
    language: "zh",
  };
  assert.deepEqual(validateAnalysis(obj), []);
});

test("validateAnalysis: rejects missing isCodingPlan", () => {
  const errors = validateAnalysis({ isRelevant: true, relevance: 0.5 });
  assert.ok(errors.some((e) => e.includes("isCodingPlan")));
});

test("validateAnalysis: requires category when categories are configured", () => {
  setAvailableCategories([{ name: "社区资讯" }]);
  const errors = validateAnalysis({ isRelevant: true, isCodingPlan: true, relevance: 0.8 });
  assert.ok(errors.some((e) => e.includes("category")));
  setAvailableCategories([]);
});

// ─── parseAndValidateAnalysis ───

test("parseAndValidateAnalysis: parses valid JSON string", () => {
  const json = '{"isRelevant":true,"isCodingPlan":true,"relevance":0.8,"sentiment":"neutral","language":"zh"}';
  const result = parseAndValidateAnalysis(json);
  assert.equal(result.isRelevant, true);
  assert.equal(result.isCodingPlan, true);
  assert.equal(result.relevance, 0.8);
});

test("parseAndValidateAnalysis: throws on invalid JSON", () => {
  assert.throws(
    () => parseAndValidateAnalysis("not json at all"),
    /invalid JSON/,
  );
});

test("parseAndValidateAnalysis: throws on valid JSON but invalid schema", () => {
  const json = '{"isRelevant":"yes","relevance":0.5}';
  assert.throws(
    () => parseAndValidateAnalysis(json),
    /schema validation failed/,
  );
});

// ─── Workflow/package regression guards ───

test("workflow uses publish crawler command", () => {
  const workflow = loadWorkflowText();
  assert.match(workflow, /npm run crawler:run:publish/);
});

test("workflow migrates discussion labels before verification", () => {
  const workflow = loadWorkflowText();
  assert.match(
    workflow,
    /verify_discussions:[\s\S]*permissions:[\s\S]*discussions:\s*write[\s\S]*run:\s*npm run crawler:migrate-discussion-labels[\s\S]*run:\s*npm run crawler:verify-discussion-labels/,
  );
});

test("cleanup npm script stays in dry-run mode by default", () => {
  const pkg = loadPackageJson();
  assert.equal(
    pkg.scripts["crawler:cleanup-discussions"],
    "node ./scripts/discussions/cleanup-discussions.js",
  );
});

test("buildExpectedState preserves analysis category instead of hard-coding General", () => {
  const expected = buildExpectedState({
    analysis: {
      supplier: "OpenAI",
      sentiment: "neutral",
      language: "zh",
      topics: ["pricing"],
      category: "社区资讯",
    },
  });

  assert.equal(expected.expectedCategory, "社区资讯");
  assert.deepEqual(expected.labels.sort(), [
    "lang:zh",
    "sentiment:neutral",
    "supplier:OpenAI",
    "topic:pricing",
  ]);
});

// ─── Linux.do fallback regression ───

test("fetchLinuxDoPosts retries the same page after switching to Playwright", async () => {
  const originalFetch = global.fetch;
  const playwright = require("playwright");
  const originalLaunch = playwright.chromium.launch;

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("timeout");
  };

  playwright.chromium.launch = async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: async (url) => ({
          status: () => 200,
          text: async () => {
            if (url.includes("/latest.json")) {
              return JSON.stringify({
                topic_list: {
                  topics: [
                    {
                      id: 123,
                      title: "LinuxDo coding plan post",
                      excerpt: "coding plan",
                      slug: "linuxdo-coding-plan-post",
                      created_at: "2026-04-05T00:00:00.000Z",
                    },
                  ],
                },
              });
            }

            return JSON.stringify({
              post_stream: {
                posts: [
                  {
                    cooked: "<p>coding plan details</p>",
                    username: "tester",
                    created_at: "2026-04-05T00:00:00.000Z",
                  },
                ],
              },
            });
          },
        }),
      }),
      close: async () => {},
    }),
    close: async () => {},
  });

  try {
    const posts = await withEnv("CRAWLER_LINUXDO_PAGES", "1", async () => {
      const modulePath = require.resolve("../../scripts/crawler/sources/linuxdo");
      delete require.cache[modulePath];
      const { fetchLinuxDoPosts } = require("../../scripts/crawler/sources/linuxdo");
      return fetchLinuxDoPosts({ failures: [] });
    });

    assert.equal(fetchCalls, 1);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, "linuxdo-123");
  } finally {
    playwright.chromium.launch = originalLaunch;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../../scripts/crawler/sources/linuxdo")];
  }
});
