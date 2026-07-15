package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 技能评分实体
 * <p>
 * 用户对已安装/使用过的技能进行 1-5 星评分，可选附文字评价。
 * 同一用户对同一技能只能有一条有效评分（uk_skill_rating_user 唯一约束）。
 */
@Data
@TableName("skill_rating")
public class SkillRating {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 关联 agent_registry.id */
    private Long agentId;

    /** 评分用户 ID */
    private Long userId;

    /** 评分 1-5 星 */
    private Integer rating;

    /** 评价内容（可选） */
    private String comment;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
