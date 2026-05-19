# VS Code Desktop 测试入口

## Feature

为扩展提供基于 `@vscode/test-cli` 的官方测试入口，并通过 `@vscode/test-electron` 下载、启动 VS Code Desktop 测试实例。

## Scenarios

| Scenario | Given | When | Then |
| --- | --- | --- | --- |
| Desktop 冒烟测试可运行 | 依赖已安装且 `npm run compile` 成功 | 执行 `npm run test:desktop` | CLI 读取 `.vscode-test.js`，自动下载/复用 Stable VS Code Desktop，启动隔离测试实例并运行 `out/test/suite/**/*.test.js`。 |
| 完整测试命令保留旧覆盖面 | 现有 `src/test/runTest.ts` 回归测试仍存在 | 执行 `npm test` | 先运行 `test:unit`，再运行 `test:desktop`，同时覆盖纯代码回归与真实 Desktop 冒烟。 |
| 本地调试入口一致 | 开发者在 VS Code 中调试扩展测试 | 启动 `Run Extension Tests` | 调试配置复用 `.vscode-test.js`，与命令行测试实例保持一致。 |
