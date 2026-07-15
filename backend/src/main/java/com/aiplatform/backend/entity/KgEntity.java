package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 知识图谱实体表 — 存储用户记忆中的命名实体
 * <p>
 * 将"用户叫老王，在深圳开了家火锅店，有 12 个员工"转化为结构化实体：
 *   老王(person) → 火锅店(organization) → 深圳(place) → 12人(number)
 * <p>
 * 与 {@link KgRelation} 配合形成 (主语, 谓词, 宾语) 三元组知识图谱。
 */
@Data
@TableName("kg_entity")
public class KgEntity {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 所属用户 */
    private Long userId;

    /** 实体名称（如"老王"、"火锅店"、"深圳"） */
    private String name;

    /**
     * 实体类型：person / place / organization / product / number / concept
     */
    private String entityType;

    /** 属性（JSON 字符串，如 {"age":35, "phone":"138..."}） */
    private String properties;

    /** 提取置信度 0-1，默认 0.80 */
    private Double confidence;

    /** 别名（逗号分隔） */
    private String aliases;

    /** 来源对话 UUID */
    private String sourceConvUuid;

    /** 状态：active / merged / archived */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
