package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.KgDTO;
import com.aiplatform.backend.entity.KgEntity;
import com.aiplatform.backend.entity.KgRelation;
import com.aiplatform.backend.mapper.KgEntityMapper;
import com.aiplatform.backend.mapper.KgRelationMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 知识图谱服务 v2 — 从对话中提取实体/关系三元组并注入系统提示
 *
 * <p>将"用户叫老王，在深圳开了家火锅店，有 12 个员工"转化为：
 * <pre>
 *   KgEntity("老王", person) → KgRelation("拥有") → KgEntity("火锅店", organization)
 *   KgEntity("火锅店", organization) → KgRelation("位于") → KgEntity("深圳", place)
 *   KgEntity("火锅店", organization) → KgRelation("有员工") → "12人"
 * </pre>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class KnowledgeGraphService {

    private final KgEntityMapper entityMapper;
    private final KgRelationMapper relationMapper;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final ObjectMapper objectMapper;

    /**
     * 实体提取系统提示词 — 指导 LLM 从对话中提取结构化实体和关系
     */
    private static final String EXTRACTION_SYSTEM_PROMPT = """
            你是一个知识图谱提取器。从用户的对话中识别命名实体和它们之间的关系，以 JSON 格式输出。

            规则：
            1. 实体类型只能从以下选：person（人）、place（地点）、organization（组织）、product（产品）、number（数量/数字）、concept（概念）
            2. 每个实体必须有 name（名称）、entityType（类型），可选 properties（JSON对象属性）、aliases（别名逗号分隔）
            3. 关系必须是 (主语实体, 谓词, 宾语) 三元组。宾语可以是另一个实体名称（实体→实体）或字面值如"12人"（实体→值）
            4. 谓词要简洁：如"拥有"、"位于"、"有员工"、"担任"、"毕业于"、"使用"、"创建于"
            5. 只提取明确提及的实体，不要推测
            6. 置信度 0-1，不确定时用 0.5-0.7

            输出 JSON 格式：
            {
              "entities": [
                {
                  "name": "老王",
                  "entityType": "person",
                  "properties": "{\\"age\\":35}",
                  "aliases": "王先生",
                  "relations": [
                    {"predicate": "拥有", "objectName": "火锅店", "objectType": "entity"},
                    {"predicate": "有员工", "objectName": "12人", "objectType": "literal"}
                  ]
                }
              ]
            }
            
            只输出 JSON，不要其他内容。""";

    // ==================== 异步实体提取 ====================

    /**
     * 从一轮对话中异步提取实体和关系并写入知识图谱。
     * 在 MemoryService.autoUpdateConversationMemory 之后调用。
     *
     * @param userId        用户 ID
     * @param convUuid      对话 UUID
     * @param userMessage   用户消息
     * @param assistantReply AI 回复
     */
    @Async
    public void extractAndUpsertAsync(Long userId, String convUuid,
                                       String userMessage, String assistantReply) {
        try {
            String conversationText = buildExtractionText(userMessage, assistantReply);
            if (conversationText.isBlank()) return;

            log.info("[KG] 开始提取实体: userId={}, convUuid={}, textLen={}", userId, convUuid, conversationText.length());

            AiService.AiResult result = aiService.chatWithFallback(
                    List.of("deepseek-v4-pro"),  // 优先高质量模型
                    EXTRACTION_SYSTEM_PROMPT,
                    conversationText,
                    0.2,   // 低温度确保稳定输出
                    1024   // max tokens
            );

            if (result == null || result.content() == null || result.content().isBlank()) {
                log.warn("[KG] LLM 提取结果为空: userId={}", userId);
                return;
            }

            // ★ 计费追踪 — 知识图谱实体提取
            try {
                usageTrackingService.trackFull(userId,
                        result.model() != null ? result.model() : "deepseek-v4-pro",
                        result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                        result.latencyMs(), "kg_extraction", null);
            } catch (Exception ex) {
                log.warn("[KG] 计费追踪失败: {}", ex.getMessage());
            }

            String jsonStr = extractJsonBlock(result.content());
            KgDTO.ExtractResult extracted = parseExtractResult(jsonStr);
            if (extracted.getEntities().isEmpty()) {
                log.info("[KG] 未提取到实体: userId={}", userId);
                return;
            }

            // 写入数据库
            int entityCount = upsertEntitiesAndRelations(userId, convUuid, extracted.getEntities());
            log.info("[KG] 知识图谱更新完成: userId={}, 新实体数={}", userId, entityCount);

        } catch (Exception e) {
            log.error("[KG] 实体提取失败: userId={}, err={}", userId, e.getMessage(), e);
        }
    }

    // ==================== 图谱上下文注入 ====================

    /**
     * 为用户构建知识图谱自然语言上下文，注入到 System Prompt
     */
    public KgDTO.GraphContext buildGraphContext(Long userId) {
        KgDTO.GraphContext ctx = new KgDTO.GraphContext();

        List<KgEntity> entities = entityMapper.selectList(
                new QueryWrapper<KgEntity>()
                        .eq("user_id", userId)
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .orderByDesc("confidence")
                        .last("LIMIT 100"));

        if (entities.isEmpty()) {
            ctx.setText("");
            ctx.setEntityCount(0);
            ctx.setRelationCount(0);
            return ctx;
        }

        // 查询所有相关关系
        List<Long> entityIds = entities.stream().map(KgEntity::getId).collect(Collectors.toList());
        List<KgRelation> relations = relationMapper.selectList(
                new QueryWrapper<KgRelation>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .in("subject_entity_id", entityIds));

        // 构建名称→实体映射
        Map<Long, KgEntity> entityMap = entities.stream()
                .collect(Collectors.toMap(KgEntity::getId, e -> e));

        // 格式化图谱文本
        StringBuilder sb = new StringBuilder();
        sb.append("## 用户知识图谱\n\n");
        sb.append("以下是根据历史对话提取的用户关键信息：\n\n");

        // 按实体类型分组
        Map<String, List<KgEntity>> byType = entities.stream()
                .collect(Collectors.groupingBy(KgEntity::getEntityType));

        if (!byType.isEmpty()) {
            sb.append("### 实体\n");
            for (Map.Entry<String, List<KgEntity>> entry : byType.entrySet()) {
                sb.append("- **").append(typeLabel(entry.getKey())).append("**：");
                sb.append(entry.getValue().stream()
                        .map(e -> {
                            String n = e.getName();
                            if (e.getProperties() != null && !e.getProperties().isBlank()
                                    && !"{}".equals(e.getProperties())) {
                                n += "(" + e.getProperties() + ")";
                            }
                            return n;
                        })
                        .collect(Collectors.joining("、")));
                sb.append("\n");
            }
            sb.append("\n");
        }

        if (!relations.isEmpty()) {
            sb.append("### 关系\n");
            for (KgRelation r : relations) {
                String subjName = entityMap.containsKey(r.getSubjectEntityId())
                        ? entityMap.get(r.getSubjectEntityId()).getName() : "?";
                String objStr;
                if (r.getObjectEntityId() != null && entityMap.containsKey(r.getObjectEntityId())) {
                    objStr = entityMap.get(r.getObjectEntityId()).getName();
                } else if (r.getObjectValue() != null) {
                    objStr = r.getObjectValue();
                } else {
                    objStr = "?";
                }
                sb.append("- ").append(subjName).append(" → ").append(r.getPredicate())
                        .append(" → ").append(objStr).append("\n");
            }
            sb.append("\n");
        }

        ctx.setText(sb.toString());
        ctx.setEntityCount(entities.size());
        ctx.setRelationCount(relations.size());
        return ctx;
    }

    // ==================== 查询 ====================

    /**
     * 查询用户的知识图谱实体
     */
    public KgDTO.QueryResult queryEntities(Long userId, String keyword, String entityType, int page, int size) {
        KgDTO.QueryResult result = new KgDTO.QueryResult();

        QueryWrapper<KgEntity> query = new QueryWrapper<KgEntity>()
                .eq("user_id", userId)
                .eq("deleted", 0);

        if (keyword != null && !keyword.isBlank()) {
            query.like("name", keyword);
        }
        if (entityType != null && !entityType.isBlank()) {
            query.eq("entity_type", entityType);
        }
        query.orderByDesc("confidence");

        Page<KgEntity> entityPage = new Page<>(page, size);
        Page<KgEntity> paged = entityMapper.selectPage(entityPage, query);

        result.setEntities(paged.getRecords().stream().map(this::toEntityVO).collect(Collectors.toList()));
        result.setTotalEntities(paged.getTotal());
        result.setRelations(List.of());
        result.setTotalRelations(0);

        return result;
    }

    /**
     * 获取实体详情（含所有关联关系）
     */
    public KgDTO.EntityDetailVO getEntityDetail(Long entityId) {
        KgEntity entity = entityMapper.selectById(entityId);
        if (entity == null) return null;

        KgDTO.EntityDetailVO detail = new KgDTO.EntityDetailVO();
        detail.setEntity(toEntityVO(entity));

        // 出边关系（主语）
        List<KgRelation> outRels = relationMapper.selectList(
                new QueryWrapper<KgRelation>()
                        .eq("subject_entity_id", entityId)
                        .eq("deleted", 0));
        detail.setOutRelations(toRelationVOs(outRels));

        // 入边关系（宾语）
        List<KgRelation> inRels = relationMapper.selectList(
                new QueryWrapper<KgRelation>()
                        .eq("object_entity_id", entityId)
                        .eq("deleted", 0));
        detail.setInRelations(toRelationVOs(inRels));

        return detail;
    }

    // ==================== 内部：写入 ====================

    /**
     * 批量 upsert 实体和关系
     */
    @Transactional
    protected int upsertEntitiesAndRelations(Long userId, String convUuid,
                                              List<KgDTO.ExtractedEntity> extractedEntities) {
        int count = 0;
        // 第一遍：插入/更新实体，建立名称→ID映射
        Map<String, Long> nameToId = new HashMap<>();
        for (KgDTO.ExtractedEntity ee : extractedEntities) {
            if (ee.getName() == null || ee.getName().isBlank()) continue;
            Long entityId = upsertEntity(userId, ee, convUuid);
            nameToId.put(ee.getName(), entityId);
            count++;
        }

        // 第二遍：插入关系
        for (KgDTO.ExtractedEntity ee : extractedEntities) {
            if (ee.getRelations() == null) continue;
            Long subjectId = nameToId.get(ee.getName());
            if (subjectId == null) continue;

            for (KgDTO.ExtractedRelation rel : ee.getRelations()) {
                if (rel.getPredicate() == null || rel.getPredicate().isBlank()) continue;
                if (rel.getObjectName() == null || rel.getObjectName().isBlank()) continue;

                if ("literal".equals(rel.getObjectType())) {
                    // 实体→字面值
                    upsertRelationLiteral(userId, subjectId, rel.getPredicate(), rel.getObjectName(), convUuid);
                } else {
                    // 实体→实体
                    Long objectId = nameToId.get(rel.getObjectName());
                    if (objectId != null) {
                        upsertRelationEntity(userId, subjectId, rel.getPredicate(), objectId, convUuid);
                    } else {
                        // 宾语实体还未创建（可能在其他对话中），尝试从DB查找
                        KgEntity existing = entityMapper.selectOne(
                                new QueryWrapper<KgEntity>()
                                        .eq("user_id", userId)
                                        .eq("name", rel.getObjectName())
                                        .eq("deleted", 0));
                        if (existing != null) {
                            upsertRelationEntity(userId, subjectId, rel.getPredicate(), existing.getId(), convUuid);
                        } else {
                            log.debug("[KG] 宾语实体不存在，跳过关系: {}→{}→{}",
                                    ee.getName(), rel.getPredicate(), rel.getObjectName());
                        }
                    }
                }
            }
        }
        return count;
    }

    /**
     * Upsert 单个实体（按 user_id+name 去重）
     */
    private Long upsertEntity(Long userId, KgDTO.ExtractedEntity ee, String convUuid) {
        // 查找已有实体
        KgEntity existing = entityMapper.selectOne(
                new QueryWrapper<KgEntity>()
                        .eq("user_id", userId)
                        .eq("name", ee.getName())
                        .eq("deleted", 0));

        if (existing != null) {
            // 更新：合并 properties（浅合并）
            boolean updated = false;
            if (ee.getProperties() != null && !ee.getProperties().isBlank() && !"{}".equals(ee.getProperties())) {
                existing.setProperties(ee.getProperties());
                updated = true;
            }
            if (ee.getEntityType() != null && !ee.getEntityType().isBlank()) {
                existing.setEntityType(ee.getEntityType());
                updated = true;
            }
            if (ee.getAliases() != null && !ee.getAliases().isBlank()) {
                existing.setAliases(ee.getAliases());
                updated = true;
            }
            if (updated) {
                entityMapper.updateById(existing);
                log.debug("[KG] 更新实体: {} (id={})", ee.getName(), existing.getId());
            }
            return existing.getId();
        }

        // 新建
        KgEntity entity = new KgEntity();
        entity.setUuid(UUID.randomUUID().toString());
        entity.setUserId(userId);
        entity.setName(ee.getName());
        entity.setEntityType(ee.getEntityType() != null ? ee.getEntityType() : "concept");
        entity.setProperties(ee.getProperties());
        entity.setConfidence(0.80);
        entity.setAliases(ee.getAliases());
        entity.setSourceConvUuid(convUuid);
        entity.setStatus("active");
        entityMapper.insert(entity);
        log.debug("[KG] 新建实体: {} (type={}, id={})", ee.getName(), entity.getEntityType(), entity.getId());
        return entity.getId();
    }

    /**
     * Upsert 实体→实体关系
     */
    private void upsertRelationEntity(Long userId, Long subjectId, String predicate, Long objectId, String convUuid) {
        if (subjectId.equals(objectId)) return; // 防止自引用

        KgRelation existing = relationMapper.selectOne(
                new QueryWrapper<KgRelation>()
                        .eq("subject_entity_id", subjectId)
                        .eq("predicate", predicate)
                        .eq("object_entity_id", objectId)
                        .eq("deleted", 0));

        if (existing == null) {
            KgRelation rel = new KgRelation();
            rel.setUuid(UUID.randomUUID().toString());
            rel.setUserId(userId);
            rel.setSubjectEntityId(subjectId);
            rel.setPredicate(predicate);
            rel.setObjectEntityId(objectId);
            rel.setConfidence(0.80);
            rel.setSourceConvUuid(convUuid);
            relationMapper.insert(rel);
            log.debug("[KG] 新建关系: {}→{}→{}", subjectId, predicate, objectId);
        }
    }

    /**
     * Upsert 实体→字面值关系
     */
    private void upsertRelationLiteral(Long userId, Long subjectId, String predicate, String value, String convUuid) {
        KgRelation existing = relationMapper.selectOne(
                new QueryWrapper<KgRelation>()
                        .eq("subject_entity_id", subjectId)
                        .eq("predicate", predicate)
                        .eq("object_value", value)
                        .eq("deleted", 0));

        if (existing == null) {
            KgRelation rel = new KgRelation();
            rel.setUuid(UUID.randomUUID().toString());
            rel.setUserId(userId);
            rel.setSubjectEntityId(subjectId);
            rel.setPredicate(predicate);
            rel.setObjectValue(value);
            rel.setConfidence(0.80);
            rel.setSourceConvUuid(convUuid);
            relationMapper.insert(rel);
            log.debug("[KG] 新建字面值关系: {}→{}→\"{}\"", subjectId, predicate, value);
        }
    }

    // ==================== 内部：解析 ====================

    /**
     * 构建发送给 LLM 的提取文本
     */
    private String buildExtractionText(String userMessage, String assistantReply) {
        StringBuilder sb = new StringBuilder();
        if (userMessage != null && !userMessage.isBlank()) {
            sb.append("用户: ").append(userMessage.trim()).append("\n");
        }
        if (assistantReply != null && !assistantReply.isBlank()) {
            // 截断过长回复，提取足够上下文
            String truncated = assistantReply.length() > 2000
                    ? assistantReply.substring(0, 2000) + "..."
                    : assistantReply;
            sb.append("AI: ").append(truncated.trim());
        }
        return sb.toString();
    }

    /**
     * 从 LLM 输出中提取 JSON 块
     */
    private String extractJsonBlock(String llmOutput) {
        String trimmed = llmOutput.trim();
        // 尝试找到 ```json ... ``` 代码块
        int start = trimmed.indexOf("```json");
        if (start >= 0) {
            start = trimmed.indexOf("\n", start) + 1;
            int end = trimmed.indexOf("```", start);
            if (end > start) return trimmed.substring(start, end).trim();
        }
        // 尝试找到 { ... }
        start = trimmed.indexOf('{');
        int end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) return trimmed.substring(start, end + 1);
        // 原始输出
        return trimmed;
    }

    /**
     * 解析 LLM 提取结果为 ExtractResult
     */
    private KgDTO.ExtractResult parseExtractResult(String jsonStr) {
        KgDTO.ExtractResult result = new KgDTO.ExtractResult();
        try {
            JsonNode root = objectMapper.readTree(jsonStr);
            List<KgDTO.ExtractedEntity> entities = new ArrayList<>();

            JsonNode entityArray = root.get("entities");
            if (entityArray != null && entityArray.isArray()) {
                for (JsonNode node : entityArray) {
                    KgDTO.ExtractedEntity ee = new KgDTO.ExtractedEntity();
                    ee.setName(node.has("name") ? node.get("name").asText() : null);
                    ee.setEntityType(node.has("entityType") ? node.get("entityType").asText() : "concept");
                    ee.setProperties(node.has("properties")
                            ? (node.get("properties").isTextual()
                                    ? node.get("properties").asText()
                                    : node.get("properties").toString())
                            : null);
                    ee.setAliases(node.has("aliases") ? node.get("aliases").asText() : null);

                    // 解析关系
                    JsonNode relArray = node.get("relations");
                    if (relArray != null && relArray.isArray()) {
                        List<KgDTO.ExtractedRelation> relations = new ArrayList<>();
                        for (JsonNode relNode : relArray) {
                            KgDTO.ExtractedRelation er = new KgDTO.ExtractedRelation();
                            er.setPredicate(relNode.has("predicate") ? relNode.get("predicate").asText() : null);
                            er.setObjectName(relNode.has("objectName") ? relNode.get("objectName").asText() : null);
                            er.setObjectType(relNode.has("objectType") ? relNode.get("objectType").asText() : "entity");
                            if (er.getPredicate() != null && er.getObjectName() != null) {
                                relations.add(er);
                            }
                        }
                        ee.setRelations(relations);
                    }
                    if (ee.getName() != null) {
                        entities.add(ee);
                    }
                }
            }
            result.setEntities(entities);
        } catch (Exception e) {
            log.warn("[KG] JSON 解析失败: {}", e.getMessage());
        }
        return result;
    }

    // ==================== 内部：转换 ====================

    private KgDTO.EntityVO toEntityVO(KgEntity e) {
        KgDTO.EntityVO vo = new KgDTO.EntityVO();
        vo.setId(e.getId());
        vo.setUuid(e.getUuid());
        vo.setName(e.getName());
        vo.setEntityType(e.getEntityType());
        vo.setProperties(e.getProperties());
        vo.setConfidence(e.getConfidence());
        vo.setAliases(e.getAliases());
        vo.setSourceConvUuid(e.getSourceConvUuid());
        vo.setStatus(e.getStatus());
        vo.setCreatedAt(e.getCreatedAt() != null ? e.getCreatedAt().toString() : null);
        return vo;
    }

    private List<KgDTO.RelationVO> toRelationVOs(List<KgRelation> relations) {
        return relations.stream().map(r -> {
            KgDTO.RelationVO vo = new KgDTO.RelationVO();
            vo.setId(r.getId());
            vo.setUuid(r.getUuid());
            vo.setPredicate(r.getPredicate());
            vo.setConfidence(r.getConfidence());
            vo.setSourceConvUuid(r.getSourceConvUuid());
            vo.setCreatedAt(r.getCreatedAt() != null ? r.getCreatedAt().toString() : null);
            vo.setObjectEntityId(r.getObjectEntityId());
            vo.setObjectValue(r.getObjectValue());
            return vo;
        }).collect(Collectors.toList());
    }

    private static String typeLabel(String entityType) {
        return switch (entityType) {
            case "person" -> "人物";
            case "place" -> "地点";
            case "organization" -> "组织";
            case "product" -> "产品";
            case "number" -> "数量";
            case "concept" -> "概念";
            default -> entityType;
        };
    }
}
