# VS Code Chat Context Window 的值是怎么来的

更新时间：2026-04-22

## 一句话结论

`Context Window X / Y tokens` 表示：

| 部分 | 含义 | 来源 |
| --- | --- | --- |
| `Y` | 当前所选模型的总上下文窗口 | 由 VS Code 根据所选模型的上下文能力决定 |
| `X` | 当前这轮对话已经占用的上下文 token | 由 VS Code / Copilot 在运行时把当前请求上下文拼装并计数后得到 |

这个控件本质上是“上下文占用统计”，不是“完整 prompt 明细列表”。

## `Y` 是怎么得到的

官方文档只明确说明一件事：`Context Window` 的分母会随着你切换模型而变化，因为不同模型的 context window 不同。

对自定义模型提供方，VS Code 公开给扩展的模型容量元数据是：

| API 字段 | 含义 |
| --- | --- |
| `maxInputTokens` | 模型最多可接受多少输入 token |
| `maxOutputTokens` | 模型最多可生成多少输出 token |

本仓库里，这两个值的来源链路是：

| 步骤 | 本仓库实现 |
| --- | --- |
| 1. 读取模型配置 | `AIModelConfig.maxTokens` 表示模型总上下文窗口，`maxInputTokens` / `maxOutputTokens` 是拆分值，见 [src/providers/baseProvider.ts](../src/providers/baseProvider.ts) |
| 2. 生成对外模型信息 | `toLanguageModelInfo(...)` 把 `model.maxInputTokens` 和 `model.maxOutputTokens` 暴露给 VS Code，见 [src/providers/lmChatProviderAdapter.ts](../src/providers/lmChatProviderAdapter.ts) |
| 3. VS Code 显示分母 | VS Code 根据当前选中的模型信息显示 `Y` |

所以，对这个仓库来说，`Y` 最终来自模型配置，再通过扩展注册的 `LanguageModelChatInformation` 传给 VS Code。

## `X` 是怎么得到的

官方文档说明，`X` 表示“当前已使用的上下文”，会随着对话推进不断增长；hover 时还能看到按类别拆分的占用。官方还能确认这些上下文来源会参与统计：

| 来源 | 官方说明 |
| --- | --- |
| 系统与指令层 | system prompt、custom instructions 也属于 context window 的一部分 |
| 隐式上下文 | 活动文件、当前选区、文件名会自动带入 |
| 显式上下文 | `#file`、`#codebase`、`#terminalSelection`、`#fetch` 等 |
| 工作区检索结果 | Copilot 会自动做 workspace indexing、search、read、usages 等检索，再把结果带入 |
| 工具结果 | tool outputs、previous tool results 会进入上下文 |
| 会话历史 | conversation history 会进入上下文 |
| 多模态上下文 | 图片、浏览器元素、页面内容等 |
| 历史压缩结果 | 上下文快满时，VS Code 会自动 compact 旧历史，摘要仍继续占用上下文 |

所以，`X` 不是“当前输入框文本长度”，而是“这次请求最终真正送进模型的上下文总量”。

## 这仓库能确认到哪一步

这点最重要：

本仓库不会把“当前这轮响应结束后”拿到的真实 `usage` 实时精确写回 VS Code 原生 `Context Window`。

并且按 2026-04-22 这次对当前 VS Code 源码链路与本扩展运行日志的核对结果，第三方 `LanguageModelChatProvider.provideTokenCount(...)` 也不会驱动原生 `Context Window` 弹层里的 `X`。

能确认的实现如下：

| 位置 | 结论 |
| --- | --- |
| [src/providers/lmChatProviderAdapter.ts](../src/providers/lmChatProviderAdapter.ts) | `provideTokenCount(...)` 固定返回 `0`；既不做本地 prompt token 估算，也不复用上一轮上游 usage 作为当前请求 token 计数 |
| [src/providers/lmChatProviderAdapter.ts](../src/providers/lmChatProviderAdapter.ts) | `reportUsageToProgress(...)` 会读取响应里的 usage |
| [src/providers/lmChatProviderAdapter.ts](../src/providers/lmChatProviderAdapter.ts) | `updateContextUsageState(...)` 会把 usage 缓存到本仓库自己的 `CodingPlans Context` 状态栏状态里 |
| VS Code 源码 `src/vs/workbench/api/browser/mainThreadLanguageModels.ts` / `src/vs/workbench/api/common/extHostLanguageModels.ts` | `provideTokenCount(...)` 只被桥接到 `computeTokenLength(...)` / `countTokens(...)` 能力；本次未找到原生 `Context Window` UI 消费这条路径的源码 |

因此可以明确下结论：

1. VS Code 原生 `Context Window` 的 `X`，不是本仓库把上游 `usage.totalTokens` 原样回填出来的值。
2. 本仓库公开参与原生控件的能力，只有模型元数据和 `provideTokenCount()` 这个估算接口。
3. 现在这里的 `provideTokenCount()` 已固定返回 `0`，避免把上一轮真实上下文占用误当成当前请求 token 计数，进而干扰 VS Code / Copilot 的 compaction 预算。
4. 因此，原生 `Context Window` 里的 `X` 目前仍应视为 VS Code / Copilot 自己的内部上下文拼装统计结果；对第三方 provider，这个值可能保持 `0`。

## 最终结论

如果你只关心“vscode chat 的 context 窗口中的值是如何得到的”，可以直接记这一句：

`Y` 来自当前模型的上下文能力；`X` 来自 VS Code / Copilot 把当前请求要发送的上下文拼起来后做的运行时统计。  
在本仓库里，模型容量由扩展提供给 VS Code；但对第三方 provider，当前并不能依靠 `provideTokenCount()` 或上游 `usage` 去驱动原生 `Context Window` 的 `X`。

## 参考

- VS Code 官方：Manage context for AI  
  https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- VS Code 官方：Chat overview  
  https://code.visualstudio.com/docs/copilot/chat/copilot-chat
- VS Code 官方：How Copilot understands your workspace  
  https://code.visualstudio.com/docs/copilot/reference/workspace-context
- VS Code 官方：Language Model Chat Provider API  
  https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
