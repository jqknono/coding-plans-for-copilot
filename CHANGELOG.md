# Changelog

All notable changes to this project will be documented in this file.

## [0.8.7] - 2026-05-15
- docs(docs): 更新模型可见性配置说明并优化模型选择器适配
- chore(release): 升级版本至 0.8.5 并优化命令显示逻辑
- feat(config): 废弃 settings.json 中的 API Key 配置
- feat(config): 新增供应商配置管理向导并优化模型加载逻辑

## [0.8.6] - 2026-05-15
- docs(docs): 更新模型可见性配置说明并优化模型选择器适配

## [0.8.5] - 2026-05-14
- chore(release): 升级版本至 0.8.5 并优化命令显示逻辑

## [0.8.4] - 2026-05-14
- feat(config): 废弃 settings.json 中的 API Key 配置
- feat(config): 新增供应商配置管理向导并优化模型加载逻辑

## [0.8.1] - 2026-05-13
- feat(config): 新增供应商配置管理向导并优化模型加载逻辑

## [0.7.19] - 2026-05-08
- feat(config): 更新内置供应商配置并优化模型视觉能力管理
- docs: update README - remove Claude Code ref, add DeepSeek, remove Infini, use English commands
- docs: use raw.githubusercontent.com for preview image

## [0.7.18] - 2026-05-06
- docs: add dashboard preview screenshot
- feat(provider): 支持在模型返回空响应时自动切换至 Responses API
- feat(pages): 抓取失败的 provider 不再显示套餐卡片
- chore(metrics): 更新 OpenRouter 提供商指标数据
- chore(assets): 更新 OpenRouter 提供商指标与定价数据
- chore: 统一 API 密钥变量名并优化工作流推送逻辑
- feat(provider): 更新服务商指标与定价并增强抓取校验
- feat(provider): 更新模型服务商运行指标与定价数据

## [0.7.17] - 2026-05-06
- feat(pages): 抓取失败的 provider 不再显示套餐卡片
- chore(metrics): 更新 OpenRouter 提供商指标数据
- chore(assets): 更新 OpenRouter 提供商指标与定价数据
- chore: 统一 API 密钥变量名并优化工作流推送逻辑
- feat(provider): 更新服务商指标与定价并增强抓取校验
- feat(provider): 更新模型服务商运行指标与定价数据

## [0.7.16] - 2026-04-28
- fix(provider): 清理转发至 Anthropic 的工具 Schema 扩展字段
- feat(provider): 优化 topP 采样逻辑并增强 Anthropic 兼容性
- ci: 在版本标签工作流中增加 GitHub Release 创建和 VSIX 上传
- fix #98: 支持 DeepSeek 思考模型上下文往返并优化 Token 计数逻辑

## [0.7.14] - 2026-04-28
- chore: 升级版本至 0.7.14
