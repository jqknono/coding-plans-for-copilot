# Changelog

All notable changes to this project will be documented in this file.

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

## [0.7.12] - 2026-04-27
- chore: 升级版本至 0.7.9 并更新变更日志

## [0.7.2] - 2026-04-16
- feat(commitMessageGenerator): 增强风格参考约束与回退格式优先级

## [0.7.1] - 2026-04-16
- chore: 升级版本至 0.7.1

## [0.7.0] - 2026-04-16
- feat(model): 实现基于上下文窗口的动态隐式输出预留逻辑
- feat(crawler): 增加分析结果统计并更新工作流配置
- chore(assets): 更新供应商价格、套餐及运行指标数据
- fix discussion labels workflow
- ci(workflow): 重构社区帖子爬取工作流并增加 Token 校验
- chore(scripts): 优化京东云与无界 AI 价格抓取逻辑并更新数据
- fix: retry transient openrouter metrics fetches
- feat(pricing): 新增 GitHub Copilot 价格数据并更新抓取脚本

## [0.6.28] - 2026-04-03
- fix(config): 模型写回时不再默认落 apiStyle/maxInputTokens/maxOutputTokens，仅保留用户显式配置的字段
