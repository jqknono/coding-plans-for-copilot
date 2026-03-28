"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STALE_PROVIDER_NOTICE,
  extractProviderIdFromFailure,
  restoreFailedProvidersFromSnapshot,
} = require("../../scripts/fetch-provider-pricing.js");

test("extractProviderIdFromFailure reads provider id prefix", () => {
  assert.equal(
    extractProviderIdFromFailure("jdcloud-ai: page.goto: Timeout 20000ms exceeded"),
    "jdcloud-ai",
  );
});

test("restoreFailedProvidersFromSnapshot keeps previous plans and marks them stale", () => {
  const currentProviders = [
    {
      provider: "kimi-ai",
      sourceUrls: ["https://kimi.com"],
      plans: [{ name: "K1", currentPriceText: "¥39/月" }],
    },
  ];
  const snapshotProviders = [
    {
      provider: "jdcloud-ai",
      sourceUrls: ["https://www.jdcloud.com/cn/pages/codingplan"],
      plans: [{ name: "Coding Plan Lite", currentPriceText: "¥7.9/月" }],
    },
  ];

  const restored = restoreFailedProvidersFromSnapshot(
    currentProviders,
    ["jdcloud-ai: page.goto: Timeout 20000ms exceeded"],
    snapshotProviders,
  );

  assert.equal(restored.length, 2);
  const fallback = restored.find((provider) => provider.provider === "jdcloud-ai");
  assert.ok(fallback);
  assert.deepEqual(fallback.plans, snapshotProviders[0].plans);
  assert.equal(fallback.staleReason, STALE_PROVIDER_NOTICE);
  assert.match(fallback.staleFailure, /Timeout 20000ms exceeded/);
});

test("restoreFailedProvidersFromSnapshot skips providers without snapshot data", () => {
  const restored = restoreFailedProvidersFromSnapshot([], ["jdcloud-ai: parse failed"], []);
  assert.deepEqual(restored, []);
});
