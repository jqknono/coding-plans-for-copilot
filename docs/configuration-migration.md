# 配置一次迁移指南 / Configuration migration

本次更新采用当前字段集合，旧配置需要手动整理。配置读取仅校验并提示路径，原始 settings 保持原样；请分别检查用户、工作区与文件夹作用域。

This update requires a manual configuration migration. Reads validate settings without rewriting them. Review user, workspace, and folder scopes separately. Unknown fields or invalid values trigger a field-path notification: a vendor-level error isolates that vendor, while a model-level error isolates only that model. Other valid entries remain available.

## 迁移步骤 / Steps

1. 在本地备份各作用域的 `coding-plans` 设置；备份中的密钥也应妥善保护。
2. 先确保供应商条目符合当前 schema，再通过 **Coding Plans: Manage Coding Plans Configuration → Set API Key** 为同名供应商保存密钥。密钥仅放入 VS Code Secret Storage；保留供应商名称以延续关联。
3. 按下表整理字段，并检查厂商默认协议与各模型覆盖值。Anthropic 厂商名称、URL 中的 `/anthropic`、`anthropic-version` header 保持原协议要求。
4. 保存后核对模型选择器与新请求预算。需要远端模型同步时，再手动运行 **Update Coding Plans Models List**；这属于显式模型发现写回，与配置校验分开。

Back up settings locally, apply the field mapping below, store each vendor key through Set API Key, then verify model selection and request budgets. Preserve vendor names to retain their Secret Storage association. Keep credential backups private. Remote model discovery remains a separate manual action.

## 字段对照 / Field mapping

路径以 `coding-plans` 为根；模型字段位于 `vendors[].models[]`。

| 旧配置 / Previous setting | 当前操作 / Action |
| --- | --- |
| `vendors[].apiType`、`models[].apiType` | 分别改为 `defaultApiStyle`、`apiStyle`，并采用下方协议值 / Rename to the vendor default or model override. |
| `defaultApiStyle` / `apiStyle` 的 `openai-chat` | 改为 `chat-completions`，请求 `/chat/completions`。 |
| `defaultApiStyle` / `apiStyle` 的 `openai-responses` | 改为 `responses`，请求 `/responses`。 |
| `defaultApiStyle` / `apiStyle` 的 `anthropic` | 改为 `messages`，请求 Anthropic `/messages`；厂商名称、认证 header 和 URL 保持各自语义。 |
| `models[].contextSize` | 删除旧键；总能力改用 `contextWindow`，独立能力使用 `maxInputTokens` / `maxOutputTokens`，实际预算使用 `contextBudget`。 |
| 模型顶层 `thinking` / `toolCalling` / `vision` | 移到 `capabilities.thinking` / `capabilities.tools` / `capabilities.vision`，值使用 boolean。旧数字 `toolCalling` 请按实际能力选 `true` 或 `false`。 |
| `vendors[].apiKey` | 删除 settings 中的密钥字段，通过 Set API Key 保存到 Secret Storage。每个供应商分别保存密钥；相同 `baseUrl` 的 settings 密钥复用机制已移除。 |
| `vendors[].defaultTemperature` / `defaultTopP`；模型 `temperature` / `topP` | 删除。当前上游请求省略采样参数；这些配置项已移除。 |
| 根 `overrideContextWindow` / `overrideMaxOutputTokens` | 删除。复制模型时直接导出解析后的默认输入加输出预算 `P+R` 和输出预算 `R`；通过模型 `contextBudget` 调整。 |
| `commitMessage.prompt` | 将原值手动搬移至 `commitMessage.options.prompt`，再删除旧键。 |
| `commitMessage.maxDiffLines` | 将原值手动搬移至 `commitMessage.options.maxDiffLines`，再删除旧键。 |
| `commitMessage.pipelineMode` | 将原值手动搬移至 `commitMessage.options.pipelineMode`，再删除旧键。 |
| `commitMessage.summaryTriggerLines` | 将原值手动搬移至 `commitMessage.options.summaryTriggerLines`，再删除旧键。 |
| `commitMessage.summaryChunkLines` | 将原值手动搬移至 `commitMessage.options.summaryChunkLines`，再删除旧键。 |
| `commitMessage.summaryMaxChunks` | 将原值手动搬移至 `commitMessage.options.summaryMaxChunks`，再删除旧键。 |
| `commitMessage.subjectMaxLength` | 将原值手动搬移至 `commitMessage.options.subjectMaxLength`，再删除旧键。 |
| `commitMessage.requireConventionalType` | 将原值手动搬移至 `commitMessage.options.requireConventionalType`，再删除旧键。 |
| `commitMessage.warnOnValidationFailure` | 将原值手动搬移至 `commitMessage.options.warnOnValidationFailure`，再删除旧键。 |
| `commitMessage.options.recentStyleMaxTotalLength` | 将原值手动搬移至 `commitMessage.options.llmMaxPromptLength`（整数 ≥ 500），再删除旧键。 |
| `limitSource: "legacy"` | 手工固定能力时改为 `configured`；自动发现维护的来源使用 `endpoint` 或 `models.dev`。 |
| 其它旧根键或未知嵌套键 | 按当前 schema 移除或改写。`logLevel`、`locale`、`autoRefreshModels`、`terminalIntent`、有效提交消息配置与 `vendors` 保留。 |

The only configuration protocol values are `chat-completions`, `responses`, and `messages`. Remove old sampling keys and plaintext vendor keys. Move model capability aliases into `capabilities` with boolean values. Set explicit budgets rather than relying on former aliases or export overrides. Validation performs no automatic migration, alias conversion, or cleanup.

提交消息生成选项仅从 `coding-plans.commitMessage.options` 对象读取，缺省值与生成算法保持原行为。请在各作用域的该对象内手动填写表中目标字段，并保留已有当前字段；旧键读取回退已移除，原始设置由用户手动整理。`commitMessage.language`、`modelVendor`、`modelId`、`useRecentCommitStyle` 与 `showGenerateCommand` 继续使用原有入口。

## 上下文选择 / Context sizing

- `contextWindow=C`：整数 ≥ 2；`maxInputTokens=I`、`maxOutputTokens=O`：整数 ≥ 1。
- `contextBudget.inputTokens=P`、`outputTokens=R` 及 `presets` 成员：整数 ≥ 1。先约束输出，再按已知能力约束输入，满足 `P+R ≤ C`。
- 默认预算为输入 400000、输出 50000，并按已知能力收缩。若需要延续旧使用量，请显式设置预算。
- 对旧 `contextSize=T`，可手动参考原行为：`O=floor(T×0.2)`、`I=T-O`、`P=I`、`R=min(O,50000)`，总能力设为 `T`。各值应满足当前整数下限，并优先采用服务商公布的真实能力。

For an old total window of 160000, the following current configuration explicitly preserves the former 80/20 budget. Verify actual provider limits before adopting it:

```json
{
  "coding-plans.vendors": [
    {
      "name": "my-vendor",
      "baseUrl": "https://api.example.com/v1",
      "defaultApiStyle": "chat-completions",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "my-model",
          "apiStyle": "chat-completions",
          "capabilities": { "tools": true, "vision": false, "thinking": true },
          "contextWindow": 160000,
          "maxInputTokens": 128000,
          "maxOutputTokens": 32000,
          "limitSource": "configured",
          "contextBudget": { "inputTokens": 128000, "outputTokens": 32000 }
        }
      ]
    }
  ]
}
```

## 保留的原生字段 / Native contracts retained

- 原生 provider `configuration.apiKey`：继续作为 Secret Storage 的密钥输入入口。
- 原生请求 `contextSize`：继续表示本次选择的输入预算 `P`。
- 复制到 `chatLanguageModels.json` 的 `apiType`：继续使用原生导出字段，值为 `chat-completions` / `responses` / `messages`。

These native fields remain supported in their own APIs. The removed keys belong to extension settings, rather than native provider configuration, request options, or exported model JSON.

Vendor, model, and `capabilities` schemas reject additional fields. Valid capability, price, streaming, authentication, discovery, reasoning-effort and edit-tool metadata remain available. Refer to the README configuration table and manifest for the complete current schema.
