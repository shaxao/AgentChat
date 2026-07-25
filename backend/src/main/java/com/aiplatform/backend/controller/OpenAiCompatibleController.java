package com.aiplatform.backend.controller;

import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.billing.BillingErrorCode;
import com.aiplatform.backend.billing.BillingException;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.ModelAliasService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.aiplatform.backend.service.UserApiKeyService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

@Slf4j
@RestController
@RequestMapping("/v1")
@RequiredArgsConstructor
public class OpenAiCompatibleController {
    private final UserApiKeyService userApiKeyService;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final ModelConfigMapper modelConfigMapper;
    private final ModelChannelMapper modelChannelMapper;
    private final SysUserMapper sysUserMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final ModelAliasService modelAliasService;
    private final ObjectMapper objectMapper;

    private final java.util.concurrent.ExecutorService sseExecutor = java.util.concurrent.Executors.newCachedThreadPool();
    private final ScheduledExecutorService sseHeartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
    private static final long RESPONSES_STATE_TTL_MS = 6 * 60 * 60 * 1000L;
    private static final int MAX_RESPONSES_STATE = 2000;
    private final ConcurrentHashMap<String, ResponsesState> responsesStateStore = new ConcurrentHashMap<>();

    @Value("${app.ai.gateway-stream-timeout:600}")
    private long gatewayStreamTimeoutSeconds;

    @GetMapping("/models")
    public ResponseEntity<?> models(@RequestHeader(value = "Authorization", required = false) String authorization) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        ArrayNode data = objectMapper.createArrayNode();
        Map<String, String> modelOwners = new LinkedHashMap<>();
        List<ModelConfig> models = modelConfigMapper.selectList(new LambdaQueryWrapper<ModelConfig>()
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getDeleted, 0)
                .orderByAsc(ModelConfig::getId));
        for (ModelConfig model : models) {
            if (model.getModelId() != null && !model.getModelId().isBlank()) {
                modelOwners.put(model.getModelId(), model.getProvider() != null ? model.getProvider() : "muhuo");
            }
        }
        List<ModelChannel> channels = modelChannelMapper.selectList(new LambdaQueryWrapper<ModelChannel>()
                .eq(ModelChannel::getDeleted, 0)
                .in(ModelChannel::getStatus, List.of("active", "enabled"))
                .and(w -> w.isNull(ModelChannel::getChannelType)
                        .or().eq(ModelChannel::getChannelType, "")
                        .or().eq(ModelChannel::getChannelType, "chat"))
                .orderByAsc(ModelChannel::getPriority));
        for (ModelChannel channel : channels) {
            for (String modelId : parseModelList(channel.getModels())) {
                modelOwners.putIfAbsent(modelId, channel.getProvider() != null ? channel.getProvider() : "muhuo");
            }
        }
        for (Map.Entry<String, String> entry : modelOwners.entrySet()) {
            ObjectNode item = data.addObject();
            item.put("id", entry.getKey());
            item.put("object", "model");
            item.put("created", Instant.now().getEpochSecond());
            item.put("owned_by", entry.getValue());
        }
        ObjectNode body = objectMapper.createObjectNode();
        body.put("object", "list");
        body.set("data", data);
        return ResponseEntity.ok(body);
    }

    @GetMapping({"/balance", "/usage"})
    public ResponseEntity<?> balance(@RequestHeader(value = "Authorization", required = false) String authorization) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        SysUser user = sysUserMapper.selectById(auth.getUserId());
        if (user == null) {
            return openAiError(HttpStatus.UNAUTHORIZED, "invalid_api_key", "API key user no longer exists");
        }

        Subscription subscription = subscriptionMapper.selectOne(new LambdaQueryWrapper<Subscription>()
                .select(
                        Subscription::getId,
                        Subscription::getUserId,
                        Subscription::getPlan,
                        Subscription::getPlanName,
                        Subscription::getStatus,
                        Subscription::getCostLimit,
                        Subscription::getCostUsed,
                        Subscription::getTokensLimit,
                        Subscription::getModelLimit,
                        Subscription::getStartDate,
                        Subscription::getEndDate,
                        Subscription::getCreatedAt,
                        Subscription::getDeleted
                )
                .eq(Subscription::getUserId, auth.getUserId())
                .eq(Subscription::getStatus, "active")
                .eq(Subscription::getDeleted, 0)
                .orderByDesc(Subscription::getCreatedAt)
                .last("LIMIT 1"));

        ObjectNode body = objectMapper.createObjectNode();
        body.put("object", "balance");
        body.put("user_id", auth.getUserId());
        body.put("wallet_balance", money(user.getBalance()));
        body.put("total_consumed", money(user.getTotalConsumed()));
        body.put("cost_limit", money(user.getCostLimit()));
        body.put("cost_used", money(user.getCostUsed()));
        body.put("cost_remaining", money(remaining(user.getCostLimit(), user.getCostUsed())));
        body.put("tokens_limit", user.getTokensLimit() != null ? user.getTokensLimit() : 0L);
        body.put("tokens_used", user.getTokensUsed() != null ? user.getTokensUsed() : 0L);

        ObjectNode plan = body.putObject("subscription");
        if (subscription != null) {
            plan.put("plan", subscription.getPlan());
            plan.put("plan_name", subscription.getPlanName());
            plan.put("status", subscription.getStatus());
            plan.put("cost_limit", money(subscription.getCostLimit()));
            plan.put("cost_used", money(subscription.getCostUsed()));
            plan.put("cost_remaining", money(remaining(subscription.getCostLimit(), subscription.getCostUsed())));
            plan.put("tokens_limit", subscription.getTokensLimit() != null ? subscription.getTokensLimit() : 0L);
            plan.put("model_limit", subscription.getModelLimit());
            if (subscription.getStartDate() != null) plan.put("start_date", subscription.getStartDate().toString());
            if (subscription.getEndDate() != null) plan.put("end_date", subscription.getEndDate().toString());
        } else {
            plan.putNull("plan");
            plan.put("status", "none");
        }
        return ResponseEntity.ok(body);
    }

    @PostMapping(value = {"/chat/completions", "/char/com"}, produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<ResponseBodyEmitter> chatCompletionsStream(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        return handleChatCompletions(authorization, request, servletRequest);
    }

    @PostMapping({"/chat/completions", "/char/com"})
    public ResponseEntity<ResponseBodyEmitter> chatCompletions(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        return handleChatCompletions(authorization, request, servletRequest);
    }

    private ResponseEntity<ResponseBodyEmitter> handleChatCompletions(String authorization,
                                                                       JsonNode request,
                                                                       HttpServletRequest servletRequest) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) {
            return jsonErrorEmitter(HttpStatus.UNAUTHORIZED, "invalid_api_key", "Invalid or missing API key");
        }

        long start = System.currentTimeMillis();
        String model = request.path("model").asText(null);
        boolean stream = request.path("stream").asBoolean(false);
        RequestSnapshot requestSnapshot = snapshot(servletRequest);
        try {
            preflightOpenAiApiUsage(auth, model, request);
        } catch (Exception e) {
            safeTrackFailure(auth, model, start, e, "api");
            return jsonErrorEmitter(billingHttpStatus(e), openAiBillingErrorType(e), e.getMessage());
        }
        if (stream) {
            return sseResponse(chatSseStreaming(auth, request, model, start, requestSnapshot));
        }
        try {
            JsonNode raw = invokeChatCompletion(request);
            markLengthIfUnsafeToolCalls(raw);
            safeTrackSuccess(auth, raw, model, start, requestSnapshot, "api");
            return jsonEmitter(HttpStatus.OK, raw);
        } catch (Exception e) {
            safeTrackFailure(auth, model, start, e, "api");
            return jsonErrorEmitter(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    @PostMapping(value = "/responses", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public ResponseEntity<ResponseBodyEmitter> responsesStream(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        return handleResponses(authorization, request, servletRequest);
    }

    @PostMapping("/responses")
    public ResponseEntity<ResponseBodyEmitter> responses(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        return handleResponses(authorization, request, servletRequest);
    }

    private ResponseEntity<ResponseBodyEmitter> handleResponses(String authorization,
                                                                 JsonNode request,
                                                                 HttpServletRequest servletRequest) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) {
            return jsonErrorEmitter(HttpStatus.UNAUTHORIZED, "invalid_api_key", "Invalid or missing API key");
        }

        long start = System.currentTimeMillis();
        String model = request.path("model").asText(null);
        boolean stream = request.path("stream").asBoolean(false);
        RequestSnapshot requestSnapshot = snapshot(servletRequest);

        try {
            preflightOpenAiApiUsage(auth, model, request);
        } catch (Exception e) {
            safeTrackFailure(auth, model, start, e, "api");
            return jsonErrorEmitter(billingHttpStatus(e), openAiBillingErrorType(e), e.getMessage());
        }

        if (stream) {
            return sseResponse(responseSseStreaming(auth, request, model, start, requestSnapshot));
        }

        try {
            return jsonEmitter(responsesNonStreaming(auth, request, model, start, requestSnapshot));
        } catch (Exception e) {
            safeTrackFailure(auth, model, start, e, "api");
            return jsonErrorEmitter(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    @PostMapping(value = "/audio/speech", produces = "audio/mpeg")
    public ResponseEntity<?> speech(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        String input = request.path("input").asText("");
        String voice = request.path("voice").asText("alloy");
        if (input.isBlank()) return openAiError(HttpStatus.BAD_REQUEST, "invalid_request_error", "input is required");
        try {
            String audioBase64 = aiService.textToSpeechWithChannel(input, voice);
            byte[] audio = Base64.getDecoder().decode(stripDataUrl(audioBase64));
            usageTrackingService.trackFull(auth.getUserId(), "tts", Math.max(1, input.length()), 0,
                    elapsed(start), "api", null);
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"speech.mp3\"")
                    .contentType(MediaType.parseMediaType("audio/mpeg"))
                    .body(audio);
        } catch (Exception e) {
            usageTrackingService.trackFailure(auth.getUserId(), "tts", 0, 0, elapsed(start), "api", e.getMessage());
            return openAiError(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    @PostMapping(value = {"/audio/transcriptions", "/audio/translations"}, consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> transcriptions(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "model", required = false) String model) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        try {
            String text = aiService.speechToTextFromBytes(file.getBytes(),
                    file.getOriginalFilename() != null ? file.getOriginalFilename() : "audio.mp3");
            usageTrackingService.trackFull(auth.getUserId(), model != null ? model : "asr", 0,
                    text != null ? text.length() : 0, elapsed(start), "api", null);
            return ResponseEntity.ok(Map.of("text", text != null ? text : ""));
        } catch (Exception e) {
            usageTrackingService.trackFailure(auth.getUserId(), model != null ? model : "asr", 0, 0,
                    elapsed(start), "api", e.getMessage());
            return openAiError(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    @PostMapping("/images/generations")
    public ResponseEntity<?> imageGenerations(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        String prompt = request.path("prompt").asText("");
        String size = request.path("size").asText("1024x1024");
        String responseFormat = request.path("response_format").asText("url");
        if (prompt.isBlank()) return openAiError(HttpStatus.BAD_REQUEST, "invalid_request_error", "prompt is required");
        try {
            String image = aiService.generateImage(prompt, size);
            ObjectNode body = objectMapper.createObjectNode();
            body.put("created", Instant.now().getEpochSecond());
            ArrayNode data = body.putArray("data");
            ObjectNode item = data.addObject();
            if ("b64_json".equals(responseFormat) || image.startsWith("data:") || looksLikeBase64(image)) {
                item.put("b64_json", stripDataUrl(image));
            } else {
                item.put("url", image);
            }
            usageTrackingService.trackFull(auth.getUserId(), "image", Math.max(1, prompt.length()), 0,
                    elapsed(start), "api", null);
            return ResponseEntity.ok(body);
        } catch (Exception e) {
            usageTrackingService.trackFailure(auth.getUserId(), "image", 0, 0, elapsed(start), "api", e.getMessage());
            return openAiError(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    private JsonNode invokeChatCompletion(JsonNode request) {
        String model = modelAliasService.resolveModelId(request.path("model").asText(null));
        String system = request.path("system").asText(null);
        Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                ? request.get("temperature").asDouble() : null;
        Integer maxTokens = firstInt(request, "max_tokens", "max_completion_tokens");
        List<Map<String, Object>> messages = objectMapper.convertValue(
                request.path("messages"),
                objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
        List<ToolDefinition> tools = parseTools(request.path("tools"));
        return aiService.chatCompletionRaw(model, system, messages, temperature, maxTokens, tools,
                thinkingEnabled(request),
                thinkingBudget(request),
                false,
                request,
                true);
    }

    private JsonNode invokeChatCompletionOnGatewayChannel(AiService.GatewayChannel channel, JsonNode request) {
        String system = request.path("system").asText(null);
        Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                ? request.get("temperature").asDouble() : null;
        Integer maxTokens = firstInt(request, "max_tokens", "max_completion_tokens");
        List<Map<String, Object>> messages = objectMapper.convertValue(
                request.path("messages"),
                objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
        List<ToolDefinition> tools = parseTools(request.path("tools"));
        return aiService.chatCompletionRawOnGatewayChannel(channel, system, messages, temperature, maxTokens, tools,
                thinkingEnabled(request), thinkingBudget(request), request);
    }

    private ResponseEntity<?> responsesNonStreaming(UserApiKeyService.AuthenticatedApiKey auth,
                                                    JsonNode request,
                                                    String requestedModel,
                                                    long start,
                                                    RequestSnapshot requestSnapshot) throws Exception {
        List<AiService.GatewayChannel> channels = resolveResponsesGatewayChannels(request);
        if (channels.isEmpty()) {
            return openAiError(HttpStatus.BAD_REQUEST, "invalid_request_error",
                    "Specified model has no available channel: " + (requestedModel != null ? requestedModel : "unknown"));
        }

        Exception lastError = null;
        for (AiService.GatewayChannel channel : channels) {
            try {
                if ("responses".equals(normalizeGatewayApiFormat(channel.apiFormat()))) {
                    JsonNode raw = aiService.responsesCompletionRawOnGatewayChannel(
                            channel, request, (int) Math.max(1L, gatewayStreamTimeoutSeconds));
                    if (isNativeResponsesFailure(raw)) {
                        throw new RuntimeException(nativeResponsesErrorMessage(raw));
                    }
                    if (!responsesHasTextOrTool(raw)) {
                        throw new RuntimeException("upstream responses completed without text or tool call");
                    }
                    safeTrackSuccess(auth, raw, requestedModel, start, requestSnapshot, "api");
                    return ResponseEntity.ok(raw);
                }

                ObjectNode chatReq = responseToChatRequest(request);
                JsonNode raw = invokeChatCompletionOnGatewayChannel(channel, chatReq);
                markLengthIfUnsafeToolCalls(raw);
                safeTrackSuccess(auth, raw, requestedModel, start, requestSnapshot, "api");
                ObjectNode response = toResponsesFormat(raw, request);
                if (!isLengthFinish(raw)) {
                    storeResponsesState(response.path("id").asText(), chatReq.path("messages"), raw);
                }
                return ResponseEntity.ok(response);
            } catch (Exception e) {
                lastError = e;
                log.warn("[OpenAiCompatible] responses non-stream channel failed: channel={}, format={}, error={}",
                        channel.channelId(), channel.apiFormat(), e.getMessage());
            }
        }

        throw lastError != null ? lastError
                : new RuntimeException("All Responses candidate channels failed");
    }

    private void preflightOpenAiApiUsage(UserApiKeyService.AuthenticatedApiKey auth, String model, JsonNode request) {
        if (auth == null || model == null || model.isBlank()) return;
        int inputTokens = estimateOpenAiRequestTokens(request);
        int outputTokens = estimateOpenAiOutputTokens(request);
        BigDecimal estimatedCost = usageTrackingService.calculateCost(model, inputTokens, 0, outputTokens);
        usageTrackingService.preflightUsage(auth.getUserId(), model, estimatedCost, "api");
    }

    private int estimateOpenAiRequestTokens(JsonNode request) {
        if (request == null || request.isMissingNode() || request.isNull()) return 0;
        StringBuilder text = new StringBuilder();
        appendTextForTokenEstimate(text, request.path("instructions"));
        appendTextForTokenEstimate(text, request.path("system"));
        appendTextForTokenEstimate(text, request.path("input"));
        appendTextForTokenEstimate(text, request.path("messages"));
        appendTextForTokenEstimate(text, request.path("tools"));
        int estimate = estimateTokens(text.toString());
        if (estimate <= 0) {
            estimate = Math.max(1, request.toString().length() / 4);
        }
        return estimate;
    }

    private int estimateOpenAiOutputTokens(JsonNode request) {
        Integer explicit = firstInt(request, "max_output_tokens", "max_tokens", "max_completion_tokens");
        if (explicit != null && explicit > 0) {
            return explicit;
        }
        return 8192;
    }

    private void appendTextForTokenEstimate(StringBuilder target, JsonNode node) {
        if (target == null || node == null || node.isMissingNode() || node.isNull()) return;
        if (node.isTextual() || node.isNumber() || node.isBoolean()) {
            target.append(node.asText("")).append('\n');
            return;
        }
        if (node.isArray()) {
            for (JsonNode item : node) appendTextForTokenEstimate(target, item);
            return;
        }
        if (node.isObject()) {
            node.fields().forEachRemaining(entry -> {
                String name = entry.getKey();
                if ("image_url".equals(name) || "url".equals(name) || "b64_json".equals(name)) {
                    return;
                }
                appendTextForTokenEstimate(target, entry.getValue());
            });
        }
    }

    private int estimateTokens(String text) {
        if (text == null || text.isBlank()) return 0;
        return Math.max(1, (int) Math.ceil(text.length() / 3.0));
    }

    private HttpStatus billingHttpStatus(Exception e) {
        if (e instanceof BillingException be) {
            BillingErrorCode code = be.getCode();
            if (BillingErrorCode.SCENE_DISABLED.equals(code)) {
                return HttpStatus.FORBIDDEN;
            }
            if (BillingErrorCode.INTERNAL_ERROR.equals(code)) {
                return HttpStatus.INTERNAL_SERVER_ERROR;
            }
            return HttpStatus.PAYMENT_REQUIRED;
        }
        return HttpStatus.PAYMENT_REQUIRED;
    }

    private String openAiBillingErrorType(Exception e) {
        if (e instanceof BillingException be) {
            BillingErrorCode code = be.getCode();
            if (BillingErrorCode.USER_WALLET_INSUFFICIENT.equals(code)
                    || BillingErrorCode.USER_WALLET_FALLBACK_EXHAUSTED.equals(code)
                    || BillingErrorCode.SCENE_QUOTA_INSUFFICIENT.equals(code)) {
                return "insufficient_quota";
            }
            if (BillingErrorCode.SCENE_DISABLED.equals(code)) {
                return "access_terminated";
            }
        }
        return "billing_error";
    }

    private ObjectNode responseToChatRequest(JsonNode request) {
        ObjectNode chat = objectMapper.createObjectNode();
        chat.put("model", request.path("model").asText(""));
        if (request.has("temperature")) chat.set("temperature", request.get("temperature"));
        if (request.has("top_p")) chat.set("top_p", request.get("top_p"));
        if (request.has("stop")) chat.set("stop", request.get("stop"));
        if (request.has("max_output_tokens")) chat.set("max_tokens", request.get("max_output_tokens"));
        if (request.has("stream")) chat.set("stream", request.get("stream"));
        if (request.has("tools")) chat.set("tools", request.get("tools"));
        if (request.has("tool_choice")) chat.set("tool_choice", request.get("tool_choice"));
        if (request.has("parallel_tool_calls")) chat.set("parallel_tool_calls", request.get("parallel_tool_calls"));
        if (request.has("response_format")) {
            chat.set("response_format", request.get("response_format"));
        } else if (request.path("text").path("format").isObject()) {
            chat.set("response_format", request.path("text").path("format"));
        }
        applyResponsesReasoningOptions(request, chat);

        ArrayNode messages = chat.putArray("messages");
        String previousResponseId = request.path("previous_response_id").asText("");
        boolean restoredPrevious = restoreResponsesState(previousResponseId, messages);

        String instructions = request.path("instructions").asText("");
        if (!instructions.isBlank() && !restoredPrevious) {
            ObjectNode sys = messages.addObject();
            sys.put("role", "system");
            sys.put("content", instructions);
        }

        JsonNode input = request.get("input");
        appendResponsesInput(messages, input);
        if (messages.isEmpty()) {
            messages.addObject().put("role", "user").put("content", "");
        }
        return chat;
    }

    private void applyResponsesReasoningOptions(JsonNode request, ObjectNode chat) {
        if (request.has("thinking")) {
            chat.set("thinking", request.get("thinking"));
        }
        if (request.has("thinking_budget")) {
            chat.set("thinking_budget", request.get("thinking_budget"));
        }
        if (request.path("enable_thinking").asBoolean(false)) {
            chat.put("thinking", true);
            if (request.has("thinking_budget")) {
                chat.set("thinking_budget", request.get("thinking_budget"));
            }
        }
        JsonNode reasoning = request.path("reasoning");
        if (reasoning.isObject()) {
            chat.set("reasoning", reasoning);
            String effort = reasoning.path("effort").asText("");
            if (!effort.isBlank()) {
                chat.put("thinking", true);
                if (!chat.has("thinking_budget")) {
                    chat.put("thinking_budget", reasoningBudgetForEffort(effort));
                }
            }
        }
    }

    private int reasoningBudgetForEffort(String effort) {
        if (effort == null) return 8192;
        return switch (effort.trim().toLowerCase()) {
            case "minimal" -> 1024;
            case "low" -> 2048;
            case "high" -> 16000;
            default -> 8192;
        };
    }

    private void appendResponsesInput(ArrayNode messages, JsonNode input) {
        if (input == null || input.isNull() || input.isMissingNode()) {
            return;
        }
        if (input.isTextual()) {
            messages.addObject().put("role", "user").put("content", input.asText());
            return;
        }
        if (input.isArray()) {
            for (JsonNode item : input) {
                appendResponsesInputItem(messages, item);
            }
            return;
        }
        appendResponsesInputItem(messages, input);
    }

    private void appendResponsesInputItem(ArrayNode messages, JsonNode item) {
        if (item == null || item.isNull() || item.isMissingNode()) return;
        if (item.isTextual()) {
            messages.addObject().put("role", "user").put("content", item.asText());
            return;
        }

        String type = item.path("type").asText("");
        if ("function_call_output".equals(type)) {
            String callId = item.path("call_id").asText("");
            String output = responseOutputToText(item.path("output"));
            appendToolResultMessage(messages, callId, output);
            return;
        }

        if ("function_call".equals(type)) {
            appendFunctionCallMessage(messages, item);
            return;
        }

        if ("message".equals(type) || item.has("role")) {
            String role = item.path("role").asText("user");
            if ("tool".equals(role)) {
                String callId = firstText(item, "tool_call_id", "call_id");
                appendToolResultMessage(messages, callId, responseContentToText(item.path("content")));
                return;
            }
            ObjectNode msg = messages.addObject();
            msg.put("role", role);
            msg.set("content", responseContentToChatContent(role, item.path("content")));
            if (item.path("tool_calls").isArray()) {
                msg.set("tool_calls", item.path("tool_calls"));
            }
            return;
        }

        if ("input_text".equals(type) || "output_text".equals(type)) {
            ObjectNode msg = messages.addObject();
            msg.put("role", "output_text".equals(type) ? "assistant" : "user");
            msg.put("content", item.path("text").asText(""));
            return;
        }

        if ("input_image".equals(type)) {
            ObjectNode msg = messages.addObject();
            msg.put("role", "user");
            ArrayNode content = objectMapper.createArrayNode();
            ObjectNode image = content.addObject();
            image.put("type", "image_url");
            image.putObject("image_url").put("url", item.path("image_url").asText(item.path("url").asText("")));
            msg.set("content", content);
            return;
        }

        ObjectNode msg = messages.addObject();
        msg.put("role", "user");
        msg.put("content", item.toString());
    }

    private void appendToolResultMessage(ArrayNode messages, String callId, String output) {
        String safeOutput = output != null ? output : "";
        if (callId != null && !callId.isBlank() && hasPriorToolCall(messages, callId)) {
            ObjectNode tool = messages.addObject();
            tool.put("role", "tool");
            tool.put("tool_call_id", callId);
            tool.put("content", safeOutput);
            return;
        }

        // 没有 previous_response_id、状态已过期，或客户端没带 tool_call_id 时，
        // 绝不能向 Chat Completions 上游发送非法 role=tool 消息；退化为普通用户上下文。
        ObjectNode user = messages.addObject();
        user.put("role", "user");
        String label = callId != null && !callId.isBlank() ? "Tool result for call_id " + callId : "Tool result";
        user.put("content", label + ":\n" + safeOutput);
    }

    private JsonNode responseContentToChatContent(String role, JsonNode content) {
        if (content == null || content.isMissingNode() || content.isNull()) {
            return objectMapper.getNodeFactory().textNode("");
        }
        if (!content.isArray()) return content;

        boolean hasImage = false;
        StringBuilder text = new StringBuilder();
        ArrayNode multimodal = objectMapper.createArrayNode();
        for (JsonNode block : content) {
            String type = block.path("type").asText("");
            if ("input_text".equals(type) || "output_text".equals(type) || "text".equals(type)) {
                String value = block.path("text").asText("");
                text.append(value);
                ObjectNode next = multimodal.addObject();
                next.put("type", "text");
                next.put("text", value);
            } else if ("input_image".equals(type)) {
                hasImage = true;
                ObjectNode next = multimodal.addObject();
                next.put("type", "image_url");
                ObjectNode imageUrl = next.putObject("image_url");
                imageUrl.put("url", block.path("image_url").asText(block.path("url").asText("")));
            } else {
                String value = block.path("text").asText(block.toString());
                text.append(value);
                ObjectNode next = multimodal.addObject();
                next.put("type", "text");
                next.put("text", value);
            }
        }
        if (!hasImage || "assistant".equals(role)) {
            return objectMapper.getNodeFactory().textNode(text.toString());
        }
        return multimodal;
    }

    private void appendFunctionCallMessage(ArrayNode messages, JsonNode item) {
        ObjectNode msg = messages.addObject();
        msg.put("role", "assistant");
        msg.put("content", "");
        ArrayNode calls = msg.putArray("tool_calls");
        ObjectNode tc = calls.addObject();
        tc.put("id", item.path("call_id").asText(item.path("id").asText("")));
        tc.put("type", "function");
        ObjectNode fn = tc.putObject("function");
        fn.put("name", item.path("name").asText(""));
        fn.put("arguments", item.path("arguments").asText("{}"));
    }

    private boolean hasPriorToolCall(ArrayNode messages, String callId) {
        if (callId == null || callId.isBlank()) return false;
        for (JsonNode msg : messages) {
            JsonNode toolCalls = msg.path("tool_calls");
            if (!toolCalls.isArray()) continue;
            for (JsonNode tc : toolCalls) {
                if (callId.equals(tc.path("id").asText(""))) return true;
            }
        }
        return false;
    }

    private String responseOutputToText(JsonNode output) {
        if (output == null || output.isMissingNode() || output.isNull()) return "";
        if (output.isTextual()) return output.asText("");
        return output.toString();
    }

    private String responseContentToText(JsonNode content) {
        JsonNode normalized = responseContentToChatContent("tool", content);
        if (normalized == null || normalized.isMissingNode() || normalized.isNull()) return "";
        return normalized.isTextual() ? normalized.asText("") : normalized.toString();
    }

    private String firstText(JsonNode node, String... fields) {
        if (node == null || node.isMissingNode() || node.isNull()) return "";
        for (String field : fields) {
            String value = node.path(field).asText("");
            if (!value.isBlank()) return value;
        }
        return "";
    }

    private List<AiService.GatewayChannel> resolveResponsesGatewayChannels(JsonNode request) {
        String requested = request != null ? request.path("model").asText(null) : null;
        String resolved = modelAliasService != null ? modelAliasService.resolveModelId(requested) : requested;
        List<AiService.GatewayChannel> channels = aiService.resolveGatewayChannels(
                resolved, Set.of("responses", "chat_completions", "messages"));

        // 如果别名解析到了一个后台模型，但渠道 models 仍只配置了用户请求的短名，
        // 不要把 gpt-5.4-mini 错误变成 gpt-5.4-mini-日期版；回查原始模型名。
        if ((channels == null || channels.isEmpty())
                && requested != null && !requested.isBlank()
                && resolved != null && !resolved.equals(requested)) {
            channels = aiService.resolveGatewayChannels(requested, Set.of("responses", "chat_completions", "messages"));
        }
        if (channels == null || channels.isEmpty()) {
            return List.of();
        }

        String previousResponseId = request != null ? request.path("previous_response_id").asText("") : "";
        if (hasLiveResponsesState(previousResponseId)) {
            // 本地合成的 Responses 状态只有 Chat 转换路径能恢复；下一轮 tool output
            // 必须优先回到 chat_completions，避免把本地 resp_id 发给原生 Responses 上游。
            List<AiService.GatewayChannel> chat = new ArrayList<>();
            List<AiService.GatewayChannel> other = new ArrayList<>();
            for (AiService.GatewayChannel channel : channels) {
                if ("chat_completions".equals(normalizeGatewayApiFormat(channel.apiFormat()))) chat.add(channel);
                else other.add(channel);
            }
            chat.addAll(other);
            return chat;
        }
        return channels;
    }

    private boolean hasLiveResponsesState(String responseId) {
        if (responseId == null || responseId.isBlank()) return false;
        ResponsesState state = responsesStateStore.get(responseId);
        if (state == null) return false;
        if (state.expiresAtMs() < System.currentTimeMillis()) {
            responsesStateStore.remove(responseId);
            return false;
        }
        return true;
    }

    private String normalizeGatewayApiFormat(String apiFormat) {
        if (apiFormat == null || apiFormat.isBlank()) return "chat_completions";
        String normalized = apiFormat.trim().toLowerCase()
                .replace('-', '_')
                .replace('/', '_');
        return switch (normalized) {
            case "chat", "chat_completion", "chat_completions", "openai_chat_completions" -> "chat_completions";
            case "response", "responses", "openai_responses" -> "responses";
            case "message", "messages", "anthropic_messages" -> "messages";
            default -> normalized;
        };
    }

    private boolean isNativeResponsesFailure(JsonNode raw) {
        if (raw == null || raw.isMissingNode() || raw.isNull()) return false;
        String status = raw.path("status").asText("");
        JsonNode error = raw.get("error");
        boolean hasRealError = error != null
                && !error.isMissingNode()
                && !error.isNull()
                && !(error.isTextual() && error.asText("").isBlank())
                && !(error.isContainerNode() && error.isEmpty());
        return hasRealError || "failed".equals(status) || "error".equals(status);
    }

    private String nativeResponsesErrorMessage(JsonNode raw) {
        if (raw == null || raw.isMissingNode() || raw.isNull()) return "upstream responses failed";
        JsonNode error = raw.path("error");
        if (error.isObject()) {
            String msg = error.path("message").asText("");
            if (!msg.isBlank()) return msg;
        }
        if (error.isTextual()) return error.asText();
        return "upstream responses failed";
    }

    private ObjectNode toResponsesFormat(JsonNode raw, JsonNode originalRequest) {
        String text = extractAssistantText(raw);
        boolean incomplete = isLengthFinish(raw);
        String itemStatus = incomplete ? "incomplete" : "completed";
        String id = "resp_" + UUID.randomUUID().toString().replace("-", "");
        ObjectNode body = objectMapper.createObjectNode();
        body.put("id", id);
        body.put("object", "response");
        body.put("created_at", Instant.now().getEpochSecond());
        body.put("status", incomplete ? "incomplete" : "completed");
        String responseModel = originalRequest.path("model").asText("");
        if (responseModel.isBlank()) {
            responseModel = raw.path("model").asText("");
        }
        body.put("model", responseModel);
        if (originalRequest.has("previous_response_id")) {
            body.set("previous_response_id", originalRequest.get("previous_response_id"));
        } else {
            body.putNull("previous_response_id");
        }
        if (incomplete) {
            body.set("incomplete_details", incompleteDetails("max_output_tokens"));
        }
        body.put("output_text", text);
        ArrayNode output = body.putArray("output");
        JsonNode toolCalls = raw.path("choices").path(0).path("message").path("tool_calls");
        if (!text.isBlank() || !toolCalls.isArray() || toolCalls.isEmpty()) {
            ObjectNode message = output.addObject();
            message.put("id", "msg_" + UUID.randomUUID().toString().replace("-", ""));
            message.put("type", "message");
            message.put("status", itemStatus);
            message.put("role", "assistant");
            ArrayNode content = message.putArray("content");
            ObjectNode textBlock = content.addObject();
            textBlock.put("type", "output_text");
            textBlock.put("text", text);
            textBlock.set("annotations", objectMapper.createArrayNode());
        }

        // 工具调用 → function_call output items（供客户端执行）
        if (!incomplete && toolCalls.isArray()) {
            for (JsonNode tc : toolCalls) {
                ObjectNode fc = output.addObject();
                fc.put("id", "fc_" + UUID.randomUUID().toString().replace("-", ""));
                fc.put("type", "function_call");
                fc.put("status", "completed");
                fc.put("call_id", tc.path("id").asText(""));
                fc.put("name", tc.path("function").path("name").asText(""));
                fc.put("arguments", tc.path("function").path("arguments").asText(""));
            }
        }

        ObjectNode usage = body.putObject("usage");
        int inputTokens = raw.path("usage").path("prompt_tokens").asInt(0);
        int outputTokens = raw.path("usage").path("completion_tokens").asInt(0);
        int cachedTokens = raw.path("usage").path("prompt_tokens_details").path("cached_tokens").asInt(0);
        usage.put("input_tokens", inputTokens);
        usage.put("output_tokens", outputTokens);
        usage.put("total_tokens", inputTokens + outputTokens);
        usage.putObject("input_tokens_details").put("cached_tokens", cachedTokens);
        return body;
    }

    private void storeResponsesState(String responseId, JsonNode requestMessages, JsonNode raw) {
        if (responseId == null || responseId.isBlank()) return;
        try {
            pruneResponsesState();
            List<Map<String, Object>> messages = objectMapper.convertValue(
                    requestMessages,
                    objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
            Map<String, Object> assistant = assistantMessageFromRaw(raw);
            if (assistant != null) messages.add(assistant);
            responsesStateStore.put(responseId,
                    new ResponsesState(messages, System.currentTimeMillis() + RESPONSES_STATE_TTL_MS));
        } catch (Exception e) {
            log.warn("[OpenAiCompatible] 保存 Responses 会话状态失败: {}", e.getMessage());
        }
    }

    private boolean restoreResponsesState(String responseId, ArrayNode targetMessages) {
        if (responseId == null || responseId.isBlank()) return false;
        ResponsesState state = responsesStateStore.get(responseId);
        if (state == null) return false;
        if (state.expiresAtMs() < System.currentTimeMillis()) {
            responsesStateStore.remove(responseId);
            return false;
        }
        for (Map<String, Object> msg : state.messages()) {
            targetMessages.add(objectMapper.valueToTree(msg));
        }
        return true;
    }

    private Map<String, Object> assistantMessageFromRaw(JsonNode raw) {
        JsonNode message = raw.path("choices").path(0).path("message");
        if (message.isMissingNode()) return null;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("role", "assistant");
        JsonNode content = message.path("content");
        result.put("content", content.isMissingNode() || content.isNull() ? "" :
                (content.isTextual() ? content.asText("") : objectMapper.convertValue(content, Object.class)));
        JsonNode toolCalls = message.path("tool_calls");
        if (toolCalls.isArray() && !toolCalls.isEmpty()) {
            result.put("tool_calls", objectMapper.convertValue(toolCalls, List.class));
        }
        return result;
    }

    private void pruneResponsesState() {
        long now = System.currentTimeMillis();
        responsesStateStore.entrySet().removeIf(e -> e.getValue().expiresAtMs() < now);
        if (responsesStateStore.size() <= MAX_RESPONSES_STATE) return;
        int overflow = responsesStateStore.size() - MAX_RESPONSES_STATE;
        for (String key : new ArrayList<>(responsesStateStore.keySet())) {
            if (overflow-- <= 0) break;
            responsesStateStore.remove(key);
        }
    }

    /**
     * 真流式 /chat/completions（网关模式，单轮，工具调用透传给客户端执行）。
     * 逐 token 发送 chat.completion.chunk，收尾补 tool_calls（若有）+ finish_reason + usage。
     */
    private SseEmitter chatSseStreaming(UserApiKeyService.AuthenticatedApiKey auth, JsonNode request,
                                        String requestedModel, long start, RequestSnapshot requestSnapshot) {
        SseEmitter emitter = newGatewaySseEmitter();
        String id = "chatcmpl-" + UUID.randomUUID().toString().replace("-", "");
        sseExecutor.submit(() -> {
            AtomicBoolean clientGone = new AtomicBoolean(false);
            try {
                String model = modelAliasService.resolveModelId(request.path("model").asText(null));
                String system = request.path("system").asText(null);
                Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                        ? request.get("temperature").asDouble() : null;
                Integer maxTokens = firstInt(request, "max_tokens", "max_completion_tokens");
                List<Map<String, Object>> messages = objectMapper.convertValue(
                        request.path("messages"),
                        objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
                List<ToolDefinition> tools = parseTools(request.path("tools"));
                Boolean thinking = thinkingEnabled(request);
                Integer thinkingBudget = thinkingBudget(request);

                // 首个 chunk：角色
                emitter.send(SseEmitter.event().data(chatRoleChunk(id, requestedModel)));

                JsonNode synthetic = aiService.streamChatCompletionRaw(
                        model, system, messages, temperature, maxTokens, tools, thinking, thinkingBudget, false,
                        request,
                        true,
                        token -> {
                            try {
                                emitter.send(SseEmitter.event().data(chatDeltaChunk(id, requestedModel, token)));
                            } catch (Exception e) {
                                clientGone.set(true);
                                log.warn("[OpenAiCompatible] chat SSE token 发送失败: {}", e.getMessage());
                            }
                        });

                if (clientGone.get()) {
                    emitter.complete();
                    return;
                }

                markLengthIfUnsafeToolCalls(synthetic);
                JsonNode message = synthetic.path("choices").path(0).path("message");
                JsonNode toolCalls = message.path("tool_calls");
                boolean incomplete = isLengthFinish(synthetic);
                boolean hasToolCalls = toolCalls.isArray() && !toolCalls.isEmpty();
                if (hasToolCalls && !incomplete) {
                    emitter.send(SseEmitter.event().data(chatToolCallsChunk(id, requestedModel, toolCalls)));
                }
                String upstreamFinishReason = synthetic.path("choices").path(0).path("finish_reason").asText("stop");
                String finishReason = "length".equals(upstreamFinishReason)
                        ? "length"
                        : (hasToolCalls ? "tool_calls" : upstreamFinishReason);
                emitter.send(SseEmitter.event().data(chatFinishChunk(id, requestedModel, finishReason, synthetic.path("usage"))));
                emitter.send(SseEmitter.event().data("[DONE]"));
                emitter.complete();

                safeTrackSuccess(auth, synthetic, requestedModel, start, requestSnapshot, "api");
            } catch (Exception e) {
                if (clientGone.get() || isClientDisconnect(e)) {
                    log.info("[OpenAiCompatible] chat SSE client disconnected: {}", e.getMessage());
                    try { emitter.complete(); } catch (Exception ignored) {}
                    return;
                }
                log.warn("[OpenAiCompatible] chat 流式失败: {}", e.getMessage());
                safeTrackFailure(auth, requestedModel, start, e, "api");
                try {
                    ObjectNode err = objectMapper.createObjectNode();
                    err.putObject("error").put("message", e.getMessage() != null ? e.getMessage() : "server_error")
                            .put("type", "server_error");
                    emitter.send(SseEmitter.event().data(err));
                    emitter.complete();
                } catch (Exception ignored) {}
            }
        });
        return emitter;
    }

    /**
     * 真流式 /responses（网关模式）。事件对齐 OpenAI Responses API：
     * response.created → output_item.added(message) → output_text.delta* →
     * output_text.done → [function_call items] → response.completed。
     */
    private SseEmitter responseSseStreaming(UserApiKeyService.AuthenticatedApiKey auth, JsonNode request,
                                            String requestedModel, long start, RequestSnapshot requestSnapshot) {
        SseEmitter emitter = newGatewaySseEmitter();
        sseExecutor.submit(() -> {
            AtomicBoolean clientGone = new AtomicBoolean(false);
            try {
                List<AiService.GatewayChannel> channels = resolveResponsesGatewayChannels(request);
                if (channels.isEmpty()) {
                    throw new RuntimeException("Specified model has no available channel: "
                            + (requestedModel != null ? requestedModel : "unknown"));
                }

                Exception lastError = null;
                for (AiService.GatewayChannel channel : channels) {
                    AtomicBoolean emittedOnThisChannel = new AtomicBoolean(false);
                    try {
                        if ("responses".equals(normalizeGatewayApiFormat(channel.apiFormat()))) {
                            List<AiService.GatewayResponsesEvent> bufferedEvents = new ArrayList<>();
                            AtomicBoolean released = new AtomicBoolean(false);
                            AiService.GatewayResponsesStreamResult result = aiService.streamResponsesRawOnGatewayChannel(
                                    channel, request, (int) Math.max(1L, gatewayStreamTimeoutSeconds), event -> {
                                        if (!released.get()) {
                                            bufferedEvents.add(event);
                                            if (isMeaningfulGatewayResponsesEvent(event)) {
                                                flushGatewayResponsesEvents(emitter, emittedOnThisChannel, bufferedEvents);
                                                released.set(true);
                                            }
                                            return;
                                        }
                                        sendGatewayResponsesEvent(emitter, event);
                                        emittedOnThisChannel.set(true);
                                    });
                            if (result.failed() && !released.get()) {
                                // 上游 Responses 在产生任何 text/tool 之前失败，不能把空失败流交给 IDE；
                                // 继续尝试下一个候选渠道（通常是 chat_completions 兼容路径）。
                                lastError = new RuntimeException("upstream responses stream failed before output");
                                log.warn("[OpenAiCompatible] native responses stream failed before output; fallback to next channel: channel={}",
                                        channel.channelId());
                                continue;
                            }
                            if (!result.failed() && !result.sawOutputOrTool() && !released.get()) {
                                lastError = new RuntimeException("upstream responses stream completed without text or tool call");
                                log.warn("[OpenAiCompatible] native responses stream completed empty; fallback to next channel: channel={}",
                                        channel.channelId());
                                continue;
                            }
                            if (!released.get()) {
                                flushGatewayResponsesEvents(emitter, emittedOnThisChannel, bufferedEvents);
                                released.set(true);
                            }
                            if (result.failed()) {
                                safeTrackFailure(auth, requestedModel, start,
                                        new RuntimeException("upstream responses stream failed"), "api");
                            } else if (result.finalResponse() != null) {
                                safeTrackSuccess(auth, result.finalResponse(), requestedModel, start, requestSnapshot, "api");
                            }
                            emitter.complete();
                            return;
                        }

                        streamResponsesViaChatChannel(auth, request, requestedModel, start, requestSnapshot,
                                emitter, clientGone, channel, emittedOnThisChannel);
                        return;
                    } catch (Exception channelError) {
                        if (clientGone.get() || isClientDisconnect(channelError)) {
                            log.info("[OpenAiCompatible] responses SSE client disconnected: {}", channelError.getMessage());
                            try { emitter.complete(); } catch (Exception ignored) {}
                            return;
                        }
                        lastError = channelError;
                        log.warn("[OpenAiCompatible] responses stream channel failed: channel={}, format={}, emitted={}, error={}",
                                channel.channelId(), channel.apiFormat(), emittedOnThisChannel.get(), channelError.getMessage());
                        if (emittedOnThisChannel.get()) {
                            throw channelError;
                        }
                    }
                }
                throw lastError != null ? lastError : new RuntimeException("All Responses candidate channels failed");
            } catch (Exception e) {
                if (clientGone.get() || isClientDisconnect(e)) {
                    log.info("[OpenAiCompatible] responses SSE client disconnected: {}", e.getMessage());
                    try { emitter.complete(); } catch (Exception ignored) {}
                    return;
                }
                log.warn("[OpenAiCompatible] responses 流式失败: {}", e.getMessage());
                safeTrackFailure(auth, requestedModel, start, e, "api");
                try {
                    ObjectNode err = objectMapper.createObjectNode();
                    err.put("type", "response.failed");
                    err.putObject("error").put("message", e.getMessage() != null ? e.getMessage() : "server_error");
                    sendResponseEvent(emitter, err);
                    emitter.complete();
                } catch (Exception ignored) {}
            }
        });
        return emitter;
    }

    private void streamResponsesViaChatChannel(UserApiKeyService.AuthenticatedApiKey auth,
                                               JsonNode request,
                                               String requestedModel,
                                               long start,
                                               RequestSnapshot requestSnapshot,
                                               SseEmitter emitter,
                                               AtomicBoolean clientGone,
                                               AiService.GatewayChannel channel,
                                               AtomicBoolean emittedOnThisChannel) throws Exception {
        String respId = "resp_" + UUID.randomUUID().toString().replace("-", "");
        String msgId = "msg_" + UUID.randomUUID().toString().replace("-", "");
        ObjectNode chatReq = responseToChatRequest(request);
        String system = chatReq.path("system").asText(null);
        Double temperature = chatReq.has("temperature") && chatReq.get("temperature").isNumber()
                ? chatReq.get("temperature").asDouble() : null;
        Integer maxTokens = firstInt(chatReq, "max_tokens", "max_completion_tokens");
        List<Map<String, Object>> messages = objectMapper.convertValue(
                chatReq.path("messages"),
                objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
        List<ToolDefinition> tools = parseTools(chatReq.path("tools"));
        Boolean thinking = thinkingEnabled(chatReq);
        Integer thinkingBudget = thinkingBudget(chatReq);

        AtomicBoolean lifecycleStarted = new AtomicBoolean(false);
        StringBuilder full = new StringBuilder();
        AtomicBoolean textStarted = new AtomicBoolean(false);
        JsonNode synthetic = aiService.streamChatCompletionRawOnGatewayChannel(
                channel, system, messages, temperature, maxTokens, tools, thinking, thinkingBudget, chatReq,
                token -> {
                    try {
                        ensureResponsesLifecycle(emitter, lifecycleStarted, emittedOnThisChannel, respId, requestedModel);
                        if (textStarted.compareAndSet(false, true)) {
                            sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseOutputItemAdded(msgId, 0));
                            sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseContentPartAdded(msgId, 0));
                        }
                        full.append(token);
                        sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseTextDelta(msgId, 0, token));
                    } catch (Exception e) {
                        clientGone.set(true);
                        log.warn("[OpenAiCompatible] responses SSE token 发送失败: {}", e.getMessage());
                    }
                });

        if (clientGone.get()) {
            emitter.complete();
            return;
        }

        markLengthIfUnsafeToolCalls(synthetic);
        boolean incomplete = isLengthFinish(synthetic);
        String itemStatus = incomplete ? "incomplete" : "completed";

        ensureResponsesLifecycle(emitter, lifecycleStarted, emittedOnThisChannel, respId, requestedModel);

        // output_text.done + content_part.done
        if (textStarted.get()) {
            sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseTextDone(msgId, 0, full.toString()));
            sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseContentPartDone(msgId, 0, full.toString()));
            sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseOutputItemDone(msgId, 0, full.toString(), itemStatus));
        }

        // 工具调用：每个 tool_call 作为一个 function_call output item。
        // length/incomplete 场景只发送 added/arguments.delta，不发送 done/completed，避免 IDE 执行半截 JSON。
        JsonNode message = synthetic.path("choices").path(0).path("message");
        JsonNode toolCalls = message.path("tool_calls");
        int outputIndex = textStarted.get() ? 1 : 0;
        if (toolCalls.isArray()) {
            for (JsonNode tc : toolCalls) {
                String itemId = "fc_" + UUID.randomUUID().toString().replace("-", "");
                sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseFunctionCallAdded(tc, outputIndex, itemId));
                String args = tc.path("function").path("arguments").asText("");
                if (!args.isEmpty()) {
                    sendTrackedResponseEvent(emitter, emittedOnThisChannel,
                            responseFunctionCallArgumentsDelta(tc, outputIndex, itemId, args));
                }
                if (!incomplete) {
                    sendTrackedResponseEvent(emitter, emittedOnThisChannel,
                            responseFunctionCallArgumentsDone(tc, outputIndex, itemId, args));
                    sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseFunctionCallDone(tc, outputIndex, itemId));
                }
                outputIndex++;
            }
        }

        // 终态 response.completed / response.incomplete（带完整 response 对象）
        ObjectNode finalResponse = toResponsesFormat(synthetic, request);
        finalResponse.put("id", respId);
        if (!incomplete) {
            // 必须在 terminal 事件发出前保存状态，避免 IDE 收到终态后立刻发下一轮
            // previous_response_id + function_call_output 时抢跑。
            storeResponsesState(respId, chatReq.path("messages"), synthetic);
        }
        ObjectNode terminal = objectMapper.createObjectNode();
        terminal.put("type", incomplete ? "response.incomplete" : "response.completed");
        terminal.set("response", finalResponse);
        sendTrackedResponseEvent(emitter, emittedOnThisChannel, terminal);
        // 兼容部分 Coding Agent/IDE 的 Responses SSE 解析器：
        // 官方终态事件仍保留 response.completed/response.incomplete，
        // 额外补一个 response.done 作为“完整 response 已落地”的收尾信号。
        sendTrackedResponseEvent(emitter, emittedOnThisChannel, responseDoneEvent(finalResponse));
        emitter.complete();

        safeTrackSuccess(auth, synthetic, requestedModel, start, requestSnapshot, "api");
    }

    // ===== chat.completion.chunk 构建 =====

    private ObjectNode chatRoleChunk(String id, String model) {
        ObjectNode chunk = baseChatChunk(id, model);
        ObjectNode delta = ((ObjectNode) chunk.path("choices").get(0)).putObject("delta");
        delta.put("role", "assistant");
        ((ObjectNode) chunk.path("choices").get(0)).putNull("finish_reason");
        return chunk;
    }

    private ObjectNode chatDeltaChunk(String id, String model, String content) {
        ObjectNode chunk = baseChatChunk(id, model);
        ObjectNode choice = (ObjectNode) chunk.path("choices").get(0);
        choice.putObject("delta").put("content", content);
        choice.putNull("finish_reason");
        return chunk;
    }

    private ObjectNode chatToolCallsChunk(String id, String model, JsonNode toolCalls) {
        ObjectNode chunk = baseChatChunk(id, model);
        ObjectNode choice = (ObjectNode) chunk.path("choices").get(0);
        ObjectNode delta = choice.putObject("delta");
        ArrayNode tcArr = delta.putArray("tool_calls");
        int i = 0;
        for (JsonNode tc : toolCalls) {
            ObjectNode out = tcArr.addObject();
            out.put("index", i++);
            out.put("id", tc.path("id").asText(""));
            out.put("type", "function");
            ObjectNode fn = out.putObject("function");
            fn.put("name", tc.path("function").path("name").asText(""));
            fn.put("arguments", tc.path("function").path("arguments").asText(""));
        }
        choice.putNull("finish_reason");
        return chunk;
    }

    private ObjectNode chatFinishChunk(String id, String model, String finishReason, JsonNode usage) {
        ObjectNode chunk = baseChatChunk(id, model);
        ObjectNode choice = (ObjectNode) chunk.path("choices").get(0);
        choice.putObject("delta");
        choice.put("finish_reason", finishReason);
        if (usage != null && !usage.isMissingNode()) {
            ObjectNode u = chunk.putObject("usage");
            u.put("prompt_tokens", usage.path("prompt_tokens").asInt(0));
            u.put("completion_tokens", usage.path("completion_tokens").asInt(0));
            u.put("total_tokens", usage.path("prompt_tokens").asInt(0) + usage.path("completion_tokens").asInt(0));
        }
        return chunk;
    }

    private ObjectNode baseChatChunk(String id, String model) {
        ObjectNode chunk = objectMapper.createObjectNode();
        chunk.put("id", id);
        chunk.put("object", "chat.completion.chunk");
        chunk.put("created", Instant.now().getEpochSecond());
        chunk.put("model", model != null ? model : "");
        ArrayNode choices = chunk.putArray("choices");
        choices.addObject().put("index", 0);
        return chunk;
    }

    // ===== Responses 事件构建 =====

    private ObjectNode responseLifecycleEvent(String type, String respId, String model, String status) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", type);
        ObjectNode response = event.putObject("response");
        response.put("id", respId);
        response.put("object", "response");
        response.put("status", status);
        response.put("model", model != null ? model : "");
        return event;
    }

    private ObjectNode responseDoneEvent(JsonNode finalResponse) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.done");
        event.set("response", finalResponse);
        return event;
    }

    private SseEmitter newGatewaySseEmitter() {
        long timeoutMs = Math.max(1L, gatewayStreamTimeoutSeconds) * 1000L;
        SseEmitter emitter = new SseEmitter(timeoutMs);
        startHeartbeat(emitter);
        return emitter;
    }

    private ResponseEntity<ResponseBodyEmitter> sseResponse(SseEmitter emitter) {
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_EVENT_STREAM)
                .header(HttpHeaders.CACHE_CONTROL, "no-cache")
                .header("X-Accel-Buffering", "no")
                .body(emitter);
    }

    private ResponseEntity<ResponseBodyEmitter> jsonEmitter(ResponseEntity<?> entity) {
        HttpStatus status = HttpStatus.resolve(entity.getStatusCode().value());
        if (status == null) status = HttpStatus.OK;
        return jsonEmitter(status, entity.getBody());
    }

    private ResponseEntity<ResponseBodyEmitter> jsonErrorEmitter(HttpStatus status, String type, String message) {
        ObjectNode body = objectMapper.createObjectNode();
        ObjectNode error = body.putObject("error");
        error.put("message", message != null ? message : "Request failed");
        error.put("type", type != null && !type.isBlank() ? type : "server_error");
        error.putNull("param");
        error.putNull("code");
        return jsonEmitter(status != null ? status : HttpStatus.INTERNAL_SERVER_ERROR, body);
    }

    private ResponseEntity<ResponseBodyEmitter> jsonEmitter(HttpStatus status, Object body) {
        long timeoutMs = Math.max(1L, gatewayStreamTimeoutSeconds) * 1000L;
        ResponseBodyEmitter emitter = new ResponseBodyEmitter(timeoutMs);
        sseExecutor.submit(() -> {
            try {
                if (body != null) {
                    emitter.send(body, MediaType.APPLICATION_JSON);
                }
                emitter.complete();
            } catch (Exception e) {
                try { emitter.completeWithError(e); } catch (Exception ignored) {}
            }
        });
        return ResponseEntity.status(status != null ? status : HttpStatus.OK)
                .contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CACHE_CONTROL, "no-cache")
                .body(emitter);
    }

    private SseEmitter errorSseEmitter(String type, String message) {
        SseEmitter emitter = newGatewaySseEmitter();
        sseExecutor.submit(() -> {
            try {
                ObjectNode err = objectMapper.createObjectNode();
                err.put("type", "response.failed");
                err.putObject("error")
                        .put("type", type != null && !type.isBlank() ? type : "server_error")
                        .put("message", message != null ? message : "Request failed");
                sendResponseEvent(emitter, err);
                emitter.complete();
            } catch (Exception ignored) {
                try { emitter.complete(); } catch (Exception ignored2) {}
            }
        });
        return emitter;
    }

    private void startHeartbeat(SseEmitter emitter) {
        AtomicBoolean open = new AtomicBoolean(true);
        AtomicReference<ScheduledFuture<?>> futureRef = new AtomicReference<>();
        Runnable cancel = () -> {
            open.set(false);
            ScheduledFuture<?> future = futureRef.get();
            if (future != null) future.cancel(false);
        };
        emitter.onCompletion(cancel);
        emitter.onTimeout(cancel);
        emitter.onError(error -> cancel.run());
        ScheduledFuture<?> future = sseHeartbeatExecutor.scheduleAtFixedRate(() -> {
            if (!open.get()) return;
            try {
                // 使用 SSE comment 作为心跳，避免向严格 Responses 事件解析器注入未知业务事件。
                emitter.send(SseEmitter.event().comment("keep-alive"));
            } catch (Exception e) {
                cancel.run();
            }
        }, 20, 20, TimeUnit.SECONDS);
        futureRef.set(future);
    }

    private void sendResponseEvent(SseEmitter emitter, ObjectNode event) throws Exception {
        String type = event.path("type").asText("");
        SseEmitter.SseEventBuilder builder = SseEmitter.event().data(event);
        if (!type.isBlank()) builder.name(type);
        emitter.send(builder);
    }

    private void sendTrackedResponseEvent(SseEmitter emitter, AtomicBoolean emitted, ObjectNode event) throws Exception {
        sendResponseEvent(emitter, event);
        if (emitted != null) emitted.set(true);
    }

    private void ensureResponsesLifecycle(SseEmitter emitter,
                                          AtomicBoolean lifecycleStarted,
                                          AtomicBoolean emitted,
                                          String respId,
                                          String requestedModel) throws Exception {
        if (lifecycleStarted.compareAndSet(false, true)) {
            sendTrackedResponseEvent(emitter, emitted,
                    responseLifecycleEvent("response.created", respId, requestedModel, "in_progress"));
            sendTrackedResponseEvent(emitter, emitted,
                    responseLifecycleEvent("response.in_progress", respId, requestedModel, "in_progress"));
        }
    }

    private void sendGatewayResponsesEvent(SseEmitter emitter, AiService.GatewayResponsesEvent event) throws Exception {
        if (event == null) return;
        String eventName = event.eventName();
        JsonNode json = event.json();
        SseEmitter.SseEventBuilder builder = SseEmitter.event();
        if (eventName != null && !eventName.isBlank()) {
            builder.name(eventName);
        }
        if (json != null && !json.isMissingNode() && !json.isNull()) {
            builder.data(json);
        } else {
            builder.data(event.rawData() != null ? event.rawData() : "");
        }
        emitter.send(builder);
    }

    private void flushGatewayResponsesEvents(SseEmitter emitter,
                                             AtomicBoolean emitted,
                                             List<AiService.GatewayResponsesEvent> events) throws Exception {
        if (events == null || events.isEmpty()) return;
        for (AiService.GatewayResponsesEvent event : events) {
            sendGatewayResponsesEvent(emitter, event);
            if (emitted != null) emitted.set(true);
        }
        events.clear();
    }

    private boolean isMeaningfulGatewayResponsesEvent(AiService.GatewayResponsesEvent event) {
        if (event == null) return false;
        JsonNode json = event.json();
        if (json == null || json.isMissingNode() || json.isNull()) return false;
        String type = json.path("type").asText(event.eventName() != null ? event.eventName() : "");
        if ("response.output_text.delta".equals(type)) {
            return !json.path("delta").asText("").isBlank();
        }
        if ("response.output_text.done".equals(type)) {
            return !json.path("text").asText("").isBlank();
        }
        if ("response.output_item.added".equals(type) || "response.output_item.done".equals(type)) {
            JsonNode item = json.path("item");
            String itemType = item.path("type").asText("");
            if ("function_call".equals(itemType)) {
                return !item.path("call_id").asText(item.path("id").asText("")).isBlank()
                        || !item.path("name").asText("").isBlank();
            }
            return "message".equals(itemType) && responsesMessageItemHasText(item);
        }
        if ("response.completed".equals(type) || "response.incomplete".equals(type) || "response.done".equals(type)) {
            return responsesHasTextOrTool(json.path("response"));
        }
        return false;
    }

    private boolean responsesHasTextOrTool(JsonNode response) {
        if (response == null || response.isMissingNode() || response.isNull()) return false;
        if (!response.path("output_text").asText("").isBlank()) return true;
        JsonNode output = response.path("output");
        if (!output.isArray()) return false;
        for (JsonNode item : output) {
            String type = item.path("type").asText("");
            if ("function_call".equals(type)) return true;
            if ("message".equals(type) && responsesMessageItemHasText(item)) return true;
        }
        return false;
    }

    private boolean responsesMessageItemHasText(JsonNode item) {
        if (item == null || item.isMissingNode() || item.isNull()) return false;
        JsonNode content = item.path("content");
        if (!content.isArray()) return false;
        for (JsonNode block : content) {
            if (!block.path("text").asText("").isBlank()) return true;
        }
        return false;
    }

    private ObjectNode responseOutputItemAdded(String msgId, int outputIndex) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_item.added");
        event.put("output_index", outputIndex);
        ObjectNode item = event.putObject("item");
        item.put("id", msgId);
        item.put("type", "message");
        item.put("status", "in_progress");
        item.put("role", "assistant");
        item.putArray("content");
        return event;
    }

    private ObjectNode responseContentPartAdded(String msgId, int outputIndex) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.content_part.added");
        event.put("item_id", msgId);
        event.put("output_index", outputIndex);
        event.put("content_index", 0);
        ObjectNode part = event.putObject("part");
        part.put("type", "output_text");
        part.put("text", "");
        part.set("annotations", objectMapper.createArrayNode());
        return event;
    }

    private ObjectNode responseTextDelta(String msgId, int outputIndex, String delta) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_text.delta");
        event.put("item_id", msgId);
        event.put("output_index", outputIndex);
        event.put("content_index", 0);
        event.put("delta", delta);
        return event;
    }

    private ObjectNode responseTextDone(String msgId, int outputIndex, String text) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_text.done");
        event.put("item_id", msgId);
        event.put("output_index", outputIndex);
        event.put("content_index", 0);
        event.put("text", text);
        return event;
    }

    private ObjectNode responseContentPartDone(String msgId, int outputIndex, String text) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.content_part.done");
        event.put("item_id", msgId);
        event.put("output_index", outputIndex);
        event.put("content_index", 0);
        ObjectNode part = event.putObject("part");
        part.put("type", "output_text");
        part.put("text", text);
        part.set("annotations", objectMapper.createArrayNode());
        return event;
    }

    private ObjectNode responseOutputItemDone(String msgId, int outputIndex, String text) {
        return responseOutputItemDone(msgId, outputIndex, text, "completed");
    }

    private ObjectNode responseOutputItemDone(String msgId, int outputIndex, String text, String status) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_item.done");
        event.put("output_index", outputIndex);
        ObjectNode item = event.putObject("item");
        item.put("id", msgId);
        item.put("type", "message");
        item.put("status", status != null && !status.isBlank() ? status : "completed");
        item.put("role", "assistant");
        ArrayNode content = item.putArray("content");
        ObjectNode part = content.addObject();
        part.put("type", "output_text");
        part.put("text", text);
        part.set("annotations", objectMapper.createArrayNode());
        return event;
    }

    private ObjectNode responseFunctionCallAdded(JsonNode toolCall, int outputIndex, String itemId) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_item.added");
        event.put("output_index", outputIndex);
        event.set("item", functionCallItem(toolCall, itemId, "in_progress"));
        return event;
    }

    private ObjectNode responseFunctionCallArgumentsDelta(JsonNode toolCall, int outputIndex, String itemId, String delta) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.function_call_arguments.delta");
        event.put("item_id", itemId);
        event.put("output_index", outputIndex);
        event.put("delta", delta);
        return event;
    }

    private ObjectNode responseFunctionCallArgumentsDone(JsonNode toolCall, int outputIndex, String itemId, String arguments) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.function_call_arguments.done");
        event.put("item_id", itemId);
        event.put("output_index", outputIndex);
        event.put("call_id", toolCall.path("id").asText(""));
        event.put("name", toolCall.path("function").path("name").asText(""));
        event.put("arguments", arguments);
        return event;
    }

    private ObjectNode responseFunctionCallDone(JsonNode toolCall, int outputIndex, String itemId) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "response.output_item.done");
        event.put("output_index", outputIndex);
        event.set("item", functionCallItem(toolCall, itemId, "completed"));
        return event;
    }

    private ObjectNode functionCallItem(JsonNode toolCall, String itemId, String status) {
        ObjectNode item = objectMapper.createObjectNode();
        item.put("id", itemId);
        item.put("type", "function_call");
        item.put("status", status);
        item.put("call_id", toolCall.path("id").asText(""));
        item.put("name", toolCall.path("function").path("name").asText(""));
        item.put("arguments", toolCall.path("function").path("arguments").asText(""));
        return item;
    }

    private List<ToolDefinition> parseTools(JsonNode toolsNode) {
        List<ToolDefinition> tools = new ArrayList<>();
        if (toolsNode == null || !toolsNode.isArray()) return tools;
        for (JsonNode rawTool : toolsNode) {
            JsonNode fn = rawTool.path("function").isMissingNode() ? rawTool : rawTool.path("function");
            String name = fn.path("name").asText("");
            if (name.isBlank()) continue;
            ObjectNode parameters = fn.path("parameters").isObject()
                    ? (ObjectNode) fn.path("parameters")
                    : objectMapper.createObjectNode().put("type", "object");
            tools.add(new ToolDefinition(name, fn.path("description").asText(""), parameters));
        }
        return tools;
    }

    private List<String> parseModelList(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        String trimmed = raw.trim();
        try {
            JsonNode node = objectMapper.readTree(trimmed);
            if (node.isArray()) {
                List<String> result = new ArrayList<>();
                for (JsonNode item : node) {
                    String id = item.isTextual()
                            ? item.asText("")
                            : item.path("model_id").asText(item.path("id").asText(item.path("modelId").asText("")));
                    if (!id.isBlank()) result.add(id);
                }
                return result;
            }
        } catch (Exception ignored) {
            // fallback to comma-separated format
        }
        List<String> result = new ArrayList<>();
        for (String item : trimmed.split(",")) {
            String id = item.trim();
            if (!id.isBlank()) result.add(id);
        }
        return result;
    }

    private void safeTrackSuccess(UserApiKeyService.AuthenticatedApiKey auth, JsonNode raw, String fallbackModel,
                                  long start, RequestSnapshot requestSnapshot, String scene) {
        try {
            String model = fallbackModel != null && !fallbackModel.isBlank()
                    ? fallbackModel
                    : raw.path("model").asText("unknown");
            JsonNode usage = raw.path("usage");
            int inputTokens = usage.path("prompt_tokens").asInt(usage.path("input_tokens").asInt(0));
            int outputTokens = usage.path("completion_tokens").asInt(usage.path("output_tokens").asInt(0));
            int cached = usage.path("prompt_tokens_details").path("cached_tokens")
                    .asInt(usage.path("input_tokens_details").path("cached_tokens").asInt(0));
            AiService.UsedChannel usedChannel = aiService != null ? aiService.getCurrentUsedChannel() : null;
            usageTrackingService.trackFull(auth.getUserId(), model, inputTokens, cached, outputTokens,
                    elapsed(start), scene, null,
                    requestSnapshot != null ? requestSnapshot.clientIp() : null,
                    usedChannel != null ? usedChannel.provider() : null,
                    usedChannel != null && usedChannel.channelId() != null ? String.valueOf(usedChannel.channelId()) : null);
        } catch (Exception e) {
            log.warn("[OpenAiCompatible] usage success tracking skipped: {}", e.getMessage());
        } finally {
            if (aiService != null) {
                aiService.clearCurrentUsedChannel();
            }
        }
    }

    private void safeTrackFailure(UserApiKeyService.AuthenticatedApiKey auth, String fallbackModel,
                                  long start, Exception error, String scene) {
        try {
            usageTrackingService.trackFailure(auth.getUserId(), fallbackModel != null ? fallbackModel : "unknown",
                    0, 0, elapsed(start), scene, error != null ? error.getMessage() : null);
        } catch (Exception e) {
            log.warn("[OpenAiCompatible] usage failure tracking skipped: {}", e.getMessage());
        }
    }

    private UserApiKeyService.AuthenticatedApiKey authenticate(String authorization) {
        return userApiKeyService.authenticate(authorization);
    }

    private ResponseEntity<ObjectNode> unauthorized() {
        return openAiError(HttpStatus.UNAUTHORIZED, "invalid_api_key", "Invalid or missing API key");
    }

    private ResponseEntity<ObjectNode> openAiError(HttpStatus status, String type, String message) {
        ObjectNode body = objectMapper.createObjectNode();
        ObjectNode error = body.putObject("error");
        error.put("message", message != null ? message : "Request failed");
        error.put("type", type);
        error.putNull("param");
        error.putNull("code");
        return ResponseEntity.status(status).body(body);
    }

    private String extractAssistantText(JsonNode raw) {
        JsonNode content = raw.path("choices").path(0).path("message").path("content");
        if (content.isTextual()) return content.asText("");
        if (content.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode part : content) {
                if (part.has("text")) sb.append(part.path("text").asText(""));
            }
            return sb.toString();
        }
        return "";
    }

    private boolean isLengthFinish(JsonNode raw) {
        return "length".equals(raw.path("choices").path(0).path("finish_reason").asText(""));
    }

    private void markLengthIfUnsafeToolCalls(JsonNode raw) {
        if (raw == null || raw.isMissingNode() || raw.isNull()) return;
        JsonNode choice = raw.path("choices").path(0);
        if (!(choice instanceof ObjectNode choiceObj)) return;
        JsonNode toolCalls = choice.path("message").path("tool_calls");
        if (hasIncompleteToolCallArguments(toolCalls)) {
            choiceObj.put("finish_reason", "length");
        }
    }

    private boolean hasIncompleteToolCallArguments(JsonNode toolCalls) {
        if (toolCalls == null || !toolCalls.isArray() || toolCalls.isEmpty()) return false;
        for (JsonNode tc : toolCalls) {
            String args = tc.path("function").path("arguments").asText("");
            if (args.isBlank()) return true;
            try {
                objectMapper.readTree(args);
            } catch (Exception e) {
                return true;
            }
        }
        return false;
    }

    private ObjectNode incompleteDetails(String reason) {
        ObjectNode details = objectMapper.createObjectNode();
        details.put("reason", reason != null && !reason.isBlank() ? reason : "max_output_tokens");
        return details;
    }

    private boolean isClientDisconnect(Throwable error) {
        Throwable current = error;
        while (current != null) {
            String className = current.getClass().getName().toLowerCase();
            String message = current.getMessage() != null ? current.getMessage().toLowerCase() : "";
            if (className.contains("clientabort")
                    || className.contains("asyncrequestnotusable")
                    || message.contains("broken pipe")
                    || message.contains("responsebodyemitter")
                    || message.contains("connection has been closed")
                    || message.contains("stream closed")) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private Integer firstInt(JsonNode node, String... keys) {
        for (String key : keys) {
            if (node.has(key) && node.get(key).isNumber()) return node.get(key).asInt();
        }
        return null;
    }

    private Boolean thinkingEnabled(JsonNode request) {
        if (request == null || request.isMissingNode() || request.isNull()) return null;
        if (request.has("thinking")) return request.get("thinking").asBoolean();
        if (request.path("enable_thinking").asBoolean(false)) return true;
        if (request.path("reasoning").isObject() && !request.path("reasoning").path("effort").asText("").isBlank()) {
            return true;
        }
        return null;
    }

    private Integer thinkingBudget(JsonNode request) {
        if (request == null || request.isMissingNode() || request.isNull()) return null;
        if (request.has("thinking_budget") && request.get("thinking_budget").isNumber()) {
            return request.get("thinking_budget").asInt();
        }
        String effort = request.path("reasoning").path("effort").asText("");
        return !effort.isBlank() ? reasoningBudgetForEffort(effort) : null;
    }

    private String stripDataUrl(String value) {
        if (value == null) return "";
        int comma = value.indexOf(',');
        return value.startsWith("data:") && comma >= 0 ? value.substring(comma + 1) : value;
    }

    private boolean looksLikeBase64(String value) {
        if (value == null || value.length() < 80 || value.startsWith("http")) return false;
        try {
            Base64.getDecoder().decode(stripDataUrl(value).getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private int elapsed(long start) {
        return (int) Math.max(0, System.currentTimeMillis() - start);
    }

    private BigDecimal remaining(BigDecimal limit, BigDecimal used) {
        if (limit == null) return BigDecimal.ZERO;
        BigDecimal value = limit.subtract(used != null ? used : BigDecimal.ZERO);
        return value.compareTo(BigDecimal.ZERO) < 0 ? BigDecimal.ZERO : value;
    }

    private String money(BigDecimal value) {
        return (value != null ? value : BigDecimal.ZERO).stripTrailingZeros().toPlainString();
    }

    private RequestSnapshot snapshot(HttpServletRequest request) {
        return new RequestSnapshot(clientIp(request), userAgent(request));
    }

    private String clientIp(HttpServletRequest request) {
        if (request == null) return null;
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) return realIp.trim();
        return request.getRemoteAddr();
    }

    private String userAgent(HttpServletRequest request) {
        if (request == null) return null;
        String userAgent = request.getHeader("User-Agent");
        return userAgent != null && !userAgent.isBlank() ? userAgent : null;
    }

    private record RequestSnapshot(String clientIp, String userAgent) {}
    private record ResponsesState(List<Map<String, Object>> messages, long expiresAtMs) {}
}
