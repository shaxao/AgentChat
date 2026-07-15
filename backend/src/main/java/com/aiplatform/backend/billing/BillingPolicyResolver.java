package com.aiplatform.backend.billing;

import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Locale;

@Slf4j
@Component
@RequiredArgsConstructor
public class BillingPolicyResolver {

    private final ObjectMapper objectMapper;
    private final SubscriptionPlanMapper planMapper;

    public BillingPolicy resolve(Subscription subscription, String sceneType) {
        String scene = normalizeScene(sceneType);
        BillingPolicy policy = null;

        if (subscription != null) {
            policy = readPolicy(subscription.getFeatures(), scene);
            if (policy == null && subscription.getPlan() != null) {
                SubscriptionPlan plan = planMapper.selectOne(new LambdaQueryWrapper<SubscriptionPlan>()
                        .eq(SubscriptionPlan::getCode, subscription.getPlan())
                        .eq(SubscriptionPlan::getDeleted, 0)
                        .orderByDesc(SubscriptionPlan::getId)
                        .last("LIMIT 1"));
                if (plan != null) policy = readPolicy(plan.getFeatures(), scene);
            }
        }

        if (policy == null) policy = new BillingPolicy();
        if (policy.getQuotaBucket() == null || policy.getQuotaBucket().isBlank()) {
            policy.setQuotaBucket(scene);
        }
        return policy;
    }

    public String normalizeScene(String sceneType) {
        if (sceneType == null || sceneType.isBlank()) return "chat";
        String value = sceneType.trim().toLowerCase(Locale.ROOT);
        if (value.equals("agent") || value.equals("code") || value.equals("coding")) return "autocode";
        return value;
    }

    private BillingPolicy readPolicy(String features, String scene) {
        if (features == null || features.isBlank()) return null;
        try {
            JsonNode root = objectMapper.readTree(features);
            JsonNode node = root.path("billing").path("scenes").path(scene);
            if (node.isMissingNode() || node.isNull()) return null;

            BillingPolicy policy = new BillingPolicy();
            if (node.has("enabled")) policy.setEnabled(node.path("enabled").asBoolean(true));
            if (node.has("costLimit") && !node.path("costLimit").isNull()) {
                policy.setCostLimit(new BigDecimal(node.path("costLimit").asText("0")));
            }
            if (node.has("walletFallbackEnabled")) {
                policy.setWalletFallbackEnabled(node.path("walletFallbackEnabled").asBoolean(false));
            }
            if (node.has("walletFallbackMonthlyLimit") && !node.path("walletFallbackMonthlyLimit").isNull()) {
                policy.setWalletFallbackMonthlyLimit(new BigDecimal(node.path("walletFallbackMonthlyLimit").asText("0")));
            }
            if (node.has("upstreamBillingMode")) {
                policy.setUpstreamBillingMode(node.path("upstreamBillingMode").asText("metered"));
            }
            if (node.has("quotaBucket")) {
                policy.setQuotaBucket(node.path("quotaBucket").asText(null));
            }
            return policy;
        } catch (Exception e) {
            log.warn("[BillingPolicy] Failed to parse features billing policy: {}", e.getMessage());
            return null;
        }
    }
}
