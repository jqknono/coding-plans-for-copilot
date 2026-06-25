---
name: pricing-data-pipeline
description: "更新编码套餐与 OpenRouter 指标/套餐 JSON、修复抓取失败或 pending。Use when: pricing:fetch, metrics:fetch, openrouter:plans:fetch, provider-pricing.json, dashboard 数据过期或 CI 定价 issue。"
argument-hint: "可选：供应商名、失败现象或要改的脚本"
---

# 价格与指标数据流水线

## 何时使用

- 用户要刷新看板数据、修抓取脚本、处理 `failures`/`pending`、或对齐 GitHub Actions（`update-pricing.yml`、`update-openrouter-metrics.yml`）。

## 步骤

1. 确认 `.env` 含 `APIKEY`（OpenRouter）；可选变量见 `scripts/fetch-openrouter-provider-metrics.js`。
2. 按顺序执行（与 CI metrics 工作流一致）：
   - `npm run pricing:fetch`
   - `npm run metrics:fetch`
   - `npm run openrouter:plans:fetch`
3. `npm run serve:page`，浏览器检查表格与失败卡片。
4. 改脚本后：`node --test scripts/fetch-openrouter-provider-metrics.test.js tests/scripts/*.test.js`，再 `npm run test:pages`。

## 原则

- 不手改 `assets/*.json`；动态页用 Playwright MCP（见 [AGENTS.md](../../../AGENTS.md)）。
- 改 JSON 字段须对照 `pages/app.js` 与 [AGENTS.md](../../../AGENTS.md) 契约一节。

## 参考

- 本地服务：`scripts/serve-pricing-page.js`
- 页面逻辑：`pages/app.js`
- 用例：`cases/openrouter-metrics-fail-closed.md`、`cases/issue-105-pricing-failure-card-hidden.md`