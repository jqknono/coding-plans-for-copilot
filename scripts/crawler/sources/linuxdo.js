#!/usr/bin/env node
'use strict';

const LINUXDO_BASE = 'https://linux.do';
const REQUEST_TIMEOUT_MS = 20_000;
const DELAY_MS = Number.parseInt(process.env.CRAWLER_LINUXDO_DELAY_MS || '1500', 10);
const TIMELINE_PAGES = Number.parseInt(process.env.CRAWLER_LINUXDO_PAGES || '5', 10);
const MAX_RETRIES = Number.parseInt(process.env.CRAWLER_LINUXDO_MAX_RETRIES || '3', 10);
const RETRY_BASE_MS = Number.parseInt(process.env.CRAWLER_LINUXDO_RETRY_BASE_MS || '2000', 10);

const COMMON_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function extractXmlTag(xml, tagName) {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? decodeXmlEntities(match[1]) : '';
}

function parseTopicIdFromUrl(url) {
  const text = String(url || '');
  const match =
    text.match(/\/t\/(?:[^/]+\/)?(\d+)(?:\.json|\.rss)?(?:[?#].*)?$/i) ||
    text.match(/linux\.do-topic-(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function parsePubDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Parse Discourse latest.rss items into normalized topic-like objects.
 */
function parseRssItems(xml) {
  const items = [];
  const matches = String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi);
  for (const match of matches) {
    const itemXml = match[1];
    const title = extractXmlTag(itemXml, 'title');
    const link = extractXmlTag(itemXml, 'link');
    const description = extractXmlTag(itemXml, 'description');
    const creator = extractXmlTag(itemXml, 'dc:creator') || extractXmlTag(itemXml, 'author');
    const category = extractXmlTag(itemXml, 'category');
    const guid = extractXmlTag(itemXml, 'guid');
    const pubDate = extractXmlTag(itemXml, 'pubDate');
    const topicId = parseTopicIdFromUrl(link) || parseTopicIdFromUrl(guid);
    if (!topicId || !title) continue;

    items.push({
      id: topicId,
      title,
      slug: 'topic',
      excerpt: stripTags(description),
      description,
      created_at: parsePubDate(pubDate),
      author: creator,
      category,
      url: link || `${LINUXDO_BASE}/t/${topicId}`,
      source: 'rss',
    });
  }
  return items;
}

function normalizeTopic(raw) {
  const topicId = raw.id;
  const author = raw.author || '';
  const content = stripTags(raw.excerpt || raw.description || raw.blurb || '');
  const url =
    raw.url ||
    (raw.slug ? `${LINUXDO_BASE}/t/${raw.slug}/${topicId}` : `${LINUXDO_BASE}/t/${topicId}`);

  return {
    id: `linuxdo-${topicId}`,
    source: 'linuxdo',
    title: raw.title || raw.name || '',
    content,
    url,
    author,
    createdAt: raw.created_at || '',
    rawApiData: raw,
  };
}

// ─── Playwright shared browser/context ───
let _browser = null;
let _context = null;
let _page = null;

function getPlaywrightLaunchOptions() {
  const channel = String(process.env.PLAYWRIGHT_BROWSER_CHANNEL || '').trim();
  return channel ? { channel, headless: true } : { headless: true };
}

async function getPlaywrightPage() {
  try {
    const { chromium } = require('playwright');
    if (!_browser) {
      console.log('[linuxdo] launching Playwright (headless chromium)...');
      _browser = await chromium.launch(getPlaywrightLaunchOptions());
    }
    if (!_context) {
      _context = await _browser.newContext({
        userAgent: COMMON_HEADERS['user-agent'],
      });
    }
    if (!_page) {
      _page = await _context.newPage();
    }
    return _page;
  } catch {
    console.warn('[linuxdo] Playwright not available, run: npx playwright install chromium');
    return null;
  }
}

async function closeBrowser() {
  if (_page) {
    await _page.close().catch(() => {});
    _page = null;
  }
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
  }
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

function isCloudflareChallenge(status, bodyPreview) {
  if (status === 403) return true;
  const text = String(bodyPreview || '');
  return /Just a moment|cf-browser-verification|challenge-platform/i.test(text);
}

function shouldRetryStatus(status) {
  return status === 429 || status === 503 || status === 502;
}

async function fetchTextDirect(url, accept) {
  try {
    const headers = {
      ...COMMON_HEADERS,
      accept,
    };
    if (process.env.LINUX_DO_API_KEY) {
      headers['Api-Key'] = process.env.LINUX_DO_API_KEY;
      headers['Api-Username'] = process.env.LINUX_DO_API_USERNAME || 'system';
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      console.log(`[linuxdo] direct fetch ${url} → HTTP ${response.status} "${text.slice(0, 120)}"`);
      return {
        ok: false,
        blocked: isCloudflareChallenge(response.status, text),
        status: response.status,
        text,
      };
    }
    return { ok: true, status: response.status, text };
  } catch (error) {
    console.log(`[linuxdo] direct fetch ${url} → error: ${error.message}`);
    return { ok: false, error: true, message: error.message };
  }
}

async function fetchTextViaPlaywright(url, { expectJson = false } = {}) {
  const page = await getPlaywrightPage();
  if (!page) return { ok: false, message: 'playwright-unavailable' };

  let lastStatus = null;
  let lastPreview = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: REQUEST_TIMEOUT_MS,
      });

      const status = response ? response.status() : 0;
      lastStatus = status;

      // Prefer response body; fall back to rendered body text (XML/JSON in <pre>).
      let text = '';
      try {
        text = response ? await response.text() : '';
      } catch {
        text = '';
      }
      if (!text) {
        text = await page.evaluate(() => (document.body ? document.body.innerText || '' : '')).catch(() => '');
      }
      lastPreview = text.slice(0, 120);

      if (status === 200) {
        if (expectJson) {
          try {
            JSON.parse(text);
          } catch {
            if (isCloudflareChallenge(status, text)) {
              console.log(`[linuxdo] playwright ${url} → challenge/non-json body`);
              return { ok: false, status: 'non-json', text };
            }
          }
        }
        console.log(`[linuxdo] playwright OK → ${url}`);
        return { ok: true, status, text };
      }

      console.log(
        `[linuxdo] playwright ${url} → HTTP ${status} "${lastPreview}" (attempt ${attempt}/${MAX_RETRIES})`,
      );

      if (shouldRetryStatus(status) && attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.log(`[linuxdo] backing off ${waitMs}ms after HTTP ${status}`);
        await sleep(waitMs);
        continue;
      }

      return {
        ok: false,
        blocked: isCloudflareChallenge(status, text),
        status,
        text,
      };
    } catch (error) {
      console.log(
        `[linuxdo] playwright ${url} → error: ${error.message} (attempt ${attempt}/${MAX_RETRIES})`,
      );
      if (attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
        await sleep(waitMs);
        continue;
      }
      return { ok: false, error: true, message: error.message, status: lastStatus };
    }
  }

  return { ok: false, status: lastStatus, text: lastPreview };
}

/**
 * Fetch raw text. Prefer direct HTTP; on Cloudflare block, fall back to Playwright.
 * When usePlaywright=true, go straight to Playwright and keep reusing the session.
 */
async function fetchText(
  url,
  failures,
  { usePlaywright = false, accept = '*/*', expectJson = false } = {},
) {
  let result;

  if (usePlaywright) {
    result = await fetchTextViaPlaywright(url, { expectJson });
  } else {
    result = await fetchTextDirect(url, accept);
    if (!result.ok && (result.blocked || shouldRetryStatus(result.status))) {
      console.log('[linuxdo] direct blocked/rate-limited, retrying with Playwright...');
      result = await fetchTextViaPlaywright(url, { expectJson });
      if (result.ok) {
        result.switchedToPlaywright = true;
      }
    }
  }

  if (!result.ok) {
    failures.push(`linuxdo: ${url} → ${result.status || result.message || 'failed'}`);
    return result;
  }
  return result;
}

async function fetchJson(url, failures, usePlaywright) {
  const result = await fetchText(url, failures, {
    usePlaywright,
    accept: 'application/json',
    expectJson: true,
  });
  if (!result.ok) return { ok: false, ...result };

  try {
    const data = JSON.parse(result.text);
    return { ok: true, data, switchedToPlaywright: result.switchedToPlaywright };
  } catch {
    failures.push(`linuxdo: ${url} → non-json`);
    return { ok: false, status: 'non-json' };
  }
}

async function fetchTopicDetail(topicId, failures, usePlaywright) {
  const url = `${LINUXDO_BASE}/t/${topicId}.json`;
  const result = await fetchJson(url, failures, usePlaywright);
  if (!result.ok) return { detail: null, switchedToPlaywright: result.switchedToPlaywright };

  const data = result.data;
  const allPosts = data.post_stream?.posts || [];
  const firstPost = allPosts[0];
  const replies = [];
  for (let i = 1; i < allPosts.length; i++) {
    replies.push({
      author: allPosts[i].username || '',
      content: stripTags(allPosts[i].cooked || ''),
      createdAt: allPosts[i].created_at || '',
      likes: allPosts[i].like_count || 0,
    });
  }

  return {
    detail: {
      content: stripTags(firstPost?.cooked || ''),
      author: firstPost?.username || '',
      replies,
    },
    switchedToPlaywright: result.switchedToPlaywright,
  };
}

async function fetchLatestViaRss(failures, usePlaywright) {
  const url = `${LINUXDO_BASE}/latest.rss`;
  console.log(`[linuxdo] --- timeline via RSS: ${url} ---`);
  const result = await fetchText(url, failures, {
    usePlaywright,
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  });
  if (!result.ok) {
    return { topics: [], switchedToPlaywright: result.switchedToPlaywright, failed: true };
  }

  const topics = parseRssItems(result.text);
  console.log(`[linuxdo] RSS OK → ${topics.length} topics`);
  return {
    topics,
    switchedToPlaywright: result.switchedToPlaywright,
    failed: false,
  };
}

async function fetchLatestViaJsonPage(pageIndex, failures, usePlaywright) {
  const url = `${LINUXDO_BASE}/latest.json${pageIndex > 0 ? `?page=${pageIndex}` : ''}`;
  console.log(`[linuxdo] --- timeline page ${pageIndex + 1}/${TIMELINE_PAGES}: ${url} ---`);
  const result = await fetchJson(url, failures, usePlaywright);
  if (!result.ok) {
    return { topics: [], switchedToPlaywright: result.switchedToPlaywright, failed: true };
  }

  const topics = (result.data?.topic_list?.topics || []).map((topic) => ({
    ...topic,
    source: 'json',
  }));
  console.log(`[linuxdo] JSON page ${pageIndex + 1} OK → ${topics.length} topics`);
  return {
    topics,
    switchedToPlaywright: result.switchedToPlaywright,
    failed: false,
  };
}

function collectMatchedTopics(topics, posts) {
  const { matchesKeywords } = require('../keywords');
  const matchedTitles = [];

  for (const topic of topics) {
    const normalized = normalizeTopic(topic);
    if (matchesKeywords(normalized.title) || matchesKeywords(normalized.content)) {
      if (!posts.has(topic.id)) {
        posts.set(topic.id, normalized);
        matchedTitles.push(normalized.title.slice(0, 40));
      }
    }
  }

  return matchedTitles;
}

// ─── Main entry ───
async function fetchLinuxDoPosts(options = {}) {
  const failures = options.failures || [];
  const posts = new Map();
  let usePlaywright = false;

  // Phase 1: prefer RSS list discovery (richer description, fewer round-trips).
  const rss = await fetchLatestViaRss(failures, usePlaywright);
  if (rss.switchedToPlaywright) usePlaywright = true;

  if (!rss.failed && rss.topics.length > 0) {
    const matched = collectMatchedTopics(rss.topics, posts);
    if (matched.length) {
      console.log(`[linuxdo] RSS matched ${matched.length}: ${matched.join(' | ')}`);
    } else {
      console.log('[linuxdo] RSS matched 0 posts after keyword filter');
    }
  } else {
    console.log('[linuxdo] RSS list unavailable, falling back to JSON latest pages');
  }

  // Phase 2: JSON pagination only when RSS failed or returned empty.
  // Avoid extra latest.json traffic after a successful RSS discovery to reduce 429 risk.
  if (!rss.failed && rss.topics.length > 0) {
    console.log('[linuxdo] RSS discovery succeeded; skipping JSON latest pagination');
  }
  const shouldUseJsonList = rss.failed || rss.topics.length === 0;
  for (let page = 0; shouldUseJsonList && page < TIMELINE_PAGES; page++) {
    const jsonPage = await fetchLatestViaJsonPage(page, failures, usePlaywright);
    if (jsonPage.switchedToPlaywright) usePlaywright = true;

    if (jsonPage.failed && !usePlaywright) {
      usePlaywright = true;
      console.log('[linuxdo] switching to Playwright for remaining pages');
      page -= 1;
      continue;
    }

    if (!jsonPage.topics || jsonPage.topics.length === 0) {
      console.log(`[linuxdo] page ${page + 1} returned no topics, stopping`);
      break;
    }

    const matched = collectMatchedTopics(jsonPage.topics, posts);
    if (matched.length) {
      console.log(`[linuxdo] page ${page + 1} matched ${matched.length}: ${matched.join(' | ')}`);
    }

    await sleep(DELAY_MS);
  }

  // Phase 3: fetch detail JSON only for keyword hits.
  const result = [...posts.values()];
  for (const post of result) {
    await sleep(DELAY_MS);
    const topicId = post.id.replace('linuxdo-', '');
    console.log(`[linuxdo] fetching detail + replies for topic ${topicId}...`);
    const { detail, switchedToPlaywright } = await fetchTopicDetail(topicId, failures, usePlaywright);
    if (switchedToPlaywright) usePlaywright = true;
    if (detail) {
      // Keep RSS description if detail body is empty.
      if (detail.content) post.content = detail.content;
      if (detail.author) post.author = detail.author;
      post.replies = detail.replies || [];
    }
  }

  await closeBrowser();

  console.log(`[linuxdo] total matched posts: ${result.length}`);
  return result;
}

module.exports = {
  fetchLinuxDoPosts,
  parseRssItems,
  parseTopicIdFromUrl,
  normalizeTopic,
};

