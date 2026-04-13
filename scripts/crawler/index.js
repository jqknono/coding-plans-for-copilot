#!/usr/bin/env node

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const { loadEnvFileIfPresent } = require("./env");
const { matchesKeywords } = require("./keywords");
const { fetchV2exPosts, fetchRepliesForPosts } = require("./sources/v2ex");
const { fetchLinuxDoPosts } = require("./sources/linuxdo");
const { analyzePosts, setAvailableCategories } = require("./analyzer");
const { createDiscussionForPost, getDiscussionCategories } = require("./github-discussion");

const DISCUSSIONS_DIR = path.resolve(__dirname, "..", "..", "assets", "discussions");
const RELEVANCE_THRESHOLD = Number.parseFloat(
  process.env.CRAWLER_RELEVANCE_THRESHOLD || "0.7"
);

function printUsage() {
  console.log(`Usage: node scripts/crawler/index.js [options]

Options:
  --source=v2ex       Only crawl V2EX
  --source=linuxdo    Only crawl Linux.do
  --days=N            Only collect posts from the last N days (default: 1)
  --discussion        Publish to GitHub Discussions (default: dry-run, local only)
  (no flag)           Show this help message

Environment variables (required):
  APIKEY              LLM API key
  BASE_URL            LLM API base URL
  MODEL               LLM model name
  COMMUNITY_CRAWLER_TOKEN        GitHub token (required only with --discussion)

Mode:
  By default the crawler runs in dry-run mode: it fetches posts, analyzes
  them with LLM, and writes results to assets/discussions/ only.
  Use --discussion to also publish relevant posts as GitHub Discussions.

Examples:
  npm run crawler:run              # dry-run (local only)
  npm run crawler:run:publish      # publish to Discussions
  npm run crawler:v2ex             # dry-run V2EX only
  npm run crawler:linuxdo          # dry-run Linux.do only
`);
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const sourceArg = args.find((a) => a.startsWith("--source="));
  const daysArg = args.find((a) => a.startsWith("--days="));
  const discussion = args.includes("--discussion");
  return {
    source: sourceArg ? sourceArg.split("=")[1] : null,
    days: daysArg ? Number.parseInt(daysArg.split("=")[1], 10) : 1,
    discussion,
  };
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function summarizeAnalysisOutcomes(analysisResults, relevanceThreshold) {
  const summary = {
    totalAnalyzed: analysisResults.length,
    selected: 0,
    analysisErrors: 0,
    notCodingPlan: 0,
    notRelevant: 0,
    belowThreshold: 0,
  };

  for (const { analysis } of analysisResults) {
    if (analysis.analysisError) {
      summary.analysisErrors += 1;
      continue;
    }

    if (!analysis.isCodingPlan) {
      summary.notCodingPlan += 1;
      continue;
    }

    if (!analysis.isRelevant) {
      summary.notRelevant += 1;
      continue;
    }

    if (analysis.relevance < relevanceThreshold) {
      summary.belowThreshold += 1;
      continue;
    }

    summary.selected += 1;
  }

  return summary;
}

async function main() {
  const { source: sourceFilter, days, discussion: publishDiscussions } = parseArgs();

  console.log(`[crawler] mode: ${publishDiscussions ? "\x1b[36mpublish\x1b[0m" : "\x1b[33mdry-run\x1b[0m"}`);
  console.log("[crawler] loading environment...");
  await loadEnvFileIfPresent();

  // Check required environment variables
  const missing = [];
  if (!process.env.APIKEY) missing.push("APIKEY");
  if (!process.env.BASE_URL) missing.push("BASE_URL");
  if (!process.env.MODEL) missing.push("MODEL");
  if (missing.length > 0) {
    console.error(`\x1b[31m❌ [crawler] missing required environment variables: ${missing.join(", ")}\x1b[0m`);
    printUsage();
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();
  const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(`[crawler] date filter: posts since ${cutoffTime.toISOString()} (${days} day${days > 1 ? "s" : ""})`);
  const failures = [];

  // Phase 1: Fetch posts from sources
  let allPosts = [];

  if (!sourceFilter || sourceFilter === "v2ex") {
    try {
      const v2exPosts = await fetchV2exPosts({ failures });
      allPosts = allPosts.concat(v2exPosts);
    } catch (error) {
      failures.push(`v2ex: ${error.message}`);
      console.warn(`\x1b[33m⚠️ [crawler] v2ex fetch failed: ${error.message}\x1b[0m`);
    }
  }

  if (!sourceFilter || sourceFilter === "linuxdo") {
    try {
      const linuxDoPosts = await fetchLinuxDoPosts({ failures });
      allPosts = allPosts.concat(linuxDoPosts);
    } catch (error) {
      failures.push(`linuxdo: ${error.message}`);
      console.warn(`\x1b[33m⚠️ [crawler] linuxdo fetch failed: ${error.message}\x1b[0m`);
    }
  }

  console.log(`[crawler] total posts fetched: ${allPosts.length}`);

  // Phase 2: Filter by keywords
  const filtered = allPosts.filter(
    (post) => matchesKeywords(post.title) || matchesKeywords(post.content)
  );
  console.log(`[crawler] posts matching keywords: ${filtered.length}`);

  // Phase 2.1: Filter by date
  const dateFiltered = filtered.filter((post) => {
    if (!post.createdAt) return true; // keep posts without timestamp
    return new Date(post.createdAt) >= cutoffTime;
  });
  console.log(`[crawler] posts within last ${days} day${days > 1 ? "s" : ""}: ${dateFiltered.length} (filtered out ${filtered.length - dateFiltered.length} older posts)`);

  if (dateFiltered.length === 0) {
    console.log("[crawler] no matching posts found, writing empty output");
    await writeOutput(generatedAt, sourceFilter, [], failures);
    return;
  }

  // Phase 2.5: Fetch replies for V2EX posts
  const v2exFiltered = dateFiltered.filter((p) => p.source === "v2ex");
  if (v2exFiltered.length > 0) {
    console.log(`[crawler] fetching replies for ${v2exFiltered.length} V2EX posts...`);
    await fetchRepliesForPosts(v2exFiltered, failures);
  }

  // Phase 3: Analyze with LLM
  // Fetch discussion categories for LLM category recommendation
  let categories = [];
  if (publishDiscussions) {
    try {
      categories = await getDiscussionCategories();
      console.log(`[crawler] available categories: ${categories.map((c) => c.name).join(", ")}`);
    } catch (error) {
      console.warn(`\x1b[33m⚠️ [crawler] failed to fetch categories: ${error.message}\x1b[0m`);
    }
  }
  setAvailableCategories(categories);

  console.log("[crawler] analyzing posts with LLM...");
  const analysisResults = await analyzePosts(dateFiltered);
  const analysisSummary = summarizeAnalysisOutcomes(
    analysisResults,
    RELEVANCE_THRESHOLD,
  );
  console.log(
    `[crawler] analysis summary: selected=${analysisSummary.selected}, ` +
      `analysisErrors=${analysisSummary.analysisErrors}, ` +
      `notCodingPlan=${analysisSummary.notCodingPlan}, ` +
      `notRelevant=${analysisSummary.notRelevant}, ` +
      `belowThreshold=${analysisSummary.belowThreshold}`,
  );

  // Phase 4: Filter relevant posts and create Discussions
  const relevantPosts = [];
  const supplierMentions = {};

  for (const { post, analysis } of analysisResults) {
    if (analysis.analysisError) {
      failures.push(`analysis failed for ${post.id}: ${analysis.error}`);
      continue;
    }

    if (analysis.isCodingPlan && analysis.isRelevant && analysis.relevance >= RELEVANCE_THRESHOLD) {
      // Track supplier mentions
      if (analysis.supplier) {
        supplierMentions[analysis.supplier] = (supplierMentions[analysis.supplier] || 0) + 1;
      }

      // Create GitHub Discussion (only in publish mode)
      let discussionUrl = null;
      if (publishDiscussions) {
        try {
          discussionUrl = await createDiscussionForPost(post, analysis, generatedAt, categories);
        } catch (error) {
          failures.push(`discussion creation failed for ${post.id}: ${error.message}`);
        }
      }

      relevantPosts.push({
        id: post.id,
        source: post.source,
        sourceUrl: post.url,
        title: post.title,
        content: stripTags(post.content).slice(0, 500),
        author: post.author,
        createdAt: post.createdAt,
        analysis,
        discussionUrl,
        analyzedAt: new Date().toISOString(),
      });
    }
  }

  console.log(`[crawler] relevant posts: ${relevantPosts.length}`);
  console.log(`[crawler] supplier mentions: ${JSON.stringify(supplierMentions)}`);
  if (relevantPosts.length === 0 && analysisResults.length > 0) {
    console.warn(
      "[crawler] no posts selected for discussion creation; " +
        `selected=${analysisSummary.selected}, ` +
        `analysisErrors=${analysisSummary.analysisErrors}, ` +
        `notCodingPlan=${analysisSummary.notCodingPlan}, ` +
        `notRelevant=${analysisSummary.notRelevant}, ` +
        `belowThreshold=${analysisSummary.belowThreshold}`,
    );
  }

  // Phase 5: Write output to date-partitioned files
  await writeOutput(generatedAt, sourceFilter, relevantPosts, failures, supplierMentions, allPosts.length, dateFiltered.length);

  // Phase 5.5: Save new discussions to the same date-partitioned files
  const newDiscussions = relevantPosts.filter((p) => p.discussionUrl);
  if (newDiscussions.length > 0) {
    await writeNewDiscussions(newDiscussions, generatedAt);
  }
}

async function writeOutput(generatedAt, sourceFilter, posts, failures, supplierMentions = {}, totalFetched = 0, afterFilter = 0) {
  const sources = sourceFilter ? [sourceFilter] : ["v2ex", "linuxdo"];
  const sentimentMap = { positive: "正面", negative: "负面", neutral: "中性" };

  // Group posts by createdAt date
  const byDate = new Map();
  for (const post of posts) {
    const dateStr = post.createdAt
      ? new Date(post.createdAt).toISOString().slice(0, 10)
      : "unknown";
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(post);
  }

  await fs.mkdir(DISCUSSIONS_DIR, { recursive: true });

  for (const [dateStr, dayPosts] of byDate) {
    const filePath = path.join(DISCUSSIONS_DIR, `${dateStr}.json`);

    // Load existing file if present (append mode)
    let existing = [];
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      existing = parsed.posts || [];
    } catch {
      // file does not exist yet
    }

    const existingIds = new Set(existing.map((p) => p.id));

    for (const post of dayPosts) {
      if (existingIds.has(post.id)) continue;
      existing.push(post);
    }

    const output = {
      date: dateStr,
      generatedAt,
      config: {
        sources,
        keywords: ["套餐", "coding", "plan"],
        llmModel: process.env.MODEL || "openrouter/free",
        relevanceThreshold: RELEVANCE_THRESHOLD,
      },
      summary: {
        totalPostsFetched: totalFetched,
        postsAfterKeywordFilter: afterFilter,
        relevantPosts: existing.length,
        discussionsCreated: existing.filter((p) => p.discussionUrl).length,
        discussionsSkipped: existing.filter((p) => !p.discussionUrl).length,
        supplierMentions,
      },
      posts: existing,
      failures,
    };

    await fs.writeFile(filePath, JSON.stringify(output, null, 2), "utf8");
    console.log(`[crawler] ${existing.length} posts written to ${filePath}`);
  }
}

async function writeNewDiscussions(posts, generatedAt) {
  const sentimentMap = { positive: "正面", negative: "负面", neutral: "中性" };

  // Group by post createdAt date (YYYY-MM-DD)
  const byDate = new Map();
  for (const post of posts) {
    const dateStr = post.createdAt
      ? new Date(post.createdAt).toISOString().slice(0, 10)
      : "unknown";
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(post);
  }

  for (const [dateStr, dayPosts] of byDate) {
    const filePath = path.join(DISCUSSIONS_DIR, `${dateStr}.json`);

    // Load existing file
    let existing = [];
    let existingOutput = {};
    try {
      const raw = await fs.readFile(filePath, "utf8");
      existingOutput = JSON.parse(raw);
      existing = existingOutput.posts || [];
    } catch {
      // file does not exist yet
    }

    const existingUrls = new Set(existing.map((d) => d.discussionUrl).filter(Boolean));

    for (const post of dayPosts) {
      const idx = existing.findIndex((p) => p.id === post.id);
      if (idx >= 0) {
        // Update discussionUrl on existing post
        existing[idx].discussionUrl = post.discussionUrl;
      }
    }

    existingOutput.posts = existing;
    existingOutput.summary.discussionsCreated = existing.filter((p) => p.discussionUrl).length;
    existingOutput.summary.discussionsSkipped = existing.filter((p) => !p.discussionUrl).length;

    await fs.writeFile(filePath, JSON.stringify(existingOutput, null, 2), "utf8");
    console.log(`[crawler] updated discussion URLs in ${filePath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\x1b[31m💥 [crawler] fatal:\x1b[0m", error);
    process.exit(1);
  });
}

module.exports = { main, summarizeAnalysisOutcomes };
