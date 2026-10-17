# Copilot Chat 上下文窗口与请求预算

更新时间：2026-10-18

## 能力、预算与选择

| 层级 | 字段 | 当前语义 |
| --- | --- | --- |
| 模型能力 | `contextWindow=C` | 输入与输出共享的总能力 |
| 模型能力 | `maxInputTokens=I` / `maxOutputTokens=O` | 独立输入、输出能力；与预算分离 |
| 能力来源 | `limitSource` | `configured` 保留显式能力；`endpoint` / `models.dev` 可随发现刷新，保留预算 |
| 默认策略 | `contextBudget.inputTokens` / `outputTokens` | 默认输入 `P` / 实际输出 `R`；初始为 400000 / 50000，受已知能力约束 |
| 输入档位 | `contextBudget.presets` | 数字输入档位，默认 32000/64000/128000/256000/512000，另有默认/最大 |
| 宿主选择 | 请求级 `contextSize` | VS Code 按模型保存所选输入 `P`，与旧配置字段 `models[].contextSize` 分离 |

先按输出能力与总容量确定 `R`，再确定 `P ≤ min(I,C-R)`。能力字段保留来源值，用户选小预算后能力仍可用于选择更大档位。未知能力仅采用已知约束。

原生模型信息注册 `maxInputTokens=min(I,C-R)` 作为可选输入上限、`maxOutputTokens=R`，并通过隐藏字段 `maxContextWindowTokens=C` 适配总能力。`schema.contextSize` 为 `type: number`、`group: tokens`，默认值为解析后的默认输入 `P`。UI 有效窗口为受 `C` 约束的 `P+R`。

`R` 是线上请求的输出预算：OpenAI Chat / Anthropic 发送 `max_tokens`，OpenAI Responses 发送 `max_output_tokens`。

## 原生 Context Window 与状态栏

- 原生 `Context Window X / Y` 中，`Y` 按所选输入预算加输出预留计算，并受总能力约束；`X` 由 VS Code / Copilot 拼装当前上下文并统计。
- System Instructions、Tool Definitions、会话历史、文件与检索内容、工具结果等均属于输入上下文。
- `provideTokenCount()` 当前委托模型对本次文本或消息做本地估算；其职责是 token 计数，而非上游 response usage 上报。估算接口与最近完成请求的真实 usage 分开维护。
- 公开 `LanguageModelChatProvider` / 响应 progress API 尚无将上游真实 usage 分类明细写回原生控件的契约。原生分子仍由宿主管理，扩展状态栏单独展示真实请求统计。

统一 `CodingPlans` 状态栏使用**最近完成请求**的预算快照和上游 usage：

| 项目 | 计算方式 |
| --- | --- |
| 输入 | `promptTokens / P` |
| 生成 | `completionTokens / R` |
| 占用 | `promptTokens + max(R,completionTokens)` |
| 有效分母 | `P+R` |
| 占用比例 | `占用 / (P+R)`，保留超过 100% 的结果 |

输出预留与已生成内容取较大值，避免重复相加；超限数值保留真实结果。上游缺少 usage 时显示缺失状态，本地估算仅服务计数接口。配置 `usageUrl` 后还会显示套餐额度。

## 当前配置契约

- “模型能力”使用 `contextWindow`、可选独立输入 `maxInputTokens`、输出 `maxOutputTokens`；“使用策略”使用 `contextBudget` 或原生选择器。总容量为整数 ≥ 2，独立能力及预算为整数 ≥ 1。
- `limitSource` 允许 `configured`、`endpoint`、`models.dev`。手工固定能力时使用 `configured`；发现来源可刷新能力并保留预算。补全隐藏此元数据，`contextBudget` 提供 64K/16K 示例，运行时默认策略为 400000/50000。
- 配置读取仅校验，原文保持原样。未知字段或无效值会弹窗提示字段路径；供应商级错误隔离供应商，模型级错误仅隔离该模型，其余有效项继续使用。
- 旧配置由用户按[一次迁移说明](configuration-migration.md)手动调整；保存、启动与读取均采用当前字段契约。
- 复制到 `chatLanguageModels.json` 时导出默认 `P+R` / `R`，保留原生 `apiType`。原生 provider `configuration.apiKey` 写入 Secret Storage，原生请求 `contextSize` 继续表示所选输入预算。
- 即使 `autoRefreshModels: false`，保存 settings/API Key 后本地模型仍即时重建；远端发现及模型列表写回由手动更新命令执行，与纯校验路径分开。

## 宿主适配与验收边界

最低宿主为 VS Code `1.142.0`，类型依赖保留 `@types/vscode ^1.120.0`。原生集成含未公开运行时字段适配，其稳定性以当前宿主实现为依据。

2026-10-17 静态核实当前安装宿主 `1.142.0`（提交 `6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`）：

- Workbench 支持数字 `contextSize`、模型配置默认值和 `tokens` 分组；总窗口逻辑支持 `min(maxContextWindowTokens, P+R)`。
- Extension Host 的模型信息桥接保留 `maxContextWindowTokens` 与 `configurationSchema`。
- 随宿主打包的 Copilot 包含原生 Context Size schema；第三方语言模型包装器的 `maxOutputTokens` getter 固定为 `8192`，形成内部输出预留限制。

**以上仅为静态核实，尚未 UI 手动验收。** 原生 UI 分母、Copilot compaction 预算和实际请求输出 `R` 应分别观察，等价性尚待验证。

## 参考与后续

- [Chat API 调查与待验收项](../todo/vscode-chat-api-follow-up.md)
- [VS Code：Manage context for AI](https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context)
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [本仓库适配器](../src/providers/lmChatProviderAdapter.ts)、[预算解析](../src/providers/contextBudget.ts)
