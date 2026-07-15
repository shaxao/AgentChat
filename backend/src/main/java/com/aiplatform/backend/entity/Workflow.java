package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 工作流定义实体（战略改造 v2.0 P2-1）
 * <p>
 * 工作流是用户创建的可自动化执行的任务编排单元，
 * 通过 JSON DSL 定义触发条件和执行步骤，支持 cron 定时触发。
 * 用户通过自然语言描述需求，AI 自动生成 DSL 并注册到调度器。
 */
@Data
@TableName("workflow")
public class Workflow {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 创建者用户ID */
    private Long userId;

    /** 关联场景ID（P2-2） */
    private Long scenarioId;

    /** 工作流名称 */
    private String name;

    /** 工作流描述 */
    private String description;

    /** 工作流 DSL（JSON 定义） */
    private String dsl;

    /** 触发 cron 表达式 */
    private String cronExpr;

    /** 状态：paused / active / error */
    private String status;

    /** 最后执行时间 */
    private LocalDateTime lastRunAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
