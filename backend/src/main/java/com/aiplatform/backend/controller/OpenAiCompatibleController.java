package com.aiplatform.backend.controller;

import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.service.AiService;
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
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/v1")
@RequiredArgsConstructor
public class OpenAiCompatibleController {
    private final UserApiKeyService userApiKeyService;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final ModelConfigMapper modelConfigMapper;
    private final SysUserMapper sysUserMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final ObjectMapper objectMapper;

    @GetMapping("/models")
    public ResponseEntity<?> models(@RequestHeader(value = "Authorization", required = false) String authorization) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        ArrayNode data = objectMapper.createArrayNode();
        List<ModelConfig> models = modelConfigMapper.selectList(new LambdaQueryWrapper<ModelConfig>()
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getDeleted, 0)
                .orderByAsc(ModelConfig::getId));
        for (ModelConfig model : models) {
            ObjectNode item = data.addObject();
            item.put("id", model.getModelId());
            item.put("object", "model");
            item.put("created", Instant.now().getEpochSecond());
            item.put("owned_by", model.getProvider() != null ? model.getProvider() : "muhuo");
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

    @PostMapping({"/chat/completions", "/char/com"})
    public ResponseEntity<?> chatCompletions(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        String model = request.path("model").asText(null);
        boolean stream = request.path("stream").asBoolean(false);
        try {
            JsonNode raw = invokeChatCompletion(request);
            trackSuccess(auth, raw, model, start, servletRequest, "api");
            if (stream) {
                return ResponseEntity.ok()
                        .contentType(MediaType.TEXT_EVENT_STREAM)
                        .body(chatSse(raw));
            }
            return ResponseEntity.ok(raw);
        } catch (Exception e) {
            usageTrackingService.trackFailure(auth.getUserId(), model != null ? model : "unknown", 0, 0,
                    elapsed(start), "api", e.getMessage());
            return openAiError(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
        }
    }

    @PostMapping("/responses")
    public ResponseEntity<?> responses(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {
        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        String model = request.path("model").asText(null);
        boolean stream = request.path("stream").asBoolean(false);
        try {
            ObjectNode chatReq = responseToChatRequest(request);
            JsonNode raw = invokeChatCompletion(chatReq);
            trackSuccess(auth, raw, model, start, servletRequest, "api");
            ObjectNode response = toResponsesFormat(raw, request);
            if (stream) {
                return ResponseEntity.ok()
                        .contentType(MediaType.TEXT_EVENT_STREAM)
                        .body(responseSse(response));
            }
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            usageTrackingService.trackFailure(auth.getUserId(), model != null ? model : "unknown", 0, 0,
                    elapsed(start), "api", e.getMessage());
            return openAiError(HttpStatus.BAD_GATEWAY, "server_error", e.getMessage());
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
        String model = request.path("model").asText(null);
        String system = request.path("system").asText(null);
        Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                ? request.get("temperature").asDouble() : null;
        Integer maxTokens = firstInt(request, "max_tokens", "max_completion_tokens");
        List<Map<String, Object>> messages = objectMapper.convertValue(
                request.path("messages"),
                objectMapper.getTypeFactory().constructCollectionType(List.class, Map.class));
        List<ToolDefinition> tools = parseTools(request.path("tools"));
        return aiService.chatCompletionRaw(model, system, messages, temperature, maxTokens, tools,
                request.has("thinking") ? request.get("thinking").asBoolean() : null,
                request.has("thinking_budget") ? request.get("thinking_budget").asInt() : null);
    }

    private ObjectNode responseToChatRequest(JsonNode request) {
        ObjectNode chat = objectMapper.createObjectNode();
        chat.put("model", request.path("model").asText(""));
        if (request.has("temperature")) chat.set("temperature", request.get("temperature"));
        if (request.has("max_output_tokens")) chat.set("max_tokens", request.get("max_output_tokens"));
        if (request.has("stream")) chat.set("stream", request.get("stream"));
        if (request.has("tools")) chat.set("tools", request.get("tools"));

        ArrayNode messages = chat.putArray("messages");
        String instructions = request.path("instructions").asText("");
        if (!instructions.isBlank()) {
            ObjectNode sys = messages.addObject();
            sys.put("role", "system");
            sys.put("content", instructions);
        }
        JsonNode input = request.get("input");
        if (input == null || input.isNull()) {
            ObjectNode msg = messages.addObject();
            msg.put("role", "user");
            msg.put("content", "");
        } else if (input.isTextual()) {
            ObjectNode msg = messages.addObject();
            msg.put("role", "user");
            msg.put("content", input.asText());
        } else if (input.isArray()) {
            for (JsonNode item : input) {
                ObjectNode msg = messages.addObject();
                msg.put("role", item.path("role").asText("user"));
                msg.set("content", normalizeResponseInputContent(item.path("content")));
            }
        } else {
            ObjectNode msg = messages.addObject();
            msg.put("role", "user");
            msg.put("content", input.toString());
        }
        return chat;
    }

    private JsonNode normalizeResponseInputContent(JsonNode content) {
        if (!content.isArray()) return content.isMissingNode() ? objectMapper.getNodeFactory().textNode("") : content;
        ArrayNode result = objectMapper.createArrayNode();
        for (JsonNode block : content) {
            String type = block.path("type").asText("");
            ObjectNode next = result.addObject();
            if ("input_text".equals(type)) {
                next.put("type", "text");
                next.put("text", block.path("text").asText(""));
            } else if ("input_image".equals(type)) {
                next.put("type", "image_url");
                ObjectNode imageUrl = next.putObject("image_url");
                imageUrl.put("url", block.path("image_url").asText(block.path("url").asText("")));
            } else {
                next.put("type", "text");
                next.put("text", block.path("text").asText(block.toString()));
            }
        }
        return result;
    }

    private ObjectNode toResponsesFormat(JsonNode raw, JsonNode originalRequest) {
        String text = extractAssistantText(raw);
        String id = "resp_" + UUID.randomUUID().toString().replace("-", "");
        ObjectNode body = objectMapper.createObjectNode();
        body.put("id", id);
        body.put("object", "response");
        body.put("created_at", Instant.now().getEpochSecond());
        body.put("status", "completed");
        body.put("model", raw.path("model").asText(originalRequest.path("model").asText("")));
        body.put("output_text", text);
        ArrayNode output = body.putArray("output");
        ObjectNode message = output.addObject();
        message.put("id", "msg_" + UUID.randomUUID().toString().replace("-", ""));
        message.put("type", "message");
        message.put("status", "completed");
        message.put("role", "assistant");
        ArrayNode content = message.putArray("content");
        ObjectNode textBlock = content.addObject();
        textBlock.put("type", "output_text");
        textBlock.put("text", text);
        textBlock.set("annotations", objectMapper.createArrayNode());
        ObjectNode usage = body.putObject("usage");
        int inputTokens = raw.path("usage").path("prompt_tokens").asInt(0);
        int outputTokens = raw.path("usage").path("completion_tokens").asInt(0);
        usage.put("input_tokens", inputTokens);
        usage.put("output_tokens", outputTokens);
        usage.put("total_tokens", inputTokens + outputTokens);
        return body;
    }

    private SseEmitter chatSse(JsonNode raw) {
        SseEmitter emitter = new SseEmitter(0L);
        new Thread(() -> {
            try {
                String content = extractAssistantText(raw);
                String id = raw.path("id").asText("chatcmpl-" + UUID.randomUUID());
                String model = raw.path("model").asText("");
                emitter.send(SseEmitter.event().data(chatChunk(id, model, content, false)));
                emitter.send(SseEmitter.event().data(chatChunk(id, model, "", true)));
                emitter.send(SseEmitter.event().data("[DONE]"));
                emitter.complete();
            } catch (Exception e) {
                emitter.completeWithError(e);
            }
        }, "openai-chat-sse").start();
        return emitter;
    }

    private SseEmitter responseSse(ObjectNode response) {
        SseEmitter emitter = new SseEmitter(0L);
        new Thread(() -> {
            try {
                ObjectNode created = objectMapper.createObjectNode();
                created.put("type", "response.created");
                created.set("response", response);
                emitter.send(SseEmitter.event().data(created));
                ObjectNode delta = objectMapper.createObjectNode();
                delta.put("type", "response.output_text.delta");
                delta.put("delta", response.path("output_text").asText(""));
                emitter.send(SseEmitter.event().data(delta));
                ObjectNode done = objectMapper.createObjectNode();
                done.put("type", "response.completed");
                done.set("response", response);
                emitter.send(SseEmitter.event().data(done));
                emitter.complete();
            } catch (Exception e) {
                emitter.completeWithError(e);
            }
        }, "openai-response-sse").start();
        return emitter;
    }

    private ObjectNode chatChunk(String id, String model, String content, boolean done) {
        ObjectNode chunk = objectMapper.createObjectNode();
        chunk.put("id", id);
        chunk.put("object", "chat.completion.chunk");
        chunk.put("created", Instant.now().getEpochSecond());
        chunk.put("model", model);
        ArrayNode choices = chunk.putArray("choices");
        ObjectNode choice = choices.addObject();
        choice.put("index", 0);
        ObjectNode delta = choice.putObject("delta");
        if (!done) {
            delta.put("role", "assistant");
            delta.put("content", content);
            choice.putNull("finish_reason");
        } else {
            choice.put("finish_reason", "stop");
        }
        return chunk;
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

    private void trackSuccess(UserApiKeyService.AuthenticatedApiKey auth, JsonNode raw, String fallbackModel,
                              long start, HttpServletRequest servletRequest, String scene) {
        String model = raw.path("model").asText(fallbackModel != null ? fallbackModel : "unknown");
        int inputTokens = raw.path("usage").path("prompt_tokens").asInt(0);
        int outputTokens = raw.path("usage").path("completion_tokens").asInt(0);
        int cached = raw.path("usage").path("prompt_tokens_details").path("cached_tokens").asInt(0);
        usageTrackingService.trackFull(auth.getUserId(), model, inputTokens, cached, outputTokens,
                elapsed(start), scene, null, clientIp(servletRequest), null, auth.getKeyPrefix());
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

    private Integer firstInt(JsonNode node, String... keys) {
        for (String key : keys) {
            if (node.has(key) && node.get(key).isNumber()) return node.get(key).asInt();
        }
        return null;
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

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) return realIp.trim();
        return request.getRemoteAddr();
    }
}
