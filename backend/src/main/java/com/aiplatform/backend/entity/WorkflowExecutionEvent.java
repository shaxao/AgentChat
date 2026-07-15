package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 工作流执行事件流。
 */
@Data
@TableName("workflow_execution_event")
public class WorkflowExecutionEvent {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long executionId;

    private String stepId;

    /** workflow_started / step_started / step_completed / step_failed / workflow_completed 等 */
    private String eventType;

    private String message;

    private String payloadJson;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
