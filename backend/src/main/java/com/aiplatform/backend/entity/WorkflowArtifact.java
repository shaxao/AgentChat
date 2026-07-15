package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 工作流文件/内容资产。
 * 大文件只保存引用，小文本和识别摘要可以放 contentText。
 */
@Data
@TableName("workflow_artifact")
public class WorkflowArtifact {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    private Long userId;

    private Long conversationId;

    private Long workflowId;

    private Long executionId;

    private String stepId;

    /** upload / workflow_output / asr / vision / document_parse */
    private String sourceType;

    private String fileName;

    /** image / document / spreadsheet / audio / video / text / other */
    private String fileType;

    private String mimeType;

    private Long fileSize;

    private String ossUrl;

    private String objectKey;

    private String contentText;

    private String metadataJson;

    /** pending / ready / failed */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
