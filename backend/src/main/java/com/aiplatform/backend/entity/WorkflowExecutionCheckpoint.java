package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("workflow_execution_checkpoint")
public class WorkflowExecutionCheckpoint {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long executionId;

    private Long workflowId;

    private String stepId;

    private Long stepRecordId;

    private String status;

    private String inputJson;

    private String outputJson;

    private String errorMsg;

    private Integer durationMs;

    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
