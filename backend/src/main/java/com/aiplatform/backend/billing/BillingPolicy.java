package com.aiplatform.backend.billing;

import lombok.Data;
import java.math.BigDecimal;

/**
 * 场景化计费策略
 *
 * 从 subscription_plan.features / subscription.features 中的 JSON 解析而来。
 * features 示例：
 * {
 *   "billing": {
 *     "scenes": {
 *       "chat": {
 *         "enabled": true,
 *         "costLimit": 100.00,
 *         "walletFallbackEnabled": false,
 *         "walletFallbackMonthlyLimit": 50.00,
 *         "upstreamBillingMode": "metered"
 *       },
 *       "autocode": {
 *         "enabled": true,
 *         "costLimit": 200.00,
 *         "walletFallbackEnabled": false,
 *         "walletFallbackMonthlyLimit": 100.00,
 *         "upstreamBillingMode": "coding_plan"
 *       }
 *     }
 *   }
 * }
 */
@Data
public class BillingPolicy {

    /** 场景是否启用 */
    private boolean enabled = true;

    /** 场景专属额度（null 表示使用全局 costLimit） */
    private BigDecimal costLimit;

    /** 额度耗尽后是否使用钱包余额兜底 */
    private boolean walletFallbackEnabled = false;

    /** 钱包兜底月度上限（0/null 表示不限，但 walletFallbackEnabled=false 时不生效） */
    private BigDecimal walletFallbackMonthlyLimit;

    /**
     * 上游渠道计费模式：
     * - metered:       按量计费（默认）
     * - coding_plan:   Coding Plan 套餐（上游免费/内部结算）
     * - included:      已包含在渠道套餐内
     */
    private String upstreamBillingMode = "metered";

    /** 场景归属的额度桶，用于多个场景共享同一额度 */
    private String quotaBucket;

    // ── 快捷判断 ──

    public boolean isFreeUpstream() {
        return "coding_plan".equalsIgnoreCase(upstreamBillingMode)
                || "included".equalsIgnoreCase(upstreamBillingMode);
    }
}
