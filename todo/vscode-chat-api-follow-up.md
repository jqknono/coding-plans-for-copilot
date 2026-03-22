# VS Code Chat API Follow-up

更新时间：2026-03-22

## TODO

- 当前结论：不再尝试通过 `provideTokenCount` 回填 VS Code 原生 `Context Window` 分子。
- 当前原因：公开的 VS Code Chat / Language Model 扩展 API 没有提供把上游真实 usage 明细写回原生 Context Window 的公开接口。
- 当前策略：`provideTokenCount` 固定返回 `0`；最近一次已完成请求的真实 usage 只显示在状态栏 `CodingPlans Context`。
- 后续触发条件：如果 VS Code 未来公开以下任一能力，再重新评估并恢复原生 Chat 集成。
  - 原生 Context Window usage 上报接口
  - 原生 prompt/completion/total/outputBuffer 明细上报接口
  - 明确支持从扩展向 Chat UI 回写真实 request usage 的公开 API

## 关联到本仓库的判断

- 仓库当前使用的是 `vscode.lm.registerLanguageModelChatProvider(...)` 接入模型。
- 公开 API 文档明确要求实现 `provideLanguageModelChatResponse(...)` 和 `provideTokenCount(...)`，但没有公开“response usage 上报”接口。
- 公开文档说明原生 Context Window 会显示 token 总量和分类明细，并随会话增长更新；但文档没有给扩展作者提供对应的 usage 写回方式。
- 由此推断：对于第三方 `LanguageModelChatProvider`，扩展目前只能提供模型信息、响应流和 token 计数，不能把上游 API 返回的 usage 明细正式注入到原生 Chat 的上下文用量 UI 中。

这是一条基于官方公开文档的工程推断，不是来自某一页文档的直接声明。

## 已收集官方文档

### 1. Language Model Chat Provider API

- URL: https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
- 关键信息：
  - 该接口用于“把你自己的语言模型贡献到 VS Code chat”。
  - 文档列出的 provider 责任包括：发现模型、处理 chat 请求、提供 token counting。
  - 文档要求实现的核心方法是：
    - `provideLanguageModelChatInformation`
    - `provideLanguageModelChatResponse`
    - `provideTokenCount`
  - 文档没有给出任何“usage 上报到原生 Context Window”的方法。
- 备注：
  - 页面还注明：通过该 API 提供的模型“目前仅对 individual GitHub Copilot plans 用户可用”，这也是产品侧能力边界的一部分。

### 2. VS Code API Reference

- URL: https://code.visualstudio.com/api/references/vscode-api
- 关键信息：
  - `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` 是公开注册入口。
  - `LanguageModelChatProvider` 公开方法只有：
    - `provideLanguageModelChatInformation(...)`
    - `provideLanguageModelChatResponse(..., progress, ...)`
    - `provideTokenCount(...)`
  - `progress` 的公开类型是 `Progress<LanguageModelResponsePart>`，文档只说明它用于输出响应流片段。
  - API Reference 中没有公开 `promptTokens`、`completionTokens`、`totalTokens`、`outputBuffer` 之类的 response usage 回传入口。

### 3. Chat Participant API

- URL: https://code.visualstudio.com/api/extension-guides/ai/chat
- 关键信息：
  - VS Code 确实公开了 Chat Participant API，扩展可以通过 `vscode.chat.createChatParticipant(...)` 创建 `@participant`。
  - 这套 API 适合做“参与者/代理”扩展，不等同于给原生 Context Window 注入 usage 数据。
- 对本仓库的意义：
  - “VS Code Chat 完全没有开放 API”这个说法不准确。
  - 更准确的说法是：公开了 Chat Participant 和 Language Model Provider API，但没有公开我们当前需要的原生 usage/context 写回 API。

### 4. Manage context for AI

- URL: https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- 关键信息：
  - 官方文档说明聊天输入框会显示 Context Window 控件。
  - hover 时会显示精确 token 数 / 总上下文和分类拆分。
  - 随着对话继续，这个控件会更新；分母随所选模型上下文窗口变化。
  - 上下文满时会自动 compaction。
- 对本仓库的意义：
  - 这是用户侧行为文档，不是扩展侧写回接口文档。
  - 文档描述了 UI 能显示什么，但没有说明第三方扩展如何上报这些 usage 明细。

## 后续跟进建议

1. 每次升级 VS Code API 时，优先检查：
   - `LanguageModelChatProvider`
   - `Progress<LanguageModelResponsePart>`
   - Chat / AI extensibility release notes
2. 若公开 API 新增 usage/context 上报能力：
   - 恢复原生 Context Window 分子维护
   - 评估是否可以移除或降级 `CodingPlans Context` 状态栏
   - 同步更新 `README.md`、`README_en.md`、`DEV.md`、`docs/copilot-chat-context-window.md`
3. 若仍无公开 API：
   - 继续保持 `provideTokenCount = 0`
   - 继续以状态栏承载最近一次真实 usage
