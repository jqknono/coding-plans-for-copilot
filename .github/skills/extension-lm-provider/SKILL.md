---
name: extension-lm-provider
description: "改 VS Code 语言模型提供商、多协议请求/流解析、工具调用、thinking、models.dev 发现或 Commit Message。Use when: genericProvider, lmChatProviderAdapter, coding-plans.vendors, apiStyle, anthropic/openai 兼容。"
argument-hint: "可选：厂商、协议、issue 或 cases 文件名"
---

# 扩展 LM Provider 工作流

## 何时使用

- 修协议兼容、流式解析、工具 schema、采样参数（top_p/temperature/thinking）、模型发现或桌面冒烟失败。

## 阅读顺序

1. `src/providers/lmChatProviderAdapter.ts` — VS Code 边界
2. `src/providers/genericProvider.ts` — 请求与模型生命周期
3. `src/providers/genericProviderProtocols.ts` — 分协议解析
4. `src/config/configStore.ts` — 设置归一化

## 专题文档（按需打开，勿整篇抄进 PR 说明）

- [docs/anthropic-tool-schema-sanitization.md](../../../docs/anthropic-tool-schema-sanitization.md)
- [docs/deepseek-thinking-mode-roundtrip.md](../../../docs/deepseek-thinking-mode-roundtrip.md)
- [docs/top-p-zero-omit-request.md](../../../docs/top-p-zero-omit-request.md)
- [cases/](../../../cases/) 中与当前 bug 同名的 md

## 校验

```bash
npm run typecheck && npm run lint
npm test
```

新行为优先补 `src/test/runTest.ts` 回归；涉及模型列表/可见性时确认 `npm run test:desktop`。