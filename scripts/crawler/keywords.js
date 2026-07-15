#!/usr/bin/env node

'use strict';

/** Keywords used for first-pass community post filtering before LLM analysis. */
const KEYWORDS = [
  '套餐',
  'coding',
  'plan',
  'claude',
  'gpt',
  'openai',
  'kimi',
  'zhipu',
  'moonshot',
  'qwen',
  'glm',
  'deepseek',
];

// Escape regex metacharacters in keyword literals.
const KEYWORD_PATTERN = new RegExp(
  KEYWORDS.map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

function matchesKeywords(text) {
  if (!text) return false;
  return KEYWORD_PATTERN.test(text);
}

module.exports = { KEYWORDS, KEYWORD_PATTERN, matchesKeywords };
