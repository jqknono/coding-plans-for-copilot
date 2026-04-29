"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchJson,
  getMetricsValidationErrors,
  hasPercentileStats,
} = require("./fetch-openrouter-provider-metrics");

test("fetchJson retries endpoint requests after transient HTTP 408", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: "timeout" }), {
        status: 408,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: { endpoints: [{ provider_name: "Test" }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const payload = await fetchJson("https://openrouter.ai/api/v1/models/qwen/qwen3.6-plus%3Afree/endpoints", {
      retryCount: 1,
      retryDelayMs: 0,
    });

    assert.deepEqual(payload, { data: { endpoints: [{ provider_name: "Test" }] } });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchJson does not retry non-transient HTTP 404", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "missing" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      fetchJson("https://openrouter.ai/api/v1/models/qwen/missing/endpoints", {
        retryCount: 2,
        retryDelayMs: 0,
      }),
      /HTTP 404/,
    );

    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hasPercentileStats requires every percentile to be finite", () => {
  assert.equal(hasPercentileStats({ p50: 1, p75: 2, p90: 3, p99: 4 }), true);
  assert.equal(hasPercentileStats({ p50: 1, p75: 2, p90: 3, p99: null }), false);
  assert.equal(hasPercentileStats(null), false);
});

test("metrics validation rejects fully empty latency and throughput metrics", () => {
  const errors = getMetricsValidationErrors({
    models: [
      {
        id: "deepseek/deepseek-v4-pro",
        endpoints: [
          {
            providerName: "DeepSeek",
            uptime_last_30m: 100,
            latency_last_30m: null,
            throughput_last_30m: null,
          },
        ],
      },
    ],
    failures: [],
  });

  assert.match(errors.join("\n"), /latency metrics are empty/);
  assert.match(errors.join("\n"), /throughput metrics are empty/);
});

test("metrics validation accepts partial nullable endpoint metrics when coverage exists", () => {
  const errors = getMetricsValidationErrors({
    models: [
      {
        id: "deepseek/deepseek-v4-pro",
        endpoints: [
          {
            providerName: "DeepSeek",
            uptime_last_30m: 100,
            latency_last_30m: { p50: 1612.5, p75: 2196, p90: 3106, p99: 18199 },
            throughput_last_30m: { p50: 24, p75: 27, p90: 29, p99: 32 },
          },
          {
            providerName: "GMICloud",
            uptime_last_1d: 99,
            latency_last_30m: null,
            throughput_last_30m: null,
          },
        ],
      },
    ],
    failures: [],
  });

  assert.deepEqual(errors, []);
});

test("metrics validation rejects endpoint fetch failures", () => {
  const errors = getMetricsValidationErrors({
    models: [
      {
        id: "deepseek/deepseek-v4-pro",
        endpoints: [
          {
            providerName: "DeepSeek",
            uptime_last_30m: 100,
            latency_last_30m: { p50: 1, p75: 2, p90: 3, p99: 4 },
            throughput_last_30m: { p50: 5, p75: 6, p90: 7, p99: 8 },
          },
        ],
      },
    ],
    failures: ["qwen/qwen3: HTTP 500"],
  });

  assert.match(errors.join("\n"), /endpoint fetch failures: 1/);
});
