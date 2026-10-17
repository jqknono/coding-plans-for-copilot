# 下一版本发布说明草稿

版本待定；`package.json` 保持当前版本。本文件仅供发布前审阅，workflow 使用 tag 自动 notes 和按差异触发的迁移文档附录。

## 配置契约更新

- 协议配置统一为 `chat-completions` / `responses` / `messages`。
- 供应商密钥统一存入 VS Code Secret Storage，能力标记统一放入 `capabilities`。
- 模型能力与使用预算分离：`contextWindow ≥ 2`，`maxInputTokens` / `maxOutputTokens ≥ 1`；预算通过 `contextBudget` 调整。
- 配置读取仅校验，原文保持原样；未知字段和无效值通过路径提示定位，相关供应商或模型被隔离，其余有效条目继续使用。
- 旧字段由用户手动整理；完整字段对照、作用域检查、预算示例和原生字段边界见 [配置一次迁移指南](../configuration-migration.md)。

## 发布前确认

- [ ] 确认目标版本与发布渠道，再单独调整版本号。
- [ ] 配置 agent 完成能力下限及提交消息旧键校验规则对齐，见 [协作收尾](../../todo/vscode-chat-api-follow-up.md)。
- [ ] 完成当前配置正向验证、类型检查、相关测试与原生 UI 验收。
- [ ] 预览目标 tag 与前一版本 tag 的迁移文档差异，确认 notes 附录内容。

## English summary

The next release adopts a strict current configuration schema and manual migration. Protocol settings use `chat-completions`, `responses`, or `messages`; vendor keys belong in Secret Storage; model flags belong in `capabilities`. Reads validate and isolate affected entries while preserving the original settings. See the migration guide for removed keys, explicit context budgets, and retained native API fields.
