package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("workflow_artifact_upload_session")
public class WorkflowArtifactUploadSession {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uploadId;

    private Long userId;

    private String fileName;

    private Long totalSize;

    private Long chunkSize;

    private Integer totalParts;

    private String uploadedParts;

    private String contentType;

    private Long workflowId;

    private Long executionId;

    private String stepId;

    private String sourceType;

    private Long conversationId;

    private Boolean syncToWorkFile;

    private String metadataJson;

    /** oss_temp_merge / native_multipart */
    private String storageMode;

    private String tempDir;

    private String objectKey;

    private String nativeUploadId;

    /** pending / uploading / completed / failed / aborted */
    private String status;

    private String errorMsg;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    private LocalDateTime expiresAt;

    @TableLogic
    private Integer deleted;
}
