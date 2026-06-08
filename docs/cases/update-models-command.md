# 更新 models 列表命令验收用例

## 背景

用户需要从命令面板主动执行一次模型列表更新，并在供应商启用 `useModelsEndpoint` 时，将 `baseUrl + /models` 的发现结果写回 `coding-plans.vendors[].models`。

## 验收用例

| 场景 | 前置条件 | 操作 | 预期结果 |
| --- | --- | --- | --- |
| 命令可发现 | 扩展已激活 | 打开命令面板搜索 `Update Coding Plans Models List` | 可看到并执行 `coding-plans.updateModels` 命令。 |
| 更新 models 配置 | 供应商配置了 `baseUrl`、API Key 且 `useModelsEndpoint=true` | 执行 `Coding Plans: Update Coding Plans Models List` | 扩展请求规范化后的 `baseUrl + /models`，将发现到的模型写回 `coding-plans.vendors[].models`，并保留已有模型的手工覆盖项。 |
| `/v1/models` 地址 | 供应商模型接口实际位于 `/v1/models` | 将 `baseUrl` 配置为包含 `/v1` 的地址，或在 404 补 `/v1` 弹窗中确认 | 扩展请求 `/v1/models`；未配置 `/v1` 且未确认弹窗时，不应静默改写 baseUrl。 |
| 同步模型选择器 | `/models` 返回的模型集发生变化 | 命令执行完成 | 扩展触发 provider 模型变化通知，并同步 VS Code Language Models UI。 |
| 无动态端点 | 供应商 `useModelsEndpoint=false` | 执行命令 | 扩展仅使用当前配置模型刷新运行时列表，不引入隐式发现逻辑。 |

## 流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Command as coding-plans.updateModels
    participant Provider as GenericAIProvider
    participant Vendor as 供应商 /models
    participant Config as VS Code Settings
    participant UI as Language Models UI

    User->>Command: 执行更新命令
    Command->>Provider: refreshModels(forceDiscoveryRetry=true)
    alt useModelsEndpoint=true 且 API Key 可用
        Provider->>Vendor: GET baseUrl + /models
        Vendor-->>Provider: 模型列表
        Provider->>Config: 写回 coding-plans.vendors[].models
    else baseUrl 缺少 /v1 且首次请求返回 404
        Provider->>User: 询问是否将 baseUrl 改为 /v1
        opt 用户确认
            Provider->>Config: 写回包含 /v1 的 baseUrl
            Provider->>Vendor: GET /v1/models
        end
    else 未启用动态发现
        Provider->>Provider: 使用已配置 models
    end
    Provider-->>Command: 运行时模型列表已刷新
    Command->>UI: 通知并刷新模型选择器
```
