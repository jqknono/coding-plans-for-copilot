# 编码套餐 for Copilot

**一键切换多厂商 AI 模型，打破 Copilot 套餐限制。**

支持智谱 z.ai、Kimi、火山云、Minimax、阿里云等国产大厂，以及**任何**兼容 OpenAI Chat、OpenAI Responses 或 Anthropic 接口风格的供应商。无需改变使用习惯，直接在 VS Code Copilot Chat 中无缝调用。

---

## 核心特性

- **多厂商统一接入**：支持**任意**符合 OpenAI Chat、OpenAI Responses 或 Anthropic 接口规范的供应商，配置一次即可使用。
- **编码套餐看板（GitHub Pages）**：访问 [GitHub Page 看板](https://jqknono.github.io/coding-plans-for-copilot/) 统一查看多家编码套餐的公开月费与权益信息（自动抓取、定期更新）。
  - 按币种分区：大陆（¥）/ 海外（$）
  - 访问受限或解析失败的海外供应商会进入 Pending 折叠区
  - 抓取失败项以低干扰折叠区展示（不占据首屏）
- **OpenRouter 供应商性能指标看板（GitHub Pages）**：同一页面提供「Provider 性能指标」Tab，展示最近 30 分钟指标：可用率、延迟、吞吐（p50/p90/p99）。
  - 可按**模型厂商 / 模型 / 供应商**筛选
  - 支持从性能指标一键跳转到对应套餐卡片，并以「大陆套餐 / 海外套餐」标签区分
- **零学习成本**：完全集成到 VS Code Copilot Chat，不改变任何操作习惯。
- **灵活模型管理**：支持动态拉取 `/models` 端点，也可自定义模型列表与参数。
- **智能 Commit 生成**：基于 Git 变更自动生成符合 Conventional Commits 规范的提交消息。
- **中英双语支持**：根据 VS Code 语言设置自动切换（默认中文）。
- **企业级安全**：API Key 使用 VS Code Secret Storage 本地保存，不上云不共享

---

## 快速开始

### 安装

**推荐方式**：在 VS Code 扩展市场搜索「编码套餐」或 `Coding Plans for Copilot` 直接安装。

[访问 VS Code 插件市场](https://marketplace.visualstudio.com/items?itemName=techfetch-dev.coding-plans-for-copilot)

### 配置

1. 按 `Ctrl+Shift+P`，输入 `编码套餐: 管理编码套餐配置`
2. 选择「选择供应商」，选择你已注册的平台（如智谱 z.ai、Kimi 等）
3. 选择「设置 API Key」，粘贴你的 API Key
4. 打开 Copilot Chat（`Ctrl+L`），切换到「编码套餐」提供商

### 配置入口

1. 按 `Ctrl+Shift+P`，输入 `编码套餐: 管理编码套餐配置`
2. 插件会打开设置页并定位到 `coding-plans.vendors`
3. 也可以直接编辑 `settings.json`

### 基础配置示例（settings.json）

```json
{
  "coding-plans.vendors": [
    {
      "name": "zhipu",
      "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
      "apiStyle": "openai-chat",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "glm-4.7",
          "description": "智谱 GLM-4.7",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextSize": 128000
        }
      ]
    }
  ],
  "coding-plans.commitMessage.showGenerateCommand": true,
  "coding-plans.commitMessage.language": "zh-cn",
  "coding-plans.commitMessage.options": {
    "pipelineMode": "single",
    "maxBodyBulletCount": 7,
    "subjectMaxLength": 72
  }
}
```

### Anthropic 风格配置示例（如 DeepSeek Anthropic 兼容入口）

```json
{
  "coding-plans.vendors": [
    {
      "name": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "apiStyle": "anthropic",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "deepseek-chat",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextSize": 200000
        },
        {
          "name": "deepseek-reasoner",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextSize": 200000
        }
      ]
    }
  ]
}
```

### OpenAI Responses 风格配置示例

```json
{
  "coding-plans.vendors": [
    {
      "name": "openai-responses-demo",
      "baseUrl": "https://api.openai.com/v1",
      "apiStyle": "openai-responses",
      "useModelsEndpoint": false,
      "models": [
        {
          "name": "gpt-5",
          "capabilities": {
            "tools": true,
            "vision": false
          },
          "contextSize": 400000
        }
      ]
    }
  ]
}
```

### 可配置项说明

| 配置键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `coding-plans.vendors` | `array` | 内置供应商模板 | 供应商配置列表。 |
| `coding-plans.vendors[].name` | `string` | 必填 | 供应商唯一名称（用于匹配与选择）。 |
| `coding-plans.vendors[].baseUrl` | `string` | 必填 | 供应商 API 基础地址，可填写自建中转站。 |
| `coding-plans.vendors[].apiStyle` | `string` | `openai-chat` | 接口协议风格，支持 `openai-chat` / `openai-responses` / `anthropic`。分别对应 `/chat/completions`、`/responses`、`/messages`。 |
| `coding-plans.vendors[].useModelsEndpoint` | `boolean` | `false` | 为 `true` 时刷新模型会请求 `/models`；刷新只按 `name` 同步模型增删，已有模型对象的其它字段会保留。 |
| `coding-plans.vendors[].models` | `array` | `[]` | 手动模型清单。 |
| `coding-plans.vendors[].models[].name` | `string` | 必填 | 模型名称。 |
| `coding-plans.vendors[].models[].description` | `string` | 空 | 模型描述。 |
| `coding-plans.vendors[].models[].capabilities.tools` | `boolean` | `true` | 是否启用工具调用能力。 |
| `coding-plans.vendors[].models[].capabilities.vision` | `boolean` | `false` | 是否启用视觉输入能力。 |
| `coding-plans.vendors[].models[].contextSize` | `number` | `400000` | 模型上下文窗口大小，推荐使用。 |
| `coding-plans.vendors[].models[].maxInputTokens` | `number` | - | 模型最大输入 token 数。 |
| `coding-plans.vendors[].models[].maxOutputTokens` | `number` | - | 模型最大输出 token 数。 |
| `coding-plans.commitMessage.showGenerateCommand` | `boolean` | `true` | 是否显示“生成 Commit 消息”命令。 |
| `coding-plans.commitMessage.language` | `string` | `en` | 提交消息语言，支持 `en` / `zh-cn`。 |
| `coding-plans.commitMessage.useRecentCommitStyle` | `boolean` | `false` | 是否参考最近 20 条 commit 风格。 |
| `coding-plans.commitMessage.modelVendor` | `string` | 空 | 生成提交消息时优先使用的供应商名。 |
| `coding-plans.commitMessage.modelId` | `string` | 空 | 生成提交消息时优先使用的模型名。 |
| `coding-plans.commitMessage.options.prompt` | `string` | 内置提示词 | 覆盖生成提示词。 |
| `coding-plans.commitMessage.options.maxDiffLines` | `number` | `3000` | 读取 diff 的最大行数。 |
| `coding-plans.commitMessage.options.pipelineMode` | `string` | `single` | 生成管线：`single` / `two-stage` / `auto`。 |
| `coding-plans.commitMessage.options.summaryTriggerLines` | `number` | `1200` | 触发摘要模式的 diff 行数阈值。 |
| `coding-plans.commitMessage.options.summaryChunkLines` | `number` | `800` | 摘要模式每段行数。 |
| `coding-plans.commitMessage.options.summaryMaxChunks` | `number` | `12` | 摘要分段最大数量。 |
| `coding-plans.commitMessage.options.maxBodyBulletCount` | `number` | `7` | 正文 bullet 最大数量。 |
| `coding-plans.commitMessage.options.subjectMaxLength` | `number` | `72` | 标题最大长度。 |
| `coding-plans.commitMessage.options.requireConventionalType` | `boolean` | `true` | 是否强制 Conventional Commits 类型。 |
| `coding-plans.commitMessage.options.warnOnValidationFailure` | `boolean` | `true` | 校验失败时是否提示告警。 |
| `coding-plans.commitMessage.options.recentStyleMaxTotalLength` | `number` | `5000` | 最近提交风格样例的总字符上限（用于 `useRecentCommitStyle`）。 |
| `coding-plans.models` | `array` | `[]` | 高级兜底：当 `/models` 不可用时，作为可选模型列表。 |
| `coding-plans.modelSettings` | `object` | `{}` | 高级兜底：按模型覆盖 token 与能力参数。 |

`API Key` 不在 `settings.json` 明文存储。请通过「设置 API Key」写入 VS Code Secret Storage。

说明：当前多协议支持重点覆盖聊天与工具调用；对 `anthropic` 与 `openai-responses`，通常建议搭配 `useModelsEndpoint: false` 并手动填写 `models` 列表。

## 高级功能

### 智能 Commit 消息生成

1. 按 `Ctrl+Shift+P`，输入 `编码套餐: 生成 Commit 消息`
2. 插件会分析当前 Git 变更，自动生成符合规范的提交消息
3. 可选择使用的模型（默认使用当前配置的供应商）

### 多工作区独立配置

供应商配置可按工作区/文件夹保存；API Key 按供应商名保存在 VS Code Secret Storage（本地）。

### 看板（价格 + 模型性能）

访问 [GitHub Pages 套餐看板](https://jqknono.github.io/coding-plans-for-copilot/)：
- `大陆套餐供应商` Tab：展示人民币计价的公开月费套餐（仅标准月费），并可查看对应权益信息。
- `海外供应商` Tab：展示美元计价套餐；若价格页访问受限或解析失败，会放入 Pending 折叠区。
- `Provider 性能指标` Tab：展示 OpenRouter 模型在不同**供应商**下的最近 30 分钟性能指标（可用率、延迟、吞吐），并支持按**模型厂商 / 模型 / 供应商**筛选。
- 表格内拆分展示 `p50/p90/p99`，并支持一键跳转到对应套餐卡片（含「大陆套餐 / 海外套餐」标签）。

本地或 CI 抓取性能数据时，使用环境变量 `CODING_PLANS_FOR_COPILOT` 作为 OpenRouter API Key：

```bash
npm run metrics:fetch
```

可选环境变量：
- `OPENROUTER_BASE_URL`：OpenRouter API Base URL（默认 `https://openrouter.ai/api/v1`）。
- `OPENROUTER_MODEL_ORGS`：逗号分隔组织列表（默认 `deepseek,qwen,moonshotai,z-ai,minimax,bytedance,bytedance-seed,kwaipilot,meituan,mistralai,stepfun`）。
- `OPENROUTER_MODEL_LIMIT`：每个组织取最新模型数量（默认 `5`）。
- `OPENROUTER_MODEL_MAX_AGE_DAYS`：仅抓取最近 N 天发布模型（默认 `180`；设为 `0` 表示不过滤发布天数）。
- `OPENROUTER_ENDPOINT_CONCURRENCY`：抓取 endpoints 并发（默认 `4`）。
- `OPENROUTER_REQUEST_TIMEOUT_MS`：请求超时毫秒数（默认 `20000`）。

抓取 OpenRouter 供应商套餐页（用于海外供应商 Tab）:

```bash
npm run openrouter:plans:fetch
```

本地预览 GitHub Pages 看板（静态服务器，默认 `http://127.0.0.1:4173`）：

```bash
npm run serve:page
```

运行 GitHub Pages 冒烟测试（自动启动/复用本地预览服务）：

```bash
npm run test:pages
```

---

## 开发指南

详细的开发文档请查看 [DEV.md](DEV.md)

### 快速命令

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式（开发时使用）
npm run watch

# 代码检查
npm run lint

# GitHub Pages 冒烟测试
npm run test:pages

# 打包发布
npm run package:vsix
```

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

