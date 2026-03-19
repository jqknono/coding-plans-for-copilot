# Coding Plans for Copilot

**Switch between multiple AI model vendors with one click, breaking Copilot plan limitations.**

Supports major domestic AI vendors such as Zhipu z.ai, Kimi, Volcano Cloud, Minimax, and Alibaba Cloud, as well as **any** vendor compatible with OpenAI Chat, OpenAI Responses, or Anthropic-style APIs. No need to change usage habits; seamlessly call directly in VS Code Copilot Chat.

---

## Core Features

- **Unified multi-vendor access**: Supports **any** provider that complies with OpenAI Chat, OpenAI Responses, or Anthropic-style API specifications. Configure once, use anywhere.
- **Coding Plans Dashboard**: Visit the [GitHub Page Dashboard](https://jqknono.github.io/coding-plans-for-copilot/) to explore available AI plans and pricing in the market.
- **Model Provider Performance Dashboard**: A new tab on the same page shows provider-level `latency_last_30m` and `throughput_last_30m` for selected models.
- **Zero learning curve**: Fully integrated into VS Code Copilot Chat, no change to any operating habits
- **Flexible model management**: Supports dynamically fetching the `/models` endpoint, and also allows custom model lists and parameters
- **Smart Commit generation**: Automatically generates commit messages that comply with Conventional Commits specification based on Git changes
- **Bilingual support (Chinese/English)**: Automatically switches based on VS Code language settings (default Chinese)
- **Enterprise-grade security**: API Keys are stored locally using VS Code Secret Storage, not uploaded to the cloud or shared

---

## Quick Start

### Installation

**Recommended method**: Search for "Coding Plans" or `Coding Plans for Copilot` directly in the VS Code Marketplace and install.

[Visit VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=techfetch-dev.coding-plans-for-copilot)

### Pre-Release Channel

- This extension supports publishing pre-release builds through the built-in VS Code Marketplace pre-release channel on the same extension listing.
- The gear menu only shows `Switch to Pre-Release Version` after the publisher has actually published at least one pre-release build to Marketplace.
- If the option is missing, it usually means there is currently no live pre-release package for this extension in Marketplace.
- After a pre-release build is published, you can switch with `Switch to Pre-Release Version` / `Switch to Release Version` from the same menu.
- Pre-release builds receive features earlier than stable, but may also include changes that are not fully stabilized yet.

### Configuration

1. Press `Ctrl+Shift+P`, enter `Coding Plans: Manage Coding Plans Configuration`
2. Select "Select Vendor", choose the platform you have registered with (such as Zhipu AI, Kimi, etc.)
3. Select "Set API Key", paste your API Key
4. Open Copilot Chat (`Ctrl+L`), switch to the "Coding Plans" provider

### Copilot Chat Context Viewer

1. Open Copilot Chat normally and use a model provided by this extension
2. Inspect the built-in Context Window / context viewer in Copilot Chat
3. This extension no longer provides a separate Agent entry or custom native context usage reporting
4. Context visualization behavior depends on the current built-in behavior of VS Code and Copilot Chat

### Context Panel Terms

- `System Instructions`: token usage from system-style instructions, such as the system prompt, mode guidance, policy hints, or extra injected instructions. This is part of the prompt token total.
- `Tool Definitions`: token usage from the tool/function schemas sent to the model, including tool names, descriptions, and JSON schema parameters. This is also part of the prompt token total.
- `Reserved Output`: output token budget reserved for the model response. This is not already-generated response text; it is headroom reserved to avoid output-limit overflow.
- `Context Window 4.0K / 400K tokens`: the current chat session has actually used about 4.0K tokens out of roughly 400K total tokens available for the selected model. The numerator is treated as total used context and is aligned to upstream `total_tokens` when available; the denominator comes from `maxInputTokens + maxOutputTokens`.
- When you hover the context window indicator, VS Code shows the exact token count and a category breakdown. When the context window gets full, VS Code might automatically compact conversation history.
- This extension now relies on the built-in Copilot Chat context viewer instead of providing a separate Agent path or custom usage breakdown.

### Configuration Entry

1. Press `Ctrl+Shift+P`, enter `Coding Plans: Manage Coding Plans Configuration`
2. The extension will open the settings page and navigate to `coding-plans.vendors`
3. You can also directly edit `settings.json`

### Basic Configuration Example (settings.json)

```json
{
  "coding-plans.vendors": [
    {
      "name": "zhipu",
      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
      "defaultApiStyle": "openai-chat",
      "defaultTemperature": 0.2,
      "defaultTopP": 1.0,
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "glm-4.7",
          "description": "Zhipu GLM-4.7",
          "temperature": 0.15,
          "topP": 1.0,
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "maxInputTokens": 64000,
          "maxOutputTokens": 64000
        }
      ]
    }
  ],
  "coding-plans.commitMessage.showGenerateCommand": true,
  "coding-plans.commitMessage.language": "zh-cn",
  "coding-plans.commitMessage.options": {
    "pipelineMode": "single",
    "maxBodyBulletCount": 7,
    "subjectMaxLength": 72
  }
}
```

### Anthropic-style Configuration Example

```json
{
  "coding-plans.vendors": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "defaultApiStyle": "anthropic",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "deepseek-chat",
          "temperature": 0.2,
          "topP": 1.0,
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "maxInputTokens": 100000,
          "maxOutputTokens": 100000
        },
        {
          "name": "deepseek-reasoner",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "maxInputTokens": 100000,
          "maxOutputTokens": 100000
        }
      ]
    }
  ]
}
```

### OpenAI Responses-style Configuration Example

```json
{
  "coding-plans.vendors": [
    {
      "name": "openai-responses-demo",
      "baseUrl": "https://api.openai.com/v1",
      "defaultApiStyle": "openai-responses",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "gpt-5",
          "temperature": 0.2,
          "topP": 1.0,
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "maxInputTokens": 200000,
          "maxOutputTokens": 200000
        }
      ]
    }
  ]
}
```

### Configuration Options

| Config Key | Type | Default | Description |
| --- | --- | --- | --- |
| `coding-plans.logLevel` | `string` | `info` | Output-channel log level. Supports `debug` / `info` / `warn` / `error`. Temporarily switch to `debug` when tracing `openai-responses` or similar request flows. |
| `coding-plans.vendors` | `array` | Built-in vendor template | Vendor configuration list. |
| `coding-plans.vendors[].name` | `string` | Required | Unique vendor name (used for matching and selection). |
| `coding-plans.vendors[].baseUrl` | `string` | Required | Vendor API base URL; can fill in self-built relay station. |
| `coding-plans.vendors[].defaultApiStyle` | `string` | `openai-chat` | Default protocol style for the vendor. Supports `openai-chat`, `openai-responses`, and `anthropic`, mapping to `/chat/completions`, `/responses`, and `/messages`. |
| `coding-plans.vendors[].defaultTemperature` | `number` | `0.2` | Vendor-level default temperature. Models inherit it unless overridden. Recommended: `0.1-0.3` for coding/refactoring, `0.3-0.5` for more creative output. |
| `coding-plans.vendors[].defaultTopP` | `number` | `1.0` | Vendor-level default top-p. Models inherit it unless overridden. Recommended: `1.0` for coding, `0.9-1.0` when balancing creativity and stability. |
| `coding-plans.vendors[].models[].apiStyle` | `string` | Inherit vendor | Per-model protocol style; when set, it overrides `defaultApiStyle`. |
| `coding-plans.vendors[].useModelsEndpoint` | `boolean` | `false` | When `true`, refreshing models will request `/models`; refresh only syncs membership by `name` and preserves the other fields of existing model entries. |
| `coding-plans.vendors[].models` | `array` | `[]` | Manual model list; `capabilities` is now required, while legacy configs are backfilled at runtime. |
| `coding-plans.vendors[].models[].name` | `string` | Required | Model name. |
| `coding-plans.vendors[].models[].description` | `string` | Empty | Model description. |
| `coding-plans.vendors[].models[].temperature` | `number` | Inherit vendor/`0.2` | Per-model temperature override with higher priority than `defaultTemperature`. |
| `coding-plans.vendors[].models[].topP` | `number` | Inherit vendor/`1.0` | Per-model top-p override with higher priority than `defaultTopP`. |
| `coding-plans.vendors[].models[].capabilities.tools` | `boolean` | `true` | Whether to enable tool calling capability; runtime backfills legacy configs when missing. |
| `coding-plans.vendors[].models[].capabilities.vision` | `boolean` | `defaultVision` | Whether to enable vision input capability; legacy configs are backfilled from vendor `defaultVision` at runtime. |
| `coding-plans.vendors[].models[].maxInputTokens` | `number` | `396000` | Maximum input token limit for the model; when omitted, a small response reserve is kept. |
| `coding-plans.vendors[].models[].maxOutputTokens` | `number` | `8000` | Maximum output token limit for the model; when omitted, a conservative reserve is used. |
| `coding-plans.commitMessage.showGenerateCommand` | `boolean` | `true` | Whether to show the "Generate Commit Message" command. |

Model `capabilities` is now required. For backward compatibility, the extension backfills `tools=true` and `vision=defaultVision` at runtime when legacy configs omit them. Vendor-level `defaultApiStyle` can also be overridden per model with `apiStyle`. Sampling inheritance is fixed as: `models[].temperature/topP` > `vendors[].defaultTemperature/defaultTopP` > built-in defaults `0.2/1.0`.

| `coding-plans.commitMessage.language` | `string` | `en` | Commit message language, supports `en` / `zh-cn`. |
| `coding-plans.commitMessage.useRecentCommitStyle` | `boolean` | `false` | Whether to reference the style of up to the last 7 commits (use all if fewer). |
| `coding-plans.commitMessage.modelVendor` | `string` | Empty | Vendor name to prioritize when generating commit messages. |
| `coding-plans.commitMessage.modelId` | `string` | Empty | Model name to prioritize when generating commit messages. |
| `coding-plans.commitMessage.options.prompt` | `string` | Built-in prompt | Override generation prompt. |
| `coding-plans.commitMessage.options.maxDiffLines` | `number` | `3000` | Maximum number of lines to read from diff. |
| `coding-plans.commitMessage.options.pipelineMode` | `string` | `single` | Generation pipeline: `single` / `two-stage` / `auto`. |
| `coding-plans.commitMessage.options.summaryTriggerLines` | `number` | `1200` | Diff line count threshold to trigger summary mode. |
| `coding-plans.commitMessage.options.summaryChunkLines` | `number` | `800` | Number of lines per chunk in summary mode. |
| `coding-plans.commitMessage.options.summaryMaxChunks` | `number` | `12` | Maximum number of summary chunks. |
| `coding-plans.commitMessage.options.maxBodyBulletCount` | `number` | `7` | Maximum number of bullet points in the body. |
| `coding-plans.commitMessage.options.subjectMaxLength` | `number` | `72` | Maximum title length. |
| `coding-plans.commitMessage.options.requireConventionalType` | `boolean` | `true` | Whether to enforce Conventional Commits type. |
| `coding-plans.commitMessage.options.warnOnValidationFailure` | `boolean` | `true` | Whether to show warning when validation fails. |
| `coding-plans.commitMessage.options.llmMaxPromptLength` | `number` | `5000` | Maximum prompt length (characters) sent to the model each time; over-limit prompts are truncated with warning. |
| `coding-plans.models` | `array` | `[]` | Advanced fallback: When `/models` is unavailable, serves as an optional model list. |
| `coding-plans.modelSettings` | `object` | `{}` | Advanced fallback: Override token and capability parameters per model. |

`API Key` is not stored in plain text in `settings.json`. Please write it to VS Code Secret Storage via 'Set API Key'.

Note: Multi-protocol support currently focuses on chat and tool calling. For `anthropic` and `openai-responses`, in most cases use `useModelsEndpoint: false` and configure the model list explicitly. Runtime behavior now prefers upstream streaming by default; when a compatible vendor explicitly does not support streaming, the extension transparently falls back to a non-stream request and logs a warning.

## Advanced Features

### Smart Commit Message Generation

1. Press `Ctrl+Shift+P`, enter `Coding Plans: Generate Commit Message`
2. The extension will analyze current Git changes and automatically generate a compliant commit message
3. You can select the model to use (by default uses the currently configured vendor)

### Multi-workspace Independent Configuration

Vendor configurations can be saved per workspace/folder; API Keys are saved by vendor name in VS Code Secret Storage (local).

### Dashboard (Pricing + Model Performance)

Visit [GitHub Pages Plan Dashboard](https://jqknono.github.io/coding-plans-for-copilot/):
- `Plan Pricing` tab: pricing and update time for coding plans.
- `Model Provider Performance` tab: OpenRouter provider-level latency/throughput for selected models (last 30 minutes), with filters for organization/model/provider.
- `p50/p90/p99` are shown in table columns with percentile explanations.
- Performance data is scheduled daily at `16:00` Beijing time.

Use environment variable `CODING_PLANS_FOR_COPILOT` as the OpenRouter API key when fetching metrics:

```bash
npm run metrics:fetch
```

Optional environment variables:
- `OPENROUTER_MODEL_ORGS`: comma-separated organization list (default `deepseek,qwen,moonshotai,z-ai,minimax,bytedance,bytedance-seed,kwaipilot,meituan,mistralai,stepfun`).
- `OPENROUTER_MODEL_LIMIT`: latest model count per organization (default `5`).
- `OPENROUTER_MODEL_MAX_AGE_DAYS`: only fetch models published in the last N days (default `90`, set `0` to disable age filtering).

---

## Development Guide

For detailed development documentation, see [DEV.md](DEV.md)

### Quick Commands

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Lint
npm run lint

# GitHub Pages smoke tests
npm run test:pages

# Package stable
npm run package:vsix

# Package pre-release
npm run package:vsix:pre
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version update details.

---

## Feedback

- **Feature suggestions**: Submit an [Issue](https://github.com/jqknono/coding-plans-for-copilot/issues)
- **Usage issues**: Include error logs and relevant configuration snippets from `settings.json` (with sensitive information redacted) in the Issue
- **Vendor integration**: Pull Requests are welcome

---

## License

MIT License

---

## Contributing Guide

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Submit a Pull Request
