#!/usr/bin/env node
"use strict";

/**
 * One-time migration script for historical crawler Discussion labels.
 *
 * Two-phase approach:
 *   Phase 1: Process records from `assets/discussions/` that have
 *            `discussionUrl` + `analysis`. Labels come from analysis.
 *   Phase 2: Process all remaining online crawler discussions NOT covered
 *            by Phase 1. Labels are parsed from the legacy `**标签**:` body
 *            line (if present).
 *
 * For each discussion:
 *   - Add missing labels (diff against existing).
 *   - Remove legacy `**标签**:` line from body.
 *   - Fix category to "General" if currently something else.
 *   - Read-back verify after each migration.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const { loadEnvFileIfPresent } = require("../crawler/env");
const {
  graphql,
  getRepoId,
  ensureLabel,
  addLabelsToDiscussion,
  buildCanonicalLabels,
  labelColor,
  REPO_OWNER,
  REPO_NAME,
} = require("../crawler/github-discussion");

const DISCUSSIONS_DIR = path.resolve(__dirname, "..", "..", "assets", "discussions");

// ─── Helpers ───

function parseDiscussionNumber(url) {
  const match = url.match(/\/discussions\/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function removeTagLineFromBody(body) {
  return body.replace(/\n?> \*\*标签\*\*:[^\n]*\n?/, "\n");
}

/**
 * Parse labels from the legacy `**标签**:` line in discussion body.
 * Only used as fallback for historical discussions without analysis data.
 */
function parseTagsFromBody(body) {
  if (!body) return [];
  const tags = [];
  const tagLineMatch = body.match(/\*\*标签\*\*:\s*(.+)/);
  if (tagLineMatch) {
    const parts = tagLineMatch[1].trim().match(/(?:supplier|sentiment|lang|topic):[^\s]+/g) || [];
    tags.push(...parts);
  }
  return tags;
}

async function fetchDiscussion(discussionNumber) {
  const data = await graphql(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          id
          number
          title
          body
          category { name }
          labels(first: 20) { nodes { id name } }
        }
      }
    }`,
    { owner: REPO_OWNER, name: REPO_NAME, number: discussionNumber },
  );
  return data.repository.discussion;
}

async function updateDiscussionBody(discussionId, body) {
  await graphql(
    `mutation UpdateDiscussion($input: UpdateDiscussionInput!) {
      updateDiscussion(input: $input) {
        discussion { id }
      }
    }`,
    { input: { discussionId, body } },
  );
}

async function getRepoLabels() {
  const data = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        labels(first: 100) { nodes { id name } }
      }
    }`,
    { owner: REPO_OWNER, name: REPO_NAME },
  );
  return data.repository.labels.nodes;
}

// ─── Fetch all crawler discussions ───

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
              id
              number
              title
              body
              category { id name }
              labels(first: 20) { nodes { id name } }
            }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME, after: cursor },
    );

    const page = data.repository.discussions;
    for (const d of page.nodes) {
      if (d.body && d.body.includes("由社区爬虫自动生成")) {
        discussions.push(d);
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return discussions;
}

// ─── Category helpers ───

async function getDiscussionCategories() {
  const data = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussionCategories(first: 20) {
          nodes { id name slug }
        }
      }
    }`,
    { owner: REPO_OWNER, name: REPO_NAME },
  );
  return data.repository.discussionCategories.nodes;
}

async function updateDiscussionCategory(discussionId, categoryId) {
  await graphql(
    `mutation UpdateDiscussion($input: UpdateDiscussionInput!) {
      updateDiscussion(input: $input) {
        discussion { id }
      }
    }`,
    { input: { discussionId, categoryId } },
  );
}

// ─── Migrate a single discussion ───

async function migrateDiscussion(discussion, expectedLabels, labelCache, generalCategoryId) {
  const { number, id, body, category } = discussion;
  const existingLabelNames = new Set(
    (discussion.labels?.nodes || []).map((l) => l.name),
  );

  const missingLabels = expectedLabels.filter((l) => !existingLabelNames.has(l));
  const hasTagLine = body?.includes("**标签**") ?? false;
  const cleanedBody = hasTagLine ? removeTagLineFromBody(body) : null;
  const needsCategoryFix = category?.name !== "General" && generalCategoryId;

  if (missingLabels.length === 0 && !hasTagLine && !needsCategoryFix) {
    console.log(`[migrate-labels] #${number} already up-to-date, skipping`);
    return "skipped";
  }

  const changes = [];
  if (missingLabels.length > 0) changes.push(`labels: [${missingLabels.join(", ")}]`);
  if (hasTagLine) changes.push("remove tag line");
  if (needsCategoryFix) changes.push(`category: ${category?.name} → General`);

  console.log(
    `[migrate-labels] #${number} "${discussion.title?.slice(0, 50)}" → ${changes.join(", ")}`,
  );

  // Add missing labels
  if (missingLabels.length > 0) {
    const labelIds = [];
    for (const tagName of missingLabels) {
      const labelId = await ensureLabel(labelCache, tagName);
      if (!labelId) {
        throw new Error(`Failed to ensure label "${tagName}"`);
      }
      labelIds.push(labelId);
    }
    await addLabelsToDiscussion(id, labelIds);
    console.log(`[migrate-labels]   added ${labelIds.length} labels`);
  }

  // Fix category
  if (needsCategoryFix) {
    await updateDiscussionCategory(id, generalCategoryId);
    console.log(`[migrate-labels]   fixed category → General`);
  }

  // Remove legacy tag line from body
  if (cleanedBody) {
    await updateDiscussionBody(id, cleanedBody);
    console.log(`[migrate-labels]   removed tag line from body`);
  }

  // Read-back verification
  const verified = await fetchDiscussion(number);
  const verifiedLabelNames = new Set(
    (verified.labels?.nodes || []).map((l) => l.name),
  );
  const stillMissing = expectedLabels.filter((l) => !verifiedLabelNames.has(l));
  if (stillMissing.length > 0) {
    throw new Error(`Post-migration verification: still missing labels: ${stillMissing.join(", ")}`);
  }
  if (verified.body?.includes("**标签**")) {
    throw new Error("Post-migration verification: body still contains legacy tag line");
  }
  console.log(`[migrate-labels]   verification passed`);

  return "migrated";
}

// ─── Main ───

async function main() {
  console.log("[migrate-labels] loading environment...");
  await loadEnvFileIfPresent();

  if (!process.env.GITHUB_TOKEN) {
    console.error("[migrate-labels] GITHUB_TOKEN not set, exiting");
    process.exit(1);
  }

  // Load crawler output for Phase 1
  let crawlerData = null;
  try {
    crawlerData = await loadAllDiscussions();
  } catch {
    console.log("[migrate-labels] no discussions data, skipping Phase 1");
  }

  // Build analysis lookup: discussionNumber → analysis
  const analysisByNumber = new Map();
  if (crawlerData) {
    for (const post of crawlerData.posts || []) {
      if (post.discussionUrl && post.analysis) {
        const num = parseDiscussionNumber(post.discussionUrl);
        if (num) analysisByNumber.set(num, post.analysis);
      }
    }
  }
  console.log(`[migrate-labels] Phase 1: ${analysisByNumber.size} posts from discussions data`);

  // Build label cache from existing repo labels
  const existingLabels = await getRepoLabels();
  const labelCache = new Map(existingLabels.map((l) => [l.name, l.id]));
  console.log(`[migrate-labels] repo has ${labelCache.size} existing labels`);

  // Get General category ID for category fixes
  const categories = await getDiscussionCategories();
  const generalCategory = categories.find((c) => c.name === "General");
  const generalCategoryId = generalCategory?.id ?? null;
  if (!generalCategoryId) {
    console.warn("[migrate-labels] General category not found, cannot fix categories");
  }

  // Fetch all online crawler discussions
  console.log("[migrate-labels] fetching all crawler discussions...");
  const allDiscussions = await fetchAllCrawlerDiscussions();
  console.log(`[migrate-labels] found ${allDiscussions.length} crawler discussions online`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const discussion of allDiscussions) {
    const num = discussion.number;

    // Determine expected labels
    let expectedLabels;
    const analysis = analysisByNumber.get(num);
    if (analysis) {
      // Phase 1: use analysis from discussions data
      expectedLabels = buildCanonicalLabels(analysis);
    } else {
      // Phase 2: parse from legacy tag line in body
      expectedLabels = parseTagsFromBody(discussion.body);
    }

    try {
      const result = await migrateDiscussion(
        discussion, expectedLabels, labelCache, generalCategoryId,
      );
      if (result === "migrated") {
        migrated++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`[migrate-labels] #${num} migration failed: ${error.message}`);
      failed++;
    }
  }

  console.log(
    `\n[migrate-labels] done: ${migrated} migrated, ${skipped} skipped, ${failed} failed`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[migrate-labels] fatal:", error);
    process.exit(1);
  });
}

module.exports = { main, parseDiscussionNumber, removeTagLineFromBody, parseTagsFromBody, loadAllDiscussions };

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