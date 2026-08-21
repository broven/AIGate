# Cloudflare Workers AI 复用 openai-compatible，不新增 provider type

Cloudflare Workers AI 提供完全 OpenAI 兼容的 `.../ai/v1/chat/completions` 端点，因此以 `type=openai-compatible` + `endpoint=https://api.cloudflare.com/client/v4/accounts/{account_id}/ai` 接入，协议层零改动。新增一个 `cloudflare` type 需要改动 7 处（shared 类型、schema CHECK 约束的整表重建 migration、adapter registry、price-router 的硬编码分支、sync 分发、dashboard 类型与表单），而唯一的实质收益仅是把 account id 独立成列——这与表中已有的 `newApiUserId` / `accessToken` 是同一种坏味道。

## Consequences

- 价格来自 models.dev 的 `cloudflare-workers-ai`（已核对：`llama-3.3-70b-fp8-fast` 的 $0.293/$2.253 与官方 neuron 换算分毫不差），因此**不需要自行维护 neuron 单价表**。
- **实测（2026-08-21）**：CF 的 `.../ai/v1/models` 返回 HTTP 405——它的 OpenAI 兼容面并没有 `/v1/models`。既有同步逻辑对非 2xx 响应抛错并回退到 `modelsDevSlug`，因此 CF 无需任何改动即可取得模型列表与价格。
- 仍然把**模型列表来源与价格来源解耦**（`modelsDevSlug` 只要设置就优先用于定价），但理由不是 CF：一旦取消裸 id 的模糊前缀匹配、并拒绝路由无价 Deployment，那些「`/v1/models` 正常但不返回价格」的 provider（vLLM / Ollama / Azure）会从「拿到一个错但存在的价格」变成「无价、被拒绝路由」。解耦后运维可以给它们配 slug 来恢复定价。
- models.dev 收录 25 个 CF 模型，其中 6 个带 `cache_read`；`deepseek-v4-flash-0731` 在收录范围内，价格与官方 neuron 换算逐项吻合。CF 实际可用模型多于 25 个，未收录者按「无价拒绝路由」处理。
- 不为 CF 的 `4006`（免费额度耗尽）做特判：Paid 计划下它不会触发，而它偶发的误报由既有的错误分类与指数退避 cooldown 处理已经足够。
