---
description: "Use when changing pricing fetch scripts, OpenRouter metrics/plans, pages dashboard, or assets JSON contracts under scripts/, pages/, assets/."
applyTo: "scripts/**,pages/**,assets/**,tests/pages/**,tests/scripts/**"
---

# 看板与抓取脚本

## 数据流

1. `npm run pricing:fetch` → `assets/provider-pricing.json`
2. `npm run metrics:fetch` → `assets/openrouter-provider-metrics.json`（需 `APIKEY`；失败时 fail-closed，勿用空结果覆盖）
3. `npm run openrouter:plans:fetch` → `assets/openrouter-provider-plans.json`（依赖上两步产物）
4. `npm run serve:page` 本地预览（默认 `127.0.0.1:4173`）

## 契约

- 字段结构须与 [AGENTS.md](../../AGENTS.md)「脚本与页面契约」一致；改输出须同步 `pages/app.js` 与 `scripts/serve-pricing-page.js` 路由。
- **禁止**手改 `assets/*.json` 做正式数据更新；改抓取逻辑后由脚本写入。
- 脚本须支持 `-h` / help。

## 网页抓取

- 供应商定价页、动态渲染页：优先 **Playwright MCP**；见根目录 `AGENTS.md`「价格页面获取」。

## 校验

```bash
node --test scripts/fetch-openrouter-provider-metrics.test.js tests/scripts/*.test.js
npm run test:pages
```

环境变量说明见各脚本顶部与 [DEV.md](../../DEV.md)；密钥仅 `.env`，勿写入日志或文档。