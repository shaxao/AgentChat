package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ModelUsageEvent;
import com.aiplatform.backend.billing.BillingDecision;
import com.aiplatform.backend.billing.BillingErrorCode;
import com.aiplatform.backend.billing.BillingException;
import com.aiplatform.backend.billing.BillingPolicy;
import com.aiplatform.backend.billing.BillingPolicyResolver;
import com.aiplatform.backend.entity.ApiLog;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.ApiLogMapper;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;

@Slf4j
@Service
@RequiredArgsConstructor
public class UsageTrackingService {

    private final ApiLogMapper apiLogMapper;
    private final SysUserMapper sysUserMapper;
    private final ModelConfigMapper modelConfigMapper;
    private final ModelChannelMapper modelChannelMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final WalletService walletService;
    private final UserPreferenceService userPreferenceService;
    private final BillingPolicyResolver billingPolicyResolver;

    public void trackApiUsage(Long userId, String model, int inputTokens, int outputTokens,
                              int latencyMs, String status, String errorMsg) {
        trackApiUsage(userId, model, inputTokens, 0, outputTokens, latencyMs, status, errorMsg, null);
    }

    public void trackApiUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens,
                              int latencyMs, String status, String errorMsg) {
        trackApiUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, latencyMs, status, errorMsg, null);
    }

    public void trackApiUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens,
                              int latencyMs, String status, String errorMsg, String sceneType) {
        trackApiUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, latencyMs,
                status, errorMsg, sceneType, null, null, null);
    }

    public void trackApiUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens,
                              int latencyMs, String status, String errorMsg, String sceneType,
                              String requestIp, String provider, String channelId) {
        if (userId == null) return;
        try {
            BigDecimal cost = calculateCost(model, inputTokens, cachedInputTokens, outputTokens);
            ModelChannel channel = findChannelForModel(model);
            ApiLog apiLog = new ApiLog();
            apiLog.setUserId(userId);
            apiLog.setModel(model != null ? model : "unknown");
            apiLog.setSceneType(sceneType != null ? sceneType : "chat");
            apiLog.setInputTokens(inputTokens);
            apiLog.setCachedInputTokens(cachedInputTokens);
            apiLog.setOutputTokens(outputTokens);
            apiLog.setLatencyMs(latencyMs);
            apiLog.setStatus(status != null ? status : "success");
            apiLog.setErrorMsg(errorMsg);
            apiLog.setCost(cost);
            apiLog.setRequestIp(blankToNull(requestIp));
            apiLog.setProvider(blankToNull(provider) != null ? provider : (channel != null ? channel.getProvider() : null));
            if (blankToNull(channelId) != null) {
                apiLog.setChannelId(channelId);
            } else if (channel != null) {
                apiLog.setChannelId(channel.getUuid() != null && !channel.getUuid().isBlank()
                        ? channel.getUuid()
                        : String.valueOf(channel.getId()));
            }
            apiLogMapper.insert(apiLog);

            updateUserTokens(userId, inputTokens + outputTokens);
            updateUserCost(userId, cost);
        } catch (Exception e) {
            log.warn("[UsageTracking] failed to record api usage: {}", e.getMessage());
        }
    }

    public BigDecimal calculateCost(String model, int inputTokens, int outputTokens) {
        return calculateCost(model, inputTokens, 0, outputTokens);
    }

    public BigDecimal calculateCost(String model, int inputTokens, int cachedInputTokens, int outputTokens) {
        ModelConfig mc = latestEnabledModel(model);
        if (mc == null) return BigDecimal.ZERO;

        BigDecimal inputPrice = mc.getInputPrice() != null ? mc.getInputPrice() : BigDecimal.ZERO;
        BigDecimal cachedInputPrice = mc.getCachedInputPrice() != null ? mc.getCachedInputPrice() : inputPrice;
        BigDecimal outputPrice = mc.getOutputPrice() != null ? mc.getOutputPrice() : BigDecimal.ZERO;
        BigDecimal unit = BigDecimal.valueOf(1_000_000);

        int cachedTokens = Math.max(0, cachedInputTokens);
        int normalInputTokens = Math.max(0, inputTokens - cachedTokens);
        BigDecimal inputCost = inputPrice.multiply(BigDecimal.valueOf(normalInputTokens))
                .divide(unit, 10, RoundingMode.HALF_UP);
        BigDecimal cachedInputCost = cachedInputPrice.multiply(BigDecimal.valueOf(cachedTokens))
                .divide(unit, 10, RoundingMode.HALF_UP);
        BigDecimal outputCost = outputPrice.multiply(BigDecimal.valueOf(Math.max(0, outputTokens)))
                .divide(unit, 10, RoundingMode.HALF_UP);
        return inputCost.add(cachedInputCost).add(outputCost);
    }

    public void assertUsageAllowed(Long userId, String model, BigDecimal estimatedCost) {
        preflightUsage(userId, model, estimatedCost, "chat");
    }

    public BillingDecision preflightUsage(Long userId, String model, BigDecimal estimatedCost, String sceneType) {
        if (userId == null || model == null || model.isBlank()) return BillingDecision.allow(BigDecimal.ZERO, BigDecimal.ZERO);
        BigDecimal cost = estimatedCost != null ? estimatedCost : BigDecimal.ZERO;
        if (cost.compareTo(BigDecimal.ZERO) <= 0) return BillingDecision.allow(BigDecimal.ZERO, BigDecimal.ZERO);

        SysUser user = sysUserMapper.selectById(userId);
        if (user == null) throw new BillingException(BillingErrorCode.INTERNAL_ERROR, "User not found");

        Subscription sub = activeSubscription(userId);
        BillingPolicy policy = billingPolicyResolver.resolve(sub, sceneType);
        String scene = billingPolicyResolver.normalizeScene(sceneType);
        if (!policy.isEnabled()) {
            throw new BillingException(BillingErrorCode.SCENE_DISABLED,
                    "Scene is disabled for current subscription: " + scene);
        }

        BigDecimal limit = policy.getCostLimit() != null ? policy.getCostLimit() : safe(sub != null ? sub.getCostLimit() : user.getCostLimit());
        BigDecimal used = safe(sub != null ? sub.getCostUsed() : user.getCostUsed());
        BigDecimal remaining = limit.compareTo(BigDecimal.ZERO) > 0 ? limit.subtract(used).max(BigDecimal.ZERO) : cost;

        if (limit.compareTo(BigDecimal.ZERO) <= 0 || used.add(cost).compareTo(limit) <= 0) {
            return BillingDecision.allow(cost, BigDecimal.ZERO);
        }

        BigDecimal overflow = cost.subtract(remaining).max(BigDecimal.ZERO);
        if (!policy.isWalletFallbackEnabled()) {
            throw new BillingException(BillingErrorCode.SCENE_QUOTA_INSUFFICIENT,
                    "Scene quota insufficient: scene=" + scene + ", estimated=" + money(cost)
                            + ", remaining=" + money(remaining) + ". Enable wallet fallback or increase quota.");
        }

        BigDecimal fallbackLimit = safe(policy.getWalletFallbackMonthlyLimit());
        if (fallbackLimit.compareTo(BigDecimal.ZERO) > 0 && overflow.compareTo(fallbackLimit) > 0) {
            throw new BillingException(BillingErrorCode.USER_WALLET_FALLBACK_EXHAUSTED,
                    "Wallet fallback monthly limit exceeded: overflow=" + money(overflow)
                            + ", limit=" + money(fallbackLimit));
        }

        BigDecimal balance = safe(user.getBalance());
        if (balance.compareTo(overflow) < 0) {
            throw new BillingException(BillingErrorCode.USER_WALLET_INSUFFICIENT,
                    "Wallet balance insufficient: required=" + money(overflow)
                            + ", balance=" + money(balance));
        }
        return BillingDecision.allow(remaining, overflow);
    }

    public void billUsage(Long userId, String model, int inputTokens, int outputTokens, String agentId) {
        billUsage(userId, model, inputTokens, 0, outputTokens, agentId, "chat");
    }

    public void billUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens, String agentId) {
        billUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, agentId, "chat");
    }

    public void billUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens, String agentId, String sceneType) {
        if (userId == null || model == null || model.isBlank()) return;
        ModelConfig mc = latestEnabledModel(model);
        if (mc == null) return;

        BigDecimal totalCost = calculateCost(model, inputTokens, cachedInputTokens, outputTokens);
        if (totalCost.compareTo(BigDecimal.ZERO) <= 0) return;

        BillingDecision decision = preflightUsage(userId, model, totalCost, sceneType);
        BigDecimal walletCost = decision.getWalletCost() != null ? decision.getWalletCost() : BigDecimal.ZERO;
        if (walletCost.compareTo(BigDecimal.ZERO) > 0) {
            walletService.consume(userId, walletCost, null, model);
        }
        if (agentId != null && !agentId.isBlank()) {
            try {
                walletService.shareRevenue(agentId, totalCost, null);
            } catch (Exception e) {
                log.warn("[UsageTracking] share revenue failed: agentId={}, error={}", agentId, e.getMessage());
            }
        }
    }

    public void trackUserPreference(Long userId, String modelId, String sceneType,
                                    boolean success, int responseTimeMs, Long tokenUsage) {
        if (userId == null || modelId == null || modelId.isBlank()) return;
        try {
            ModelUsageEvent event = new ModelUsageEvent();
            event.setUserId(userId);
            event.setModelId(modelId);
            event.setSceneType(sceneType != null ? sceneType : "chat");
            event.setSuccess(success);
            event.setResponseTimeMs(responseTimeMs);
            event.setTokenUsage(tokenUsage);
            userPreferenceService.recordUsage(event);
        } catch (Exception e) {
            log.debug("[UsageTracking] failed to record preference: {}", e.getMessage());
        }
    }

    public void trackFull(Long userId, String model, int inputTokens, int outputTokens,
                          int latencyMs, String sceneType, String agentId) {
        trackFull(userId, model, inputTokens, 0, outputTokens, latencyMs, sceneType, agentId);
    }

    public void trackFull(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens,
                          int latencyMs, String sceneType, String agentId) {
        trackFull(userId, model, inputTokens, cachedInputTokens, outputTokens, latencyMs,
                sceneType, agentId, null, null, null);
    }

    public void trackFull(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens,
                          int latencyMs, String sceneType, String agentId,
                          String requestIp, String provider, String channelId) {
        billUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, agentId, sceneType);
        trackApiUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, latencyMs,
                "success", null, sceneType, requestIp, provider, channelId);
        trackUserPreference(userId, model, sceneType, true, latencyMs, (long) (inputTokens + outputTokens));
    }

    public void trackFailure(Long userId, String model, int inputTokens, int outputTokens,
                             int latencyMs, String sceneType, String errorMsg) {
        trackApiUsage(userId, model, inputTokens, 0, outputTokens, latencyMs, "error", errorMsg, sceneType);
        trackUserPreference(userId, model, sceneType, false, latencyMs, 0L);
    }

    private ModelConfig latestEnabledModel(String model) {
        if (model == null || model.isBlank()) return null;
        try {
            ModelConfig mc = modelConfigMapper.selectOne(
                    new LambdaQueryWrapper<ModelConfig>()
                            .eq(ModelConfig::getModelId, model)
                            .orderByDesc(ModelConfig::getId)
                            .last("LIMIT 1"));
            return mc != null && Boolean.TRUE.equals(mc.getEnabled()) ? mc : null;
        } catch (Exception e) {
            log.warn("[UsageTracking] failed to load model price: model={}, error={}", model, e.getMessage());
            return null;
        }
    }

    private ModelChannel findChannelForModel(String model) {
        if (model == null || model.isBlank()) return null;
        try {
            var channels = modelChannelMapper.selectList(
                    new LambdaQueryWrapper<ModelChannel>()
                            .eq(ModelChannel::getStatus, "active")
                            .eq(ModelChannel::getDeleted, 0)
                            .orderByDesc(ModelChannel::getPriority)
                            .orderByAsc(ModelChannel::getId));
            String needle = model.trim();
            for (ModelChannel channel : channels) {
                String models = channel.getModels();
                if (models == null || models.isBlank()) continue;
                for (String raw : models.replace("[", "").replace("]", "").replace("\"", "").split(",")) {
                    String item = raw.trim();
                    if (item.isEmpty()) continue;
                    if (needle.equalsIgnoreCase(item)) return channel;
                }
            }
            for (ModelChannel channel : channels) {
                String models = channel.getModels();
                if (models == null || models.isBlank()) continue;
                for (String raw : models.replace("[", "").replace("]", "").replace("\"", "").split(",")) {
                    String item = raw.trim();
                    if (item.isEmpty()) continue;
                    if (needle.toLowerCase().contains(item.toLowerCase())
                            || item.toLowerCase().contains(needle.toLowerCase())) {
                        return channel;
                    }
                }
            }
        } catch (Exception e) {
            log.debug("[UsageTracking] failed to resolve channel for model {}: {}", model, e.getMessage());
        }
        return null;
    }

    private String blankToNull(String value) {
        return value != null && !value.isBlank() ? value : null;
    }

    private void updateUserTokens(Long userId, int tokensUsed) {
        try {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null) {
                long newUsed = (user.getTokensUsed() != null ? user.getTokensUsed() : 0) + tokensUsed;
                user.setTokensUsed(newUsed);
                sysUserMapper.updateById(user);
            }
        } catch (Exception e) {
            log.warn("[UsageTracking] failed to update token usage: {}", e.getMessage());
        }
    }

    private void updateUserCost(Long userId, BigDecimal cost) {
        if (cost == null || cost.compareTo(BigDecimal.ZERO) <= 0) return;
        try {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null) {
                BigDecimal newUsed = (user.getCostUsed() != null ? user.getCostUsed() : BigDecimal.ZERO).add(cost);
                user.setCostUsed(newUsed);
                sysUserMapper.updateById(user);
            }
            updateSubscriptionCost(userId, cost);
        } catch (Exception e) {
            log.warn("[UsageTracking] failed to update cost usage: {}", e.getMessage());
        }
    }

    private void updateSubscriptionCost(Long userId, BigDecimal cost) {
        Subscription sub = activeSubscription(userId);
        if (sub == null) return;
        BigDecimal used = sub.getCostUsed() != null ? sub.getCostUsed() : BigDecimal.ZERO;
        sub.setCostUsed(used.add(cost));
        subscriptionMapper.updateById(sub);
    }

    private Subscription activeSubscription(Long userId) {
        if (userId == null) return null;
        return subscriptionMapper.selectOne(new LambdaQueryWrapper<Subscription>()
                .eq(Subscription::getUserId, userId)
                .eq(Subscription::getStatus, "active")
                .eq(Subscription::getDeleted, 0)
                .orderByDesc(Subscription::getCreatedAt)
                .last("LIMIT 1"));
    }

    private BigDecimal safe(BigDecimal value) {
        return value != null ? value : BigDecimal.ZERO;
    }

    private String money(BigDecimal value) {
        return safe(value).setScale(4, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
    }
}
