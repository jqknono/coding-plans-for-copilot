# VS Code Chat API 调查与跟进

更新时间：2026-10-18

## 当前结论

- 最低宿主提升至 VS Code `1.142.0`；`@types/vscode` 保留 `^1.120.0`。
- 已静态核实当前安装的 1.142.0 宿主支持数字 `schema.contextSize`（`group: tokens`）、模型选择持久化路径及隐藏 `maxContextWindowTokens` 桥接。原生有效分母按所选输入 `P` 加输出 `R` 计算，受总能力 `C` 约束。
- 此集成含未公开运行时字段适配，证据来自当前 Workbench、Extension Host 与随宿主打包的 Copilot 源码，公开 API 的稳定性保证仅覆盖其已公开部分。**尚未 UI 手动验收。**
- 第三方 Copilot 包装器内部 `maxOutputTokens` getter 固定为 `8192`，形成内部输出预留限制；原生 UI、compaction 与上游请求预算的等价性仍待实测。
- `provideTokenCount()` 当前执行本地文本/消息估算，已替代旧版固定 `0` 行为。它是当前输入的 token 计数接口，与上游响应 usage 上报分离。
- 公开 `LanguageModelChatProvider` / `Progress<LanguageModelResponsePart>` 尚无写回真实 prompt/completion/total/outputBuffer 明细的契约。最近完成请求的真实 usage 继续由 `CodingPlans` 状态栏承载。

## 当前仓库契约

- 能力：`contextWindow=C`、独立输入/输出能力、`limitSource`；预算：`contextBudget { inputTokens, outputTokens, presets }`。
- 原生选择：数字输入 `P`，默认值来自默认输入预算；默认数字档位 32k/64k/128k/256k/512k，另有默认/最大，由宿主保存选择。
- 模型信息：可选输入上限 `min(I,C-R)`、输出 `R`、隐藏总能力 `C`。
- 统计：最近完成请求输入 / `P`、生成 / `R`，占用 `prompt+max(R,completion)`，分母 `P+R`，保留超限值。
- 关闭自动刷新仍即时本地重建预算；远端发现继续由手动更新命令执行。

## 配置契约与协作收尾

- 协议唯一值为 `chat-completions` / `responses` / `messages`，分别对应 OpenAI Chat、OpenAI Responses、Anthropic Messages。
- 校验仅报告路径并隔离相关供应商或模型；配置原文保持原样，旧键由用户按[迁移指南](../docs/configuration-migration.md)手动处理。
- 原生 provider `configuration.apiKey`、请求级 `contextSize` 和复制导出的 `apiType` 保留各自契约。
- [ ] 配置 agent 将 `maxInputTokens` / `maxOutputTokens` 校验下限对齐为 `1`，`contextWindow` 维持 `2`。
- [ ] 配置 agent 从根规则移除 `commitMessage.options.recentStyleMaxTotalLength`，与 manifest 的当前允许字段集合对齐。
- [ ] 在能力 `C=2`、`I=1`、`O=1` 和预算 `1/1` 的正向配置中，核对 schema 与运行时均接受该值。
- [ ] 在用户、工作区、文件夹作用域保存当前合法配置，确认读取保留原文、各有效模型可选，并核对手动迁移后的预算。

## 待配合 UI 验收

- [ ] 在 VS Code 1.142 中查看模型 Context Size，确认默认/最大与数字档位，以及 schema 默认输入值。
- [ ] 切换模型后恢复选择，确认宿主保存的 `P` 与下一次请求预算一致。
- [ ] 对照原生分母、请求日志 `R` 和状态栏 `P+R`，分别记录 UI、compaction 与第三方包装器 8192 预留的表现。
- [ ] 关闭 `autoRefreshModels` 后编辑本地预算，确认新请求即时使用新值；通过手动更新命令核对远端发现。

## 后续触发条件

升级宿主或 Copilot 时复核数字 schema、隐藏总窗口桥接、配置持久化及第三方包装器输出预留；若公开 API 增加 usage/context 明细上报，再评估原生统计接入及状态栏职责。

同步维护 [上下文说明](../docs/copilot-chat-context-window.md)、双语 README 与 DEV.md，保持本地估算、真实 usage 和宿主 UI 三层职责清晰。

参考：[Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)、[API Reference](https://code.visualstudio.com/api/references/vscode-api)、[Manage context](https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context)。
