package com.aiplatform.backend.dto;

import lombok.Data;

/**
 * 手动设置偏好权重请求
 */
@Data
public class ManualPreferenceRequest {
    private String modelId;
    private String sceneType;
    private double weight;
}
