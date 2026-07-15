package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.entity.WalletTransaction;
import com.aiplatform.backend.mapper.AgentRegistryMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.mapper.WalletTransactionMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;

/**
 * 钱包服务。
 *
 * 核心能力：
 * 1. 管理员充值确认
 * 2. 用户提现申请与管理员审核
 * 3. 对话消费扣费
 * 4. 开发者分成
 * 5. 余额与流水查询
 *
 * 并发安全：扣费使用 MyBatis-Plus 条件更新，确保 balance >= amount，避免超扣。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WalletService {

    private final SysUserMapper sysUserMapper;
    private final WalletTransactionMapper walletTransactionMapper;
    private final AgentRegistryMapper agentRegistryMapper;

    public BigDecimal getBalance(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");
        return user.getBalance() != null ? user.getBalance() : BigDecimal.ZERO;
    }

    public List<WalletTransaction> getTransactions(Long userId) {
        return walletTransactionMapper.selectList(
            new LambdaQueryWrapper<WalletTransaction>()
                .eq(WalletTransaction::getUserId, userId)
                .orderByDesc(WalletTransaction::getCreatedAt)
                .last("LIMIT 50")
        );
    }

    public List<WalletTransaction> getAllTransactions(int limit) {
        return walletTransactionMapper.selectList(
            new LambdaQueryWrapper<WalletTransaction>()
                .orderByDesc(WalletTransaction::getCreatedAt)
                .last("LIMIT " + limit)
        );
    }

    @Transactional
    public WalletTransaction recharge(Long userId, BigDecimal amount, String description, Long adminUserId) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) throw new RuntimeException("充值金额必须大于 0");
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");

        BigDecimal before = safeBalance(user);
        int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
                .eq(SysUser::getId, userId)
                .setSql("balance = balance + " + amount.toPlainString())
                .setSql("total_recharged = total_recharged + " + amount.toPlainString()));
        if (updated <= 0) throw new RuntimeException("充值失败，请稍后重试");

        SysUser afterUser = sysUserMapper.selectById(userId);
        BigDecimal after = safeBalance(afterUser);

        WalletTransaction tx = buildTx(userId, "deposit", amount, before, after, description, "recharge", null);
        walletTransactionMapper.insert(tx);

        log.info("[Wallet] 管理员 {} 为用户 {} 充值 ¥{}, 余额 ¥{} -> ¥{}",
            adminUserId, userId, amount, before, after);
        return tx;
    }

    @Transactional
    public WalletTransaction requestWithdraw(Long userId, BigDecimal amount, String description) {
        if (amount.compareTo(BigDecimal.ZERO) <= 0) throw new RuntimeException("提现金额必须大于 0");
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");
        if (safeBalance(user).compareTo(amount) < 0) throw new RuntimeException("余额不足");

        WalletTransaction tx = buildTx(userId, "withdraw", amount,
            safeBalance(user), safeBalance(user), description, "withdraw", null);
        tx.setStatus("pending");
        walletTransactionMapper.insert(tx);

        log.info("[Wallet] 用户 {} 申请提现 ¥{}", userId, amount);
        return tx;
    }

    @Transactional
    public WalletTransaction approveWithdraw(Long txId, Long adminUserId) {
        WalletTransaction tx = walletTransactionMapper.selectById(txId);
        if (tx == null) throw new RuntimeException("交易不存在");
        if (!"pending".equals(tx.getStatus())) throw new RuntimeException("该交易不是待审核状态");

        SysUser user = sysUserMapper.selectById(tx.getUserId());
        BigDecimal before = safeBalance(user);
        int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
                .eq(SysUser::getId, tx.getUserId())
                .ge(SysUser::getBalance, tx.getAmount())
                .setSql("balance = balance - " + tx.getAmount().toPlainString()));
        if (updated <= 0) throw new RuntimeException("余额不足");

        SysUser afterUser = sysUserMapper.selectById(tx.getUserId());
        BigDecimal after = safeBalance(afterUser);
        if (after.compareTo(BigDecimal.ZERO) < 0) throw new RuntimeException("余额不足");

        tx.setStatus("success");
        tx.setBalanceBefore(before);
        tx.setBalanceAfter(after);
        tx.setDescription(tx.getDescription() + " (已审核)");
        walletTransactionMapper.updateById(tx);

        log.info("[Wallet] 管理员 {} 审核通过提现 tx#{}, 用户 {} ¥{} -> ¥{}",
            adminUserId, txId, tx.getUserId(), before, after);
        return tx;
    }

    @Transactional
    public WalletTransaction rejectWithdraw(Long txId, String reason, Long adminUserId) {
        WalletTransaction tx = walletTransactionMapper.selectById(txId);
        if (tx == null) throw new RuntimeException("交易不存在");

        tx.setStatus("failed");
        tx.setDescription("提现驳回: " + (reason != null ? reason : "管理员拒绝"));
        walletTransactionMapper.updateById(tx);

        log.info("[Wallet] 管理员 {} 驳回提现 tx#{}, 理由: {}", adminUserId, txId, reason);
        return tx;
    }

    /**
     * 用户对话消费扣费。扣费失败会抛出明确错误，调用方不得写成功流水。
     */
    @Transactional
    public WalletTransaction consume(Long userId, BigDecimal cost, String convUuid, String model) {
        if (cost.compareTo(BigDecimal.ZERO) <= 0) return null;

        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");

        BigDecimal before = safeBalance(user);
        if (before.compareTo(cost) < 0) {
            log.warn("[Wallet] 用户 {} 余额不足，需要 ¥{}，当前余额 ¥{}", userId, cost, before);
            throw new RuntimeException(String.format("账户余额不足，本次消费 ¥%.4f，当前余额 ¥%.4f", cost, before));
        }

        int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
                .eq(SysUser::getId, userId)
                .ge(SysUser::getBalance, cost)
                .setSql("balance = balance - " + cost.toPlainString())
                .setSql("total_consumed = total_consumed + " + cost.toPlainString()));
        if (updated <= 0) {
            BigDecimal current = getBalance(userId);
            log.warn("[Wallet] 用户 {} 扣费失败，需要 ¥{}，当前余额 ¥{}", userId, cost, current);
            throw new RuntimeException(String.format("账户余额不足，本次消费 ¥%.4f，当前余额 ¥%.4f", cost, current));
        }

        SysUser afterUser = sysUserMapper.selectById(userId);
        BigDecimal after = safeBalance(afterUser);

        String desc = String.format("对话消费 - 模型: %s, Token 费用: ¥%.4f", model, cost);
        WalletTransaction tx = buildTx(userId, "consume", cost.negate(), before, after, desc, "chat", convUuid);
        walletTransactionMapper.insert(tx);

        log.info("[Wallet] 用户 {} 对话扣费 ¥{}, 余额 ¥{} -> ¥{}", userId, cost, before, after);
        return tx;
    }

    @Transactional
    public void assertRefundable(Long userId, BigDecimal amount) {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new RuntimeException("退款金额必须大于 0");
        }
        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");
        BigDecimal balance = safeBalance(user);
        if (balance.compareTo(amount) < 0) {
            throw new RuntimeException("用户钱包余额不足，无法回滚充值退款");
        }
    }

    @Transactional
    public WalletTransaction refundRecharge(Long userId, BigDecimal amount, String description, String refId) {
        assertRefundable(userId, amount);
        SysUser user = sysUserMapper.selectById(userId);
        BigDecimal before = safeBalance(user);

        int updated = sysUserMapper.update(null, new LambdaUpdateWrapper<SysUser>()
                .eq(SysUser::getId, userId)
                .ge(SysUser::getBalance, amount)
                .setSql("balance = balance - " + amount.toPlainString()));
        if (updated <= 0) {
            throw new RuntimeException("用户钱包余额不足，无法回滚充值退款");
        }

        SysUser afterUser = sysUserMapper.selectById(userId);
        BigDecimal after = safeBalance(afterUser);
        WalletTransaction tx = buildTx(userId, "refund", amount.negate(), before, after,
                description, "payment_refund", refId);
        walletTransactionMapper.insert(tx);
        log.info("[Wallet] refund recharge rollback: userId={}, amount={}, balance {} -> {}",
                userId, amount, before, after);
        return tx;
    }

    @Transactional
    public void shareRevenue(String agentId, BigDecimal totalCost, String convUuid) {
        AgentRegistry agent = agentRegistryMapper.selectOne(
            new LambdaQueryWrapper<AgentRegistry>().eq(AgentRegistry::getAgentId, agentId));
        if (agent == null || agent.getCreatedBy() == null) return;

        BigDecimal ratio = agent.getRevenueRatio() != null
            ? agent.getRevenueRatio() : new BigDecimal("0.3");
        BigDecimal devAmount = totalCost.multiply(ratio);

        if (devAmount.compareTo(BigDecimal.ZERO) <= 0) return;

        Long devId = agent.getCreatedBy();
        SysUser dev = sysUserMapper.selectById(devId);
        if (dev == null) return;

        BigDecimal before = safeBalance(dev);
        BigDecimal after = before.add(devAmount);

        dev.setBalance(after);
        dev.setTotalEarned(safe(dev.getTotalEarned()).add(devAmount));
        sysUserMapper.updateById(dev);

        WalletTransaction tx = buildTx(devId, "earn", devAmount, before, after,
            String.format("Agent '%s' 使用分成 (比例 %.0f%%)", agent.getName(), ratio.multiply(new BigDecimal("100"))),
            "agent_share", convUuid);
        walletTransactionMapper.insert(tx);

        agent.setTotalUsage((agent.getTotalUsage() != null ? agent.getTotalUsage() : 0) + 1);
        agent.setTotalRevenue((agent.getTotalRevenue() != null ? agent.getTotalRevenue() : BigDecimal.ZERO).add(devAmount));
        agentRegistryMapper.updateById(agent);

        log.info("[Wallet] 开发者 {} 获得分成 ¥{} (Agent {}), 余额 ¥{} -> ¥{}",
            devId, devAmount, agentId, before, after);
    }

    private BigDecimal safeBalance(SysUser user) {
        return user.getBalance() != null ? user.getBalance() : BigDecimal.ZERO;
    }

    private BigDecimal safe(BigDecimal value) {
        return value != null ? value : BigDecimal.ZERO;
    }

    private WalletTransaction buildTx(Long userId, String type, BigDecimal amount,
                                      BigDecimal before, BigDecimal after,
                                      String description, String refType, String refId) {
        WalletTransaction tx = new WalletTransaction();
        tx.setUserId(userId);
        tx.setType(type);
        tx.setAmount(amount);
        tx.setBalanceBefore(before);
        tx.setBalanceAfter(after);
        tx.setDescription(description);
        tx.setRefType(refType);
        tx.setRefId(refId);
        tx.setStatus("success");
        return tx;
    }
}
