#!/usr/bin/env node

"use strict";

const KEYWORD_PATTERN = /套餐|coding|plan/i;

function matchesKeywords(text) {
  if (!text) return false;
  return KEYWORD_PATTERN.test(text);
}

module.exports = { KEYWORD_PATTERN, matchesKeywords };
