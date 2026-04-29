"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchJson,
  getMetricsValidationErrors,
  hasPercentileStats,
  normalizeEndpointPricing,
  withCnyPricing,
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

test("normalizeEndpointPricing keeps 1M token price inputs and cache discount signal", () => {
  assert.deepEqual(
    normalizeEndpointPricing({
      prompt: "0.00000027",
      input_cache_read: "0.000000135",
      input_cache_write: "0.0000003",
      completion: "0.000001",
      discount: 0,
    }),
    {
      prompt: 0.00000027,
      input_cache_read: 0.000000135,
      input_cache_write: 0.0000003,
      completion: 0.000001,
      has_input_cache_read_discount: true,
      input_cache_read_discount_rate: 0.5,
    },
  );

  assert.deepEqual(
    normalizeEndpointPricing({
      prompt: "0.00000055",
      input_cache_read: "0.00000055",
      completion: "0.00000165",
    }),
    {
      prompt: 0.00000055,
      input_cache_read: 0.00000055,
      input_cache_write: null,
      completion: 0.00000165,
      has_input_cache_read_discount: false,
      input_cache_read_discount_rate: null,
    },
  );
});

test("normalizeEndpointPricing treats zero cache read price as unavailable", () => {
  assert.deepEqual(
    normalizeEndpointPricing({
      prompt: "0.00000025",
      input_cache_read: "0",
      completion: "0.000002",
    }),
    {
      prompt: 0.00000025,
      input_cache_read: null,
      input_cache_write: null,
      completion: 0.000002,
      has_input_cache_read_discount: false,
      input_cache_read_discount_rate: null,
    },
  );
});

test("withCnyPricing derives CNY token prices from USD/CNY rate", () => {
  const result = withCnyPricing({
    prompt: 0.00000025,
    input_cache_read: 0.00000005,
    input_cache_write: null,
    completion: 0.000002,
    has_input_cache_read_discount: true,
    input_cache_read_discount_rate: 0.8,
  }, 7.1);

  assert.equal(result.currency, "USD");
  assert.equal(result.cny.exchange_rate, 7.1);
  assert.equal(result.cny.input_cache_write, null);
  assert.ok(Math.abs(result.cny.prompt - 0.000001775) < 1e-18);
  assert.ok(Math.abs(result.cny.input_cache_read - 3.55e-7) < 1e-18);
  assert.ok(Math.abs(result.cny.completion - 0.0000142) < 1e-18);
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
