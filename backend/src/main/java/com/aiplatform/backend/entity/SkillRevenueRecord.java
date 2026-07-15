package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 技能收益记录实体（战略改造 v3.0 P3-4）
 * <p>
 * 记录创作者从技能使用中获得的分成收益。
 * 收益类型：usage（按使用量付费）/ download（下载付费）/ subscription（订阅付费）
 */
@Data
@TableName("skill_revenue_record")
public class SkillRevenueRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 唯一标识 */
    private String uuid;

    /** 创作者用户ID */
    private Long userId;

    /** 关联 agent_registry.id */
    private Long agentId;

    /** 收益类型：usage/download/subscription */
    private String revenueType;

    /** 收益金额 */
    private BigDecimal amount;

    /** 收益描述 */
    private String description;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
