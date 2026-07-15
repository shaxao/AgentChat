package com.aiplatform.backend.controller;

import com.aiplatform.backend.agent.AgentConfig;
import com.aiplatform.backend.agent.AgentSessionContext;
import com.aiplatform.backend.agent.ToolCallRecord;
import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.agent.ToolExecutor;
import com.aiplatform.backend.dto.ChatDTO;
import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.ApiLog;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.MemoryWorkFile;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.mapper.ApiLogMapper;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.MemoryWorkFileMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.service.AgentService;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.CacheLedgerClient;
import com.aiplatform.backend.service.ChatService;
import com.aiplatform.backend.service.IconStorageService;
import com.aiplatform.backend.service.HarnessEvolutionService;
import com.aiplatform.backend.service.MemoryService;
import com.aiplatform.backend.service.WalletService;
import com.aiplatform.backend.service.ToolResultStorageService;
import com.aiplatform.backend.service.ModelRoutingService;
import com.aiplatform.backend.service.PrivacySettingService;
import com.aiplatform.backend.service.UserPreferenceService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.aiplatform.backend.service.provider.SearchAdapter;
import com.aiplatform.backend.util.ClientIpUtil;
import com.aiplatform.backend.dto.ModelUsageEvent;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Slf4j
@RestController
@RequestMapping("/api/chat")
@RequiredArgsConstructor
public class ChatController {

    private final ChatService chatService;
    private final AiService aiService;
    private final IconStorageService iconStorageService;
    private final HarnessEvolutionService harnessEvolutionService;
    private final AgentService agentService;
    private final MemoryService memoryService;
    private final WalletService walletService;
    private final ToolResultStorageService toolResultStorageService;
    private final ModelRoutingService modelRoutingService;
    private final PrivacySettingService privacySettingService;
    private final UserPreferenceService userPreferenceService;
    private final UsageTrackingService usageTrackingService;
    private final CacheLedgerClient cacheLedgerClient;
    private final ObjectMapper objectMapper;
    private final ApiLogMapper apiLogMapper;
    private final SysUserMapper sysUserMapper;
    private final ChatConversationMapper conversationMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final SubscriptionPlanMapper subscriptionPlanMapper;
    private final ModelChannelMapper modelChannelMapper;
    private final ModelConfigMapper modelConfigMapper;
    private final MemoryWorkFileMapper workFileMapper;

    private final ExecutorService sseExecutor = Executors.newCachedThreadPool();

    /**
     * 当前请求的文件 URL 列表（ThreadLocal，供 read_uploaded_file 工具直接使用）。
     * 解决 work_file 表记录可能缺失/名称编码不匹配时文件找不到的问题。
     */
    private static final ThreadLocal<List<String>> currentRequestFileUrls = new ThreadLocal<>();

    /** 获取对话列表 */
    @GetMapping("/conversations")
    public Result<List<ChatDTO.ConversationVO>> listConversations(@RequestAttribute Long userId) {
        return Result.ok(chatService.listConversations(userId));
    }

    /** 创建对话 */
    @PostMapping("/conversations")
    public Result<ChatDTO.ConversationVO> createConversation(
            @RequestAttribute Long userId,
            @RequestBody ChatDTO.CreateConversationRequest req) {
        return Result.ok(chatService.createConversation(userId, req));
    }

    /** 获取单个对话（含消息，支持游标分页） */
    @GetMapping("/conversations/{uuid}")
    public Result<ChatDTO.ConversationVO> getConversation(
            @RequestAttribute Long userId,
            @PathVariable String uuid,
            @RequestParam(defaultValue = "500") int limit,
            @RequestParam(required = false) String before) {
        return Result.ok(chatService.getConversation(userId, uuid, limit, before));
    }

    /** User-facing available model list. Applies backend enabled state, active chat channels and subscription limits. */
    @GetMapping("/models")
    public Result<List<Map<String, Object>>> listAvailableModels(@RequestAttribute Long userId) {
        return Result.ok(buildAvailableModelsForUser(userId));
    }

    /** 更新对话信息 */
    @PutMapping("/conversations/{uuid}")
    public Result<ChatDTO.ConversationVO> updateConversation(
            @RequestAttribute Long userId,
            @PathVariable String uuid,
            @RequestBody ChatDTO.CreateConversationRequest req) {
        return Result.ok(chatService.updateConversation(userId, uuid, req));
    }

    /** 置顶/取消置顶 */
    @PostMapping("/conversations/{uuid}/pin")
    public Result<String> togglePin(@RequestAttribute Long userId, @PathVariable String uuid) {
        chatService.togglePin(userId, uuid);
        return Result.ok("操作成功");
    }

    /** 删除对话 */
    @DeleteMapping("/conversations/{uuid}")
    public Result<String> deleteConversation(@RequestAttribute Long userId, @PathVariable String uuid) {
        chatService.deleteConversation(userId, uuid);
        return Result.ok("删除成功");
    }

    /** 清空消息 */
    @DeleteMapping("/conversations/{uuid}/messages")
    public Result<String> clearMessages(@RequestAttribute Long userId, @PathVariable String uuid) {
        chatService.clearMessages(userId, uuid);
        return Result.ok("已清空");
    }

    /**
     * 生成图标（AI 图片生成）
     */
    @PostMapping("/generate-icon")
    public Result<Map<String, String>> generateIcon(@RequestBody Map<String, String> body) {
        String prompt = body.get("prompt");
        if (prompt == null || prompt.isBlank()) {
            return Result.fail("缺少 prompt 参数");
        }
        String size = body.getOrDefault("size", "1024x1024");
        try {
            String url = iconStorageService.persistRemoteIcon(aiService.generateImage(prompt, size), "chat-icon");
            return Result.ok(Map.of("url", url));
        } catch (Exception e) {
            log.error("[ChatController] 图标生成失败: {}", e.getMessage(), e);
            return Result.fail("图标生成失败: " + e.getMessage());
        }
    }

    /**
     * SSE 流式发送消息，完成后记录 ApiLog 并更新用户 token 用量
     */
    @PostMapping(value = "/conversations/{uuid}/messages/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter sendMessageStream(
            @RequestAttribute Long userId,
            @PathVariable String uuid,
            @RequestBody ChatDTO.SendMessageRequest req,
            HttpServletRequest httpRequest) {

        // Agent 模式需要更长超时（30分钟），普通模式3分钟
        boolean isAgent = req.getAgentId() != null && !req.getAgentId().isBlank();
        SseEmitter emitter = new SseEmitter(isAgent ? 1_800_000L : 180_000L);
        String requestIp = ClientIpUtil.getClientIp(httpRequest);

        sseExecutor.submit(() -> {
            final Long[] traceId = new Long[1];
            // 🔧 将当前请求的文件 URL 存入 ThreadLocal，供 read_uploaded_file 工具直接使用
            currentRequestFileUrls.set(req.getFileUrls());
            aiService.setThinkingTokenConsumer(thinking -> {
                try {
                    emitter.send(SseEmitter.event()
                            .name("thinking")
                            .data(objectMapper.writeValueAsString(Map.of("token", thinking))));
                } catch (Exception e) {
                    log.warn("SSE send thinking failed: {}", e.getMessage());
                }
            });
            try {
                // 检查用户订阅的模型限制
                String modelLimitError = checkModelLimit(userId, req.getModel());
                if (modelLimitError != null) {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data(objectMapper.writeValueAsString(Map.of("message", modelLimitError))));
                    emitter.complete();
                    return;
                }

                // ① 确保对话存在（H2 重启/数据丢失时自动重建，避免"对话不存在"导致 SSE 截断）
                chatService.ensureConversationExists(userId, uuid, req.getModel());
                ChatConversation traceConversation = conversationMapper.selectOne(
                        new LambdaQueryWrapper<ChatConversation>()
                                .eq(ChatConversation::getUuid, uuid)
                                .eq(ChatConversation::getUserId, userId)
                                .eq(ChatConversation::getDeleted, 0)
                                .orderByDesc(ChatConversation::getId)
                                .last("LIMIT 1"));
                traceId[0] = harnessEvolutionService.startTrace(
                        isAgent ? "chat_agent" : "chat",
                        userId,
                        traceConversation != null ? traceConversation.getId() : null,
                        uuid,
                        null,
                        req.getModel(),
                        null,
                        req.getContent(),
                        Map.of(
                                "agentId", req.getAgentId() != null ? req.getAgentId() : "",
                                "hasFiles", req.getFileUrls() != null && !req.getFileUrls().isEmpty(),
                                "thinking", Boolean.TRUE.equals(req.getThinking()),
                                "temperature", req.getTemperature() != null ? req.getTemperature() : 0.0
                        ),
                        Map.of(
                                "requestIp", requestIp,
                                "continueMessageId", req.getContinueMessageId() != null ? req.getContinueMessageId() : ""
                        ));
                harnessEvolutionService.addEvent(traceId[0], "lifecycle", "conversation_ready", Map.of("uuid", uuid));

                // ② 在保存当前消息之前，先加载历史上下文（不含当前消息）
                List<Map<String, String>> history = chatService.getHistoryForAi(userId, uuid);
                harnessEvolutionService.addEvent(traceId[0], "context", "history_loaded", Map.of("messageCount", history != null ? history.size() : 0));

                ChatDTO.MessageVO userMsg = chatService.saveUserMessage(userId, uuid, req.getContent());
                emitter.send(SseEmitter.event()
                        .name("user")
                        .data(objectMapper.writeValueAsString(Map.of("msgId", userMsg.getId()))));

                // 🔧 自动保存文件为工作文件（弥补上传时对话尚未创建的情况）
                autoSaveWorkFiles(userId, uuid, req.getFileUrls());

                StringBuilder fullContent = new StringBuilder();

                // ② 判断是否为 Agent 模式
                boolean isAgentMode = req.getAgentId() != null && !req.getAgentId().isBlank();

                if (isAgentMode) {
                    // ===== Agent 模式：使用 streamChatWithTools =====
                    AgentConfig agentConfig = agentService.getAgentConfig(req.getAgentId());

                    // 设置会话上下文（userId + conversationUuid 作为 sessionId）
                    String agentSessionId = userId + "-" + uuid;

                    // 将前端上传的文件路径存入会话上下文，供工具直接使用
                    if (req.getUploadedFilePaths() != null && !req.getUploadedFilePaths().isEmpty()) {
                        AgentSessionContext.setUploadedFilePaths(req.getUploadedFilePaths());
                    }

                    // 构建消息列表（兼容 tool role，使用 Map<String, Object>）
                    List<Map<String, Object>> agentMessages = new ArrayList<>();
                    for (Map<String, String> h : history) {
                        Map<String, Object> msg = new LinkedHashMap<>();
                        msg.put("role", h.get("role"));
                        msg.put("content", h.get("content"));
                        agentMessages.add(msg);
                    }

                    // 🔧 确定生效模型（提前到图片处理之前，用于 Vision 路由判断）
                    // 优先：用户指定模型 → Agent配置模型 → 智能路由选择
                    String rawModel = req.getModel() != null && !req.getModel().isBlank()
                            ? req.getModel() : agentConfig.model();
                    boolean agentHasImages = (req.getFileUrls() != null && !req.getFileUrls().isEmpty())
                            || (req.getImageBase64List() != null && !req.getImageBase64List().isEmpty());
                    String effectiveModel = resolveModelWithRouting(rawModel, true, agentHasImages, userId);
                    if (effectiveModel == null) {
                        effectiveModel = findAllowedAvailableModel(userId, agentHasImages ? List.of("vision") : List.of("tool"));
                        log.warn("[ModelRouting] Agent 路由返回 null, fallback: {} → {}", rawModel, effectiveModel);
                    }
                    String agentLimitError = checkModelLimit(userId, effectiveModel);
                    if (agentLimitError != null) {
                        harnessEvolutionService.failTrace(traceId[0], "model_limit", agentLimitError, "medium",
                                Map.of("model", effectiveModel != null ? effectiveModel : "", "uuid", uuid));
                        emitter.send(SseEmitter.event()
                                .name("error")
                                .data(objectMapper.writeValueAsString(Map.of("message", agentLimitError))));
                        emitter.complete();
                        return;
                    }
                    String agentQuotaError = checkEstimatedUsageQuota(
                            userId, effectiveModel, req.getSystemPrompt(), history, req.getContent(), req.getMaxTokens(), "autocode");
                    if (agentQuotaError != null) {
                        harnessEvolutionService.failTrace(traceId[0], "quota_limit", agentQuotaError, "medium",
                                Map.of("model", effectiveModel != null ? effectiveModel : "", "uuid", uuid));
                        emitter.send(SseEmitter.event()
                                .name("error")
                                .data(objectMapper.writeValueAsString(Map.of("message", agentQuotaError))));
                        emitter.complete();
                        return;
                    }

                    // 当前用户消息：根据模型能力决定如何处理图片
                    // - 有 vision 能力 → 直接构建 Vision 消息
                    // - 有 tool 能力但无 vision → Vision 路由：委托 vision 模型识别图片，将描述文本注入用户消息
                    // - 否则 → 纯文本消息
                    boolean hasImages = (req.getFileUrls() != null && !req.getFileUrls().isEmpty())
                            || (req.getImageBase64List() != null && !req.getImageBase64List().isEmpty());

                    if (hasImages) {
                        boolean modelHasVision = hasModelCapability(effectiveModel, "vision");
                        boolean modelHasTool = hasModelCapability(effectiveModel, "tool");

                        if (modelHasVision) {
                            // 原生 Vision 模型：直接构建 Vision 消息
                            if (req.getFileUrls() != null && !req.getFileUrls().isEmpty()) {
                                Map<String, Object> visionMsg = aiService.buildVisionMessage(
                                        req.getContent(), req.getFileUrls());
                                agentMessages.add(visionMsg);
                            } else {
                                Map<String, Object> visionMsg = aiService.buildVisionMessage(
                                        req.getContent(), req.getImageBase64List());
                                agentMessages.add(visionMsg);
                            }
                        } else if (modelHasTool) {
                            // 🔧 Vision 路由：非 vision 但有 tool 能力的模型 → 委托 vision 模型识别图片
                            log.info("[Vision路由] 模型 '{}' 无 vision 能力，启用 Vision 路由", effectiveModel);
                            List<String> imageUrls = req.getFileUrls() != null && !req.getFileUrls().isEmpty()
                                    ? req.getFileUrls() : req.getImageBase64List();
                            String imageDesc = performVisionRouting(imageUrls);
                            String enhancedContent = req.getContent();
                            if (imageDesc != null && !imageDesc.isBlank()) {
                                enhancedContent = req.getContent() + "\n\n[图片描述]\n" + imageDesc;
                            }
                            Map<String, Object> userMessage = new LinkedHashMap<>();
                            userMessage.put("role", "user");
                            userMessage.put("content", enhancedContent);
                            agentMessages.add(userMessage);
                            // 发送图片描述事件给前端
                            emitter.send(SseEmitter.event()
                                    .name("vision_route")
                                    .data(objectMapper.writeValueAsString(Map.of(
                                            "desc", imageDesc != null ? imageDesc : "",
                                            "model", effectiveModel))));
                        } else {
                            // 无 vision 也无 tool → 纯文本消息（图片信息丢失）
                            log.warn("[Vision路由] 模型 '{}' 既不支持 vision 也不支持 tool，图片将被忽略", effectiveModel);
                            Map<String, Object> userMessage = new LinkedHashMap<>();
                            userMessage.put("role", "user");
                            userMessage.put("content", req.getContent());
                            agentMessages.add(userMessage);
                        }
                    } else {
                        Map<String, Object> userMessage = new LinkedHashMap<>();
                        userMessage.put("role", "user");
                        userMessage.put("content", req.getContent());
                        agentMessages.add(userMessage);
                    }

                    // 设置当前用户 ID（供 Agent 工具使用）
                    com.aiplatform.backend.agent.AgentSessionContext.setUserId(userId);

                    // 🔧 注入 read_stored_result 工具（OSS 外部化存储读取）
                    List<ToolDefinition> augmentedTools = new ArrayList<>(agentConfig.tools());
                    augmentedTools.add(ToolDefinition.of(
                        "read_stored_result",
                        "读取已存储到 OSS 的完整工具结果。当之前某个工具的结果被截断并存到 OSS 时（结果中会包含 storedKey），"
                                + "用此工具分页读取完整内容。offset 为字节偏移（从 0 开始），limit 为每次返回的字符数（建议 2000）。",
                        Map.of("type", "object",
                                "properties", Map.of(
                                    "storedKey", Map.of("type", "string",
                                            "description", "OSS 对象键（从之前工具结果中的 storedKey 字段获取）"),
                                    "offset", Map.of("type", "integer",
                                            "description", "字节偏移量，从 0 开始（默认 0）"),
                                    "limit", Map.of("type", "integer",
                                            "description", "每次返回的字符数，建议 2000（默认 2000）")
                                ),
                                "required", List.of("storedKey"))
                    ));

                    // 🔧 注入记忆管理工具（对话记忆自动读写）
                    augmentedTools.add(ToolDefinition.of(
                        "memory_read_document",
                        "读取本对话的记忆文件（SOUL.md、MEMORY.md、USER.md、WORK.md）。"
                                + "用于获取角色设定、对话历史摘要、用户偏好或已上传文件列表。"
                                + "title 参数为文件名（如 SOUL.md、MEMORY.md、USER.md、WORK.md）。",
                        Map.of("type", "object",
                                "properties", Map.of(
                                    "title", Map.of("type", "string",
                                            "description", "要读取的记忆文件名，如 SOUL.md、MEMORY.md、USER.md、WORK.md")
                                ),
                                "required", List.of("title"))
                    ));

                    augmentedTools.add(ToolDefinition.of(
                        "memory_save_document",
                        "保存或更新本对话的记忆文件。用于在对话过程中自动维护记忆："
                                + "如记录关键决策到 MEMORY.md、更新用户偏好到 USER.md、"
                                + "将上传文件索引更新到 WORK.md。"
                                + "title 为文件名，content 为新的完整内容。",
                        Map.of("type", "object",
                                "properties", Map.of(
                                    "title", Map.of("type", "string",
                                            "description", "要保存的记忆文件名，如 MEMORY.md、USER.md、WORK.md"),
                                    "content", Map.of("type", "string",
                                            "description", "文件的完整新内容（Markdown 格式）")
                                ),
                                "required", List.of("title", "content"))
                    ));

                    augmentedTools.add(ToolDefinition.of(
                        "memory_search_documents",
                        "在对话记忆中搜索关键词。用于查找之前讨论过的内容、决策或文件。"
                                + "返回匹配的记忆文档摘要列表。",
                        Map.of("type", "object",
                                "properties", Map.of(
                                    "query", Map.of("type", "string",
                                            "description", "搜索关键词")
                                ),
                                "required", List.of("query"))
                    ));

                    // 🔧 读取已上传的对话文件（从 OSS 下载并返回内容）
                    augmentedTools.add(ToolDefinition.of(
                        "read_uploaded_file",
                        "读取对话中已上传的文件内容。fileName 为文件名（如「台账模板.xlsx」），"
                                + "后端会自动从 OSS 下载并解析。支持 Excel(.xlsx/.xls)、CSV、"
                                + "图片(.png/.jpg/.gif)等格式。Excel 文件会被解析为 JSON 表格数据。",
                        Map.of("type", "object",
                                "properties", Map.of(
                                    "fileName", Map.of("type", "string",
                                            "description", "要读取的上传文件名，如「台账模板.xlsx」")
                                ),
                                "required", List.of("fileName"))
                    ));

                    // 包装 ToolExecutor，追加 read_stored_result + 记忆工具支持
                    ToolExecutor originalExecutor = agentConfig.toolExecutor();
                    ToolExecutor wrappedExecutor = (toolName, argumentsJson) -> {
                        if ("read_stored_result".equals(toolName)) {
                            return executeReadStoredResult(argumentsJson);
                        }
                        if ("memory_read_document".equals(toolName)) {
                            return executeMemoryRead(userId, uuid, argumentsJson);
                        }
                        if ("memory_save_document".equals(toolName)) {
                            return executeMemorySave(userId, uuid, argumentsJson);
                        }
                        if ("memory_search_documents".equals(toolName)) {
                            return executeMemorySearch(userId, uuid, argumentsJson);
                        }
                        if ("read_uploaded_file".equals(toolName)) {
                            return executeReadUploadedFile(userId, uuid, argumentsJson);
                        }
                        return originalExecutor.execute(toolName, argumentsJson);
                    };

                    // 🔧 Agent 模式：使用前端传入的系统提示词（已包含 Agent 原始提示词 + UI 块指令等运行时注入）
                    // 前端不可用时回退到数据库中的 Agent 提示词
                    String effectiveSystemPrompt = (req.getSystemPrompt() != null && !req.getSystemPrompt().isBlank())
                            ? req.getSystemPrompt()
                            : agentConfig.systemPrompt();
                    String agentSystemPrompt = buildEffectiveSystemPrompt(
                            userId, uuid, effectiveSystemPrompt, "chat_agent", req.getContent());
                    agentSystemPrompt = applyCacheLedgerPromptContext(
                            userId, uuid, effectiveModel, "chat_agent", agentSystemPrompt);

                    aiService.streamChatWithTools(
                        effectiveModel,
                        agentSystemPrompt,
                        agentMessages,
                        agentConfig.temperature(),
                        agentConfig.maxTokens(),
                        augmentedTools,
                        wrappedExecutor,
                        token -> {
                            try {
                                fullContent.append(token);
                                emitter.send(SseEmitter.event()
                                        .name("token")
                                        .data(objectMapper.writeValueAsString(Map.of("token", token))));
                            } catch (Exception e) {
                                log.warn("SSE 发送 token 失败: {}", e.getMessage());
                            }
                        },
                        toolCall -> {
                            try {
                                harnessEvolutionService.addEvent(traceId[0], "tool", "tool_call", Map.of(
                                        "toolName", toolCall.toolName(),
                                        "toolCallId", toolCall.toolCallId()));
                                // 🔧 OOM 防御 — SSE 发送前截断超大 tool_args（如 1M 的 code_content）
                                //    前端 truncateToolArgs 只能处理已解析的数据，此处从源头截断避免
                                //    Jackson 序列化 1MB+ JSON 时内存爆炸
                                String args = toolCall.arguments();
                                String safeArgs = args != null && args.length() > 3000
                                    ? args.substring(0, 3000)
                                        + "\n\n[... tool_args 已在 SSE 层截断，原 " + args.length()
                                        + " 字符。工具执行时已使用完整参数 ...]"
                                    : args;

                                // OOM 监控：记录 tool_call 事件大小
                                Map<String, Object> toolCallData = Map.of(
                                        "toolCallId", toolCall.toolCallId(),
                                        "toolName", toolCall.toolName(),
                                        "arguments", safeArgs
                                );
                                String toolCallJson = objectMapper.writeValueAsString(toolCallData);
                                if (toolCallJson.length() > 50_000) {
                                    log.warn("[OOM-WARN] SSE tool_call 事件大小 {} KB，超过 50KB！",
                                            toolCallJson.length() / 1024);
                                }

                                emitter.send(SseEmitter.event()
                                        .name("tool_call")
                                        .data(toolCallJson));
                            } catch (Exception e) {
                                log.warn("SSE 发送 tool_call 失败: {}", e.getMessage());
                            }
                        },
                        toolResult -> {
                            try {
                                harnessEvolutionService.addEvent(traceId[0], "tool", "tool_result", Map.of(
                                        "toolName", toolResult.toolName(),
                                        "toolCallId", toolResult.toolCallId(),
                                        "resultLength", toolResult.result() != null ? toolResult.result().length() : 0));
                                // 🔧 OOM 防御 — 分层截断 + OSS 外部化存储
                                String rawResult = toolResult.result();
                                int maxChars = getToolResultLimit(toolResult.toolName());

                                Map<String, Object> resultData = new LinkedHashMap<>();
                                resultData.put("toolCallId", toolResult.toolCallId());
                                resultData.put("toolName", toolResult.toolName());

                                if (rawResult != null && rawResult.length() > maxChars) {
                                    // 尝试 OSS 外部化存储
                                    var summary = toolResultStorageService.maybeOffload(
                                            toolResult.toolName(), rawResult, maxChars,
                                            toolResult.toolCallId());

                                    if (summary != null && summary.stored()) {
                                        // ✅ 已上传 OSS — SSE 只发预览 + URL
                                        resultData.put("result", summary.preview());
                                        resultData.put("stored", true);
                                        resultData.put("storedUrl", summary.url());
                                        resultData.put("storedKey", summary.objectKey());
                                        resultData.put("totalSize", summary.totalSize());
                                    } else {
                                        // OSS 不可用 — 降级为截断
                                        String truncatedResult = rawResult.substring(0, maxChars)
                                                + "\n\n[... 结果已截断，原 " + rawResult.length()
                                                + " 字符，上限 " + maxChars + " 字符 ...]";
                                        resultData.put("result", truncatedResult);
                                    }
                                } else {
                                    resultData.put("result", rawResult);
                                }

                                // OOM 监控：记录 tool_result 事件大小
                                String resultJson = objectMapper.writeValueAsString(resultData);
                                if (resultJson.length() > 100_000) {
                                    log.warn("[OOM-WARN] SSE tool_result 事件大小 {} KB，超过 100KB！tool={}",
                                            resultJson.length() / 1024, toolResult.toolName());
                                }

                                emitter.send(SseEmitter.event()
                                        .name("tool_result")
                                        .data(resultJson));
                            } catch (Exception e) {
                                log.warn("SSE 发送 tool_result 失败: {}", e.getMessage());
                            }
                        },
                        (content, inputTokens, outputTokens, cachedInputTokens, latencyMs, model, thinkingContent) -> {
                            try {
                                // 🧠 内联继续对话：continueMessageId 存在时追加到现有 AI 消息
                                ChatDTO.MessageVO assistantMsg;
                                if (req.getContinueMessageId() != null && !req.getContinueMessageId().isBlank()) {
                                    assistantMsg = chatService.appendAssistantMessage(
                                            userId, uuid, req.getContinueMessageId(), content, req.getExistingContent(),
                                            model, inputTokens, outputTokens, latencyMs);
                                } else {
                                    assistantMsg = chatService.saveAssistantMessage(
                                            userId, uuid, content, model, inputTokens, outputTokens, latencyMs);
                                }

                                recordApiLog(userId, uuid, model, inputTokens, cachedInputTokens, outputTokens, latencyMs, "success", null, requestIp);
                                recordDialogueCacheUsage(userId, uuid, model, inputTokens, cachedInputTokens, outputTokens, latencyMs);
                                updateUserTokens(userId, inputTokens + outputTokens);
                                // 🔧 记录路由结果（成功）
                                recordRoutingResult(model, hasImages ? "vision" : (isAgentMode ? "agent" : "chat"), true, latencyMs);
                                // ★ 记录用户模型使用偏好
                                recordUserModelUsage(userId, model, hasImages ? "vision" : (isAgentMode ? "agent" : "chat"), true, latencyMs, (long)(inputTokens + outputTokens));
                                // 钱包扣费 + Agent 开发者分成
                                billChatUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, req.getAgentId());
                                completeHarnessTrace(userId, traceId[0], content, model, inputTokens, outputTokens, latencyMs, false, true);

                                Map<String, Object> doneData = new java.util.LinkedHashMap<>();
                                doneData.put("msgId", assistantMsg.getId());
                                doneData.put("tokens", outputTokens);
                                doneData.put("inputTokens", inputTokens);
                                doneData.put("cachedInputTokens", cachedInputTokens);
                                doneData.put("cost", usageTrackingService.calculateCost(model, inputTokens, cachedInputTokens, outputTokens));
                                doneData.put("model", model);
                                if (thinkingContent != null && !thinkingContent.isEmpty()) {
                                    doneData.put("thinkingContent", thinkingContent);
                                }
                                emitter.send(SseEmitter.event()
                                        .name("done")
                                        .data(objectMapper.writeValueAsString(doneData)));
                                emitter.complete();

                                // 🔧 异步更新对话记忆（避免阻塞前端响应）
                                autoSaveMemoryAsync(userId, uuid, req.getContent(), content, req.getFileUrls(), requestIp);
                            } catch (Exception e) {
                                log.error("SSE Agent 完成处理失败: {}", e.getMessage(), e);
                                harnessEvolutionService.failTrace(traceId[0], "finish_persistence_error", e.getMessage(), "high",
                                        Map.of("model", req.getModel() != null ? req.getModel() : "", "uuid", uuid));
                                try {
                                    emitter.send(SseEmitter.event()
                                            .name("error")
                                            .data(objectMapper.writeValueAsString(Map.of("message",
                                                    "保存回复失败: " + (e.getMessage() != null ? e.getMessage() : "未知错误")))));
                                } catch (Exception ignored) {}
                                try { emitter.complete(); } catch (Exception ignored) {}
                            }
                        },
                        agentSessionId,  // 传递 sessionId 供 ToolExecutor 访问会话级数据
                        req.getThinking(), req.getThinkingBudget()  // 深度思考参数
                    );

                } else {
                    // ===== 普通模式：使用原有 streamChat（支持 Vision 图片） =====
                    // 🔧 模型路由集成：未指定模型时自动选择
                    boolean normalHasImages = (req.getFileUrls() != null && !req.getFileUrls().isEmpty())
                            || (req.getImageBase64List() != null && !req.getImageBase64List().isEmpty());
                    String routedModel = resolveModelWithRouting(req.getModel(), false, normalHasImages, userId);
                    String effectiveNormalModel;
                    if (routedModel != null) {
                        effectiveNormalModel = routedModel;
                    } else if ("auto".equalsIgnoreCase(req.getModel())) {
                        // 路由失败: auto → 取第一个启用的模型作为 fallback
                        effectiveNormalModel = findAllowedAvailableModel(userId, normalHasImages ? List.of("vision") : null);
                        log.warn("[ModelRouting] 普通模式路由返回 null for auto, fallback: {}", effectiveNormalModel);
                    } else {
                        effectiveNormalModel = req.getModel();
                    }
                    String effectiveModelLimitError = checkModelLimit(userId, effectiveNormalModel);
                    if (effectiveModelLimitError != null) {
                        harnessEvolutionService.failTrace(traceId[0], "model_limit", effectiveModelLimitError, "medium",
                                Map.of("model", effectiveNormalModel != null ? effectiveNormalModel : "", "uuid", uuid));
                        emitter.send(SseEmitter.event()
                                .name("error")
                                .data(objectMapper.writeValueAsString(Map.of("message", effectiveModelLimitError))));
                        emitter.complete();
                        return;
                    }
                    String quotaError = checkEstimatedUsageQuota(
                            userId, effectiveNormalModel, req.getSystemPrompt(), history, req.getContent(), req.getMaxTokens(), "chat");
                    if (quotaError != null) {
                        harnessEvolutionService.failTrace(traceId[0], "quota_limit", quotaError, "medium",
                                Map.of("model", effectiveNormalModel != null ? effectiveNormalModel : "", "uuid", uuid));
                        emitter.send(SseEmitter.event()
                                .name("error")
                                .data(objectMapper.writeValueAsString(Map.of("message", quotaError))));
                        emitter.complete();
                        return;
                    }

                    // 收集图片 URL（优先 OSS fileUrls，降级 base64 imageBase64List）
                    List<String> imageUrls = null;
                    if (req.getFileUrls() != null && !req.getFileUrls().isEmpty()) {
                        imageUrls = req.getFileUrls();
                    } else if (req.getImageBase64List() != null && !req.getImageBase64List().isEmpty()) {
                        imageUrls = req.getImageBase64List();
                    }

                    // 🔧 Vision 路由：非 vision 模型不能直接传 image_url，需委托 vision 模型识别
                    String nonAgentImageDesc = null;
                    if (imageUrls != null && !imageUrls.isEmpty()) {
                        boolean modelHasVision = hasModelCapability(effectiveNormalModel, "vision");
                        if (!modelHasVision) {
                            log.info("[Vision路由-普通模式] 模型 '{}' 无 vision 能力，启用 Vision 路由", effectiveNormalModel);
                            nonAgentImageDesc = performVisionRouting(imageUrls);
                            if (nonAgentImageDesc != null && !nonAgentImageDesc.isBlank()) {
                                // 将图片描述注入到用户内容中
                                String originalContent = req.getContent();
                                if (originalContent == null || originalContent.isBlank()) {
                                    req.setContent("[图片内容描述]\n" + nonAgentImageDesc);
                                } else {
                                    req.setContent(originalContent + "\n\n[图片内容描述]\n" + nonAgentImageDesc);
                                }
                            }
                            // 清空 imageUrls，不再以 image_url 格式发送给非 vision 模型
                            imageUrls = null;
                            // 通知前端使用了 Vision 路由
                            try {
                                emitter.send(SseEmitter.event()
                                        .name("vision_route")
                                        .data(objectMapper.writeValueAsString(Map.of(
                                                "desc", nonAgentImageDesc != null ? nonAgentImageDesc : "",
                                                "model", effectiveNormalModel))));
                            } catch (Exception ve) {
                                log.warn("发送 vision_route 事件失败: {}", ve.getMessage());
                            }
                        }
                    }

                    String effectiveSystemPrompt = buildEffectiveSystemPrompt(userId, uuid, req.getSystemPrompt(), "chat", req.getContent());
                    SearchDecision searchDecision = decideSearchNeed(effectiveNormalModel, history, req.getContent());
                    SearchAdapter.SearchResponse searchResponse = null;
                    if (searchDecision.needed()) {
                        harnessEvolutionService.addEvent(traceId[0], "routing", "search_start", Map.of(
                                "query", searchDecision.query(),
                                "reason", searchDecision.reason()));
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("search_start")
                                    .data(objectMapper.writeValueAsString(Map.of(
                                            "query", searchDecision.query(),
                                            "reason", searchDecision.reason()))));
                        } catch (Exception se) {
                            log.warn("发送 search_start 事件失败: {}", se.getMessage());
                        }
                        searchResponse = aiService.searchWeb(searchDecision.query());
                        harnessEvolutionService.addEvent(traceId[0], "routing", "search_done", Map.of(
                                "query", searchDecision.query(),
                                "hasResponse", searchResponse != null));
                        try {
                            emitter.send(SseEmitter.event()
                                    .name("search_result")
                                    .data(objectMapper.writeValueAsString(searchResponse)));
                        } catch (Exception se) {
                            log.warn("发送 search_result 事件失败: {}", se.getMessage());
                        }
                        String searchContext = aiService.buildSearchContext(searchResponse);
                        if (searchContext != null && !searchContext.isBlank()) {
                            effectiveSystemPrompt = (effectiveSystemPrompt == null || effectiveSystemPrompt.isBlank())
                                    ? searchContext
                                    : effectiveSystemPrompt + "\n\n" + searchContext;
                        }
                    }
                    effectiveSystemPrompt = applyCacheLedgerPromptContext(
                            userId, uuid, effectiveNormalModel, "chat", effectiveSystemPrompt);

                    aiService.streamChat(
                        effectiveNormalModel,
                        effectiveSystemPrompt,
                        history,
                        req.getContent(),
                        imageUrls,
                        req.getTemperature(),
                        req.getMaxTokens(),
                        req.getThinking(),
                        req.getThinkingBudget(),
                        token -> {
                            try {
                                fullContent.append(token);
                                emitter.send(SseEmitter.event()
                                        .name("token")
                                        .data(objectMapper.writeValueAsString(Map.of("token", token))));
                            } catch (Exception e) {
                                log.warn("SSE 发送 token 失败: {}", e.getMessage());
                            }
                        },
                        (content, inputTokens, outputTokens, cachedInputTokens, latencyMs, model, thinkingContent) -> {
                            try {
                                // 🧠 内联继续对话：continueMessageId 存在时追加到现有 AI 消息
                                ChatDTO.MessageVO assistantMsg;
                                if (req.getContinueMessageId() != null && !req.getContinueMessageId().isBlank()) {
                                    assistantMsg = chatService.appendAssistantMessage(
                                            userId, uuid, req.getContinueMessageId(), content, req.getExistingContent(),
                                            model, inputTokens, outputTokens, latencyMs);
                                } else {
                                    assistantMsg = chatService.saveAssistantMessage(
                                            userId, uuid, content, model, inputTokens, outputTokens, latencyMs);
                                }

                                recordApiLog(userId, uuid, model, inputTokens, cachedInputTokens, outputTokens, latencyMs, "success", null, requestIp);
                                recordDialogueCacheUsage(userId, uuid, model, inputTokens, cachedInputTokens, outputTokens, latencyMs);
                                updateUserTokens(userId, inputTokens + outputTokens);
                                // 🔧 记录路由结果（成功）
                                recordRoutingResult(model, normalHasImages ? "vision" : "chat", true, latencyMs);
                                // ★ 记录用户模型使用偏好
                                recordUserModelUsage(userId, model, normalHasImages ? "vision" : "chat", true, latencyMs, (long)(inputTokens + outputTokens));
                                // 钱包扣费
                                billChatUsage(userId, model, inputTokens, cachedInputTokens, outputTokens, null);
                                completeHarnessTrace(userId, traceId[0], content, model, inputTokens, outputTokens, latencyMs, searchDecision.needed(), false);

                                Map<String, Object> doneData = new java.util.LinkedHashMap<>();
                                doneData.put("msgId", assistantMsg.getId());
                                doneData.put("tokens", outputTokens);
                                doneData.put("inputTokens", inputTokens);
                                doneData.put("cachedInputTokens", cachedInputTokens);
                                doneData.put("cost", usageTrackingService.calculateCost(model, inputTokens, cachedInputTokens, outputTokens));
                                doneData.put("model", model);
                                if (thinkingContent != null && !thinkingContent.isEmpty()) {
                                    doneData.put("thinkingContent", thinkingContent);
                                }
                                emitter.send(SseEmitter.event()
                                        .name("done")
                                        .data(objectMapper.writeValueAsString(doneData)));
                                emitter.complete();

                                // 🔧 异步更新对话记忆（避免阻塞前端响应）
                                autoSaveMemoryAsync(userId, uuid, req.getContent(), content, req.getFileUrls(), requestIp);
                            } catch (Exception e) {
                                log.error("SSE 完成处理失败: {}", e.getMessage(), e);
                                harnessEvolutionService.failTrace(traceId[0], "finish_persistence_error", e.getMessage(), "high",
                                        Map.of("model", req.getModel() != null ? req.getModel() : "", "uuid", uuid));
                                try {
                                    emitter.send(SseEmitter.event()
                                            .name("error")
                                            .data(objectMapper.writeValueAsString(Map.of("message",
                                                    "保存回复失败: " + (e.getMessage() != null ? e.getMessage() : "未知错误")))));
                                } catch (Exception ignored) {}
                                try { emitter.complete(); } catch (Exception ignored) {}
                            }
                        }
                    );
                }

            } catch (Exception e) {
                log.error("SSE 流式处理失败: {}", e.getMessage(), e);
                // 记录错误日志
                recordApiLog(userId, uuid, req.getModel(), 0, 0, 0, 0, "error", e.getMessage(), requestIp);
                // 🔧 记录路由失败
                recordRoutingResult(req.getModel(), null, false, 0);
                // ★ 记录失败的使用偏好
                recordUserModelUsage(userId, req.getModel(), null, false, 0, 0L);
                harnessEvolutionService.failTrace(traceId[0], "runtime_error", e.getMessage(), "high",
                        Map.of("model", req.getModel() != null ? req.getModel() : "", "uuid", uuid));
                try {
                    emitter.send(SseEmitter.event()
                            .name("error")
                            .data(objectMapper.writeValueAsString(Map.of("message",
                                    e.getMessage() != null ? e.getMessage() : "服务器内部错误"))));
                } catch (Exception ignored) {}
                // 使用 complete() 而非 completeWithError()：
                // HTTP 200 已发出，completeWithError 会强制关闭 chunked 连接，
                // 导致浏览器收到 ERR_INCOMPLETE_CHUNKED_ENCODING。
                // 发完 error 事件后正常关闭即可，前端通过 error 事件感知异常。
                try {
                    emitter.complete();
                } catch (Exception ignored) {}
            } finally {
                // 清理 ThreadLocal，防止内存泄漏
                currentRequestFileUrls.remove();
                aiService.clearThinkingTokenConsumer();
                aiService.clearCurrentUsedChannel();
                aiService.clearPromptCacheKey();
            }
        });

        return emitter;
    }

    /** 同步发送消息（兜底） */
    @PostMapping("/conversations/{uuid}/messages")
    public Result<Map<String, Object>> sendMessage(
            @RequestAttribute Long userId,
            @PathVariable String uuid,
            @RequestBody ChatDTO.SendMessageRequest req) {

        Long traceId = null;
        String modelLimitError = checkModelLimit(userId, req.getModel());
        if (modelLimitError != null) return Result.fail(403, modelLimitError);

        ChatConversation traceConversation = conversationMapper.selectOne(
                new LambdaQueryWrapper<ChatConversation>()
                        .eq(ChatConversation::getUuid, uuid)
                        .eq(ChatConversation::getUserId, userId)
                        .eq(ChatConversation::getDeleted, 0)
                        .orderByDesc(ChatConversation::getId)
                        .last("LIMIT 1"));
        traceId = harnessEvolutionService.startTrace(
                "chat_sync",
                userId,
                traceConversation != null ? traceConversation.getId() : null,
                uuid,
                null,
                req.getModel(),
                null,
                req.getContent(),
                Map.of(
                        "agentId", req.getAgentId() != null ? req.getAgentId() : "",
                        "hasFiles", req.getFileUrls() != null && !req.getFileUrls().isEmpty(),
                        "thinking", Boolean.TRUE.equals(req.getThinking()),
                        "temperature", req.getTemperature() != null ? req.getTemperature() : 0.0
                ),
                Map.of("continueMessageId", req.getContinueMessageId() != null ? req.getContinueMessageId() : ""));

        // 保存用户消息前加载历史
        try {
            List<Map<String, String>> history = chatService.getHistoryForAi(userId, uuid);
        harnessEvolutionService.addEvent(traceId, "context", "history_loaded", Map.of("messageCount", history != null ? history.size() : 0));
        String quotaError = checkEstimatedUsageQuota(
                userId, req.getModel(), req.getSystemPrompt(), history, req.getContent(), req.getMaxTokens(),
                req.getAgentId() != null && !req.getAgentId().isBlank() ? "autocode" : "chat");
        if (quotaError != null) {
            harnessEvolutionService.failTrace(traceId, "quota_limit", quotaError, "medium",
                    Map.of("model", req.getModel() != null ? req.getModel() : "", "uuid", uuid));
            return Result.fail(402, quotaError);
        }

        ChatDTO.MessageVO userMsg = chatService.saveUserMessage(userId, uuid, req.getContent());
        String syncSystemPrompt = buildEffectiveSystemPrompt(userId, uuid, req.getSystemPrompt(), "chat_sync", req.getContent());
        syncSystemPrompt = applyCacheLedgerPromptContext(userId, uuid, req.getModel(), "chat_sync", syncSystemPrompt);
        AiService.AiResult aiResult = aiService.chat(
                req.getModel(), syncSystemPrompt, history, req.getContent(),
                req.getTemperature(), req.getMaxTokens(), req.getThinking(), req.getThinkingBudget());
        // 🧠 内联继续对话：continueMessageId 存在时追加到现有 AI 消息
        ChatDTO.MessageVO assistantMsg;
        if (req.getContinueMessageId() != null && !req.getContinueMessageId().isBlank()) {
            assistantMsg = chatService.appendAssistantMessage(
                    userId, uuid, req.getContinueMessageId(), aiResult.content(), req.getExistingContent(),
                    aiResult.model(), aiResult.inputTokens(), aiResult.outputTokens(), aiResult.latencyMs());
        } else {
            assistantMsg = chatService.saveAssistantMessage(
                    userId, uuid, aiResult.content(), aiResult.model(),
                    aiResult.inputTokens(), aiResult.outputTokens(), aiResult.latencyMs());
        }

        recordApiLog(userId, uuid, aiResult.model(), aiResult.inputTokens(), aiResult.cachedInputTokens(), aiResult.outputTokens(), aiResult.latencyMs(), "success", null, null);
        recordDialogueCacheUsage(userId, uuid, aiResult.model(), aiResult.inputTokens(), aiResult.cachedInputTokens(), aiResult.outputTokens(), aiResult.latencyMs());
        updateUserTokens(userId, aiResult.inputTokens() + aiResult.outputTokens());
        billChatUsage(userId, aiResult.model(), aiResult.inputTokens(), aiResult.cachedInputTokens(), aiResult.outputTokens(), req.getAgentId());
        completeHarnessTrace(userId, traceId, aiResult.content(), aiResult.model(), aiResult.inputTokens(), aiResult.outputTokens(), aiResult.latencyMs(), false, req.getAgentId() != null && !req.getAgentId().isBlank());

            aiService.clearPromptCacheKey();
            return Result.ok(Map.of("userMessage", userMsg, "assistantMessage", assistantMsg));
        } catch (Exception e) {
            harnessEvolutionService.failTrace(traceId, "runtime_error", e.getMessage(), "high",
                    Map.of("model", req.getModel() != null ? req.getModel() : "", "uuid", uuid));
            aiService.clearPromptCacheKey();
            return Result.fail(e.getMessage() != null ? e.getMessage() : "服务异常");
        }
    }

    // ==================== 私有辅助 ====================

    /** 检查用户订阅的模型限制，返回 null 表示允许，否则返回错误消息 */
    private String checkModelLimit(Long userId, String requestedModel) {
        if (requestedModel == null || requestedModel.isBlank()) return null;
        if ("auto".equalsIgnoreCase(requestedModel.trim())) return null;
        try {
            Set<String> allowed = getAllowedModelSet(userId);
            if (allowed == null || allowed.isEmpty()) return null;
            for (String m : allowed) {
                if (m.equalsIgnoreCase(requestedModel.trim())) return null;
            }
            return "您当前套餐不支持使用模型 " + requestedModel + "，可用模型: " + String.join(",", allowed);
        } catch (Exception e) {
            log.warn("检查模型限制失败: {}", e.getMessage());
            return "套餐模型权限校验失败，请稍后重试";
        }
    }

    private String checkEstimatedUsageQuota(Long userId, String model, String systemPrompt,
                                            List<Map<String, String>> history, String userMessage,
                                            Integer maxTokens, String sceneType) {
        if (model == null || model.isBlank() || "auto".equalsIgnoreCase(model)) return null;
        try {
            int inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);
            if (history != null) {
                for (Map<String, String> item : history) {
                    inputTokens += estimateTokens(item != null ? item.get("content") : null);
                }
            }
            int outputTokens = maxTokens != null && maxTokens > 0 ? maxTokens : 8192;
            BigDecimal estimatedCost = usageTrackingService.calculateCost(model, inputTokens, 0, outputTokens);
            usageTrackingService.preflightUsage(userId, model, estimatedCost, sceneType);
            return null;
        } catch (Exception e) {
            log.warn("[Billing] usage preflight rejected: userId={}, model={}, error={}", userId, model, e.getMessage());
            return e.getMessage() != null ? e.getMessage() : "当前账户额度不足，无法发起本次模型调用";
        }
    }

    private int estimateTokens(String text) {
        if (text == null || text.isBlank()) return 0;
        return Math.max(1, (int) Math.ceil(text.length() / 3.0));
    }

    private Set<String> getAllowedModelSet(Long userId) {
        String modelLimit = null;
        Subscription sub = subscriptionMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<Subscription>()
                        .eq("user_id", userId).eq("status", "active").eq("deleted", 0)
                        .orderByDesc("created_at").last("LIMIT 1"));
        if (sub != null && sub.getModelLimit() != null && !sub.getModelLimit().isBlank()) {
            modelLimit = sub.getModelLimit();
        }
        if (modelLimit == null || modelLimit.isBlank()) {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null && user.getPlan() != null && !user.getPlan().isBlank()) {
                SubscriptionPlan plan = subscriptionPlanMapper.selectOne(
                        new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<SubscriptionPlan>()
                                .eq("code", user.getPlan()).eq("deleted", 0)
                                .orderByDesc("id").last("LIMIT 1"));
                if (plan != null && plan.getModelLimit() != null && !plan.getModelLimit().isBlank()) {
                    modelLimit = plan.getModelLimit();
                }
            }
        }
        if (modelLimit == null || modelLimit.isBlank()) return null;
        Set<String> allowed = new LinkedHashSet<>();
        for (String item : modelLimit.split(",")) {
            String model = item.trim();
            if (!model.isBlank()) allowed.add(model);
        }
        return allowed;
    }

    private boolean isModelAllowed(Long userId, String modelId) {
        if (modelId == null || modelId.isBlank()) return false;
        Set<String> allowed = getAllowedModelSet(userId);
        if (allowed == null || allowed.isEmpty()) return true;
        for (String model : allowed) {
            if (model.equalsIgnoreCase(modelId.trim())) return true;
        }
        return false;
    }

    private List<Map<String, Object>> buildAvailableModelsForUser(Long userId) {
        Set<String> allowed = getAllowedModelSet(userId);
        List<ModelConfig> modelConfigs = modelConfigMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelConfig>()
                        .eq("deleted", 0)
                        .eq("enabled", true)
                        .orderByAsc("provider")
                        .orderByAsc("model_id"));

        List<ModelChannel> activeChatChannels = modelChannelMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelChannel>()
                        .eq("deleted", 0)
                        .eq("status", "active")
                        .and(w -> w.isNull("channel_type").or().eq("channel_type", "chat"))
                        .orderByAsc("priority"));

        Set<String> activeChannelModelIds = new LinkedHashSet<>();
        Map<String, Set<String>> channelTagsByModel = new LinkedHashMap<>();
        for (ModelChannel ch : activeChatChannels) {
            List<String> channelModels = parseLooseList(ch.getModels());
            List<String> channelTags = parseLooseList(ch.getTags());
            for (String id : channelModels) {
                activeChannelModelIds.add(id);
                channelTagsByModel.computeIfAbsent(id, k -> new LinkedHashSet<>()).addAll(channelTags);
            }
        }

        boolean restrictToChannels = !activeChannelModelIds.isEmpty();
        List<Map<String, Object>> result = new ArrayList<>();
        for (ModelConfig mc : modelConfigs) {
            String modelId = mc.getModelId();
            if (modelId == null || modelId.isBlank()) continue;
            if (restrictToChannels && !activeChannelModelIds.contains(modelId)) continue;
            if (allowed != null && !allowed.isEmpty() && allowed.stream().noneMatch(m -> m.equalsIgnoreCase(modelId))) {
                continue;
            }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", modelId);
            item.put("name", mc.getName() != null && !mc.getName().isBlank() ? mc.getName() : modelId);
            item.put("provider", mc.getProvider() != null ? mc.getProvider() : "");
            item.put("description", mc.getDescription() != null ? mc.getDescription() : "");
            item.put("contextLength", mc.getContextLength() != null ? mc.getContextLength() : 0);
            item.put("inputPrice", mc.getInputPrice() != null ? mc.getInputPrice() : BigDecimal.ZERO);
            item.put("cachedInputPrice", mc.getCachedInputPrice() != null ? mc.getCachedInputPrice() : BigDecimal.ZERO);
            item.put("outputPrice", mc.getOutputPrice() != null ? mc.getOutputPrice() : BigDecimal.ZERO);
            Set<String> caps = new LinkedHashSet<>(parseLooseList(mc.getCapabilities()));
            caps.addAll(channelTagsByModel.getOrDefault(modelId, Set.of()));
            if (caps.isEmpty()) caps.add("text");
            item.put("capabilities", caps);
            item.put("enabled", true);
            result.add(item);
        }
        return result;
    }

    private List<String> parseLooseList(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        String s = raw.trim();
        if (s.startsWith("[") && s.endsWith("]")) {
            s = s.substring(1, s.length() - 1);
        }
        s = s.replace("\"", "").replace("'", "");
        List<String> result = new ArrayList<>();
        for (String part : s.split(",")) {
            String item = part.trim();
            if (!item.isBlank()) result.add(item);
        }
        return result;
    }

    private void recordApiLog(Long userId, String convUuid, String model,
                               int inputTokens, int cachedInputTokens, int outputTokens, int latencyMs,
                               String status, String errorMsg, String requestIp) {
        try {
            ApiLog apiLog = new ApiLog();
            apiLog.setUserId(userId);
            apiLog.setModel(model != null ? model : "unknown");
            apiLog.setInputTokens(inputTokens);
            apiLog.setCachedInputTokens(cachedInputTokens);
            apiLog.setOutputTokens(outputTokens);
            apiLog.setLatencyMs(latencyMs);
            apiLog.setStatus(status);
            apiLog.setErrorMsg(errorMsg);
            apiLog.setRequestIp(requestIp);
            AiService.UsedChannel usedChannel = aiService.getCurrentUsedChannel();
            if (usedChannel != null) {
                apiLog.setProvider(usedChannel.provider());
                apiLog.setChannelId(usedChannel.channelId() != null ? String.valueOf(usedChannel.channelId()) : null);
            } else {
                ModelChannel channel = findChannelForApiLog(model);
                if (channel != null) {
                apiLog.setProvider(channel.getProvider());
                apiLog.setChannelId(channel.getUuid() != null && !channel.getUuid().isBlank()
                        ? channel.getUuid()
                        : String.valueOf(channel.getId()));
                }
            }
            BigDecimal cost = usageTrackingService.calculateCost(model, inputTokens, cachedInputTokens, outputTokens);
            apiLog.setCost(cost);
            apiLogMapper.insert(apiLog);
            updateUserCost(userId, cost);
        } catch (Exception e) {
            log.warn("记录 ApiLog 失败: {}", e.getMessage());
        }
    }

    private void completeHarnessTrace(Long userId, Long traceId, String content, String model,
                                      int inputTokens, int outputTokens, int latencyMs,
                                      boolean usedSearch, boolean agentMode) {
        AiService.UsedChannel usedChannel = aiService.getCurrentUsedChannel();
        boolean allowContentForImprovement = privacySettingService.isDataImprovementEnabled(userId);
        harnessEvolutionService.completeTrace(
                traceId,
                allowContentForImprovement ? content : null,
                usedChannel != null ? usedChannel.provider() : null,
                usedChannel != null && usedChannel.channelId() != null ? String.valueOf(usedChannel.channelId()) : null,
                inputTokens,
                outputTokens,
                latencyMs,
                Map.of(
                        "usedSearch", usedSearch,
                        "agentMode", agentMode,
                        "outputLength", content != null ? content.length() : 0,
                        "dataImprovementEnabled", allowContentForImprovement
                ),
                Map.of(
                        "hasOutput", content != null && !content.isBlank(),
                        "outputTokens", outputTokens,
                        "latencyMs", latencyMs
                ));
    }

    private ModelChannel findChannelForApiLog(String model) {
        if (model == null || model.isBlank()) return null;
        try {
            List<ModelChannel> channels = modelChannelMapper.selectList(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelChannel>()
                            .eq("deleted", 0)
                            .eq("status", "active")
                            .and(w -> w.isNull("channel_type").or().eq("channel_type", "chat"))
                            .orderByAsc("priority"));
            for (ModelChannel channel : channels) {
                for (String item : parseLooseList(channel.getModels())) {
                    if (model.equalsIgnoreCase(item)) return channel;
                }
            }
        } catch (Exception e) {
            log.debug("Find api log channel failed: {}", e.getMessage());
        }
        return null;
    }

    private void updateUserTokens(Long userId, int tokensUsed) {
        try {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null) {
                long newUsed = (user.getTokensUsed() != null ? user.getTokensUsed() : 0) + tokensUsed;
                user.setTokensUsed(newUsed);
                sysUserMapper.updateById(user);
            }
        } catch (Exception e) {
            log.warn("更新用户 token 用量失败: {}", e.getMessage());
        }
    }

    // ==================== 记忆注入 ====================

    /**
     * 构建增强版 system prompt（合并记忆上下文）。
     * 基于 Coze 三层记忆架构：
     *   L1 基础设定 → 直接注入
     *   L2 对话记忆 + 用户画像 → 注入
     *   L3 项目/技能记忆索引 → 注入摘要（不注入全文）
     *
     * @param userId           用户 ID
     * @param convUuid         对话 UUID
     * @param baseSystemPrompt 用户/Agent 的基础 system prompt（可为 null）
     * @return 增强后的 system prompt
     */
    private SearchDecision decideSearchNeed(String model, List<Map<String, String>> history, String userMessage) {
        if (userMessage == null || userMessage.isBlank()) {
            return new SearchDecision(false, "", "empty");
        }
        try {
            String prompt = """
                    你是对话系统的联网搜索决策器。判断用户当前问题是否需要联网搜索。
                    需要搜索的情况：最新/今天/最近/价格/政策/法规/赛事/新闻/版本/文档/官网信息/具体网页或明显需要实时事实。
                    不需要搜索的情况：闲聊、写作、翻译、解释通用概念、代码改写、数学推理、基于已给材料回答。
                    只返回 JSON，不要解释，格式：
                    {"search":true,"query":"适合搜索引擎的查询词","reason":"简短原因"}
                    或：
                    {"search":false,"query":"","reason":"简短原因"}
                    """;
            List<Map<String, String>> recentHistory = history == null
                    ? List.of()
                    : history.subList(Math.max(0, history.size() - Math.min(history.size(), 4)), history.size());
            AiService.AiResult result = aiService.chat(model, prompt, recentHistory, userMessage, 0.0, 120);
            String json = extractJsonObject(result.content());
            if (json != null) {
                var node = objectMapper.readTree(json);
                boolean search = node.path("search").asBoolean(false);
                String query = node.path("query").asText("").trim();
                String reason = node.path("reason").asText("").trim();
                if (search && query.isBlank()) query = userMessage.trim();
                return new SearchDecision(search, query, reason.isBlank() ? "ai_decision" : reason);
            }
        } catch (Exception e) {
            log.debug("[SearchDecision] AI 判断失败，使用规则兜底: {}", e.getMessage());
        }
        return heuristicSearchDecision(userMessage);
    }

    private SearchDecision heuristicSearchDecision(String message) {
        String text = message == null ? "" : message.trim();
        String lower = text.toLowerCase(Locale.ROOT);
        List<String> keywords = List.of(
                "今天", "昨日", "昨天", "明天", "最新", "最近", "当前", "现在", "实时", "新闻", "官网",
                "价格", "股价", "汇率", "天气", "赛事", "比分", "政策", "法规", "版本", "发布",
                "文档", "api", "sdk", "npm", "maven", "github", "arxiv", "论文", "搜索", "联网"
        );
        boolean needed = keywords.stream().anyMatch(k -> lower.contains(k.toLowerCase(Locale.ROOT)))
                || lower.matches(".*20\\d{2}.*");
        return new SearchDecision(needed, needed ? text : "", needed ? "规则检测到实时信息需求" : "未检测到实时信息需求");
    }

    private String extractJsonObject(String text) {
        if (text == null) return null;
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return text.substring(start, end + 1);
        }
        return null;
    }

    private record SearchDecision(boolean needed, String query, String reason) {}

    private String buildEffectiveSystemPrompt(Long userId, String convUuid, String baseSystemPrompt, String harnessSurface) {
        return buildEffectiveSystemPrompt(userId, convUuid, baseSystemPrompt, harnessSurface, null);
    }

    private String applyCacheLedgerPromptContext(Long userId, String convUuid, String model, String surface, String systemPrompt) {
        if (!cacheLedgerClient.isEnabled()) {
            aiService.clearPromptCacheKey();
            return systemPrompt;
        }
        try {
            Map<String, Object> stableContext = new LinkedHashMap<>();
            stableContext.put("surface", surface != null ? surface : "chat");
            stableContext.put("conversation", convUuid != null ? convUuid : "");
            stableContext.put("format", "java-dialogue-system-v1");
            Map<String, Object> response = cacheLedgerClient.buildPromptContext(
                    "default",
                    userId != null ? String.valueOf(userId) : "",
                    convUuid != null ? convUuid : "",
                    model != null ? model : "",
                    "java-chat",
                    surface != null ? surface : "chat",
                    systemPrompt,
                    stableContext);
            Object key = response.get("prompt_cache_key");
            if (key != null && !String.valueOf(key).isBlank()) {
                aiService.setPromptCacheKey(String.valueOf(key));
            } else {
                aiService.clearPromptCacheKey();
            }
            Object prefix = response.get("stable_context_prefix");
            if (prefix instanceof String text && !text.isBlank()) {
                return text;
            }
        } catch (Exception e) {
            log.debug("[CacheLedger] prompt context skipped: {}", e.getMessage());
            aiService.clearPromptCacheKey();
        }
        return systemPrompt;
    }

    private void recordDialogueCacheUsage(Long userId, String convUuid, String model,
                                          int inputTokens, int cachedInputTokens,
                                          int outputTokens, int latencyMs) {
        try {
            AiService.UsedChannel usedChannel = aiService.getCurrentUsedChannel();
            String provider = usedChannel != null && usedChannel.provider() != null
                    ? usedChannel.provider()
                    : "java-chat";
            cacheLedgerClient.recordProviderUsage(
                    "default",
                    userId != null ? String.valueOf(userId) : "",
                    convUuid != null ? convUuid : "",
                    model != null ? model : "",
                    provider,
                    inputTokens,
                    cachedInputTokens,
                    outputTokens,
                    latencyMs);
        } catch (Exception e) {
            log.debug("[CacheLedger] usage event skipped: {}", e.getMessage());
        }
    }

    private String buildEffectiveSystemPrompt(Long userId, String convUuid, String baseSystemPrompt, String harnessSurface, String currentQuery) {
        try {
            // 查找对话 database ID
            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("user_id", userId).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));

            Long conversationId = conv != null ? conv.getId() : null;

            // 构建记忆上下文
            MemoryDTO.MemoryContext ctx = memoryService.buildMemoryContext(userId, conversationId, currentQuery);

            StringBuilder sb = new StringBuilder();
            if (baseSystemPrompt != null && !baseSystemPrompt.isBlank()) {
                sb.append(baseSystemPrompt.trim()).append("\n\n");
            }
            if (ctx.getInjectedSystemPrompt() != null && !ctx.getInjectedSystemPrompt().isBlank()) {
                sb.append(ctx.getInjectedSystemPrompt());
            }
            String harnessGuidance = harnessEvolutionService.activeHarnessGuidance(harnessSurface);
            if (harnessGuidance != null && !harnessGuidance.isBlank()) {
                if (!sb.isEmpty()) {
                    sb.append("\n\n");
                }
                sb.append(harnessGuidance);
            }

            String effective = sb.toString().trim();
            if (!effective.isEmpty()) {
                log.debug("[Memory] 记忆上下文已注入, userId={}, convUuid={}, injectedLen={}",
                        userId, convUuid, ctx.getInjectedSystemPrompt() != null ? ctx.getInjectedSystemPrompt().length() : 0);
            }
            return effective.isEmpty() ? null : effective;
        } catch (Exception e) {
            log.warn("[Memory] 构建记忆上下文失败, userId={}, convUuid={}: {}", userId, convUuid, e.getMessage());
            return baseSystemPrompt; // 降级：返回原始 system prompt
        }
    }

    // ==================== 分层截断辅助方法 ====================

    /**
     * 🔧 OOM 防御 — 基于工具名称返回结果截断上限
     *
     * 分层策略:
     *   - 代码/文件类工具 (read, file, cat, tail, head, grep, glob, edit, write,
     *     diff, open, view, ls) → 50,000 字符 (约 1000 行代码)
     *   - 数据/搜索/查询工具 (search, query, select, find, scan, list, sql, data,
     *     fetch, lookup, browse) → 20,000 字符
     *   - 其他 → 5,000 字符 (默认)
     */
    private static final java.util.regex.Pattern CODE_FILE_PATTERN =
            java.util.regex.Pattern.compile(
                    "(?:^|[\\s_-])(read|file|cat|tail|head|grep|glob|code|open|view|ls|dir|edit|write|diff)(?:[\\s_-]|$)",
                    java.util.regex.Pattern.CASE_INSENSITIVE);

    private static final java.util.regex.Pattern DATA_SEARCH_PATTERN =
            java.util.regex.Pattern.compile(
                    "(?:search|query|select|find|scan|list|sql|data|fetch|aggregate|lookup|browse)",
                    java.util.regex.Pattern.CASE_INSENSITIVE);

    private int getToolResultLimit(String toolName) {
        if (toolName == null || toolName.isBlank()) return 5000;
        if (CODE_FILE_PATTERN.matcher(toolName).find()) return 50000;
        if (DATA_SEARCH_PATTERN.matcher(toolName).find()) return 20000;
        return 5000;
    }

    // ==================== Vision 路由辅助方法 ====================

    /**
     * 检查指定模型是否具备某能力标签。
     * 从 model_config 表的 capabilities 字段（逗号分隔）中查找。
     */
    private boolean hasModelCapability(String modelId, String capability) {
        if (modelId == null || modelId.isBlank()) return false;
        List<ModelConfig> models = modelConfigMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelConfig>()
                        .eq("deleted", 0)
                        .eq("enabled", true));
        for (ModelConfig mc : models) {
            if (modelId.equals(mc.getModelId()) || modelId.equals(String.valueOf(mc.getId()))) {
                String caps = mc.getCapabilities();
                if (caps == null || caps.isBlank()) return false;
                return Arrays.asList(caps.split(",")).contains(capability);
            }
        }
        return false;
    }

    /**
     * 寻找一个启用的、具备 vision 能力的模型。
     * 优先选择价格最低的。
     */
    private String findVisionModel() {
        List<ModelConfig> models = modelConfigMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelConfig>()
                        .eq("deleted", 0)
                        .eq("enabled", true));
        ModelConfig best = null;
        for (ModelConfig mc : models) {
            String caps = mc.getCapabilities();
            if (caps == null || caps.isBlank()) continue;
            if (!Arrays.asList(caps.split(",")).contains("vision")) continue;
            if (best == null) {
                best = mc;
            } else {
                // 选择价格更低的（输出价格优先，因为图片识别以输出为主）
                double thisPrice = mc.getOutputPrice() != null ? mc.getOutputPrice().doubleValue() : 0;
                double bestPrice = best.getOutputPrice() != null ? best.getOutputPrice().doubleValue() : 0;
                if (thisPrice < bestPrice) best = mc;
            }
        }
        return best != null ? best.getModelId() : null;
    }

    /**
     * 执行 Vision 路由：使用 vision 模型识别图片，返回文字描述。
     * 失败时返回 null（降级为纯文本消息）。
     */
    private String performVisionRouting(List<String> imageUrls) {
        String visionModel = findVisionModel();
        if (visionModel == null) {
            log.warn("[Vision路由] 未找到可用 vision 模型，图片将被忽略");
            return null;
        }
        log.info("[Vision路由] 使用 vision 模型 '{}' 识别 {} 张图片", visionModel, imageUrls != null ? imageUrls.size() : 0);
        try {
            String prompt = "请详细描述以下图片的内容。包括：图片中有什么物体、文字、颜色、布局等所有可见信息。";
            AiService.AiResult result = aiService.describeImages(visionModel, prompt, imageUrls);
            if (result != null && result.content() != null && !result.content().isBlank()) {
                log.info("[Vision路由] 图片识别成功: {} 字符", result.content().length());
                return result.content();
            }
            log.warn("[Vision路由] 图片识别返回空内容");
            return null;
        } catch (Exception e) {
            log.error("[Vision路由] 图片识别失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 执行 read_stored_result 工具 — 从 OSS 分页读取已存储的完整结果。
     * 供 LLM 在工具结果被外部化后按需获取完整内容。
     */
    private String executeReadStoredResult(String argumentsJson) {
        try {
            var args = objectMapper.readTree(argumentsJson);
            String storedKey = args.has("storedKey") ? args.get("storedKey").asText() : null;
            if (storedKey == null || storedKey.isBlank()) {
                return "错误: 缺少 storedKey 参数";
            }
            long offset = args.has("offset") ? args.get("offset").asLong() : 0L;
            int limit = args.has("limit") ? args.get("limit").asInt() : 2000;
            if (limit > 10000) limit = 10000; // 安全上限

            String content = toolResultStorageService.readStoredResultRange(storedKey, offset, limit);
            String suffix = content.length() >= limit
                    ? "\n\n[... 更多内容，用 read_stored_result 将 offset 设为 " + (offset + limit) + " 继续读取 ...]"
                    : "";
            return content + suffix;
        } catch (Exception e) {
            log.error("read_stored_result 执行失败: {}", e.getMessage());
            return "读取存储结果失败: " + e.getMessage();
        }
    }

    // ==================== 记忆工具执行方法 ====================

    /**
     * 执行 memory_read_document — 读取本对话的记忆文件
     */
    private String executeMemoryRead(Long userId, String convUuid, String argumentsJson) {
        try {
            var args = objectMapper.readTree(argumentsJson);
            String title = args.has("title") ? args.get("title").asText() : null;
            if (title == null || title.isBlank()) {
                return "错误: 缺少 title 参数（如 SOUL.md、MEMORY.md、USER.md、WORK.md）";
            }

            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (conv == null) {
                return "错误: 对话不存在";
            }

            MemoryDTO.DocumentVO doc = memoryService.getDocumentByTitle(userId, conv.getId(), title);
            if (doc == null) {
                return "未找到记忆文件: " + title + "（当前对话中此文件尚未创建）";
            }
            return doc.getContent() != null ? doc.getContent() : "(空文件)";
        } catch (Exception e) {
            log.error("memory_read_document 执行失败: {}", e.getMessage());
            return "读取记忆文件失败: " + e.getMessage();
        }
    }

    /**
     * 执行 memory_save_document — 保存/更新对话记忆文件
     */
    private String executeMemorySave(Long userId, String convUuid, String argumentsJson) {
        try {
            var args = objectMapper.readTree(argumentsJson);
            String title = args.has("title") ? args.get("title").asText() : null;
            String content = args.has("content") ? args.get("content").asText() : null;
            if (title == null || title.isBlank()) {
                return "错误: 缺少 title 参数";
            }
            if (content == null) {
                return "错误: 缺少 content 参数";
            }

            // 防止修改 SOUL.md（角色设定只读）
            if ("SOUL.md".equalsIgnoreCase(title)) {
                return "错误: SOUL.md 是只读的，仅用于参考，不可修改。可修改 MEMORY.md、USER.md 或 WORK.md。";
            }

            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (conv == null) {
                return "错误: 对话不存在";
            }

            MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
            req.setTitle(title);
            req.setContent(content);
            req.setDocType("conversation_summary"); // 归类为对话记忆

            MemoryDTO.DocumentVO saved = memoryService.saveDocument(userId, conv.getId(), req);
            return "已保存记忆文件: " + title + " (" + (content.length()) + " 字符)";
        } catch (Exception e) {
            log.error("memory_save_document 执行失败: {}", e.getMessage());
            return "保存记忆文件失败: " + e.getMessage();
        }
    }

    /**
     * 执行 memory_search_documents — 搜索对话记忆
     */
    private String executeMemorySearch(Long userId, String convUuid, String argumentsJson) {
        try {
            var args = objectMapper.readTree(argumentsJson);
            String query = args.has("query") ? args.get("query").asText() : null;
            if (query == null || query.isBlank()) {
                return "错误: 缺少 query 参数";
            }

            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            Long conversationId = conv != null ? conv.getId() : null;

            List<MemoryDTO.DocumentVO> results = memoryService.searchDocuments(userId, conversationId, query);
            if (results == null || results.isEmpty()) {
                return "未找到匹配 \"" + query + "\" 的记忆内容";
            }

            StringBuilder sb = new StringBuilder();
            sb.append("搜索 \"").append(query).append("\" 的结果 (").append(results.size()).append(" 条):\n\n");
            for (int i = 0; i < results.size(); i++) {
                MemoryDTO.DocumentVO doc = results.get(i);
                sb.append("--- ").append(doc.getTitle()).append(" ---\n");
                String snippet = doc.getContent() != null ? doc.getContent() : "";
                if (snippet.length() > 500) snippet = snippet.substring(0, 500) + "...";
                sb.append(snippet).append("\n\n");
            }
            return sb.toString();
        } catch (Exception e) {
            log.error("memory_search_documents 执行失败: {}", e.getMessage());
            return "搜索记忆失败: " + e.getMessage();
        }
    }

    /**
     * 🔧 读取已上传的对话文件（从 OSS 下载并解析内容）
     *
     * 查找优先级：
     *   1. work_file 表（精确匹配 → URL解码匹配 → 模糊匹配）
     *   2. ThreadLocal 当前请求 fileUrls（上传时直接传入的原始 URL 列表）
     *   3. 用户所有对话的 work_file 表（跨会话搜索，应对文件存错会话的情况）
     */
    private String executeReadUploadedFile(Long userId, String convUuid, String argumentsJson) {
        try {
            var args = objectMapper.readTree(argumentsJson);
            String fileName = args.has("fileName") ? args.get("fileName").asText() : null;
            if (fileName == null || fileName.isBlank()) {
                return "错误: 缺少 fileName 参数";
            }

            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (conv == null) return "错误: 对话不存在";

            // ── 策略1：work_file 表多策略搜索 ──
            String ossUrl = findWorkFileAndGetUrl(userId, conv.getId(), fileName);

            // ── 策略2：ThreadLocal 当前请求的 fileUrls 兜底 ──
            if (ossUrl == null) {
                ossUrl = findInCurrentRequestUrls(fileName);
                log.info("[read_uploaded_file] 策略2(ThreadLocal) {} -> {}", fileName,
                        ossUrl != null ? "FOUND" : "NOT FOUND");
            }

            // ── 策略3：跨会话搜索（用户所有对话的 work_file）──
            if (ossUrl == null) {
                ossUrl = findInAllUserFiles(userId, fileName);
                log.info("[read_uploaded_file] 策略3(跨会话) {} -> {}", fileName,
                        ossUrl != null ? "FOUND" : "NOT FOUND");
            }

            if (ossUrl == null || ossUrl.isBlank()) {
                // 列出当前对话文件 + ThreadLocal 文件供参考
                var hint = buildFileListHint(userId, conv.getId());
                return "文件 \"" + fileName + "\" 未找到。" + hint;
            }

            // 从 OSS 下载文件
            log.info("[read_uploaded_file] 下载文件: {} -> {}", fileName, ossUrl);

            java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                    .connectTimeout(java.time.Duration.ofSeconds(10))
                    .build();
            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(ossUrl))
                    .timeout(java.time.Duration.ofSeconds(30))
                    .GET()
                    .build();
            java.net.http.HttpResponse<byte[]> response = client.send(request,
                    java.net.http.HttpResponse.BodyHandlers.ofByteArray());

            if (response.statusCode() != 200) {
                return "下载文件失败: HTTP " + response.statusCode();
            }

            byte[] data = response.body();
            String mimeType = guessMimeType(fileName);
            String lowerName = fileName.toLowerCase();

            // Excel 文件 → 尝试用 Python 桥接解析
            if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
                try {
                    return parseExcelWithPython(data, fileName);
                } catch (Exception e) {
                    log.warn("[read_uploaded_file] Python 解析 Excel 失败，返回文件信息: {}", e.getMessage());
                    return "文件 \"" + fileName + "\" (" + data.length + " bytes, " + mimeType + ")\n"
                            + "Python 解析失败: " + e.getMessage() + "\n"
                            + "请使用命令行工具或手动下载查看。OSS URL: " + ossUrl;
                }
            }

            // CSV 文件 → 直接当文本返回
            if (lowerName.endsWith(".csv")) {
                return new String(data, java.nio.charset.StandardCharsets.UTF_8);
            }

            // 图片文件 → 返回 URL（模型可用 Vision 能力查看）
            if (mimeType.startsWith("image/")) {
                return "图片文件 \"" + fileName + "\" (" + data.length + " bytes, " + mimeType + ")\n"
                        + "图片 URL: " + ossUrl;
            }

            // 其他文本文件 → 尝试返回文本内容
            try {
                String text = new String(data, java.nio.charset.StandardCharsets.UTF_8);
                if (text.length() > 10000) text = text.substring(0, 10000) + "\n\n[... 内容过长已截断，原 " + data.length + " bytes ...]";
                return text;
            } catch (Exception e) {
                return "文件 \"" + fileName + "\" (" + data.length + " bytes, " + mimeType + ")\n"
                        + "该文件为二进制格式，无法直接文本化。OSS URL: " + ossUrl;
            }
        } catch (Exception e) {
            log.error("read_uploaded_file 执行失败: {}", e.getMessage());
            return "读取文件失败: " + e.getMessage();
        }
    }

    // ==================== read_uploaded_file 搜索策略辅助方法 ====================

    /**
     * 策略1：从 work_file 表查找 OSS URL（返回 URL 或 null）
     */
    private String findWorkFileAndGetUrl(Long userId, Long conversationId, String fileName) {
        MemoryWorkFile wf = findWorkFile(userId, conversationId, fileName);
        if (wf != null && wf.getOssUrl() != null && !wf.getOssUrl().isBlank()) {
            return wf.getOssUrl();
        }
        return null;
    }

    /**
     * 策略2：从 ThreadLocal 当前请求的 fileUrls 中搜索匹配项。
     * 这是最终兜底——文件上传时前端已将 OSS URL 传给后端，无论 DB 是否有记录都能找到。
     */
    private String findInCurrentRequestUrls(String fileName) {
        List<String> urls = currentRequestFileUrls.get();
        if (urls == null || urls.isEmpty()) return null;

        for (String url : urls) {
            String urlName = extractFileNameFromUrl(url);
            if (urlName == null) continue;
            urlName = decodeFileName(urlName);

            // 解码后的名称与搜索词匹配
            if (urlName.equalsIgnoreCase(fileName)) return url;
            // 包含关系匹配（处理带 UUID 前缀的情况，如 a9765468_食品台账.xlsx 包含 食品台账.xlsx）
            if (urlName.contains(fileName) || fileName.contains(urlName)) return url;
            // 去掉 UUID 前缀后再匹配
            String withoutPrefix = stripUuidPrefix(urlName);
            if (withoutPrefix.equalsIgnoreCase(fileName) || withoutPrefix.contains(fileName) || fileName.contains(withoutPrefix)) {
                return url;
            }
        }
        return null;
    }

    /**
     * 策略3：跨会话搜索——在用户所有对话的 work_file 中查找。
     * 应对文件被保存到错误对话 ID 的情况。
     */
    private String findInAllUserFiles(Long userId, String fileName) {
        var allFiles = workFileMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<MemoryWorkFile>()
                        .eq("user_id", userId).eq("deleted", 0));

        for (MemoryWorkFile f : allFiles) {
            if (f.getOssUrl() == null || f.getOssUrl().isBlank()) continue;

            // 检查 file_name
            String storedRaw = f.getFileName();
            if (storedRaw != null) {
                String decoded = decodeFileName(storedRaw);
                if (decoded.equalsIgnoreCase(fileName) || decoded.contains(fileName) || fileName.contains(decoded)) {
                    return f.getOssUrl();
                }
            }

            // 检查 OSS URL 中的文件名
            String urlName = decodeFileName(extractFileNameFromUrl(f.getOssUrl()));
            if (urlName != null) {
                String withoutPrefix = stripUuidPrefix(urlName);
                if (withoutPrefix.equalsIgnoreCase(fileName) || withoutPrefix.contains(fileName)
                        || fileName.contains(withoutPrefix)) {
                    return f.getOssUrl();
                }
            }
        }
        return null;
    }

    /**
     * 构建文件列表提示信息（用于"未找到"错误响应）
     */
    private String buildFileListHint(Long userId, Long conversationId) {
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();

        // 当前对话 work_file
        var convFiles = workFileMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<MemoryWorkFile>()
                        .eq("user_id", userId).eq("conversation_id", conversationId).eq("deleted", 0));
        convFiles.stream().map(MemoryWorkFile::getFileName)
                .filter(n -> n != null && !n.isBlank()).forEach(names::add);

        // ThreadLocal 文件
        List<String> reqUrls = currentRequestFileUrls.get();
        if (reqUrls != null) {
            for (String u : reqUrls) {
                String n = decodeFileName(extractFileNameFromUrl(u));
                if (n != null && !n.isBlank()) names.add(n + " [from request]");
            }
        }

        if (!names.isEmpty()) {
            return "当前可用文件: " + String.join(", ", names) + "。";
        }
        return "当前对话中尚未上传任何文件。";
    }

    /**
     * 去掉文件名开头的 UUID 前缀（如 "a9765468_" → ""）
     */
    private String stripUuidPrefix(String name) {
        if (name == null) return "";
        // 匹配 开头8-32位十六进制 + 下划线 的前缀
        return name.replaceFirst("^[a-fA-F0-9]{8,32}_", "");
    }

    /**
     * 🔧 多策略查找工作文件：兼容不同代码路径存储的文件名差异。
     *
     * 策略：
     *   1. 精确匹配 file_name
     *   2. 从 OSS URL 提取文件名段并 URL 解码后匹配
     *   3. LIKE 模糊匹配（file_name 包含搜索词或反之）
     */
    private MemoryWorkFile findWorkFile(Long userId, Long conversationId, String fileName) {
        // 策略1：精确匹配 file_name 列
        var qw1 = new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId).eq("conversation_id", conversationId)
                .eq("file_name", fileName).eq("deleted", 0)
                .orderByDesc("id")
                .last("LIMIT 1");
        MemoryWorkFile wf = workFileMapper.selectOne(qw1);
        if (wf != null) return wf;

        // 加载当前对话所有工作文件（后续策略复用）
        var all = workFileMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<MemoryWorkFile>()
                        .eq("user_id", userId).eq("conversation_id", conversationId).eq("deleted", 0));

        // 策略2：从 OSS URL 提取文件名段 + URL 解码后匹配
        for (MemoryWorkFile f : all) {
            if (f.getOssUrl() == null) continue;
            String urlName = extractFileNameFromUrl(f.getOssUrl());
            if (urlName == null) continue;
            urlName = decodeFileName(urlName); // URL 解码中文
            if (urlName.equalsIgnoreCase(fileName)) return f;
            // 中文空格/特殊字符归一化比较
            if (urlName.replace(" ", "").equalsIgnoreCase(fileName.replace(" ", ""))) return f;
        }

        // 策略3：对存储的 file_name 做 URL 解码后模糊匹配
        for (MemoryWorkFile f : all) {
            String storedRaw = f.getFileName();
            if (storedRaw == null) continue;
            String storedDecoded = decodeFileName(storedRaw);

            // 解码后的名称直接匹配
            if (storedDecoded.equalsIgnoreCase(fileName)) return f;
            // 包含关系匹配（解码后）
            if (storedDecoded.contains(fileName) || fileName.contains(storedDecoded)) return f;
            // 原始名包含关系（兜底）
            if (storedRaw.contains(fileName) || fileName.contains(storedRaw)) return f;
        }

        return null;
    }

    /**
     * 用 Python openpyxl 解析 Excel 文件
     */
    private String parseExcelWithPython(byte[] data, String fileName) throws Exception {
        // 写入临时文件
        java.nio.file.Path tmpFile = java.nio.file.Files.createTempFile("uploaded_", fileName);
        try {
            java.nio.file.Files.write(tmpFile, data);

            // 调用 Python 解析脚本
            String pythonScript = "import openpyxl, json, sys\n"
                    + "wb = openpyxl.load_workbook(sys.argv[1], data_only=True)\n"
                    + "result = {}\n"
                    + "for name in wb.sheetnames:\n"
                    + "    ws = wb[name]\n"
                    + "    rows = []\n"
                    + "    for row in ws.iter_rows(values_only=True):\n"
                    + "        rows.append([str(c) if c is not None else '' for c in row])\n"
                    + "    result[name] = rows\n"
                    + "print(json.dumps(result, ensure_ascii=False))";

            // 尝试 python3，失败降级 python
            String pythonCmd = "python3";
            try {
                new ProcessBuilder(pythonCmd, "--version").start().waitFor();
            } catch (Exception e) {
                pythonCmd = "python";
            }

            ProcessBuilder pb = new ProcessBuilder(pythonCmd, "-c", pythonScript, tmpFile.toAbsolutePath().toString());
            pb.redirectErrorStream(true);
            Process process = pb.start();
            String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            int exitCode = process.waitFor();

            if (exitCode != 0) {
                throw new RuntimeException("Python exit code " + exitCode + ": " + output);
            }

            // 解析 JSON 并格式化为可读的表格文本
            var json = objectMapper.readTree(output);
            StringBuilder sb = new StringBuilder();
            sb.append("文件 \"").append(fileName).append("\" 解析结果:\n\n");
            var fields = json.fields();
            while (fields.hasNext()) {
                var entry = fields.next();
                sb.append("=== Sheet: ").append(entry.getKey()).append(" ===\n");
                var rows = entry.getValue();
                if (rows.isArray() && rows.size() > 0) {
                    // 限制最多返回 200 行
                    int maxRows = Math.min(rows.size(), 200);
                    for (int i = 0; i < maxRows; i++) {
                        var row = rows.get(i);
                        if (row.isArray()) {
                            var cells = new java.util.ArrayList<String>();
                            for (var cell : row) {
                                cells.add(cell.asText());
                            }
                            sb.append(String.join("\t", cells)).append("\n");
                        }
                    }
                    if (rows.size() > 200) {
                        sb.append("... (共 ").append(rows.size()).append(" 行，仅显示前 200 行)\n");
                    }
                }
                sb.append("\n");
            }
            return sb.toString().trim();
        } finally {
            try { java.nio.file.Files.deleteIfExists(tmpFile); } catch (Exception ignored) {}
        }
    }

    // ==================== 工作文件自动保存 ====================

    /**
     * 发送消息时自动保存文件 URL 为对话工作文件。
     * 处理文件上传时对话尚未创建的情况：文件先上传 OSS，消息发送时再关联到对话。
     *
     * 注意：FileUploadController 上传时已用原始文件名保存过 work_file，
     * 此处仅作为兜底（如上传时 convUuid 为空导致未保存）。
     * 去重逻辑：相同 oss_url 不重复插入。
     */
    private void autoSaveWorkFiles(Long userId, String convUuid, List<String> fileUrls) {
        if (fileUrls == null || fileUrls.isEmpty()) return;
        try {
            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (conv == null) return;

            // 批量加载已有 work_file（避免循环内重复查库）
            var existingFiles = memoryService.listWorkFiles(userId, conv.getId(), null);

            for (String url : fileUrls) {
                try {
                    // 去重：已存在相同 ossUrl 的记录则跳过
                    boolean alreadyExists = existingFiles.stream()
                            .anyMatch(f -> url.equals(f.getOssUrl()));
                    if (alreadyExists) continue;

                    // 从 URL 提取文件名并 URL 解码
                    String rawName = extractFileNameFromUrl(url);
                    String fileName = decodeFileName(rawName);
                    String fileType = classifyFileType(fileName);

                    memoryService.saveWorkFile(userId, conv.getId(),
                            fileName, fileType, 0L,
                            guessMimeType(fileName), url, null);
                } catch (Exception inner) {
                    log.debug("[Memory] 自动保存工作文件失败: url={}, error={}", url, inner.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("[Memory] 自动保存工作文件异常: {}", e.getMessage());
        }
    }

    /**
     * URL 解码文件名（OSS key 中的中文会被编码为 %XX 格式）
     */
    private String decodeFileName(String rawName) {
        if (rawName == null) return "unknown";
        try {
            return java.net.URLDecoder.decode(rawName, java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return rawName;
        }
    }

    private String extractFileNameFromUrl(String url) {
        try {
            String path = url.contains("?") ? url.substring(0, url.indexOf("?")) : url;
            int lastSlash = path.lastIndexOf('/');
            return lastSlash >= 0 ? path.substring(lastSlash + 1) : "unknown";
        } catch (Exception e) {
            return "unknown";
        }
    }

    private String classifyFileType(String fileName) {
        String name = fileName.toLowerCase();
        if (name.matches(".*\\.(png|jpg|jpeg|gif|webp|bmp|svg)$")) return "image";
        if (name.matches(".*\\.(mp3|wav|ogg|aac|flac)$")) return "audio";
        if (name.matches(".*\\.(mp4|webm|avi|mov|mkv)$")) return "video";
        if (name.matches(".*\\.(xlsx|xls|csv)$")) return "spreadsheet";
        if (name.matches(".*\\.(pdf|doc|docx|ppt|pptx)$")) return "document";
        if (name.matches(".*\\.(zip|tar|gz|skill)$")) return "skill";
        return "other";
    }

    private void updateUserCost(Long userId, BigDecimal cost) {
        if (cost == null || cost.compareTo(BigDecimal.ZERO) <= 0) return;
        try {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null) {
                user.setCostUsed((user.getCostUsed() != null ? user.getCostUsed() : BigDecimal.ZERO).add(cost));
                sysUserMapper.updateById(user);
            }
            Subscription sub = subscriptionMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<Subscription>()
                            .eq("user_id", userId).eq("status", "active").eq("deleted", 0)
                            .orderByDesc("created_at").last("LIMIT 1"));
            if (sub != null) {
                sub.setCostUsed((sub.getCostUsed() != null ? sub.getCostUsed() : BigDecimal.ZERO).add(cost));
                subscriptionMapper.updateById(sub);
            }
        } catch (Exception e) {
            log.warn("更新用户费用用量失败: {}", e.getMessage());
        }
    }

    private String guessMimeType(String fileName) {
        String name = fileName.toLowerCase();
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        return "application/octet-stream";
    }

    // ==================== 计费辅助 ====================

    /**
     * 对话完成后按模型价格从钱包扣费 + 开发者分成
     * @param model 模型名称（用于查 ModelConfig 价格）
     * @param agentId 如果使用 Agent，传入 agentId（非内置 Agent 才有分成）
     */
    private void billChatUsage(Long userId, String model, int inputTokens, int cachedInputTokens, int outputTokens, String agentId) {
        try {
            if (model == null || model.isBlank()) return;

            // 查询模型价格
            ModelConfig mc = modelConfigMapper.selectOne(
                new LambdaQueryWrapper<ModelConfig>().eq(ModelConfig::getModelId, model)
                        .orderByDesc(ModelConfig::getId)
                        .last("LIMIT 1"));
            if (mc == null || !mc.getEnabled()) return;

            BigDecimal totalCost = usageTrackingService.calculateCost(model, inputTokens, cachedInputTokens, outputTokens);

            if (totalCost.compareTo(BigDecimal.ZERO) <= 0) return;

            // 从用户钱包扣费
            walletService.consume(userId, totalCost, null, model);

            // 如果是市场 Agent（非内置），给开发者分成
            if (agentId != null && !agentId.isBlank()) {
                walletService.shareRevenue(agentId, totalCost, null);
            }
        } catch (RuntimeException e) {
            // 余额不足等情况——仅记录日志，不阻塞 SSE 流
            log.warn("[Wallet] 对话扣费失败: userId={}, model={}, error={}", userId, model, e.getMessage());
        } catch (Exception e) {
            log.warn("[Wallet] 对话扣费异常: {}", e.getMessage());
        }
    }

    /**
     * 🔧 异步更新记忆：先发送 done 事件给前端，后台异步完成 LLM 摘要
     * 避免 LLM 调用（可能数秒）阻塞用户看到对话结果
     */
    private void autoSaveMemoryAsync(Long userId, String convUuid, String userMessage, String assistantReply,
            java.util.List<String> fileUrls, String requestIp) {
        if (!privacySettingService.isSaveHistoryEnabled(userId)) {
            log.debug("[Memory] saveHistory disabled, skip auto memory save. userId={}, convUuid={}", userId, convUuid);
            return;
        }
        java.util.concurrent.CompletableFuture.runAsync(() -> {
            autoSaveMemory(userId, convUuid, userMessage, assistantReply, fileUrls, requestIp);
        });
    }

    /**
     * 对话完成后自动更新记忆文件（MEMORY.md / WORK.md）
     * 不依赖 LLM，后端自动执行，确保对话记忆持续积累
     */
    private void autoSaveMemory(Long userId, String convUuid, String userMessage, String assistantReply,
            java.util.List<String> fileUrls, String requestIp) {
        try {
            ChatConversation conv = conversationMapper.selectOne(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("user_id", userId).eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (conv == null) return;

            java.util.List<String> fileNames = new java.util.ArrayList<>();
            if (fileUrls != null) {
                for (String url : fileUrls) {
                    String name = url.substring(url.lastIndexOf('/') + 1);
                    if (!name.isBlank()) fileNames.add(name);
                }
            }

            memoryService.autoUpdateConversationMemory(
                    userId, conv.getId(), userMessage, assistantReply, fileNames, convUuid, requestIp);
        } catch (Exception e) {
            log.warn("[Memory] 自动更新对话记忆失败: {}", e.getMessage());
        }
    }

    // ==================== 模型路由集成 ====================

    /**
     * 🔧 智能模型选择：当请求未指定模型或模型为空时，使用 ModelRoutingService 自动选择最佳模型。
     * 集成点：
     *   - Agent 模式：effectiveModel 确定前
     *   - 普通模式：streamChat 调用前
     *
     * @param requestedModel 用户请求的模型（可为 null）
     * @param isAgentMode    是否为 Agent 模式
     * @param hasImages      是否包含图片
     * @return 最终使用的模型 ID（优先返回 requestedModel，否则返回路由结果）
     */
    private String resolveModelWithRouting(String requestedModel, boolean isAgentMode, boolean hasImages, Long userId) {
        // "auto" 表示用户希望使用智能路由，不视为指定模型
        // 用户明确指定了具体模型（非 auto、非空）→ 直接使用
        if (requestedModel != null && !requestedModel.isBlank() && !"auto".equalsIgnoreCase(requestedModel)) {
            log.debug("[ModelRouting] 用户指定模型: {}", requestedModel);
            if (!isModelAllowed(userId, requestedModel)) {
                String fallback = findAllowedAvailableModel(userId, hasImages
                        ? List.of("vision")
                        : (isAgentMode ? List.of("tool") : null));
                log.warn("[ModelRouting] requested model {} is outside subscription limit, fallback to {}",
                        requestedModel, fallback);
                return fallback;
            }
            return requestedModel;
        }

        // 未指定模型或 model=auto → 使用智能路由
        log.info("[ModelRouting] 启动智能路由选择... agentMode={}, hasImages={}, raw={}, userId={}", isAgentMode, hasImages, requestedModel, userId);

        try {
            ModelRoutingService.RouteContext ctx = new ModelRoutingService.RouteContext();

            // 场景类型判断
            if (hasImages) {
                ctx.setSceneType("vision");
                ctx.setRequiredCapabilities(Arrays.asList("vision"));
            } else if (isAgentMode) {
                ctx.setSceneType("agent");
                ctx.setRequiredCapabilities(Arrays.asList("tool"));
            } else {
                ctx.setSceneType("chat");
            }

            // 复杂度默认为 moderate（后续可根据消息长度/历史动态调整）
            ctx.setComplexity("moderate");

            // ★ 注入用户偏好
            if (userId != null) {
                ctx.setUserId(String.valueOf(userId));
                try {
                    ctx.setUserPreferences(userPreferenceService.getPreferencesByUser(userId));
                } catch (Exception e) {
                    log.debug("[ModelRouting] 加载用户偏好失败，忽略: {}", e.getMessage());
                }
            }

            ModelRoutingService.RouteResult result = modelRoutingService.selectModel(ctx);

            if (result != null && result.getModelId() != null) {
                if (!isModelAllowed(userId, result.getModelId())) {
                    String fallback = findAllowedAvailableModel(userId, ctx.getRequiredCapabilities());
                    log.warn("[ModelRouting] model {} is outside subscription limit, fallback to {}",
                            result.getModelId(), fallback);
                    return fallback;
                }
                log.info("[ModelRouting] 路由选择结果: modelId={}, provider={}, score={}, reason={}",
                        result.getModelId(), result.getProvider(), result.getScore(), result.getReason());
                return result.getModelId();
            }

            log.warn("[ModelRouting] 路由未找到合适模型，将使用默认模型");
        } catch (Exception e) {
            log.error("[ModelRouting] 路由失败，降级为默认模型: {}", e.getMessage());
        }

        return findAllowedAvailableModel(userId, null);
    }

    private String findAllowedAvailableModel(Long userId, List<String> requiredCapabilities) {
        List<Map<String, Object>> models = buildAvailableModelsForUser(userId);
        for (Map<String, Object> model : models) {
            @SuppressWarnings("unchecked")
            Collection<String> caps = (Collection<String>) model.get("capabilities");
            if (requiredCapabilities == null || requiredCapabilities.isEmpty()
                    || (caps != null && caps.containsAll(requiredCapabilities))) {
                Object id = model.get("id");
                return id != null ? id.toString() : null;
            }
        }
        return null;
    }

    /**
     * 🔧 记录模型调用结果到路由服务（用于熔断器和统计）
     * 在 SSE 完成回调中调用
     */
    private void recordRoutingResult(String modelId, String sceneType, boolean success, int responseTimeMs) {
        if (modelId == null || modelId.isBlank()) return;

        try {
            String routeScene = (sceneType != null) ? sceneType : "chat";
            if (success) {
                modelRoutingService.recordSuccess(modelId, routeScene, responseTimeMs);
            } else {
                modelRoutingService.recordFailure(modelId, routeScene);
            }
        } catch (Exception e) {
            log.debug("[ModelRouting] 记录路由结果失败: {}", e.getMessage());
        }
    }

    /**
     * ★ 记录用户模型使用情况到偏好系统（异步学习）
     * 在 SSE 完成回调中调用，不阻塞主流程
     */
    private void recordUserModelUsage(Long userId, String modelId, String sceneType, boolean success, int responseTimeMs, Long tokenUsage) {
        if (userId == null || modelId == null || modelId.isBlank()) return;

        try {
            ModelUsageEvent event = new ModelUsageEvent();
            event.setUserId(userId);
            event.setModelId(modelId);
            event.setSceneType(sceneType != null ? sceneType : "chat");
            event.setSuccess(success);
            event.setResponseTimeMs(responseTimeMs);
            event.setTokenUsage(tokenUsage);
            // cost 由 billChatUsage 计算，此处暂不重复计算
            userPreferenceService.recordUsage(event);
        } catch (Exception e) {
            log.debug("[UserPreference] 记录使用情况失败: {}", e.getMessage());
        }
    }
}
