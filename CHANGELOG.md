# Changelog

All notable changes to this project will be documented in this file.

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

## [0.6.26] - 2026-03-31
- feat(config): 更新供应商配置并优化模型管理

## [0.6.25] - 2026-03-30
- feat(套餐使用): 新增套餐使用状态栏与轮询功能

## [0.6.17] - 2026-03-28
- feat(定价数据): 更新定价数据并增强错误处理机制
- feat(config): 优化模型配置与输出预算管理
- feat(provider): 新增京东云支持并更新 Kimi 价格数据

## [0.6.6] - 2026-03-24
- feat(provider): 为提交信息生成请求添加来源标识并优化用量统计
