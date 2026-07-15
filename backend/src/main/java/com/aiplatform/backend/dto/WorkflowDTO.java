package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

/**
 * 工作流 DTO（战略改造 v2.0 P2-1）
 */
public class WorkflowDTO {

    // ===== 响应 VO =====

    @Data
    public static class WorkflowVO {
        private Long id;
        private Long userId;
        private Long scenarioId;
        private String name;
        private String description;
        private String dsl;
        private String cronExpr;
        private String status;
        private String lastRunAt;
        private String createdAt;
        private String updatedAt;
    }

    @Data
    public static class WorkflowBriefVO {
        private Long id;
        private String name;
        private String description;
        private String status;
        private String cronExpr;
        private String lastRunAt;
        private Long scenarioId;
    }

    /** 场景详情中展示的工作流模板概要（P2-2） */
    @Data
    public static class WorkflowTemplateBrief {
        private Long id;
        private String name;
        private String description;
        private String status;
    }

    // ===== 请求 =====

    @Data
    public static class WorkflowCreateRequest {
        private String name;
        private String description;
        private String dsl;
        private String cronExpr;
        private Long scenarioId;
    }

    @Data
    public static class WorkflowUpdateRequest {
        private String name;
        private String description;
        private String dsl;
        private String cronExpr;
        private Long scenarioId;
    }

    @Data
    public static class WorkflowStatusRequest {
        private String status;  // paused / active
    }

    // ===== 执行记录 VO =====

    @Data
    public static class ExecutionVO {
        private Long id;
        private Long workflowId;
        private Long userId;
        private String status;
        private String triggerType;
        private String inputJson;
        private String outputJson;
        private String stepResults;
        private String errorMsg;
        private String startedAt;
        private String finishedAt;
        private Integer durationMs;
        private List<ExecutionStepVO> steps;
        private List<ExecutionEventVO> events;
    }

    @Data
    public static class ExecutionStepVO {
        private Long id;
        private Long executionId;
        private Long workflowId;
        private String stepId;
        private String stepName;
        private String toolName;
        private String status;
        private String inputJson;
        private String outputJson;
        private String errorMsg;
        private String startedAt;
        private String finishedAt;
        private Integer durationMs;
        private String createdAt;
    }

    @Data
    public static class ExecutionEventVO {
        private Long id;
        private Long executionId;
        private String stepId;
        private String eventType;
        private String message;
        private String payloadJson;
        private String createdAt;
    }

    @Data
    public static class ExecutionBriefVO {
        private Long id;
        private Long workflowId;
        private String status;
        private String triggerType;
        private String startedAt;
        private String finishedAt;
        private Integer durationMs;
    }

    // ===== 工作流模板市场（P3-2）=====

    @Data
    public static class WorkflowTemplateVO {
        private Long id;
        private String uuid;
        private String name;
        private String description;
        private String category;
        private String icon;
        private String dsl;
        private String paramsSchema;
        private Boolean isOfficial;
        private Long authorId;
        private String authorName;
        private Integer useCount;
        private java.math.BigDecimal rating;
        private Integer ratingCount;
        private Boolean isPublished;
        private Boolean isCertified;
        private Long sourceWorkflowId;
        private String createdAt;
        private String updatedAt;
    }

    @Data
    public static class WorkflowTemplateBriefVO {
        private Long id;
        private String uuid;
        private String name;
        private String description;
        private String category;
        private String icon;
        private Boolean isOfficial;
        private String authorName;
        private Integer useCount;
        private java.math.BigDecimal rating;
        private Integer ratingCount;
        private Boolean isCertified;
        private Integer stepCount;  // DSL 中步骤数
        private String createdAt;
    }

    @Data
    public static class TemplatePublishRequest {
        private Long workflowId;        // 要发布的工作流ID
        private String name;            // 模板名称
        private String description;     // 模板描述
        private String category;        // 分类
        private String icon;            // 图标 emoji
        private String paramsSchema;    // 参数化字段定义（JSON 数组字符串）
    }

    @Data
    public static class TemplateCloneRequest {
        private String name;            // 克隆后的工作流名称（可选）
        private String params;          // 用户填入的参数（JSON 对象字符串）
    }

    @Data
    public static class TemplateSearchRequest {
        private String keyword;         // 搜索关键词
        private String category;        // 分类筛选
        private Boolean official;       // 只看官方
        private Boolean certified;      // 只看认证
        private String sort;            // 排序：hot/newest/rating
        private Integer page;           // 页码（从1开始）
        private Integer pageSize;       // 每页数量
    }

    @Data
    public static class TemplateRateRequest {
        private Integer rating;         // 评分 1-5
    }

    @Data
    public static class TemplatePageResult {
        private List<WorkflowTemplateBriefVO> items;
        private long total;
        private int page;
        private int pageSize;
        private int totalPages;
    }

    // ===== AI 生成请求 =====

    @Data
    public static class WorkflowGenerateRequest {
        private String naturalLanguage;  // 自然语言描述
        private String conversationId;   // 可选：关联对话 ID
    }

    @Data
    public static class WorkflowResumeRequest {
        /** 指定从哪个步骤继续；为空时默认从失败/取消步骤开始 */
        private String fromStepId;
    }
}
