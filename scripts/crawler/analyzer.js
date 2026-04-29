#!/usr/bin/env node

"use strict";

const REQUEST_TIMEOUT_MS = 30_000;
const DELAY_MS = Number.parseInt(process.env.CRAWLER_LLM_DELAY_MS || "2000", 10);
const MAX_CONTENT_CHARS = 2000;
const MAX_RETRIES = Number.parseInt(process.env.CRAWLER_LLM_MAX_RETRIES || "3", 10);

const VALID_SENTIMENTS = new Set(["positive", "negative", "neutral"]);
const VALID_LANGUAGES = new Set(["zh", "en", "other"]);
const VALID_SUPPLIER_CATEGORIES = new Set([
  "chinese-provider", "international-provider", "aggregator", "tool", "other",
]);

let availableCategories = [];

function setAvailableCategories(categories) {
  availableCategories = categories || [];
}

function buildSystemPrompt() {
  const categoryList = availableCategories.length > 0
    ? `Available discussion categories (MUST choose one for the "category" field):\n${availableCategories.map((c) => `- ${c.name}`).join("\n")}`
    : "No categories available.";

  return `${SYSTEM_PROMPT_BASE}\n\n${categoryList}`;
}

const SYSTEM_PROMPT_BASE = `You are an analyst for a project called "coding-plans-for-copilot", a VS Code extension that helps developers compare AI coding plan pricing across providers (e.g., Zhipu, Kimi, Volcengine, MiniMax, DeepSeek, OpenRouter, Cursor, GitHub Copilot, Windsurf, etc.).

Your task is to analyze social media/forum posts and determine:
1. Whether the post is related to "coding plans" (AI coding assistant subscription plans, pricing, or 套餐)
2. Whether the post is specifically about an AI coding assistant plan (isCodingPlan)
3. Which supplier/provider is mentioned (if any)
4. The sentiment of the post toward the provider/plan
5. A brief summary of what the post discusses

A "coding plan" (编码套餐) refers EXCLUSIVELY to subscription services for AI coding assistants — tools that write, review, or assist with code inside editors/IDEs. Examples:
- GitHub Copilot (Individual/Business/Enterprise)
- Cursor (Pro/Business)
- Windsurf (Pro/Enterprise)
- 智谱 GLM Coding Plan
- Kimi, 火山引擎(Volcengine), MiniMax, 百度千帆, 腾讯云, 阿里云, DeepSeek coding plans
- OpenRouter, aggregators that compare these plans

NOT "coding plans" (should have isCodingPlan=false, isRelevant=false):
- 指纹浏览器/反检测浏览器 (e.g., RoxyBrowser, AdsPower) — these are browser tools, NOT AI coding assistants
- VPN/代理/网络工具套餐
- 云服务器/VPS/域名/CDN 套餐
- 普通 SaaS 订阅 (e.g., 网盘, 邮箱, 设计工具)
- 任何与 AI 编码助手无关的"套餐"或"plan"

Return your analysis as a JSON object with exactly this structure:
{
  "isRelevant": boolean,
  "isCodingPlan": boolean,
  "relevance": number (0.0 to 1.0),
  "supplier": string or null,
  "supplierCategory": "chinese-provider" | "international-provider" | "aggregator" | "tool" | "other" | null,
  "sentiment": "positive" | "negative" | "neutral",
  "sentimentConfidence": number (0.0 to 1.0),
  "summary": string (1-2 sentence summary in the post's original language),
  "topics": string[] (key topics mentioned in Chinese, e.g., ["定价", "Copilot", "套餐对比", "抽奖", "体验卡", "故障排查"]),
  "planMentioned": string or null (specific plan name if mentioned),
  "language": "zh" | "en" | "other",
  "category": string (choose the most fitting category from the available categories listed above)
}

Rules:
- isCodingPlan MUST be true ONLY if the post is about an AI coding assistant subscription/plan. This is the primary filter. If isCodingPlan=false, then isRelevant MUST also be false.
- isRelevant should be true ONLY if isCodingPlan is true AND the post discusses coding plan pricing, subscriptions, comparisons, user experiences, trials, or giveaways related to coding plans.
- Posts about general programming, unrelated AI topics, browser tools, VPN, cloud servers, or any non-coding-assistant "套餐" should have isCodingPlan=false and isRelevant=false.
- Do NOT be fooled by the word "套餐" or "plan" alone — verify the product is an AI coding assistant.
- relevance is your confidence that this post is about AI coding plans.
- If no specific supplier is mentioned, set supplier to null.
- Be conservative: when in doubt, set isCodingPlan to false and isRelevant to false.
- topics MUST be in Chinese (e.g., "定价", "套餐对比", "抽奖", "体验卡", "故障排查", "订阅", "激活", "免费额度").
- summary should be written in the post's original language (Chinese for zh posts, English for en posts).`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateContent(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

async function callLLM(messages, { noJsonFormat, rawContent } = {}) {
  const baseUrl = process.env.BASE_URL || "https://openrouter.ai/api/v1";
  const apiKey = process.env.APIKEY;
  const model = process.env.MODEL || "openrouter/free";

  if (!apiKey) {
    throw new Error("No API key configured. Set APIKEY in .env");
  }

  const body = {
    model,
    messages,
    temperature: 0.1,
  };
  if (!noJsonFormat) {
    body.response_format = { type: "json_object" };
  }

  console.log(`[analyzer] POST ${baseUrl}/chat/completions model=${model} json_format=${!noJsonFormat}`);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const respBody = await response.text().catch(() => "");
    const isJsonFormatError = respBody.includes("response_format") || respBody.includes("json_object") || respBody.includes("INVALID_ARGUMENT");
    throw new Error(`HTTP ${response.status}: ${respBody.slice(0, 300)}`, { cause: isJsonFormatError ? "json_format_unsupported" : undefined });
  }

  const data = await response.json();

  if (!data.choices?.length) {
    console.log(`[analyzer] LLM response missing choices: ${JSON.stringify(data).slice(0, 300)}`);
    throw new Error(`LLM returned no choices (response keys: ${Object.keys(data).join(",")})`);
  }

  const content = data.choices[0].message?.content;
  if (!content) {
    const msg = data.choices[0].message || {};
    console.log(`[analyzer] LLM choice[0].message keys: ${Object.keys(msg).join(",")} finish_reason=${data.choices[0].finish_reason}`);
    if (msg.tool_calls) console.log(`[analyzer] unexpected tool_calls in response`);
    if (msg.refusal) console.log(`[analyzer] model refused: ${msg.refusal.slice(0, 200)}`);
    throw new Error(`LLM returned empty content (finish_reason=${data.choices[0].finish_reason})`);
  }

  if (rawContent) {
    return content;
  }

  try {
    return JSON.parse(content);
  } catch (parseErr) {
    console.log(`[analyzer] JSON parse failed, raw content: ${content.slice(0, 300)}`);
    throw new Error(`LLM returned invalid JSON: ${parseErr.message}`);
  }
}

// ─── JSON schema validation ───

/**
 * Validate the parsed analysis object against the expected schema.
 * Returns an array of error strings (empty if valid).
 */
function validateAnalysis(obj) {
  const errors = [];

  if (typeof obj.isRelevant !== "boolean") {
    errors.push(`isRelevant: expected boolean, got ${typeof obj.isRelevant}`);
  }
  if (typeof obj.isCodingPlan !== "boolean") {
    errors.push(`isCodingPlan: expected boolean, got ${typeof obj.isCodingPlan}`);
  }
  if (typeof obj.relevance !== "number" || obj.relevance < 0 || obj.relevance > 1) {
    errors.push(`relevance: expected number 0-1, got ${obj.relevance}`);
  }
  if (obj.sentiment !== undefined && obj.sentiment !== null && !VALID_SENTIMENTS.has(obj.sentiment)) {
    errors.push(`sentiment: expected one of [${[...VALID_SENTIMENTS].join(",")}], got "${obj.sentiment}"`);
  }
  if (obj.sentimentConfidence !== undefined && (typeof obj.sentimentConfidence !== "number" || obj.sentimentConfidence < 0 || obj.sentimentConfidence > 1)) {
    errors.push(`sentimentConfidence: expected number 0-1, got ${obj.sentimentConfidence}`);
  }
  if (obj.supplierCategory !== undefined && obj.supplierCategory !== null && !VALID_SUPPLIER_CATEGORIES.has(obj.supplierCategory)) {
    errors.push(`supplierCategory: invalid value "${obj.supplierCategory}"`);
  }
  if (obj.language !== undefined && obj.language !== null && !VALID_LANGUAGES.has(obj.language)) {
    errors.push(`language: expected one of [${[...VALID_LANGUAGES].join(",")}], got "${obj.language}"`);
  }
  if (obj.topics !== undefined && !Array.isArray(obj.topics)) {
    errors.push(`topics: expected array, got ${typeof obj.topics}`);
  }
  if (obj.summary !== undefined && typeof obj.summary !== "string") {
    errors.push(`summary: expected string, got ${typeof obj.summary}`);
  }
  if (availableCategories.length > 0) {
    if (typeof obj.category !== "string" || obj.category.trim() === "") {
      errors.push(`category: expected non-empty string, got ${typeof obj.category}`);
    } else if (!availableCategories.some((c) => c.name === obj.category || c.slug === obj.category)) {
      errors.push(`category: expected one of available categories, got "${obj.category}"`);
    }
  }

  return errors;
}

/**
 * Parse LLM content as JSON and validate schema.
 * Throws on parse failure or validation failure.
 */
function parseAndValidateAnalysis(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(`LLM returned invalid JSON: ${parseErr.message}`);
  }

  const errors = validateAnalysis(parsed);
  if (errors.length > 0) {
    throw new Error(`LLM output schema validation failed: ${errors.join("; ")}`);
  }

  return parsed;
}

async function analyzePost(post) {
  const userPrompt = `Analyze this forum post for relevance to AI coding plans/套餐.

Title: ${post.title}
Content: ${truncateContent(post.content, MAX_CONTENT_CHARS)}
Source: ${post.source}`;

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: userPrompt },
  ];

  let lastError = null;
  let noJsonFormat = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const rawContent = await callLLM(messages, { noJsonFormat, rawContent: true });
      const result = parseAndValidateAnalysis(rawContent);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`[analyzer] attempt ${attempt}/${MAX_RETRIES} failed for ${post.id}: ${error.message}`);

      // If json_object format is unsupported, retry without it
      if (error.cause === "json_format_unsupported" && !noJsonFormat) {
        noJsonFormat = true;
        console.log("[analyzer] retrying without response_format (model doesn't support json_object)");
      }

      if (attempt < MAX_RETRIES) {
        await sleep(DELAY_MS);
      }
    }
  }

  console.error(`[analyzer] all ${MAX_RETRIES} attempts failed for ${post.id}`);
  return { analysisError: true, error: lastError?.message || "Unknown error" };
}

async function analyzePosts(posts, options = {}) {
  const results = [];
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    console.log(`[analyzer] analyzing ${i + 1}/${posts.length}: ${post.title.slice(0, 50)}...`);
    const analysis = await analyzePost(post);
    results.push({ post, analysis });
    if (i < posts.length - 1) {
      await sleep(DELAY_MS);
    }
  }
  return results;
}

module.exports = { analyzePost, analyzePosts, validateAnalysis, parseAndValidateAnalysis, setAvailableCategories };
