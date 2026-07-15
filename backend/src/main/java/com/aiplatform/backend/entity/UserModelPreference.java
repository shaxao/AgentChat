package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 用户模型偏好实体
 * DB 表: user_model_preference
 */
@Data
@TableName("user_model_preference")
public class UserModelPreference {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String modelId;

    private String sceneType;

    @TableField("preference_weight")
    private BigDecimal preferenceWeight;

    @TableField("usage_count")
    private Integer usageCount;

    @TableField("like_count")
    private Integer likeCount;

    @TableField("dislike_count")
    private Integer dislikeCount;

    @TableField("avg_response_time")
    private Integer avgResponseTime;

    @TableField("last_used_at")
    private LocalDateTime lastUsedAt;

    private String source;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
