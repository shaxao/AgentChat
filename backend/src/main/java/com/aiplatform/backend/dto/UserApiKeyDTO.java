package com.aiplatform.backend.dto;

import lombok.Data;

public class UserApiKeyDTO {
    @Data
    public static class ApiKeyVO {
        private String id;
        private String name;
        private String keyPrefix;
        private String status;
        private String createdAt;
        private String lastUsedAt;
        private String expiresAt;
    }

    @Data
    public static class GenerateApiKeyRequest {
        private String name;
    }

    @Data
    public static class GenerateApiKeyResponse {
        private ApiKeyVO apiKey;
        private String key;
    }
}
