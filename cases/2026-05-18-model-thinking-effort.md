## 模型独立 Thinking Effort

| ID | Given | When | Then |
| --- | --- | --- | --- |
| A1 | `request.modelOptions.thinkingEffort = none` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "disabled" }`，且不包含 effort 字段 |
| A2 | `request.modelOptions.thinkingEffort = low` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `reasoning_effort: "low"` |
| A3 | `request.modelOptions.thinkingEffort = medium` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `reasoning_effort: "medium"` |
| A4 | `request.modelOptions.thinkingEffort = high` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `reasoning_effort: "high"` |
| A5 | `request.modelOptions.thinkingEffort = xhigh` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `reasoning_effort: "xhigh"` |
| A6 | `request.modelOptions.thinkingEffort = max` | 对该模型发起 `openai-chat` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `reasoning_effort: "max"` |
| A7 | `request.modelOptions.thinkingEffort = high` | 对该模型发起 `openai-responses` 请求 | 上游 payload 包含 `reasoning: { effort: "high" }` |
| A7a | `request.modelOptions.thinkingEffort = max` | 对该模型发起 `openai-responses` 请求 | 上游 payload 包含 `reasoning: { effort: "max" }` |
| A8 | `request.modelOptions.thinkingEffort = max` | 对该模型发起 `anthropic` 请求 | 上游 payload 包含 `thinking: { type: "enabled" }` 与 `output_config.effort: "max"` |
| A9 | `LanguageModelChatInformation` 按 VS Code 1.120 公开接口返回 | 打开 Language Models picker | 模型信息只包含公开 API 定义的字段 |
| A10 | `modelOptions` 同时带有内部 source 标记、`temperature` 与 `thinkingEffort` | adapter 转发请求 | 仅剥离内部 source 标记，保留请求级覆盖项 |
| A11 | `request.modelOptions.thinkingType = default` 且 `thinkingEffort = high` | 对该模型发起 `openai-chat` 请求 | 上游 payload 不包含 `thinking` 字段，可继续包含 `reasoning_effort: "high"` |

```mermaid
sequenceDiagram
    participant Caller as Language Model Caller
    participant Adapter as LMChatProviderAdapter
    participant Provider as GenericAIProvider
    participant Upstream as Vendor API

    Caller->>Adapter: modelOptions.thinkingEffort=max
    Adapter->>Provider: forwarded modelOptions.thinkingEffort=max
    Provider->>Provider: resolve request override
    Provider->>Upstream: thinking + reasoning_effort/output_config.effort
```
