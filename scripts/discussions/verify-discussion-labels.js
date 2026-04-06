#!/usr/bin/env node
"use strict";

/**
 * Read-only verification script for crawler Discussion labels.
 *
 * Usage:
 *   node scripts/discussions/verify-discussion-labels.js
 *   node scripts/discussions/verify-discussion-labels.js -- --discussion=29
 *   node scripts/discussions/verify-discussion-labels.js -- --all
 *
 * Without flags: verifies all discussions referenced in assets/discussions/.
 * --discussion=N: verify a single discussion by number.
 * --all: verify all crawler discussions in the repo (not just those in assets/discussions/).
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const { loadEnvFileIfPresent } = require("../crawler/env");
const {
  graphql,
  buildCanonicalLabels,
  verifyDiscussion,
  REPO_OWNER,
  REPO_NAME,
} = require("../crawler/github-discussion");

const DISCUSSIONS_DIR = path.resolve(__dirname, "..", "..", "assets", "discussions");

function parseArgs() {
  const args = process.argv.slice(2);
  const discussionArg = args.find((a) => a.startsWith("--discussion="));
  const allFlag = args.includes("--all");
  return {
    discussionNumber: discussionArg
      ? Number.parseInt(discussionArg.split("=")[1], 10)
      : null,
    all: allFlag,
  };
}

function parseDiscussionNumber(url) {
  const match = url.match(/\/discussions\/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function buildExpectedState(post) {
  return {
    labels: buildCanonicalLabels(post.analysis),
    expectedCategory:
      typeof post.analysis?.category === "string" && post.analysis.category.trim()
        ? post.analysis.category
        : null,
  };
}

async function fetchAllCrawlerDiscussions() {
  const discussions = [];
  let cursor = null;

  while (true) {
    const data = await graphql(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 50, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              body
              category { name }
              labels(first: 20) { nodes { name } }
            }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME, after: cursor },
    );

    const page = data.repository.discussions;
    for (const d of page.nodes) {
      // Only include crawler discussions
      if (d.body && d.body.includes("由社区爬虫自动生成")) {
        discussions.push(d);
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return discussions;
}

async function verifySingle(discussionNumber, expectedState = null) {
  const result = await verifyDiscussion(discussionNumber);
  if (!result) {
    console.error(`[verify] #${discussionNumber}: FAILED — could not fetch discussion`);
    return false;
  }

  const errors = [];

  // Check category only when we know which category the crawler intended.
  if (expectedState?.expectedCategory && result.category !== expectedState.expectedCategory) {
    errors.push(`category: expected "${expectedState.expectedCategory}", got "${result.category}"`);
  }

  // Check labels
  if (Array.isArray(expectedState?.labels)) {
    const actualLabelNames = new Set(result.labels.map((l) => l.name));
    const missing = expectedState.labels.filter((l) => !actualLabelNames.has(l));
    if (missing.length > 0) {
      errors.push(`missing labels: ${missing.join(", ")}`);
    }
  }

  // Check body for legacy tag line
  if (result.body.includes("**标签**")) {
    errors.push("body still contains legacy tag line");
  }

  if (errors.length === 0) {
    console.log(
      `[verify] #${discussionNumber}: PASS ` +
      `category="${result.category}" labels=[${result.labels.map((l) => l.name).join(", ")}]`,
    );
    return true;
  } else {
    console.error(`[verify] #${discussionNumber}: FAILED — ${errors.join("; ")}`);
    return false;
  }
}

async function main() {
  console.log("[verify] loading environment...");
  await loadEnvFileIfPresent();

  if (!process.env.COMMUNITY_CRAWLER_TOKEN) {
    console.error("[verify] COMMUNITY_CRAWLER_TOKEN not set, exiting");
    process.exit(1);
  }

  const { discussionNumber, all: allFlag } = parseArgs();

  // Single discussion mode
  if (discussionNumber) {
    // Try to find expected labels from discussions data
    let expectedState = null;
    try {
      const crawlerData = await loadAllDiscussions();
      for (const post of crawlerData.posts || []) {
        if (post.discussionUrl && post.analysis) {
          const num = parseDiscussionNumber(post.discussionUrl);
          if (num === discussionNumber) {
            expectedState = buildExpectedState(post);
            break;
          }
        }
      }
    } catch {
      // No discussions data — verify without expected labels
    }

    if (expectedState?.labels) {
      console.log(`[verify] expected labels for #${discussionNumber}: [${expectedState.labels.join(", ")}]`);
    }

    const ok = await verifySingle(discussionNumber, expectedState);
    process.exit(ok ? 0 : 1);
  }

  // Load discussions data for expected labels
  let crawlerData = null;
  try {
    crawlerData = await loadAllDiscussions();
  } catch {
    console.error("\x1b[31m❌ [verify] cannot read discussions data\x1b[0m");
    process.exit(1);
  }

  // Build lookup: discussionNumber → expected verification state
  const expectedByNumber = new Map();
  for (const post of crawlerData.posts || []) {
    if (post.discussionUrl && post.analysis) {
      const num = parseDiscussionNumber(post.discussionUrl);
      if (num) {
        expectedByNumber.set(num, buildExpectedState(post));
      }
    }
  }

  let discussions;
  if (allFlag) {
    console.log("[verify] fetching all crawler discussions from repo...");
    discussions = await fetchAllCrawlerDiscussions();
  } else {
    // Only verify discussions referenced in assets/discussions/
    discussions = [...expectedByNumber.keys()].map((num) => ({ number: num }));
  }

  console.log(`[verify] verifying ${discussions.length} discussions...\n`);

  let passed = 0;
  let failed = 0;

  for (const d of discussions) {
    const expected = expectedByNumber.get(d.number) || null;
    const ok = await verifySingle(d.number, expected);
    if (ok) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n[verify] results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[verify] fatal:", error);
    process.exit(1);
  });
}

module.exports = { verifySingle, parseDiscussionNumber, loadAllDiscussions, buildExpectedState };

async function loadAllDiscussions() {
  const allPosts = [];
  let dir;
  try {
    dir = await fs.readdir(DISCUSSIONS_DIR);
  } catch {
    return { posts: [] };
  }
  const jsonFiles = dir.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const file of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(DISCUSSIONS_DIR, file), "utf8");
      const data = JSON.parse(raw);
      if (data.posts) allPosts.push(...data.posts);
    } catch {
      // skip unreadable files
    }
  }
  return { posts: allPosts };
}
