package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 工作流执行记录实体（战略改造 v2.0 P2-1）
 * <p>
 * 记录每次工作流执行的详细信息，包括触发方式、各步骤结果、
 * 执行耗时和错误信息，用于追踪和调试。
 */
@Data
@TableName("workflow_execution")
public class WorkflowExecution {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 关联工作流ID */
    private Long workflowId;

    /** 执行者用户ID */
    private Long userId;

    /** 执行状态：running / success / failed / cancelled */
    private String status;

    /** 触发方式：manual / cron */
    private String triggerType;

    /** 输入参数（JSON） */
    private String inputJson;

    /** 执行结果（JSON） */
    private String outputJson;

    /** 各步骤执行结果（JSON 数组） */
    private String stepResults;

    /** 错误信息 */
    private String errorMsg;

    /** 开始时间 */
    private LocalDateTime startedAt;

    /** 完成时间 */
    private LocalDateTime finishedAt;

    /** 执行耗时（毫秒） */
    private Integer durationMs;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
