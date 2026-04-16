# Coding Plans for Copilot

**Switch between multiple AI model vendors with one click, breaking Copilot plan limitations.**

Supports domestic major vendors like Zhipu, Kimi, iFlytek, Volcano Cloud, Minimax, Baidu Qianfan, Tencent Cloud, JD Cloud, Kuaishou KAT, X-AIO, Compshare, Alibaba Cloud, Infini, Qiniu, as well as **any** vendor compatible with OpenAI Chat, OpenAI Responses, or Anthropic API styles. No need to change usage habits; seamlessly call directly in VS Code Copilot Chat.

---

## Core Features

- **Multi-Protocol Unified Access**: Supports OpenAI Chat (`/chat/completions`), OpenAI Responses (`/responses`), and Anthropic (`/messages`) three protocol styles, adapting to any compatible vendor.
- **Claude Code Priority Endpoint**: Built-in vendors default to Anthropic-compatible endpoints, compatible with both Claude Code and Copilot Chat.
- **Zero Learning Curve**: Fully integrated into VS Code Copilot Chat without changing any operational habits.
- **Flexible Model Management**: Supports dynamic fetching from `/models` endpoint, or custom model lists.
- **Intelligent Commit Generation**: Automatically generates Conventional Commits-compliant commit messages based on Git changes.
- **Coding Plans Dashboard**: Visit [GitHub Pages Dashboard](https://jqknono.github.io/coding-plans-for-copilot/) to view monthly fees and benefits from multiple coding plans, as well as OpenRouter vendor performance metrics.
- **Key Security**: API Keys are stored locally using VS Code Secret Storage, not uploaded to the cloud or shared.

---

## Quick Start

### Installation

**Recommended Method**: Search "Coding Plans" or `Coding Plans for Copilot` directly in the VS Code Marketplace.

#### Method 1: Install within VS Code (Recommended)

1. Open VS Code
2. Press `Ctrl+Shift+X` to open the Extensions panel
3. Type `Coding Plans for Copilot` or `编码套餐` in the search box
4. Click **Install** to install
5. After installation, press `Ctrl+Shift+P` and type `编码套餐` to see related commands

#### Method 2: Command Line Installation

```bash
code --install-extension techfetch-dev.coding-plans-for-copilot
```

#### Method 3: Install from Marketplace Page

👉 [VS Code Marketplace Direct Link](https://marketplace.visualstudio.com/items?itemName=techfetch-dev.coding-plans-for-copilot)

Click the **Install** button on the marketplace page, which will automatically open the extension in VS Code and install it.

> **Prerequisites**: Requires VS Code ≥ 1.109.0 and the [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension installed.

### Configuration

1. Press `Ctrl+Shift+P`, type `编码套餐: 管理编码套餐配置`
2. Select "Select Vendor", choose the platform you've registered with (e.g., Zhipu, Kimi, Volcano Engine, etc.)
3. Select "Set API Key", paste your API Key
4. Open Copilot Chat (`Ctrl+L`), switch to "Coding Plans" provider

You can also directly edit `settings.json`; the extension will open settings and navigate to `coding-plans.vendors`.

### Built-in Vendor Endpoints

The following vendors come with built-in default configurations and are ready to use after installation:

| Vendor | Default Endpoint (Anthropic) | OpenAI Compatible Endpoint |
| --- | --- | --- |
| Zhipu (zhipu) | `https://open.bigmodel.cn/api/anthropic/v1` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| z.ai | `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/coding/paas/v4` |
| Volcano Engine | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| Volcengine Overseas | `https://ark.ap-southeast.bytepluses.com/api/coding` | `https://ark.ap-southeast.bytepluses.com/api/coding/v3` |
| MiniMax Mainland | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` |
| MiniMax Overseas | `https://api.minimax.io/anthropic` | `https://api.minimax.io/v1` |
| Kimi Mainland | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` |
| Kimi Overseas | `https://api.moonshot.ai/anthropic` | `https://api.moonshot.ai/v1` |
| Alibaba Cloud (Aliyun) | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | `https://coding.dashscope.aliyuncs.com/v1` |
| Tencent Cloud | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | — |
| Infini (无问芯穹) | `https://cloud.infini-ai.com` | — |
| Qiniu (七牛) | `https://api.qnaigc.com` | — |
| OpenRouter | `https://openrouter.ai/api` | `https://openrouter.ai/api/v1` |

To switch to OpenAI-compatible endpoints, modify the vendor's `baseUrl` and `defaultApiStyle`.

### Configuration Examples

**Anthropic Style (Default)**

```json
{
  "coding-plans.vendors": [
    {
      "name": "zhipu",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic/v1",
      "usageUrl": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      "defaultApiStyle": "anthropic",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "glm-4.7",
          "capabilities": { "tools": true, "vision": false },
          "contextSize": 128000
        }
      ]
    }
  ]
}
```

**OpenAI Chat Style**

```json
{
  "coding-plans.vendors": [
    {
      "name": "my-openai-vendor",
      "baseUrl": "https://api.example.com/v1",
      "defaultApiStyle": "openai-chat",
      "useModelsEndpoint": true,
      "models": []
    }
  ]
}
```

**OpenAI Responses Style**

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
          "capabilities": { "tools": true, "vision": false },
          "contextSize": 400000
        }
      ]
    }
  ]
}
```

### Configurable Items

| Config Key | Type | Default Value | Description |
| --- | --- | --- | --- |
| `coding-plans.logLevel` | `string` | `info` | Log level: `debug` / `info` / `warn` / `error`. |
| `coding-plans.vendors` | `array` | Built-in vendor templates | Vendor configuration list. |
| `coding-plans.vendors[].name` | `string` | Required | Vendor unique name. |
| `coding-plans.vendors[].baseUrl` | `string` | Required | API base address. |
| `coding-plans.vendors[].usageUrl` | `string` | Empty | Plan usage API address; when configured, status bar displays quota percentage. |
| `coding-plans.vendors[].defaultApiStyle` | `string` | `openai-chat` | Protocol style: `openai-chat` / `openai-responses` / `anthropic`. |
| `coding-plans.vendors[].defaultTemperature` | `number` | `0.2` | Vendor default temperature. |
| `coding-plans.vendors[].defaultTopP` | `number` | `1.0` | Vendor default topP. |
| `coding-plans.vendors[].useModelsEndpoint` | `boolean` | `false` | Whether to fetch model list from `/models`. |
| `coding-plans.vendors[].models[].name` | `string` | Required | Model name. |
| `coding-plans.vendors[].models[].description` | `string` | Empty | Model description. |
| `coding-plans.vendors[].models[].apiStyle` | `string` | Inherit from vendor | Model-level protocol style override. |
| `coding-plans.vendors[].models[].temperature` | `number` | Inherit from vendor | Model-level temperature override. |
| `coding-plans.vendors[].models[].topP` | `number` | Inherit from vendor | Model-level topP override. |
| `coding-plans.vendors[].models[].capabilities` | `object` | `{ tools: true, vision: false }` | Model capability declaration. |
| `coding-plans.vendors[].models[].contextSize` | `number` | Empty | Model total context window. When `maxOutputTokens` is unset, runtime derives the implicit reserved output budget from this total window. |
| `coding-plans.vendors[].models[].maxInputTokens` | `number` | Empty | Deprecated,建议使用 `contextSize`. |
| `coding-plans.vendors[].models[].maxOutputTokens` | `number` | `0` | Deprecated,建议使用 `contextSize`. `0` means unset; runtime then derives an implicit reserved output budget as 20% of total context, clamped to 4096-30000. |
| `coding-plans.advanced.defaultReservedOutput` | `number` | `60000` | Request-side default output token budget. It only overrides request budgeting and is still capped by the model output limit. |
| `coding-plans.commitMessage.showGenerateCommand` | `boolean` | `true` | Whether to show "Generate Commit Message" command. |
| `coding-plans.commitMessage.language` | `string` | `en` | Commit message language: `en` / `zh-cn`. |
| `coding-plans.commitMessage.useRecentCommitStyle` | `boolean` | `false` | Whether to reference the style of the last 20 commits. |
| `coding-plans.commitMessage.modelVendor` | `string` | Empty | Preferred vendor name when generating commit messages. |
| `coding-plans.commitMessage.modelId` | `string` | Empty | Preferred model name when generating commit messages. |
| `coding-plans.commitMessage.options.prompt` | `string` | Built-in prompt | Override generation prompt. |
| `coding-plans.commitMessage.options.maxDiffLines` | `number` | `3000` | Maximum number of lines to read from diff. |
| `coding-plans.commitMessage.options.pipelineMode` | `string` | `single` | Generation pipeline: `single` / `two-stage` / `auto`. |
| `coding-plans.commitMessage.options.maxBodyBulletCount` | `number` | `7` | Maximum number of body bullets. |
| `coding-plans.commitMessage.options.subjectMaxLength` | `number` | `72` | Maximum subject length. |
| `coding-plans.commitMessage.options.requireConventionalType` | `boolean` | `true` | Whether to enforce Conventional Commits type. |
| `coding-plans.commitMessage.options.warnOnValidationFailure` | `boolean` | `true` | Whether to show warning on validation failure. |

`API Key` is not stored in plaintext in `settings.json`. Please write it to VS Code Secret Storage via "Set API Key".

### Context Window Display

Limited by VS Code's public API, this extension additionally implements context window display:

- **System Instructions**: System-class prompts occupy (system prompts, mode descriptions, strategy prompts, etc.), counted as prompt tokens.
- **Tool Definitions**: Tool definitions occupy (tool names, descriptions, parameter JSON Schema), counted as prompt tokens.
- **Reserved Output**: Output token budget reserved for this round of response, not the actual generated reply content.
- **Context Window**: The denominator prioritizes `contextSize` from model configuration. The current public API does not provide an interface to return upstream usage breakdown to the native Context Window, so this extension maintains the numerator display of the context window itself.
- Status bar displays a unified `CodingPlans` entry: the body shows a concise percentage of plan usage and context ratio; hover to view detailed information.
- If the vendor has `usageUrl` configured, it additionally displays plan quota percentage.

## Advanced Features

### Intelligent Commit Message Generation

1. Press `Ctrl+Shift+P`, type `编码套餐: 生成 Commit 消息`
2. The extension analyzes current Git changes and automatically generates a Conventional Commits-compliant commit message
3. You can select the model to use (defaults to the currently configured vendor)

### Multi-Workspace Independent Configuration

Vendor configurations can be saved per workspace/folder; API Keys are stored in VS Code Secret Storage (local) by vendor name.

## Dashboard

Visit [GitHub Pages Plans Dashboard](https://jqknono.github.io/coding-plans-for-copilot/):
- `大陆套餐供应商` Tab: Shows publicly available monthly plan pricing in RMB.
- `海外供应商` Tab: Shows USD-priced plans; restricted items are placed in Pending collapsible section.
- `Provider 性能指标` Tab: Shows OpenRouter model performance metrics (availability, latency, throughput p50/p90/p99) for different vendors over the last 30 minutes, with filtering by model vendor/model/vendor.

---

## Development

Detailed development documentation can be found in [DEV.md](DEV.md).

---

## Changelog

Check [CHANGELOG.md](CHANGELOG.md) for version update details.

---

## Feedback

- **Feature Suggestions**: Submit [Issue](https://github.com/jqknono/coding-plans-for-copilot/issues)
- **Usage Questions**: Include error logs and relevant `settings.json` configuration snippets (with sensitive information redacted) in the Issue
- **Vendor Integration**: Pull Requests are welcome

---

## License

MIT License

---

## Contribution Guidelines

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request
