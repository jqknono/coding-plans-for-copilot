# 供应商 deprecated apiKey 优先级验收用例

## 背景

`coding-plans.vendors` 需要重新接受已废弃的 `apiKey` 字段，便于临时从 `settings.json` 直接注入供应商密钥。该字段仅作为过渡入口，运行时优先级高于 VS Code Secret Storage 中按供应商名保存的密钥。

## 生效路径

```mermaid
flowchart TD
  A[读取供应商 API Key] --> B{vendors[].apiKey 是否为非空字符串}
  B -- 是 --> C[使用 vendors[].apiKey]
  B -- 否 --> D[读取 Secret Storage]
  C --> E[模型刷新 / 请求 / usage 查询]
  D --> E
```

## 验收用例

### 用例 1：deprecated apiKey 覆盖 Secret Storage

- 前置条件：
  - `coding-plans.vendors[]` 中存在 `name = Vendor`
  - 该供应商配置 `apiKey = " config-key "`
  - Secret Storage 中同时存在 `coding-plans.vendor.apiKey.Vendor = "secret-key"`
- 当：运行时调用 `ConfigStore.getApiKey("Vendor")`
- 则：
  - 返回值为 `config-key`
  - 首尾空白被裁剪
  - 不读取为 `secret-key`

### 用例 2：未配置 apiKey 时沿用 Secret Storage

- 前置条件：
  - `coding-plans.vendors[]` 中存在 `name = Vendor`
  - 该供应商未配置 `apiKey`
  - Secret Storage 中存在 `coding-plans.vendor.apiKey.Vendor = "secret-key"`
- 当：运行时调用 `ConfigStore.getApiKey("Vendor")`
- 则：返回值为 `secret-key`

## 验证命令

```powershell
npm run test:unit
npm run typecheck
npm run lint
```
