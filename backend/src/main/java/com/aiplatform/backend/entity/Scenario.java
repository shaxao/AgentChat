package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 场景实体（战略改造 v2.0）
 * <p>
 * 场景是职业/行业导向的 AI 工作入口，将 System Prompt、推荐技能、
 * 预置工作流打包为一个"一键激活"的配置单元。
 * 用户可创建自己的场景并分享到社区。
 */
@Data
@TableName("scenario")
public class Scenario {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 场景名称 */
    private String name;

    /** 场景图标 emoji */
    private String icon;

    /** 目标职业/行业 */
    private String profession;

    /** 场景描述（给用户看的） */
    private String description;

    /** 激活场景时注入的 System Prompt */
    private String systemPrompt;

    /** 推荐安装的技能/Agent ID列表（JSON 数组字符串） */
    private String recommendedSkills;

    /** 是否官方场景 */
    private Integer isOfficial;

    /** 是否公开（社区可见） */
    private Integer isPublic;

    /** 创建者用户ID */
    private Long creatorId;

    /** 使用量 */
    private Long usageCount;

    /** 排序权重 */
    private Integer sortOrder;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
