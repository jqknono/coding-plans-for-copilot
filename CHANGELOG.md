# Changelog

All notable changes to this project will be documented in this file.

## [0.12.4] - 2026-07-10
- fix(scripts)#188: 修复腾讯云 Coding Plan 页面解析超时问题
- build(ci): 升级 GitHub Pages 部署工作流的 Action 版本

## [0.12.3] - 2026-06-27
- fix(provider): 兼容 OpenAI function 形态工具定义并保留 function.name
- build(deps): 升级项目版本并添加 eslint-config-prettier
- feat(provider): 将 Responses API 的 Personality 默认值改为 none

## [0.12.2] - 2026-06-26
- feat(app): 完善模型目录与服务兜底逻辑
- feat(pricing): 更新服务商套餐数据与前端展示逻辑
- feat(provider): 支持关闭额外请求封装并优化 Grok 协议与 Token 计数

## [0.12.1] - 2026-06-26
- feat(app): 完善模型目录与服务兜底逻辑
- feat(pricing): 更新服务商套餐数据与前端展示逻辑

## [0.12.0] - 2026-06-25
- feat(provider): 支持关闭额外请求封装并优化 Grok 协议与 Token 计数
- feat(pricing): add 华为云 Token Plan (智果园) — closes #160

## [0.11.11] - 2026-06-16
- feat(config): 新增 coding-plans.autoRefreshModels 配置项

## [0.11.10] - 2026-06-15
- feat(config): 迁移 thinking 配置至 capabilities 并重命名为 thinkingType

## [0.11.3] - 2026-06-12
- feat(provider): 优化模型协议适配与请求格式定义
- feat(config): 集成 models.dev 自动补全模型元数据
- feat(config): 支持模型成本元数据配置
- refactor(config): 移除配置项中的 toolCalling 和 vision 属性
- refactor(config): 更新 reasoningEffortFormat 枚举值与逻辑
- refactor(config): 移除已废弃的 apiType 配置字段
- feat(core): 支持 multi-find-replace 编辑工具
- build(config): 配置 editorconfig 与 prettier 相关环境
- feat(config): 支持 Copilot 风格协议配置与模型参数扩展

## [0.10.2] - 2026-06-09
- fix(assets): 优化套餐配置信息的文本格式
- feat(commands): 新增更新模型列表命令

## [0.10.1] - 2026-06-04
- feat(providers): 支持多模态消息内容并更新版本至 0.10.0
- feat(config): 将 API Key 字段标记为废弃并支持临时回退配置
- feat(pricing): 更新 AI 供应商套餐信息与解析脚本
- feat(config): 扩展 openai-chat 模型 Thinking Effort 配置项
- feat(model): 将 thinkingEffort 默认值调整为 high 并优化 Anthropic 使用量统计
