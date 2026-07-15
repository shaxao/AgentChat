package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.entity.WorkflowExecution;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;

/**
 * 工作流调度器（战略改造 v2.0 P2-1）
 * <p>
 * 基于 Spring TaskScheduler，为每个 active 工作流注册 cron 定时任务。
 * 支持动态添加/取消调度，应用启动时自动注册所有 active 工作流。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class WorkflowScheduler {

    private final TaskScheduler taskScheduler;
    private final WorkflowMapper workflowMapper;
    private final WorkflowService workflowService;
    private final WorkflowParser workflowParser;
    private final UnifiedToolService unifiedToolService;
    private final CodeExecutionService codeExecutionService;
    private final ObjectMapper objectMapper;
    private final AiService aiService;
    private final WorkflowArtifactService workflowArtifactService;

    /** 已注册的调度任务：workflowId → ScheduledFuture */
    private final Map<Long, ScheduledFuture<?>> scheduledTasks = new ConcurrentHashMap<>();

    /** 正在执行的线程：executionId → Thread（用于手动停止） */
    private final Map<Long, Thread> runningThreads = new ConcurrentHashMap<>();

    /**
     * 应用启动后，自动注册所有 active 状态的工作流，
     * 并清理后端重启遗留的僵尸 running 记录
     */
    @EventListener(ApplicationReadyEvent.class)
    public void onApplicationReady() {
        log.info("[WorkflowScheduler] 应用启动，扫描 active 工作流...");

        // 清理僵尸 running 记录（上次运行时未完成，服务重启后线程丢失但数据库仍为 running）
        try {
            int zombies = workflowService.cleanupZombieExecutions(30);
            if (zombies > 0) {
                log.warn("[WorkflowScheduler] 清理了 {} 条僵尸执行记录（超过 30 分钟未完成）", zombies);
            }
        } catch (Exception e) {
            log.error("[WorkflowScheduler] 清理僵尸执行记录失败: {}", e.getMessage());
        }

        cleanupExpiredWorkflowArtifactUploads();

        List<Workflow> activeWorkflows = workflowMapper.selectList(
                new QueryWrapper<Workflow>()
                        .eq("status", "active")
                        .eq("deleted", 0));

        if (activeWorkflows.isEmpty()) {
            log.info("[WorkflowScheduler] 没有需要调度的 active 工作流");
            return;
        }

        int successCount = 0;
        int failCount = 0;
        for (Workflow wf : activeWorkflows) {
            try {
                schedule(wf);
                successCount++;
            } catch (Exception e) {
                failCount++;
                log.error("[WorkflowScheduler] 调度工作流 {} (ID={}) 失败: {}", wf.getName(), wf.getId(), e.getMessage());
            }
        }
        log.info("[WorkflowScheduler] 定时调度注册完成: 成功 {} 个, 失败 {} 个 (共 {} 个 active 工作流)",
                successCount, failCount, activeWorkflows.size());
    }

    /**
     * 注册工作流调度
     */
    @Scheduled(fixedDelay = 60 * 60 * 1000, initialDelay = 10 * 60 * 1000)
    public void cleanupExpiredWorkflowArtifactUploads() {
        try {
            int cleaned = workflowArtifactService.cleanupExpiredUploadSessions(100);
            if (cleaned > 0) {
                log.info("[WorkflowScheduler] cleaned {} expired workflow artifact upload session(s)", cleaned);
            }
        } catch (Exception e) {
            log.warn("[WorkflowScheduler] cleanup expired workflow artifact upload sessions failed: {}", e.getMessage());
        }
    }

    public void schedule(Workflow workflow) {
        // 如果 cronExpr 列为空，尝试从 DSL 中提取（兼容旧数据）
        if (workflow.getCronExpr() == null || workflow.getCronExpr().trim().isEmpty()) {
            String extractedCron = extractCronFromDsl(workflow.getDsl());
            if (extractedCron != null) {
                log.info("[WorkflowScheduler] 工作流 {} (ID={}) cronExpr 列为空，从 DSL 提取到: {}",
                        workflow.getName(), workflow.getId(), extractedCron);
                workflow.setCronExpr(extractedCron);
                // 持久化到数据库，避免下次再解析
                try {
                    com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper<Workflow> uw =
                            new com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper<>();
                    uw.eq("id", workflow.getId()).set("cron_expr", extractedCron);
                    workflowMapper.update(null, uw);
                } catch (Exception e) {
                    log.warn("[WorkflowScheduler] 持久化 cronExpr 失败: {}", e.getMessage());
                }
            } else {
                log.warn("[WorkflowScheduler] 工作流 {} (ID={}) 没有 cron 表达式，跳过调度", workflow.getName(), workflow.getId());
                return;
            }
        }

        // 先取消已有的调度
        cancel(workflow.getId());

        // 将 5 段 cron 表达式（标准 Unix 格式）转换为 6 段（Spring 格式）
        String normalizedCron = normalizeCronExpression(workflow.getCronExpr());

        try {
            CronTrigger trigger = new CronTrigger(normalizedCron);
            ScheduledFuture<?> future = taskScheduler.schedule(
                    () -> executeWorkflow(workflow.getId(), workflow.getUserId(), null),
                    trigger);
            scheduledTasks.put(workflow.getId(), future);
            log.info("[WorkflowScheduler] 已调度工作流: {} (ID={}, cron={})", workflow.getName(), workflow.getId(), normalizedCron);
        } catch (Exception e) {
            log.error("[WorkflowScheduler] 调度工作流 {} (ID={}) 失败: {}", workflow.getName(), workflow.getId(), e.getMessage());
            // 抛出异常，让调用方（Controller）能感知失败并返回错误信息给前端
            throw new RuntimeException("调度注册失败: " + e.getMessage(), e);
        }
    }

    /**
     * 将标准 5 段 cron 表达式（分 时 日 月 周）转换为 Spring 要求的 6 段格式（秒 分 时 日 月 周）。
     * Spring 的 CronTrigger 要求至少 6 段，而用户通常使用标准 Unix cron 的 5 段格式。
     * 此方法在 5 段表达式前自动补 "0"（秒位为 0）。
     * 示例：5 段输入前补 "0 " 即可得到 6 段。
     */
    private String normalizeCronExpression(String cron) {
        if (cron == null || cron.trim().isEmpty()) {
            throw new IllegalArgumentException("cron 表达式不能为空");
        }
        String trimmed = cron.trim();
        // 按空白分割（支持多个空格）
        String[] fields = trimmed.split("\\s+");
        if (fields.length == 5) {
            // 标准 5 段 → 补秒位 "0"
            String normalized = "0 " + trimmed;
            log.info("[WorkflowScheduler] cron 表达式 5 段转 6 段: '{}' → '{}'", trimmed, normalized);
            return normalized;
        } else if (fields.length == 6 || fields.length == 7) {
            // 已经是 Spring 格式，直接使用
            return trimmed;
        } else {
            throw new IllegalArgumentException(
                    String.format("无效的 cron 表达式 '%s'：期望 5-7 段，实际 %d 段", trimmed, fields.length));
        }
    }

    /**
     * 从 DSL JSON 中提取 cron 表达式
     * @return cron 表达式，如果 DSL 中没有 cron 触发器则返回 null
     */
    private String extractCronFromDsl(String dsl) {
        if (dsl == null || dsl.trim().isEmpty()) {
            return null;
        }
        try {
            WorkflowParser.ParsedDsl parsed = workflowParser.parse(dsl);
            if ("cron".equals(parsed.getTriggerType()) && parsed.getCronExpr() != null) {
                return parsed.getCronExpr().trim();
            }
        } catch (Exception e) {
            log.warn("[WorkflowScheduler] 解析 DSL 提取 cron 失败: {}", e.getMessage());
        }
        return null;
    }

    /**
     * 取消工作流调度
     */
    public void cancel(Long workflowId) {
        ScheduledFuture<?> future = scheduledTasks.remove(workflowId);
        if (future != null) {
            future.cancel(false);
            log.info("[WorkflowScheduler] 已取消调度工作流 ID={}", workflowId);
        }
    }

    /**
     * 执行工作流
     * @param workflowId 工作流 ID
     * @param userId 用户 ID
     * @param existingExecutionId 手动执行时传入已有的执行记录 ID；null 表示自动创建
     */
    public void executeWorkflow(Long workflowId, Long userId, Long existingExecutionId) {
        executeWorkflow(workflowId, userId, existingExecutionId, null, null);
    }

    public void resumeWorkflow(Long workflowId,
                               Long userId,
                               Long existingExecutionId,
                               String fromStepId,
                               Map<String, Object> checkpointOutputs) {
        executeWorkflow(workflowId, userId, existingExecutionId, fromStepId, checkpointOutputs);
    }

    private void executeWorkflow(Long workflowId,
                                 Long userId,
                                 Long existingExecutionId,
                                 String fromStepId,
                                 Map<String, Object> checkpointOutputs) {
        log.info("[WorkflowScheduler] 开始执行工作流 ID={}, existingExecutionId={}", workflowId, existingExecutionId);

        WorkflowExecution execution = null;
        boolean isNewExecution = (existingExecutionId == null);

        try {
            // 使用已有执行记录 或 创建新记录
            if (isNewExecution) {
                execution = workflowService.createExecution(workflowId, userId, "cron", null);
            } else {
                execution = workflowService.getExecutionEntity(existingExecutionId);
                if (execution == null) {
                    log.error("[WorkflowScheduler] 执行记录 {} 不存在", existingExecutionId);
                    return;
                }
            }

            // 注册到运行线程表（支持手动停止）
            final Long executionId = execution.getId();
            runningThreads.put(executionId, Thread.currentThread());

            // 校验工作流存在
            Workflow wf = workflowMapper.selectById(workflowId);
            if (wf == null || wf.getDsl() == null || wf.getDsl().trim().isEmpty()) {
                workflowService.completeExecution(executionId, false, null, null, "工作流不存在或 DSL 为空");
                return;
            }

            // 解析 DSL
            WorkflowParser.ParsedDsl parsed;
            try {
                parsed = workflowParser.parse(wf.getDsl());
            } catch (Exception e) {
                workflowService.completeExecution(executionId, false, null, null, "DSL 解析失败: " + e.getMessage());
                return;
            }

            if (parsed.getSteps() == null || parsed.getSteps().isEmpty()) {
                workflowService.completeExecution(executionId, true,
                        "{\"steps\":0,\"status\":\"noop\"}", "[]", null);
                return;
            }

            // 执行各步骤 — 真正调用工具
            List<Map<String, Object>> stepResults = new ArrayList<>();
            Map<String, Object> stepOutputs = new LinkedHashMap<>(); // stepId → 输出（供后续步骤引用）
            if (checkpointOutputs != null && !checkpointOutputs.isEmpty()) {
                stepOutputs.putAll(checkpointOutputs);
                workflowService.recordExecutionEvent(executionId, null, "workflow_resumed",
                        "工作流从断点继续执行",
                        Map.of(
                                "workflowId", workflowId,
                                "fromStepId", fromStepId != null ? fromStepId : "",
                                "checkpointSteps", new ArrayList<>(checkpointOutputs.keySet())));
            }
            boolean allSuccess = true;
            String firstError = null;
            String dataMode = parsed.getDataMode() != null ? parsed.getDataMode() : "auto";
            log.info("[WorkflowScheduler] 工作流 ID={} 数据传递模式: {}", workflowId, dataMode);

            if ("ai".equalsIgnoreCase(dataMode)) {
                Map<String, Object> aiResult = executeAiDrivenWorkflow(
                        parsed, workflowId, userId, executionId, stepOutputs, fromStepId, execution.getInputJson());
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> aiStepResults =
                        (List<Map<String, Object>>) aiResult.getOrDefault("stepResults", new ArrayList<>());
                stepResults.addAll(aiStepResults);
                allSuccess = Boolean.TRUE.equals(aiResult.get("success"));
                firstError = aiResult.get("error") != null ? String.valueOf(aiResult.get("error")) : null;

                String stepResultsJson = objectMapper.writeValueAsString(stepResults);
                workflowService.completeExecution(
                        executionId,
                        allSuccess,
                        objectMapper.writeValueAsString(Map.of(
                                "steps", stepResults.size(),
                                "allSuccess", allSuccess,
                                "status", "done",
                                "mode", "ai",
                                "finalAnswer", aiResult.getOrDefault("finalAnswer", ""))),
                        stepResultsJson,
                        firstError);

                workflowService.updateLastRun(workflowId);
                log.info("[WorkflowScheduler] AI-driven workflow ID={} completed, steps={}, success={}",
                        workflowId, stepResults.size(), allSuccess);
                return;
            }

            boolean resumeGateOpen = fromStepId == null || fromStepId.isBlank();

            for (WorkflowParser.ParsedStep step : parsed.getSteps()) {
                if (!resumeGateOpen) {
                    if (fromStepId.equals(step.getId())) {
                        resumeGateOpen = true;
                    } else {
                        Map<String, Object> restored = new LinkedHashMap<>();
                        restored.put("stepId", step.getId());
                        restored.put("tool", step.getTool());
                        restored.put("status", "restored");
                        restored.put("message", "已从原执行记录恢复，未重复执行");
                        restored.put("output", stepOutputs.get(step.getId()));
                        stepResults.add(restored);
                        continue;
                    }
                }

                var stepRecord = workflowService.startExecutionStep(executionId, workflowId, step, step.getArgs());
                // 检查条件
                if (step.getCondition() != null && !step.getCondition().trim().isEmpty()) {
                    boolean conditionMet = evaluateCondition(step.getCondition(), stepOutputs);
                    if (!conditionMet) {
                        Map<String, Object> skipped = new LinkedHashMap<>();
                        skipped.put("stepId", step.getId());
                        skipped.put("tool", step.getTool());
                        skipped.put("status", "skipped");
                        skipped.put("message", "条件不满足: " + step.getCondition());
                        stepResults.add(skipped);
                        workflowService.finishExecutionStep(
                                stepRecord.getId(),
                                "skipped",
                                skipped,
                                null,
                                null);
                        log.info("[WorkflowScheduler] 步骤 {} 条件不满足，跳过: {}", step.getId(), step.getCondition());
                        continue;
                    }
                }

                Map<String, Object> stepResult = executeStep(step, stepOutputs, userId, dataMode, workflowId, executionId);
                stepResults.add(stepResult);

                // 存储输出供后续步骤引用
                String status = (String) stepResult.get("status");
                String executionStatus = "completed".equals(status) ? "completed"
                        : "cancelled".equals(status) ? "cancelled" : "failed";
                Object elapsedObj = stepResult.get("elapsedMs");
                Integer elapsedMs = elapsedObj instanceof Number ? ((Number) elapsedObj).intValue() : null;
                workflowService.finishExecutionStep(
                        stepRecord.getId(),
                        executionStatus,
                        stepResult.get("input"),
                        stepResult.get("output"),
                        "completed".equals(status) ? null : (String) stepResult.getOrDefault("message", "步骤执行失败"),
                        elapsedMs);
                if ("completed".equals(status)) {
                    stepOutputs.put(step.getId(), stepResult.get("output"));
                } else {
                    allSuccess = false;
                    if (firstError == null) {
                        firstError = (String) stepResult.getOrDefault("message", "步骤执行失败");
                    }
                    log.warn("[WorkflowScheduler] 步骤 {} 执行失败: {}", step.getId(),
                            stepResult.getOrDefault("message", "未知错误"));
                }
            }

            // 完成执行
            String stepResultsJson = objectMapper.writeValueAsString(stepResults);
            workflowService.completeExecution(
                    executionId,
                    allSuccess,
                    "{\"steps\":" + stepResults.size() + ",\"allSuccess\":" + allSuccess + ",\"status\":\"done\"}",
                    stepResultsJson,
                    firstError);

            workflowService.updateLastRun(workflowId);
            log.info("[WorkflowScheduler] 工作流 ID={} 执行完成, {} 个步骤, allSuccess={}", workflowId, stepResults.size(), allSuccess);

        } catch (Exception e) {
            log.error("[WorkflowScheduler] 工作流 ID={} 执行失败: {}", workflowId, e.getMessage(), e);
            if (execution != null) {
                try {
                    workflowService.completeExecution(execution.getId(), false, null, null, e.getMessage());
                } catch (Exception ex) {
                    log.error("[WorkflowScheduler] 记录执行失败状态出错: {}", ex.getMessage());
                }
            }
        } finally {
            if (execution != null) {
                runningThreads.remove(execution.getId());
            }
        }
    }

    /**
     * 停止正在执行的工作流
     * @return true 表示成功发送中断信号
     */
    public boolean stopExecution(Long executionId) {
        Thread thread = runningThreads.get(executionId);
        if (thread != null) {
            thread.interrupt();
            runningThreads.remove(executionId);
            log.info("[WorkflowScheduler] 已发送中断信号给执行 {} (thread={})", executionId, thread.getName());
            return true;
        }
        log.warn("[WorkflowScheduler] 未找到执行 {} 的运行线程", executionId);
        return false;
    }

    // =============================================
    // 私有方法
    // =============================================

    /**
     * 执行单个步骤
     * <p>
     * 优先级：
     * 1. 如果步骤包含内联代码（code 字段），直接通过 CodeExecutionService 执行
     * 2. 否则按工具名查找已注册工具（内置工具 / Agent Skill 工具）
     * <p>
     * 数据传递模式（dataMode）：
     * - "auto"（默认）：模板变量替换 + 启发式自动注入前步输出
     * - "template"：仅模板变量替换，不自动注入
     * - "ai"：AI 编排，由 AI 决定如何传递数据；失败时降级到 auto
     */
    private Map<String, Object> executeStep(WorkflowParser.ParsedStep step,
                                            Map<String, Object> previousOutputs,
                                            Long userId,
                                            String dataMode,
                                            Long workflowId,
                                            Long executionId) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("stepId", step.getId());
        result.put("tool", step.getTool());

        String toolName = step.getTool();
        if (toolName == null || toolName.trim().isEmpty()) {
            result.put("status", "failed");
            result.put("message", "步骤缺少 tool 字段");
            return result;
        }

        // ★ 根据数据传递模式准备参数
        Map<String, Object> args;
        if ("ai".equals(dataMode) && !previousOutputs.isEmpty()) {
            // 方案二：AI 编排数据传递
            try {
                args = resolveArgsWithAi(step, previousOutputs);
                log.info("[WorkflowScheduler] 步骤 {} AI 编排参数完成", step.getId());
            } catch (Exception e) {
                log.warn("[WorkflowScheduler] 步骤 {} AI 编排失败，降级到自动注入: {}", step.getId(), e.getMessage());
                args = resolveArgs(step.getArgs(), previousOutputs);
                args = autoInjectPreviousOutput(args, previousOutputs);
            }
        } else {
            // 方案一：模板变量替换 + 自动注入
            args = resolveArgs(step.getArgs(), previousOutputs);
            if (!"template".equals(dataMode)) {
                // auto 模式：自动注入前步输出到常见参数名
                args = autoInjectPreviousOutput(args, previousOutputs);
            }
        }

        // ★ 为代码步骤注入上下文变量（无论哪种 dataMode）
        injectCodeStepContext(args, previousOutputs);

        // ★ 注入 userId 供计费追踪使用
        args.put("_userId", userId);
        args.put("_workflowId", workflowId);
        args.put("_executionId", executionId);
        args.put("_stepId", step.getId());
        result.put("input", sanitizeExecutionInput(args));

        // ★ 优先检查是否有内联代码 — 有则直接执行代码，无需工具注册
        String code = step.getCode();
        if (code != null && !code.trim().isEmpty()) {
            String language = step.getLanguage() != null ? step.getLanguage() : "python";
            try {
                validateSchemaRequirements(step.getInputSchema(), args, "输入");
                long startMs = System.currentTimeMillis();
                Map<String, Object> codeResult = codeExecutionService.executeCode(
                        code,
                        language,
                        args,
                        step.getTimeoutSeconds(),
                        step.getPermissions());
                long elapsed = System.currentTimeMillis() - startMs;

                boolean success = Boolean.TRUE.equals(codeResult.get("success"));
                if (success) {
                    Object outputObj = codeResult.get("output");
                    validateSchemaRequirements(step.getOutputSchema(), outputObj, "输出");
                    result.put("status", "completed");
                    result.put("output", outputObj);
                    result.put("elapsedMs", elapsed);
                    String outputPreview = stringifyOutput(outputObj);
                    result.put("outputPreview", outputPreview.length() > 500 ? outputPreview.substring(0, 500) + "..." : outputPreview);
                    log.info("[WorkflowScheduler] 步骤 {} ({}): 内联代码执行完成, {}ms", step.getId(), toolName, elapsed);
                } else {
                    result.put("status", "failed");
                    result.put("message", toolName + " 内联代码执行失败: " + codeResult.get("error"));
                    log.warn("[WorkflowScheduler] 步骤 {} 内联代码执行失败: {}", step.getId(), codeResult.get("error"));
                }
            } catch (InterruptedException e) {
                result.put("status", "cancelled");
                result.put("message", "执行被中断");
                Thread.currentThread().interrupt();
                log.warn("[WorkflowScheduler] 步骤 {} 被中断", step.getId());
            } catch (Exception e) {
                result.put("status", "failed");
                result.put("message", toolName + " 内联代码执行出错: " + e.getMessage());
                log.error("[WorkflowScheduler] 步骤 {} ({}): 内联代码执行异常 - {}", step.getId(), toolName, e.getMessage());
            }
            return result;
        }

        // 没有内联代码 — 按工具名查找已注册工具
        if (!unifiedToolService.hasTool(toolName)) {
            result.put("status", "failed");
            result.put("message", "未知工具: " + toolName + "（可用工具: " + unifiedToolService.listTools() + "）");
            log.warn("[WorkflowScheduler] 步骤 {} 工具 {} 未注册", step.getId(), toolName);
            return result;
        }

        try {
            long startMs = System.currentTimeMillis();
            String output = unifiedToolService.execute(toolName, args);
            long elapsed = System.currentTimeMillis() - startMs;

            result.put("status", "completed");
            result.put("output", output);
            result.put("elapsedMs", elapsed);
            // 截断过长输出以便存储
            result.put("outputPreview", output.length() > 500 ? output.substring(0, 500) + "..." : output);

            log.info("[WorkflowScheduler] 步骤 {} ({}): 完成, {}ms", step.getId(), toolName, elapsed);
        } catch (InterruptedException e) {
            result.put("status", "cancelled");
            result.put("message", "执行被中断");
            Thread.currentThread().interrupt();
            log.warn("[WorkflowScheduler] 步骤 {} 被中断", step.getId());
        } catch (Exception e) {
            result.put("status", "failed");
            result.put("message", toolName + " 执行出错: " + e.getMessage());
            log.error("[WorkflowScheduler] 步骤 {} ({}): 失败 - {}", step.getId(), toolName, e.getMessage());
        }

        return result;
    }

    private void validateSchemaRequirements(Map<String, Object> schema, Object value, String label) {
        if (schema == null || schema.isEmpty()) {
            return;
        }
        Object requiredRaw = schema.get("required");
        if (!(requiredRaw instanceof List<?> required) || required.isEmpty()) {
            return;
        }
        if (!(value instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException(label + "不符合 schema：需要对象类型");
        }
        List<String> missing = new ArrayList<>();
        for (Object item : required) {
            if (item == null) continue;
            String key = String.valueOf(item);
            if (!map.containsKey(key) || map.get(key) == null || String.valueOf(map.get(key)).isBlank()) {
                missing.add(key);
            }
        }
        if (!missing.isEmpty()) {
            throw new IllegalArgumentException(label + "缺少必填字段: " + String.join(", ", missing));
        }
    }

    private String stringifyOutput(Object outputObj) {
        if (outputObj == null) {
            return "";
        }
        if (outputObj instanceof String text) {
            return text;
        }
        try {
            return objectMapper.writeValueAsString(outputObj);
        } catch (Exception e) {
            return String.valueOf(outputObj);
        }
    }

    private Map<String, Object> sanitizeExecutionInput(Map<String, Object> args) {
        Map<String, Object> safe = new LinkedHashMap<>();
        if (args == null || args.isEmpty()) {
            return safe;
        }
        for (Map.Entry<String, Object> entry : args.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.startsWith("_")) {
                continue;
            }
            safe.put(key, entry.getValue());
        }
        return safe;
    }

    /**
     * 解析步骤参数 — 支持多种引用格式
     * <p>
     * 支持的引用格式：
     * 1. 旧格式（完全替换）: "$ref.step1" 或 "$ref.step1.field"
     * 2. 模板变量（字符串内嵌）: "${steps.step1.output}" 或 "${steps.step1.field}"
     * 3. 快捷变量: "${previous_output}" 引用上一个步骤的输出
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> resolveArgs(Map<String, Object> rawArgs, Map<String, Object> previousOutputs) {
        if (rawArgs == null || rawArgs.isEmpty()) {
            return new HashMap<>();
        }

        Map<String, Object> resolved = new HashMap<>();
        for (Map.Entry<String, Object> entry : rawArgs.entrySet()) {
            Object value = entry.getValue();
            resolved.put(entry.getKey(), resolveValue(value, previousOutputs));
        }
        return resolved;
    }

    /**
     * 递归解析值中的引用和模板变量
     */
    @SuppressWarnings("unchecked")
    private Object resolveValue(Object value, Map<String, Object> previousOutputs) {
        if (value == null) {
            return null;
        }

        if (value instanceof String) {
            String str = (String) value;

            // 1. 旧格式: $ref.stepId 或 $ref.stepId.field（完全替换）
            if (str.startsWith("$ref.")) {
                String ref = str.substring(5);
                int dotIdx = ref.indexOf('.');
                String stepId = dotIdx > 0 ? ref.substring(0, dotIdx) : ref;
                Object stepOutput = previousOutputs.get(stepId);
                if (stepOutput != null) {
                    if (dotIdx > 0) {
                        String field = ref.substring(dotIdx + 1);
                        if (stepOutput instanceof Map) {
                            return ((Map<String, Object>) stepOutput).get(field);
                        }
                    }
                    return stepOutput;
                }
                return null;
            }

            // 2. 模板变量: ${steps.stepId.output} 或 ${steps.stepId.field} 或 ${previous_output}
            if (str.contains("${")) {
                return resolveTemplateString(str, previousOutputs);
            }

            return str;
        }

        if (value instanceof Map) {
            Map<String, Object> nested = new HashMap<>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) value).entrySet()) {
                nested.put(e.getKey(), resolveValue(e.getValue(), previousOutputs));
            }
            return nested;
        }

        if (value instanceof List) {
            List<Object> list = new ArrayList<>();
            for (Object item : (List<?>) value) {
                list.add(resolveValue(item, previousOutputs));
            }
            return list;
        }

        return value;
    }

    /**
     * 解析字符串中的模板变量 ${...}
     * 支持: ${steps.step1.output}, ${steps.step1.field}, ${previous_output}
     */
    @SuppressWarnings("unchecked")
    private String resolveTemplateString(String template, Map<String, Object> previousOutputs) {
        String result = template;
        // 匹配 ${steps.stepId.output} 或 ${steps.stepId.field}
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile(
                "\\$\\{(?:steps\\.)?([a-zA-Z0-9_-]+)(?:\\.([a-zA-Z0-9_.-]+))?\\}");
        java.util.regex.Matcher matcher = pattern.matcher(template);

        StringBuilder sb = new StringBuilder();
        while (matcher.find()) {
            String stepId = matcher.group(1);
            String field = matcher.group(2); // 可能为 null

            Object replacement;
            if ("previous_output".equals(stepId) || "prev".equals(stepId)) {
                // 快捷变量: ${previous_output}
                replacement = getLastOutput(previousOutputs);
            } else {
                Object stepOutput = previousOutputs.get(stepId);
                if (stepOutput != null && field != null && !"output".equals(field)) {
                    // 引用子字段
                    if (stepOutput instanceof Map) {
                        replacement = ((Map<String, Object>) stepOutput).get(field);
                    } else {
                        replacement = stepOutput;
                    }
                } else {
                    // 引用整个输出
                    replacement = stepOutput;
                }
            }

            String replacementStr = replacement != null ? replacement.toString() : "";
            matcher.appendReplacement(sb, java.util.regex.Matcher.quoteReplacement(replacementStr));
        }
        matcher.appendTail(sb);

        // 同时替换 ${previous_output}（防止上面正则未匹配到的情况）
        result = sb.toString();
        if (result.contains("${previous_output}")) {
            Object lastOutput = getLastOutput(previousOutputs);
            result = result.replace("${previous_output}", lastOutput != null ? lastOutput.toString() : "");
        }

        return result;
    }

    /**
     * 获取上一个步骤的输出（LinkedHashMap 的最后一个值）
     */
    private Object getLastOutput(Map<String, Object> previousOutputs) {
        if (previousOutputs == null || previousOutputs.isEmpty()) {
            return null;
        }
        Object last = null;
        for (Object v : previousOutputs.values()) {
            last = v;
        }
        return last;
    }

    /**
     * 方案一核心：自动注入前步输出到常见参数名
     * <p>
     * 启发式规则：
     * - 检测参数名匹配 body/content/message/text/prompt/subject/query/input/data 等
     * - 如果值为空/null：直接填充前步输出
     * - 如果值包含 ${previous_output}：替换为前步输出
     * - 如果值是静态字符串且非空：追加前步输出（保留原内容作为前缀/标题）
     */
    private static final Set<String> CONTENT_PARAM_NAMES = Set.of(
            "body", "content", "message", "text", "prompt", "subject", "query",
            "input", "data", "email_body", "mail_body", "email_content",
            "notification", "text_content", "main_content", "payload"
    );

    private Map<String, Object> autoInjectPreviousOutput(Map<String, Object> args, Map<String, Object> previousOutputs) {
        if (previousOutputs == null || previousOutputs.isEmpty()) {
            return args;
        }

        Object lastOutput = getLastOutput(previousOutputs);
        if (lastOutput == null) {
            return args;
        }

        String lastOutputStr = lastOutput.toString();
        if (lastOutputStr.isEmpty()) {
            return args;
        }

        Map<String, Object> injected = new HashMap<>(args);
        for (Map.Entry<String, Object> entry : injected.entrySet()) {
            String paramName = entry.getKey().toLowerCase();
            if (!CONTENT_PARAM_NAMES.contains(paramName)) {
                continue;
            }

            Object value = entry.getValue();
            if (value == null || (value instanceof String && ((String) value).trim().isEmpty())) {
                // 值为空 — 直接填充前步输出
                injected.put(entry.getKey(), lastOutputStr);
                log.info("[WorkflowScheduler] 自动注入: 参数 '{}' ← 前步输出 ({}字符)", entry.getKey(), lastOutputStr.length());
            } else if (value instanceof String) {
                String strVal = (String) value;
                if (strVal.contains("${previous_output}")) {
                    // 包含占位符 — 替换
                    String resolved = strVal.replace("${previous_output}", lastOutputStr);
                    injected.put(entry.getKey(), resolved);
                    log.info("[WorkflowScheduler] 模板替换: 参数 '{}' ← ${previous_output} 替换", entry.getKey());
                } else if (!strVal.contains("${") && !strVal.startsWith("$ref.")) {
                    // 静态字符串 — 追加前步输出（保留原内容作为标题/前缀）
                    String combined = strVal + "\n\n" + lastOutputStr;
                    injected.put(entry.getKey(), combined);
                    log.info("[WorkflowScheduler] 自动追加: 参数 '{}' ← 原内容 + 前步输出 ({}字符)", entry.getKey(), combined.length());
                }
            }
        }

        return injected;
    }

    /**
     * 为代码步骤注入上下文变量
     * <p>
     * 注入以下变量供内联代码通过 stdin 访问：
     * - __previous_output__: 上一个步骤的输出
     * - __all_outputs__: 所有前序步骤输出的 JSON {stepId: output}
     */
    private void injectCodeStepContext(Map<String, Object> args, Map<String, Object> previousOutputs) {
        if (previousOutputs == null || previousOutputs.isEmpty()) {
            return;
        }

        Object lastOutput = getLastOutput(previousOutputs);
        if (lastOutput != null) {
            args.put("__previous_output__", lastOutput);
        }

        try {
            String allOutputsJson = objectMapper.writeValueAsString(previousOutputs);
            args.put("__all_outputs__", allOutputsJson);
        } catch (Exception e) {
            log.warn("[WorkflowScheduler] 序列化所有输出失败: {}", e.getMessage());
        }
    }

    /**
     * 方案二核心：AI 编排数据传递
     * <p>
     * 调用 AI 根据前序步骤的输出和当前步骤的参数模板，智能决定如何传递数据。
     * AI 返回 JSON 格式的解析后参数。
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> resolveArgsWithAi(WorkflowParser.ParsedStep step, Map<String, Object> previousOutputs) {
        // 构建 AI 的系统提示词
        String systemPrompt = """
                你是一个工作流数据编排助手。你的任务是根据前序步骤的输出结果，为当前步骤生成合适的参数。

                规则：
                1. 分析前序步骤的输出内容
                2. 根据当前步骤的工具名、描述和参数模板，智能决定如何传递数据
                3. 返回纯 JSON 格式的参数（不要包含 markdown 代码块标记）
                4. 参数应包含当前步骤需要的所有字段
                5. 如果前序输出是文本内容，应将其传递到当前步骤的 body/content/message/text/prompt 等参数中
                6. 保留原始参数中不需要修改的值（如邮箱地址等配置信息）
                """;

        // 构建用户消息
        StringBuilder userMessage = new StringBuilder();
        userMessage.append("== 前序步骤输出 ==\n");
        for (Map.Entry<String, Object> e : previousOutputs.entrySet()) {
            String outputStr = e.getValue() != null ? e.getValue().toString() : "(空)";
            // 截断过长输出
            if (outputStr.length() > 2000) {
                outputStr = outputStr.substring(0, 2000) + "...(截断)";
            }
            userMessage.append("步骤 [").append(e.getKey()).append("] 输出:\n")
                    .append(outputStr).append("\n\n");
        }

        userMessage.append("== 当前步骤信息 ==\n");
        userMessage.append("工具名: ").append(step.getTool()).append("\n");
        userMessage.append("描述: ").append(step.getDescription() != null ? step.getDescription() : "(无)").append("\n");

        try {
            userMessage.append("参数模板: ").append(objectMapper.writeValueAsString(step.getArgs())).append("\n\n");
        } catch (Exception e) {
            userMessage.append("参数模板: (序列化失败)\n\n");
        }

        userMessage.append("请根据以上信息，为当前步骤生成完整的参数 JSON。只返回 JSON，不要其他内容。");

        // 调用 AI
        AiService.AiResult aiResult = aiService.chat(
                null, // 使用默认模型
                systemPrompt,
                null, // 无历史对话
                userMessage.toString(),
                0.3, // 低温度确保输出稳定
                2000  // 足够的 token 数
        );

        String aiResponse = aiResult.content().trim();

        // 移除可能的 markdown 代码块标记
        if (aiResponse.startsWith("```")) {
            aiResponse = aiResponse.replaceAll("^```(?:json)?\\s*", "").replaceAll("\\s*```$", "");
        }

        log.info("[WorkflowScheduler] AI 编排响应 ({} tokens, {}ms): {}",
                aiResult.outputTokens(), aiResult.latencyMs(),
                aiResponse.length() > 200 ? aiResponse.substring(0, 200) + "..." : aiResponse);

        // 解析 AI 返回的 JSON
        Map<String, Object> aiArgs;
        try {
            aiArgs = objectMapper.readValue(aiResponse,
                    new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new RuntimeException("AI 返回的 JSON 解析失败: " + e.getMessage(), e);
        }

        // 移除 AI 可能添加的上下文变量
        aiArgs.remove("__previous_output__");
        aiArgs.remove("__all_outputs__");
        aiArgs.remove("_userId");

        return aiArgs;
    }

    private Map<String, Object> executeAiDrivenWorkflow(WorkflowParser.ParsedDsl parsed,
                                                        Long workflowId,
                                                        Long userId,
                                                        Long executionId,
                                                        Map<String, Object> stepOutputs,
                                                        String fromStepId,
                                                        String inputJson) {
        List<WorkflowParser.ParsedStep> allowedSteps = filterAiAllowedSteps(parsed.getSteps(), fromStepId);
        List<Map<String, Object>> stepResults = new ArrayList<>();
        Map<String, Object> result = new LinkedHashMap<>();
        List<Map<String, Object>> observations = new ArrayList<>();
        Set<String> executedStepIds = new LinkedHashSet<>();
        WorkflowParser.ParsedAiPolicy aiPolicy = parsed.getAiPolicy();
        boolean allowRepeatSteps = aiPolicy != null && Boolean.TRUE.equals(aiPolicy.getAllowRepeatSteps());
        boolean continueOnStepFailure = aiPolicy != null && Boolean.TRUE.equals(aiPolicy.getContinueOnStepFailure());
        int maxTurns = resolveAiMaxTurns(aiPolicy, allowedSteps.size());

        workflowService.recordExecutionEvent(executionId, null, "workflow_ai_started",
                "AI 驱动模式已启动",
                Map.of(
                        "workflowId", workflowId,
                        "allowedSteps", describeStepIds(allowedSteps),
                        "maxTurns", maxTurns,
                        "allowRepeatSteps", allowRepeatSteps,
                        "continueOnStepFailure", continueOnStepFailure));

        for (int turn = 1; turn <= maxTurns; turn++) {
            if (Thread.currentThread().isInterrupted()) {
                result.put("success", false);
                result.put("error", "执行已被用户中断");
                result.put("stepResults", stepResults);
                return result;
            }

            AiDecision decision;
            try {
                decision = askAiForWorkflowDecision(
                        allowedSteps,
                        stepOutputs,
                        observations,
                        executedStepIds,
                        inputJson,
                        turn,
                        maxTurns,
                        allowRepeatSteps,
                        continueOnStepFailure);
            } catch (Exception e) {
                workflowService.recordExecutionEvent(executionId, null, "workflow_ai_decision_failed",
                        "AI 决策失败：" + e.getMessage(), Map.of("turn", turn));
                result.put("success", false);
                result.put("error", "AI 决策失败: " + e.getMessage());
                result.put("stepResults", stepResults);
                return result;
            }

            workflowService.recordExecutionEvent(executionId, decision.stepId(), "workflow_ai_decision",
                    decision.reason() != null && !decision.reason().isBlank() ? decision.reason() : "AI 已选择下一步",
                    Map.of(
                            "turn", turn,
                            "action", decision.action(),
                            "stepId", decision.stepId() != null ? decision.stepId() : "",
                            "args", decision.args() != null ? decision.args() : Map.of()));

            if ("finish".equalsIgnoreCase(decision.action())) {
                String finalAnswer = decision.finalAnswer() != null ? decision.finalAnswer() : "";
                workflowService.recordExecutionEvent(executionId, null, "workflow_ai_finished",
                        "AI 驱动流程已完成", Map.of("turn", turn, "finalAnswer", finalAnswer));
                result.put("success", true);
                result.put("finalAnswer", finalAnswer);
                result.put("stepResults", stepResults);
                return result;
            }

            WorkflowParser.ParsedStep selectedStep = findStepById(allowedSteps, decision.stepId());
            if (selectedStep == null) {
                String message = "AI 选择了未授权或不存在的步骤: " + decision.stepId();
                workflowService.recordExecutionEvent(executionId, decision.stepId(), "workflow_ai_policy_blocked",
                        message, Map.of("turn", turn, "allowedSteps", describeStepIds(allowedSteps)));
                observations.add(Map.of("turn", turn, "status", "blocked", "message", message));
                continue;
            }

            if (!allowRepeatSteps && executedStepIds.contains(selectedStep.getId())) {
                String message = "AI policy blocked repeated step: " + selectedStep.getId();
                workflowService.recordExecutionEvent(executionId, selectedStep.getId(), "workflow_ai_policy_blocked",
                        message, Map.of("turn", turn, "allowRepeatSteps", false));
                observations.add(Map.of(
                        "turn", turn,
                        "stepId", selectedStep.getId() != null ? selectedStep.getId() : "",
                        "status", "blocked",
                        "message", message));
                continue;
            }
            if (allowRepeatSteps && executedStepIds.contains(selectedStep.getId()) && !isStepRepeatSafe(selectedStep)) {
                String message = "AI policy blocked non-idempotent repeated step: " + selectedStep.getId();
                workflowService.recordExecutionEvent(executionId, selectedStep.getId(), "workflow_ai_policy_blocked",
                        message, Map.of(
                                "turn", turn,
                                "allowRepeatSteps", true,
                                "idempotent", Boolean.TRUE.equals(selectedStep.getIdempotent()),
                                "sideEffect", selectedStep.getSideEffect() != null ? selectedStep.getSideEffect() : ""));
                observations.add(Map.of(
                        "turn", turn,
                        "stepId", selectedStep.getId() != null ? selectedStep.getId() : "",
                        "status", "blocked",
                        "message", message));
                continue;
            }

            WorkflowParser.ParsedStep executableStep = cloneStepWithArgs(selectedStep, decision.args());
            var stepRecord = workflowService.startExecutionStep(executionId, workflowId, executableStep, executableStep.getArgs());

            if (executableStep.getCondition() != null && !executableStep.getCondition().trim().isEmpty()
                    && !evaluateCondition(executableStep.getCondition(), stepOutputs)) {
                Map<String, Object> skipped = new LinkedHashMap<>();
                skipped.put("stepId", executableStep.getId());
                skipped.put("tool", executableStep.getTool());
                skipped.put("status", "skipped");
                skipped.put("message", "Condition not met: " + executableStep.getCondition());
                stepResults.add(skipped);
                workflowService.finishExecutionStep(stepRecord.getId(), "skipped", skipped, null, null);
                observations.add(Map.of(
                        "turn", turn,
                        "stepId", executableStep.getId() != null ? executableStep.getId() : "",
                        "tool", executableStep.getTool() != null ? executableStep.getTool() : "",
                        "status", "skipped",
                        "message", "Condition not met: " + executableStep.getCondition()));
                continue;
            }

            Map<String, Object> stepResult = executeStep(executableStep, stepOutputs, userId, "template", workflowId, executionId);
            stepResults.add(stepResult);
            executedStepIds.add(selectedStep.getId());

            String status = (String) stepResult.get("status");
            String executionStatus = "completed".equals(status) ? "completed"
                    : "cancelled".equals(status) ? "cancelled" : "failed";
            Object elapsedObj = stepResult.get("elapsedMs");
            Integer elapsedMs = elapsedObj instanceof Number ? ((Number) elapsedObj).intValue() : null;
            workflowService.finishExecutionStep(
                    stepRecord.getId(),
                    executionStatus,
                    stepResult.get("input"),
                    stepResult.get("output"),
                    "completed".equals(status) ? null : String.valueOf(stepResult.getOrDefault("message", "步骤执行失败")),
                    elapsedMs);

            if ("completed".equals(stepResult.get("status"))) {
                stepOutputs.put(selectedStep.getId(), stepResult.get("output"));
            }

            observations.add(Map.of(
                    "turn", turn,
                    "stepId", selectedStep.getId() != null ? selectedStep.getId() : "",
                    "tool", selectedStep.getTool() != null ? selectedStep.getTool() : "",
                    "status", stepResult.getOrDefault("status", "unknown"),
                    "output", truncateForAi(stepResult.get("output"), 3000),
                    "message", stepResult.getOrDefault("message", "")));

            workflowService.recordExecutionEvent(executionId, selectedStep.getId(), "workflow_ai_tool_result",
                    "AI 调用步骤完成：" + selectedStep.getId(),
                    Map.of(
                            "turn", turn,
                            "stepId", selectedStep.getId(),
                            "tool", selectedStep.getTool() != null ? selectedStep.getTool() : "",
                            "status", stepResult.getOrDefault("status", "unknown"),
                            "outputPreview", truncateForAi(stepResult.get("output"), 800)));

            if (!"completed".equals(status) && !continueOnStepFailure) {
                String error = String.valueOf(stepResult.getOrDefault("message", "AI selected step failed"));
                result.put("success", false);
                result.put("error", error);
                result.put("stepResults", stepResults);
                workflowService.recordExecutionEvent(executionId, selectedStep.getId(), "workflow_ai_stopped_on_failure",
                        "AI 驱动流程因步骤失败停止", Map.of(
                                "turn", turn,
                                "stepId", selectedStep.getId() != null ? selectedStep.getId() : "",
                                "status", status != null ? status : "unknown",
                                "continueOnStepFailure", false));
                return result;
            }
        }

        result.put("success", false);
        result.put("error", "AI 驱动流程超过最大轮次限制: " + maxTurns);
        result.put("stepResults", stepResults);
        workflowService.recordExecutionEvent(executionId, null, "workflow_ai_max_turns",
                "AI 驱动流程超过最大轮次限制", Map.of("maxTurns", maxTurns));
        return result;
    }

    private int resolveAiMaxTurns(WorkflowParser.ParsedAiPolicy aiPolicy, int stepCount) {
        int defaultTurns = Math.max(3, Math.min(20, stepCount * 3));
        if (aiPolicy == null || aiPolicy.getMaxTurns() == null) {
            return defaultTurns;
        }
        return Math.max(1, Math.min(50, aiPolicy.getMaxTurns()));
    }

    private AiDecision askAiForWorkflowDecision(List<WorkflowParser.ParsedStep> allowedSteps,
                                                Map<String, Object> stepOutputs,
                                                List<Map<String, Object>> observations,
                                                Set<String> executedStepIds,
                                                String inputJson,
                                                int turn,
                                                int maxTurns,
                                                boolean allowRepeatSteps,
                                                boolean continueOnStepFailure) throws Exception {
        String systemPrompt = """
                You are a workflow orchestration agent. Decide the next workflow step using only the allowed steps.
                Return strict JSON only, without markdown.
                Schema:
                {
                  "action": "call" | "finish",
                  "stepId": "allowed step id when action is call",
                  "args": { "parameter": "value" },
                  "reason": "short reason",
                  "finalAnswer": "required when action is finish"
                }
                Rules:
                - You may only call one of the allowed step ids.
                - Do not invent tools, URLs, files, or permissions.
                - Do not repeat an executed step unless allowRepeatSteps is true.
                - If continueOnStepFailure is false and a step failed, finish instead of trying risky recovery.
                - Use observations and previous outputs to decide whether to continue or finish.
                - Finish when the workflow objective is satisfied or no safe useful step remains.
                """;

        Map<String, Object> context = new LinkedHashMap<>();
        context.put("turn", turn);
        context.put("maxTurns", maxTurns);
        context.put("policy", Map.of(
                "allowRepeatSteps", allowRepeatSteps,
                "continueOnStepFailure", continueOnStepFailure));
        context.put("input", parseJsonValueOrRaw(inputJson));
        context.put("allowedSteps", allowedSteps.stream().map(this::stepToAiDescriptor).toList());
        context.put("executedStepIds", new ArrayList<>(executedStepIds));
        context.put("previousOutputs", compactMapForAi(stepOutputs, 2500));
        context.put("observations", compactListForAi(observations, 2500));

        AiService.AiResult aiResult = aiService.chat(
                null,
                systemPrompt,
                null,
                objectMapper.writeValueAsString(context),
                0.2,
                1800);
        Map<String, Object> rawDecision = parseJsonObjectFromAi(aiResult.content());
        String action = stringValue(rawDecision.get("action"));
        String stepId = stringValue(rawDecision.get("stepId"));
        String reason = stringValue(rawDecision.get("reason"));
        String finalAnswer = stringValue(rawDecision.get("finalAnswer"));
        @SuppressWarnings("unchecked")
        Map<String, Object> args = rawDecision.get("args") instanceof Map<?, ?> rawArgs
                ? new LinkedHashMap<>((Map<String, Object>) rawArgs)
                : new LinkedHashMap<>();

        if (action == null || action.isBlank()) {
            throw new IllegalArgumentException("missing action");
        }
        if (!"call".equalsIgnoreCase(action) && !"finish".equalsIgnoreCase(action)) {
            throw new IllegalArgumentException("unsupported action: " + action);
        }
        if ("call".equalsIgnoreCase(action) && (stepId == null || stepId.isBlank())) {
            throw new IllegalArgumentException("call action requires stepId");
        }
        return new AiDecision(action, stepId, args, reason, finalAnswer);
    }

    private List<WorkflowParser.ParsedStep> filterAiAllowedSteps(List<WorkflowParser.ParsedStep> steps, String fromStepId) {
        if (steps == null || steps.isEmpty()) {
            return List.of();
        }
        if (fromStepId == null || fromStepId.isBlank()) {
            return steps;
        }
        List<WorkflowParser.ParsedStep> filtered = new ArrayList<>();
        boolean open = false;
        for (WorkflowParser.ParsedStep step : steps) {
            if (!open && fromStepId.equals(step.getId())) {
                open = true;
            }
            if (open) {
                filtered.add(step);
            }
        }
        return filtered.isEmpty() ? steps : filtered;
    }

    private WorkflowParser.ParsedStep findStepById(List<WorkflowParser.ParsedStep> steps, String stepId) {
        if (stepId == null) {
            return null;
        }
        for (WorkflowParser.ParsedStep step : steps) {
            if (stepId.equals(step.getId())) {
                return step;
            }
        }
        return null;
    }

    private boolean isStepRepeatSafe(WorkflowParser.ParsedStep step) {
        if (step == null) {
            return false;
        }
        if (Boolean.TRUE.equals(step.getIdempotent())) {
            return true;
        }
        String sideEffect = step.getSideEffect();
        if (sideEffect == null || sideEffect.isBlank()) {
            return false;
        }
        String normalized = sideEffect.trim().toLowerCase(Locale.ROOT);
        return "none".equals(normalized) || "read".equals(normalized);
    }

    private WorkflowParser.ParsedStep cloneStepWithArgs(WorkflowParser.ParsedStep source, Map<String, Object> args) {
        WorkflowParser.ParsedStep copy = new WorkflowParser.ParsedStep();
        copy.setId(source.getId());
        copy.setTool(source.getTool());
        copy.setDescription(source.getDescription());
        copy.setCondition(source.getCondition());
        copy.setCode(source.getCode());
        copy.setLanguage(source.getLanguage());
        copy.setTimeoutSeconds(source.getTimeoutSeconds());
        copy.setPermissions(source.getPermissions());
        copy.setIdempotent(source.getIdempotent());
        copy.setSideEffect(source.getSideEffect());
        copy.setInputSchema(source.getInputSchema());
        copy.setOutputSchema(source.getOutputSchema());
        copy.setArgs(args != null && !args.isEmpty() ? args : source.getArgs());
        return copy;
    }

    private Map<String, Object> stepToAiDescriptor(WorkflowParser.ParsedStep step) {
        Map<String, Object> descriptor = new LinkedHashMap<>();
        descriptor.put("id", step.getId());
        descriptor.put("tool", step.getTool());
        descriptor.put("description", step.getDescription());
        descriptor.put("argsTemplate", step.getArgs());
        descriptor.put("inputSchema", step.getInputSchema());
        descriptor.put("outputSchema", step.getOutputSchema());
        descriptor.put("hasInlineCode", step.getCode() != null && !step.getCode().isBlank());
        descriptor.put("idempotent", Boolean.TRUE.equals(step.getIdempotent()));
        descriptor.put("sideEffect", step.getSideEffect() != null ? step.getSideEffect() : "none");
        return descriptor;
    }

    private List<String> describeStepIds(List<WorkflowParser.ParsedStep> steps) {
        return steps.stream().map(WorkflowParser.ParsedStep::getId).toList();
    }

    private Map<String, Object> parseJsonObjectFromAi(String text) throws Exception {
        String json = extractJsonObject(text);
        return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
    }

    private Object parseJsonValueOrRaw(String text) {
        if (text == null || text.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(text, Object.class);
        } catch (Exception ignored) {
            return text;
        }
    }

    private String extractJsonObject(String text) {
        if (text == null) {
            throw new IllegalArgumentException("AI returned empty decision");
        }
        String trimmed = text.trim();
        if (trimmed.startsWith("```")) {
            trimmed = trimmed.replaceAll("^```(?:json)?\\s*", "").replaceAll("\\s*```$", "").trim();
        }
        int start = trimmed.indexOf('{');
        int end = trimmed.lastIndexOf('}');
        if (start < 0 || end <= start) {
            throw new IllegalArgumentException("AI decision is not JSON: " + truncateForAi(trimmed, 200));
        }
        return trimmed.substring(start, end + 1);
    }

    private Map<String, Object> compactMapForAi(Map<String, Object> source, int maxLen) {
        Map<String, Object> compact = new LinkedHashMap<>();
        if (source == null) {
            return compact;
        }
        for (Map.Entry<String, Object> entry : source.entrySet()) {
            compact.put(entry.getKey(), truncateForAi(entry.getValue(), maxLen));
        }
        return compact;
    }

    private List<Map<String, Object>> compactListForAi(List<Map<String, Object>> source, int maxLen) {
        List<Map<String, Object>> compact = new ArrayList<>();
        if (source == null) {
            return compact;
        }
        for (Map<String, Object> item : source) {
            compact.add(compactMapForAi(item, maxLen));
        }
        return compact;
    }

    private Object truncateForAi(Object value, int maxLen) {
        if (value == null) {
            return "";
        }
        String text = value instanceof String ? (String) value : stringifyOutput(value);
        if (text.length() <= maxLen) {
            return text;
        }
        return text.substring(0, maxLen) + "...(truncated)";
    }

    private String stringValue(Object value) {
        return value != null ? String.valueOf(value) : null;
    }

    private record AiDecision(
            String action,
            String stepId,
            Map<String, Object> args,
            String reason,
            String finalAnswer) {}

    /**
     * 评估步骤条件（简单表达式）
     * 支持: "stepId.success" / "stepId.failed" / "stepId.completed"
     */
    private boolean evaluateCondition(String condition, Map<String, Object> stepOutputs) {
        if (condition == null || condition.trim().isEmpty()) return true;

        String trimmed = condition.trim();
        int dotIdx = trimmed.indexOf('.');
        if (dotIdx <= 0) return true;

        String stepId = trimmed.substring(0, dotIdx);
        String status = trimmed.substring(dotIdx + 1);

        Object output = stepOutputs.get(stepId);

        if ("success".equals(status) || "completed".equals(status)) {
            return output != null && !(output instanceof String && ((String) output).startsWith("{\"error\""));
        }
        if ("failed".equals(status)) {
            return output == null || (output instanceof String && ((String) output).startsWith("{\"error\""));
        }

        return true;
    }
}
