# Coding Plans for Copilot

**Switch between multiple AI model vendors with one click, breaking Copilot plan limitations.**

Supports major domestic AI vendors such as Zhipu z.ai, Kimi, Volcano Cloud, Minimax, and Alibaba Cloud, as well as **any** vendor compatible with the OpenAI API. No need to change usage habits; seamlessly call directly in VS Code Copilot Chat.

---

## Core Features

- **Unified multi-vendor access**: Supports **any** provider that complies with the OpenAI API specification. Configure once, use anywhere.
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

### Configuration

1. Press `Ctrl+Shift+P`, enter `Coding Plans: Manage Coding Plans Configuration`
2. Select "Select Vendor", choose the platform you have registered with (such as Zhipu AI, Kimi, etc.)
3. Select "Set API Key", paste your API Key
4. Open Copilot Chat (`Ctrl+L`), switch to the "Coding Plans" provider

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
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "glm-4.7",
          "description": "Zhipu GLM-4.7",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "maxInputTokens": 128000,
          "maxOutputTokens": 128000
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

### Configuration Options

| Config Key | Type | Default | Description |
| --- | --- | --- | --- |
| `coding-plans.vendors` | `array` | Built-in vendor template | Vendor configuration list. |
| `coding-plans.vendors[].name` | `string` | Required | Unique vendor name (used for matching and selection). |
| `coding-plans.vendors[].baseUrl` | `string` | Required | Vendor API base URL; can fill in self-built relay station. |
| `coding-plans.vendors[].useModelsEndpoint` | `boolean` | `false` | When `true`, refreshing models will request `/models`. |
| `coding-plans.vendors[].models` | `array` | `[]` | Manual model list. |
| `coding-plans.vendors[].models[].name` | `string` | Required | Model name. |
| `coding-plans.vendors[].models[].description` | `string` | Empty | Model description. |
| `coding-plans.vendors[].models[].capabilities.tools` | `boolean` | `true` | Whether to enable tool calling capability. |
| `coding-plans.vendors[].models[].capabilities.vision` | `boolean` | `false` | Whether to enable vision input capability. |
| `coding-plans.vendors[].models[].maxInputTokens` | `number` | `200000` | Model maximum input tokens. |
| `coding-plans.vendors[].models[].maxOutputTokens` | `number` | `200000` | Model maximum output tokens. |
| `coding-plans.commitMessage.showGenerateCommand` | `boolean` | `true` | Whether to show the "Generate Commit Message" command. |
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

# Watch mode (for development)
npm run watch

# Lint
npm run lint

# Package for release
npm run package:vsix
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
