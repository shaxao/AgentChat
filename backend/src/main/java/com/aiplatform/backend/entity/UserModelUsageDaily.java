package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * 用户模型使用日汇总实体
 * DB 表: user_model_usage_daily
 */
@Data
@TableName("user_model_usage_daily")
public class UserModelUsageDaily {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String modelId;

    private String sceneType;

    private LocalDate statDate;

    @TableField("call_count")
    private Integer callCount;

    @TableField("success_count")
    private Integer successCount;

    @TableField("total_tokens")
    private Long totalTokens;

    @TableField("total_cost")
    private BigDecimal totalCost;

    @TableField("avg_response_time")
    private Integer avgResponseTime;
}
