package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("api_log")
public class ApiLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long conversationId;
    private String model;
    private String sceneType;
    private Integer inputTokens;
    private Integer cachedInputTokens;
    private Integer outputTokens;
    private BigDecimal inputPriceSnapshot;
    private BigDecimal cachedInputPriceSnapshot;
    private BigDecimal outputPriceSnapshot;
    private BigDecimal inputCost;
    private BigDecimal cachedInputCost;
    private BigDecimal outputCost;
    private BigDecimal cost;
    private Integer latencyMs;
    private String status;
    private String errorMsg;
    private String requestIp;
    private String provider;
    private String channelId;
    @TableField(exist = false)
    private String channelName;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
