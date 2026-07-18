# 开发指南

## 快速命令

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 代码检查
npm run lint

# 扩展完整测试（unit + VS Code Desktop）
npm test

# 仅运行 VS Code Desktop 冒烟测试
npm run test:desktop

# GitHub Pages 冒烟测试
npm run test:pages

# 打包正式版
npm run package:vsix

# 打包预览版
npm run package:vsix:pre
```

## 扩展测试

| 命令 | 说明 |
| --- | --- |
| `npm run test:unit` | 运行 `src/test/runTest.ts` 里的纯代码回归测试。 |
| `npm run test:desktop` | 通过 `@vscode/test-cli` 调用 `@vscode/test-electron`，首次运行会下载 Stable VS Code Desktop 到 `.vscode-test/`，然后启动隔离测试实例执行 `src/test/suite/**/*.test.ts`。 |
| `npm test` | 先跑 `test:unit`，再跑 `test:desktop`。 |
| `Run Extension Tests` | VS Code 调试入口，读取仓库根目录 `.vscode-test.js`。 |

更多测试分层与执行链路见 [docs/testing.md](docs/testing.md)。

## 打包发布

```bash
npm run package:vsix
```

打包预览版：

```bash
npm run package:vsix:pre
```

发布到插件市场：

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace

# PowerShell
$env:VSCE_PAT=”your_pat”
npm run publish:marketplace
```

发布预览版到插件市场：

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace:pre

# PowerShell
$env:VSCE_PAT=”your_pat”
npm run publish:marketplace:pre
```

说明：`npm run publish:marketplace` 会在发布前自动更新 `CHANGELOG.md`（按当前 `package.json` 版本生成对应条目）。

预发布通道约定：

- 本项目使用 VS Code Marketplace 的同一扩展 `Pre-Release` 通道，不额外拆分扩展 ID。
- 只有在 Marketplace 上已经存在至少一个预发布版本时，用户安装扩展后，才可在扩展详情页的齿轮菜单中切换 `Switch to Pre-Release Version` / `Switch to Release Version`。
- 如果当前详情页没有该入口，说明市场上还没有可切换的预发布包，这通常不是扩展清单问题，而是尚未执行过一次 `publish --pre-release`。
- 预发布版和正式版必须使用不同版本号；建议采用”奇数 minor 预发布、偶数 minor 正式”的约定，例如 `0.7.x` 为预览通道，`0.8.x` 为正式通道。
- `npm run publish:marketplace:pre` 只负责按当前 `package.json` 版本发布为预发布，不会自动修改版本号。

## 提交消息高级配置

在 VS Code `settings.json` 中可配置：

```json
{
  “coding-plans.commitMessage.options”: {
    “prompt”: “FORMAT REQUIREMENT:\nFollow the Conventional Commits format...”,
    “maxDiffLines”: 3000,
    “pipelineMode”: “single”,
    “summaryTriggerLines”: 1200,
    “summaryChunkLines”: 800,
    “summaryMaxChunks”: 12,
    “maxBodyBulletCount”: 7,
    “subjectMaxLength”: 72,
    “requireConventionalType”: true,
    “warnOnValidationFailure”: true,
    “llmMaxPromptLength”: 20000
  }
}
```

## 编码套餐价格抓取

执行 `npm run pricing:fetch` 抓取编码套餐价格，结果写入：

- `assets/provider-pricing.json`（扩展和 GitHub Pages 的统一数据源）

GitHub Pages 部署时会将 `assets/provider-pricing.json` 同步到 `pages/provider-pricing.json` 作为站点构建产物（不入库）。

## OpenRouter 数据抓取

抓取性能数据时，使用环境变量 `APIKEY` 作为 OpenRouter API Key：

```bash
npm run metrics:fetch
```

可选环境变量：
- `OPENROUTER_BASE_URL`：OpenRouter API Base URL（默认 `https://openrouter.ai/api/v1`）。
- `OPENROUTER_MODEL_ORGS`：逗号分隔组织列表（默认 `deepseek,qwen,moonshotai,z-ai,minimax,bytedance,bytedance-seed,kwaipilot,meituan,mistralai,stepfun`）。
- `OPENROUTER_MODEL_LIMIT`：每个组织取最新模型数量（默认 `5`）。
- `OPENROUTER_MODEL_MAX_AGE_DAYS`：仅抓取最近 N 天发布模型（默认 `180`；设为 `0` 表示不过滤发布天数）。
- `OPENROUTER_ENDPOINT_CONCURRENCY`：抓取 endpoints 并发（默认 `4`）。
- `OPENROUTER_REQUEST_TIMEOUT_MS`：请求超时毫秒数（默认 `20000`）。

`metrics:fetch` 采用失败即停止策略：若 endpoint 请求失败、没有抓到 provider endpoint、或所有 endpoint 的 `latency_last_30m` / `throughput_last_30m` 性能分位数均为空，脚本会以非 0 状态退出，且不会覆盖已有的 `assets/openrouter-provider-metrics.json`。OpenRouter latency/throughput 字段需要可查看 endpoint performance metrics 的 API Key；无鉴权或权限不足时通常只会返回 uptime/status。

抓取 OpenRouter 供应商套餐页（用于海外供应商 Tab）:

```bash
npm run openrouter:plans:fetch
```

本地预览 GitHub Pages 看板（静态服务器，默认 `http://127.0.0.1:4173`）：

```bash
npm run serve:page
```

运行 GitHub Pages 冒烟测试（自动启动/复用本地预览服务）：

```bash
npm run test:pages
```

## Copilot Chat Context

- 本扩展不再维护独立的原生 Context Agent。
- 上下文展示直接复用 Copilot Chat 自带的 Context Window / 上下文展示器。
- 相关展示能力与细节以 VS Code / Copilot Chat 当前内置实现为准。
- 关于 Context Window 的实际使用方式、上下文来源和本仓库内的落地建议，见 [docs/copilot-chat-context-window.md](docs/copilot-chat-context-window.md)。
- 关于当前公开 Chat API 的能力边界与后续待跟进项，见 [todo/vscode-chat-api-follow-up.md](todo/vscode-chat-api-follow-up.md)。

## Context 面板语义

- `System Instructions`：指 system prompt、模式说明、策略提示、插件额外注入说明等 System 类输入，占用 prompt tokens。
- `Tool Definitions`：指工具定义本身的 schema 占用，占用 prompt tokens。
- `Reserved Output`：指预留给模型输出的 token 预算，对应 `outputBuffer`，在 UI 中单独显示。
- `Context Window X / Y tokens`：配置了 `contextSize` 时，运行时按总窗口拆分为 80% 输入窗口与 20% 输出窗口，供 VS Code Language Models 汇总显示；未配置 `contextSize` 时使用显式 `maxInputTokens/maxOutputTokens`，且 `Y` 按两者求和对齐原生 custom endpoint 的 Context Window 口径。当前公开 API 只要求扩展实现 `provideTokenCount`，没有提供把上游 usage 明细写回原生 Context Window 的公开接口，因此本仓库不再维护 `X`。
- VS Code 官方文档说明：hover 到上下文窗口控件时，会显示”精确 token 数 / 总上下文”和按类别拆分；上下文满时会触发 compaction。
- 当前实现中，`provideTokenCount()` 固定返回 `0`；不再复用上一轮真实 usage 作为当前请求 token 计数，避免工具续调时过早触发 conversation compaction。
- 若后续 VS Code / Copilot Chat 调整上下文展示结构，应以其内置行为为准同步更新文档描述。
- 当前实现已完全停止本地 prompt token 估算与本地 token 计数；若上游不返回 usage，只能显示”无 usage 数据”，不会再做近似补算。
- 若需要看最近一次真实请求的 usage 比例与明细，以统一状态栏 `CodingPlans` 为准；正文显示简洁百分比，tooltip 合并展示套餐 usage 与 context 明细。
- 若供应商配置了 `coding-plans.vendors[].usageUrl`，`CodingPlans` 会额外展示套餐额度。当前先支持智谱 coding plan usage，已兼容 5 小时额度与 MCP/次数额度两类展示。

## 多协议供应商接入说明

- 配置入口优先使用 `Coding Plans: Manage Vendor Configuration`。该命令从 `coding-plans.vendors` 动态生成供应商 QuickPick，选择供应商后可设置 API Key、刷新模型或打开供应商设置。
- API Key 推荐通过 VS Code Secret Storage 保存；`coding-plans.vendors[].apiKey` 作为已废弃字段保留，非空时优先于 Secret Storage 生效。若当前供应商没有密钥，会按相同 `baseUrl` 从其它 `vendors[].apiKey` 兜底读取。
- VS Code 1.120 起按公开 `LanguageModelChatProvider` 接口直接枚举 provider 模型；当前实现通过 `languageModelChatProviders` contribution 声明 vendor，并在运行时注册 `registerLanguageModelChatProvider('coding-plans', adapter)`，不依赖 `managementCommand`。
- 调试请求链路时，通过 `coding-plans.logLevel` 设置 `Coding Plans` 原生输出通道等级，也可在输出面板使用 Set Log Level 临时调整。日常建议保持 `Info`，详细诊断使用 `Debug`；只有 `Trace` 才会按消息记录 system/user/assistant 文本的前 1000 个字符（不记录 tool 内容和图片数据），日志可能包含敏感上下文。
- `coding-plans.vendors[].defaultApiStyle` 用于声明供应商默认协议风格，模型也可以通过 `coding-plans.vendors[].models[].apiStyle` 单独覆盖：
  - `openai-chat`：请求 `baseUrl + /chat/completions`
  - `openai-responses`：请求 `baseUrl + /responses`
  - `anthropic`：请求 `baseUrl + /messages`
- `coding-plans.vendors[].enableExtraRequestWrapping` 默认 `true`；为 `false` 时仍保留 thinking 参数与 thinking 结果展示，但不再发送 temperature/topP/personality 等插件增强字段，不再做 reasoning/tool continuation round-trip，也不再触发 `/v1`、non-stream、missing max_tokens、unsupported reasoning` 等兼容性自动回退。
- `coding-plans.vendors[].usageUrl` 为可选套餐 usage 接口；当前默认按 `Authorization: Bearer <API Key>` 轮询，并将识别到的小时额度、周额度或次数额度以百分比显示在状态栏。
- `coding-plans.vendors[].models[].contextSize` 是模型总上下文窗口主字段；自动刷新时取 models.dev 的 `limit.context`。同时存在时优先于 `maxInputTokens/maxOutputTokens`，运行时按 `maxInputTokens=80%` 与 `maxOutputTokens=20%` 拆分，避免 VS Code Language Models 把上下文窗口显示为超出总窗口。
- `coding-plans.vendors[].models[].price.inputCost` / `cacheCost` / `outputCost` 是 VS Code Manage Language Models 成本列读取的 Copilot 风格元数据，单位为 credits / 1M tokens。
- `coding-plans.vendors[].models[].toolCalling` / `vision` 是 Copilot 风格能力别名，会归一化到 `capabilities.tools` / `capabilities.vision`。
- `/models` 刷新成功后会优先读取 `https://models.dev/catalog.json`，失败时回退 `https://models.dev/api.json`，只按模型 ID/名称匹配并为新发现模型补全 `description`、`capabilities`、`contextSize`、`price`；匹配时忽略模型名最后路径段中 `:` 后的标记（如 `:free`）；`description` 格式为 `id | Lab | Family | Weights | ReleaseDate`，其中 `Lab` 来自模型 ID 前缀；`capabilities.thinking` 对应 models.dev 的 `reasoning`；价格按所有匹配模型来源取中位数，不使用本地供应商名匹配 models.dev provider；获取失败或无法匹配时保持上游 `/models` 结果和本工程预置值。
- `coding-plans.vendors[].models[].enabled` 默认 `true`；设为 `false` 时模型保留在配置中，但不会进入最终 Language Model 暴露列表，因此不会显示在 VS Code `Manage Language Models` 中。
- 未配置 `maxInputTokens` / `contextSize` 时，扩展默认按 `400000` tokens 输入窗口与 `30000` tokens 输出窗口构建模型，总上下文窗口按两者求和。
- 配置了 `contextSize` 时，扩展按 80%/20% 拆分模型声明的输入/输出窗口；未配置 `contextSize` 时，`maxOutputTokens` 缺省使用 `30000` tokens 默认输出上限。
- `coding-plans.advanced.defaultReservedOutput` 的默认值为 `60000`，用于请求侧输出预算覆盖；发送请求时会自动按模型输出上限收敛，不改变模型声明的 `maxOutputTokens`。
- 新增采样参数：
  - `coding-plans.vendors[].defaultTemperature` / `defaultTopP`：供应商默认采样值；其中 `defaultTemperature` 已标记 deprecated
  - `coding-plans.vendors[].models[].temperature` / `topP`：模型级覆盖值；其中 `temperature` 已标记 deprecated
  - `request.modelOptions.temperature` 仍作为 API 调用方传入的请求级覆盖项；VS Code 1.120 公开模型信息接口不再提供 `configurationSchema` UI 声明
  - 继承顺序固定为 `request.modelOptions.temperature` > `models[].temperature` > `vendors[].defaultTemperature` > 不发送
  - `vendors[].defaultTemperature = null` / 留空表示 vendor 级不设置；`models[].temperature = inherit` 表示使用 vendor 级设置
  - `request.modelOptions.temperature = inherit` 表示继承上级配置，`none` 表示请求中省略 `temperature`；模型行 `More Actions` 不提供 `0`，默认值为 `none`
  - `openai-responses` 请求不发送 `temperature`；模型行 `More Actions` 改为显示 `Personality`，默认 `none` 不注入，选择 `pragmatic` / `friendly` 时写入 `instructions`
  - `topP = 0` 表示请求中省略 `top_p`；模型行 `More Actions` 不提供 `topP` 配置，默认保持留空
  - 建议：编码场景默认保持 `topP 0`；仅当上游明确需要或你想显式控制 nucleus sampling 时再设置为正数
  - `anthropic` 请求仅发送 `temperature`，不发送 `top_p`，以兼容会拒绝同时指定两者的上游
- 新增 thinking effort：
  - effort 具体值仍来自 API 调用方传入的请求级覆盖项；模型级 `capabilities.thinking: false` 会隐藏并禁止发送 thinking/reasoning 参数，`supportsReasoningEffort` 会限制模型行可选项并阻止未声明值进入 payload。
  - `editTools` 默认 `["apply-patch","multi-find-replace","find-replace","code-rewrite"]`，作为 Copilot 风格模型元数据透传到 `capabilities.editToolsHint` 给 VS Code/Copilot 选择编辑工具偏好；本扩展自身不根据该字段筛选请求工具。
  - `reasoningEffortFormat` 与 `zeroDataRetentionEnabled` 作为 Copilot 风格元数据保留；后者不代表上游真实数据保留策略。
  - 继承顺序固定为 request modelOptions > 不发送
  - 协议映射：
    - `openai-chat`：使用 `request.modelOptions.thinkingEffort`，可选 `none` / `low` / `medium` / `high` / `xhigh` / `max`；模型行 `More Actions` 默认值为 `high`；`none` 发送 `thinking: { type: "disabled" }`，其余值发送 `thinking: { type: "enabled" }` 与对应 `reasoning_effort`
    - `openai-responses`：使用 `request.modelOptions.thinkingEffort`，可选 `low` / `medium` / `high` / `xhigh` / `max`；模型行 `More Actions` 默认值为 `max`；发送 `reasoning: { effort }`
    - `anthropic`：使用 `request.modelOptions.thinkingType` 作为开关，`true` 发送 `thinking: { type: "adaptive" }`，`false` 发送 `thinking: { type: "disabled" }`；使用 `request.modelOptions.effort` 发送 `output_config.effort`，可选 `low` / `medium` / `high` / `xhigh` / `max`
  - Moonshot/Kimi Anthropic-compatible 入口在 thinking + tool continuation 场景下可能要求上一条 assistant tool-call 历史消息携带非标准 `reasoning_content`，否则返回 `thinking is enabled but reasoning_content is missing in assistant tool call message`；当前不在 Anthropic 路径实现该字段的 tool continuation 回传，建议关闭 thinking 或改走 `openai-chat` 兼容 API。
- 未配置 `defaultApiStyle`/模型 `apiStyle` 时默认按 `openai-chat` 处理。
- `/models` 自动发现新增模型时会写入推导出的 `models[].apiStyle`：模型自身标识为 OpenAI 或 Grok/xAI 来源时使用 `openai-responses`，仅模型自身标识为 Anthropic 来源时使用 `anthropic`，其它模型使用 `openai-chat`；已有手工模型配置不被刷新覆盖，但 Grok 模型若仍保留旧的 `openai-chat` 会在刷新时自动升级为 `openai-responses`；扩展自动生成的 fallback 描述（如 `供应商名 model: 模型名`）可升级为 models.dev 新结构。
- `anthropic` 与 `openai-responses` 目前重点覆盖聊天与工具调用；模型发现仍建议使用 `useModelsEndpoint: false` 并手动维护 `models`。
- 请求链路默认优先上游真实流式传输；若模型配置 `streaming: false`，直接发送非流式请求。若兼容供应商明确不支持流式，应自动回退到非流式请求并记录告警日志。
- `capabilities` 可省略；归一化时自动补齐 `tools=true` 与 `vision=defaultVision`。
- 当 `useModelsEndpoint: true` 时，刷新模型列表按 `name` 同步增删；设置中已有手工模型项保持原样，不用 `/models` 或 `models.dev` 的结果覆盖。只有模型不存在于 settings 时，才新增并填充 `description`、`capabilities`、`contextSize`、`price` 等自动元数据；若已有项是扩展生成的旧 fallback 结构，则可被新的 models.dev 元数据替换。
- 保存 settings 默认只刷新运行时已配置模型；禁止配置变更监听自动请求 `/models` 或写回 `coding-plans.vendors[].models`。只有手动命令 `Coding Plans: Update Coding Plans Models List` 允许动态发现和写回模型列表。`coding-plans.autoRefreshModels: false` 会进一步禁止 settings/API Key 变化和空模型选择器查询触发自动运行时刷新，但手动刷新命令仍可用。
- 若修改协议相关行为，请同步检查：
  - `src/providers/genericProvider.ts`
  - `src/config/configStore.ts`
  - `package.json`
  - `README.md`
  - `README_en.md`
