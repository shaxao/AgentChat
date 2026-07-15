package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.WorkflowArtifact;
import com.aiplatform.backend.mapper.AgentRegistryMapper;
import com.aiplatform.backend.mapper.WorkflowArtifactMapper;
import com.aiplatform.backend.service.impl.OssServiceFactory;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.hssf.usermodel.HSSFWorkbook;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.*;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.lang.reflect.Method;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 统一工具服务（战略改造 v2.0 P2-2）
 * <p>
 * 合并 Agent 系统（AgentRegistryService.executeScriptTool）和 Workflow 系统
 * （WorkflowToolRegistry）的工具调用入口，提供单一 {@link #execute} 方法：
 * <ul>
 *   <li>内置工具（ai_chat / web_search）→ 直接调用</li>
 *   <li>Agent Skill 脚本工具 → 委托 AgentRegistryService 执行</li>
 * </ul>
 * <p>
 * 替代了以下冗余类：
 * {@code WorkflowToolRegistry}, {@code WorkflowToolExecutor},
 * {@code AiChatToolExecutor}, {@code WebSearchToolExecutor}
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class UnifiedToolService {

    private static final long MAX_EXTRACTABLE_DOCUMENT_BYTES = 25L * 1024 * 1024;
    private static final int MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

    private final AiService aiService;
    private final AgentRegistryService agentRegistryService;
    private final AgentRegistryMapper agentRegistryMapper;
    private final WorkflowArtifactMapper workflowArtifactMapper;
    private final ObjectMapper objectMapper;
    private final UsageTrackingService usageTrackingService;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    // ─── 内置工具名常量 ─────────────────────────────────

    /** AI 对话工具 */
    public static final String TOOL_AI_CHAT = "ai_chat";
    /** Web 搜索工具 */
    public static final String TOOL_WEB_SEARCH = "web_search";
    /** 多 Agent 协作调用工具（P3-3） */
    public static final String TOOL_AGENT_CALL = "agent_call";
    /** 工作流文件资产引用工具 */
    public static final String TOOL_FILE_UPLOAD = "file_upload";
    /** 图片识别工具 */
    public static final String TOOL_IMAGE_RECOGNITION = "image_recognition";
    /** 音频转写工具 */
    public static final String TOOL_AUDIO_TRANSCRIBE = "audio_transcribe";
    /** 大文档分段处理工具 */
    public static final String TOOL_DOCUMENT_CHUNK_PROCESS = "document_chunk_process";
    /** 所有内置工具名列表 */
    public static final List<String> BUILTIN_TOOLS = List.of(
            TOOL_AI_CHAT,
            TOOL_WEB_SEARCH,
            TOOL_AGENT_CALL,
            TOOL_FILE_UPLOAD,
            TOOL_IMAGE_RECOGNITION,
            TOOL_AUDIO_TRANSCRIBE,
            TOOL_DOCUMENT_CHUNK_PROCESS);

    // ─── 公共 API ─────────────────────────────────

    /**
     * 执行任意工具（统一入口）
     *
     * @param toolName 工具名（ai_chat / web_search / Agent Skill 工具名）
     * @param args     工具参数 Map
     * @return 工具执行结果（JSON 字符串）
     */
    public String execute(String toolName, Map<String, Object> args) throws Exception {
        if (toolName == null || toolName.trim().isEmpty()) {
            return errorResult("工具名不能为空", toolName);
        }

        // 1. 内置工具
        if (TOOL_AI_CHAT.equals(toolName)) {
            return executeAiChat(args);
        }
        if (TOOL_WEB_SEARCH.equals(toolName)) {
            return executeWebSearch(args);
        }
        if (TOOL_AGENT_CALL.equals(toolName)) {
            return executeAgentCall(args);
        }
        if (TOOL_FILE_UPLOAD.equals(toolName)) {
            return executeFileUpload(args);
        }
        if (TOOL_IMAGE_RECOGNITION.equals(toolName)) {
            return executeImageRecognition(args);
        }
        if (TOOL_AUDIO_TRANSCRIBE.equals(toolName)) {
            return executeAudioTranscribe(args);
        }
        if (TOOL_DOCUMENT_CHUNK_PROCESS.equals(toolName)) {
            return executeDocumentChunkProcess(args);
        }

        // 2. Agent Skill 脚本工具 — 委托 AgentRegistryService
        try {
            return agentRegistryService.executeToolByName(toolName, toJson(args));
        } catch (Exception e) {
            log.error("[UnifiedTool] Agent 脚本工具 {} 执行失败: {}", toolName, e.getMessage());
            return errorResult("Agent 脚本工具执行失败: " + e.getMessage(), toolName);
        }
    }

    /**
     * 测试工具 — 与 execute 相同，但提供结构化返回
     */
    public Map<String, Object> testTool(String toolName, Map<String, Object> args) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("toolName", toolName);
        result.put("args", args);

        long startMs = System.currentTimeMillis();
        try {
            String output = execute(toolName, args);
            long elapsed = System.currentTimeMillis() - startMs;
            result.put("success", true);
            result.put("output", output);
            result.put("elapsedMs", elapsed);
            result.put("outputPreview", output.length() > 500 ? output.substring(0, 500) + "..." : output);
        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - startMs;
            result.put("success", false);
            result.put("error", e.getMessage());
            result.put("elapsedMs", elapsed);
        }
        return result;
    }

    /**
     * 列出所有可用工具名
     */
    public List<String> listTools() {
        return new java.util.ArrayList<>(BUILTIN_TOOLS);
    }

    /**
     * 判断工具是否存在
     */
    public boolean hasTool(String toolName) {
        return BUILTIN_TOOLS.contains(toolName) || agentRegistryService.hasAgentTool(toolName);
    }

    // ─── 内置工具实现 ─────────────────────────────────

    /**
     * AI 对话工具
     * DSL: { "tool": "ai_chat", "args": { "prompt": "...", "system_prompt": "..." } }
     */
    private String executeAiChat(Map<String, Object> args) throws Exception {
        // userId 从 args 中提取（由 WorkflowScheduler 注入）
        Long userId = args != null && args.get("_userId") instanceof Number
                ? ((Number) args.get("_userId")).longValue() : null;

        String prompt = args != null
                ? (String) args.getOrDefault("prompt", args.getOrDefault("query", "你好"))
                : "你好";
        String systemPrompt = args != null ? (String) args.get("system_prompt") : null;

        log.info("[UnifiedTool/ai_chat] prompt={}..., userId={}",
                prompt.length() > 50 ? prompt.substring(0, 50) + "..." : prompt, userId);

        long startMs = System.currentTimeMillis();
        AiService.AiResult result = aiService.chat(
                "auto",
                systemPrompt != null ? systemPrompt : "你是一个智能助手，请简洁准确地回答问题。",
                null,
                prompt,
                0.7,
                2048);

        String content = result != null ? result.content() : "";
        int latencyMs = (int)(System.currentTimeMillis() - startMs);

        // ★ 计费追踪
        if (userId != null && result != null) {
            String usedModel = result.model() != null ? result.model() : "auto";
            usageTrackingService.trackFull(userId, usedModel,
                    result.inputTokens(), result.cachedInputTokens(), result.outputTokens(), latencyMs,
                    "workflow", null, extractRequestIp(args), null, null);
        }

        log.info("[UnifiedTool/ai_chat] 完成, 输出长度={}", content.length());
        return String.format("{\"result\": %s}", objectMapper.writeValueAsString(content));
    }

    /**
     * Web 搜索工具
     * DSL: { "tool": "web_search", "args": { "query": "..." } }
     */
    private String executeWebSearch(Map<String, Object> args) throws Exception {
        String query = args != null ? (String) args.get("query") : null;
        if (query == null || query.trim().isEmpty()) {
            return "{\"error\": \"搜索关键词为空\"}";
        }

        log.info("[UnifiedTool/web_search] query={}", query);

        try {
            String encodedQuery = URLEncoder.encode(query, StandardCharsets.UTF_8);
            String url = "https://api.duckduckgo.com/?q=" + encodedQuery + "&format=json&no_html=1&skip_disambig=1";

            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(15))
                    .header("User-Agent", "MuhuoAi-Workflow/1.0")
                    .GET()
                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200) {
                String body = response.body();
                log.info("[UnifiedTool/web_search] 完成, 结果长度={}", body.length());
                return body;
            } else {
                return String.format("{\"error\": \"搜索请求失败, HTTP %d\", \"query\": \"%s\"}",
                        response.statusCode(), escapeJson(query));
            }
        } catch (Exception e) {
            log.error("[UnifiedTool/web_search] 异常: {}", e.getMessage());
            return String.format("{\"error\": \"搜索异常: %s\", \"query\": \"%s\"}",
                    escapeJson(e.getMessage()), escapeJson(query));
        }
    }

    /**
     * 多 Agent 协作调用工具（P3-3）
     * DSL: { "tool": "agent_call", "args": { "agent": "ban-biao", "prompt": "...", "context": "..." } }
     * <p>
     * 根据 agent 名称或 ID 查找对应的 Agent，使用其系统提示词执行 AI 对话。
     * 支持工作流中链式调用多个 Agent（台账Agent → 成本Agent → 报表Agent → 通知Agent）。
     */
    private String executeAgentCall(Map<String, Object> args) throws Exception {
        // userId 从 args 中提取（由 WorkflowScheduler 注入）
        Long userId = args != null && args.get("_userId") instanceof Number
                ? ((Number) args.get("_userId")).longValue() : null;

        String agentName = args != null ? (String) args.get("agent") : null;
        String prompt = args != null ? (String) args.get("prompt") : null;
        String context = args != null ? (String) args.get("context") : null;

        if (agentName == null || agentName.trim().isEmpty()) {
            return "{\"error\": \"agent_call 缺少 agent 参数\"}";
        }
        if (prompt == null || prompt.trim().isEmpty()) {
            return "{\"error\": \"agent_call 缺少 prompt 参数\"}";
        }

        // 查找 Agent（支持 agentId 或 id 查找）
        AgentRegistry agent = null;
        // 先按 agentId 查找
        var agents = agentRegistryMapper.selectList(
                new LambdaQueryWrapper<AgentRegistry>()
                        .eq(AgentRegistry::getAgentId, agentName)
                        .in(AgentRegistry::getStatus, List.of("approved", "active")));
        if (!agents.isEmpty()) {
            agent = agents.get(0);
        }

        // 如果没找到，尝试按 ID 查找
        if (agent == null) {
            try {
                Long agentId = Long.parseLong(agentName);
                agent = agentRegistryMapper.selectOne(
                        new LambdaQueryWrapper<AgentRegistry>()
                                .eq(AgentRegistry::getId, agentId)
                                .in(AgentRegistry::getStatus, List.of("approved", "active")));
            } catch (NumberFormatException ignored) {}
        }

        if (agent == null) {
            return String.format("{\"error\": \"Agent 未找到或不可用: %s\", \"agent\": \"%s\"}",
                    escapeJson(agentName), escapeJson(agentName));
        }

        // 构建系统提示词
        StringBuilder systemPromptBuilder = new StringBuilder();
        systemPromptBuilder.append("你是「").append(agent.getName()).append("」Agent。\n");
        if (agent.getSystemPrompt() != null && !agent.getSystemPrompt().trim().isEmpty()) {
            systemPromptBuilder.append(agent.getSystemPrompt());
        } else {
            systemPromptBuilder.append("请根据你的专业知识完成任务。");
        }

        // 如果有上下文，追加到系统提示词
        if (context != null && !context.trim().isEmpty()) {
            systemPromptBuilder.append("\n\n## 上下文信息\n").append(context);
        }

        String systemPrompt = systemPromptBuilder.toString();

        // 构建用户消息
        StringBuilder userMessage = new StringBuilder();
        if (agent.getDescription() != null && !agent.getDescription().trim().isEmpty()) {
            userMessage.append("任务背景：").append(agent.getDescription()).append("\n\n");
        }
        userMessage.append(prompt);

        log.info("[UnifiedTool/agent_call] agent={} ({}), prompt length={}",
                agent.getAgentId(), agent.getName(), prompt.length());

        // 调用 AI（使用 Agent 推荐的模型或 auto）
        String model = agent.getModel() != null && !agent.getModel().trim().isEmpty()
                ? agent.getModel() : "auto";
        double temperature = agent.getTemperature() != null ? agent.getTemperature() : 0.7;
        int maxTokens = agent.getMaxTokens() != null ? agent.getMaxTokens() : 2048;

        AiService.AiResult result = aiService.chat(
                model, systemPrompt, null, userMessage.toString(), temperature, maxTokens);

        String content = result != null ? result.content() : "";
        int latencyMs = result != null ? result.latencyMs() : 0;

        // ★ 计费追踪
        if (userId != null && result != null) {
            String usedModel = result.model() != null ? result.model() : model;
            String agentId = agent.getAgentId();
            // 非内置 Agent 有分成
            usageTrackingService.trackFull(userId, usedModel,
                    result.inputTokens(), result.cachedInputTokens(), result.outputTokens(), latencyMs,
                    "agent", !Boolean.TRUE.equals(agent.getIsBuiltin()) ? agentId : null,
                    extractRequestIp(args), null, null);
        }

        log.info("[UnifiedTool/agent_call] agent={} 完成, 输出长度={}", agent.getAgentId(), content.length());

        // 包装为 JSON
        return String.format("{\"agent\":\"%s\",\"agent_name\":\"%s\",\"result\":%s}",
                escapeJson(agent.getAgentId()),
                escapeJson(agent.getName()),
                objectMapper.writeValueAsString(content));
    }

    /**
     * 工作流文件资产引用工具。
     * <p>
     * 上传动作由 /api/workflow-artifacts/upload 完成；此工具在执行时把 artifact UUID/URL
     * 规范化成稳定输出，便于后续节点引用。
     */
    private String executeFileUpload(Map<String, Object> args) throws Exception {
        Long userId = extractUserId(args);
        ResolvedArtifact artifact = resolveArtifact(args, userId);
        if (artifact == null) {
            return errorResult("file_upload 需要 artifactUuid、artifactId、fileUrl 或 url 参数", TOOL_FILE_UPLOAD);
        }

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("schemaVersion", "workflow.native.v1");
        output.put("tool", TOOL_FILE_UPLOAD);
        output.put("artifact", artifact.toMap());
        output.put("text", artifact.fileName() != null ? artifact.fileName() : artifact.url());
        return objectMapper.writeValueAsString(output);
    }

    /**
     * 图片识别工具。
     * DSL: { "tool": "image_recognition", "args": { "artifactUuid": "...", "prompt": "..." } }
     */
    private String executeImageRecognition(Map<String, Object> args) throws Exception {
        Long userId = extractUserId(args);
        ResolvedArtifact artifact = resolveArtifact(args, userId);
        if (artifact == null || artifact.url() == null || artifact.url().isBlank()) {
            return errorResult("image_recognition 需要 artifactUuid、imageUrl、fileUrl 或 url 参数", TOOL_IMAGE_RECOGNITION);
        }
        if (!isImageArtifact(artifact)) {
            return errorResult("image_recognition 只支持图片文件，当前类型: " + artifact.fileType(), TOOL_IMAGE_RECOGNITION);
        }

        String prompt = stringArg(args, "prompt");
        if (prompt == null || prompt.isBlank()) {
            prompt = "请识别图片中的主要内容，提取关键文字，并返回可供后续工作流节点使用的结构化摘要。";
        }
        String model = stringArg(args, "model");

        long startMs = System.currentTimeMillis();
        AiService.AiResult aiResult = aiService.describeImages(
                model,
                prompt,
                List.of(artifact.url()));
        long elapsedMs = System.currentTimeMillis() - startMs;

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("schemaVersion", "workflow.native.v1");
        output.put("tool", TOOL_IMAGE_RECOGNITION);
        output.put("artifact", artifact.toMap());
        output.put("prompt", prompt);
        output.put("model", aiResult != null ? aiResult.model() : model);
        output.put("text", aiResult != null ? aiResult.content() : "");
        output.put("elapsedMs", elapsedMs);
        WorkflowArtifact derived = createDerivedTextArtifact(
                args,
                userId,
                artifact,
                "vision",
                "图片识别结果",
                aiResult != null ? aiResult.content() : "",
                Map.of(
                        "tool", TOOL_IMAGE_RECOGNITION,
                        "prompt", prompt,
                        "model", aiResult != null ? String.valueOf(aiResult.model()) : String.valueOf(model),
                        "sourceArtifactUuid", artifact.uuid() != null ? artifact.uuid() : ""));
        if (derived != null) {
            output.put("derivedArtifact", artifactToOutputMap(derived));
        }
        return objectMapper.writeValueAsString(output);
    }

    /**
     * 音频转写工具。
     * DSL: { "tool": "audio_transcribe", "args": { "artifactUuid": "..." } }
     */
    private String executeAudioTranscribe(Map<String, Object> args) throws Exception {
        Long userId = extractUserId(args);
        ResolvedArtifact artifact = resolveArtifact(args, userId);
        if (artifact == null || artifact.url() == null || artifact.url().isBlank()) {
            return errorResult("audio_transcribe 需要 artifactUuid、audioUrl、fileUrl 或 url 参数", TOOL_AUDIO_TRANSCRIBE);
        }
        if (!isAudioArtifact(artifact)) {
            return errorResult("audio_transcribe 只支持音频文件，当前类型: " + artifact.fileType(), TOOL_AUDIO_TRANSCRIBE);
        }

        long startMs = System.currentTimeMillis();
        String text = aiService.speechToText(artifact.url());
        long elapsedMs = System.currentTimeMillis() - startMs;

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("schemaVersion", "workflow.native.v1");
        output.put("tool", TOOL_AUDIO_TRANSCRIBE);
        output.put("artifact", artifact.toMap());
        output.put("text", text);
        output.put("elapsedMs", elapsedMs);
        WorkflowArtifact derived = createDerivedTextArtifact(
                args,
                userId,
                artifact,
                "asr",
                "音频转写结果",
                text,
                Map.of(
                        "tool", TOOL_AUDIO_TRANSCRIBE,
                        "sourceArtifactUuid", artifact.uuid() != null ? artifact.uuid() : ""));
        if (derived != null) {
            output.put("derivedArtifact", artifactToOutputMap(derived));
        }
        return objectMapper.writeValueAsString(output);
    }

    /**
     * Large text document segmented processing.
     * DSL: { "tool": "document_chunk_process", "args": { "artifactUuid": "...", "task": "summarize" } }
     */
    private String executeDocumentChunkProcess(Map<String, Object> args) throws Exception {
        Long userId = extractUserId(args);
        ResolvedArtifact artifact = resolveArtifact(args, userId);
        if (artifact == null) {
            return errorResult("document_chunk_process requires artifactUuid, artifactId, fileUrl or url", TOOL_DOCUMENT_CHUNK_PROCESS);
        }
        if (!isDocumentProcessableArtifact(artifact)) {
            return errorResult("document_chunk_process currently supports text, csv/xlsx/xls, docx and pdf artifacts. Current type: "
                    + artifact.fileType(), TOOL_DOCUMENT_CHUNK_PROCESS);
        }

        String task = firstStringArg(args, "task", "prompt", "instruction");
        if (task == null || task.isBlank()) {
            task = "Summarize this document segment and extract key facts, risks, decisions and action items.";
        }
        String model = stringArg(args, "model");
        int chunkBytes = clampInt(firstLongArg(args, "chunkBytes", "chunkSize"), 8 * 1024, 256 * 1024, 64 * 1024);
        int maxChunks = clampInt(firstLongArg(args, "maxChunks"), 1, 100, 20);
        int maxTokensPerChunk = clampInt(firstLongArg(args, "maxTokensPerChunk"), 256, 4096, 1200);

        long totalSize = artifact.fileSize() != null ? artifact.fileSize() : 0L;
        long startMs = System.currentTimeMillis();
        List<Map<String, Object>> chunkResults = new java.util.ArrayList<>();
        DocumentText documentText = null;

        if (requiresDocumentExtraction(artifact)) {
            documentText = extractDocumentText(artifact);
            if (documentText.text() == null || documentText.text().isBlank()) {
                return errorResult("document_chunk_process could not extract text from artifact: "
                        + artifact.fileName(), TOOL_DOCUMENT_CHUNK_PROCESS);
            }
            List<String> chunks = splitTextByChars(documentText.text(), Math.max(2000, chunkBytes / 2), maxChunks);
            for (int i = 0; i < chunks.size(); i++) {
                chunkResults.add(processDocumentChunk(model, task, chunks.get(i), i + 1, chunks.size(), maxTokensPerChunk));
            }
            totalSize = documentText.sourceBytes();
        } else if (artifact.contentText() != null && !artifact.contentText().isBlank()) {
            List<String> chunks = splitTextByChars(artifact.contentText(), Math.max(2000, chunkBytes / 2), maxChunks);
            for (int i = 0; i < chunks.size(); i++) {
                chunkResults.add(processDocumentChunk(model, task, chunks.get(i), i + 1, chunks.size(), maxTokensPerChunk));
            }
            totalSize = artifact.contentText().getBytes(StandardCharsets.UTF_8).length;
        } else {
            if (artifact.objectKey() == null || artifact.objectKey().isBlank()) {
                return errorResult("document_chunk_process requires artifact objectKey for range reading", TOOL_DOCUMENT_CHUNK_PROCESS);
            }
            var ossService = OssServiceFactory.getActive();
            if (ossService == null) {
                return errorResult("No active OSS configuration", TOOL_DOCUMENT_CHUNK_PROCESS);
            }
            long remaining = totalSize > 0 ? totalSize : (long) chunkBytes * maxChunks;
            int totalChunks = Math.max(1, (int) Math.ceil((double) remaining / chunkBytes));
            totalChunks = Math.min(totalChunks, maxChunks);
            for (int i = 0; i < totalChunks; i++) {
                long offset = (long) i * chunkBytes;
                int limit = (int) Math.min(chunkBytes, Math.max(0, remaining - offset));
                if (limit <= 0) break;
                byte[] bytes = ossService.readRange(artifact.objectKey(), offset, limit);
                String text = new String(bytes, StandardCharsets.UTF_8);
                chunkResults.add(processDocumentChunk(model, task, text, i + 1, totalChunks, maxTokensPerChunk));
            }
        }

        String combined = combineChunkSummaries(model, task, chunkResults);
        long elapsedMs = System.currentTimeMillis() - startMs;

        Map<String, Object> derivedMetadata = new LinkedHashMap<>();
        derivedMetadata.put("tool", TOOL_DOCUMENT_CHUNK_PROCESS);
        derivedMetadata.put("task", task);
        derivedMetadata.put("chunkBytes", chunkBytes);
        derivedMetadata.put("processedChunks", chunkResults.size());
        derivedMetadata.put("maxChunks", maxChunks);
        derivedMetadata.put("sourceArtifactUuid", artifact.uuid() != null ? artifact.uuid() : "");
        if (documentText != null) {
            derivedMetadata.put("extractionMethod", documentText.method());
            derivedMetadata.put("extractedChars", documentText.text().length());
            derivedMetadata.put("extractionTruncated", documentText.truncated());
        }

        WorkflowArtifact derived = createDerivedTextArtifact(
                args,
                userId,
                artifact,
                "document_parse",
                "document_chunk_process_result",
                combined,
                derivedMetadata);

        Map<String, Object> output = new LinkedHashMap<>();
        output.put("schemaVersion", "workflow.native.v1");
        output.put("tool", TOOL_DOCUMENT_CHUNK_PROCESS);
        output.put("artifact", artifact.toMap());
        output.put("task", task);
        output.put("chunkBytes", chunkBytes);
        output.put("processedChunks", chunkResults.size());
        output.put("totalSize", totalSize);
        if (documentText != null) {
            output.put("extractionMethod", documentText.method());
            output.put("extractedChars", documentText.text().length());
            output.put("extractionTruncated", documentText.truncated());
        }
        output.put("chunks", chunkResults);
        output.put("text", combined);
        output.put("elapsedMs", elapsedMs);
        if (derived != null) {
            output.put("derivedArtifact", artifactToOutputMap(derived));
        }
        return objectMapper.writeValueAsString(output);
    }

    // ─── 工具方法 ─────────────────────────────────

    private Long extractUserId(Map<String, Object> args) {
        Object raw = args != null ? args.get("_userId") : null;
        return raw instanceof Number ? ((Number) raw).longValue() : null;
    }

    private String extractRequestIp(Map<String, Object> args) {
        if (args == null) return null;
        Object raw = args.get("_requestIp");
        if (raw == null) raw = args.get("requestIp");
        if (raw == null) return null;
        String text = raw.toString().trim();
        return text.isEmpty() ? null : text;
    }

    private Long internalLongArg(Map<String, Object> args, String key) {
        Object raw = args != null ? args.get(key) : null;
        if (raw instanceof Number number) return number.longValue();
        if (raw instanceof String text && !text.isBlank()) {
            try {
                return Long.parseLong(text);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private WorkflowArtifact createDerivedTextArtifact(Map<String, Object> args,
                                                       Long userId,
                                                       ResolvedArtifact source,
                                                       String sourceType,
                                                       String defaultName,
                                                       String text,
                                                       Map<String, Object> metadata) {
        if (userId == null) {
            return null;
        }
        try {
            WorkflowArtifact artifact = new WorkflowArtifact();
            artifact.setUuid(UUID.randomUUID().toString());
            artifact.setUserId(userId);
            artifact.setWorkflowId(internalLongArg(args, "_workflowId"));
            artifact.setExecutionId(internalLongArg(args, "_executionId"));
            artifact.setStepId(stringArg(args, "_stepId"));
            artifact.setSourceType(sourceType);
            artifact.setFileName(buildDerivedFileName(source, defaultName, sourceType));
            artifact.setFileType("text");
            artifact.setMimeType("text/plain");
            artifact.setFileSize(text != null ? (long) text.getBytes(StandardCharsets.UTF_8).length : 0L);
            artifact.setContentText(text);
            artifact.setStatus("ready");

            Map<String, Object> meta = new LinkedHashMap<>(metadata != null ? metadata : Map.of());
            if (source != null) {
                meta.put("sourceArtifactId", source.id());
                meta.put("sourceArtifactUuid", source.uuid());
                meta.put("sourceFileName", source.fileName());
                meta.put("sourceUrl", source.url());
            }
            artifact.setMetadataJson(objectMapper.writeValueAsString(meta));
            workflowArtifactMapper.insert(artifact);
            return artifact;
        } catch (Exception e) {
            log.warn("[UnifiedTool] 派生资产写入失败 sourceType={}, error={}", sourceType, e.getMessage());
            return null;
        }
    }

    private String buildDerivedFileName(ResolvedArtifact source, String defaultName, String sourceType) {
        String base = source != null && source.fileName() != null && !source.fileName().isBlank()
                ? source.fileName()
                : defaultName;
        return base + "." + sourceType + ".txt";
    }

    @SuppressWarnings("unchecked")
    private ResolvedArtifact resolveArtifact(Map<String, Object> args, Long userId) {
        if (args == null || args.isEmpty()) return null;

        Object nested = args.get("artifact");
        if (nested instanceof Map<?, ?> nestedMap) {
            Map<String, Object> merged = new LinkedHashMap<>(args);
            nestedMap.forEach((k, v) -> {
                if (k != null) merged.put(String.valueOf(k), v);
            });
            args = merged;
        }

        String uuid = firstStringArg(args, "artifactUuid", "artifact_uuid", "uuid");
        if (uuid != null && !uuid.isBlank() && userId != null) {
            WorkflowArtifact artifact = workflowArtifactMapper.selectOne(
                    new QueryWrapper<WorkflowArtifact>()
                            .eq("uuid", uuid)
                            .eq("user_id", userId)
                            .eq("deleted", 0)
                            .last("LIMIT 1"));
            if (artifact != null) {
                return ResolvedArtifact.from(artifact);
            }
        }

        Long artifactId = firstLongArg(args, "artifactId", "artifact_id", "id");
        if (artifactId != null && userId != null) {
            WorkflowArtifact artifact = workflowArtifactMapper.selectOne(
                    new QueryWrapper<WorkflowArtifact>()
                            .eq("id", artifactId)
                            .eq("user_id", userId)
                            .eq("deleted", 0)
                            .last("LIMIT 1"));
            if (artifact != null) {
                return ResolvedArtifact.from(artifact);
            }
        }

        String url = firstStringArg(args, "fileUrl", "imageUrl", "audioUrl", "url", "ossUrl");
        if (url == null || url.isBlank()) return null;
        String mimeType = firstStringArg(args, "mimeType", "contentType");
        String fileName = firstStringArg(args, "fileName", "name");
        String fileType = firstStringArg(args, "fileType", "type");
        if (fileType == null || fileType.isBlank()) {
            fileType = inferFileType(fileName, mimeType, url);
        }
        return new ResolvedArtifact(null, null, url, null, fileName, fileType, mimeType, null, null);
    }

    private String stringArg(Map<String, Object> args, String key) {
        Object value = args != null ? args.get(key) : null;
        return value != null ? value.toString() : null;
    }

    private String firstStringArg(Map<String, Object> args, String... keys) {
        for (String key : keys) {
            String value = stringArg(args, key);
            if (value != null && !value.isBlank()) return value;
        }
        return null;
    }

    private Long firstLongArg(Map<String, Object> args, String... keys) {
        for (String key : keys) {
            Object value = args.get(key);
            if (value instanceof Number number) return number.longValue();
            if (value instanceof String text && !text.isBlank()) {
                try {
                    return Long.parseLong(text);
                } catch (NumberFormatException ignored) {
                    // Try the next alias.
                }
            }
        }
        return null;
    }

    private boolean isImageArtifact(ResolvedArtifact artifact) {
        return "image".equalsIgnoreCase(artifact.fileType())
                || (artifact.mimeType() != null && artifact.mimeType().startsWith("image/"));
    }

    private boolean isAudioArtifact(ResolvedArtifact artifact) {
        return "audio".equalsIgnoreCase(artifact.fileType())
                || (artifact.mimeType() != null && artifact.mimeType().startsWith("audio/"));
    }

    private boolean isDocumentProcessableArtifact(ResolvedArtifact artifact) {
        return isTextProcessableArtifact(artifact) || requiresDocumentExtraction(artifact);
    }

    private boolean isTextProcessableArtifact(ResolvedArtifact artifact) {
        String type = artifact.fileType() != null ? artifact.fileType().toLowerCase() : "";
        String mime = artifact.mimeType() != null ? artifact.mimeType().toLowerCase() : "";
        String name = artifact.fileName() != null ? artifact.fileName().toLowerCase() : "";
        return "text".equals(type)
                || mime.startsWith("text/")
                || mime.contains("json")
                || name.matches(".*\\.(txt|md|json|jsonl|csv|tsv|log)$");
    }

    private boolean requiresDocumentExtraction(ResolvedArtifact artifact) {
        String type = artifact.fileType() != null ? artifact.fileType().toLowerCase() : "";
        String mime = artifact.mimeType() != null ? artifact.mimeType().toLowerCase() : "";
        String name = artifact.fileName() != null ? artifact.fileName().toLowerCase() : "";
        return "spreadsheet".equals(type)
                || "document".equals(type)
                || "application/pdf".equals(mime)
                || "application/msword".equals(mime)
                || mime.contains("officedocument")
                || mime.contains("vnd.ms-excel")
                || name.matches(".*\\.(xlsx|xls|docx|doc|pdf)$");
    }

    private int clampInt(Long value, int min, int max, int fallback) {
        if (value == null) return fallback;
        return Math.max(min, Math.min(max, value.intValue()));
    }

    private DocumentText extractDocumentText(ResolvedArtifact artifact) {
        if (artifact.objectKey() == null || artifact.objectKey().isBlank()) {
            throw new IllegalArgumentException("document extraction requires artifact objectKey");
        }
        long declaredSize = artifact.fileSize() != null ? artifact.fileSize() : 0L;
        if (declaredSize > MAX_EXTRACTABLE_DOCUMENT_BYTES) {
            throw new IllegalArgumentException("document extraction supports files up to "
                    + (MAX_EXTRACTABLE_DOCUMENT_BYTES / 1024 / 1024) + "MB before provider-native streaming parser is configured");
        }
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalArgumentException("No active OSS configuration");
        }

        byte[] bytes = ossService.download(artifact.objectKey());
        String name = artifact.fileName() != null ? artifact.fileName().toLowerCase() : "";
        String mime = artifact.mimeType() != null ? artifact.mimeType().toLowerCase() : "";
        String text;
        String method;
        if (name.endsWith(".docx") || mime.contains("wordprocessingml")) {
            text = extractDocxText(bytes);
            method = "poi_docx";
        } else if (name.endsWith(".xlsx") || mime.contains("spreadsheetml")) {
            text = extractWorkbookText(bytes, false);
            method = "poi_xlsx";
        } else if (name.endsWith(".xls") || mime.contains("vnd.ms-excel")) {
            text = extractWorkbookText(bytes, true);
            method = "poi_xls";
        } else if (name.endsWith(".pdf") || "application/pdf".equals(mime)) {
            text = extractPdfTextIfAvailable(bytes);
            method = "pdfbox_optional";
        } else if (name.endsWith(".doc") || "application/msword".equals(mime)) {
            text = extractLegacyDocTextIfAvailable(bytes);
            method = "poi_scratchpad_optional";
        } else {
            text = new String(bytes, StandardCharsets.UTF_8);
            method = "utf8_fallback";
        }

        boolean truncated = text != null && text.length() > MAX_EXTRACTED_TEXT_CHARS;
        if (truncated) {
            text = text.substring(0, MAX_EXTRACTED_TEXT_CHARS);
        }
        return new DocumentText(text != null ? text : "", method, bytes.length, truncated);
    }

    private String extractDocxText(byte[] bytes) {
        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            StringBuilder sb = new StringBuilder();
            for (var element : doc.getBodyElements()) {
                if (element instanceof XWPFParagraph paragraph) {
                    appendLine(sb, paragraph.getText());
                } else if (element instanceof XWPFTable table) {
                    for (XWPFTableRow row : table.getRows()) {
                        List<String> cells = row.getTableCells().stream()
                                .map(XWPFTableCell::getText)
                                .toList();
                        appendLine(sb, String.join("\t", cells));
                    }
                }
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalArgumentException("DOCX text extraction failed: " + e.getMessage(), e);
        }
    }

    private String extractWorkbookText(byte[] bytes, boolean legacyXls) {
        try (Workbook workbook = legacyXls
                ? new HSSFWorkbook(new ByteArrayInputStream(bytes))
                : new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            DataFormatter formatter = new DataFormatter();
            StringBuilder sb = new StringBuilder();
            for (int s = 0; s < workbook.getNumberOfSheets(); s++) {
                Sheet sheet = workbook.getSheetAt(s);
                appendLine(sb, "# Sheet: " + sheet.getSheetName());
                for (Row row : sheet) {
                    StringBuilder rowText = new StringBuilder();
                    short lastCell = row.getLastCellNum();
                    for (int c = 0; c < lastCell; c++) {
                        if (c > 0) rowText.append('\t');
                        rowText.append(formatter.formatCellValue(row.getCell(c)));
                    }
                    appendLine(sb, rowText.toString());
                }
                appendLine(sb, "");
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalArgumentException((legacyXls ? "XLS" : "XLSX")
                    + " text extraction failed: " + e.getMessage(), e);
        }
    }

    private String extractPdfTextIfAvailable(byte[] bytes) {
        try {
            Class<?> loaderClass = Class.forName("org.apache.pdfbox.Loader");
            Method loadPdf = loaderClass.getMethod("loadPDF", byte[].class);
            Object document = loadPdf.invoke(null, bytes);
            try {
                Object stripper = Class.forName("org.apache.pdfbox.text.PDFTextStripper")
                        .getConstructor()
                        .newInstance();
                Method getText = stripper.getClass().getMethod("getText", document.getClass());
                return String.valueOf(getText.invoke(stripper, document));
            } finally {
                if (document instanceof AutoCloseable closeable) {
                    closeable.close();
                }
            }
        } catch (ClassNotFoundException e) {
            throw new IllegalArgumentException("PDF extraction requires PDFBox dependency before PDF artifacts can be chunked");
        } catch (Exception e) {
            throw new IllegalArgumentException("PDF text extraction failed: " + e.getMessage(), e);
        }
    }

    private String extractLegacyDocTextIfAvailable(byte[] bytes) {
        try {
            Object document = Class.forName("org.apache.poi.hwpf.HWPFDocument")
                    .getConstructor(java.io.InputStream.class)
                    .newInstance(new ByteArrayInputStream(bytes));
            try {
                Method getRange = document.getClass().getMethod("getRange");
                Object range = getRange.invoke(document);
                Method text = range.getClass().getMethod("text");
                return String.valueOf(text.invoke(range));
            } finally {
                if (document instanceof AutoCloseable closeable) {
                    closeable.close();
                }
            }
        } catch (ClassNotFoundException e) {
            throw new IllegalArgumentException("Legacy DOC extraction requires poi-scratchpad dependency; please upload DOCX when possible");
        } catch (Exception e) {
            throw new IllegalArgumentException("DOC text extraction failed: " + e.getMessage(), e);
        }
    }

    private void appendLine(StringBuilder sb, String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        sb.append(text.strip()).append('\n');
    }

    private List<String> splitTextByChars(String text, int chunkChars, int maxChunks) {
        if (text == null || text.isBlank()) return List.of();
        List<String> chunks = new java.util.ArrayList<>();
        int cursor = 0;
        while (cursor < text.length() && chunks.size() < maxChunks) {
            int end = Math.min(text.length(), cursor + chunkChars);
            chunks.add(text.substring(cursor, end));
            cursor = end;
        }
        return chunks;
    }

    private Map<String, Object> processDocumentChunk(String model,
                                                     String task,
                                                     String text,
                                                     int chunkIndex,
                                                     int totalChunks,
                                                     int maxTokens) {
        String prompt = "Task: " + task + "\n\n"
                + "Process chunk " + chunkIndex + " of " + totalChunks + ". "
                + "Return concise structured notes with facts, risks, decisions and action items when present.\n\n"
                + text;
        AiService.AiResult result = aiService.chat(
                model != null && !model.isBlank() ? model : "auto",
                "You process large documents chunk by chunk. Be accurate and avoid inventing details.",
                null,
                prompt,
                0.2,
                maxTokens);
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("index", chunkIndex);
        map.put("text", result != null ? result.content() : "");
        map.put("model", result != null ? result.model() : model);
        return map;
    }

    private String combineChunkSummaries(String model, String task, List<Map<String, Object>> chunkResults) {
        if (chunkResults == null || chunkResults.isEmpty()) return "";
        String joined = chunkResults.stream()
                .map(item -> "Chunk " + item.get("index") + ":\n" + String.valueOf(item.get("text")))
                .collect(java.util.stream.Collectors.joining("\n\n"));
        AiService.AiResult result = aiService.chat(
                model != null && !model.isBlank() ? model : "auto",
                "You merge chunk-level document analysis into one coherent final result. Do not add unsupported facts.",
                null,
                "Original task: " + task + "\n\nMerge these chunk notes into a final answer:\n\n" + joined,
                0.2,
                2000);
        return result != null ? result.content() : joined;
    }

    private String inferFileType(String fileName, String mimeType, String url) {
        String type = mimeType != null ? mimeType.toLowerCase() : "";
        String name = ((fileName != null ? fileName : url) != null ? (fileName != null ? fileName : url) : "").toLowerCase();
        if (type.startsWith("image/") || name.matches(".*\\.(png|jpg|jpeg|gif|webp|bmp)$")) return "image";
        if (type.startsWith("audio/") || name.matches(".*\\.(mp3|wav|ogg|aac|flac|m4a)$")) return "audio";
        if (type.startsWith("video/") || name.matches(".*\\.(mp4|mov|avi|mkv|webm)$")) return "video";
        if (name.matches(".*\\.(xlsx|xls|csv)$")) return "spreadsheet";
        if (name.matches(".*\\.(pdf|doc|docx)$")) return "document";
        if (name.matches(".*\\.(txt|md|json)$")) return "text";
        return "other";
    }

    private Map<String, Object> artifactToOutputMap(WorkflowArtifact artifact) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("id", artifact.getId());
        map.put("uuid", artifact.getUuid());
        map.put("workflowId", artifact.getWorkflowId());
        map.put("executionId", artifact.getExecutionId());
        map.put("stepId", artifact.getStepId());
        map.put("sourceType", artifact.getSourceType());
        map.put("fileName", artifact.getFileName());
        map.put("fileType", artifact.getFileType());
        map.put("mimeType", artifact.getMimeType());
        map.put("fileSize", artifact.getFileSize());
        map.put("contentText", artifact.getContentText());
        map.put("metadataJson", artifact.getMetadataJson());
        map.put("status", artifact.getStatus());
        return map;
    }

    private String toJson(Map<String, Object> args) {
        if (args == null) return "{}";
        try {
            return objectMapper.writeValueAsString(args);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String errorResult(String message, String toolName) {
        return String.format("{\"error\": \"%s\", \"tool_name\": \"%s\"}",
                escapeJson(message), escapeJson(toolName));
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private record DocumentText(String text, String method, long sourceBytes, boolean truncated) {}

    private record ResolvedArtifact(
            Long id,
            String uuid,
            String url,
            String objectKey,
            String fileName,
            String fileType,
            String mimeType,
            Long fileSize,
            String contentText) {
        static ResolvedArtifact from(WorkflowArtifact artifact) {
            return new ResolvedArtifact(
                    artifact.getId(),
                    artifact.getUuid(),
                    artifact.getOssUrl(),
                    artifact.getObjectKey(),
                    artifact.getFileName(),
                    artifact.getFileType(),
                    artifact.getMimeType(),
                    artifact.getFileSize(),
                    artifact.getContentText());
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("id", id);
            map.put("uuid", uuid);
            map.put("url", url);
            map.put("objectKey", objectKey);
            map.put("fileName", fileName);
            map.put("fileType", fileType);
            map.put("mimeType", mimeType);
            map.put("fileSize", fileSize);
            map.put("contentText", contentText);
            return map;
        }
    }
}
