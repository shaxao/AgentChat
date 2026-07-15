package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 知识图谱关系表 — 存储 (主语, 谓词, 宾语) 三元组
 * <p>
 * 示例：
 *   老王 → 拥有 → 火锅店        （entity → relation → entity）
 *   火锅店 → 位于 → 深圳        （entity → relation → entity）
 *   火锅店 → 有员工 → "12人"    （entity → relation → literal value）
 * <p>
 * object_entity_id 和 object_value 二选一：
 *   - 实体→实体时填 object_entity_id，object_value 为 NULL
 *   - 实体→字面值时填 object_value，object_entity_id 为 NULL
 */
@Data
@TableName("kg_relation")
public class KgRelation {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 所属用户 */
    private Long userId;

    /** 主语实体 ID（关联 kg_entity.id） */
    private Long subjectEntityId;

    /** 谓词（如"拥有"、"位于"、"有员工"） */
    private String predicate;

    /** 宾语实体 ID（实体→实体关系时使用） */
    private Long objectEntityId;

    /** 宾语字面值（实体→值关系时使用，如"12人"） */
    private String objectValue;

    /** 置信度 0-1，默认 0.80 */
    private Double confidence;

    /** 来源对话 UUID */
    private String sourceConvUuid;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
