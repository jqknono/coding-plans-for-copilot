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

## Release Notes Assembly

`create-version-tag.yml` retains its version-change and new-tag gates. Existing remote tags skip build/release creation, including repeated runs; existing releases remain untouched. Release notes come from GitHub's `generate-notes` API and are passed to `gh release create --notes-file` after local composition.

The previous tag is the nearest reachable `v[0-9]*` tag before the target commit. The same tag bounds both generated notes and the migration-document diff. With no previous version tag, the empty Git tree is the comparison base and GitHub receives the target tag alone. The workflow appends the target tag's `docs/configuration-migration.md` only when that file appears in the tag diff and exists at the target. Later releases with an unchanged document receive generated notes alone; deliberate edits to that document trigger an updated migration appendix.

`docs/releases/next.md` is an editorial draft, with no automatic inclusion in releases. Choose a version separately when preparing publication. Keep ongoing changes in Git tags/releases rather than a maintained changelog.

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

Pricing fetches run with three provider workers. Each provider has a 120-second budget starting when its worker begins; queued providers do not consume that budget. HTTP requests retain their 15-second default. Rendered-page helpers allow 30 seconds for navigation by default and, when a content predicate is supplied, wait for navigation commit followed by the required pricing content. Provider-specific limits still apply. Timed-out tasks abort HTTP requests and close their browsers; subsequent browser launches are rejected. CUCloud failures retain both browser and HTTP error details.

Zhipu readiness depends on populated price cards, not marketing copy. The parser switches to the monthly tab before extracting prices. Run `node --test tests/scripts/pricing-execution.test.js tests/scripts/fetch-provider-pricing.test.js` for execution and parser regressions.

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
- `OPENROUTER_METRICS_VALIDATION_RETRY_COUNT`: whole-collection retries when every endpoint has empty performance metrics (default `2`; total attempts `3`).
- `OPENROUTER_METRICS_VALIDATION_RETRY_DELAY_MS`: delay between those validation retries in milliseconds (default `30000`).

`metrics:fetch` retries a whole collection when OpenRouter temporarily returns empty performance metrics for every endpoint. It then uses a fail-closed strategy: if an endpoint request fails, no provider endpoint is captured, or the `latency_last_30m` / `throughput_last_30m` performance percentiles of all endpoints remain empty, the script exits with a non-zero status and does not overwrite the existing `assets/openrouter-provider-metrics.json`. OpenRouter latency/throughput fields require an API Key that can view endpoint performance metrics; without auth or with insufficient permissions, usually only uptime/status is returned.

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

- Configuration UX separates **Model capability** (`contextWindow`, optional `maxInputTokens`, `maxOutputTokens`) from **Usage policy** (`contextBudget`) through localized schema titles and descriptions, retaining existing JSON paths. Capability token fields use integer schemas. When input capability is omitted, the ceiling follows known total capacity minus reserved output.
- Configuration reads perform validation only and preserve stored settings. Unknown fields and invalid values produce field-path notifications; vendor errors isolate the vendor, and model errors isolate only the model. Users update old settings manually; see [configuration migration](docs/configuration-migration.md).
- `contextBudget.defaultSnippets` offers a 64K/16K example; it is completion assistance rather than a runtime default. Capability fields are integers: `contextWindow ≥ 2`, `maxInputTokens ≥ 1`, `maxOutputTokens ≥ 1`; budget fields and presets are integers ≥ 1.

- Minimum host: VS Code `1.142.0`; `@types/vscode` remains `^1.120.0`. Native context integration adapts unpublished runtime fields, isolated from public API guarantees.
- Model capabilities are `contextWindow=C`, independent `maxInputTokens=I` / `maxOutputTokens=O`, and `limitSource: configured | endpoint | models.dev`. Budget policy is `contextBudget { inputTokens, outputTokens, presets }`: default input `P=400000`, actual output `R=50000`, constrained by known capabilities and `P+R ≤ C`.
- Native `schema.contextSize` is a **number** in `group: "tokens"`, representing input `P`. Its default is resolved default input; presets default to 32000/64000/128000/256000/512000 plus Default/Maximum. VS Code persists the per-model selection. Register `maxInputTokens=min(I,C-R)` as the selectable ceiling, `maxOutputTokens=R`, and hidden `maxContextWindowTokens=C`; the effective UI denominator is `P+R`, constrained by `C`.
- Static inspection of the installed VS Code `1.142.0` workbench, extension-host bridge and bundled Copilot confirms native numeric context selection and hidden total-window support. Manual UI acceptance is pending. The third-party Copilot wrapper internally reserves only `8192` output tokens; native UI, compaction and actual request budgets have separate semantics and unverified equivalence.
- Details and follow-up: [context window](docs/copilot-chat-context-window.md), [Chat API investigation](todo/vscode-chat-api-follow-up.md).

## Context Panel Semantics

- System instructions, tool definitions, history and tool results contribute to prompt input; Reserved Output is budget `R`, separate from generated completion.
- `provideTokenCount()` now delegates to local text/message estimation for the current request. It is a token-counting contract, not an upstream response-usage reporting channel; previous usage is never substituted for current input.
- The host manages the native Context Window numerator. Public `LanguageModelChatProvider` / response progress APIs expose no upstream usage-detail reporting contract.
- Unified `CodingPlans` status shows the latest completed request's real usage: input / `P`, generation / `R`; occupied context is `prompt + max(R,completion)` over `P+R`, retaining over-limit percentages. Missing upstream usage stays missing rather than being filled with local estimates.
- A configured `usageUrl` adds plan quota, including supported Zhipu hourly and MCP/request-count quotas.

## Configuration Contract

- Root settings retain `logLevel`, `locale`, `autoRefreshModels`, `terminalIntent.enabled`, `terminalIntent.maxEntries`, and `vendors`.
- Commit-message settings retain `showGenerateCommand`, `language`, `useRecentCommitStyle`, `modelVendor`, `modelId`, and `options` under `coding-plans.commitMessage`.
- `options` accepts `prompt`, `maxDiffLines`, `pipelineMode`, `summaryTriggerLines`, `summaryChunkLines`, `summaryMaxChunks`, `maxBodyBulletCount`, `subjectMaxLength`, `requireConventionalType`, `warnOnValidationFailure`, and `llmMaxPromptLength`. Numeric options and `terminalIntent.maxEntries` use integer schemas with the validator's minimums.
- `locale` accepts empty, `zh-CN`, or `en-US`. `logLevel` defaults to `warn`.
- Vendor, model, capabilities, context-budget, price, and commit options objects use closed property sets. Optional capability flags may be supplied individually. `editTools` accepts non-empty tool identifiers.
- Keep manifest fields and `src/config/configValidation.ts` rules aligned. The remaining runtime handoff is tracked in [Chat API follow-up](todo/vscode-chat-api-follow-up.md).

## Multi-Protocol Vendor Integration Notes

- Prefer the `Coding Plans: Manage Vendor Configuration` command as the config entry. It generates a vendor QuickPick dynamically from `coding-plans.vendors`; after selecting a vendor you can set the API Key, refresh models, or open vendor settings.
- Store API keys in VS Code Secret Storage by vendor name through Manage Vendor Configuration. Native provider `configuration.apiKey` also writes to Secret Storage; settings contain vendor metadata only.
- Since VS Code 1.120, provider models are enumerated directly via the public `LanguageModelChatProvider` interface; the current implementation declares vendors through the `languageModelChatProviders` contribution and registers `registerLanguageModelChatProvider('coding-plans', adapter)` at runtime, without relying on `managementCommand`.
- When debugging the request chain, set the `Coding Plans` native output channel level via `coding-plans.logLevel`, or adjust it temporarily with Set Log Level in the Output panel. Keep `Info` for daily use and `Debug` for detailed diagnostics; only `Trace` logs the first 1,000 characters of system/user/assistant message text per message (tool content and image data are not logged), and logs may contain sensitive context.
- `coding-plans.vendors[].defaultApiStyle` declares the vendor's default protocol style; models can override it individually via `coding-plans.vendors[].models[].apiStyle`:
  - `chat-completions`: requests `baseUrl + /chat/completions`
  - `responses`: requests `baseUrl + /responses`
  - `messages`: requests `baseUrl + /messages`
- When `coding-plans.vendors[].authType` is omitted, default request headers match native Custom Endpoint: `chat-completions` / `responses` send `Authorization: Bearer`; `messages` sends `x-api-key` plus `anthropic-version: 2023-06-01` and does not send `Authorization`. Optional `authType: "bearer" | "x-api-key"` overrides authentication for all three chat protocols and `/models` discovery, sending mutually exclusive auth headers. Anthropic always keeps its version header, including with Bearer. Validation accepts only these exact values; invalid values isolate the affected vendor and trigger a field-path notification. Omitted auth follows the actual model-level protocol for chat, and `defaultApiStyle` for discovery. The discovery signature includes `authType` so an auth change invalidates failed-discovery suppression and stale in-flight discovery writes. This does not change Secret Storage or `usageUrl` authentication and adds no implicit retry.
- The built-in `火山引擎` template uses `https://ark.cn-beijing.volces.com/api/coding/v3`, `defaultApiStyle: "responses"`, `useModelsEndpoint: false`, and ten static model IDs: `doubao-seed-evolving`, `doubao-seed-2.1-turbo`, `doubao-seed-2.0-lite`, `minimax-m3`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `kimi-k2.7-code`, `kimi-k3`. The template only declares IDs, without unverified per-model vision/context/thinking metadata. The complete URL is `/api/coding/v3/responses`; `/api/coding/v3/chat/completions` is also supported. Responses is recommended, not mandatory. Static models remain visible under the explicit vendor group and even forced discovery refresh must not request `/models` when disabled.
- For Volcano Engine Anthropic compatibility, use `defaultApiStyle: "messages"`, `authType: "bearer"`, and extension `baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v1"`, keeping static models and discovery disabled. This extension only appends `/messages`, giving `/api/coding/v1/messages`; Claude Code's documented `/api/coding` base is not interchangeable. Its `ANTHROPIC_AUTH_TOKEN` setting indicates Bearer auth; this extension instead uses its configured/stored key. Existing explicit vendor settings require manual endpoint/protocol/model updates; `models[].apiStyle` overrides the vendor default and must also be removed or updated when switching protocols. Keep the vendor name to preserve the stored key association. Never fall back to general `/api/v3`, which may incur additional usage charges outside the Coding Plan. Discovery failure falls back to configured/cached models rather than necessarily clearing them. Upstream 401, `/models` availability and model access are not independently verified without a real Volcano Engine key.
- The request path is fixed to native Custom Endpoint behavior: thinking parameters and thinking-output display are kept; plugin extras such as temperature / topP / personality are not sent; there is no reasoning/tool-continuation cache; chat-path compatibility auto-fallbacks (`/v1`, non-stream, missing max_tokens, unsupported reasoning) are not triggered. `/models` discovery still uses `withOptionalV1Retry`. Real stream errors still call `disableStreamingForSession`.
- `coding-plans.locale` is an optional, global locale override for this extension's model requests. When non-empty, the provider inserts a system message after existing system messages asking for natural-language reasoning/thinking text emitted by the model and the final response to use that locale, while preserving code and literal identifiers. This applies to OpenAI Chat, OpenAI Responses, and Anthropic requests; it is a prompt-level instruction, so compliance and hidden reasoning behavior depend on the upstream model.
- `coding-plans.vendors[].usageUrl` is an optional plan usage API; currently it polls with `Authorization: Bearer <API Key>` by default and shows recognized hourly, weekly, or request-count quotas as percentages in the status bar.
- Copying a model to `chatLanguageModels.json` exports resolved default `P+R` as `contextWindow` and `R` as `maxOutputTokens`. The native export retains its `apiType` field with `chat-completions` / `responses` / `messages` values.
- `coding-plans.vendors[].models[].price.inputCost` / `cacheCost` / `outputCost` are Copilot-style metadata read by the VS Code Manage Language Models cost column, in credits / 1M tokens.
- After a successful `/models` refresh, the extension prefers `https://models.dev/catalog.json` and falls back to `https://models.dev/api.json`, matching by model ID/name only and enriching newly discovered models with `description`, `capabilities`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `limitSource`, `price`; matching ignores tags after `:` in the final model path segment (e.g. `:free`); a model whose final path segment ends in `-fast` uses its own models.dev entry when present, otherwise it uses the entry without that suffix and doubles `input` / `output` prices, including long-context input and output, while cache prices stay unchanged; the `description` format is `id | Lab | Family | Weights | ReleaseDate`, where `Lab` comes from the model ID prefix; `capabilities.thinking` maps to models.dev `reasoning`; prices use the median across all matching model sources, without matching the local vendor name to a models.dev provider; on fetch failure or no match, the upstream `/models` results and the project's preset values are kept.
- `coding-plans.vendors[].models[].enabled` defaults to `true`; when `false`, the model stays in the config but is not exposed in the final Language Model list, so it does not appear in VS Code `Manage Language Models`.
- Resolve output budget first against `maxOutputTokens` and total capacity, then resolve input against `maxInputTokens` and remaining capacity. Unknown limits remain unknown metadata rather than being inferred from the selected budget.
- Automatic capability refresh applies to `limitSource: "endpoint" | "models.dev"`; `configured` retains explicit limits. Refresh preserves `contextBudget`.
- Actual output budget `R` is sent as `max_tokens` for `chat-completions` / `messages`, and `max_output_tokens` for `responses`; it is independent of model output capability `O`.
- Sampling parameters:
  - `request.modelOptions.temperature` / `personality` may still be forwarded by the adapter if a caller supplies them; the provider does not write them into the upstream payload. The model row `More Actions` menu includes thinking controls and native Context Size (no Temperature / Personality).
  - `responses` aligns with native Custom Endpoint Responses body shape: keep system messages in `input` and do not send top-level `instructions`. This is protocol alignment with VS Code Custom Endpoint, not a vendor-specific workaround.
- Thinking effort:
  - The specific effort value still comes from the request-level override passed by API callers. The adapter also accepts Copilot-style `modelConfiguration.reasoningEffort` and copies it to `thinkingEffort` when the latter is absent; an existing `thinkingEffort` (including a More Actions / schema-default value) is not overwritten by `reasoningEffort`. Copilot's private `_enableThinking: false` disables thinking when `thinkingType` is missing or still the schema default (`default` / `think`); an explicit `enabled` / `disabled` / `non-think` choice is kept. `_enableThinking: true` does not change `thinkingType` and does not force thinking on. Adapter info logs include the forwarded thinking fields. `_enableThinking` is adapter/provider input only and is not sent upstream. Model-level `capabilities.thinking: false` hides and forbids sending thinking/reasoning parameters, and `supportsReasoningEffort` restricts model-row options and blocks undeclared values from the payload.
  - `editTools` defaults to `["apply-patch","multi-find-replace","find-replace","code-rewrite"]`, passed through as Copilot-style model metadata to `capabilities.editToolsHint` for VS Code/Copilot to choose edit-tool preferences; this extension itself does not filter request tools by this field.
  - `reasoningEffortFormat` and `zeroDataRetentionEnabled` are kept as Copilot-style metadata; the latter does not represent the upstream's real data retention policy.
  - The inheritance order is fixed as request modelOptions > omit
  - Protocol mapping:
    - `chat-completions`: uses `request.modelOptions.thinkingEffort` (alias `reasoningEffort`), options `none` / `low` / `medium` / `high` / `xhigh` / `max`; the model row `More Actions` default is `high`; `none` sends `thinking: { type: "disabled" }`. The rest send top-level `reasoning_effort` only by default (native Custom Endpoint Chat Completions shape). Uses `request.modelOptions.thinkingType` as the thinking switch; the More Actions default is `default` (omit `thinking`, A11/A12). Explicit `enabled` also sends `thinking: { type: "enabled" }` (A13) for vendors that require that field. Response parts emit thinking before output text (native Custom Endpoint order).
    - `responses`: uses `request.modelOptions.thinkingEffort` (alias `reasoningEffort`), options `low` / `medium` / `high` / `xhigh` / `max`; the model row `More Actions` default is `max`; sends `reasoning: { effort }`. Copilot `_enableThinking: false` or an explicit disabled `thinkingType` omits `reasoning`. Response parts emit thinking before output text.
    - `messages`: uses `request.modelOptions.thinkingType` as the switch; `true` / `enabled` / `adaptive` / schema default `think` send `thinking: { type: "enabled", budget_tokens, display: "summarized" }`, `false` / `disabled` / `non-think` send `thinking: { type: "disabled" }`; `_enableThinking: true` alone does not force thinking on. Uses `request.modelOptions.effort` (aliases `thinkingEffort` / `reasoningEffort`) both for `output_config.effort` and for mapping `budget_tokens` (`low=1024`, `medium=4096`, `high=8192`, `xhigh=12288`, `max=16384`, always `< max_tokens`, minimum `1024`). Options: `low` / `medium` / `high` / `xhigh` / `max`. Response parts emit thinking before output text.
  - Moonshot/Kimi Anthropic-compatible entrypoints may require the previous assistant tool-call history message to carry the non-standard `reasoning_content` in thinking + tool continuation scenarios, otherwise they return `thinking is enabled but reasoning_content is missing in assistant tool call message`; the current implementation does not echo that field on the Anthropic path, so disable thinking or switch to the `chat-completions` compatible API.
- When `defaultApiStyle` / model `apiStyle` are not configured, `chat-completions` is assumed.
- `/models` auto-discovery assigns new models `apiStyle` by model source: `responses` for OpenAI or Grok/xAI, `messages` for Anthropic, and `chat-completions` otherwise. Existing manual model attributes and budgets remain intact; extension-generated fallback descriptions can be enriched with models.dev metadata.
- `messages` and `responses` currently focus on chat and tool calling; model discovery is still recommended with `useModelsEndpoint: false` and manually maintained `models`.
- The request chain prefers real upstream streaming by default; when a model has `streaming: false`, a non-streaming request is sent directly. If a compatible vendor explicitly does not support streaming, fall back to a non-streaming request and log a warning.
- `capabilities` is optional; normalization fills in `tools=true` and `vision=defaultVision`.
- When `useModelsEndpoint: true`, refreshing the model list syncs add/remove by `name`; existing manual attributes and budgets stay unchanged; automatically sourced capabilities may refresh according to `limitSource`. Only models not present in settings are added, filled with auto metadata such as `description`, `capabilities`, `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `limitSource`, `price`; existing legacy fallback structures generated by the extension can be replaced by new models.dev metadata.
- Settings/API-key changes always rebuild configured runtime models locally, including budgets, even with `autoRefreshModels: false`. This flag controls automatic picker synchronization and empty-query refresh. Remote `/models` discovery and model-list writeback remain behind the manual `Coding Plans: Update Coding Plans Models List` command.
- If you modify protocol-related behavior, check in sync:
  - `src/providers/genericProvider.ts`
  - `src/config/configStore.ts`
  - `package.json`
  - `README.md`
  - `README.zh-CN.md`
