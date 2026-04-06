#!/usr/bin/env node
"use strict";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 15_000;

const REPO_OWNER = "jqknono";
const REPO_NAME = "coding-plans-for-copilot";

async function graphql(query, variables = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN not configured");
  }

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub GraphQL HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  if (data.errors) {
    const messages = data.errors.map((e) => e.message).join("; ");
    throw new Error(messages);
  }
  return data.data;
}

async function getRepoId() {
  const data = await graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }`,
    { owner: REPO_OWNER, name: REPO_NAME },
  );
  return data.repository.id;
}

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

async function findExistingDiscussion(sourceUrl) {
  try {
    const data = await graphql(
      `query($owner: String!, $name: String!, $query: String!) {
        repository(owner: $owner, name: $name) {
          discussions(first: 5, searchQuery: $query, orderBy: {field: CREATED_AT, direction: DESC}) {
            nodes { id title url }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME, query: sourceUrl },
    );
    const discussions = data.repository.discussions.nodes;
    return discussions.length > 0 ? discussions[0] : null;
  } catch {
    return null;
  }
}

async function createDiscussion(repoId, categoryId, title, body) {
  const data = await graphql(
    `mutation CreateDiscussion($input: CreateDiscussionInput!) {
      createDiscussion(input: $input) {
        discussion { id number title url }
      }
    }`,
    { input: { repositoryId: repoId, categoryId, title, body } },
  );
  return data.createDiscussion.discussion;
}

// ─── Label helpers ───

function labelColor(name) {
  if (name.startsWith("supplier:")) return "0075ca";   // blue
  if (name.startsWith("sentiment:")) return "e99695";  // pink
  if (name.startsWith("lang:")) return "c5def5";       // light blue
  if (name.startsWith("topic:")) return "bfdadc";      // teal
  return "ededed";                                      // gray
}

async function ensureLabel(labelCache, tagName) {
  if (labelCache.has(tagName)) return labelCache.get(tagName);

  // Fetch existing labels on first miss
  if (labelCache.size === 0) {
    const data = await graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          labels(first: 100) { nodes { id name } }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME },
    );
    for (const l of data.repository.labels.nodes) {
      labelCache.set(l.name, l.id);
    }
    if (labelCache.has(tagName)) return labelCache.get(tagName);
  }

  try {
    const repoId = await getRepoId();
    const data = await graphql(
      `mutation CreateLabel($input: CreateLabelInput!) {
        createLabel(input: $input) {
          label { id name }
        }
      }`,
      { input: { repositoryId: repoId, name: tagName, color: labelColor(tagName) } },
    );
    const label = data.createLabel.label;
    labelCache.set(tagName, label.id);
    return label.id;
  } catch (error) {
    console.warn(`\x1b[33m⚠️ [github] cannot create label "${tagName}": ${error.message}\x1b[0m`);
    return null;
  }
}

async function addLabelsToDiscussion(discussionId, labelIds) {
  if (labelIds.length === 0) return;
  await graphql(
    `mutation AddLabels($labelableId: ID!, $labelIds: [ID!]!) {
      addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) {
        labelable { ... on Discussion { id } }
      }
    }`,
    { labelableId: discussionId, labelIds },
  );
}

// ─── Canonical label helpers ───

/**
 * Normalize a label segment: trim, collapse internal whitespace to single `-`, lowercase.
 * e.g. "coding plan" → "coding-plan", "GPT Plus" → "GPT-Plus"
 */
function normalizeLabelSegment(segment) {
  return segment.trim().replace(/\s+/g, "-");
}

/**
 * Build canonical label list from analysis.
 * Rules: trim, collapse whitespace to `-`, deduplicate.
 */
function buildCanonicalLabels(analysis) {
  const labels = new Set();
  if (analysis.supplier) labels.add(`supplier:${normalizeLabelSegment(analysis.supplier)}`);
  if (analysis.sentiment) labels.add(`sentiment:${analysis.sentiment}`);
  if (analysis.language) labels.add(`lang:${analysis.language}`);
  if (Array.isArray(analysis.topics)) {
    for (const topic of analysis.topics) {
      labels.add(`topic:${normalizeLabelSegment(topic)}`);
    }
  }
  return [...labels];
}

// ─── Read-back verification ───

async function verifyDiscussion(discussionNumber) {
  try {
    const data = await graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          discussion(number: $number) {
            category { name }
            body
            labels(first: 20) { nodes { name } }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME, number: discussionNumber },
    );
    const d = data.repository.discussion;
    return {
      category: d.category?.name ?? "",
      body: d.body ?? "",
      labels: d.labels.nodes,
    };
  } catch (error) {
    console.warn(`\x1b[33m⚠️ [github] verification query failed for #${discussionNumber}: ${error.message}\x1b[0m`);
    return null;
  }
}

// ─── Build body (no tag line — tags go to labels) ───

function buildDiscussionBody(post, analysis, generatedAt) {
  const maxContent = 4000;
  const content =
    post.content.length > maxContent
      ? post.content.slice(0, maxContent) + "..."
      : post.content;

  const sourceLabel = post.source === "v2ex" ? "V2EX" : "Linux.do";
  const sentimentMap = { positive: "正面", negative: "负面", neutral: "中性" };

  // Build replies section (max 10, each truncated to 300 chars)
  const replies = post.replies || [];
  const displayReplies = replies.slice(0, 10);
  const repliesSection = displayReplies.length > 0
    ? `## 评论 (${displayReplies.length})\n\n${displayReplies
        .map((r) => {
          const text = r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content;
          return `**${r.author}**: ${text}`;
        })
        .join("\n\n")}`
    : "*暂无评论*";

  return `> **来源**: [${sourceLabel}](${post.url})
> **作者**: ${post.author} | **发布时间**: ${post.createdAt}
> **供应商**: ${analysis.supplier || "未提及"} | **评价**: ${sentimentMap[analysis.sentiment] || analysis.sentiment}

## 摘要

${analysis.summary}

---

## 原帖内容

${content}

---

${repliesSection}

---

<sub>由社区爬虫自动生成于 ${generatedAt}</sub>`;
}

// ─── Main entry ───

async function createDiscussionForPost(post, analysis, generatedAt, categories) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("[github] GITHUB_TOKEN not set, skipping discussion creation");
    return null;
  }

  const existing = await findExistingDiscussion(post.url);
  if (existing) {
    console.log(`[github] discussion already exists for ${post.id}: ${existing.url}`);
    return existing.url;
  }

  const repoId = await getRepoId();
  if (!categories) {
    categories = await getDiscussionCategories();
  }

  // Pick category: use LLM-recommended category, fallback to first available
  let category = null;
  if (analysis.category) {
    category = categories.find(
      (c) => c.name === analysis.category || c.slug === analysis.category,
    );
  }
  if (!category && categories.length > 0) {
    category = categories[0];
    console.log(`\x1b[33m⚠️ [github] no matching category for "${analysis.category}", falling back to "${category.name}"\x1b[0m`);
  }
  if (!category) {
    console.error(`\x1b[31m❌ [github] no categories available in repository\x1b[0m`);
    return null;
  }
  console.log(`[github] using category: "${category.name}" (${category.slug})`);

  const sourceLabel = post.source === "v2ex" ? "V2EX" : "Linux.do";
  const title = `[${sourceLabel}] ${post.title}`;
  const body = buildDiscussionBody(post, analysis, generatedAt);

  try {
    const discussion = await createDiscussion(repoId, category.id, title, body);
    console.log(`[github] created discussion #${discussion.number}: ${discussion.url}`);

    // Add labels
    const tags = buildCanonicalLabels(analysis);
    if (tags.length > 0) {
      const labelCache = new Map();
      const labelIds = [];
      for (const tagName of tags) {
        const labelId = await ensureLabel(labelCache, tagName);
        if (!labelId) {
          throw new Error(`Failed to ensure label "${tagName}" — aborting discussion creation`);
        }
        labelIds.push(labelId);
      }
      if (labelIds.length > 0) {
        await addLabelsToDiscussion(discussion.id, labelIds);
        console.log(`[github] added ${labelIds.length} labels: ${tags.join(", ")}`);
      }
    }

    // Post-creation read-back verification
    const verified = await verifyDiscussion(discussion.number);
    if (verified) {
      if (verified.category !== category.name) {
        throw new Error(
          `Post-creation verification failed for #${discussion.number}: ` +
          `expected category "${category.name}", got "${verified.category}"`,
        );
      }
      const actualLabelNames = new Set(verified.labels.map((l) => l.name));
      const missingLabels = tags.filter((t) => !actualLabelNames.has(t));
      if (missingLabels.length > 0) {
        throw new Error(
          `Post-creation verification failed for #${discussion.number}: ` +
          `missing labels: ${missingLabels.join(", ")}`,
        );
      }
      if (verified.body.includes("**标签**")) {
        throw new Error(
          `Post-creation verification failed for #${discussion.number}: ` +
          `body still contains legacy tag line`,
        );
      }
      console.log(`[github] post-creation verification passed for #${discussion.number}`);
    }

    return discussion.url;
  } catch (error) {
    console.warn(`\x1b[31m❌ [github] failed to create discussion for ${post.id}: ${error.message}\x1b[0m`);
    return null;
  }
}

module.exports = {
  createDiscussionForPost,
  buildCanonicalLabels,
  normalizeLabelSegment,
  buildDiscussionBody,
  verifyDiscussion,
  graphql,
  getRepoId,
  getDiscussionCategories,
  ensureLabel,
  addLabelsToDiscussion,
  labelColor,
  REPO_OWNER,
  REPO_NAME,
};
