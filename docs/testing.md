# 测试说明

## 测试分层

| 测试层 | 命令 | 入口 | 说明 |
| --- | --- | --- | --- |
| 单元/契约回归 | `npm run test:unit` | `src/test/runTest.ts` | 继续复用现有 `vscode` mock，覆盖配置归一化、协议适配与命令逻辑回归。 |
| Desktop 集成冒烟 | `npm run test:desktop` | `.vscode-test.js` + `src/test/suite/**/*.test.ts` | 通过 `@vscode/test-cli` 调度 `@vscode/test-electron`，首次运行会下载 Stable VS Code 到 `.vscode-test/` 并启动隔离测试实例。 |
| Web/VSIX 打包契约 | `npm run test:vsix` | `tests/scripts/vsix-package-files.test.js` | 验证 Node 与浏览器入口均被打入 VSIX，且浏览器 bundle 不包含 Node 运行时导入。 |
| 扩展完整测试 | `npm test` | `test:unit` + `test:desktop` | 先跑纯代码回归，再跑真实 VS Code Desktop 冒烟。 |
| 页面冒烟 | `npm run test:pages` | `tests/pages/github-pages.spec.ts` | 验证价格看板本地预览页可用性。 |

## 执行流程

```mermaid
flowchart LR
    A[npm test] --> B[pretest: compile + lint]
    B --> C[test:unit]
    C --> D[test:desktop]
    D --> E[@vscode/test-cli 读取 .vscode-test.js]
    E --> F[@vscode/test-electron 下载并启动 VS Code Desktop]
    F --> G[Mocha 执行 out/test/suite/**/*.test.js]
```

## 说明

### 思考内容显示集成验证

`src/test/runTest.ts` 中的 provider 级正向集成场景覆盖：

- Responses 的 `response.reasoning_summary_text.delta` 按分片输出思考摘要，保留词间空格；`done`、`output_item.done` 和 `completed` 保持已输出摘要仅出现一次。
- Responses 仅在完成事件携带摘要时，通过完成响应补齐思考内容。
- Anthropic 流式和非流式的纯元数据 thinking 使用内部 `LanguageModelDataPart` 传递，正文正常输出；宿主回传这些部件时，下一轮请求恢复 redacted thinking 与 signature。

这些场景模拟上游响应与宿主消息回传。真实 Copilot Chat 的内部数据部件保留行为、子代理卡片显示与运行状态仍通过手动 UI 验收确认。

| 事项 | 说明 |
| --- | --- |
| 首次下载 | `npm run test:desktop` 首次会下载 Stable VS Code，缓存目录默认为仓库下 `.vscode-test/`。 |
| 调试入口 | 使用 VS Code `Run Extension Tests` 启动配置，读取 `.vscode-test.js`。 |
| Web 调试 | 使用 VS Code `Run Web Extension` 启动浏览器扩展宿主；该配置会加载 `out/extension.web.js`。 |
| 打包影响 | `.vscodeignore` 只放行 `out/extension.node.js` 和 `out/extension.web.js`，测试产物不会被打进 VSIX。 |
