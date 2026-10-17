---
description: "Use when editing the VS Code extension under src/: LanguageModelChatProvider, vendor config, OpenAI/Anthropic protocol adapters, commit message, or LM model registration."
applyTo: "src/**/*.ts"
---

# 扩展 TypeScript（`src/`）

## 定位

- 通用 **OpenAI Chat / OpenAI Responses / Anthropic** 协议适配，不复制 Copilot 私有 endpoint 字段。
- 北向：`vscode.LanguageModelChatProvider`（`engines.vscode` 见 `package.json`）。
- 南向：各厂商 `baseUrl` + `apiStyle` 对应的路径与流式解析。

## 改前必读

- 架构与配置细节：[DEV.md](../../DEV.md)
- 测试分层：[docs/testing.md](../../docs/testing.md)
- 协议/采样/工具兼容专题：[docs/](../../docs/) 下对应文档

## 易错点

- 配置：仅接受 `defaultApiStyle` / `models[].apiStyle`（`chat-completions` | `responses` | `messages`）；未知字段和枚举值由统一 validator 报告并按厂商或模型隔离。读取保持设置原样，旧字段由用户按发布说明手动迁移。
- 上下文：`contextWindow`、`maxInputTokens`、`maxOutputTokens` 描述模型能力，`contextBudget` 描述默认输入与实际输出预算；原生请求 `contextSize` 仅表示输入选择。统一预算解析负责能力约束。
- 未加 scope 的 `coding-plans` 根不应在无 group 时向 `selectChatModels` 暴露模型；模型路径为 `coding-plans > vendorName > family`（desktop 冒烟会覆盖）。
- 请求路径固定为原生 Custom Endpoint：不发送 temperature / topP / personality；聊天请求不做兼容性隐式重试（`/models` 的 `withOptionalV1Retry` 除外）。改请求构造时对照 `genericProvider.ts` 与厂商实测。

## 校验

```bash
npm run typecheck && npm run lint
# 行为变更
npm test
```