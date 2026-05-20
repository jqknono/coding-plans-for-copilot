# VS Code Language Model Settings Group Bug

更新时间：2026-05-20

## TODO

- 当前结论：`modelConfiguration` / 模型行 `More Actions` settings 错位问题暂不在本仓库绕过处理。
- 上游 issue：https://github.com/microsoft/vscode/issues/317500
- 阻塞原因：VS Code 1.120 的 `setModelConfiguration` 归属逻辑在新增 settings 时只按 contributed vendor 选择 group；当多个 group 共用同一个 vendor 且目标模型没有现有 settings 记录时，会回退到第一个同 vendor group。
- 处理策略：等待 VS Code 上游 issue 明确修复或给出公开 API/推荐模式后，再评估本仓库是否需要调整 provider/group 设计。
- 禁止方案：不直接监控或改写 VS Code 维护的 `chatLanguageModels.json` 作为长期修复。

## 现象

多个逻辑供应商通过同一个 VS Code `languageModelChatProviders` vendor（当前为 `coding-plans`）暴露时，VS Code 可能把 `cliproxyapi/...` 模型的 settings 写入第一个同 vendor group，例如 `qtdev`。

错误示例：

```json
[
	{
		"name": "qtdev",
		"vendor": "coding-plans",
		"vendorName": "qtdev",
		"settings": {
			"cliproxyapi/violetgray835/gpt-5.4": {
				"thinkingEffort": "low"
			}
		}
	},
	{
		"name": "cliproxyapi",
		"vendor": "coding-plans",
		"vendorName": "cliproxyapi"
	}
]
```

期望应写入 `name/vendorName = cliproxyapi` 的配置块。
