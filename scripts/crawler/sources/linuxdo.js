#!/usr/bin/env node
"use strict";

const LINUXDO_BASE = "https://linux.do";
const REQUEST_TIMEOUT_MS = 20_000;
const DELAY_MS = Number.parseInt(process.env.CRAWLER_LINUXDO_DELAY_MS || "500", 10);
const TIMELINE_PAGES = Number.parseInt(process.env.CRAWLER_LINUXDO_PAGES || "5", 10);

const COMMON_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  accept: "application/json",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTopic(raw) {
  return {
    id: `linuxdo-${raw.id}`,
    source: "linuxdo",
    title: raw.title || raw.name || "",
    content: stripTags(raw.excerpt || raw.description || raw.blurb || ""),
    url: raw.slug ? `${LINUXDO_BASE}/t/${raw.slug}/${raw.id}` : `${LINUXDO_BASE}/t/${raw.id}`,
    author: "",
    createdAt: raw.created_at || "",
    rawApiData: raw,
  };
}

// ─── Direct fetch (fast, but Cloudflare may block) ───
async function fetchJsonDirect(url) {
  try {
    const headers = { ...COMMON_HEADERS };
    if (process.env.LINUX_DO_API_KEY) {
      headers["Api-Key"] = process.env.LINUX_DO_API_KEY;
      headers["Api-Username"] = process.env.LINUX_DO_API_USERNAME || "system";
    }
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "").then((t) => t.slice(0, 120));
      console.log(`[linuxdo] direct fetch ${url} → HTTP ${response.status} "${body}"`);
      return { ok: false, blocked: response.status === 403, status: response.status };
    }
    const data = await response.json();
    const topicCount = data?.topic_list?.topics?.length ?? "??";
    console.log(`[linuxdo] direct fetch OK → ${topicCount} topics`);
    return { ok: true, data };
  } catch (error) {
    console.log(`[linuxdo] direct fetch ${url} → error: ${error.message}`);
    return { ok: false, error: true };
  }
}

// ─── Playwright fallback (bypasses Cloudflare) ───
let _browser = null;

async function getPlaywrightBrowser() {
  try {
    const { chromium } = require("playwright");
    if (!_browser) {
      console.log("[linuxdo] launching Playwright (headless chromium)...");
      _browser = await chromium.launch({ headless: true });
    }
    return _browser;
  } catch {
    console.warn("[linuxdo] Playwright not available, run: npx playwright install chromium");
    return null;
  }
}

async function fetchJsonViaPlaywright(url) {
  const browser = await getPlaywrightBrowser();
  if (!browser) return { ok: false };

  try {
    const context = await browser.newContext({
      userAgent: COMMON_HEADERS["user-agent"],
    });
    const page = await context.newPage();

    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: REQUEST_TIMEOUT_MS,
    });

    const status = response.status();
    if (status !== 200) {
      const body = await response.text().catch(() => "").then((t) => t.slice(0, 120));
      console.log(`[linuxdo] playwright ${url} → HTTP ${status} "${body}"`);
      await context.close();
      return { ok: false, status };
    }

    const text = await response.text();
    await context.close();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.log(`[linuxdo] playwright ${url} → response not JSON (Cloudflare challenge page)`);
      return { ok: false, status: "non-json" };
    }

    const topicCount = data?.topic_list?.topics?.length ?? "??";
    console.log(`[linuxdo] playwright OK → ${topicCount} topics`);
    return { ok: true, data };
  } catch (error) {
    console.log(`[linuxdo] playwright ${url} → error: ${error.message}`);
    return { ok: false, error: true, message: error.message };
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ─── Unified fetch ───
async function fetchJson(url, failures, usePlaywright) {
  let result;

  if (usePlaywright) {
    result = await fetchJsonViaPlaywright(url);
  } else {
    result = await fetchJsonDirect(url);
    if (!result.ok && result.blocked) {
      console.log("[linuxdo] direct blocked by Cloudflare, retrying with Playwright...");
      result = await fetchJsonViaPlaywright(url);
    }
  }

  if (!result.ok) {
    failures.push(`linuxdo: ${url} → ${result.status || result.message || "failed"}`);
    return null;
  }
  return result.data;
}

// ─── Topic detail (includes replies) ───
async function fetchTopicDetail(topicId, failures, usePlaywright) {
  const url = `${LINUXDO_BASE}/t/${topicId}.json`;
  const data = await fetchJson(url, failures, usePlaywright);
  if (!data) return null;

  const allPosts = data.post_stream?.posts || [];
  const firstPost = allPosts[0];
  const replies = [];
  for (let i = 1; i < allPosts.length; i++) {
    replies.push({
      author: allPosts[i].username || "",
      content: stripTags(allPosts[i].cooked || ""),
      createdAt: allPosts[i].created_at || "",
      likes: allPosts[i].like_count || 0,
    });
  }

  return {
    content: stripTags(firstPost?.cooked || ""),
    author: firstPost?.username || "",
    replies,
  };
}

// ─── Main entry ───
async function fetchLinuxDoPosts(options = {}) {
  const failures = options.failures || [];
  const posts = new Map();
  const { matchesKeywords } = require("../keywords");

  let usePlaywright = false;

  for (let page = 0; page < TIMELINE_PAGES; page++) {
    const url = `${LINUXDO_BASE}/latest.json${page > 0 ? `?page=${page}` : ""}`;
    console.log(`[linuxdo] --- timeline page ${page + 1}/${TIMELINE_PAGES}: ${url} ---`);

    const data = await fetchJson(url, failures, usePlaywright);

    if (!data && !usePlaywright) {
      usePlaywright = true;
      console.log("[linuxdo] switching to Playwright for remaining pages");
      page -= 1;
      continue;
    }

    const topics = data?.topic_list?.topics;
    if (!topics || topics.length === 0) {
      console.log(`[linuxdo] page ${page + 1} returned no topics, stopping`);
      break;
    }

    const matched = [];
    for (const topic of topics) {
      const normalized = normalizeTopic(topic);
      if (matchesKeywords(normalized.title) || matchesKeywords(normalized.content)) {
        if (!posts.has(topic.id)) {
          posts.set(topic.id, normalized);
          matched.push(normalized.title.slice(0, 40));
        }
      }
    }
    if (matched.length) {
      console.log(`[linuxdo] page ${page + 1} matched ${matched.length}: ${matched.join(" | ")}`);
    }

    await sleep(DELAY_MS);
  }

  // Fetch detail & replies for all matching posts
  const result = [...posts.values()];
  for (const post of result) {
    await sleep(DELAY_MS);
    const topicId = post.id.replace("linuxdo-", "");
    console.log(`[linuxdo] fetching detail + replies for topic ${topicId}...`);
    const detail = await fetchTopicDetail(topicId, failures, usePlaywright);
    if (detail) {
      post.content = detail.content;
      post.author = detail.author;
      post.replies = detail.replies || [];
    }
  }

  await closeBrowser();

  console.log(`[linuxdo] total matched posts from ${TIMELINE_PAGES} pages: ${result.length}`);
  return result;
}

module.exports = { fetchLinuxDoPosts };
