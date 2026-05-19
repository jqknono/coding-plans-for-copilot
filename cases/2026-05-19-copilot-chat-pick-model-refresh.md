# Copilot Chat Pick Model 初始化同步

## Feature

当 `Coding Plans` 在扩展激活后异步完成模型初始化时，Copilot Chat 的 `Pick Model` 应能看到这些模型，而不要求用户先手动执行 `Coding Plans: Refresh Models`。

## Scenarios

| Scenario | Given | When | Then |
| --- | --- | --- | --- |
| 首次激活后无需手动刷新即可枚举模型 | `coding-plans.vendors` 预先包含至少一个静态模型，扩展尚未激活 | 激活扩展并等待初始化完成 | `vscode.lm.selectChatModels({ vendor: 'coding-plans' })` 返回该模型。 |
| 模型集变化后统一触发 UI 同步 | 扩展已激活且 `GenericAIProvider` 模型集发生变化 | provider 触发 `onDidChangeModels` | 扩展复用统一同步链路通知 VS Code/Copilot 刷新模型列表，而不是只更新内部缓存。 |
| 文档不再声明 managementCommand 依赖 | 开发者阅读 `DEV.md` 的多协议供应商接入说明 | 查阅 `languageModelChatProviders` 相关描述 | 文档明确当前实现依赖运行时注册与刷新链路，不再声称 contribution 使用 `managementCommand`。 |
