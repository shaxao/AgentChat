package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

/**
 * 场景 DTO
 */
public class ScenarioDTO {

    // ===== 响应 VO =====

    @Data
    public static class ScenarioVO {
        private Long id;
        private String name;
        private String icon;
        private String profession;
        private String description;
        private String systemPrompt;
        private List<String> recommendedSkills;
        private Boolean isOfficial;
        private Boolean isPublic;
        private Long creatorId;
        private Long usageCount;
        private Integer sortOrder;
        private String createdAt;
        private String updatedAt;
        /** 关联工作流数量（P2-2） */
        private Integer workflowCount;
        /** 关联工作流模板列表（P2-2） */
        private List<WorkflowDTO.WorkflowTemplateBrief> workflowTemplates;
    }

    @Data
    public static class ScenarioBriefVO {
        private Long id;
        private String name;
        private String icon;
        private String profession;
        private String description;
        private Boolean isOfficial;
        private Boolean isPublic;
        private Long usageCount;
    }

    // ===== 请求 =====

    @Data
    public static class ScenarioCreateRequest {
        private String name;
        private String icon;
        private String profession;
        private String description;
        private String systemPrompt;
        private List<String> recommendedSkills;
        private List<Long> workflowIds;
        private Boolean isPublic;
        private Boolean isOfficial;
    }

    @Data
    public static class ScenarioUpdateRequest {
        private String name;
        private String icon;
        private String profession;
        private String description;
        private String systemPrompt;
        private List<String> recommendedSkills;
        private List<Long> workflowIds;
        private Boolean isPublic;
        private Boolean isOfficial;
    }

    // ===== 激活响应 =====

    @Data
    public static class ScenarioActivateResponse {
        private Long scenarioId;
        private String scenarioName;
        private String systemPrompt;
        private List<String> recommendedSkills;
        private String profession;
        /** 关联工作流数量（P2-2） */
        private Integer workflowCount;
        /** 关联工作流模板列表（P2-2） */
        private List<WorkflowDTO.WorkflowTemplateBrief> workflowTemplates;
    }

    // ===== 职业分组 =====

    @Data
    public static class ProfessionGroupVO {
        private String profession;
        private String label;
        private Integer count;
    }
}
