#!/usr/bin/env node
"use strict";

/**
 * Setup Discussion categories and migrate existing discussions to appropriate ones.
 *
 * Categories:
 *   📢 Announcements   — 维护者公告、规范说明
 *   🗞️ 社区资讯        — 爬虫抓取的社区讨论
 *   ⚡ 使用体验         — 套餐使用评测、避雷、对比
 *   💡 经验分享         — API Key 分享、使用技巧
 *
 * Classification rules:
 *   - Body contains "由社区爬虫自动生成" → 社区资讯
 *   - Title contains "避雷" or "卡慢" or "怎么样" → 使用体验
 *   - Title contains "分享" or "apikey" or "API Key" → 经验分享
 *   - Title contains "公告" or "规范" or "tag" → Announcements
 *   - Default → 社区资讯
 *
 * Usage:
 *   node ./scripts/crawler/setup-discussion-categories.js              # dry-run
 *   node ./scripts/crawler/setup-discussion-categories.js --apply      # apply changes
 */

const { loadEnvFileIfPresent } = require("../crawler/env");
const {
  graphql,
  getRepoId,
  REPO_OWNER,
  REPO_NAME,
} = require("../crawler/github-discussion");

// ─── Category definitions ───

const CATEGORIES = [
  {
    name: "Announcements",
    emoji: ":mega:",
    description: "维护者公告、规范说明",
    // Keep existing — do not recreate
    isExisting: true,
  },
  {
    name: "社区资讯",
    emoji: ":newspaper:",
    description: "来自社区的 coding plan 讨论与资讯",
  },
  {
    name: "使用体验",
    emoji: ":zap:",
    description: "套餐使用评测、避雷、对比",
  },
  {
    name: "经验分享",
    emoji: ":bulb:",
    description: "API Key 分享、使用技巧与资源",
  },
];

// ─── Classification rules ───

function classifyDiscussion(discussion) {
  const { title, body } = discussion;
  const t = (title || "").toLowerCase();
  const b = body || "";

  // Crawler-generated → 社区资讯
  // Note: early versions had truncated watermark "由社厨虫动生成"
  if (b.includes("由社区爬虫自动生成") || b.includes("由社厨虫动生成")) {
    return "社区资讯";
  }

  // Announcements: meta posts about how to post
  if (/公告|规范|tag|发帖/.test(t)) {
    return "Announcements";
  }

  // 经验分享: API key sharing, tips
  if (/分享|apikey|api.?key|lite.?plan/i.test(t)) {
    return "经验分享";
  }

  // 使用体验: reviews, warnings, comparisons
  if (/避雷|卡慢|怎么样|评测|体验|对比|排队|限制|抢不到/.test(t)) {
    return "使用体验";
  }

  // Default for non-crawler posts
  return "使用体验";
}

// ─── GraphQL helpers ───

async function fetchExistingCategories() {
  const data = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussionCategories(first: 20) {
          nodes { id name emoji description }
        }
      }
    }`,
    { owner: REPO_OWNER, name: REPO_NAME },
  );
  return data.repository.discussionCategories.nodes;
}

async function createCategory(repoId, name, emoji, description) {
  // GitHub GraphQL API does not support createDiscussionCategory mutation.
  // Categories must be created via the GitHub Web UI.
  throw new Error(
    `Cannot create category "${name}" via GraphQL API. ` +
    `Please create it manually at https://github.com/${REPO_OWNER}/${REPO_NAME}/discussions/categories/new`,
  );
}

async function fetchAllDiscussions() {
  const discussions = [];
  let cursor = null;

  while (true) {
    const data = await graphql(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 100, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              number
              title
              body
              category { id name }
            }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME, after: cursor },
    );

    const page = data.repository.discussions;
    discussions.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return discussions;
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

// ─── Main ───

async function main() {
  const apply = process.argv.includes("--apply");

  console.log("[setup-categories] loading environment...");
  await loadEnvFileIfPresent();

  if (!process.env.COMMUNITY_CRAWLER_TOKEN) {
    console.error("[setup-categories] COMMUNITY_CRAWLER_TOKEN not set, exiting");
    process.exit(1);
  }

  // 1. Fetch existing categories
  const existingCategories = await fetchExistingCategories();
  const categoryMap = new Map(existingCategories.map((c) => [c.name, c]));
  console.log(`[setup-categories] existing categories: ${[...categoryMap.keys()].join(", ")}`);

  // 2. Verify all required categories exist
  for (const cat of CATEGORIES) {
    if (categoryMap.has(cat.name)) {
      console.log(`[setup-categories]   ✓ "${cat.name}" exists`);
      continue;
    }

    console.error(
      `[setup-categories]   ✗ "${cat.name}" not found! ` +
      `Create it at: https://github.com/${REPO_OWNER}/${REPO_NAME}/discussions/categories/new`,
    );
    if (apply) process.exit(1);
  }

  // 3. Fetch all discussions
  console.log("[setup-categories] fetching discussions...");
  const discussions = await fetchAllDiscussions();
  console.log(`[setup-categories] found ${discussions.length} discussions`);

  // 4. Classify and plan migrations
  const migrations = [];
  for (const d of discussions) {
    const targetCategory = classifyDiscussion(d);
    const currentCategory = d.category?.name ?? "";
    if (currentCategory === targetCategory) continue;
    migrations.push({
      number: d.number,
      title: d.title,
      id: d.id,
      from: currentCategory,
      to: targetCategory,
    });
  }

  if (migrations.length === 0) {
    console.log("[setup-categories] all discussions already in correct categories");
    return;
  }

  console.log(`\n[setup-categories] ${migrations.length} discussion(s) need reclassification:\n`);
  for (const m of migrations) {
    console.log(`  #${String(m.number).padStart(2)}  ${m.from} → ${m.to}  "${m.title.slice(0, 55)}"`);
  }

  if (!apply) {
    console.log("\n[setup-categories] dry-run mode — no changes applied");
    console.log("[setup-categories] re-run with --apply to create categories and migrate discussions");
    return;
  }

  // 5. Apply migrations
  console.log(`\n[setup-categories] applying ${migrations.length} migration(s)...`);
  let migrated = 0;
  let failed = 0;

  for (const m of migrations) {
    const targetCat = categoryMap.get(m.to);
    if (!targetCat) {
      console.error(`[setup-categories]   #${m.number} skipped: category "${m.to}" not found`);
      failed++;
      continue;
    }

    try {
      await updateDiscussionCategory(m.id, targetCat.id);
      console.log(`[setup-categories]   ✓ #${m.number} → ${m.to}`);
      migrated++;
    } catch (error) {
      console.error(`[setup-categories]   ✗ #${m.number} failed: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n[setup-categories] done: ${migrated} migrated, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[setup-categories] fatal:", error);
    process.exit(1);
  });
}

module.exports = { classifyDiscussion, CATEGORIES };
