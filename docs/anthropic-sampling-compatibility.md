# Anthropic 采样参数与当前配置

Anthropic 对应的配置协议值为 `messages`，请求路径为 `/messages`。厂商名称、URL 以及 `anthropic-version` header 保留 Anthropic 协议语义。

## 当前行为

请求 payload 省略 `temperature` 与 `top_p`，保留适用的 thinking、工具调用及输出预算字段。上游曾对同时指定两种采样参数返回 `Invalid request`；当前请求结构通过省略采样字段避免此组合。

供应商和模型 schema 仅接受当前配置字段。旧采样键由用户手动删除，完整字段清单见[配置一次迁移指南](configuration-migration.md)。请求级 API 调用者传入的采样选项与扩展 settings 分属各自契约；当前 provider payload 仍省略这些采样参数。

## 验证重点

使用合法 `messages` 配置验证请求成功构建，检查模型、消息、thinking 和输出预算等有效字段符合预期。配置契约与请求构造分别验收，保持各自职责清晰。
