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

- 配置：优先 `defaultApiStyle` / `models[].apiStyle`（`openai-chat` | `openai-responses` | `anthropic`），勿在新逻辑里依赖已弃用的 `apiType`。
- `contextSize`：按 80% 输入 / 20% 输出拆分；勿与随意手写的 `maxInputTokens`/`maxOutputTokens` 打架。
- 未加 scope 的 `coding-plans` 根不应在无 group 时向 `selectChatModels` 暴露模型；模型路径为 `coding-plans > vendorName > family`（desktop 冒烟会覆盖）。
- `enableExtraRequestWrapping` 默认开启（`!== false`）；改请求封装行为时对照 `genericProvider.ts` 与厂商实测。

## 校验

```bash
npm run typecheck && npm run lint
# 行为变更
npm test
```