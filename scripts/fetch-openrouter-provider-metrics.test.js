"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchJson } = require("./fetch-openrouter-provider-metrics");

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
