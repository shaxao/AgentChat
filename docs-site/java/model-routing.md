# 模型路由

平台接了 OpenAI、Anthropic、Google、阿里云、DeepSeek 等一堆模型和渠道。用户发一条消息，**到底用哪个模型、走哪个渠道**？这就是模型路由要回答的问题。

核心实现在 `backend/.../service/ModelRoutingService.java`。它做的不是简单的「查表」，而是一套**打分 + 场景规则 + 熔断**的选择器。

## 一句话概括

> 给每个可用模型打个分（0~100），选分最高的；同时把最近老失败的模型「熔断」掉，暂时不选它。

## 入口：selectModel

<SourceExplainer
  file="backend/.../service/ModelRoutingService.java:92"
  :notes="[
    { lines: '3', text: 'applyBestMatchingRule：先套用最匹配的场景路由规则（把规则里的能力要求、偏好厂商、价格上限灌进 context）。' },
    { lines: '5-7', text: 'filterModels：按熔断状态、能力、上下文长度、价格上限过滤。全被过滤光了就放开限制兜底，保证总能返回。' },
    { lines: '11-21', text: '对每个候选模型算 score 和 reason，打包成 CandidateModel。' },
    { lines: '22-23', text: '按分数从高到低排序，取第一名作为路由结果。' }
  ]">

```java
public RouteResult selectModel(RouteContext context) {
    RouteContext ctx = context != null ? context : new RouteContext();
    applyBestMatchingRule(ctx);

    List<ModelConfig> filteredModels = filterModels(getAvailableModels(), ctx);
    if (filteredModels.isEmpty()) filteredModels = getAvailableModels();
    if (filteredModels.isEmpty()) return null;

    Map<String, ModelChannel> channelsByModel = activeChannelsByModel();
    List<CandidateModel> candidates = new ArrayList<>();
    for (ModelConfig model : filteredModels) {
        ModelChannel channel = channelsByModel.get(model.getModelId());
        CandidateModel candidate = new CandidateModel();
        candidate.setModelId(model.getModelId());
        candidate.setChannelId(channel == null ? null : ...);
        candidate.setProvider(...);
        candidate.setScore(scoreModel(model, ctx));
        candidate.setReason(buildReason(model, ctx));
        candidates.add(candidate);
    }
    if (candidates.isEmpty()) return null;
    candidates.sort((a, b) -> Double.compare(b.getScore(), a.getScore()));
    CandidateModel best = candidates.get(0);
    // ... 打包成 RouteResult 返回（含全部 candidates，方便调试）
}
```

</SourceExplainer>

注意最后 `result.setCandidates(candidates)`——路由结果里带上了**所有候选和它们的得分**。这在调试「为什么选了这个模型」时非常有用，前端的模型路由页就是靠这个把打分明细画出来的。

## 打分规则 scoreModel

这是路由的灵魂。基础分 50，然后各维度加减：

<SourceExplainer
  file="backend/.../service/ModelRoutingService.java:233"
  :notes="[
    { lines: '2', text: '基础分 50 分——所有模型的起跑线。' },
    { lines: '3', text: '能力匹配 +20：要求 vision/tool 等能力且该模型具备，加 20 分。这是权重最大的一项。' },
    { lines: '4', text: '偏好厂商 +12：命中场景规则或请求指定的偏好厂商。' },
    { lines: '5', text: '路由优先级：管理员给模型配的 routingPriority，乘 1.2，最多加 10 分。' },
    { lines: '6', text: 'costScore：越便宜分越高（免费 8 分，≤1 得 7 分，≤5 得 4 分，更贵 1 分）——鼓励用便宜模型。' },
    { lines: '7', text: 'userPreferenceScore：用户对某模型的偏好权重，范围 ±8 分——支持个性化。' },
    { lines: '10', text: '最终裁剪到 [0,100] 区间。' }
  ]">

```java
private double scoreModel(ModelConfig model, RouteContext ctx) {
    double score = 50.0;
    if (hasCapabilities(model, ctx.getRequiredCapabilities())) score += 20.0;
    if (matchesPreferredProvider(model, ctx)) score += 12.0;
    score += Math.min(10.0, nvl(model.getRoutingPriority()) * 1.2);
    score += costScore(model);
    score += userPreferenceScore(model, ctx);
    if (model.getContextLength() != null && ctx.getMinContextLength() != null
            && model.getContextLength() >= ctx.getMinContextLength()) score += 5.0;
    return Math.max(0.0, Math.min(100.0, score));
}
```

</SourceExplainer>

这套加权设计的思路值得体会：**没有硬规则说「必须用某模型」，而是把多个考量（能力、成本、优先级、个人偏好）折算成分数一起比较。** 想调整路由倾向，改的是权重，不是 if-else 分支。

## 熔断器 CircuitBreaker

如果某个模型/渠道连续失败（比如上游挂了、限流了），继续往它上面撞就是浪费时间。路由服务内置了一个**熔断器**：

<SourceExplainer
  file="backend/.../service/ModelRoutingService.java:174"
  :notes="[
    { lines: '4-8', text: 'recordFailure：每次失败累加 consecutiveFailures，并更新持久化的统计表。' },
    { lines: '9', text: '连续失败达到阈值 CIRCUIT_BREAKER_THRESHOLD，就把熔断状态置为 open（断开）。' },
    { lines: '11-15', text: '同时更新内存缓存 circuitBreakerCache——filterModels 里用它快速判断某模型是否被熔断，被熔断的直接跳过。' }
  ]">

```java
public void recordFailure(String modelId, String sceneType) {
    if (modelId == null || modelId.isBlank()) return;
    ModelRoutingStats stats = getOrCreateStats(modelId, sceneType);
    int failures = nvl(stats.getConsecutiveFailures()) + 1;
    stats.setConsecutiveFailures(failures);
    stats.setLastFailureTime(LocalDateTime.now());
    stats.setCircuitBreakerState(failures >= CIRCUIT_BREAKER_THRESHOLD ? "open" : "closed");
    routingStatsMapper.updateById(stats);

    CircuitBreakerState state = circuitBreakerCache.computeIfAbsent(modelId, ignored -> new CircuitBreakerState());
    state.consecutiveFailures = failures;
    state.lastFailureTime = System.currentTimeMillis();
    state.open = failures >= CIRCUIT_BREAKER_THRESHOLD;
}
```

</SourceExplainer>

对应地，`recordSuccess` 会把 `consecutiveFailures` 清零、状态改回 `closed`、并从缓存里移除熔断记录——**一次成功就恢复**。这是经典的熔断器三态思想（关闭 / 打开 / 半开）的简化实现。

熔断状态有两份存储：

- **内存缓存** `circuitBreakerCache`（`ConcurrentHashMap`）——路由时高频读，要快。
- **数据库** `model_routing_stats` 表——持久化，重启不丢，也供管理后台看统计。

## 场景路由规则

`applyBestMatchingRule` 会遍历路由规则表（`ModelRoutingRule`），找到第一条匹配当前场景的规则，把它的约束灌进 `RouteContext`：

- 个人规则优先于全局规则（`getRoutingRules` 里排序时 `isPersonalRule` 排最前）。
- 规则可以指定：要求的能力、偏好厂商、最小上下文长度、价格上限。
- 用户没显式指定的约束，才用规则填充（不覆盖用户的显式选择）。

这实现了「**管理员配策略、用户可覆盖**」的两层控制。

## 全链路里的位置

回顾 [SSE 流式对话](/java/sse-chat) 里 `ChatController` 的 `resolveModelWithRouting`——当用户选了 `auto` 或没指定模型时，就会走到这里的 `selectModel`。路由决定了后面 `AiService` 去连哪个渠道。

## 动手观察

管理后台的「模型路由」页（`app/src/pages/ModelRoutingPage.tsx`）可以：

- 看每个模型的实时得分和候选排名
- 看熔断器状态（哪些模型正被熔断、断了多久）
- 手动重置熔断（`resetCircuitBreaker`）
- 配置场景路由规则

## 相关源码

- `backend/.../service/ModelRoutingService.java` — 路由主逻辑、打分、熔断
- `backend/.../controller/ModelRoutingController.java` — 路由管理 API
- `backend/.../entity/ModelRoutingRule.java`、`ModelRoutingStats.java` — 规则与统计表
- `docs/architecture/model_routing_implementation.md` — 项目自带的路由设计文档

下一篇 [CacheLedger 计费桥接](/java/cache-ledger) 讲另一个跨系统的核心机制：AutoCode 用了模型，费用怎么算回到 Java 主系统。
