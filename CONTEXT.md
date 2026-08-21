# AIGate

一个比价路由的 LLM 网关：把多个上游 AI 服务聚合起来，按价格为每个请求挑选最便宜的可用通道，并记录用量与成本。

## Language

**Provider**:
一个上游 AI 服务的账号，由凭证、端点和协议格式共同定义。
_Avoid_: 渠道, 供应商, upstream

**Group**:
Provider 内部的分组。同一个模型在不同 Group 下可能有不同的倍率和独立令牌。
_Avoid_: 渠道, channel, 分组令牌

**Canonical Model**:
归一化后的模型名，是跨 Provider 比价的公共键。同一个 Canonical Model 可以由多个 Provider 提供。
_Avoid_: model name, 标准模型名

**Model Deployment**:
可被调度的最小单元，等于 Provider × Group × Canonical Model。它承载真实的上游模型 id、独立令牌与价格。由同步过程自动增删，是派生数据而非人工配置的对象。
_Avoid_: endpoint, 实例, 通道

**Virtual Model**:
由用户定义的、映射到一组 Model Deployment 的模型名，用于表达合并或降级链等调度意图。

**Cost Multiplier**:
挂在 Provider 上的价格**校正**系数，用于把上游公布的价目表修正为真实支付金额（中转站自带倍率、或倍率为 0 的免费渠道）。它不是加价系数，也不是路由偏好旋钮——校正后的价格必须始终等于真实支出。
_Avoid_: 加价, markup, 权重

**Spend**:
一个 Provider 在某个时间窗口内产生的真实支出累计，以 UTC 日为最小粒度。
_Avoid_: usage, quota, 用量

**Cost Limit**:
挂在 Provider 上的支出上限（日 / 月）。达到后该 Provider 的全部 Model Deployment 一并退出调度候选。留空表示不限。
_Avoid_: quota, 配额, rate limit

**Saved vs Direct**:
相对于直连该 Canonical Model 的**第一方**官方 API 所节省的金额。第一方无法解析时该值缺失，而非退化为近似。
_Avoid_: 节省, discount
