package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 用户模型反馈记录实体
 * DB 表: user_model_feedback
 */
@Data
@TableName("user_model_feedback")
public class UserModelFeedback {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String conversationId;

    private String modelId;

    private String sceneType;

    private Integer rating;

    private Integer liked;

    private Integer disliked;

    @TableField("feedback_text")
    private String feedbackText;

    @TableField("response_time_ms")
    private Integer responseTimeMs;

    @TableField("token_usage")
    private Integer tokenUsage;

    @TableField("was_retry")
    private Integer wasRetry;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
