## Moonshot Anthropic Thinking Tool-Call Compatibility

### 背景

| Topic | Detail |
| --- | --- |
| Affected vendor shape | Moonshot/Kimi Anthropic-compatible endpoints, or proxy endpoints with the same behavior |
| Affected request shape | Anthropic `/messages` + `thinking` enabled + tool calling |
| Error signature | `thinking is enabled but reasoning_content is missing in assistant tool call message` |
| Current decision | 不为 Anthropic 路径默认携带非标准 `reasoning_content` 字段 |

### 原因

部分 Anthropic-compatible 上游在启用 thinking 后，会要求工具调用续轮中的上一条 assistant tool-call 历史消息携带 `reasoning_content`。该字段不是本项目当前 Anthropic 请求结构的一部分；默认发送它可能影响严格遵循 Anthropic `/messages` 协议的端点。

因此，本项目不在 Anthropic 路径中默认实现 `reasoning_content` round-trip，也不新增模型级开关来为特定代理端注入该字段。

### 建议

使用 Moonshot/Kimi 的 Anthropic-compatible 入口时：

- 如果需要继续使用 Anthropic `/messages` 路径，请在模型行 `More Actions` 中将 thinking 设为 `non-think`。
- 如果需要 thinking 能力，请优先改用 Moonshot/Kimi 的 OpenAI Chat 兼容 API，并将供应商或模型的 `apiStyle` 配置为 `openai-chat`。

### 后续扩展边界

若后续要支持该类代理端，需要作为单独需求设计：

- 是否新增显式配置控制非标准 `reasoning_content` 回传。
- 如何解析 Anthropic 响应中的 thinking/reasoning 内容。
- 如何在隐藏 `LanguageModelDataPart` 与本地 tool-call cache 之间保持一致。
- 如何避免影响官方或严格 Anthropic-compatible 端点。
