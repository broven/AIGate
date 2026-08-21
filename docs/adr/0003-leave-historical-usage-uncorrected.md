# 不修复存量 daily_usage 中的非有限成本值

无价 Deployment 曾以 `Infinity` 价格参与路由，写入的 `cost` / `savedVsDirect` 为 `±Infinity`，被累加进 `daily_usage` 后永久污染该行。`/api/stats` 的累计统计对全表无日期过滤求和，因此**累计成本与累计节省会永久序列化为 `null`**（"今日"那组按日期过滤，每天自愈）。我们选择不做数据修复。

## Consequences

- 修复上线前的历史成本数据不可信，需在 CHANGELOG 中标注一条计费准确性分界日期。
- 成本上限功能不受影响：它读取新建的 spend 计数表，从零开始，且守卫会拒绝写入非有限值。
- 若日后改变主意，代价仅为 migration 中两行 `UPDATE`。
