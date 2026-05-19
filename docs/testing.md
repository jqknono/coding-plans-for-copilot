# 测试说明

## 测试分层

| 测试层 | 命令 | 入口 | 说明 |
| --- | --- | --- | --- |
| 单元/契约回归 | `npm run test:unit` | `src/test/runTest.ts` | 继续复用现有 `vscode` mock，覆盖配置归一化、协议适配与命令逻辑回归。 |
| Desktop 集成冒烟 | `npm run test:desktop` | `.vscode-test.js` + `src/test/suite/**/*.test.ts` | 通过 `@vscode/test-cli` 调度 `@vscode/test-electron`，首次运行会下载 Stable VS Code 到 `.vscode-test/` 并启动隔离测试实例。 |
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

| 事项 | 说明 |
| --- | --- |
| 首次下载 | `npm run test:desktop` 首次会下载 Stable VS Code，缓存目录默认为仓库下 `.vscode-test/`。 |
| 调试入口 | 使用 VS Code `Run Extension Tests` 启动配置，读取 `.vscode-test.js`。 |
| 打包影响 | `.vscodeignore` 仍只放行 `out/extension.js`，测试产物不会被打进 VSIX。 |
