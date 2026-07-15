package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.WorkflowDTO;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.entity.MemoryDocument;
import com.aiplatform.backend.entity.MemoryWorkFile;
import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.entity.WorkflowArtifact;
import com.aiplatform.backend.entity.WorkflowExecutionCheckpoint;
import com.aiplatform.backend.entity.WorkflowExecutionEvent;
import com.aiplatform.backend.entity.WorkflowExecutionStep;
import com.aiplatform.backend.entity.WorkflowExecution;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.mapper.MemoryDocumentMapper;
import com.aiplatform.backend.mapper.MemoryWorkFileMapper;
import com.aiplatform.backend.mapper.WorkflowArtifactMapper;
import com.aiplatform.backend.mapper.WorkflowExecutionCheckpointMapper;
import com.aiplatform.backend.mapper.WorkflowExecutionEventMapper;
import com.aiplatform.backend.mapper.WorkflowExecutionMapper;
import com.aiplatform.backend.mapper.WorkflowExecutionStepMapper;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 工作流引擎核心服务（战略改造 v2.0 P2-1）
 * <p>
 * 工作流是用户创建的可自动化执行的任务编排单元。
 * 支持自然语言创建（AI 解析生成 DSL）、CRUD 管理、手动/定时触发执行。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkflowService {

    private final WorkflowMapper workflowMapper;
    private final WorkflowExecutionMapper executionMapper;
    private final MemoryService memoryService;
    private final MemoryDocumentMapper memoryDocumentMapper;
    private final MemoryWorkFileMapper memoryWorkFileMapper;
    private final ChatConversationMapper chatConversationMapper;
    private final WorkflowArtifactMapper workflowArtifactMapper;
    private final WorkflowExecutionStepMapper executionStepMapper;
    private final WorkflowExecutionCheckpointMapper executionCheckpointMapper;
    private final WorkflowExecutionEventMapper executionEventMapper;
    private final WorkflowParser workflowParser;
    private final WorkflowExecutionEventBus workflowExecutionEventBus;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    // =============================================
    // 工作流 CRUD
    // =============================================

    /**
     * 获取用户的所有工作流
     */
    public List<WorkflowDTO.WorkflowBriefVO> listByUser(Long userId) {
        return workflowMapper.selectList(
                new QueryWrapper<Workflow>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("created_at")
        ).stream().map(this::toBriefVO).collect(Collectors.toList());
    }

    /**
     * 获取工作流详情
     */
    public WorkflowDTO.WorkflowVO getById(Long id, Long userId) {
        Workflow w = workflowMapper.selectOne(
                new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
        if (w == null) {
            throw new RuntimeException("工作流不存在");
        }
        if (!Objects.equals(w.getUserId(), userId)) {
            throw new RuntimeException("无权访问此工作流");
        }
        return toVO(w);
    }

    /**
     * 创建工作流
     */
    @Transactional
    public WorkflowDTO.WorkflowVO create(WorkflowDTO.WorkflowCreateRequest req, Long userId) {
        Workflow w = new Workflow();
        w.setUserId(userId);
        w.setName(req.getName() != null ? req.getName() : "未命名工作流");
        w.setDescription(req.getDescription());
        w.setDsl(req.getDsl());
        w.setCronExpr(req.getCronExpr());
        w.setScenarioId(req.getScenarioId());
        w.setStatus("paused");

        // 同步 cronExpr 与 DSL trigger.value（确保两者一致）
        syncCronAndDsl(w, req.getCronExpr());

        workflowMapper.insert(w);
        log.info("[Workflow] 用户 {} 创建工作流: {} (ID={})", userId, w.getName(), w.getId());
        return toVO(w);
    }

    /**
     * 更新工作流
     */
    @Transactional
    public WorkflowDTO.WorkflowVO update(Long id, WorkflowDTO.WorkflowUpdateRequest req, Long userId) {
        Workflow w = workflowMapper.selectOne(
                new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
        if (w == null) {
            throw new RuntimeException("工作流不存在");
        }
        if (!Objects.equals(w.getUserId(), userId)) {
            throw new RuntimeException("无权修改此工作流");
        }

        if (req.getName() != null) w.setName(req.getName());
        if (req.getDescription() != null) w.setDescription(req.getDescription());
        if (req.getDsl() != null) w.setDsl(req.getDsl());
        if (req.getCronExpr() != null) w.setCronExpr(req.getCronExpr());
        if (req.getScenarioId() != null) w.setScenarioId(req.getScenarioId());

        // 同步 cronExpr 与 DSL trigger.value（确保两者一致）
        syncCronAndDsl(w, req.getCronExpr());

        workflowMapper.updateById(w);
        log.info("[Workflow] 工作流 {} (ID={}) 已更新", w.getName(), id);
        return toVO(w);
    }

    /**
     * 更新工作流状态（激活/暂停）
     */
    @Transactional
    public void updateStatus(Long id, String status, Long userId) {
        Workflow w = workflowMapper.selectOne(
                new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
        if (w == null) {
            throw new RuntimeException("工作流不存在");
        }
        if (!Objects.equals(w.getUserId(), userId)) {
            throw new RuntimeException("无权修改此工作流");
        }
        if (!List.of("paused", "active").contains(status)) {
            throw new RuntimeException("无效的状态值: " + status);
        }

        UpdateWrapper<Workflow> uw = new UpdateWrapper<>();
        uw.eq("id", id).set("status", status);
        workflowMapper.update(null, uw);
        log.info("[Workflow] 工作流 {} (ID={}) 状态 → {}", w.getName(), id, status);
    }

    /**
     * 删除工作流
     */
    @Transactional
    public void delete(Long id, Long userId) {
        Workflow w = workflowMapper.selectOne(
                new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
        if (w == null) {
            throw new RuntimeException("工作流不存在");
        }
        if (!Objects.equals(w.getUserId(), userId)) {
            throw new RuntimeException("无权删除此工作流");
        }
        workflowMapper.deleteById(id);
        log.info("[Workflow] 工作流 {} (ID={}) 已删除", w.getName(), id);
    }

    private Map<String, Object> extractExecutionContext(String inputJson) {
        if (inputJson == null || inputJson.isBlank()) return Map.of();
        try {
            Map<String, Object> input = objectMapper.readValue(inputJson, new TypeReference<Map<String, Object>>() {});
            Object raw = input.get("_scenarioContext");
            if (raw instanceof Map<?, ?> rawMap) {
                Map<String, Object> result = new LinkedHashMap<>();
                rawMap.forEach((k, v) -> {
                    if (k != null) result.put(String.valueOf(k), v);
                });
                return result;
            }
        } catch (Exception e) {
            log.debug("[Workflow] 解析执行上下文失败: {}", e.getMessage());
        }
        return Map.of();
    }

    private Long resolveConversationId(Long userId, String conversationUuid) {
        if (conversationUuid == null || conversationUuid.isBlank()) return null;
        ChatConversation conv = chatConversationMapper.selectOne(
                new QueryWrapper<ChatConversation>()
                        .eq("uuid", conversationUuid)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        return conv != null ? conv.getId() : null;
    }

    private void saveExecutionWorkFile(WorkflowExecution exec, MemoryDocument doc, String workflowName,
                                       Long conversationId, String content, Long scenarioId) {
        MemoryWorkFile file = new MemoryWorkFile();
        file.setUuid(UUID.randomUUID().toString());
        file.setUserId(exec.getUserId());
        file.setConversationId(conversationId);
        file.setDocId(doc.getId());
        file.setFileName("workflow-" + sanitizeFileName(workflowName) + "-" + exec.getId() + ".md");
        file.setFileType("document");
        file.setFileSize((long) content.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        file.setMimeType("text/markdown");
        file.setDescription("工作流执行结果：" + workflowName);
        file.setTags(buildExecutionTags(exec, scenarioId));
        memoryWorkFileMapper.insert(file);
    }

    private List<WorkflowExecutionStep> listStepEntities(Long executionId) {
        return executionStepMapper.selectList(
                new QueryWrapper<WorkflowExecutionStep>()
                        .eq("execution_id", executionId)
                        .orderByAsc("started_at")
                        .orderByAsc("id"));
    }

    private List<WorkflowExecutionEvent> listEventEntities(Long executionId) {
        return executionEventMapper.selectList(
                new QueryWrapper<WorkflowExecutionEvent>()
                        .eq("execution_id", executionId)
                        .orderByAsc("created_at")
                        .orderByAsc("id"));
    }

    private List<WorkflowArtifact> listExecutionArtifacts(WorkflowExecution exec) {
        return workflowArtifactMapper.selectList(
                new QueryWrapper<WorkflowArtifact>()
                        .eq("user_id", exec.getUserId())
                        .eq("execution_id", exec.getId())
                        .eq("deleted", 0)
                        .orderByAsc("created_at")
                        .orderByAsc("id"));
    }

    private void appendExecutionSteps(StringBuilder content, List<WorkflowExecutionStep> steps) {
        if (steps == null || steps.isEmpty()) return;
        content.append("\n## 步骤轨迹\n\n");
        for (WorkflowExecutionStep step : steps) {
            content.append("- `").append(step.getStepId()).append("` ");
            if (step.getStepName() != null && !step.getStepName().isBlank()) {
                content.append(step.getStepName()).append(" ");
            }
            content.append("[").append(step.getStatus()).append("]");
            if (step.getToolName() != null && !step.getToolName().isBlank()) {
                content.append(" tool=").append(step.getToolName());
            }
            if (step.getDurationMs() != null) {
                content.append(" duration=").append(step.getDurationMs()).append("ms");
            }
            if (step.getErrorMsg() != null && !step.getErrorMsg().isBlank()) {
                content.append(" error=").append(truncate(step.getErrorMsg(), 180));
            }
            content.append("\n");
            if (step.getOutputJson() != null && !step.getOutputJson().isBlank()) {
                content.append("  - output: `").append(escapeInline(truncate(step.getOutputJson(), 240))).append("`\n");
            }
        }
    }

    private void appendExecutionEvents(StringBuilder content, List<WorkflowExecutionEvent> events) {
        if (events == null || events.isEmpty()) return;
        content.append("\n## 执行事件\n\n");
        for (WorkflowExecutionEvent event : events) {
            content.append("- ");
            if (event.getCreatedAt() != null) {
                content.append(event.getCreatedAt().format(FMT)).append(" ");
            }
            content.append("`").append(event.getEventType()).append("`");
            if (event.getStepId() != null && !event.getStepId().isBlank()) {
                content.append(" step=").append(event.getStepId());
            }
            if (event.getMessage() != null && !event.getMessage().isBlank()) {
                content.append(" - ").append(truncate(event.getMessage(), 180));
            }
            content.append("\n");
        }
    }

    private void appendExecutionArtifacts(StringBuilder content, List<WorkflowArtifact> artifacts) {
        if (artifacts == null || artifacts.isEmpty()) return;
        content.append("\n## 关联产物\n\n");
        for (WorkflowArtifact artifact : artifacts) {
            content.append("- `").append(artifact.getUuid()).append("` ")
                    .append(artifact.getFileName() != null ? artifact.getFileName() : "unnamed")
                    .append(" (").append(artifact.getFileType() != null ? artifact.getFileType() : "unknown")
                    .append(", ").append(artifact.getFileSize() != null ? artifact.getFileSize() : 0).append(" bytes)");
            if (artifact.getStepId() != null && !artifact.getStepId().isBlank()) {
                content.append(" step=").append(artifact.getStepId());
            }
            if (artifact.getOssUrl() != null && !artifact.getOssUrl().isBlank()) {
                content.append(" url=").append(artifact.getOssUrl());
            }
            content.append("\n");
            if (artifact.getContentText() != null && !artifact.getContentText().isBlank()) {
                content.append("  - text: ").append(truncate(artifact.getContentText(), 240)).append("\n");
            }
        }
    }

    private void upsertWorkflowWorkIndex(Long userId, Long conversationId, String sourceConvUuid,
                                         WorkflowExecution exec, String workflowName,
                                         List<WorkflowArtifact> artifacts) {
        if (conversationId == null) return;
        MemoryDocument doc = memoryDocumentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("conversation_id", conversationId)
                        .eq("title", "WORK.md")
                        .eq("deleted", 0)
                        .last("LIMIT 1"));

        String marker = "workflow-exec:" + exec.getId();
        String current = doc != null && doc.getContent() != null ? doc.getContent().trim() : "";
        if (current.contains(marker)) return;

        StringBuilder entry = new StringBuilder();
        if (!current.isBlank()) {
            entry.append(current).append("\n\n");
        }
        entry.append("## Workflow Execution ").append(exec.getId()).append("\n");
        entry.append("- marker: ").append(marker).append("\n");
        entry.append("- workflow: ").append(workflowName).append("\n");
        entry.append("- status: ").append(exec.getStatus()).append("\n");
        entry.append("- finishedAt: ").append(exec.getFinishedAt() != null ? exec.getFinishedAt().format(FMT) : "N/A").append("\n");
        if (artifacts != null && !artifacts.isEmpty()) {
            entry.append("- artifacts:\n");
            for (WorkflowArtifact artifact : artifacts) {
                entry.append("  - ").append(artifact.getFileName() != null ? artifact.getFileName() : artifact.getUuid())
                        .append(" [").append(artifact.getFileType() != null ? artifact.getFileType() : "unknown").append("]");
                if (artifact.getUuid() != null) {
                    entry.append(" artifactUuid=").append(artifact.getUuid());
                }
                if (artifact.getOssUrl() != null && !artifact.getOssUrl().isBlank()) {
                    entry.append(" url=").append(artifact.getOssUrl());
                }
                entry.append("\n");
            }
        }

        if (doc == null) {
            doc = new MemoryDocument();
            doc.setUuid(UUID.randomUUID().toString());
            doc.setUserId(userId);
            doc.setConversationId(conversationId);
            doc.setDocType("work_index");
            doc.setTitle("WORK.md");
            doc.setCategory("work");
            doc.setTags("work,workflow");
            doc.setImportance(3);
            doc.setStatus("active");
            doc.setSourceConvUuid(sourceConvUuid);
            doc.setContent(entry.toString());
            memoryDocumentMapper.insert(doc);
        } else {
            doc.setContent(entry.toString());
            doc.setDocType(doc.getDocType() != null ? doc.getDocType() : "work_index");
            doc.setCategory(doc.getCategory() != null ? doc.getCategory() : "work");
            memoryDocumentMapper.updateById(doc);
        }
    }

    private String truncate(String value, int maxLen) {
        if (value == null || value.length() <= maxLen) return value;
        return value.substring(0, maxLen) + "...";
    }

    private String escapeInline(String value) {
        return value == null ? "" : value.replace("`", "'");
    }

    private String buildExecutionTags(WorkflowExecution exec, Long scenarioId) {
        StringBuilder tags = new StringBuilder("workflow,workflow_result,")
                .append(exec.getStatus() != null ? exec.getStatus() : "unknown");
        if (scenarioId != null) {
            tags.append(",scenario:").append(scenarioId);
        }
        return tags.toString();
    }

    private String sanitizeFileName(String name) {
        if (name == null || name.isBlank()) return "workflow";
        return name.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
    }

    private String asString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private Long asLong(Object value) {
        if (value instanceof Number number) return number.longValue();
        if (value == null) return null;
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // =============================================
    // 执行相关
    // =============================================

    /**
     * 创建执行记录
     */
    @Transactional
    public WorkflowExecution createExecution(Long workflowId, Long userId, String triggerType, String inputJson) {
        WorkflowExecution exec = new WorkflowExecution();
        exec.setWorkflowId(workflowId);
        exec.setUserId(userId);
        exec.setStatus("running");
        exec.setTriggerType(triggerType != null ? triggerType : "manual");
        exec.setInputJson(inputJson);
        exec.setStartedAt(LocalDateTime.now());

        executionMapper.insert(exec);
        recordExecutionEvent(exec.getId(), null, "workflow_started",
                "工作流执行已开始", Map.of("workflowId", workflowId, "triggerType", exec.getTriggerType()));
        return exec;
    }

    /**
     * 完成执行记录
     */
    @Transactional
    public void completeExecution(Long executionId, boolean success, String outputJson, String stepResults, String errorMsg) {
        WorkflowExecution exec = executionMapper.selectById(executionId);
        if (exec == null) return;

        exec.setStatus(success ? "success" : "failed");
        exec.setOutputJson(outputJson);
        exec.setStepResults(stepResults);
        exec.setErrorMsg(errorMsg);
        exec.setFinishedAt(LocalDateTime.now());
        if (exec.getStartedAt() != null) {
            exec.setDurationMs((int) java.time.Duration.between(exec.getStartedAt(), exec.getFinishedAt()).toMillis());
        }
        executionMapper.updateById(exec);
        recordExecutionEvent(executionId, null, success ? "workflow_completed" : "workflow_failed",
                success ? "工作流执行完成" : "工作流执行失败",
                Map.of("workflowId", exec.getWorkflowId(), "status", exec.getStatus()));

        // P2-2: 工作流执行完成后自动写入记忆系统
        try {
            saveExecutionMemoryV2(exec);
        } catch (Exception e) {
            log.warn("[Workflow] 写入执行记忆失败（不影响主流程）: {}", e.getMessage());
        }
    }

    /**
     * 记录步骤开始。用于 P1-2 step/event 执行轨迹，不影响旧 step_results。
     */
    @Transactional
    public WorkflowExecutionStep startExecutionStep(Long executionId, Long workflowId,
                                                    WorkflowParser.ParsedStep step,
                                                    Map<String, Object> input) {
        WorkflowExecutionStep record = new WorkflowExecutionStep();
        record.setExecutionId(executionId);
        record.setWorkflowId(workflowId);
        record.setStepId(step.getId());
        record.setStepName(step.getDescription());
        record.setToolName(step.getTool());
        record.setStatus("running");
        record.setInputJson(toJsonString(input));
        record.setStartedAt(LocalDateTime.now());
        executionStepMapper.insert(record);

        recordExecutionEvent(executionId, step.getId(), "step_started",
                "步骤开始：" + readableStepName(step),
                Map.of("tool", step.getTool() != null ? step.getTool() : ""));
        return record;
    }

    /**
     * 完成步骤记录。status: completed / skipped / failed / cancelled。
     */
    @Transactional
    public void finishExecutionStep(Long stepRecordId, String status, Object output,
                                    String errorMsg, Integer durationMs) {
        finishExecutionStep(stepRecordId, status, null, output, errorMsg, durationMs);
    }

    @Transactional
    public void finishExecutionStep(Long stepRecordId, String status, Object input, Object output,
                                    String errorMsg, Integer durationMs) {
        if (stepRecordId == null) return;
        WorkflowExecutionStep record = executionStepMapper.selectById(stepRecordId);
        if (record == null) return;

        record.setStatus(status);
        if (input != null) {
            record.setInputJson(toJsonString(input));
        }
        record.setOutputJson(toJsonString(output));
        record.setErrorMsg(errorMsg);
        record.setFinishedAt(LocalDateTime.now());
        record.setDurationMs(durationMs != null ? durationMs : calculateDuration(record.getStartedAt(), record.getFinishedAt()));
        executionStepMapper.updateById(record);
        upsertExecutionCheckpoint(record);

        String eventType = switch (status) {
            case "completed" -> "step_completed";
            case "skipped" -> "step_skipped";
            case "cancelled" -> "step_cancelled";
            default -> "step_failed";
        };
        recordExecutionEvent(record.getExecutionId(), record.getStepId(), eventType,
                "步骤" + statusLabel(status) + "：" + (record.getStepName() != null ? record.getStepName() : record.getStepId()),
                Map.of("tool", record.getToolName() != null ? record.getToolName() : "", "status", status));
    }

    @Transactional
    public void recordExecutionEvent(Long executionId, String stepId, String eventType,
                                     String message, Object payload) {
        try {
            WorkflowExecutionEvent event = new WorkflowExecutionEvent();
            event.setExecutionId(executionId);
            event.setStepId(stepId);
            event.setEventType(eventType);
            event.setMessage(message);
            event.setPayloadJson(toJsonString(payload));
            executionEventMapper.insert(event);
            workflowExecutionEventBus.publish(toEventVO(event));
        } catch (Exception e) {
            log.warn("[Workflow] 写入执行事件失败 executionId={}, eventType={}, error={}",
                    executionId, eventType, e.getMessage());
        }
    }

    /**
     * 更新工作流最后执行时间
     */
    @Transactional
    public void updateLastRun(Long workflowId) {
        UpdateWrapper<Workflow> uw = new UpdateWrapper<>();
        uw.eq("id", workflowId).set("last_run_at", LocalDateTime.now());
        workflowMapper.update(null, uw);
    }

    /**
     * 获取工作流执行历史
     */
    public List<WorkflowDTO.ExecutionBriefVO> listExecutions(Long workflowId, int limit) {
        return executionMapper.selectList(
                new QueryWrapper<WorkflowExecution>()
                        .eq("workflow_id", workflowId)
                        .orderByDesc("started_at")
                        .last("LIMIT " + Math.min(limit, 100))
        ).stream().map(this::toExecBriefVO).collect(Collectors.toList());
    }

    /**
     * 获取当前用户所有运行中的执行记录
     */
    public List<WorkflowDTO.ExecutionBriefVO> listRunningExecutions(Long userId) {
        return executionMapper.selectList(
                new QueryWrapper<WorkflowExecution>()
                        .eq("user_id", userId)
                        .eq("status", "running")
                        .orderByDesc("started_at")
        ).stream().map(this::toExecBriefVO).collect(Collectors.toList());
    }

    /**
     * 清理僵尸 running 记录（后端重启后遗留）
     */
    @Transactional
    public int cleanupZombieExecutions(int maxAgeMinutes) {
        LocalDateTime cutoff = LocalDateTime.now().minusMinutes(maxAgeMinutes);
        List<WorkflowExecution> zombies = executionMapper.selectList(
                new QueryWrapper<WorkflowExecution>()
                        .eq("status", "running")
                        .lt("started_at", cutoff)
        );
        if (zombies.isEmpty()) {
            return 0;
        }
        for (WorkflowExecution exec : zombies) {
            exec.setStatus("failed");
            exec.setFinishedAt(LocalDateTime.now());
            exec.setOutputJson("{\"status\":\"failed\",\"message\":\"服务重启导致任务中断\"}");
            if (exec.getStartedAt() != null) {
                exec.setDurationMs((int) Duration.between(exec.getStartedAt(), exec.getFinishedAt()).toMillis());
            }
            executionMapper.updateById(exec);
        }
        return zombies.size();
    }

    /**
     * 获取执行详情（VO 版本，Controller 用）
     */
    public WorkflowDTO.ExecutionVO getExecution(Long executionId) {
        WorkflowExecution exec = executionMapper.selectById(executionId);
        if (exec == null) {
            throw new RuntimeException("执行记录不存在");
        }
        WorkflowDTO.ExecutionVO vo = toExecVO(exec);
        vo.setSteps(listExecutionSteps(executionId));
        vo.setEvents(listExecutionEvents(executionId));
        return vo;
    }

    /**
     * 获取执行记录实体（内部使用，不走异常）
     */
    public WorkflowExecution getExecutionEntity(Long executionId) {
        return executionMapper.selectById(executionId);
    }

    public List<WorkflowExecutionStep> listExecutionStepEntities(Long executionId) {
        return executionStepMapper.selectList(
                new QueryWrapper<WorkflowExecutionStep>()
                        .eq("execution_id", executionId)
                        .orderByAsc("started_at")
                        .orderByAsc("id"));
    }

    public Map<String, Object> collectCompletedStepOutputsBefore(Long executionId, String fromStepId) {
        Map<String, Object> checkpointOutputs = collectCompletedCheckpointOutputsBefore(executionId, fromStepId);
        if (!checkpointOutputs.isEmpty()) {
            return checkpointOutputs;
        }
        Map<String, Object> outputs = new LinkedHashMap<>();
        for (WorkflowExecutionStep step : listExecutionStepEntities(executionId)) {
            if (fromStepId != null && fromStepId.equals(step.getStepId())) {
                break;
            }
            if (!"completed".equals(step.getStatus())) {
                continue;
            }
            outputs.put(step.getStepId(), parseJsonValue(step.getOutputJson()));
        }
        return outputs;
    }

    private void upsertExecutionCheckpoint(WorkflowExecutionStep step) {
        if (step == null || step.getExecutionId() == null || step.getStepId() == null) {
            return;
        }
        try {
            WorkflowExecutionCheckpoint checkpoint = executionCheckpointMapper.selectOne(
                    new QueryWrapper<WorkflowExecutionCheckpoint>()
                            .eq("execution_id", step.getExecutionId())
                            .eq("step_id", step.getStepId())
                            .eq("deleted", 0)
                            .last("LIMIT 1"));
            boolean insert = checkpoint == null;
            if (insert) {
                checkpoint = new WorkflowExecutionCheckpoint();
                checkpoint.setExecutionId(step.getExecutionId());
                checkpoint.setWorkflowId(step.getWorkflowId());
                checkpoint.setStepId(step.getStepId());
            }
            checkpoint.setWorkflowId(step.getWorkflowId());
            checkpoint.setStepRecordId(step.getId());
            checkpoint.setStatus(step.getStatus());
            checkpoint.setInputJson(step.getInputJson());
            checkpoint.setOutputJson(step.getOutputJson());
            checkpoint.setErrorMsg(step.getErrorMsg());
            checkpoint.setDurationMs(step.getDurationMs());
            checkpoint.setCompletedAt(step.getFinishedAt() != null ? step.getFinishedAt() : LocalDateTime.now());
            if (insert) {
                executionCheckpointMapper.insert(checkpoint);
            } else {
                executionCheckpointMapper.updateById(checkpoint);
            }
        } catch (Exception e) {
            log.warn("[Workflow] 写入 checkpoint 失败 executionId={}, stepId={}, error={}",
                    step.getExecutionId(), step.getStepId(), e.getMessage());
        }
    }

    private Map<String, Object> collectCompletedCheckpointOutputsBefore(Long executionId, String fromStepId) {
        Map<String, Object> outputs = new LinkedHashMap<>();
        try {
            List<WorkflowExecutionCheckpoint> checkpoints = executionCheckpointMapper.selectList(
                    new QueryWrapper<WorkflowExecutionCheckpoint>()
                            .eq("execution_id", executionId)
                            .eq("deleted", 0)
                            .orderByAsc("completed_at")
                            .orderByAsc("id"));
            for (WorkflowExecutionCheckpoint checkpoint : checkpoints) {
                if (fromStepId != null && fromStepId.equals(checkpoint.getStepId())) {
                    break;
                }
                if (!"completed".equals(checkpoint.getStatus())) {
                    continue;
                }
                outputs.put(checkpoint.getStepId(), parseJsonValue(checkpoint.getOutputJson()));
            }
        } catch (Exception e) {
            log.warn("[Workflow] 读取 checkpoint 失败，回退到 step 输出 executionId={}, error={}",
                    executionId, e.getMessage());
        }
        return outputs;
    }

    public String findFirstFailedOrCancelledStepId(Long executionId) {
        for (WorkflowExecutionStep step : listExecutionStepEntities(executionId)) {
            if ("failed".equals(step.getStatus()) || "cancelled".equals(step.getStatus())) {
                return step.getStepId();
            }
        }
        return null;
    }

    /**
     * 强制停止执行
     */
    @Transactional
    public void stopExecution(Long executionId, Long userId) {
        WorkflowExecution exec = executionMapper.selectById(executionId);
        if (exec == null) {
            throw new RuntimeException("执行记录不存在");
        }
        if (!Objects.equals(exec.getUserId(), userId)) {
            throw new RuntimeException("无权操作此执行记录");
        }
        if (!"running".equals(exec.getStatus())) {
            throw new RuntimeException("执行已结束，无法停止");
        }

        exec.setStatus("cancelled");
        exec.setOutputJson("{\"status\":\"cancelled\",\"message\":\"用户手动停止\"}");
        exec.setFinishedAt(LocalDateTime.now());
        if (exec.getStartedAt() != null) {
            exec.setDurationMs((int) java.time.Duration.between(exec.getStartedAt(), exec.getFinishedAt()).toMillis());
        }
        executionMapper.updateById(exec);
        List<WorkflowExecutionStep> runningSteps = executionStepMapper.selectList(
                new QueryWrapper<WorkflowExecutionStep>()
                        .eq("execution_id", executionId)
                        .eq("status", "running"));
        for (WorkflowExecutionStep step : runningSteps) {
            finishExecutionStep(step.getId(), "cancelled", null, "用户手动停止", null);
        }
        recordExecutionEvent(executionId, null, "workflow_cancelled",
                "工作流已被用户手动停止", Map.of("workflowId", exec.getWorkflowId()));
        log.info("[Workflow] 执行 {} 已被用户手动停止", executionId);
    }

    // =============================================
    // 记忆集成 (P2-2)
    // =============================================

    /**
     * 将工作流执行结果写入记忆系统
     * 生成一个 memory_document（doc_type=workflow_result），记录执行摘要
     */
    private void saveExecutionMemoryV2(WorkflowExecution exec) {
        Workflow wf = workflowMapper.selectById(exec.getWorkflowId());
        String wfName = wf != null ? wf.getName() : "未知工作流";
        Map<String, Object> executionContext = extractExecutionContext(exec.getInputJson());
        String sourceConvUuid = asString(executionContext.get("conversationUuid"));
        Long scenarioId = asLong(executionContext.get("scenarioId"));
        String scenarioName = asString(executionContext.get("scenarioName"));
        Long conversationId = resolveConversationId(exec.getUserId(), sourceConvUuid);

        List<WorkflowExecutionStep> steps = listStepEntities(exec.getId());
        List<WorkflowExecutionEvent> events = listEventEntities(exec.getId());
        List<WorkflowArtifact> artifacts = listExecutionArtifacts(exec);

        StringBuilder content = new StringBuilder();
        content.append("# 工作流执行记录：").append(wfName).append("\n\n");
        content.append("- **Execution ID**: ").append(exec.getId()).append("\n");
        content.append("- **Workflow ID**: ").append(exec.getWorkflowId()).append("\n");
        if (scenarioId != null) {
            content.append("- **场景 ID**: ").append(scenarioId).append("\n");
        }
        if (scenarioName != null && !scenarioName.isBlank()) {
            content.append("- **场景**: ").append(scenarioName).append("\n");
        }
        content.append("- **状态**: ").append(exec.getStatus()).append("\n");
        content.append("- **触发方式**: ").append(exec.getTriggerType()).append("\n");
        content.append("- **开始时间**: ").append(exec.getStartedAt() != null ? exec.getStartedAt().format(FMT) : "N/A").append("\n");
        content.append("- **完成时间**: ").append(exec.getFinishedAt() != null ? exec.getFinishedAt().format(FMT) : "N/A").append("\n");
        content.append("- **耗时**: ").append(exec.getDurationMs()).append("ms\n");

        appendExecutionSteps(content, steps);
        appendExecutionEvents(content, events);
        appendExecutionArtifacts(content, artifacts);

        if (exec.getStepResults() != null && !exec.getStepResults().isBlank()) {
            content.append("\n## 步骤结果快照\n\n```json\n");
            content.append(truncate(exec.getStepResults(), 4000)).append("\n```\n");
        }

        if (exec.getErrorMsg() != null && !exec.getErrorMsg().isBlank()) {
            content.append("\n## 错误信息\n\n").append(exec.getErrorMsg()).append("\n");
        }

        if (exec.getOutputJson() != null && !exec.getOutputJson().isBlank()) {
            content.append("\n## 执行输出\n\n```json\n")
                    .append(truncate(exec.getOutputJson(), 5000))
                    .append("\n```\n");
        }

        MemoryDocument doc = new MemoryDocument();
        doc.setUuid(UUID.randomUUID().toString());
        doc.setUserId(exec.getUserId());
        doc.setConversationId(conversationId);
        doc.setDocType("workflow_result");
        doc.setTitle("工作流执行 " + wfName + " #" + exec.getId() + " (" + exec.getStatus() + ")");
        doc.setContent(content.toString());
        doc.setCategory("workflow_execution");
        doc.setTags(buildExecutionTags(exec, scenarioId));
        doc.setImportance(exec.getStatus() != null && exec.getStatus().equals("failed") ? 4 : 3);
        doc.setStatus("active");
        doc.setSourceConvUuid(sourceConvUuid);

        memoryDocumentMapper.insert(doc);
        saveExecutionWorkFile(exec, doc, wfName, conversationId, content.toString(), scenarioId);
        upsertWorkflowWorkIndex(exec.getUserId(), conversationId, sourceConvUuid, exec, wfName, artifacts);
        log.info("[Workflow] 执行记录已写入记忆 docId={}, workflowId={}, executionId={}, status={}",
                doc.getId(), exec.getWorkflowId(), exec.getId(), exec.getStatus());
    }

    private void saveExecutionMemory(WorkflowExecution exec) {
        Workflow wf = workflowMapper.selectById(exec.getWorkflowId());
        String wfName = wf != null ? wf.getName() : "未知工作流";
        Map<String, Object> executionContext = extractExecutionContext(exec.getInputJson());
        String sourceConvUuid = asString(executionContext.get("conversationUuid"));
        Long scenarioId = asLong(executionContext.get("scenarioId"));
        String scenarioName = asString(executionContext.get("scenarioName"));
        Long conversationId = resolveConversationId(exec.getUserId(), sourceConvUuid);

        // 构建摘要内容
        StringBuilder content = new StringBuilder();
        content.append("# 工作流执行记录：").append(wfName).append("\n\n");
        if (scenarioName != null && !scenarioName.isBlank()) {
            content.append("- **场景**：").append(scenarioName).append("\n");
        }
        content.append("- **状态**：").append(exec.getStatus()).append("\n");
        content.append("- **触发方式**：").append(exec.getTriggerType()).append("\n");
        content.append("- **开始时间**：").append(exec.getStartedAt() != null ? exec.getStartedAt().format(FMT) : "N/A").append("\n");
        content.append("- **完成时间**：").append(exec.getFinishedAt() != null ? exec.getFinishedAt().format(FMT) : "N/A").append("\n");
        content.append("- **耗时**：").append(exec.getDurationMs()).append("ms\n");

        if (exec.getStepResults() != null && !exec.getStepResults().isBlank()) {
            content.append("\n## 步骤执行结果\n\n```json\n");
            // 截断过长内容
            String stepResults = exec.getStepResults();
            if (stepResults.length() > 2000) {
                stepResults = stepResults.substring(0, 2000) + "\n... (截断)";
            }
            content.append(stepResults).append("\n```\n");
        }

        if (exec.getErrorMsg() != null && !exec.getErrorMsg().isBlank()) {
            content.append("\n## 错误信息\n\n").append(exec.getErrorMsg()).append("\n");
        }

        if (exec.getOutputJson() != null && !exec.getOutputJson().isBlank()) {
            String output = exec.getOutputJson();
            if (output.length() > 3000) {
                output = output.substring(0, 3000) + "\n... (截断)";
            }
            content.append("\n## 执行输出\n\n```json\n").append(output).append("\n```\n");
        }

        // 创建记忆文档
        MemoryDocument doc = new MemoryDocument();
        doc.setUuid(UUID.randomUUID().toString());
        doc.setUserId(exec.getUserId());
        doc.setConversationId(conversationId);
        doc.setDocType("workflow_result");
        doc.setTitle("工作流执行: " + wfName + " (" + exec.getStatus() + ")");
        doc.setContent(content.toString());
        doc.setCategory("workflow_execution");
        doc.setTags(buildExecutionTags(exec, scenarioId));
        doc.setImportance(exec.getStatus() != null && exec.getStatus().equals("failed") ? 4 : 3);
        doc.setStatus("active");
        doc.setSourceConvUuid(sourceConvUuid);

        memoryDocumentMapper.insert(doc);
        saveExecutionWorkFile(exec, doc, wfName, conversationId, content.toString(), scenarioId);
        log.info("[Workflow] 执行记录已写入记忆: docId={}, workflowId={}, status={}",
                doc.getId(), exec.getWorkflowId(), exec.getStatus());
    }

    // =============================================
    // DSL ↔ cronExpr 双向同步
    // =============================================

    /**
     * 同步 Workflow 的 cronExpr 列与 DSL 中的 trigger.value，确保两者一致。
     * <p>
     * 规则：
     * 1. 如果请求中显式提供了 cronExpr（列表编辑场景），以 cronExpr 为准，
     *    更新 DSL 的 trigger.type=cron, trigger.value=cronExpr
     * 2. 如果请求中未提供 cronExpr 但 DSL 中有 cron 触发器（可视化编辑场景），
     *    从 DSL 提取 cron 表达式写入 cronExpr 列
     * 3. 如果 DSL 触发器为 manual，清除 cronExpr
     *
     * @param w              工作流实体（dsl 字段已设置）
     * @param requestCronExpr 请求中显式传入的 cronExpr（可能为 null）
     */
    private void syncCronAndDsl(Workflow w, String requestCronExpr) {
        String dsl = w.getDsl();
        if (dsl == null || dsl.trim().isEmpty()) {
            return;
        }

        try {
            WorkflowParser.ParsedDsl parsed = workflowParser.parse(dsl);
            String dslCron = parsed.getCronExpr();
            String dslTriggerType = parsed.getTriggerType();

            if (requestCronExpr != null && !requestCronExpr.trim().isEmpty()) {
                // 用户显式设置了 cronExpr（列表编辑）— 以 cronExpr 为准，更新 DSL
                if (!requestCronExpr.equals(dslCron)) {
                    updateDslTriggerValue(w, requestCronExpr);
                    log.info("[Workflow] DSL trigger.value 已同步为 cronExpr: {}", requestCronExpr);
                }
                // cronExpr 列已由调用方设置
            } else if ("cron".equals(dslTriggerType) && dslCron != null && !dslCron.trim().isEmpty()) {
                // DSL 中有 cron 表达式（可视化编辑）— 同步到 cronExpr 列
                w.setCronExpr(dslCron);
                log.info("[Workflow] cronExpr 列已从 DSL 同步: {}", dslCron);
            } else if (!"cron".equals(dslTriggerType)) {
                // DSL 触发器非 cron — 清除 cronExpr
                w.setCronExpr(null);
            }
        } catch (Exception e) {
            log.warn("[Workflow] DSL cron 同步失败（不影响保存）: {}", e.getMessage());
        }
    }

    /**
     * 更新 DSL JSON 中的 trigger.value
     */
    @SuppressWarnings("unchecked")
    private void updateDslTriggerValue(Workflow w, String newCronExpr) {
        try {
            Map<String, Object> dsl = objectMapper.readValue(w.getDsl(),
                    new TypeReference<Map<String, Object>>() {});
            Map<String, Object> trigger = (Map<String, Object>) dsl.get("trigger");
            if (trigger == null) {
                trigger = new LinkedHashMap<>();
                dsl.put("trigger", trigger);
            }
            trigger.put("type", "cron");
            trigger.put("value", newCronExpr);
            w.setDsl(objectMapper.writeValueAsString(dsl));
        } catch (Exception e) {
            log.warn("[Workflow] 更新 DSL trigger.value 失败: {}", e.getMessage());
        }
    }

    // =============================================
    // 转换方法
    // =============================================

    private WorkflowDTO.WorkflowVO toVO(Workflow w) {
        WorkflowDTO.WorkflowVO vo = new WorkflowDTO.WorkflowVO();
        vo.setId(w.getId());
        vo.setUserId(w.getUserId());
        vo.setName(w.getName());
        vo.setDescription(w.getDescription());
        vo.setDsl(w.getDsl());
        vo.setCronExpr(w.getCronExpr());
        vo.setStatus(w.getStatus());
        vo.setLastRunAt(w.getLastRunAt() != null ? w.getLastRunAt().format(FMT) : null);
        vo.setCreatedAt(w.getCreatedAt() != null ? w.getCreatedAt().format(FMT) : null);
        vo.setUpdatedAt(w.getUpdatedAt() != null ? w.getUpdatedAt().format(FMT) : null);
        return vo;
    }

    private WorkflowDTO.WorkflowBriefVO toBriefVO(Workflow w) {
        WorkflowDTO.WorkflowBriefVO vo = new WorkflowDTO.WorkflowBriefVO();
        vo.setId(w.getId());
        vo.setName(w.getName());
        vo.setDescription(w.getDescription());
        vo.setStatus(w.getStatus());
        vo.setCronExpr(w.getCronExpr());
        vo.setLastRunAt(w.getLastRunAt() != null ? w.getLastRunAt().format(FMT) : null);
        return vo;
    }

    private WorkflowDTO.ExecutionVO toExecVO(WorkflowExecution e) {
        WorkflowDTO.ExecutionVO vo = new WorkflowDTO.ExecutionVO();
        vo.setId(e.getId());
        vo.setWorkflowId(e.getWorkflowId());
        vo.setUserId(e.getUserId());
        vo.setStatus(e.getStatus());
        vo.setTriggerType(e.getTriggerType());
        vo.setInputJson(e.getInputJson());
        vo.setOutputJson(e.getOutputJson());
        vo.setStepResults(e.getStepResults());
        vo.setErrorMsg(e.getErrorMsg());
        vo.setStartedAt(e.getStartedAt() != null ? e.getStartedAt().format(FMT) : null);
        vo.setFinishedAt(e.getFinishedAt() != null ? e.getFinishedAt().format(FMT) : null);
        vo.setDurationMs(e.getDurationMs());
        return vo;
    }

    private List<WorkflowDTO.ExecutionStepVO> listExecutionSteps(Long executionId) {
        return executionStepMapper.selectList(
                new QueryWrapper<WorkflowExecutionStep>()
                        .eq("execution_id", executionId)
                        .orderByAsc("started_at")
                        .orderByAsc("id")
        ).stream().map(this::toStepVO).collect(Collectors.toList());
    }

    private List<WorkflowDTO.ExecutionEventVO> listExecutionEvents(Long executionId) {
        return executionEventMapper.selectList(
                new QueryWrapper<WorkflowExecutionEvent>()
                        .eq("execution_id", executionId)
                        .orderByAsc("created_at")
                        .orderByAsc("id")
        ).stream().map(this::toEventVO).collect(Collectors.toList());
    }

    public List<WorkflowDTO.ExecutionEventVO> listExecutionEventsAfter(Long executionId, Long afterId) {
        QueryWrapper<WorkflowExecutionEvent> qw = new QueryWrapper<WorkflowExecutionEvent>()
                .eq("execution_id", executionId)
                .orderByAsc("created_at")
                .orderByAsc("id");
        if (afterId != null && afterId > 0) {
            qw.gt("id", afterId);
        }
        return executionEventMapper.selectList(qw).stream().map(this::toEventVO).collect(Collectors.toList());
    }

    private WorkflowDTO.ExecutionStepVO toStepVO(WorkflowExecutionStep e) {
        WorkflowDTO.ExecutionStepVO vo = new WorkflowDTO.ExecutionStepVO();
        vo.setId(e.getId());
        vo.setExecutionId(e.getExecutionId());
        vo.setWorkflowId(e.getWorkflowId());
        vo.setStepId(e.getStepId());
        vo.setStepName(e.getStepName());
        vo.setToolName(e.getToolName());
        vo.setStatus(e.getStatus());
        vo.setInputJson(e.getInputJson());
        vo.setOutputJson(e.getOutputJson());
        vo.setErrorMsg(e.getErrorMsg());
        vo.setStartedAt(e.getStartedAt() != null ? e.getStartedAt().format(FMT) : null);
        vo.setFinishedAt(e.getFinishedAt() != null ? e.getFinishedAt().format(FMT) : null);
        vo.setDurationMs(e.getDurationMs());
        vo.setCreatedAt(e.getCreatedAt() != null ? e.getCreatedAt().format(FMT) : null);
        return vo;
    }

    private WorkflowDTO.ExecutionEventVO toEventVO(WorkflowExecutionEvent e) {
        WorkflowDTO.ExecutionEventVO vo = new WorkflowDTO.ExecutionEventVO();
        vo.setId(e.getId());
        vo.setExecutionId(e.getExecutionId());
        vo.setStepId(e.getStepId());
        vo.setEventType(e.getEventType());
        vo.setMessage(e.getMessage());
        vo.setPayloadJson(e.getPayloadJson());
        vo.setCreatedAt(e.getCreatedAt() != null ? e.getCreatedAt().format(FMT) : null);
        return vo;
    }

    private WorkflowDTO.ExecutionBriefVO toExecBriefVO(WorkflowExecution e) {
        WorkflowDTO.ExecutionBriefVO vo = new WorkflowDTO.ExecutionBriefVO();
        vo.setId(e.getId());
        vo.setWorkflowId(e.getWorkflowId());
        vo.setStatus(e.getStatus());
        vo.setTriggerType(e.getTriggerType());
        vo.setStartedAt(e.getStartedAt() != null ? e.getStartedAt().format(FMT) : null);
        vo.setFinishedAt(e.getFinishedAt() != null ? e.getFinishedAt().format(FMT) : null);
        vo.setDurationMs(e.getDurationMs());
        return vo;
    }

    private String toJsonString(Object value) {
        if (value == null) return null;
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return String.valueOf(value);
        }
    }

    private Object parseJsonValue(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return objectMapper.readValue(raw, new TypeReference<Object>() {});
        } catch (Exception e) {
            return raw;
        }
    }

    private int calculateDuration(LocalDateTime startedAt, LocalDateTime finishedAt) {
        if (startedAt == null || finishedAt == null) return 0;
        return (int) Duration.between(startedAt, finishedAt).toMillis();
    }

    private String readableStepName(WorkflowParser.ParsedStep step) {
        if (step.getDescription() != null && !step.getDescription().isBlank()) {
            return step.getDescription();
        }
        return step.getId() != null ? step.getId() : "未命名步骤";
    }

    private String statusLabel(String status) {
        return switch (status) {
            case "completed" -> "完成";
            case "skipped" -> "跳过";
            case "cancelled" -> "取消";
            default -> "失败";
        };
    }
}
