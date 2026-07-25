package com.aiplatform.backend.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

public class UserUsageDTO {

    @Data
    public static class UsageSummary {
        private int days;
        private long requestCount;
        private long successCount;
        private long errorCount;
        private long inputTokens;
        private long cachedInputTokens;
        private long billableInputTokens;
        private long outputTokens;
        private long totalTokens;
        /** Percentage, 0-100. */
        private BigDecimal cacheHitRate = BigDecimal.ZERO;
        private BigDecimal totalCost = BigDecimal.ZERO;
        private BigDecimal avgCost = BigDecimal.ZERO;
    }

    @Data
    public static class UsageLogItem {
        private Long id;
        private String model;
        private String sceneType;
        private String status;
        private String errorMsg;
        private String requestIp;
        private String provider;
        private String channelId;
        private String channelName;
        private int inputTokens;
        private int cachedInputTokens;
        private int billableInputTokens;
        private int outputTokens;
        private int totalTokens;
        /** Percentage, 0-100. */
        private BigDecimal cacheHitRate = BigDecimal.ZERO;
        private BigDecimal inputPrice = BigDecimal.ZERO;
        private BigDecimal cachedInputPrice = BigDecimal.ZERO;
        private BigDecimal outputPrice = BigDecimal.ZERO;
        private BigDecimal inputCost = BigDecimal.ZERO;
        private BigDecimal cachedInputCost = BigDecimal.ZERO;
        private BigDecimal outputCost = BigDecimal.ZERO;
        private BigDecimal totalCost = BigDecimal.ZERO;
        private boolean costEstimated;
        private Integer latencyMs;
        private LocalDateTime createdAt;
    }

    @Data
    public static class ModelPriceItem {
        private String id;
        private String name;
        private String provider;
        private String description;
        private Integer contextLength;
        private BigDecimal inputPrice = BigDecimal.ZERO;
        private BigDecimal cachedInputPrice = BigDecimal.ZERO;
        private BigDecimal outputPrice = BigDecimal.ZERO;
        private List<String> capabilities = List.of();
    }
}
