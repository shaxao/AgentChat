package com.aiplatform.backend.dto;

import lombok.Data;

import java.util.List;

/**
 * 工作流资产 DTO。
 */
public class WorkflowArtifactDTO {

    @Data
    public static class ArtifactVO {
        private Long id;
        private String uuid;
        private Long userId;
        private Long conversationId;
        private Long workflowId;
        private Long executionId;
        private String stepId;
        private String sourceType;
        private String fileName;
        private String fileType;
        private String mimeType;
        private Long fileSize;
        private String ossUrl;
        private String objectKey;
        private String contentText;
        private String metadataJson;
        private String status;
        private Long workFileId;
        private String createdAt;
    }

    @Data
    public static class ArtifactPageVO {
        private List<ArtifactVO> items;
        private Integer total;
    }

    @Data
    public static class ChunkUploadSessionVO {
        private String uploadId;
        private String fileName;
        private Long totalSize;
        private Long chunkSize;
        private Integer totalParts;
        private List<Integer> uploadedParts;
        private Boolean completed;
        private String status;
        private String errorMsg;
    }
}
