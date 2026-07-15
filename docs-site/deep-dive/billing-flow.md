# 一次计费的流转

这是全链路专题的最后一篇，也是最能体现「跨系统协作」的一篇。我们追踪**一次 AI 调用产生的费用**，看它如何从 token 用量，变成用户钱包里的扣款，以及跨进程的缓存台账记录。

读之前建议先看 [CacheLedger 计费桥接](/java/cache-ledger) 和 [钱包与订阅](/java/wallet)。这一篇把它们和实际调用链串起来。

## 计费的两条线

平台的「计费」其实是两件独立的事，别混淆：

| 线 | 记什么 | 落在哪 | 目的 |
|----|--------|--------|------|
| **钱包扣费** | 用户为这次对话付了多少钱 | Java：`sys_user.balance` + `wallet_transaction` | 真实交易，影响余额 |
| **缓存台账** | 这次调用命中/未命中缓存、省了多少 token | Python：`cache_ledger` 表 | 可观测，优化缓存策略 |

一条是「钱」，一条是「效率观测」。两条线都从同一次 AI 调用产生，但走向完全不同的存储和用途。

## 钱包扣费的时序

<FlowTimeline
  title="一次对话消费的扣费流转"
  :interval="1500"
  :steps='[
    { system: "Spring Boot", title: "对话完成", detail: "streamChat 结束，拿到 token 用量", file: "backend/.../AiService.java:456" },
    { system: "Java", title: "计算费用", detail: "input/output tokens × 模型单价", file: "backend/.../service/UsageTrackingService.java" },
    { system: "Java", title: "WalletService.consume", detail: "@Transactional 原子扣费", file: "backend/.../service/WalletService.java" },
    { system: "MySQL", title: "条件更新余额", detail: "UPDATE ... WHERE balance >= cost（乐观锁）", file: "sys_user 表" },
    { system: "Java", title: "写消费流水", detail: "wallet_transaction 插入一条 consume 记录", file: "backend/.../service/WalletService.java" },
    { system: "Java", title: "上报 provider 用量", detail: "CacheLedgerClient.recordProviderUsage", file: "backend/.../service/CacheLedgerClient.java:69" },
    { system: "Nginx", title: "跨进程调用", detail: "POST → Python /api/cache/events", file: "app/nginx.conf" },
    { system: "Python", title: "落缓存台账", detail: "CacheLedgerService.record 写 MySQL", file: "agent-platform/backend/services/cache_ledger_service.py:214" }
  ]'
/>

## 核心：原子扣费

整个流转里最关键的一步，是 `WalletService.consume` 如何保证并发安全。回顾 [钱包与订阅](/java/wallet) 讲过的手法：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/WalletService.java"
  :notes="[
    { lines: '1-5', text: '扣费前先读余额做一次快速校验。但这不是最终防线——真正的防线在下面的条件更新。' },
    { lines: '7-11', text: '关键：UPDATE 带 WHERE balance >= cost 条件。数据库层面保证「余额够才扣」，天然抗并发。这是乐观锁思想。' },
    { lines: '13-16', text: '如果 updated <= 0，说明并发下余额已被别的请求扣走，本次扣费失败，抛异常。调用方不得写成功流水。' }
  ]">

```java
BigDecimal before = safeBalance(user);
if (before.compareTo(cost) < 0) {
    throw new RuntimeException("账户余额不足");
}

int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
        .eq(SysUser::getId, userId)
        .ge(SysUser::getBalance, cost)
        .setSql("balance = balance - " + cost.toPlainString())
        .setSql("total_consumed = total_consumed + " + cost.toPlainString()));

if (updated <= 0) {
    throw new RuntimeException("账户余额不足");
}
```

</SourceExplainer>

为什么不用「读余额 → 判断 → 写余额」三步？因为那样在高并发下会有竞态：两个请求同时读到余额 100，各自判断够扣 60，结果都扣成功，余额变成 -20。而 `WHERE balance >= cost` 把「判断」和「扣减」合并成一条原子 SQL，数据库帮你锁住这一行，第二个请求的 `updated` 会是 0，自然失败。

## 核心：降级不影响主链路

第二个关键设计在 CacheLedger 上报。它是**跨进程调用**（Java → Python），网络可能超时、Python 服务可能没启动。如果这一步失败会拖垮对话吗？

不会。回顾 [CacheLedger 计费桥接](/java/cache-ledger) 讲的降级设计：

- `CacheLedgerClient.isEnabled()` 为空（没配 baseUrl）时，`post()` 直接返回空 Map，根本不发请求。
- 任何异常只打 `log.debug`，绝不向上抛。
- Python 侧 `CacheLedgerService.record` 即使 MySQL 连不上，也会先写内存 `_events_fallback`，保证数据不丢。

这是一个重要原则：**观测性功能永远不能拖垮主业务链路**。钱一定要扣对（强一致、抛异常），但缓存台账「尽力而为」（弱一致、静默降级）。两种数据用两种截然不同的可靠性策略——这正是把它们分成两条线的深层原因。

## AutoCode 任务的计费

上面讲的是普通对话。AutoCode 任务的计费走的是同一套 CacheLedger 机制，但更丰富：

- 每个工具调用带 `cost_tag`（见 [Tool Registry](/autocode/tool-registry) 的 ToolSpec），标记这次工具消耗归到哪个成本科目。
- Python 侧 `CacheLedgerEvent` 记录 `task_id`、`workspace_id`、`epoch`、`cached_input_tokens` 等字段，比对话场景细得多。
- 缓存命中（比如 SystemContext 没变、直接复用上次的 manifest）会记 `status=hit`，`token_saved_estimate` 记省下的 token。

这就把 [SystemContext Epoch](/autocode/system-context) 的「只关注增量」设计，和成本观测闭环了起来：epoch 没变 → 上下文缓存命中 → 台账记录省下的 token → 数据反过来验证「增量式上下文管理」到底省了多少钱。

## 三篇专题回顾

全链路专题到这里就完整了，三篇串起来看：

1. [一次对话的一生](/deep-dive/chat-lifecycle) —— 最基础的「一次调用」，SSE 流式的端到端。
2. [一次 AutoCode 任务](/deep-dive/autocode-task) —— 最复杂的「自主循环」，跨两个系统。
3. **一次计费的流转**（本篇）—— 贯穿始终的「钱与观测」，两条可靠性策略。

如果你把这三条线都走通了，那么这个 16.5 万行、三系统、五语言的平台，在你脑子里就不再是一堆孤立的模块，而是一套有清晰数据流和协作边界的完整系统。这，就是本学习手册想带你抵达的地方。
