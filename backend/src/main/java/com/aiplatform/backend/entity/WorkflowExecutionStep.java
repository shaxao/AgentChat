package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 工作流单步骤执行记录。
 */
@Data
@TableName("workflow_execution_step")
public class WorkflowExecutionStep {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long executionId;

    private Long workflowId;

    private String stepId;

    private String stepName;

    private String toolName;

    /** running / completed / skipped / failed / cancelled */
    private String status;

    private String inputJson;

    private String outputJson;

    private String errorMsg;

    private LocalDateTime startedAt;

    private LocalDateTime finishedAt;

    private Integer durationMs;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
