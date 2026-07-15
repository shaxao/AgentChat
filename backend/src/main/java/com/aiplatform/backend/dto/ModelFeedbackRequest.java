package com.aiplatform.backend.dto;

import lombok.Data;

/**
 * 模型反馈请求
 */
@Data
public class ModelFeedbackRequest {
    private String conversationId;
    private String modelId;
    private String sceneType;
    private Integer rating;
    private Boolean liked;
    private Boolean disliked;
    private String feedbackText;
    private Integer responseTimeMs;
}
