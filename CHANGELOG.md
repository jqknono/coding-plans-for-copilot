# Changelog

All notable changes to this project will be documented in this file.

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

## [0.6.5] - 2026-03-22
- feat(ci): 更新 GitHub Actions 版本并调整 Node.js 环境至 v24

## [0.6.4] - 2026-03-22
- fix(docs): 更新上下文窗口文档与状态栏显示逻辑
- feat: 支持 contextSize 配置并优化上下文窗口处理

## [0.6.2] - 2026-03-19
- fix(provider-pricing): 更新供应商定价数据及资源链接
- fix(#8): 更新 OpenRouter 指标采集流程
- build(workflow): 更新 OpenRouter 指标与套餐抓取流程
- feat(ci): 调整 OpenRouter 模型数据最大缓存天数
- fix(provider-pricing): 更新模型定价数据和爬虫逻辑
- fix(docs): 更新废弃字段 maxInputTokens 和 maxOutputTokens 的描述信息

## [0.6.1] - 2026-03-19
- fix(docs): 更新废弃字段 maxInputTokens 和 maxOutputTokens 的描述信息

## [0.6.0] - 2026-03-19
- feat(ci): 调整 OpenRouter 模型数据最大缓存天数
- fix(provider-pricing): 更新模型定价数据和爬虫逻辑
- fix(docs): 更新废弃字段 maxInputTokens 和 maxOutputTokens 的描述信息
- feat(metrics): 添加指标页面失败项显示区域

## [0.5.2] - 2026-03-11
- feat(pages): 添加 GitHub Pages 冒烟测试和更新定价数据
- feat(config): 改进模型配置处理逻辑
- #6 feat(pricing): 添加讯飞星辰定价信息
- chore(pricing): 更新定价数据和脚本名称
- feat(model): 保留已配置模型对象的完整字段
- chore(changelog): 更新 0.5.0 发布日志
- feat(provider): 支持多协议供应商接入
- feat(scripts): 增加 Redpill 自定义解析及界面调整
- chore(docs): 更新价格指标文档与数据
