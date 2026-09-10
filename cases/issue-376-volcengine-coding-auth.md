# Issue #376：火山 Coding Plan 模板与可选认证

## 范围与依据

- [Issue #376](https://github.com/jqknono/coding-plans-for-copilot/issues/376)。此前模板为 `/api/coding`、`anthropic`、空 `models`、开启发现；本扩展仅追加 `/messages`，且此前 Anthropic 固定使用 `x-api-key`。
- 2026-09-10 调查时读取了更新于 2026-09-08 的官方文档：[Claude Code](https://docs.volcengine.com/docs/82379/1928262) 使用 `ANTHROPIC_AUTH_TOKEN`；[Codex](https://docs.volcengine.com/docs/82379/2556056) 使用 `wire_api = "responses"`；[API 支持](https://docs.volcengine.com/docs/82379/2188958) 确认 Chat 与 Responses 都支持，推荐 Responses。
- 模板静态 ID：`doubao-seed-evolving`、`doubao-seed-2.1-turbo`、`doubao-seed-2.0-lite`、`minimax-m3`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`kimi-k2.7-code`、`kimi-k3`。不推断模型级 vision、contextSize、thinking 参数。
- 无真实火山 Key 实测。下表 HTTP 401/403/404 为 mock 场景，不代表已独立验证上游 401 或 `/models` 不存在。发现失败会回退静态/缓存模型，不能描述为必然清空列表。

## 验收用例

自动回归复用 `src/test/runTest.ts` 的 `runVendorAuthAndVolcengineTests`；原有默认请求包用例 A3/A4 与 group 过滤用例继续适用。

| ID | Given / When | Then |
| --- | --- | --- |
| V1 | 三协议各自归一化缺省、`bearer`、`x-api-key`、非法类型/枚举（含空串、大小写和空格变体） | 仅精确合法值保留；非法值视为缺省，不丢弃供应商或改变协议 |
| V2 | 三协议 × 缺省及两个显式 authType 发起聊天 | 缺省按实际模型协议选头；显式仅发所选认证头；Anthropic 始终保留 `anthropic-version: 2023-06-01`；Content-Type 与取消信号保持有效 |
| V3 | 供应商默认与模型级 apiStyle 不同 | 模型协议优先，认证缺省也按实际请求协议；设置显式 authType 不改变协议 |
| V4 | Coding v3 Chat/Responses，Coding v1 Anthropic，baseUrl 含单个尾斜杠 | 分别精确请求 `https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions`、`https://ark.cn-beijing.volces.com/api/coding/v3/responses`、`https://ark.cn-beijing.volces.com/api/coding/v1/messages` |
| V5 | 三协议聊天返回 mock 401/403/404 | 单次请求失败，不暗中切认证、不补 `/v1`、不重试、不切到通用计费端点 |
| V6 | 三种 defaultApiStyle × 三种认证配置发起发现 | GET `baseUrl + /models` 使用供应商认证；失败回退配置且不写回；同签名的 401 抑制重复发现，改变 authType 后允许新发现，签名无明文密钥 |
| V7 | 检查 package.json Schema 与火山模板 | authType 可选且无固定 default；名称保持 `火山引擎`，Coding v3 Responses、关闭发现、十个仅含 name 的静态模型 |
| V8 | 使用火山模板初始化，再强制刷新（discoverFromEndpoint + forceDiscoveryRetry） | 模型列表保留，所有模型继承 Responses，不请求 `/models` 或 models.dev，不写回配置，不改变同名 Secret Storage 密钥 |
| V9 | 真实 provider + adapter 查询 `group=火山引擎` 或显式 configuration.vendorName | 返回全部静态模型；无 group 或默认 `Coding Plans` group 仍返回空列表 |

## 用户配置与手工验收

1. 在“管理供应商配置”中为 `火山引擎` 保存 Coding Plan Key，不在日志或文档中回显。
2. 新默认模板使用 `baseUrl=https://ark.cn-beijing.volces.com/api/coding/v3`、`defaultApiStyle=openai-responses`、`useModelsEndpoint=false` 和上述静态列表。在 Manage Language Models 显式添加 `火山引擎` group，检查模型可见性，再刷新确认无模型发现请求。
3. 已有用户显式设置不会自动替换：手动更新原供应商条目，保留名称；旧 `models[].apiStyle` 优先于供应商默认，必须删除或改为目标协议。
4. 如选择 Anthropic：设置 `baseUrl=https://ark.cn-beijing.volces.com/api/coding/v1`、`defaultApiStyle=anthropic`、`authType=bearer`，保留静态模型并关闭发现。本扩展仅附加 `/messages`，不可直接使用 Claude Code 的 `/api/coding` 基地址。仍发送版本头，不发送 `x-api-key`；密钥来源仍为扩展配置/Secret Storage，而非读取 `ANTHROPIC_AUTH_TOKEN`。
5. 不得改用会产生额外按量计费的通用 `/api/v3`。使用真实账号验证最小文本/工具请求时，核对完整 Coding URL 与权限；本文不声称已完成这一上游实测。

## 本地验证入口

优先执行已有 compile 任务，再运行 `npm run typecheck`、`npm run lint`、`npm test`（包含 Desktop）。同时检查编辑器诊断和 `git diff --check`。Desktop 原有冒烟验证真实宿主激活、命令注册与未作用域化根隐藏；火山显式 group 和零发现请求由上述 mock 契约回归覆盖。