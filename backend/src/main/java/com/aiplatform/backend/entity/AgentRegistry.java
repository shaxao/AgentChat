package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * Agent 注册实体
 * <p>
 * 存储动态注册的 Agent Manifest，支持开放平台任何人注册自己的 Agent 应用。
 * 工具定义（tools_json）遵循 OpenAI Function Calling 格式。
 */
@Data
@TableName("agent_registry")
public class AgentRegistry {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** Agent 唯一标识（如 "ban-biao", "code-reviewer"） */
    private String agentId;

    /** 显示名称 */
    private String name;

    /** 版本号 */
    private String version;

    /** 功能描述 */
    private String description;

    /** 分类标签，逗号分隔 */
    private String categories;

    /** 推荐模型（需支持 tool calling） */
    private String model;

    /** 温度 */
    private Double temperature;

    /** 最大 token 数 */
    private Integer maxTokens;

    /** 系统提示词 */
    private String systemPrompt;

    /** 工具定义 JSON 数组（OpenAI Function Calling 格式） */
    private String toolsJson;

    /** 依赖的其他 Skill agentId 列表（JSON 数组，如 ["skill-a","skill-b"]），加载时自动合并依赖 Skill 的工具 */
    private String dependsOn;

    /** 生命周期钩子 JSON */
    private String hooksJson;

    /** 图标 URL */
    private String icon;

    /** 作者 */
    private String author;

    /** 注册 API Key（用于验证 Agent 调用权限） */
    private String apiKey;

    /** 状态：pending/approved/rejected/active/disabled */
    private String status;

    /** 是否内置 Agent */
    private Boolean isBuiltin;

    /** 排序 */
    private Integer sortOrder;

    /** 创建者用户 ID */
    private Long createdBy;

    /** 审核意见 */
    private String reviewComment;

    /** 审核人用户 ID */
    private Long reviewedBy;

    /** 审核时间 */
    private LocalDateTime reviewedAt;

    /** 应用截图 JSON 数组 */
    private String screenshots;

    /** 使用说明 */
    private String usageGuide;

    /** 开发者分成比例（0~1，默认 0.3） */
    private java.math.BigDecimal revenueRatio;

    /** 是否官方认证（P3-4） */
    private Boolean isCertified;

    /** 总使用次数 */
    private Long totalUsage;

    /** 累计分成收入（¥） */
    private java.math.BigDecimal totalRevenue;

    /** 是否公开（社区可见） */
    private Boolean isPublic;

    /** 平均评分 1-5 星（冗余字段加速查询） */
    private java.math.BigDecimal avgRating;

    /** 评分人数 */
    private Integer ratingCount;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
