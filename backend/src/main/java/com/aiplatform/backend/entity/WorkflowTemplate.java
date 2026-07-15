package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 工作流模板实体（战略改造 v3.0 P3-2）
 * <p>
 * 工作流模板市场：官方出模板 + 用户可将工作流发布为模板。
 * 模板支持参数化（params_schema），用户填入参数即可克隆使用。
 */
@Data
@TableName("workflow_template")
public class WorkflowTemplate {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 唯一标识 */
    private String uuid;

    /** 模板名称 */
    private String name;

    /** 模板描述 */
    private String description;

    /** 分类：general/data/report/notification/schedule/automation/ai */
    private String category;

    /** 模板图标 emoji */
    private String icon;

    /** 工作流 DSL 定义（JSON） */
    private String dsl;

    /** 参数化字段定义（JSON 数组） */
    private String paramsSchema;

    /** 是否官方模板 */
    private Integer isOfficial;

    /** 作者用户ID（0=官方） */
    private Long authorId;

    /** 作者名称 */
    private String authorName;

    /** 使用次数 */
    private Integer useCount;

    /** 平均评分 0-5 */
    private java.math.BigDecimal rating;

    /** 评分人数 */
    private Integer ratingCount;

    /** 是否已发布 */
    private Integer isPublished;

    /** 是否官方认证 */
    private Integer isCertified;

    /** 来源工作流ID（用户发布模板时关联） */
    private Long sourceWorkflowId;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
