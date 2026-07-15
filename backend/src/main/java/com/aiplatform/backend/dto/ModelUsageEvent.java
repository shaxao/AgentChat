package com.aiplatform.backend.dto;

import lombok.Data;
import java.math.BigDecimal;

/**
 * 模型使用事件（对话完成后触发偏好更新）
 */
@Data
public class ModelUsageEvent {
    private Long userId;
    private String modelId;
    private String sceneType;
    private boolean success;
    private int responseTimeMs;
    private Long tokenUsage;
    private BigDecimal cost;

    public ModelUsageEvent() {}

    public ModelUsageEvent(Long userId, String modelId, String sceneType, boolean success,
                           int responseTimeMs, Long tokenUsage, BigDecimal cost) {
        this.userId = userId;
        this.modelId = modelId;
        this.sceneType = sceneType;
        this.success = success;
        this.responseTimeMs = responseTimeMs;
        this.tokenUsage = tokenUsage;
        this.cost = cost;
    }
}
