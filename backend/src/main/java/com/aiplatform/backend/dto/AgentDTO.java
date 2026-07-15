package com.aiplatform.backend.dto;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * Agent 开放平台 DTO
 */
public class AgentDTO {

    /**
     * 注册/更新 Agent 请求
     */
    @Data
    public static class RegisterRequest {
        /** Agent 唯一标识（字母数字+短横线，如 "ban-biao"） */
        private String agentId;

        /** 显示名称 */
        private String name;

        /** 版本号（默认 "1.0.0"） */
        private String version;

        /** 功能描述 */
        private String description;

        /** 分类标签 */
        private List<String> categories;

        /** 推荐模型 */
        private String model;

        /** 温度 */
        private Double temperature;

        /** 最大 token 数 */
        private Integer maxTokens;

        /** 系统提示词 */
        private String systemPrompt;

        /** 工具定义列表（OpenAI Function Calling 格式） */
        private List<ToolDef> tools;

        /** 生命周期钩子 */
        private HooksDef hooks;

        /** 图标 URL */
        private String icon;

        /** 作者 */
        private String author;

        /** 状态（draft / active） */
        private String status;

        /** 应用截图 JSON 数组 */
        private List<String> screenshots;

        /** 使用说明 */
        private String usageGuide;

        /** 依赖的其他 Skill agentId 列表（JSON 数组），加载时自动合并依赖 Skill 的工具 */
        private List<String> dependsOn;
    }

    /**
     * 工具定义
     */
    @Data
    public static class ToolDef {
        private String name;
        private String description;
        private Map<String, Object> parameters;
        /** HTTP 端点（可选，用于远程工具） */
        private String endpoint;
        /** 是否危险操作 */
        private Boolean isDangerous;
        /** 执行模式：local / http */
        private String executionMode;
        /** 工具脚本代码（Python），保存到 toolsJson 中 */
        private String code;
    }

    /**
     * 生命周期钩子
     */
    @Data
    public static class HooksDef {
        /** Agent 开始时调用 */
        private String onStart;
        /** 工具调用前/后 */
        private String onToolCall;
        /** Agent 完成时调用 */
        private String onDone;
    }

    /**
     * Agent 列表响应项
     */
    @Data
    public static class AgentListItem {
        private Long id;
        private String agentId;
        private String name;
        private String version;
        private String description;
        private List<String> categories;
        private String model;
        private String icon;
        private String author;
        private String status;
        private Boolean isBuiltin;
        private Integer toolCount;
        private Long totalUsage;
        private java.math.BigDecimal revenueRatio;
        /** 社区评分 (P2-3) */
        private java.math.BigDecimal avgRating;
        private Integer ratingCount;
        private Boolean isPublic;
        private String reviewComment;
        private String reviewedAt;
        private String createdAt;
        /** 当前用户是否已安装此技能 */
        private Boolean installed;
    }

    /**
     * Agent 详情响应
     */
    @Data
    public static class AgentDetail {
        private Long id;
        private String agentId;
        private String name;
        private String version;
        private String description;
        private List<String> categories;
        private String model;
        private Double temperature;
        private Integer maxTokens;
        private String systemPrompt;
        private List<ToolDef> tools;
        private HooksDef hooks;
        private String icon;
        private String author;
        private String status;
        private Boolean isBuiltin;
        private Integer sortOrder;
        private List<String> screenshots;
        private String usageGuide;
        private java.math.BigDecimal revenueRatio;
        private Long totalUsage;
        private java.math.BigDecimal totalRevenue;
        private String reviewComment;
        private Long reviewedBy;
        private String reviewedAt;
        private Long createdBy;
        private String createdAt;
        private String updatedAt;
        /** 社区评分 (P2-3) */
        private java.math.BigDecimal avgRating;
        private Integer ratingCount;
        private Boolean isPublic;
    }

    /**
     * 审核请求
     */
    @Data
    public static class ReviewRequest {
        /** 审核意见 */
        private String comment;
    }

    /**
     * 分页结果
     */
    @Data
    public static class PageResult<T> {
        private List<T> content;
        private int page;
        private int size;
        private long totalElements;
        private int totalPages;

        public static <T> PageResult<T> of(List<T> content, int page, int size, long totalElements) {
            PageResult<T> r = new PageResult<>();
            r.content = content;
            r.page = page;
            r.size = size;
            r.totalElements = totalElements;
            r.totalPages = size > 0 ? (int) Math.ceil((double) totalElements / size) : 0;
            return r;
        }
    }

    // ===== 创作者排行榜 (P3-4) =====

    /**
     * 创作者排行榜条目
     */
    @Data
    public static class CreatorRankVO {
        private int rank;               // 排名
        private Long userId;            // 用户ID
        private String username;        // 用户名
        private String avatar;          // 头像
        private String agentId;         // Agent ID
        private String agentName;       // Agent 名称
        private String agentIcon;       // Agent 图标
        private java.math.BigDecimal totalRevenue;  // 总收入
        private int useCount;           // 使用次数
        private boolean isCertified;    // 是否官方认证
    }

    /**
     * 创作者排行榜响应
     */
    @Data
    public static class CreatorLeaderboardResponse {
        private List<CreatorRankVO> rankings;
        private String period;          // week/month/all
        private String updatedAt;
    }

    // ===== 技能商店统计 =====

    /**
     * 技能商店统计数据
     */
    @Data
    public static class AgentStoreStats {
        private long totalAgents;       // 上架技能总数
        private int totalCategories;    // 分类标签数（去重）
        private long totalUsage;        // 累计使用次数
        private long newThisWeek;       // 本周新增
    }
}
