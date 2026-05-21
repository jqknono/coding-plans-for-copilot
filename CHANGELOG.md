# Changelog

All notable changes to this project will be documented in this file.

## [0.9.10] - 2026-05-21
- feat(provider): 更新 openai-responses 协议并添加推理参数自动降级

## [0.9.9] - 2026-05-20
- feat(config): 优化模型参数配置与 Thinking Effort 协议适配

## [0.9.7] - 2026-05-20
- Maintenance updates

## [0.9.6] - 2026-05-20
- feat(provider): 优化语言模型提供程序注册与分组过滤逻辑

## [0.9.3] - 2026-05-19
- feat(config): 废弃供应商与模型级 temperature 配置
- feat(config): 移除模型级 thinkingEffort 配置并改为请求级设置
- feat(provider): 限制未显式添加 group 的模型暴露
- fix(extension): 延迟注册语言模型提供程序并修复模型可见性
- feat(test): 添加扩展测试配置与文档

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
