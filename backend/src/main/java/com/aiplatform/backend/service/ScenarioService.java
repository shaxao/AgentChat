package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ScenarioDTO;
import com.aiplatform.backend.dto.WorkflowDTO;
import com.aiplatform.backend.entity.Scenario;
import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.mapper.ScenarioMapper;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 场景系统核心服务（战略改造 v2.0）
 * <p>
 * 场景是职业/行业导向的 AI 工作入口。
 * 支持官方预置 + 用户创建分享，按职业分组浏览。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ScenarioService {

    private final ScenarioMapper scenarioMapper;
    private final WorkflowMapper workflowMapper;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    // =============================================
    // 查询
    // =============================================

    /**
     * 按职业分组列出场景（仅返回公开的）
     */
    public List<ScenarioDTO.ProfessionGroupVO> listProfessionGroups() {
        List<Scenario> all = scenarioMapper.selectList(
                new QueryWrapper<Scenario>()
                        .eq("is_public", 1)
                        .eq("deleted", 0)
                        .orderByDesc("is_official")
                        .orderByDesc("usage_count"));

        // 按 profession 分组统计
        Map<String, List<Scenario>> grouped = all.stream()
                .collect(Collectors.groupingBy(
                        s -> s.getProfession() != null ? s.getProfession() : "通用"));

        return grouped.entrySet().stream()
                .map(entry -> {
                    ScenarioDTO.ProfessionGroupVO vo = new ScenarioDTO.ProfessionGroupVO();
                    vo.setProfession(entry.getKey());
                    vo.setLabel(entry.getKey());
                    vo.setCount(entry.getValue().size());
                    return vo;
                })
                .sorted(Comparator.comparing(ScenarioDTO.ProfessionGroupVO::getCount).reversed())
                .collect(Collectors.toList());
    }

    /**
     * 按职业列出场景详情
     */
    public List<ScenarioDTO.ScenarioBriefVO> listByProfession(String profession) {
        QueryWrapper<Scenario> qw = new QueryWrapper<Scenario>()
                .eq("is_public", 1)
                .eq("deleted", 0)
                .orderByDesc("is_official")
                .orderByDesc("usage_count");

        if (profession != null && !profession.isEmpty()) {
            qw.eq("profession", profession);
        }

        return scenarioMapper.selectList(qw).stream()
                .map(this::toBriefVO)
                .collect(Collectors.toList());
    }

    /**
     * 搜索场景
     */
    public List<ScenarioDTO.ScenarioBriefVO> search(String keyword) {
        if (keyword == null || keyword.trim().isEmpty()) {
            return listByProfession(null);
        }
        QueryWrapper<Scenario> qw = new QueryWrapper<Scenario>()
                .eq("is_public", 1)
                .eq("deleted", 0)
                .and(w -> w.like("name", keyword).or().like("profession", keyword).or().like("description", keyword))
                .orderByDesc("is_official")
                .orderByDesc("usage_count");

        return scenarioMapper.selectList(qw).stream()
                .map(this::toBriefVO)
                .collect(Collectors.toList());
    }

    /**
     * 获取场景详情
     */
    public ScenarioDTO.ScenarioVO getById(Long id) {
        Scenario s = scenarioMapper.selectById(id);
        if (s == null || Objects.equals(s.getDeleted(), 1)) {
            throw new RuntimeException("场景不存在");
        }
        return toVO(s);
    }

    /**
     * 获取官方场景
     */
    public List<ScenarioDTO.ScenarioBriefVO> listOfficial() {
        return scenarioMapper.selectList(
                new QueryWrapper<Scenario>()
                        .eq("is_official", 1)
                        .eq("is_public", 1)
                        .eq("deleted", 0)
                        .orderByAsc("sort_order")
                        .orderByDesc("usage_count")
        ).stream().map(this::toBriefVO).collect(Collectors.toList());
    }

    /**
     * 获取所有场景（管理员用，不过滤 isPublic）
     */
    public List<ScenarioDTO.ScenarioBriefVO> listAll() {
        return scenarioMapper.selectList(
                new QueryWrapper<Scenario>()
                        .eq("deleted", 0)
                        .orderByDesc("is_official")
                        .orderByAsc("profession")
                        .orderByDesc("usage_count")
        ).stream().map(this::toBriefVO).collect(Collectors.toList());
    }

    /**
     * 获取社区公开场景（用户创建且公开，非官方）
     */
    public List<ScenarioDTO.ScenarioBriefVO> listCommunity() {
        return scenarioMapper.selectList(
                new QueryWrapper<Scenario>()
                        .eq("is_public", 1)
                        .eq("is_official", 0)
                        .eq("deleted", 0)
                        .orderByDesc("usage_count")
        ).stream().map(this::toBriefVO).collect(Collectors.toList());
    }

    /**
     * 获取当前用户创建的场景（我的场景，包含私有的）
     */
    public List<ScenarioDTO.ScenarioBriefVO> listByCreator(Long userId) {
        return scenarioMapper.selectList(
                new QueryWrapper<Scenario>()
                        .eq("creator_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("updated_at")
        ).stream().map(this::toBriefVO).collect(Collectors.toList());
    }

    // =============================================
    // 创建/更新/删除
    // =============================================

    @Transactional
    public ScenarioDTO.ScenarioVO create(ScenarioDTO.ScenarioCreateRequest req, Long userId) {
        // 检查同一职业下是否已存在同名场景
        String profession = req.getProfession() != null ? req.getProfession() : "通用";
        Long count = scenarioMapper.selectCount(
                new QueryWrapper<Scenario>()
                        .eq("name", req.getName())
                        .eq("profession", profession)
                        .eq("deleted", 0));
        if (count > 0) {
            throw new RuntimeException("场景名称「" + req.getName() + "」在「" + profession + "」职业下已存在，请修改名称");
        }

        Scenario s = new Scenario();
        s.setName(req.getName());
        s.setIcon(req.getIcon() != null ? req.getIcon() : "🤖");
        s.setProfession(req.getProfession() != null ? req.getProfession() : "通用");
        s.setDescription(req.getDescription());
        s.setSystemPrompt(req.getSystemPrompt());
        s.setRecommendedSkills(toJson(req.getRecommendedSkills()));
        // 安全：仅管理员可创建官方场景，非管理员强制 isOfficial=0
        s.setIsOfficial(0);
        s.setIsPublic(req.getIsPublic() != null && req.getIsPublic() ? 1 : 0);
        s.setCreatorId(userId);
        s.setUsageCount(0L);
        s.setSortOrder(0);

        scenarioMapper.insert(s);
        bindWorkflowsToScenario(s.getId(), req.getWorkflowIds(), userId);
        log.info("[Scenario] 用户 {} 创建了场景: {} (ID={})", userId, s.getName(), s.getId());
        return toVO(s);
    }

    @Transactional
    public ScenarioDTO.ScenarioVO update(Long id, ScenarioDTO.ScenarioUpdateRequest req, Long userId, boolean isAdmin) {
        Scenario s = scenarioMapper.selectById(id);
        if (s == null || Objects.equals(s.getDeleted(), 1)) {
            throw new RuntimeException("场景不存在");
        }
        // 仅创建者或管理员可修改
        boolean isCreator = Objects.equals(s.getCreatorId(), userId);
        if (!isCreator && !isAdmin) {
            throw new RuntimeException("仅场景创建者或管理员可以修改");
        }

        if (req.getName() != null) s.setName(req.getName());
        if (req.getIcon() != null) s.setIcon(req.getIcon());
        if (req.getProfession() != null) s.setProfession(req.getProfession());
        if (req.getDescription() != null) s.setDescription(req.getDescription());
        if (req.getSystemPrompt() != null) s.setSystemPrompt(req.getSystemPrompt());
        if (req.getRecommendedSkills() != null) s.setRecommendedSkills(toJson(req.getRecommendedSkills()));
        // 安全：仅管理员可变更 isOfficial
        if (req.getIsOfficial() != null && isAdmin) s.setIsOfficial(req.getIsOfficial() ? 1 : 0);
        if (req.getIsPublic() != null) s.setIsPublic(req.getIsPublic() ? 1 : 0);

        // 检查更新后是否与同职业下其他场景重名
        Long dupCount = scenarioMapper.selectCount(
                new QueryWrapper<Scenario>()
                        .eq("name", s.getName())
                        .eq("profession", s.getProfession())
                        .eq("deleted", 0)
                        .ne("id", id));
        if (dupCount > 0) {
            throw new RuntimeException("场景名称「" + s.getName() + "」在「" + s.getProfession() + "」职业下已存在，请修改名称");
        }

        scenarioMapper.updateById(s);
        if (req.getWorkflowIds() != null) {
            bindWorkflowsToScenario(id, req.getWorkflowIds(), userId);
        }
        log.info("[Scenario] 场景 {} (ID={}) 已更新", s.getName(), id);
        return toVO(s);
    }

    @Transactional
    public void delete(Long id, Long userId, boolean isAdmin) {
        Scenario s = scenarioMapper.selectById(id);
        if (s == null || Objects.equals(s.getDeleted(), 1)) {
            throw new RuntimeException("场景不存在");
        }
        if (!Objects.equals(s.getCreatorId(), userId) && !isAdmin) {
            throw new RuntimeException("仅场景创建者或管理员可以删除");
        }
        scenarioMapper.deleteById(id);
        log.info("[Scenario] 场景 {} (ID={}) 已删除", s.getName(), id);
    }

    @Transactional
    public ScenarioDTO.ScenarioVO togglePublic(Long id, Long userId, boolean isAdmin) {
        Scenario s = scenarioMapper.selectById(id);
        if (s == null || Objects.equals(s.getDeleted(), 1)) {
            throw new RuntimeException("场景不存在");
        }
        if (!Objects.equals(s.getCreatorId(), userId) && !isAdmin) {
            throw new RuntimeException("仅场景创建者或管理员可以修改公开状态");
        }
        boolean currentPublic = s.getIsPublic() != null && s.getIsPublic() == 1;
        s.setIsPublic(currentPublic ? 0 : 1);
        scenarioMapper.updateById(s);
        log.info("[Scenario] 场景 {} (ID={}) 公开状态: {} → {}", s.getName(), id, currentPublic, !currentPublic);
        return toVO(s);
    }

    // =============================================
    // 激活 & 使用量
    // =============================================

    /**
     * 激活场景——返回完整配置给前端应用
     */
    public ScenarioDTO.ScenarioActivateResponse activate(Long id) {
        Scenario s = scenarioMapper.selectById(id);
        if (s == null || Objects.equals(s.getDeleted(), 1)) {
            throw new RuntimeException("场景不存在");
        }

        // 增加使用量（失败不影响激活）
        try {
            incrementUsage(id);
        } catch (Exception e) {
            log.warn("[Scenario] 增加使用量失败: {}", e.getMessage());
        }

        ScenarioDTO.ScenarioActivateResponse resp = new ScenarioDTO.ScenarioActivateResponse();
        resp.setScenarioId(s.getId());
        resp.setScenarioName(s.getName());
        resp.setSystemPrompt(s.getSystemPrompt());
        resp.setRecommendedSkills(parseJsonList(s.getRecommendedSkills()));
        resp.setProfession(s.getProfession());

        // P2-2: 填充关联工作流信息
        try {
            List<Workflow> workflows = workflowMapper.selectList(
                    new QueryWrapper<Workflow>()
                            .eq("scenario_id", id)
                            .eq("deleted", 0)
                            .eq("status", "active")
                            .orderByDesc("updated_at"));
            if (workflows != null && !workflows.isEmpty()) {
                resp.setWorkflowCount(workflows.size());
                resp.setWorkflowTemplates(workflows.stream()
                        .limit(5)
                        .map(w -> {
                            WorkflowDTO.WorkflowTemplateBrief brief = new WorkflowDTO.WorkflowTemplateBrief();
                            brief.setId(w.getId());
                            brief.setName(w.getName());
                            brief.setDescription(w.getDescription());
                            brief.setStatus(w.getStatus());
                            return brief;
                        })
                        .collect(Collectors.toList()));
            } else {
                resp.setWorkflowCount(0);
                resp.setWorkflowTemplates(new ArrayList<>());
            }
        } catch (Exception e) {
            log.warn("[Scenario] activate 查询关联工作流失败: id={}, error={}", id, e.getMessage());
            resp.setWorkflowCount(0);
            resp.setWorkflowTemplates(new ArrayList<>());
        }

        return resp;
    }

    @Transactional
    public void incrementUsage(Long id) {
        Scenario s = scenarioMapper.selectById(id);
        if (s != null) {
            s.setUsageCount((s.getUsageCount() != null ? s.getUsageCount() : 0) + 1);
            scenarioMapper.updateById(s);
        }
    }

    private void bindWorkflowsToScenario(Long scenarioId, List<Long> workflowIds, Long userId) {
        workflowMapper.update(
                null,
                new com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper<Workflow>()
                        .eq("scenario_id", scenarioId)
                        .eq("user_id", userId)
                        .set("scenario_id", null)
        );
        if (workflowIds == null || workflowIds.isEmpty()) {
            return;
        }
        List<Long> ids = workflowIds.stream()
                .filter(Objects::nonNull)
                .distinct()
                .collect(Collectors.toList());
        if (ids.isEmpty()) {
            return;
        }
        List<Workflow> workflows = workflowMapper.selectList(
                new QueryWrapper<Workflow>()
                        .in("id", ids)
                        .eq("user_id", userId)
                        .eq("deleted", 0));
        for (Workflow workflow : workflows) {
            workflow.setScenarioId(scenarioId);
            workflowMapper.updateById(workflow);
        }
    }

    // =============================================
    // 转换方法
    // =============================================

    private ScenarioDTO.ScenarioVO toVO(Scenario s) {
        ScenarioDTO.ScenarioVO vo = new ScenarioDTO.ScenarioVO();
        vo.setId(s.getId());
        vo.setName(s.getName());
        vo.setIcon(s.getIcon());
        vo.setProfession(s.getProfession());
        vo.setDescription(s.getDescription());
        vo.setSystemPrompt(s.getSystemPrompt());
        vo.setRecommendedSkills(parseJsonList(s.getRecommendedSkills()));
        // Integer → Boolean
        vo.setIsOfficial(s.getIsOfficial() != null && s.getIsOfficial() == 1);
        vo.setIsPublic(s.getIsPublic() != null && s.getIsPublic() == 1);
        vo.setCreatorId(s.getCreatorId());
        vo.setUsageCount(s.getUsageCount());
        vo.setSortOrder(s.getSortOrder());
        vo.setCreatedAt(s.getCreatedAt() != null ? s.getCreatedAt().format(FMT) : null);
        vo.setUpdatedAt(s.getUpdatedAt() != null ? s.getUpdatedAt().format(FMT) : null);

        // P2-2: 填充关联工作流信息
        fillWorkflowInfo(s.getId(), vo);

        return vo;
    }

    /**
     * 填充场景关联的工作流信息到 VO（P2-2）
     * 查询该场景关联的工作流，最多取前 5 个模板
     */
    private void fillWorkflowInfo(Long scenarioId, ScenarioDTO.ScenarioVO vo) {
        try {
            List<Workflow> workflows = workflowMapper.selectList(
                    new QueryWrapper<Workflow>()
                            .eq("scenario_id", scenarioId)
                            .eq("deleted", 0)
                            .orderByDesc("updated_at"));
            if (workflows != null && !workflows.isEmpty()) {
                vo.setWorkflowCount(workflows.size());
                vo.setWorkflowTemplates(workflows.stream()
                        .limit(5)
                        .map(w -> {
                            WorkflowDTO.WorkflowTemplateBrief brief = new WorkflowDTO.WorkflowTemplateBrief();
                            brief.setId(w.getId());
                            brief.setName(w.getName());
                            brief.setDescription(w.getDescription());
                            brief.setStatus(w.getStatus());
                            return brief;
                        })
                        .collect(Collectors.toList()));
            } else {
                vo.setWorkflowCount(0);
                vo.setWorkflowTemplates(new ArrayList<>());
            }
        } catch (Exception e) {
            log.warn("[Scenario] 查询关联工作流失败: scenarioId={}, error={}", scenarioId, e.getMessage());
            vo.setWorkflowCount(0);
            vo.setWorkflowTemplates(new ArrayList<>());
        }
    }

    private ScenarioDTO.ScenarioBriefVO toBriefVO(Scenario s) {
        ScenarioDTO.ScenarioBriefVO vo = new ScenarioDTO.ScenarioBriefVO();
        vo.setId(s.getId());
        vo.setName(s.getName());
        vo.setIcon(s.getIcon());
        vo.setProfession(s.getProfession());
        vo.setDescription(s.getDescription());
        // Integer → Boolean
        vo.setIsOfficial(s.getIsOfficial() != null && s.getIsOfficial() == 1);
        vo.setIsPublic(s.getIsPublic() != null && s.getIsPublic() == 1);
        vo.setUsageCount(s.getUsageCount());
        return vo;
    }

    private String toJson(List<String> list) {
        if (list == null || list.isEmpty()) return null;
        try {
            return objectMapper.writeValueAsString(list);
        } catch (JsonProcessingException e) {
            log.warn("[Scenario] JSON 序列化失败: {}", e.getMessage());
            return null;
        }
    }

    private List<String> parseJsonList(String json) {
        if (json == null || json.trim().isEmpty()) return new ArrayList<>();
        try {
            return objectMapper.readValue(json, objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
        } catch (Exception e) {
            log.warn("[Scenario] JSON 反序列化失败: {} -> {}", json, e.getMessage());
            return new ArrayList<>();
        }
    }
}
