package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.WorkflowDTO;
import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.aiplatform.backend.service.WorkflowExecutionEventBus;
import com.aiplatform.backend.service.WorkflowParser;
import com.aiplatform.backend.service.WorkflowScheduler;
import com.aiplatform.backend.service.WorkflowService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 工作流引擎控制器（战略改造 v2.0 P2-1）
 * <p>
 * 提供工作流的 CRUD、手动/定时触发执行、执行历史查询、
 * AI 自然语言生成工作流 DSL 等 REST API。
 */
@Slf4j
@RestController
@RequestMapping("/api/workflows")
@RequiredArgsConstructor
public class WorkflowController {

    private final WorkflowService workflowService;
    private final WorkflowScheduler workflowScheduler;
    private final WorkflowParser workflowParser;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final WorkflowMapper workflowMapper;
    private final ObjectMapper objectMapper;
    private final WorkflowExecutionEventBus workflowExecutionEventBus;

    // =============================================
    // 工作流 CRUD
    // =============================================

    /**
     * 获取当前用户的所有工作流（概要列表）
     */
    @GetMapping
    public Result<List<WorkflowDTO.WorkflowBriefVO>> list(
            @RequestAttribute Long userId) {
        try {
            return Result.ok(workflowService.listByUser(userId));
        } catch (RuntimeException e) {
            log.error("[Workflow] 列表查询失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 获取工作流详情
     */
    @GetMapping("/{id}")
    public Result<WorkflowDTO.WorkflowVO> detail(
            @PathVariable Long id,
            @RequestAttribute Long userId) {
        try {
            return Result.ok(workflowService.getById(id, userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 创建工作流
     */
    @PreAuthorize("hasAuthority('PERM_workflow:publish')")
    @PostMapping
    public Result<WorkflowDTO.WorkflowVO> create(
            @RequestBody WorkflowDTO.WorkflowCreateRequest request,
            @RequestAttribute Long userId) {
        if (request.getName() == null || request.getName().trim().isEmpty()) {
            return Result.fail("工作流名称不能为空");
        }
        if (request.getName().length() > 128) {
            return Result.fail("工作流名称不能超过128个字符");
        }
        if (request.getDescription() != null && request.getDescription().length() > 500) {
            return Result.fail("工作流描述不能超过500个字符");
        }

        // 如果提供了 DSL，验证其合法性
        if (request.getDsl() != null && !request.getDsl().trim().isEmpty()) {
            try {
                workflowParser.validate(request.getDsl());
            } catch (RuntimeException e) {
                return Result.fail("DSL 格式无效: " + e.getMessage());
            }
        }

        try {
            return Result.ok(workflowService.create(request, userId));
        } catch (RuntimeException e) {
            log.error("[Workflow] 创建失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 更新工作流
     */
    @PreAuthorize("hasAuthority('PERM_workflow:edit')")
    @PutMapping("/{id}")
    public Result<WorkflowDTO.WorkflowVO> update(
            @PathVariable Long id,
            @RequestBody WorkflowDTO.WorkflowUpdateRequest request,
            @RequestAttribute Long userId) {
        if (request.getName() != null && request.getName().length() > 128) {
            return Result.fail("工作流名称不能超过128个字符");
        }
        if (request.getDescription() != null && request.getDescription().length() > 500) {
            return Result.fail("工作流描述不能超过500个字符");
        }

        // 如果提供了 DSL，验证其合法性
        if (request.getDsl() != null && !request.getDsl().trim().isEmpty()) {
            try {
                workflowParser.validate(request.getDsl());
            } catch (RuntimeException e) {
                return Result.fail("DSL 格式无效: " + e.getMessage());
            }
        }

        try {
            WorkflowDTO.WorkflowVO result = workflowService.update(id, request, userId);

            // 如果工作流是 active 状态且有 cron 表达式，重新注册调度
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
            if (wf != null && "active".equals(wf.getStatus()) && wf.getCronExpr() != null) {
                try {
                    workflowScheduler.schedule(wf);
                } catch (Exception e) {
                    log.warn("[Workflow] 重新注册调度失败 (ID={}): {}", id, e.getMessage());
                }
            }

            return Result.ok(result);
        } catch (RuntimeException e) {
            log.error("[Workflow] 更新失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 更新工作流状态（激活/暂停）
     */
    @PatchMapping("/{id}/status")
    public Result<Void> updateStatus(
            @PathVariable Long id,
            @RequestBody WorkflowDTO.WorkflowStatusRequest request,
            @RequestAttribute Long userId) {
        if (request.getStatus() == null) {
            return Result.fail("状态值不能为空");
        }
        if (!List.of("paused", "active").contains(request.getStatus())) {
            return Result.fail("无效的状态值，仅支持 paused / active");
        }

        try {
            workflowService.updateStatus(id, request.getStatus(), userId);

            // 激活 → 注册调度；暂停 → 取消调度
            if ("active".equals(request.getStatus())) {
                Workflow wf = workflowMapper.selectOne(
                        new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
                if (wf != null) {
                    try {
                        workflowScheduler.schedule(wf);
                    } catch (RuntimeException e) {
                        // 调度注册失败 — 将工作流状态回退为 paused，并返回错误信息
                        workflowService.updateStatus(id, "paused", userId);
                        log.error("[Workflow] 激活工作流 {} 调度注册失败: {}", id, e.getMessage());
                        return Result.fail("激活失败: " + e.getMessage());
                    }
                }
            } else {
                workflowScheduler.cancel(id);
            }

            return Result.ok();
        } catch (RuntimeException e) {
            log.error("[Workflow] 状态更新失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 删除工作流（逻辑删除）
     */
    @PreAuthorize("hasAuthority('PERM_workflow:delete')")
    @DeleteMapping("/{id}")
    public Result<Void> delete(
            @PathVariable Long id,
            @RequestAttribute Long userId) {
        try {
            // 先取消调度
            workflowScheduler.cancel(id);
            workflowService.delete(id, userId);
            return Result.ok();
        } catch (RuntimeException e) {
            log.error("[Workflow] 删除失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 手动触发执行
    // =============================================

    /**
     * 手动触发工作流执行（异步执行，立即返回执行记录 ID）
     */
    @PostMapping("/{id}/execute")
    public Result<WorkflowDTO.ExecutionVO> execute(
            @PathVariable Long id,
            @RequestBody(required = false) Map<String, Object> body,
            @RequestAttribute Long userId) {
        try {
            // 校验工作流存在且属于当前用户
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
            if (wf == null) {
                return Result.fail("工作流不存在");
            }
            if (!wf.getUserId().equals(userId)) {
                return Result.fail("无权操作此工作流");
            }

            // 检查 DSL 是否存在
            if (wf.getDsl() == null || wf.getDsl().trim().isEmpty()) {
                return Result.fail("工作流 DSL 为空，无法执行");
            }

            // 构建输入 JSON
            String inputJson = null;
            if (body != null && !body.isEmpty()) {
                inputJson = objectMapper.writeValueAsString(body);
            }

            log.info("[Workflow] 手动触发执行: {} (ID={}), userId={}", wf.getName(), id, userId);

            // 创建执行记录
            var execution = workflowService.createExecution(id, userId, "manual", inputJson);

            // 异步执行 — 传入已有执行记录 ID，避免内部重复创建
            final Long executionId = execution.getId();
            new Thread(() -> {
                try {
                    workflowScheduler.executeWorkflow(id, userId, executionId);
                } catch (Exception e) {
                    log.error("[Workflow] 异步执行失败 (ID={}): {}", id, e.getMessage());
                    try {
                        workflowService.completeExecution(executionId, false, null, null, e.getMessage());
                    } catch (Exception ex) {
                        log.error("[Workflow] 记录执行失败状态出错: {}", ex.getMessage());
                    }
                }
            }, "workflow-exec-" + executionId).start();

            // 立即返回执行记录（状态为 running）
            return Result.ok(workflowService.getExecution(executionId));

        } catch (RuntimeException e) {
            log.error("[Workflow] 触发执行失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        } catch (Exception e) {
            log.error("[Workflow] 触发执行异常: {}", e.getMessage());
            return Result.fail("执行失败: " + e.getMessage());
        }
    }

    // =============================================
    // 执行历史
    // =============================================

    /**
     * 获取工作流的执行历史
     */
    @GetMapping("/{id}/executions")
    public Result<List<WorkflowDTO.ExecutionBriefVO>> listExecutions(
            @PathVariable Long id,
            @RequestParam(defaultValue = "20") int limit,
            @RequestAttribute Long userId) {
        try {
            // 校验归属权
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", id).eq("deleted", 0));
            if (wf == null) {
                return Result.fail("工作流不存在");
            }
            if (!wf.getUserId().equals(userId)) {
                return Result.fail("无权访问此工作流");
            }

            return Result.ok(workflowService.listExecutions(id, Math.min(limit, 100)));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 获取执行记录详情
     */
    @GetMapping("/executions/{executionId}")
    public Result<WorkflowDTO.ExecutionVO> getExecution(
            @PathVariable Long executionId,
            @RequestAttribute Long userId) {
        try {
            WorkflowDTO.ExecutionVO exec = workflowService.getExecution(executionId);

            // 校验归属权
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", exec.getWorkflowId()).eq("deleted", 0));
            if (wf == null || !wf.getUserId().equals(userId)) {
                return Result.fail("无权访问此执行记录");
            }

            return Result.ok(exec);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 从指定步骤或失败步骤继续执行。
     */
    @PostMapping("/executions/{executionId}/resume")
    public Result<WorkflowDTO.ExecutionVO> resumeExecution(
            @PathVariable Long executionId,
            @RequestBody(required = false) WorkflowDTO.WorkflowResumeRequest request,
            @RequestAttribute Long userId) {
        try {
            WorkflowDTO.ExecutionVO source = workflowService.getExecution(executionId);
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", source.getWorkflowId()).eq("deleted", 0));
            if (wf == null || !wf.getUserId().equals(userId)) {
                return Result.fail("无权操作此执行记录");
            }
            if ("running".equals(source.getStatus())) {
                return Result.fail("原执行仍在运行，不能续执行");
            }

            String fromStepId = request != null ? request.getFromStepId() : null;
            if (fromStepId == null || fromStepId.isBlank()) {
                fromStepId = workflowService.findFirstFailedOrCancelledStepId(executionId);
            }
            if (fromStepId == null || fromStepId.isBlank()) {
                return Result.fail("未找到可续执行的失败或取消步骤");
            }

            Map<String, Object> checkpointOutputs =
                    workflowService.collectCompletedStepOutputsBefore(executionId, fromStepId);
            Map<String, Object> resumeInput = new LinkedHashMap<>();
            resumeInput.put("_resume", true);
            resumeInput.put("sourceExecutionId", executionId);
            resumeInput.put("fromStepId", fromStepId);
            resumeInput.put("checkpointSteps", checkpointOutputs.keySet());

            var execution = workflowService.createExecution(
                    source.getWorkflowId(),
                    userId,
                    "resume",
                    objectMapper.writeValueAsString(resumeInput));
            final Long newExecutionId = execution.getId();
            final String startStepId = fromStepId;
            final Map<String, Object> restoredOutputs = new LinkedHashMap<>(checkpointOutputs);

            new Thread(() -> {
                try {
                    workflowScheduler.resumeWorkflow(
                            source.getWorkflowId(),
                            userId,
                            newExecutionId,
                            startStepId,
                            restoredOutputs);
                } catch (Exception e) {
                    log.error("[Workflow] 续执行失败 sourceExecutionId={}, newExecutionId={}, error={}",
                            executionId, newExecutionId, e.getMessage());
                    try {
                        workflowService.completeExecution(newExecutionId, false, null, null, e.getMessage());
                    } catch (Exception ex) {
                        log.error("[Workflow] 记录续执行失败状态出错: {}", ex.getMessage());
                    }
                }
            }, "workflow-resume-" + newExecutionId).start();

            return Result.ok(workflowService.getExecution(newExecutionId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        } catch (Exception e) {
            log.error("[Workflow] 续执行异常: {}", e.getMessage(), e);
            return Result.fail("续执行失败: " + e.getMessage());
        }
    }

    /**
     * 订阅执行实时进度（SSE）。
     * <p>
     * 事件：
     * - snapshot：完整执行详情，包含 steps/events
     * - execution_event：新增执行事件
     * - heartbeat：连接保活
     * - done：执行进入终态并关闭连接
     */
    @GetMapping(value = "/executions/{executionId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamExecution(
            @PathVariable Long executionId,
            @RequestAttribute Long userId) {
        SseEmitter emitter = new SseEmitter(1_800_000L);

        WorkflowDTO.ExecutionVO exec;
        try {
            exec = workflowService.getExecution(executionId);
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", exec.getWorkflowId()).eq("deleted", 0));
            if (wf == null || !wf.getUserId().equals(userId)) {
                sendSseError(emitter, "无权访问此执行记录");
                return emitter;
            }
        } catch (RuntimeException e) {
            sendSseError(emitter, e.getMessage());
            return emitter;
        }

        WorkflowExecutionEventBus.Subscription subscription = workflowExecutionEventBus.subscribe(executionId);
        emitter.onCompletion(() -> workflowExecutionEventBus.unsubscribe(subscription));
        emitter.onTimeout(() -> workflowExecutionEventBus.unsubscribe(subscription));
        emitter.onError(e -> workflowExecutionEventBus.unsubscribe(subscription));

        new Thread(() -> {
            long lastEventId = maxEventId(exec);
            try {
                sendSse(emitter, "snapshot", exec);
                boolean terminal = isTerminalExecutionStatus(exec.getStatus());
                int idleTicks = 0;

                while (!terminal && idleTicks < 1800) {
                    WorkflowDTO.ExecutionEventVO event = subscription.poll();
                    if (event == null) {
                        WorkflowDTO.ExecutionVO latest = workflowService.getExecution(executionId);
                        sendSse(emitter, "heartbeat", Map.of(
                                "executionId", executionId,
                                "status", latest.getStatus(),
                                "lastEventId", lastEventId
                        ));
                        terminal = isTerminalExecutionStatus(latest.getStatus());
                        idleTicks++;
                        if (terminal) {
                            sendSse(emitter, "snapshot", latest);
                            sendSse(emitter, "done", latest);
                            emitter.complete();
                            return;
                        }
                        continue;
                    }

                    if (event.getId() != null && event.getId() > lastEventId) {
                        sendSse(emitter, "execution_event", event);
                        lastEventId = event.getId();
                    }

                    if (isTerminalEvent(event.getEventType())) {
                        WorkflowDTO.ExecutionVO latest = workflowService.getExecution(executionId);
                        sendSse(emitter, "snapshot", latest);
                        sendSse(emitter, "done", latest);
                        emitter.complete();
                        return;
                    }
                }

                emitter.complete();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                emitter.complete();
            } catch (Exception e) {
                log.warn("[Workflow] SSE 执行流异常 executionId={}, error={}", executionId, e.getMessage());
                emitter.completeWithError(e);
            }
        }, "workflow-stream-" + executionId).start();

        return emitter;
    }

    /**
     * 获取当前用户所有正在运行的执行记录
     * <p>
     * 用于前端恢复"离开页面后仍在执行的任务"——页面加载时调用，
     * 自动加入轮询列表。
     */
    @GetMapping("/executions/running")
    public Result<List<WorkflowDTO.ExecutionBriefVO>> listRunningExecutions(
            @RequestAttribute Long userId) {
        try {
            return Result.ok(workflowService.listRunningExecutions(userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    private boolean isTerminalExecutionStatus(String status) {
        return status != null && List.of("success", "failed", "cancelled").contains(status);
    }

    private boolean isTerminalEvent(String eventType) {
        return eventType != null && List.of(
                "workflow_completed",
                "workflow_failed",
                "workflow_cancelled",
                "workflow_ai_finished",
                "workflow_ai_max_turns"
        ).contains(eventType);
    }

    private long maxEventId(WorkflowDTO.ExecutionVO exec) {
        if (exec == null || exec.getEvents() == null || exec.getEvents().isEmpty()) {
            return 0L;
        }
        return exec.getEvents().stream()
                .map(WorkflowDTO.ExecutionEventVO::getId)
                .filter(java.util.Objects::nonNull)
                .mapToLong(Long::longValue)
                .max()
                .orElse(0L);
    }

    private void sendSse(SseEmitter emitter, String eventName, Object data) throws IOException {
        emitter.send(SseEmitter.event()
                .name(eventName)
                .data(objectMapper.writeValueAsString(data)));
    }

    private void sendSseError(SseEmitter emitter, String message) {
        try {
            emitter.send(SseEmitter.event()
                    .name("error")
                    .data("{\"message\":" + objectMapper.writeValueAsString(message) + "}"));
            emitter.complete();
        } catch (IOException e) {
            emitter.completeWithError(e);
        }
    }

    /**
     * 停止正在执行的工作流
     */
    @PostMapping("/executions/{executionId}/stop")
    public Result<Void> stopExecution(
            @PathVariable Long executionId,
            @RequestAttribute Long userId) {
        try {
            // 校验归属权
            WorkflowDTO.ExecutionVO exec = workflowService.getExecution(executionId);
            Workflow wf = workflowMapper.selectOne(
                    new QueryWrapper<Workflow>().eq("id", exec.getWorkflowId()).eq("deleted", 0));
            if (wf == null || !wf.getUserId().equals(userId)) {
                return Result.fail("无权操作此执行记录");
            }

            // 1. 中断运行线程
            boolean interrupted = workflowScheduler.stopExecution(executionId);

            // 2. 更新数据库状态
            workflowService.stopExecution(executionId, userId);

            log.info("[Workflow] 执行 {} 已停止 (interrupted={})", executionId, interrupted);
            return Result.ok();
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // AI 生成 DSL（SSE 流式）
    // =============================================

    /**
     * AI 自然语言生成工作流 DSL（SSE 流式输出）
     * <p>
     * 前端发送自然语言描述，后端通过 AI 解析生成 DSL JSON，
     * 以 SSE 流式返回。完成后发送最终的完整 DSL。
     */
    @PostMapping(value = "/generate", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter generateDsl(
            @RequestBody WorkflowDTO.WorkflowGenerateRequest request,
            @RequestAttribute Long userId) {

        String naturalLang = request.getNaturalLanguage();
        SseEmitter emitter = new SseEmitter(120_000L); // 2 分钟超时

        if (naturalLang == null || naturalLang.trim().isEmpty()) {
            try {
                emitter.send(SseEmitter.event()
                        .name("error")
                        .data("{\"message\":\"自然语言描述不能为空\"}"));
                emitter.complete();
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
            return emitter;
        }

        log.info("[Workflow] AI 生成 DSL 请求: {}... (userId={})",
                naturalLang.length() > 50 ? naturalLang.substring(0, 50) + "..." : naturalLang, userId);

        // 异步执行 AI 调用
        new Thread(() -> {
            try {
                String systemPrompt = buildDslGenerationPrompt();
                AiService.AiResult result = aiService.chat(
                        "auto",                   // 使用自动路由
                        systemPrompt,
                        null,                     // 无历史
                        naturalLang,              // 用户输入 = 自然语言描述
                        0.7,
                        4096);

                if (result != null && result.content() != null) {
                    // ★ 计费追踪 — AI DSL 生成
                    try {
                        usageTrackingService.trackFull(userId,
                                result.model() != null ? result.model() : "auto",
                                result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                                result.latencyMs(), "workflow_dsl_gen", null);
                    } catch (Exception ex) {
                        log.warn("[Workflow] 计费追踪失败: {}", ex.getMessage());
                    }

                    // 提取 JSON（AI 可能在 JSON 前后添加说明文字）
                    String dsl = extractJson(result.content());
                    if (dsl != null) {
                        // 验证 DSL 合法性
                        try {
                            workflowParser.validate(dsl);
                        } catch (RuntimeException e) {
                            emitter.send(SseEmitter.event()
                                    .name("error")
                                    .data("{\"message\":\"AI 生成的 DSL 格式有误: " + e.getMessage() + "\"}"));
                            emitter.complete();
                            return;
                        }

                        // 发送 token 事件（逐段发送）
                        emitter.send(SseEmitter.event()
                                .name("token")
                                .data("{\"message\":" + objectMapper.writeValueAsString(dsl) + "}"));
                        // 发送 done 事件
                        emitter.send(SseEmitter.event()
                                .name("done")
                                .data("{\"message\":" + objectMapper.writeValueAsString(dsl)
                                        + ",\"status\":\"success\"}"));

                        log.info("[Workflow] AI DSL 生成成功, 长度={}", dsl.length());
                    } else {
                        // AI 没有返回有效 JSON，直接返回原始内容
                        emitter.send(SseEmitter.event()
                                .name("token")
                                .data("{\"message\":" + objectMapper.writeValueAsString(result.content()) + "}"));
                        emitter.send(SseEmitter.event()
                                .name("done")
                                .data("{\"message\":" + objectMapper.writeValueAsString(result.content())
                                        + ",\"status\":\"raw\"}"));
                    }
                } else {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data("{\"message\":\"AI 未返回有效内容\"}"));
                }

                emitter.complete();
            } catch (Exception e) {
                log.error("[Workflow] AI DSL 生成失败: {}", e.getMessage());
                try {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data("{\"message\":\"AI 生成失败: " + e.getMessage() + "\"}"));
                    emitter.complete();
                } catch (IOException ex) {
                    emitter.completeWithError(ex);
                }
            }
        }, "workflow-gen-" + System.currentTimeMillis()).start();

        return emitter;
    }

    // =============================================
    // 验证 DSL（无需持久化）
    // =============================================

    /**
     * 验证 DSL 是否合法（不创建/更新工作流）
     */
    @PostMapping("/validate-dsl")
    public Result<Map<String, Object>> validateDsl(
            @RequestBody Map<String, String> body) {

        String dsl = body.get("dsl");
        if (dsl == null || dsl.trim().isEmpty()) {
            return Result.fail("DSL 不能为空");
        }

        try {
            workflowParser.validate(dsl);
            WorkflowParser.ParsedDsl parsed = workflowParser.parse(dsl);

            Map<String, Object> info = new LinkedHashMap<>();
            info.put("valid", true);
            info.put("triggerType", parsed.getTriggerType());
            info.put("cronExpr", parsed.getCronExpr());
            info.put("stepCount", parsed.getSteps() != null ? parsed.getSteps().size() : 0);

            return Result.ok(info);
        } catch (RuntimeException e) {
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("valid", false);
            info.put("error", e.getMessage());
            return Result.ok(info);
        }
    }

    // =============================================
    // 私有辅助方法
    // =============================================

    /**
     * 构建 AI 生成 DSL 的系统提示词
     */
    private String buildDslGenerationPrompt() {
        return """
                你是一个工作流 DSL 生成器。根据用户的自然语言描述，生成一个 JSON 格式的工作流定义。

                工作流 DSL 格式要求：
                ```json
                {
                  "trigger": {
                    "type": "cron",        // 触发类型：cron（定时）或 manual（手动）
                    "value": "0 8 * * *"   // cron 表达式（type 为 cron 时必填）
                  },
                  "steps": [
                    {
                      "id": "step1",        // 步骤唯一标识
                      "tool": "tool_name",  // 工具名称
                      "description": "步骤描述",
                      "condition": "step0.success",  // 可选：执行条件（引用前置步骤结果）
                      "args": {             // 可选：工具参数
                        "key": "value"
                      }
                    }
                  ]
                }
                ```

                规则：
                1. 根据描述推断触发方式：有明确时间/周期 → cron，否则 → manual
                2. 每个步骤必须有 id 和 tool 字段
                3. 工具名使用英文小写下划线格式
                4. 如有顺序依赖，为后续步骤添加 condition 字段
                5. **只输出 JSON**，不要有任何额外说明、markdown 标记或代码块包裹
                6. JSON 必须可被标准解析器解析

                现在，根据下面的描述生成工作流 DSL：""";
    }

    /**
     * 从 AI 返回的内容中提取 JSON
     */
    private String extractJson(String content) {
        if (content == null) return null;

        String trimmed = content.trim();

        // 尝试去除 markdown 代码块包裹
        if (trimmed.startsWith("```")) {
            int start = trimmed.indexOf('\n');
            if (start > 0) {
                int end = trimmed.lastIndexOf("```");
                if (end > start) {
                    trimmed = trimmed.substring(start + 1, end).trim();
                }
            }
        }

        // 找到第一个 { 和最后一个 }
        int braceStart = trimmed.indexOf('{');
        int braceEnd = trimmed.lastIndexOf('}');
        if (braceStart >= 0 && braceEnd > braceStart) {
            return trimmed.substring(braceStart, braceEnd + 1);
        }

        return null;
    }
}
