# AGENTS 指令

## 开发基本原则

- 脚本均需实现`-h`参数
- 本工程默认只面向当前目标版本实现；禁止为旧版本 VS Code、旧配置、旧数据结构保留兼容代码。
- 价格/套餐信息变更应优先通过改进抓取脚本实现，不直接手改 `assets/*.json` 数据文件（仅在脚本验证产物阶段由脚本写入）。

## 项目定位

- 本仓库包含两部分：
  - VS Code 扩展（`src/`）：多厂商模型接入 + Commit Message 生成。
  - 价格/性能看板（`pages/` + `assets/` + `scripts/`）：展示编码套餐与 OpenRouter provider 性能指标。
- VS Code 扩展的核心定位是通用 OpenAI Chat、OpenAI Responses、Anthropic 协议适配器；请求构造应优先使用公开/通用协议字段，避免依赖 Copilot 私有请求字段。
- 与原生 VS Code/Copilot Chat 内置 endpoint 请求不同，本插件应保持对 Codex、Claude Code 等反代出的 OpenAI/Anthropic 风格 API 的兼容性；不要为了贴近 Copilot 私有 endpoint 而牺牲通用兼容。
- 看板核心数据文件：
  - `assets/provider-pricing.json`（国内/已结构化套餐）
  - `assets/openrouter-provider-metrics.json`（OpenRouter 指标）
  - `assets/openrouter-provider-plans.json`（OpenRouter provider 套餐与 pending）

## 价格页面获取

- 在获取供应商定价页面或任何价格相关网页内容时，应优先且积极使用 Playwright MCP 工具。
- 对于动态渲染页面、前端渲染内容、可能存在反爬机制的流程，默认使用 Playwright MCP，而不是直接 HTTP 抓取。
- 仅在 Playwright MCP 不可用，或明确不需要浏览器能力时，才回退到非浏览器请求方式。
- 若页面可访问但无法稳定解析，应优先补充 Playwright 路径（含必要等待与交互），再考虑将该供应商标记为 pending。

## 数据抓取执行顺序

- 更新价格与指标数据时，按以下顺序执行：
  1. `npm run pricing:fetch`
  2. `npm run metrics:fetch`
  3. `npm run openrouter:plans:fetch`
  4. `npm run serve:page`（本地预览）
- `openrouter:plans:fetch` 依赖前两步的产物：
  - `assets/provider-pricing.json`
  - `assets/openrouter-provider-metrics.json`

## 脚本与页面契约

- `pages/app.js` 依赖以下字段结构，修改脚本输出时必须保持兼容：
  - `provider-pricing.json`: `providers[].provider/plans/sourceUrls`、顶层 `generatedAt/failures`
  - `openrouter-provider-metrics.json`: `generatedAt(Beijing)`、`captureWindow`、`config`、`models[]`、`failures`
  - `openrouter-provider-plans.json`: `providers[]`、`pending[]`、`summary`、`generatedAt(Beijing)`
- `scripts/serve-pricing-page.js` 将以下路由映射到 `assets/` 文件：
  - `/provider-pricing.json`
  - `/openrouter-provider-metrics.json`
  - `/openrouter-provider-plans.json`
- 不要随意修改上述 JSON 路径；若必须修改，需要同步更新 `pages/app.js` 与 `scripts/serve-pricing-page.js`。

## 环境变量与安全

- `metrics:fetch` 与 `openrouter:plans:fetch` 需要 `APIKEY`（OpenRouter API Key）。
- 可通过项目根目录 `.env` 加载环境变量。
- 进行扩展联调或手工接口测试时，可优先复用 `.env` 中的 `BASE_URL`、`APIKEY`、`MODEL`；默认视为本地测试参数，不写入仓库配置。
- 严禁在文档、日志、提交信息中暴露任何密钥。

## 代码地图（扩展）

- 入口：`src/extension.ts`（注册 `LanguageModelChatProvider`、命令与 SCM 菜单）。
- 配置：`src/config/configStore.ts`（`coding-plans.vendors` 归一化；新配置用 `defaultApiStyle` / `models[].apiStyle`，`apiType` 仅作迁移读取）。
- 协议与请求：`src/providers/genericProvider.ts`、`genericProviderProtocols.ts`；适配 VS Code API：`lmChatProviderAdapter.ts`。
- 行为与回归说明见 [DEV.md](DEV.md)、[docs/testing.md](docs/testing.md)；可验收场景见 [cases/](cases/)（非自动化用例，改行为前应对照或补充）。

## 开发与校验

| 改动范围 | 至少执行 |
| --- | --- |
| `src/` | `npm run typecheck`、`npm run lint`；行为变更时 `npm test`（含 `pretest` 的 compile+lint） |
| `scripts/`、`pages/`、`assets/` 契约 | 相关 `npm run pricing:fetch` / `metrics:fetch` / `openrouter:plans:fetch` + `npm run serve:page`；可选 `npm run test:pages` |
| 发布扩展 | `npm run package:vsix`；见 [DEV.md](DEV.md) 发布与预发布版本约定 |

- 常用命令：`compile`（typecheck+bundle）、`package:vsix`、`test:unit`、`test:desktop`、`test:pages`。
- VSIX 仅打包 `out/extension.js` 等清单内文件（见 `.vscodeignore`）；新增运行时资源须同步打包/esbuild 配置。

## 文档一致性

- 当配置项、脚本参数或默认值发生变更时，同步检查：
  - `README.md`
  - `README_en.md`
  - `DEV.md`
  - `package.json`（contributes.configuration）
- 若文档与代码冲突，以代码行为为准，并在同一轮修改中修正文档。
