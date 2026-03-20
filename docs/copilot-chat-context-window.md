# VS Code Copilot Chat Context Window 使用说明

更新时间：2026-03-19

## 一句话结论

`Context Window` 不是一个让你手动编辑“当前上下文内容”的面板，而是一个“当前这轮对话已经塞进了多少上下文”的使用量指示器。真正决定上下文内容的入口，是聊天里的隐式上下文、`#` 引用、`@` 参与者、自定义指令、prompt files、图片、浏览器元素和对话历史。

## Context Window 里通常有什么

根据 VS Code 官方文档，Copilot Chat 会把下面几类信息拼进当前请求：

- 隐式上下文：当前选中的代码、当前文件名；在部分模式下还会自动考虑活动文件。
- 显式上下文：通过 `#` 主动附加的文件、文件夹、符号、`#codebase`、终端输出、网页内容等。
- 参与者与工具：通过 `@` 选择的 chat participant，以及该参与者可用的工具定义。
- 自定义指令：`.github/copilot-instructions.md`、`*.instructions.md`、`AGENTS.md`、用户级或组织级 instructions。
- Prompt files：`*.prompt.md`，通常通过 `/你的命令名` 运行。
- 多模态上下文：图片、浏览器元素、集成浏览器页面。
- 会话历史：当前聊天的历史消息，以及历史过长后压缩出来的摘要。
- 输出预留：为了避免本轮回答超限，系统会预留一部分 token 给模型输出。

你在悬浮 `Context Window X / Y tokens` 时看到的分类拆分，本质上就是这些来源的占用统计。

## 这东西应该怎么用

### 1. 把它当成“上下文预算表”，不是“内容编辑器”

看见占用上涨，说明你当前这次对话携带的信息在变多。它适合回答两个问题：

- 现在这轮对话是否已经装了太多无关历史？
- 我还要不要继续往里塞文件、图片、网页，还是应该先压缩/开新会话？

不适合的用法是：盯着这个面板猜“为什么模型一定看到了某一段代码”。因为它显示的是预算和分类，不是完整逐项清单。

### 2. 优先用 `#` 精确喂上下文

如果问题和代码直接相关，优先用精确上下文，而不是一句笼统自然语言让 Agent 自己猜：

- 单文件问题：直接选中代码，再补一个 `#对应文件`
- 多文件链路问题：`#入口文件 #调用方文件 #相关配置文件`
- 仓库级问题：明确写 `#codebase`
- 终端报错：附加终端输出
- 最新外部文档：直接贴 URL，或者加 `#fetch`

官方文档还特别提到：附加文件时，能放下就传完整文件；放不下时会退化成文件大纲；大纲还放不下时，这个文件可能根本不会进 prompt。也就是说，“提到了文件名”不等于“完整源码一定进了上下文”。

### 3. 用 `@` 决定“谁来回答”，不要把它和 `#` 混在一起理解

- `#` 是给模型补材料
- `@` 是指定由哪个 participant 处理问题

例如：

- `@vscode 如何开启自动保存`
- `@terminal 当前目录最大的 5 个文件是什么`

如果你问的是仓库代码本身，重点还是先把代码上下文喂准，而不是只切 participant。

### 4. 稳定规则放 instructions，重复流程放 prompt files

如果某些约束每次都要生效，不要每轮聊天重复粘贴，应该落到文件：

- 项目级统一规则：`.github/copilot-instructions.md`
- 目录或语言特定规则：`*.instructions.md`
- 多代理共享规则：`AGENTS.md`
- 可复用工作流：`*.prompt.md`

官方建议也很明确：

- 全项目共用规范，优先放 `.github/copilot-instructions.md`
- 多代理场景，使用 `AGENTS.md`
- 某类任务反复出现，做成 prompt file，用 `/命令名` 触发

这几类文件会直接影响 Copilot Chat 的上下文组成，所以它们比“手动在聊天里反复解释一遍”更稳定。

### 5. UI / 页面问题，不要只发文字

如果问题和前端界面有关，优先附加：

- 截图
- 浏览器元素
- 集成浏览器页面

官方文档支持把集成浏览器里的元素直接加进 Chat，上下文里可以包含 HTML、CSS，必要时还能带图片。对布局问题、样式问题、交互问题，这比“描述页面长什么样”有效得多。

### 6. 当上下文快满时，主动压缩或开新会话

官方文档说明，Context Window 快满时 VS Code 会自动做 compaction，也就是把更早的对话压缩成摘要。

你的可操作手段有两个：

- 输入 `/compact`，必要时补一句压缩重点，例如 `/compact focus on the provider config changes`
- 直接开始新会话

经验上：

- 还在同一个问题链路里，但历史有噪音：用 `/compact`
- 任务已经换题：直接开新会话

## 结合本仓库应该怎么理解

### 1. 本扩展复用的是 VS Code 内置 Context Window

本仓库没有再维护一套独立的原生 Context Agent 展示。用户在聊天框里看到的 `Context Window`、hover 后的 token 拆分、compact 行为，都以 VS Code / Copilot Chat 当前内置实现为准。

### 2. 分母大小依赖模型上下文配置

在这个仓库里，模型上下文参数来自供应商/模型配置。代码里会把总上下文、最大输入、最大输出做归一化处理：

- 当显式提供总上下文和输入/输出上限时，按显式值使用
- 只提供部分字段时，会推导剩余部分
- 没配时，会回退到默认值

因此，如果供应商模型的 `contextSize`、`maxInputTokens`、`maxOutputTokens` 配置不准确，Copilot Chat 里看到的 `X / Y tokens` 也可能与真实模型能力不一致。本仓库当前推荐用 `contextSize` 作为描述模型上下文的主字段；`maxInputTokens` / `maxOutputTokens` 仅保留兼容旧配置。运行时会优先使用 `contextSize` 作为总上下文窗口；只有当 `maxInputTokens` 或 `maxOutputTokens` 超过它时，才会自动收敛到 `contextSize`。

### 2.5 分子按“已用总上下文”理解更直观

本仓库现在会优先使用上游返回的 `total_tokens` 作为“当前轮已用总上下文”。

- 对 `openai-chat`：优先使用 `total_tokens`
- 对 `openai-responses`：优先使用 `total_tokens`
- 对 `anthropic`：回退为 `input_tokens + output_tokens`

如果上游同时返回了 `prompt/input`、`completion/output` 和 `total_tokens`，且两者不一致，会以 `total_tokens` 为准做归一化，确保显示比例更符合“当前已经占了多少上下文”的直觉。

同时，本仓库已经停止本地 prompt token 估算和本地 token 计数。如果上游接口没有返回 usage，扩展不会再自行补一个估算值。

### 3. 对这个项目最实用的上下文组织方式

处理这个仓库的典型问题时，建议这样喂上下文：

- 改 provider 行为：附加 `#src/providers/...` 和相关配置读取代码
- 改设置项：附加 `#src/config/configStore.ts #package.json #README.md #DEV.md`
- 改文档说明：附加 `#README.md #README_en.md #DEV.md`
- 查某个模型上下文窗口为什么显示不对：附加模型配置 + `#src/providers/baseProvider.ts #src/config/configStore.ts`

不要一上来就无差别 `#codebase`。只有在确实是跨模块机制问题时，才需要整仓上下文。

## 排查建议

如果你怀疑“为什么某条 instructions / prompt 没生效”，官方建议直接看 Chat 诊断信息：

1. 在 Chat 视图里右键
2. 选择 `Diagnostics`
3. 检查已加载的 instruction files、prompt files 和错误信息

这比只盯着 `Context Window` 数字更有效，因为后者只能告诉你“用了多少”，不能告诉你“具体哪份规则没被加载”。

## 官方文档

- VS Code: Manage context for AI
  https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context
- VS Code: Chat overview
  https://code.visualstudio.com/docs/copilot/chat/copilot-chat
- VS Code: Use custom instructions in VS Code
  https://code.visualstudio.com/docs/copilot/customization/custom-instructions
- VS Code: Use prompt files in VS Code
  https://code.visualstudio.com/docs/copilot/customization/prompt-files
