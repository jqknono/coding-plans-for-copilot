#!/usr/bin/env node
"use strict";

/**
 * Cleanup script for Discussions that have no real community engagement.
 *
 * A discussion is considered "deletable" when ALL of the following are true:
 *   1. It has zero comments (replies).
 *   2. It is NOT pinned.
 *   3. It has NO labels.
 *
 * Usage:
 *   node ./scripts/crawler/cleanup-discussions.js              # dry-run (default)
 *   node ./scripts/crawler/cleanup-discussions.js --apply      # actually delete
 *   node ./scripts/crawler/cleanup-discussions.js --apply 3,7,12   # delete specific numbers
 *
 * In dry-run mode the script lists all deletable discussions and exits.
 * In --apply mode without numbers it prompts for a comma-separated selection.
 * In --apply mode with numbers it deletes those specific discussions.
 */

const { loadEnvFileIfPresent } = require("../crawler/env");
const {
  graphql,
  REPO_OWNER,
  REPO_NAME,
} = require("../crawler/github-discussion");

// ─── CLI parsing ───

function parseArgs(argv) {
  const args = { apply: false, numbers: [] };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") {
      args.apply = true;
    } else if (/^\d+(,\d+)*$/.test(arg)) {
      args.numbers = arg.split(",").map(Number);
    }
  }
  return args;
}

// ─── GraphQL helpers ───

async function fetchPinnedDiscussionNumbers() {
  try {
    const data = await graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          pinnedDiscussions(first: 10) {
            nodes { discussion { number } }
          }
        }
      }`,
      { owner: REPO_OWNER, name: REPO_NAME },
    );
    return new Set(data.repository.pinnedDiscussions.nodes.map((n) => n.discussion.number));
  } catch {
    return new Set();
  }
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
              comments { totalCount }
              labels(first: 20) { nodes { name } }
              category { name }
              createdAt
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

async function deleteDiscussion(id) {
  await graphql(
    `mutation DeleteDiscussion($input: DeleteDiscussionInput!) {
      deleteDiscussion(input: $input) {
        discussion { id }
      }
    }`,
    { input: { id } },
  );
}

// ─── Interactive selection ───

async function promptSelection(deletable) {
  console.log("");
  console.log("Enter discussion numbers to delete (comma-separated), or 'q' to cancel:");
  console.log("Example: 3,7,12");

  const { createInterface } = require("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed.toLowerCase() === "q" || trimmed === "") {
        resolve(null);
        return;
      }
      const numbers = trimmed
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      resolve(numbers);
    });
  });
}

// ─── Main ───

async function main() {
  const args = parseArgs(process.argv);

  console.log("[cleanup] loading environment...");
  await loadEnvFileIfPresent();

  if (!process.env.COMMUNITY_CRAWLER_TOKEN) {
    console.error("[cleanup] COMMUNITY_CRAWLER_TOKEN not set, exiting");
    process.exit(1);
  }

  console.log("[cleanup] fetching all discussions...");
  const pinnedNumbers = await fetchPinnedDiscussionNumbers();
  const allDiscussions = await fetchAllDiscussions();
  console.log(`[cleanup] found ${allDiscussions.length} discussions total (${pinnedNumbers.size} pinned)`);

  // Filter deletable: no comments, no labels, not pinned
  const deletable = allDiscussions.filter((d) => {
    const hasComments = d.comments?.totalCount > 0;
    const hasLabels = (d.labels?.nodes?.length ?? 0) > 0;
    const isPinned = pinnedNumbers.has(d.number);
    return !hasComments && !hasLabels && !isPinned;
  });

  if (deletable.length === 0) {
    console.log("[cleanup] no deletable discussions found");
    return;
  }

  console.log(`[cleanup] ${deletable.length} deletable discussion(s):\n`);

  // Display table
  const maxTitleLen = Math.min(
    Math.max(...deletable.map((d) => d.title.length)),
    60,
  );

  for (const d of deletable) {
    const num = String(d.number).padStart(3);
    const title = d.title.length > 60 ? d.title.slice(0, 57) + "..." : d.title.padEnd(maxTitleLen);
    const category = d.category?.name ?? "?";
    const date = new Date(d.createdAt).toISOString().slice(0, 10);
    console.log(`  #${num}  ${title}  [${category}]  ${date}`);
  }

  // Dry-run mode: just list and exit
  if (!args.apply) {
    console.log("");
    console.log("[cleanup] dry-run mode — no discussions were deleted");
    console.log("[cleanup] re-run with --apply to delete, e.g.:");
    const numbers = deletable.map((d) => d.number).join(",");
    console.log(`  node ./scripts/crawler/cleanup-discussions.js --apply ${numbers}`);
    return;
  }

  // Determine which to delete
  let selectedNumbers;
  if (args.numbers.length > 0) {
    selectedNumbers = args.numbers;
    console.log(`\n[cleanup] selected from args: ${selectedNumbers.join(", ")}`);
  } else {
    selectedNumbers = await promptSelection(deletable);
    if (!selectedNumbers || selectedNumbers.length === 0) {
      console.log("[cleanup] cancelled");
      return;
    }
  }

  // Validate selection
  const deletableMap = new Map(deletable.map((d) => [d.number, d]));
  const invalid = selectedNumbers.filter((n) => !deletableMap.has(n));
  if (invalid.length > 0) {
    console.warn(`[cleanup] warning: #${invalid.join(", #")} not in deletable list, skipping`);
  }

  const toDelete = selectedNumbers
    .filter((n) => deletableMap.has(n))
    .map((n) => deletableMap.get(n));

  if (toDelete.length === 0) {
    console.log("[cleanup] nothing to delete");
    return;
  }

  console.log(`\n[cleanup] deleting ${toDelete.length} discussion(s)...\n`);

  let deleted = 0;
  let failed = 0;

  for (const d of toDelete) {
    try {
      await deleteDiscussion(d.id);
      console.log(`[cleanup]   deleted #${d.number} "${d.title.slice(0, 50)}"`);
      deleted++;
    } catch (error) {
      console.error(`[cleanup]   failed #${d.number}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n[cleanup] done: ${deleted} deleted, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[cleanup] fatal:", error);
    process.exit(1);
  });
}

module.exports = { parseArgs, fetchAllDiscussions };
