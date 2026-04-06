#!/usr/bin/env node

"use strict";

const V2EX_BASE = "https://www.v2ex.com/api";
const REQUEST_TIMEOUT_MS = 15_000;
const DELAY_MS = Number.parseInt(process.env.CRAWLER_V2EX_DELAY_MS || "1000", 10);

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
    id: `v2ex-${raw.id}`,
    source: "v2ex",
    title: raw.title || "",
    content: stripTags(raw.content_rendered || raw.content || ""),
    url: raw.url || `https://www.v2ex.com/t/${raw.id}`,
    author: raw.member?.username || "",
    createdAt: raw.created ? new Date(raw.created * 1000).toISOString() : "",
    replyCount: raw.replies || 0,
    rawApiData: raw,
  };
}

async function fetchJson(url, failures) {
  try {
    const response = await fetch(url, {
      headers: COMMON_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const msg = `v2ex: ${url} HTTP ${response.status}`;
      failures.push(msg);
      console.warn(`[v2ex] ${msg}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    const msg = `v2ex: ${url} ${error.message}`;
    failures.push(msg);
    console.warn(`[v2ex] ${msg}`);
    return null;
  }
}

async function fetchReplies(topicId, failures) {
  const url = `${V2EX_BASE}/replies/show.json?topic_id=${topicId}`;
  const data = await fetchJson(url, failures);
  if (!Array.isArray(data)) return [];

  return data.map((r) => ({
    id: r.id,
    content: stripTags(r.content_rendered || r.content || ""),
    author: r.member?.username || "",
    createdAt: r.created ? new Date(r.created * 1000).toISOString() : "",
    thanks: r.thanks || 0,
  }));
}

async function fetchV2exPosts(options = {}) {
  const failures = options.failures || [];
  const posts = new Map();
  const endpoints = [
    `${V2EX_BASE}/topics/latest.json`,
    `${V2EX_BASE}/topics/hot.json`,
    `${V2EX_BASE}/topics/show.json?node_name=programmer`,
  ];

  for (let i = 0; i < endpoints.length; i++) {
    const url = endpoints[i];
    console.log(`[v2ex] fetching ${url}...`);
    const data = await fetchJson(url, failures);
    if (Array.isArray(data)) {
      for (const topic of data) {
        if (!posts.has(topic.id)) {
          posts.set(topic.id, normalizeTopic(topic));
        }
      }
    }
    if (i < endpoints.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  const result = [...posts.values()];
  console.log(`[v2ex] fetched ${result.length} unique posts`);
  return result;
}

/**
 * Fetch replies for a list of posts, attaching them to each post object.
 */
async function fetchRepliesForPosts(posts, failures) {
  for (const post of posts) {
    if (!post.replyCount || post.replyCount === 0) {
      post.replies = [];
      continue;
    }
    const topicId = post.id.replace("v2ex-", "");
    console.log(`[v2ex] fetching ${post.replyCount} replies for topic ${topicId}...`);
    const replies = await fetchReplies(topicId, failures);
    post.replies = replies;
    await sleep(DELAY_MS);
  }
}

module.exports = { fetchV2exPosts, fetchRepliesForPosts };
