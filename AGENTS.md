# AGENTS Instructions

## Development Principles

- All scripts implement the `-h` parameter.
- Generate release notes from Git tags/releases; keep project docs focused on current behavior rather than a maintained `CHANGELOG.md`.
- Target the current VS Code version, configuration shape, and data structures by default; evolve forward instead of retaining legacy compatibility layers.
- Update price/plan information by improving the fetch scripts first; let scripts write `assets/*.json` during verification.

## Project Positioning

- This repository contains two parts:
  - VS Code extension (`src/`): multi-vendor model integration + Commit Message generation.
  - Price/performance dashboard (`pages/` + `assets/` + `scripts/`): displays coding plans and OpenRouter provider performance metrics.
- The VS Code extension is a general OpenAI Chat, OpenAI Responses, and Anthropic protocol adapter; construct requests with public/general protocol fields.
- Preserve compatibility with OpenAI/Anthropic-style APIs reverse-proxied by Codex, Claude Code, and similar tools, even when that differs from native VS Code/Copilot Chat built-in endpoint requests.
- Core dashboard data files:
  - `assets/provider-pricing.json` (domestic/structured plans)
  - `assets/openrouter-provider-metrics.json` (OpenRouter metrics)
  - `assets/openrouter-provider-plans.json` (OpenRouter provider plans and pending)

## Price Page Fetching

- When fetching vendor pricing pages or any price-related web content, prefer and actively use the Playwright MCP tool.
- For dynamically rendered pages, front-end rendered content, and flows that may have anti-scraping mechanisms, use Playwright MCP by default.
- Fall back to non-browser requests when Playwright MCP is unavailable or browser capability is clearly unnecessary.
- If a page is accessible but cannot be parsed reliably, add a Playwright path (including necessary waits and interactions) before marking the vendor as pending.

## Data Fetching Order

- When updating pricing and metrics data, execute in the following order:
  1. `npm run pricing:fetch`
  2. `npm run metrics:fetch`
  3. `npm run openrouter:plans:fetch`
  4. `npm run serve:page` (local preview)
- `openrouter:plans:fetch` depends on the artifacts of the first two steps:
  - `assets/provider-pricing.json`
  - `assets/openrouter-provider-metrics.json`
- To refresh a single provider, run `npm run pricing:fetch -- --provider <id>` (e.g. `--provider opencode`). Other providers and their failures are kept from the existing asset. Run `npm run pricing:fetch -- -h` to list provider ids.
- A full `npm run pricing:fetch` (without `--provider`) aborts without writing if any provider's plans were added, removed or repriced, and prints the diff. Review it, then rerun with `--confirm` only if the changes are intended. CI passes `--confirm`.
- After any full `npm run pricing:fetch`, review `git --no-pager diff -- assets/provider-pricing.json` and confirm every provider you did not intend to change is unchanged. Restore unintended providers from HEAD before committing.

## Script and Page Contracts

- `pages/app.js` depends on the following field structures; keep them compatible when modifying script output:
  - `provider-pricing.json`: `providers[].provider/plans/sourceUrls`, top-level `updatedAt/failures`
  - `openrouter-provider-metrics.json`: `generatedAt(Beijing)`, `captureWindow`, `config`, `models[]`, `failures`
  - `openrouter-provider-plans.json`: `providers[]`, `pending[]`, `summary`, `generatedAt(Beijing)`
- `scripts/serve-pricing-page.js` maps the following routes to `assets/` files:
  - `/provider-pricing.json`
  - `/openrouter-provider-metrics.json`
  - `/openrouter-provider-plans.json`
- Keep the JSON paths above stable; when a path must change, update `pages/app.js` and `scripts/serve-pricing-page.js` in the same change.

## Environment Variables and Security

- `metrics:fetch` and `openrouter:plans:fetch` require `APIKEY` (OpenRouter API Key).
- Environment variables can be loaded from the `.env` file in the project root.
- When debugging the extension or doing manual API tests, reuse `BASE_URL`, `APIKEY`, `MODEL` from `.env` as local test parameters and keep them out of committed repository configuration.
- Keep secrets out of documentation, logs, and commit messages.

## Code Map (Extension)

- Entries: `src/extension.node.ts` (Node.js host) and `src/extension.web.ts` (browser host); shared activation is in `src/extension.ts`.
- Configuration: `src/config/configStore.ts` (`coding-plans.vendors` normalization; new configs use `defaultApiStyle` / `models[].apiStyle`, `apiType` is only read for migration).
- Protocols and requests: `src/providers/genericProvider.ts`, `genericProviderProtocols.ts`; VS Code API adaptation: `lmChatProviderAdapter.ts`.
- Behavior and regression notes: see [DEV.md](DEV.md) and [docs/testing.md](docs/testing.md). Express expected behavior through implementation and automated tests.

## Development and Validation

| Change Scope | Minimum to Run |
| --- | --- |
| `src/` | `npm run typecheck`, `npm run lint`; `npm test` for behavior changes (includes `pretest` compile+lint) |
| `scripts/`, `pages/`, `assets/` contracts | Related `npm run pricing:fetch` / `metrics:fetch` / `openrouter:plans:fetch` + `npm run serve:page`; optional `npm run test:pages` |
| Publish extension | `npm run package:vsix`; see [DEV.md](DEV.md) for release and pre-release version conventions |

- Common commands: `compile` (typecheck+bundle), `package:vsix`, `test:unit`, `test:desktop`, `test:pages`.
- VSIX only packages allowlisted runtime entries `out/extension.node.js` and `out/extension.web.js` (see `.vscodeignore`); new runtime resources must be added to the packaging/esbuild config as well.

## Documentation Consistency

- When config items, script parameters, or default values change, check in sync:
  - `README.md` (English main doc)
  - `README.zh-CN.md` (Chinese)
  - `DEV.md`
  - `package.json` (contributes.configuration)
- If docs conflict with code, the code behavior wins, and fix the docs in the same change.
