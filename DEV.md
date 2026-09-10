# Development Guide

## Quick Commands

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Verify the Web bundle and VSIX allowlist
npm run test:vsix

# Lint
npm run lint

# Full extension tests (unit + VS Code Desktop)
npm test

# Run only the VS Code Desktop smoke tests
npm run test:desktop

# GitHub Pages smoke test
npm run test:pages

# Package the release build
npm run package:vsix

# Package the pre-release build
npm run package:vsix:pre
```

## Extension Tests

| Command | Description |
| --- | --- |
| `npm run test:unit` | Runs the pure code regression tests in `src/test/runTest.ts`. |
| `npm run test:desktop` | Uses `@vscode/test-cli` to invoke `@vscode/test-electron`; on the first run it downloads the Stable VS Code Desktop into `.vscode-test/`, then launches an isolated test instance to run `src/test/suite/**/*.test.ts`. |
| `Run Web Extension` | VS Code debug entry that launches the browser extension host using `out/extension.web.js`. |
| `npm test` | Runs `test:unit` first, then `test:desktop`. |
| `Run Extension Tests` | VS Code debug entry; reads `.vscode-test.js` in the repository root. |

More test layers and execution chains: see [docs/testing.md](docs/testing.md).

## Packaging and Publishing

The extension package contains separate runtime entry points: `out/extension.node.js` for the Node.js extension host and `out/extension.web.js` for browser extension hosts. `npm run compile` and `npm run package` build both entries; `npm run test:vsix` verifies that both are packaged and that the browser bundle has no Node runtime imports.

In VS Code for the Web, configured upstream endpoints must support CORS. Commit-message generation can use a host-provided SCM/Git API, but recent-commit style sampling remains a desktop-only enhancement because it runs `git log` locally.

```bash
npm run package:vsix
```

Package a pre-release build:

```bash
npm run package:vsix:pre
```

Publish to the marketplace:

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace

# PowerShell
$env:VSCE_PAT="your_pat"
npm run publish:marketplace
```

Publish a pre-release to the marketplace:

```bash
# Linux / macOS
export VSCE_PAT=your_pat
npm run publish:marketplace:pre

# PowerShell
$env:VSCE_PAT="your_pat"
npm run publish:marketplace:pre
```

Pre-release channel conventions:

- This project uses the same extension `Pre-Release` channel on the VS Code Marketplace; no separate extension ID.
- Only after at least one pre-release version already exists on the Marketplace can users switch between `Switch to Pre-Release Version` / `Switch to Release Version` from the gear menu on the extension details page.
- If that entry is missing from the details page, no switchable pre-release package exists on the marketplace yet; this is usually not a manifest issue but a missing one-time `publish --pre-release`.
- Pre-release and release must use different version numbers; the recommended convention is "odd minor for pre-release, even minor for release", e.g. `0.7.x` is the preview channel and `0.8.x` is the release channel.
- `npm run publish:marketplace:pre` only publishes the current `package.json` version as pre-release; it does not bump the version number.

## Commit Message Advanced Configuration

Configurable in VS Code `settings.json`:

```json
{
  "coding-plans.commitMessage.options": {
    "prompt": "FORMAT REQUIREMENT:\nFollow the Conventional Commits format...",
    "maxDiffLines": 3000,
    "pipelineMode": "single",
    "summaryTriggerLines": 1200,
    "summaryChunkLines": 800,
    "summaryMaxChunks": 12,
    "maxBodyBulletCount": 7,
    "subjectMaxLength": 72,
    "requireConventionalType": true,
    "warnOnValidationFailure": true,
    "llmMaxPromptLength": 20000
  }
}
```

## Coding Plans Price Fetching

Run `npm run pricing:fetch` to fetch coding plan prices; results are written to:

- `assets/provider-pricing.json` (the unified data source for the extension and GitHub Pages)

On GitHub Pages deployment, `assets/provider-pricing.json` is synced to `pages/provider-pricing.json` as a site build artifact (not committed).

## OpenRouter Data Fetching

When fetching performance data, use the environment variable `APIKEY` as the OpenRouter API Key:

```bash
npm run metrics:fetch
```

Optional environment variables:
- `OPENROUTER_BASE_URL`: OpenRouter API Base URL (default `https://openrouter.ai/api/v1`).
- `OPENROUTER_MODEL_ORGS`: comma-separated list of organizations (default `deepseek,qwen,moonshotai,z-ai,minimax,bytedance,bytedance-seed,kwaipilot,meituan,mistralai,stepfun`).
- `OPENROUTER_MODEL_LIMIT`: number of latest models to fetch per organization (default `5`).
- `OPENROUTER_MODEL_MAX_AGE_DAYS`: only fetch models released within the last N days (default `180`; set to `0` to skip the release-day filter).
- `OPENROUTER_ENDPOINT_CONCURRENCY`: concurrency for fetching endpoints (default `4`).
- `OPENROUTER_REQUEST_TIMEOUT_MS`: request timeout in milliseconds (default `20000`).

`metrics:fetch` uses a fail-closed strategy: if an endpoint request fails, no provider endpoint is captured, or the `latency_last_30m` / `throughput_last_30m` performance percentiles of all endpoints are empty, the script exits with a non-zero status and does not overwrite the existing `assets/openrouter-provider-metrics.json`. OpenRouter latency/throughput fields require an API Key that can view endpoint performance metrics; without auth or with insufficient permissions, usually only uptime/status is returned.

Fetch OpenRouter provider plan pages (for the Overseas Provider tab):

```bash
npm run openrouter:plans:fetch
```

Preview the GitHub Pages dashboard locally (static server, default `http://127.0.0.1:4173`):

```bash
npm run serve:page
```

Run the GitHub Pages smoke tests (starts/reuses the local preview server automatically):

```bash
npm run test:pages
```

## Copilot Chat Context

- This extension no longer maintains an independent native Context Agent.
- Context display directly reuses Copilot Chat's built-in Context Window / context viewer.
- Related display capabilities and details follow the current built-in VS Code / Copilot Chat implementation.
- For the actual usage of the Context Window, context sources, and landing suggestions in this repo, see [docs/copilot-chat-context-window.md](docs/copilot-chat-context-window.md).
- For the capability boundaries of the current public Chat API and follow-up items, see [todo/vscode-chat-api-follow-up.md](todo/vscode-chat-api-follow-up.md).

## Context Panel Semantics

- `System Instructions`: System-class inputs such as system prompt, mode descriptions, strategy prompts, and additional plugin-injected instructions; counts as prompt tokens.
- `Tool Definitions`: the schema footprint of the tool definitions themselves; counts as prompt tokens.
- `Reserved Output`: the token budget reserved for the model output, corresponding to `outputBuffer`, shown separately in the UI.
- `Context Window X / Y tokens`: when `contextSize` is configured, the runtime splits the total window into an 80% input window and a 20% output window for VS Code Language Models to aggregate; when `contextSize` is not configured, explicit `maxInputTokens/maxOutputTokens` are used, and `Y` follows the native custom endpoint Context Window convention as the sum of the two. The current public API only requires extensions to implement `provideTokenCount` and provides no public interface to write upstream usage details back to the native Context Window, so this repo no longer maintains `X`.
- VS Code official docs: hovering over the context window control shows "exact token count / total context" and a per-category breakdown; compaction triggers when the context is full.
- In the current implementation, `provideTokenCount()` always returns `0`; the previous round's real usage is no longer reused as the current request token count, to avoid premature conversation compaction during tool continuation.
- If VS Code / Copilot Chat later adjusts the context display structure, follow its built-in behavior and update the docs accordingly.
- The current implementation has fully stopped local prompt token estimation and local token counting; if upstream does not return usage, only "no usage data" is shown, with no approximate compensation.
- To see the usage ratio and details of the most recent real request, rely on the unified status bar `CodingPlans`: the body shows a concise percentage, and the tooltip combines plan usage and context details.
- If the vendor has `coding-plans.vendors[].usageUrl` configured, `CodingPlans` additionally shows plan quota. Currently Zhipu coding plan usage is supported first, covering both 5-hour quota and MCP/request-count quota displays.

## Multi-Protocol Vendor Integration Notes

- Prefer the `Coding Plans: Manage Vendor Configuration` command as the config entry. It generates a vendor QuickPick dynamically from `coding-plans.vendors`; after selecting a vendor you can set the API Key, refresh models, or open vendor settings.
- API Keys should be stored in VS Code Secret Storage; `coding-plans.vendors[].apiKey` is kept as a deprecated field and takes precedence over Secret Storage when non-empty. If the current vendor has no key, it falls back to another `vendors[].apiKey` with the same `baseUrl`.
- Since VS Code 1.120, provider models are enumerated directly via the public `LanguageModelChatProvider` interface; the current implementation declares vendors through the `languageModelChatProviders` contribution and registers `registerLanguageModelChatProvider('coding-plans', adapter)` at runtime, without relying on `managementCommand`.
- When debugging the request chain, set the `Coding Plans` native output channel level via `coding-plans.logLevel`, or adjust it temporarily with Set Log Level in the Output panel. Keep `Info` for daily use and `Debug` for detailed diagnostics; only `Trace` logs the first 1,000 characters of system/user/assistant message text per message (tool content and image data are not logged), and logs may contain sensitive context.
- `coding-plans.vendors[].defaultApiStyle` declares the vendor's default protocol style; models can override it individually via `coding-plans.vendors[].models[].apiStyle`:
  - `openai-chat`: requests `baseUrl + /chat/completions`
  - `openai-responses`: requests `baseUrl + /responses`
  - `anthropic`: requests `baseUrl + /messages`
- When `coding-plans.vendors[].authType` is omitted, default request headers match native Custom Endpoint: `openai-chat` / `openai-responses` send `Authorization: Bearer`; `anthropic` sends `x-api-key` plus `anthropic-version: 2023-06-01` and does not send `Authorization`. Optional `authType: "bearer" | "x-api-key"` overrides authentication for all three chat protocols and `/models` discovery, sending mutually exclusive auth headers. Anthropic always keeps its version header, including with Bearer. Normalization accepts only these exact values; invalid values behave as omitted. Omitted auth follows the actual model-level protocol for chat, and `defaultApiStyle` for discovery. The discovery signature includes `authType` so an auth change invalidates failed-discovery suppression and stale in-flight discovery writes. This does not change Secret Storage or `usageUrl` authentication and adds no implicit retry.
- The built-in `火山引擎` template uses `https://ark.cn-beijing.volces.com/api/coding/v3`, `defaultApiStyle: "openai-responses"`, `useModelsEndpoint: false`, and ten static model IDs: `doubao-seed-evolving`, `doubao-seed-2.1-turbo`, `doubao-seed-2.0-lite`, `minimax-m3`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `kimi-k2.7-code`, `kimi-k3`. The template only declares IDs, without unverified per-model vision/context/thinking metadata. The complete URL is `/api/coding/v3/responses`; `/api/coding/v3/chat/completions` is also supported. Responses is recommended, not mandatory. Static models remain visible under the explicit vendor group and even forced discovery refresh must not request `/models` when disabled.
- For Volcano Engine Anthropic compatibility, use `defaultApiStyle: "anthropic"`, `authType: "bearer"`, and extension `baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v1"`, keeping static models and discovery disabled. This extension only appends `/messages`, giving `/api/coding/v1/messages`; Claude Code's documented `/api/coding` base is not interchangeable. Its `ANTHROPIC_AUTH_TOKEN` setting indicates Bearer auth; this extension instead uses its configured/stored key. Existing explicit vendor settings require manual endpoint/protocol/model updates; `models[].apiStyle` overrides the vendor default and must also be removed or updated when switching protocols. Keep the vendor name to preserve the stored key association. Never fall back to general `/api/v3`, which may incur additional usage charges outside the Coding Plan. Discovery failure falls back to configured/cached models rather than necessarily clearing them. See [issue #376 acceptance cases](cases/issue-376-volcengine-coding-auth.md); upstream 401, `/models` availability and model access are not independently verified without a real Volcano Engine key.
- The request path is fixed to native Custom Endpoint behavior: thinking parameters and thinking-output display are kept; plugin extras such as temperature / topP / personality are not sent; there is no reasoning/tool-continuation cache; chat-path compatibility auto-fallbacks (`/v1`, non-stream, missing max_tokens, unsupported reasoning) are not triggered. `/models` discovery still uses `withOptionalV1Retry`. Real stream errors still call `disableStreamingForSession`.
- `coding-plans.vendors[].usageUrl` is an optional plan usage API; currently it polls with `Authorization: Bearer <API Key>` by default and shows recognized hourly, weekly, or request-count quotas as percentages in the status bar.
- `coding-plans.vendors[].models[].contextSize` is the primary total context window field; automatic refresh takes `limit.context` from models.dev. When present it takes precedence over `maxInputTokens/maxOutputTokens`; the runtime splits it into `maxInputTokens=80%` and `maxOutputTokens=20%` so VS Code Language Models does not display a context window exceeding the total.
- `coding-plans.vendors[].models[].price.inputCost` / `cacheCost` / `outputCost` are Copilot-style metadata read by the VS Code Manage Language Models cost column, in credits / 1M tokens.
- `coding-plans.vendors[].models[].toolCalling` / `vision` are Copilot-style capability aliases normalized to `capabilities.tools` / `capabilities.vision`.
- After a successful `/models` refresh, the extension prefers `https://models.dev/catalog.json` and falls back to `https://models.dev/api.json`, matching by model ID/name only and enriching newly discovered models with `description`, `capabilities`, `contextSize`, `price`; matching ignores tags after `:` in the final model path segment (e.g. `:free`); the `description` format is `id | Lab | Family | Weights | ReleaseDate`, where `Lab` comes from the model ID prefix; `capabilities.thinking` maps to models.dev `reasoning`; prices use the median across all matching model sources, without matching the local vendor name to a models.dev provider; on fetch failure or no match, the upstream `/models` results and the project's preset values are kept.
- `coding-plans.vendors[].models[].enabled` defaults to `true`; when `false`, the model stays in the config but is not exposed in the final Language Model list, so it does not appear in VS Code `Manage Language Models`.
- When `maxInputTokens` / `contextSize` are not configured, the extension builds models with a `400000` token input window and a `30000` token output window by default; the total context window is the sum of the two.
- When `contextSize` is configured, the extension splits the declared input/output windows 80%/20%; when not configured, `maxOutputTokens` defaults to `30000` tokens.
- `coding-plans.advanced.defaultReservedOutput` defaults to `60000` and overrides the request-side output budget; when sending a request it is automatically capped by the model output limit and does not change the declared `maxOutputTokens`. `openai-chat` sends this as `max_tokens`, `openai-responses` as `max_output_tokens`, and `anthropic` as `max_tokens`. Native Custom Endpoint typically uses the model's configured `maxOutputTokens` directly.
- Sampling parameters:
  - `coding-plans.vendors[].defaultTemperature` / `defaultTopP`: vendor sampling config keys; `defaultTemperature` is marked deprecated. Values are kept in configuration but are not sent.
  - `coding-plans.vendors[].models[].temperature` / `topP`: model-level overrides; `temperature` is marked deprecated. Values are kept in configuration but are not sent.
  - `request.modelOptions.temperature` / `personality` may still be forwarded by the adapter if a caller supplies them; the provider does not write them into the upstream payload. The model row `More Actions` menu is thinking-only (no Temperature / Personality).
  - `openai-responses` keeps system messages in `input` and does not send `instructions`.
- Thinking effort:
  - The specific effort value still comes from the request-level override passed by API callers. The adapter also accepts Copilot-style `modelConfiguration.reasoningEffort` and copies it to `thinkingEffort` when the latter is absent; an existing `thinkingEffort` (including a More Actions / schema-default value) is not overwritten by `reasoningEffort`. Copilot's private `_enableThinking: false` disables thinking when `thinkingType` is missing or still the schema default (`default` / `think`); an explicit `enabled` / `disabled` / `non-think` choice is kept. `_enableThinking: true` does not change `thinkingType` and does not force thinking on. Adapter info logs include the forwarded thinking fields. `_enableThinking` is adapter/provider input only and is not sent upstream. Model-level `capabilities.thinking: false` hides and forbids sending thinking/reasoning parameters, and `supportsReasoningEffort` restricts model-row options and blocks undeclared values from the payload.
  - `editTools` defaults to `["apply-patch","multi-find-replace","find-replace","code-rewrite"]`, passed through as Copilot-style model metadata to `capabilities.editToolsHint` for VS Code/Copilot to choose edit-tool preferences; this extension itself does not filter request tools by this field.
  - `reasoningEffortFormat` and `zeroDataRetentionEnabled` are kept as Copilot-style metadata; the latter does not represent the upstream's real data retention policy.
  - The inheritance order is fixed as request modelOptions > omit
  - Protocol mapping:
    - `openai-chat`: uses `request.modelOptions.thinkingEffort` (alias `reasoningEffort`), options `none` / `low` / `medium` / `high` / `xhigh` / `max`; the model row `More Actions` default is `high`; `none` sends `thinking: { type: "disabled" }`. The rest send top-level `reasoning_effort` only by default (native Custom Endpoint Chat Completions shape). Uses `request.modelOptions.thinkingType` as the thinking switch; the More Actions default is `default` (omit `thinking`, A11/A12). Explicit `enabled` also sends `thinking: { type: "enabled" }` (A13) for vendors that require that field. Response parts emit thinking before output text (native Custom Endpoint order).
    - `openai-responses`: uses `request.modelOptions.thinkingEffort` (alias `reasoningEffort`), options `low` / `medium` / `high` / `xhigh` / `max`; the model row `More Actions` default is `max`; sends `reasoning: { effort }`. Copilot `_enableThinking: false` or an explicit disabled `thinkingType` omits `reasoning`. Response parts emit thinking before output text.
    - `anthropic`: uses `request.modelOptions.thinkingType` as the switch; `true` / `enabled` / `adaptive` / schema default `think` send `thinking: { type: "adaptive" }`, `false` / `disabled` / `non-think` send `thinking: { type: "disabled" }`; `_enableThinking: true` alone does not force thinking on. Uses `request.modelOptions.effort` (aliases `thinkingEffort` / `reasoningEffort`) to send `output_config.effort`, options `low` / `medium` / `high` / `xhigh` / `max`. Response parts emit thinking before output text.
  - Moonshot/Kimi Anthropic-compatible entrypoints may require the previous assistant tool-call history message to carry the non-standard `reasoning_content` in thinking + tool continuation scenarios, otherwise they return `thinking is enabled but reasoning_content is missing in assistant tool call message`; the current implementation does not echo that field on the Anthropic path, so disable thinking or switch to the `openai-chat` compatible API.
- When `defaultApiStyle` / model `apiStyle` are not configured, `openai-chat` is assumed.
- `/models` auto-discovery writes a derived `models[].apiStyle` for new models: `openai-responses` when the model itself is identified as OpenAI or Grok/xAI source, `anthropic` only when the model itself is identified as Anthropic source, and `openai-chat` for everything else; existing manual model entries are not overwritten by refresh, but Grok models that still keep the legacy `openai-chat` are automatically upgraded to `openai-responses`; extension-generated fallback descriptions (e.g. `vendor model: model`) can be upgraded to the models.dev structure.
- `anthropic` and `openai-responses` currently focus on chat and tool calling; model discovery is still recommended with `useModelsEndpoint: false` and manually maintained `models`.
- The request chain prefers real upstream streaming by default; when a model has `streaming: false`, a non-streaming request is sent directly. If a compatible vendor explicitly does not support streaming, fall back to a non-streaming request and log a warning.
- `capabilities` is optional; normalization fills in `tools=true` and `vision=defaultVision`.
- When `useModelsEndpoint: true`, refreshing the model list syncs add/remove by `name`; existing manual model entries in settings stay unchanged and are not overwritten by `/models` or models.dev results. Only models not present in settings are added, filled with auto metadata such as `description`, `capabilities`, `contextSize`, `price`; existing legacy fallback structures generated by the extension can be replaced by new models.dev metadata.
- Saving settings only refreshes runtime-configured models by default; config-change listeners must not automatically request `/models` or write back `coding-plans.vendors[].models`. Only the manual command `Coding Plans: Update Coding Plans Models List` is allowed to dynamically discover and write back the model list. `coding-plans.autoRefreshModels: false` further forbids settings/API-key changes and empty model-picker queries from triggering automatic runtime refresh, but manual refresh commands still work.
- If you modify protocol-related behavior, check in sync:
  - `src/providers/genericProvider.ts`
  - `src/config/configStore.ts`
  - `package.json`
  - `README.md`
  - `README.zh-CN.md`
