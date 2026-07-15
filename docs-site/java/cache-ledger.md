# CacheLedger 计费桥接

这一章讲全项目**唯一一处 Java 与 Python 直接对话**的地方。理解它，你就理解了「两个后端如何协作而不互相拖垮」。

## 它解决什么问题

平台里有两套系统会消耗 token、命中缓存、产生用量：

- Java 主系统的普通对话（`chat` 场景）
- Python AutoCode 的编程任务（`autocode` 场景）

如果各记各的账，就会出现两套口径、两张表、两份统计，最后对不上。CacheLedger 的设计目标是：**统一一本缓存/用量台账**，两个系统都往同一个地方写事件，由 Python 侧统一落库和聚合。

於是分工变成：

- **Python 侧**是台账的「唯一权威」——建表、落库、聚合统计、沉淀可复用方案（solved pattern）。
- **Java 侧**是台账的「一个上报方」——通过 HTTP 把自己产生的缓存/用量事件推过去。

## Java 侧：一个极度克制的 HTTP 客户端

Java 端只有一个类 `CacheLedgerClient`，本质是对 Python `/api/cache/*` 接口的薄封装。它最重要的特质是**克制**：绝不因为台账服务的任何问题影响主对话。

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/CacheLedgerClient.java:129"
  :notes="[
    { lines: '1-4', text: 'baseUrl 没配置就直接返回空 Map，整个台账功能优雅关闭。这意味着不接 Python 服务时，Java 主系统照常跑。' },
    { lines: '6-11', text: 'WebClient 发 POST，block 等待，但设了超时下限（至少 500ms）。台账是旁路，不能让它拖慢对话。' },
    { lines: '12-15', text: '任何异常只记 debug 级日志然后吞掉，返回空 Map。这是关键——台账挂了，用户对话不受任何影响。' }
  ]">

```java
private Map<String, Object> post(String path, Map<String, Object> body) {
    if (!isEnabled()) {
        return Map.of();
    }
    try {
        Object response = client().post()
                .uri(path)
                .bodyValue(body)
                .retrieve()
                .bodyToMono(Object.class)
                .block(Duration.ofMillis(Math.max(500, timeoutMs)));
        if (response instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
    } catch (Exception e) {
        log.debug("[CacheLedger] request skipped: path={}, error={}", path, e.getMessage());
    }
    return Map.of();
}
```

</SourceExplainer>

::: tip 旁路服务的黄金法则
一个「锦上添花」的功能（统计、埋点、台账）**永远不能**成为核心链路的故障点。CacheLedgerClient 把这条法则贯彻得很彻底：没配置就关闭、有超时、异常全吞。你在自己项目里接埋点/统计时，值得照抄这个姿态。
:::

## 一次 provider 用量上报长什么样

Java 对话结束后，会把这一轮的 token 消耗和缓存命中情况打包成一个事件推给台账：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/CacheLedgerClient.java:69"
  :notes="[
    { lines: '1-3', text: '标注为 L3 缓存层，cache_key 用 session + model 拼成，让同一会话同一模型的事件能聚在一起。' },
    { lines: '4', text: '有 cached_input_tokens 就算命中（hit），否则算未命中（miss）。命中与否直接由上游 provider 返回的缓存 token 数决定。' },
    { lines: '5-11', text: '带上租户、用户、会话、模型、provider 等维度，供后续按任意维度聚合。' },
    { lines: '12-15', text: '估算省下的延迟和 token。命中时省下的延迟粗略按三分之一估算——这是一个务实的近似，台账追求趋势而非精确。' }
  ]">

```java
Map<String, Object> event = new HashMap<>();
event.put("cache_layer", "L3");
event.put("cache_key", "java-provider:" + safe(sessionId) + ":" + safe(model));
event.put("status", cachedInputTokens > 0 ? "hit" : "miss");
event.put("scene_type", "chat");
event.put("tenant_id", safe(tenantId));
event.put("user_id", safe(userId));
event.put("session_id", safe(sessionId));
event.put("model", safe(model));
event.put("provider", safe(provider));
event.put("input_tokens", Math.max(0, inputTokens));
event.put("cached_input_tokens", Math.max(0, cachedInputTokens));
event.put("output_tokens", Math.max(0, outputTokens));
event.put("latency_saved_ms", cachedInputTokens > 0 ? Math.max(1, latencyMs / 3) : 0);
event.put("token_saved_estimate", Math.max(0, cachedInputTokens));
recordEvent(event);
```

</SourceExplainer>

`recordEvent` 只是把事件 POST 到 Python 的 `/events` 端点。接下来的落库、聚合，全在 Python 侧。

## Python 侧：台账的权威落地

Python 的 `CacheLedgerService` 才是真正管数据的一方。它做三件事：**建表 → 落库 → 聚合**。

### 事件的规范化

无论事件从哪来（Java 推的、还是 AutoCode 自己产的），进库前都先过一次 `normalized()`：

<SourceExplainer
  file="agent-platform/backend/services/cache_ledger_service.py:129"
  :notes="[
    { lines: '3', text: 'status 统一小写，cache_layer 统一大写。跨系统上报最怕大小写不一致导致聚合分裂，这里强制归一。' },
    { lines: '4-5', text: 'cache_key 或 input_hash 为空时，用整个事件内容的稳定哈希兜底，保证每条事件都可定位。' },
    { lines: '6', text: 'metadata 做长度裁剪，避免超大字段撑爆 JSON 列。' }
  ]">

```python
def normalized(self) -> dict[str, Any]:
    data = asdict(self)
    data["status"] = (self.status or "miss").lower()
    data["cache_layer"] = (self.cache_layer or "unknown").upper()
    data["cache_key"] = self.cache_key or stable_hash(data)
    data["input_hash"] = self.input_hash or stable_hash(self.metadata)
    data["metadata"] = _trim(self.metadata or {})
    return data
```

</SourceExplainer>

### 落库：也有 fallback

有意思的是，Python 侧自己也有一套「降级」哲学，和 Java 侧呼应：

<SourceExplainer
  file="agent-platform/backend/services/cache_ledger_service.py:214"
  :notes="[
    { lines: '2-4', text: '先无条件把事件塞进内存 fallback 列表，并限制上限（超过 5000 条就裁掉最老的 1000 条）。这样即使 MySQL 连不上，最近的事件也不丢，stats 仍能从内存聚合。' },
    { lines: '5-6', text: 'MySQL 连不上就直接返回，不抛异常。台账在 Python 侧同样是「尽力而为」，不阻塞 AutoCode 任务。' },
    { lines: '7-', text: 'MySQL 可用时才真正 INSERT。失败也只记 debug 日志，靠前面的内存 fallback 兜底。' }
  ]">

```python
def record(self, event):
    data = event.normalized() if isinstance(event, CacheLedgerEvent) else CacheLedgerEvent(**event).normalized()
    _events_fallback.append(data)
    if len(_events_fallback) > 5000:
        del _events_fallback[:1000]
    if not _test_mysql_connection():
        return data
    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute(f"INSERT INTO `{CACHE_LEDGER_TABLE}` (...) VALUES (...)", (...))
    except Exception as exc:
        logger.debug(f"[CacheLedger] record failed, kept fallback: {exc}")
    return data
```

</SourceExplainer>

::: tip 两端对称的降级设计
注意 Java 和 Python 两端不约而同都做了「异常吞掉 + 兜底」：Java 端配置缺失就关闭、异常返回空 Map；Python 端 MySQL 挂了就走内存 fallback。这不是巧合——**台账服务的正确姿态就是"能记则记，记不上也别拦路"**。两端都把这条贯彻到底，整条链路才真正稳。
:::

## 表结构：一张事件表 + 一张方案表

Python 侧 `init()` 会自动建两张表：

| 表 | 作用 |
|----|------|
| `cache_ledger`（事件表） | 每条缓存/用量事件一行，带 layer/status/scene/user/model 等维度和多组 token 计数，建了 4 个复合索引支撑按不同维度聚合 |
| `solved_pattern`（方案表） | 沉淀「已解决的问题模式」：指纹、技术栈、根因、补丁摘要、验证命令、复用策略、命中次数。这是 AutoCode「记住解过的问题、下次直接复用」的存储基础 |

`solved_pattern` 的 `UNIQUE KEY (fingerprint, scene_type, tenant_id)` 保证同一个问题在同一场景同一租户下只沉淀一份，靠 `hit_count` / `stale_count` 记录它被复用/失效的次数。

## 全链路视角

<FlowTimeline
  title="一次 Java 对话产生的台账事件流转"
  :steps='[
    { system: "Spring Boot", title: "对话结束", detail: "AiService 拿到 usage：input/cached/output tokens", file: "backend/.../AiService.java" },
    { system: "Java", title: "组装 L3 事件", detail: "recordProviderUsage 打包成事件 Map", file: "backend/.../CacheLedgerClient.java:69" },
    { system: "Java", title: "POST /events", detail: "WebClient 推给 Python，异常全吞", file: "backend/.../CacheLedgerClient.java:129" },
    { system: "Python", title: "规范化", detail: "normalized 统一大小写、补哈希、裁剪 metadata", file: "agent-platform/.../cache_ledger_service.py:129" },
    { system: "Python", title: "写内存 fallback", detail: "先入内存列表，MySQL 挂了也不丢", file: "agent-platform/.../cache_ledger_service.py:214" },
    { system: "MySQL", title: "INSERT cache_ledger", detail: "落库，供后续按维度聚合统计", file: "agent-platform/.../cache_ledger_service.py:224" }
  ]'
/>

## 小结

- CacheLedger 是两个后端之间**唯一的直接业务桥**，用最朴素的 HTTP + JSON 打通。
- 职责清晰：**Python 是权威（落库/聚合/沉淀），Java 是上报方**。
- 两端都把「旁路服务不拖垮主链路」贯彻到底：配置缺失即关闭、超时、异常吞掉、内存兜底。
- 它同时承载两个价值：**统一用量台账** + **沉淀可复用方案（solved pattern）**，后者是 AutoCode 越用越聪明的存储底座。

想看两个后端为什么要拆开、以及它们各自的边界，回到 [三系统整体架构](/guide/architecture)。
