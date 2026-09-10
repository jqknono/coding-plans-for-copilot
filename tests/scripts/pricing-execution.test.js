'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

function loadParser(overrides = {}) {
  const filename = path.resolve(__dirname, '../../scripts/fetch-provider-pricing.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    require: (id) => overrides[id] || localRequire(id),
    module: { exports: {} }, __dirname: path.dirname(filename),
    process, console, setTimeout, clearTimeout, AbortController, fetch,
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.execution = { runPricingTasks, runTaskWithTimeout, launchPricingBrowser, fetchRenderedPageText, parseZhipuCodingPlansWithPlaywright, TASK_TIMEOUT_MS };', context);
  return { context, api: context.module.exports.execution };
}

test('task budget covers sequential browser navigation, rendering and secondary sources', () => {
  const { api } = loadParser();
  assert.ok(api.TASK_TIMEOUT_MS >= 120_000);
});

test('pricing workers bound concurrency and preserve failure/provider order', async () => {
  const { api } = loadParser();
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => ({ fn: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (index === 2) throw new Error('provider unavailable');
    return index;
  } }));
  const results = await api.runPricingTasks(tasks);
  assert.equal(peak, 3);
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[7].value, 7);
  assert.equal(results[0].value, 0);
});

test('timeout closes browsers and forbids a subsequent fallback launch', async () => {
  const { api } = loadParser();
  let closed = false;
  let launches = 0;
  let release;
  let lateLaunch;
  const gate = new Promise((resolve) => { release = resolve; });
  const chromium = { launch: async () => {
    launches += 1;
    return { close: async () => { closed = true; } };
  } };
  await assert.rejects(api.runTaskWithTimeout(async () => {
    await api.launchPricingBrowser(chromium);
    await gate;
    lateLaunch = api.launchPricingBrowser(chromium);
    await assert.rejects(lateLaunch, /abort/i);
  }, 20), /Task timed out after 20ms/);
  assert.equal(closed, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lateLaunch);
  assert.equal(launches, 1);
});

test('rendered pricing waits for content without waiting for DOMContentLoaded', async () => {
  const page = {
    route: async () => {},
    goto: async (_url, options) => {
      assert.equal(options.waitUntil, 'commit');
      assert.ok(options.timeout >= 30_000);
    },
    waitForFunction: async (_fn, _arg, options) => assert.ok(options.timeout > 0),
    evaluate: async () => 'Lite Plan ¥120 / 季度',
    url: () => 'https://example.com',
  };
  const { api } = loadParser({ '@playwright/test': { chromium: { launch: async () => ({ newPage: async () => page, close: async () => {} }) } } });
  const result = await api.fetchRenderedPageText('https://example.com', 'test', { waitForText: /Lite Plan/ });
  assert.match(result.text, /Lite Plan/);
});

test('a browser finishing launch after timeout is closed before it can be used', async () => {
  const { api } = loadParser();
  let release;
  let closed = false;
  let pendingLaunch;
  const launched = new Promise((resolve) => { release = resolve; });
  await assert.rejects(api.runTaskWithTimeout(async () => {
    pendingLaunch = api.launchPricingBrowser({ launch: () => launched });
    await pendingLaunch;
  }, 20), /Task timed out/);
  release({ close: async () => { closed = true; } });
  await assert.rejects(pendingLaunch, /abort/i);
  assert.equal(closed, true);
});

test('Zhipu passes wait timeout as the third Playwright argument', async () => {
  let waits = 0;
  const page = {
    route: async () => {}, goto: async () => {},
    waitForFunction: async (_fn, arg, options) => {
      assert.equal(arg, undefined);
      assert.ok(options.timeout > 0);
      if (waits === 0) {
        const document = {
          body: { innerText: 'GLM Coding Plan 你的全能搭档 连续包月 每周 10,000 积分' },
          querySelectorAll: () => Array.from({ length: 3 }, () => ({
            querySelector: () => ({ textContent: '¥118/月' }),
          })),
        };
        assert.equal(vm.runInNewContext(`(${_fn.toString()})()`, { document }), true);
      }
      waits += 1;
      if (waits === 2) throw new Error('stop after verified waits');
    },
    evaluate: async () => {},
  };
  const { api } = loadParser({ '@playwright/test': { chromium: { launch: async () => ({ newPage: async () => page, close: async () => {} }) } } });
  await assert.rejects(api.parseZhipuCodingPlansWithPlaywright(), /stop after verified waits/);
  assert.equal(waits, 2);
});
