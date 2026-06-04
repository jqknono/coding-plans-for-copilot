# Changelog

All notable changes to this project will be documented in this file.

## [0.10.1] - 2026-06-04
- feat(providers): 支持多模态消息内容并更新版本至 0.10.0
- feat(config): 将 API Key 字段标记为废弃并支持临时回退配置
- feat(pricing): 更新 AI 供应商套餐信息与解析脚本
- feat(config): 扩展 openai-chat 模型 Thinking Effort 配置项
- feat(model): 将 thinkingEffort 默认值调整为 high 并优化 Anthropic 使用量统计

## [0.10.0] - 2026-06-04
- feat(providers): 支持多模态消息内容并更新版本至 0.10.0

## [0.9.15] - 2026-06-02
- Maintenance updates

## [0.9.14] - 2026-06-02
- feat(config): 将 API Key 字段标记为废弃并支持临时回退配置
- feat(pricing): 更新 AI 供应商套餐信息与解析脚本

## [0.9.13] - 2026-06-01
- feat(model): 将 thinkingEffort 默认值调整为 high 并优化 Anthropic 使用量统计
- feat(provider): 更新 Anthropic thinking 配置项名称与值
- feat(provider): 更新 openai-responses 协议并添加推理参数自动降级
- feat(adapter): 支持转发模型配置并更新版本号
- feat(config): 优化模型参数配置与 Thinking Effort 协议适配
- feat(config): 新增模型 enabled 配置项以支持隐藏模型
- feat(provider): 优化语言模型提供程序注册与分组过滤逻辑
- feat(provider): 优化 openai-responses 协议支持并引入 Personality 配置

## [0.9.0] - 2026-05-19
- feat(config): 废弃供应商与模型级 temperature 配置
- feat(config): 移除模型级 thinkingEffort 配置并改为请求级设置
- feat(provider): 限制未显式添加 group 的模型暴露
- fix(extension): 延迟注册语言模型提供程序并修复模型可见性
- feat(test): 添加扩展测试配置与文档

## [0.8.4] - 2026-05-14
- feat(config): 废弃 settings.json 中的 API Key 配置
- feat(config): 新增供应商配置管理向导并优化模型加载逻辑

## [0.8.1] - 2026-05-13
- feat(config): 新增供应商配置管理向导并优化模型加载逻辑

## [0.7.19] - 2026-05-08
- feat(config): 更新内置供应商配置并优化模型视觉能力管理
