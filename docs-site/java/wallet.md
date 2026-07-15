# 钱包与订阅

这一章讲平台怎么「收钱」和「扣钱」。里面有一个非常值得学的并发安全扣费写法——如果你以后要写任何涉及余额、库存、配额的系统，这个模式都用得上。

## 两套计费口径

平台对用户的计费有两条腿：

| 方式 | 场景 | 特征 |
|------|------|------|
| **订阅套餐** | 包月/包年，按 plan 限制可用模型、配额 | 预付费，周期性 |
| **钱包余额** | 按 token 实际消费，一次一扣 | 后付费，用多少扣多少 |

对话结束、算出本次 token 成本后，走的就是钱包的 `consume` 扣费。

## 核心：原子扣费

先看反面教材——**新手最容易写错的扣费**：

```java
// ❌ 有并发漏洞的写法
SysUser user = mapper.selectById(userId);
if (user.getBalance() < cost) throw new RuntimeException("余额不足");
user.setBalance(user.getBalance() - cost);   // 读出来，减一下
mapper.updateById(user);                       // 再写回去
```

问题出在「读 → 判断 → 写」三步之间。如果同一用户并发发两条消息，两个线程都读到余额 10 元，都判断「够扣 8 元」，然后都写回 2 元——结果扣了 16 元的服务，只减了 8 元。这就是典型的 **check-then-act 竞态**。

再看项目里的真实写法：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/WalletService.java:150"
  :notes="[
    { lines: '1-2', text: '成本小于等于 0 直接返回，不产生流水。这是第一道防线，避免无意义的零元交易。' },
    { lines: '9-13', text: '先做一次快速余额检查，余额明显不足时早失败、给出友好错误。注意这只是预检，不是最终保证。' },
    { lines: '15-19', text: '真正的原子扣费：UPDATE 时用 ge(balance, cost) 作为条件——只有当数据库里的余额仍然大于等于成本时，这条 UPDATE 才会命中行。余额和累计消费在同一条 SQL 里一起改。' },
    { lines: '20-24', text: '关键判断：updated 为受影响行数。如果为 0，说明扣费的瞬间余额已经不够（被另一个并发请求扣走了），此时抛异常、绝不写成功流水。' }
  ]">

```java
public WalletTransaction consume(Long userId, BigDecimal cost, String convUuid, String model) {
    if (cost.compareTo(BigDecimal.ZERO) <= 0) return null;

    SysUser user = sysUserMapper.selectById(userId);
    if (user == null) throw new RuntimeException("用户不存在");

    BigDecimal before = safeBalance(user);
    if (before.compareTo(cost) < 0) {
        throw new RuntimeException(
            String.format("账户余额不足，本次消费 ¥%.4f，当前余额 ¥%.4f", cost, before));
    }

    int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
            .eq(SysUser::getId, userId)
            .ge(SysUser::getBalance, cost)
            .setSql("balance = balance - " + cost.toPlainString())
            .setSql("total_consumed = total_consumed + " + cost.toPlainString()));
    if (updated <= 0) {
        BigDecimal current = getBalance(userId);
        throw new RuntimeException(
            String.format("账户余额不足，本次消费 ¥%.4f，当前余额 ¥%.4f", cost, current));
    }
    // ... 写消费流水
}
```

</SourceExplainer>

## 为什么这样就安全了

关键在这条 SQL：

```sql
UPDATE sys_user
SET balance = balance - 8, total_consumed = total_consumed + 8
WHERE id = 123 AND balance >= 8
```

数据库对单行 UPDATE 是有行锁的。两个并发请求会**串行**执行这条 UPDATE：

- 第一个执行：`balance >= 8` 成立，扣成功，余额从 10 变 2，`updated = 1`。
- 第二个执行：此时 `balance = 2`，`balance >= 8` 不成立，**这条 UPDATE 命中 0 行**，`updated = 0` → 抛「余额不足」。

于是「判断」和「扣减」被合并成了一个原子操作，竞态窗口消失了。这就是所谓的**乐观锁 / 条件更新**思路——不加显式锁，靠 `WHERE` 条件 + 受影响行数来保证一致性。

::: tip 可迁移的通用模式
只要是「先检查一个数值够不够，再扣减」的场景——余额、库存、配额、令牌桶——都可以用这个模式：
```
UPDATE t SET x = x - n WHERE id = ? AND x >= n
```
再判断受影响行数是否为 1。它比「查出来在应用层判断再写回」既简单又安全。
:::

## 扣费失败绝不写成功流水

注意方法注释里那句：**「扣费失败会抛出明确错误，调用方不得写成功流水。」**

这是一条业务铁律。SSE 对话流程里，只有 `consume` 成功返回，才会记录这次消费成功。如果扣费抛异常，上层会捕获并给用户报错，而不是「服务给了、钱没扣到」。钱和服务必须对齐。

## 事务边界

`consume` 上标了 `@Transactional`：扣余额 + 写流水在同一个事务里。要么都成功，要么都回滚，不会出现「余额扣了但流水没记」的中间态。

## 相关源码

- `backend/src/main/java/com/aiplatform/backend/service/WalletService.java` — 充值、消费、提现、审核
- `backend/src/main/java/com/aiplatform/backend/controller/WalletController.java` — 钱包 REST 接口
- `backend/src/main/java/com/aiplatform/backend/entity/WalletTransaction.java` — 流水实体

计费金额是怎么算出来的、又怎么和 Python 侧的用量对齐，见 [CacheLedger 计费桥接](/java/cache-ledger) 和全链路专题 [一次计费的流转](/deep-dive/billing-flow)。
