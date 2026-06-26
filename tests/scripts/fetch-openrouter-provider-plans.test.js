'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePlanServiceDetails } = require('../../scripts/fetch-openrouter-provider-plans.js');

test('normalizePlanServiceDetails fills concise fallback for plans without details', () => {
  const plans = normalizePlanServiceDetails([
    {
      name: '官网价格参考',
      currentPriceText: '$4/mo',
      serviceDetails: null,
    },
  ]);

  assert.deepEqual(plans[0].serviceDetails, ['官网价格页参考，具体权益以官网说明为准']);
});

test('normalizePlanServiceDetails reuses shared details for sibling plans', () => {
  const plans = normalizePlanServiceDetails([
    {
      name: 'Pro',
      currentPriceText: '$20/mo',
      serviceDetails: ['Included usage: 1,000 credits'],
    },
    {
      name: 'Team',
      currentPriceText: '$40/mo',
      serviceDetails: null,
    },
  ]);

  assert.deepEqual(plans[1].serviceDetails, ['Included usage: 1,000 credits']);
});
