package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

/**
 * 知识图谱 DTO — 知识图谱实体/关系提取、查询和注入
 */
public class KgDTO {

    // ===== 实体 VO =====

    @Data
    public static class EntityVO {
        private Long id;
        private String uuid;
        private String name;
        private String entityType;
        private String properties;
        private Double confidence;
        private String aliases;
        private String sourceConvUuid;
        private String status;
        private String createdAt;
    }

    // ===== 关系 VO =====

    @Data
    public static class RelationVO {
        private Long id;
        private String uuid;
        private String predicate;
        private Double confidence;
        private String sourceConvUuid;
        private String createdAt;
        /** 主语实体名称（JOIN 查询填充） */
        private String subjectName;
        private String subjectEntityType;
        /** 宾语实体名称（JOIN 查询填充，实体→实体关系） */
        private String objectName;
        private String objectEntityType;
        /** 宾语的 entity id 或 literal value */
        private Long objectEntityId;
        private String objectValue;
    }

    // ===== 实体 + 关系完整视图 =====

    @Data
    public static class EntityDetailVO {
        private KgDTO.EntityVO entity;
        /** 以该实体为主语的所有关系 */
        private List<KgDTO.RelationVO> outRelations;
        /** 以该实体为宾语的所有关系 */
        private List<KgDTO.RelationVO> inRelations;
    }

    // ===== 图谱上下文（注入 System Prompt） =====

    @Data
    public static class GraphContext {
        /** 格式化后的知识图谱自然语言文本 */
        private String text;
        /** 实体数量 */
        private int entityCount;
        /** 关系数量 */
        private int relationCount;
    }

    // ===== 实体提取（从对话文本中） =====

    @Data
    public static class ExtractResult {
        /** 提取到的实体列表（带关系） */
        private List<ExtractedEntity> entities;
        /** 提取摘要 */
        private String summary;
    }

    @Data
    public static class ExtractedEntity {
        private String name;
        private String entityType;       // person/place/organization/product/number/concept
        private String properties;       // JSON string
        private String aliases;
        /** 该实体涉及的关系（主语→谓词→宾语） */
        private List<ExtractedRelation> relations;
    }

    @Data
    public static class ExtractedRelation {
        /** 谓词（如"拥有"、"位于"、"有员工"） */
        private String predicate;
        /** 宾语实体名称（实体→实体）或字面值（实体→值） */
        private String objectName;
        /** "entity" 或 "literal" */
        private String objectType;
    }

    // ===== 查询请求 =====

    @Data
    public static class QueryRequest {
        private String keyword;          // 实体名称关键词搜索
        private String entityType;       // 按类型过滤
        private Integer page;
        private Integer size;
    }

    @Data
    public static class QueryResult {
        private List<KgDTO.EntityVO> entities;
        private List<KgDTO.RelationVO> relations;
        private long totalEntities;
        private long totalRelations;
    }
}
