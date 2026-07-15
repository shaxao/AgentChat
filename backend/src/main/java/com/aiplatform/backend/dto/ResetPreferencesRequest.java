package com.aiplatform.backend.dto;

import lombok.Data;

/**
 * 重置偏好请求
 */
@Data
public class ResetPreferencesRequest {
    private String sceneType; // null = 全部场景
}
