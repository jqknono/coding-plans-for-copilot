# 开发指南

## 快速命令

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 代码检查
npm run lint

# GitHub Pages 冒烟测试
npm run test:pages

# 打包正式版
npm run package:vsix

# 打包预览版
npm run package:vsix:pre
```

## 打包发布

```bash
npm run package:vsix
```

打包预览版：

```bash
npm run package:vsix:pre
```

发布到插件市场：

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace

# PowerShell
$env:VSCE_PAT=”your_pat”
npm run publish:marketplace
```

发布预览版到插件市场：

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace:pre

# PowerShell
$env:VSCE_PAT=”your_pat”
npm run publish:marketplace:pre
```

说明：`npm run publish:marketplace` 会在发布前自动更新 `CHANGELOG.md`（按当前 `package.json` 版本生成对应条目）。

预发布通道约定：

- 本项目使用 VS Code Marketplace 的同一扩展 `Pre-Release` 通道，不额外拆分扩展 ID。
- 只有在 Marketplace 上已经存在至少一个预发布版本时，用户安装扩展后，才可在扩展详情页的齿轮菜单中切换 `Switch to Pre-Release Version` / `Switch to Release Version`。
- 如果当前详情页没有该入口，说明市场上还没有可切换的预发布包，这通常不是扩展清单问题，而是尚未执行过一次 `publish --pre-release`。
- 预发布版和正式版必须使用不同版本号；建议采用”奇数 minor 预发布、偶数 minor 正式”的约定，例如 `0.7.x` 为预览通道，`0.8.x` 为正式通道。
- `npm run publish:marketplace:pre` 只负责按当前 `package.json` 版本发布为预发布，不会自动修改版本号。

## 提交消息高级配置

在 VS Code `settings.json` 中可配置：

```json
{
  “coding-plans.commitMessage.options”: {
    “prompt”: “FORMAT REQUIREMENT:\nFollow the Conventional Commits format...”,
    “maxDiffLines”: 3000,
    “pipelineMode”: “single”,
    “summaryTriggerLines”: 1200,
    “summaryChunkLines”: 800,
    “summaryMaxChunks”: 12,
    “maxBodyBulletCount”: 7,
    “subjectMaxLength”: 72,
    “requireConventionalType”: true,
    “warnOnValidationFailure”: true,
    “llmMaxPromptLength”: 20000
  }
}
```

## 编码套餐价格抓取

执行 `npm run pricing:fetch` 抓取编码套餐价格，结果写入：

- `assets/provider-pricing.json`（扩展和 GitHub Pages 的统一数据源）

GitHub Pages 部署时会将 `assets/provider-pricing.json` 同步到 `pages/provider-pricing.json` 作为站点构建产物（不入库）。

## OpenRouter 数据抓取

抓取性能数据时，使用环境变量 `CODING_PLANS_FOR_COPILOT` 作为 OpenRouter API Key：

```bash
npm run metrics:fetch
```

可选环境变量：
- `OPENROUTER_BASE_URL`：OpenRouter API Base URL（默认 `https://openrouter.ai/api/v1`）。
- `OPENROUTER_MODEL_ORGS`：逗号分隔组织列表（默认 `deepseek,qwen,moonshotai,z-ai,minimax,bytedance,bytedance-seed,kwaipilot,meituan,mistralai,stepfun`）。
- `OPENROUTER_MODEL_LIMIT`：每个组织取最新模型数量（默认 `5`）。
- `OPENROUTER_MODEL_MAX_AGE_DAYS`：仅抓取最近 N 天发布模型（默认 `180`；设为 `0` 表示不过滤发布天数）。
- `OPENROUTER_ENDPOINT_CONCURRENCY`：抓取 endpoints 并发（默认 `4`）。
- `OPENROUTER_REQUEST_TIMEOUT_MS`：请求超时毫秒数（默认 `20000`）。

抓取 OpenRouter 供应商套餐页（用于海外供应商 Tab）:

```bash
npm run openrouter:plans:fetch
```

本地预览 GitHub Pages 看板（静态服务器，默认 `http://127.0.0.1:4173`）：

```bash
npm run serve:page
```

运行 GitHub Pages 冒烟测试（自动启动/复用本地预览服务）：

```bash
npm run test:pages
```

## Copilot Chat Context

- 本扩展不再维护独立的原生 Context Agent。
- 上下文展示直接复用 Copilot Chat 自带的 Context Window / 上下文展示器。
- 相关展示能力与细节以 VS Code / Copilot Chat 当前内置实现为准。
- 关于 Context Window 的实际使用方式、上下文来源和本仓库内的落地建议，见 [docs/copilot-chat-context-window.md](docs/copilot-chat-context-window.md)。
- 关于当前公开 Chat API 的能力边界与后续待跟进项，见 [todo/vscode-chat-api-follow-up.md](todo/vscode-chat-api-follow-up.md)。

## Context 面板语义

- `System Instructions`：指 system prompt、模式说明、策略提示、插件额外注入说明等 System 类输入，占用 prompt tokens。
- `Tool Definitions`：指工具定义本身的 schema 占用，占用 prompt tokens。
- `Reserved Output`：指预留给模型输出的 token 预算，对应 `outputBuffer`，在 UI 中单独显示。
- `Context Window X / Y tokens`：`Y` 是当前模型的总上下文窗口，优先取模型配置中的 `contextSize`，未提供时再回退到归一化后的 token window。当前公开 API 只要求扩展实现 `provideTokenCount`，没有提供把上游 usage 明细写回原生 Context Window 的公开接口，因此本仓库不再维护 `X`。
- VS Code 官方文档说明：hover 到上下文窗口控件时，会显示”精确 token 数 / 总上下文”和按类别拆分；上下文满时会触发 compaction。
- 若后续 VS Code / Copilot Chat 调整上下文展示结构，应以其内置行为为准同步更新文档描述。
- 当前实现已完全停止本地 prompt token 估算与本地 token 计数；若上游不返回 usage，只能显示”无 usage 数据”，不会再做近似补算。
- 若需要看最近一次真实请求的 usage 比例与明细，以统一状态栏 `CodingPlans` 为准；正文显示简洁百分比，tooltip 合并展示套餐 usage 与 context 明细。
- 若供应商配置了 `coding-plans.vendors[].usageUrl`，`CodingPlans` 会额外展示套餐额度。当前先支持智谱 coding plan usage，已兼容 5 小时额度与 MCP/次数额度两类展示。

## 多协议供应商接入说明

- 调试请求链路时，可通过 `coding-plans.logLevel` 控制输出面板日志级别；需要完整追踪时切到 `debug`，日常建议保持 `info`。
- `coding-plans.vendors[].defaultApiStyle` 用于声明供应商默认协议风格，模型也可以通过 `coding-plans.vendors[].models[].apiStyle` 单独覆盖：
  - `openai-chat`：请求 `baseUrl + /chat/completions`
  - `openai-responses`：请求 `baseUrl + /responses`
  - `anthropic`：请求 `baseUrl + /messages`
- `coding-plans.vendors[].usageUrl` 为可选套餐 usage 接口；当前默认按 `Authorization: Bearer <API Key>` 轮询，并将识别到的小时额度、周额度或次数额度以百分比显示在状态栏。
- `coding-plans.vendors[].models[].contextSize` 现在是描述模型上下文的首选字段。
- `coding-plans.advanced.defaultReservedOutput` 的默认值为 `60000`，用于全局输出预算；发送请求时会自动按模型上限收敛。
- `coding-plans.vendors[].models[].maxInputTokens` / `maxOutputTokens` 已标记为 deprecated，保留兼容旧配置与特殊覆盖用途。两者仍允许配置为 `0`。其中 `maxInputTokens: 0` 的语义为”未设置”；`maxOutputTokens` 默认值就是 `0`，表示”未设置”；在 `openai-chat` / `openai-responses` 下不主动下发 `max_tokens` / `max_output_tokens`，但当上游协议端点强制要求 `max_tokens` 时需自动补发兼容值。`maxInputTokens` 仍仅用于本地元数据和预算，不直接传给 API。自动刷新/写回 `vendors` 配置时不再默认补入这两个字段；只有用户显式配置的现有模型项会被原样保留。
- 新增采样参数：
  - `coding-plans.vendors[].defaultTemperature` / `defaultTopP`：供应商默认采样值
  - `coding-plans.vendors[].models[].temperature` / `topP`：模型级覆盖值
  - 继承顺序固定为 `models[].temperature/topP` > `vendors[].defaultTemperature/defaultTopP` > 内置默认值 `0.2/1.0`
  - 建议：代码生成/重构优先 `temperature 0.1-0.3`、`topP 1.0`；平衡创造性与稳定性可用 `temperature 0.3-0.5`、`topP 0.9-1.0`
- 需兼容旧字段 `apiStyle`；未配置 `defaultApiStyle`/模型 `apiStyle` 时默认按 `openai-chat` 处理。
- 需继续兼容旧字段 `maxInputTokens` / `maxOutputTokens`；当模型同时提供 `contextSize` 与这两个旧字段时，总上下文窗口优先按 `contextSize` 处理，仅在输入或输出上限超过 `contextSize` 时才收敛。
- `anthropic` 与 `openai-responses` 目前重点覆盖聊天与工具调用；模型发现仍建议使用 `useModelsEndpoint: false` 并手动维护 `models`。
- 请求链路默认优先上游真实流式传输；若兼容供应商明确不支持流式，应自动回退到非流式请求并记录告警日志，不新增单独的 stream 配置开关。
- `capabilities` 现在按必填语义处理；对旧配置要在归一化时自动补齐 `tools=true` 与 `vision=defaultVision`。
- 当 `useModelsEndpoint: true` 时，刷新模型列表只按 `name` 同步增删；设置中已有模型项的 `description`、`temperature`、`topP`、`capabilities`、`contextSize`、`maxInputTokens`、`maxOutputTokens` 等字段应保持原样，新发现模型不应自动写入采样参数，也不应自动写入 `maxInputTokens` / `maxOutputTokens`。
- 若修改协议相关行为，请同步检查：
  - `src/providers/genericProvider.ts`
  - `src/config/configStore.ts`
  - `package.json`
  - `README.md`
  - `README_en.md`
