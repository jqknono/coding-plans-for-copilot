# 编码套餐 for Copilot

**一键切换多厂商 AI 模型，打破 Copilot 套餐限制。**

支持智谱、Kimi、讯飞、火山云、Minimax、百度千帆、腾讯云、京东云、快手 KAT、X-AIO、Compshare、阿里云、Infini、七牛等国产大厂，以及**任何**兼容 OpenAI Chat、OpenAI Responses 或 Anthropic 接口风格的供应商。无需改变使用习惯，直接在 VS Code Copilot Chat 中无缝调用。

---

## 核心特性

- **多协议统一接入**：支持 OpenAI Chat（`/chat/completions`）、OpenAI Responses（`/responses`）、Anthropic（`/messages`）三种协议风格，适配任意兼容供应商。
- **Claude Code 优先端点**：内置供应商默认使用 Anthropic 兼容端点，同时兼容 Claude Code 与 Copilot Chat。
- **零学习成本**：完全集成到 VS Code Copilot Chat，不改变任何操作习惯。
- **灵活模型管理**：支持动态拉取 `/models` 端点，也可自定义模型列表。
- **智能 Commit 生成**：基于 Git 变更自动生成符合 Conventional Commits 规范的提交消息。
- **编码套餐看板**：访问 [GitHub Pages 看板](https://jqknono.github.io/coding-plans-for-copilot/) 查看多家编码套餐月费与权益，以及 OpenRouter 供应商性能指标。
- **密钥安全**：API Key 使用 VS Code Secret Storage 本地保存，不上云不共享。

---

## 快速开始

### 安装

**推荐方式**：在 VS Code 扩展市场搜索「编码套餐」或 `Coding Plans for Copilot` 直接安装。

#### 方式一：VS Code 内安装（推荐）

1. 打开 VS Code
2. 按 `Ctrl+Shift+X` 打开扩展面板
3. 在搜索框中输入 `Coding Plans for Copilot` 或 `编码套餐`
4. 点击 **Install** 安装
5. 安装完成后，按 `Ctrl+Shift+P` 输入 `编码套餐` 即可看到相关命令

#### 方式二：命令行安装

```bash
code --install-extension techfetch-dev.coding-plans-for-copilot
```

#### 方式三：从市场页面安装

👉 [VS Code 扩展市场直达链接](https://marketplace.visualstudio.com/items?itemName=techfetch-dev.coding-plans-for-copilot)

点击市场页面上的 **Install** 按钮，会自动在 VS Code 中打开扩展并安装。

> **前置条件**：需要 VS Code ≥ 1.109.0，且已安装 [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) 扩展。

### 配置

1. 按 `Ctrl+Shift+P`，输入 `编码套餐: 管理编码套餐配置`
2. 选择「选择供应商」，选择你已注册的平台（如智谱、Kimi、火山引擎等）
3. 选择「设置 API Key」，粘贴你的 API Key
4. 打开 Copilot Chat（`Ctrl+L`），切换到「编码套餐」提供商

也可以直接编辑 `settings.json`，插件会打开设置页并定位到 `coding-plans.vendors`。

### 内置供应商端点

以下供应商已内置默认配置，安装后即可使用：

| 供应商 | 默认端点（Anthropic） | OpenAI 兼容端点 |
| --- | --- | --- |
| 智谱（zhipu） | `https://open.bigmodel.cn/api/anthropic/v1` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| z.ai | `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/coding/paas/v4` |
| 火山引擎 | `https://ark.cn-beijing.volces.com/api/coding` | `https://ark.cn-beijing.volces.com/api/coding/v3` |
| Volcengine Overseas | `https://ark.ap-southeast.bytepluses.com/api/coding` | `https://ark.ap-southeast.bytepluses.com/api/coding/v3` |
| MiniMax Mainland | `https://api.minimaxi.com/anthropic` | `https://api.minimaxi.com/v1` |
| MiniMax Overseas | `https://api.minimax.io/anthropic` | `https://api.minimax.io/v1` |
| Kimi Mainland | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` |
| Kimi Overseas | `https://api.moonshot.ai/anthropic` | `https://api.moonshot.ai/v1` |
| 阿里云（Aliyun） | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | `https://coding.dashscope.aliyuncs.com/v1` |
| 腾讯云 | `https://api.lkeap.cloud.tencent.com/coding/anthropic` | — |
| Infini（无问芯穹） | `https://cloud.infini-ai.com` | — |
| 七牛（Qiniu） | `https://api.qnaigc.com` | — |
| OpenRouter | `https://openrouter.ai/api` | `https://openrouter.ai/api/v1` |

如需切换到 OpenAI 兼容端点，修改供应商的 `baseUrl` 和 `defaultApiStyle` 即可。

### 配置示例

**Anthropic 风格（默认）**

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

**OpenAI Chat 风格**

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

**OpenAI Responses 风格**

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

### 可配置项

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `coding-plans.logLevel` | `string` | `info` | 日志级别：`debug` / `info` / `warn` / `error`。 |
| `coding-plans.vendors` | `array` | 内置供应商模板 | 供应商配置列表。 |
| `coding-plans.vendors[].name` | `string` | 必填 | 供应商唯一名称。 |
| `coding-plans.vendors[].baseUrl` | `string` | 必填 | API 基础地址。 |
| `coding-plans.vendors[].usageUrl` | `string` | 空 | 套餐 usage 接口地址，配置后状态栏显示额度百分比。 |
| `coding-plans.vendors[].defaultApiStyle` | `string` | `openai-chat` | 协议风格：`openai-chat` / `openai-responses` / `anthropic`。 |
| `coding-plans.vendors[].defaultTemperature` | `number` | `0.2` | 供应商默认 temperature。 |
| `coding-plans.vendors[].defaultTopP` | `number` | `1.0` | 供应商默认 topP。 |
| `coding-plans.vendors[].useModelsEndpoint` | `boolean` | `false` | 是否从 `/models` 拉取模型列表。 |
| `coding-plans.vendors[].models[].name` | `string` | 必填 | 模型名称。 |
| `coding-plans.vendors[].models[].description` | `string` | 空 | 模型描述。 |
| `coding-plans.vendors[].models[].apiStyle` | `string` | 继承供应商 | 模型级协议风格覆盖。 |
| `coding-plans.vendors[].models[].temperature` | `number` | 继承供应商 | 模型级 temperature 覆盖。 |
| `coding-plans.vendors[].models[].topP` | `number` | 继承供应商 | 模型级 topP 覆盖。 |
| `coding-plans.vendors[].models[].capabilities` | `object` | `{ tools: true, vision: false }` | 模型能力声明。 |
| `coding-plans.vendors[].models[].contextSize` | `number` | 空 | 模型总上下文窗口。 |
| `coding-plans.vendors[].models[].maxInputTokens` | `number` | 空 | 已废弃，建议使用 `contextSize`。 |
| `coding-plans.vendors[].models[].maxOutputTokens` | `number` | `0` | 已废弃，建议使用 `contextSize`。 |
| `coding-plans.advanced.defaultReservedOutput` | `number` | `60000` | 全局默认输出 token 预算。 |
| `coding-plans.commitMessage.showGenerateCommand` | `boolean` | `true` | 是否显示"生成 Commit 消息"命令。 |
| `coding-plans.commitMessage.language` | `string` | `en` | 提交消息语言：`en` / `zh-cn`。 |
| `coding-plans.commitMessage.useRecentCommitStyle` | `boolean` | `false` | 是否参考最近 20 条 commit 风格。 |
| `coding-plans.commitMessage.modelVendor` | `string` | 空 | 生成提交消息时优先使用的供应商名。 |
| `coding-plans.commitMessage.modelId` | `string` | 空 | 生成提交消息时优先使用的模型名。 |
| `coding-plans.commitMessage.options.prompt` | `string` | 内置提示词 | 覆盖生成提示词。 |
| `coding-plans.commitMessage.options.maxDiffLines` | `number` | `3000` | 读取 diff 的最大行数。 |
| `coding-plans.commitMessage.options.pipelineMode` | `string` | `single` | 生成管线：`single` / `two-stage` / `auto`。 |
| `coding-plans.commitMessage.options.maxBodyBulletCount` | `number` | `7` | 正文 bullet 最大数量。 |
| `coding-plans.commitMessage.options.subjectMaxLength` | `number` | `72` | 标题最大长度。 |
| `coding-plans.commitMessage.options.requireConventionalType` | `boolean` | `true` | 是否强制 Conventional Commits 类型。 |
| `coding-plans.commitMessage.options.warnOnValidationFailure` | `boolean` | `true` | 校验失败时是否提示告警。 |

`API Key` 不在 `settings.json` 明文存储，请通过「设置 API Key」写入 VS Code Secret Storage。

### 上下文窗口展示

受限于 VS Code 公开 API，本扩展额外实现了上下文窗口展示：

- **System Instructions**：System 类提示词占用（系统提示、模式说明、策略提示等），属于 prompt tokens。
- **Tool Definitions**：工具定义占用（工具名、描述、参数 JSON Schema），属于 prompt tokens。
- **Reserved Output**：为本轮回答预留的输出 token 预算，非已生成的回复内容。
- **Context Window**：分母优先使用模型配置中的 `contextSize`。当前公开 API 不提供将上游 usage 明细分发回原生 Context Window 的接口，因此本扩展自行维护上下文窗口的分子展示。
- 状态栏显示统一的 `CodingPlans` 条目：正文以简洁百分比展示套餐 usage 与 context 占比，悬浮查看详细信息。
- 若供应商配置了 `usageUrl`，会额外展示套餐额度百分比。

## 高级功能

### 智能 Commit 消息生成

1. 按 `Ctrl+Shift+P`，输入 `编码套餐: 生成 Commit 消息`
2. 插件会分析当前 Git 变更，自动生成符合规范的提交消息
3. 可选择使用的模型（默认使用当前配置的供应商）

### 多工作区独立配置

供应商配置可按工作区/文件夹保存；API Key 按供应商名保存在 VS Code Secret Storage（本地）。

## 看板

访问 [GitHub Pages 套餐看板](https://jqknono.github.io/coding-plans-for-copilot/)：
- `大陆套餐供应商` Tab：展示人民币计价的公开月费套餐。
- `海外供应商` Tab：展示美元计价套餐；访问受限项放入 Pending 折叠区。
- `Provider 性能指标` Tab：展示 OpenRouter 模型在不同供应商下的最近 30 分钟性能指标（可用率、延迟、吞吐 p50/p90/p99），支持按模型厂商/模型/供应商筛选。

---

## 开发

详细的开发文档请查看 [DEV.md](DEV.md)。

---

## 更新日志

查看 [CHANGELOG.md](CHANGELOG.md) 了解版本更新详情。

---

## 问题反馈

- **功能建议**：提交 [Issue](https://github.com/jqknono/coding-plans-for-copilot/issues)
- **使用问题**：在 Issue 中附上错误日志和 `settings.json` 相关配置片段（隐去敏感信息）
- **厂商接入**：欢迎提交 Pull Request

---

## 许可证

MIT License

---

## 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交变更 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 提交 Pull Request
