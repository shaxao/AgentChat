package com.aiplatform.backend.controller;

import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.ModelAliasService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.aiplatform.backend.service.UserApiKeyService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Anthropic Messages 兼容入站网关 — 供 Claude Code / Cline / Cursor 等 IDE 工具接入。
 * <p>
 * 端点：POST /v1/messages（Anthropic Messages API 格式）
 * 认证：x-api-key 头（Anthropic 客户端默认）或 Authorization: Bearer（兼容）
 * <p>
 * 设计：作为网关（gateway），工具由客户端执行。本端点单轮调用上游，
 * 遇到 tool_use 即返回 stop_reason=tool_use，不在服务端跑 ReAct 循环。
 * 内部统一走 OpenAI canonical 格式（{@link AiService#chatCompletionRaw}），
 * 再把响应转回 Anthropic 格式，因此可复用现有的多渠道降级、计费、适配器体系。
 */
@Slf4j
@RestController
@RequestMapping("/v1")
@RequiredArgsConstructor
public class AnthropicMessagesController {

    private final UserApiKeyService userApiKeyService;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final ModelAliasService modelAliasService;
    private final ObjectMapper objectMapper;

    private final ExecutorService sseExecutor = Executors.newCachedThreadPool();

    private static final String ANTHROPIC_VERSION = "2023-06-01";

    @PostMapping("/messages")
    public ResponseEntity<?> messages(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestHeader(value = "x-api-key", required = false) String xApiKey,
            @RequestBody JsonNode request,
            HttpServletRequest servletRequest) {

        UserApiKeyService.AuthenticatedApiKey auth = authenticate(authorization, xApiKey);
        if (auth == null) return unauthorized();

        long start = System.currentTimeMillis();
        String requestedModel = request.path("model").asText(null);
        String model = modelAliasService.resolveModelId(requestedModel);
        boolean stream = request.path("stream").asBoolean(false);

        if (stream) {
            return ResponseEntity.ok()
                    .contentType(MediaType.TEXT_EVENT_STREAM)
                    .body(streamMessages(auth, request, model, requestedModel, start, servletRequest));
        }

        try {
            List<Map<String, Object>> messages = toCanonicalMessages(request);
            String system = extractSystem(request);
            Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                    ? request.get("temperature").asDouble() : null;
            Integer maxTokens = request.has("max_tokens") && request.get("max_tokens").isNumber()
                    ? request.get("max_tokens").asInt() : null;
            List<ToolDefinition> tools = parseTools(request.path("tools"));
            Boolean thinking = extractThinking(request);
            Integer thinkingBudget = extractThinkingBudget(request);

            JsonNode raw = aiService.chatCompletionRaw(model, system, messages, temperature, maxTokens,
                    tools, thinking, thinkingBudget, false);
            trackSuccess(auth, raw, requestedModel, start, servletRequest);
            ObjectNode anthropic = toAnthropicResponse(raw, requestedModel);
            return ResponseEntity.ok(anthropic);
        } catch (Exception e) {
            log.warn("[AnthropicMessages] 非流式请求失败: {}", e.getMessage());
            usageTrackingService.trackFailure(auth.getUserId(), requestedModel != null ? requestedModel : "unknown",
                    0, 0, elapsed(start), "api", e.getMessage());
            return anthropicError(HttpStatus.BAD_GATEWAY, "api_error", e.getMessage());
        }
    }

    // ==================== 流式（真 SSE，Anthropic 事件协议） ====================

    private SseEmitter streamMessages(UserApiKeyService.AuthenticatedApiKey auth, JsonNode request,
                                      String model, String requestedModel, long start,
                                      HttpServletRequest servletRequest) {
        SseEmitter emitter = new SseEmitter(0L);
        sseExecutor.submit(() -> {
            AnthropicSseWriter writer = new AnthropicSseWriter(emitter, objectMapper,
                    requestedModel != null ? requestedModel : model);
            try {
                List<Map<String, Object>> messages = toCanonicalMessages(request);
                String system = extractSystem(request);
                Double temperature = request.has("temperature") && request.get("temperature").isNumber()
                        ? request.get("temperature").asDouble() : null;
                Integer maxTokens = request.has("max_tokens") && request.get("max_tokens").isNumber()
                        ? request.get("max_tokens").asInt() : null;
                List<ToolDefinition> tools = parseTools(request.path("tools"));
                Boolean thinking = extractThinking(request);
                Integer thinkingBudget = extractThinkingBudget(request);

                writer.sendMessageStart();

                // 单轮流式调用上游：文本 token 实时透传，最终拿到 tool_calls + usage
                JsonNode synthetic = aiService.streamChatCompletionRaw(
                        model, system, messages, temperature, maxTokens, tools, thinking, thinkingBudget,
                        false, writer::onTextDelta);

                JsonNode message = synthetic.path("choices").path(0).path("message");
                JsonNode toolCalls = message.path("tool_calls");
                boolean hasToolCalls = toolCalls.isArray() && !toolCalls.isEmpty();

                // 关闭文本块（若开启过）
                writer.closeTextBlockIfOpen();

                // tool_use 块（gateway 模式：转发给客户端执行，不在服务端执行）
                if (hasToolCalls) {
                    for (JsonNode tc : toolCalls) {
                        String id = tc.path("id").asText("");
                        String name = tc.path("function").path("name").asText("");
                        String args = tc.path("function").path("arguments").asText("");
                        writer.sendToolUseBlock(id, name, args);
                    }
                }

                int inputTokens = synthetic.path("usage").path("prompt_tokens").asInt(0);
                int outputTokens = synthetic.path("usage").path("completion_tokens").asInt(0);
                String stopReason = hasToolCalls ? "tool_use"
                        : mapStopReason(synthetic.path("choices").path(0).path("finish_reason").asText("stop"));

                writer.sendMessageDelta(stopReason, outputTokens);
                writer.sendMessageStop();
                emitter.complete();

                trackSuccess(auth, synthetic, requestedModel, start, servletRequest);
            } catch (Exception e) {
                log.warn("[AnthropicMessages] 流式请求失败: {}", e.getMessage());
                usageTrackingService.trackFailure(auth.getUserId(),
                        requestedModel != null ? requestedModel : "unknown", 0, 0, elapsed(start), "api", e.getMessage());
                writer.sendError(e.getMessage());
                try { emitter.complete(); } catch (Exception ignored) {}
            }
        });
        return emitter;
    }

    // ==================== 请求转换：Anthropic → OpenAI canonical ====================

    /** 提取 system（string 或 block 数组）为纯文本 */
    private String extractSystem(JsonNode request) {
        JsonNode system = request.path("system");
        if (system.isMissingNode() || system.isNull()) return null;
        if (system.isTextual()) return system.asText();
        if (system.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : system) {
                String text = block.path("text").asText("");
                if (!text.isEmpty()) {
                    if (sb.length() > 0) sb.append("\n\n");
                    sb.append(text);
                }
            }
            return sb.length() > 0 ? sb.toString() : null;
        }
        return null;
    }

    /**
     * 将 Anthropic messages 转为内部 canonical（OpenAI）消息列表。
     * <ul>
     *   <li>text 块 → 文本</li>
     *   <li>image 块（base64/url）→ image_url（data URI）</li>
     *   <li>tool_use 块 → assistant.tool_calls</li>
     *   <li>tool_result 块 → tool role 消息（tool_call_id = tool_use_id）</li>
     * </ul>
     */
    private List<Map<String, Object>> toCanonicalMessages(JsonNode request) {
        List<Map<String, Object>> result = new ArrayList<>();
        JsonNode messages = request.path("messages");
        if (!messages.isArray()) return result;

        for (JsonNode msg : messages) {
            String role = msg.path("role").asText("user");
            JsonNode content = msg.path("content");

            // content 为字符串 → 直接文本消息
            if (content.isTextual()) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("role", role);
                m.put("content", content.asText());
                result.add(m);
                continue;
            }
            if (!content.isArray()) continue;

            // content 为块数组：需要拆分 tool_use / tool_result / text / image
            List<JsonNode> toolUses = new ArrayList<>();
            List<JsonNode> toolResults = new ArrayList<>();
            ArrayNode multimodal = objectMapper.createArrayNode();
            StringBuilder plainText = new StringBuilder();
            boolean hasImage = false;

            for (JsonNode block : content) {
                String type = block.path("type").asText("");
                switch (type) {
                    case "text": {
                        String text = block.path("text").asText("");
                        if (plainText.length() > 0) plainText.append("\n");
                        plainText.append(text);
                        multimodal.addObject().put("type", "text").put("text", text);
                        break;
                    }
                    case "image": {
                        hasImage = true;
                        String dataUrl = anthropicImageToDataUrl(block.path("source"));
                        if (dataUrl != null) {
                            ObjectNode img = multimodal.addObject();
                            img.put("type", "image_url");
                            img.putObject("image_url").put("url", dataUrl);
                        }
                        break;
                    }
                    case "tool_use":
                        toolUses.add(block);
                        break;
                    case "tool_result":
                        toolResults.add(block);
                        break;
                    default:
                        break;
                }
            }

            // tool_result 块 → 每个生成一个 tool role 消息（OpenAI 要求 tool role 独立成条）
            if (!toolResults.isEmpty()) {
                for (JsonNode tr : toolResults) {
                    Map<String, Object> toolMsg = new LinkedHashMap<>();
                    toolMsg.put("role", "tool");
                    toolMsg.put("tool_call_id", tr.path("tool_use_id").asText(""));
                    toolMsg.put("content", anthropicToolResultToText(tr.path("content")));
                    result.add(toolMsg);
                }
                // tool_result 消息里通常没有其他内容，处理完继续
                if (toolUses.isEmpty() && plainText.length() == 0 && !hasImage) {
                    continue;
                }
            }

            // assistant.tool_use → assistant 消息带 tool_calls
            if (!toolUses.isEmpty()) {
                Map<String, Object> assistantMsg = new LinkedHashMap<>();
                assistantMsg.put("role", "assistant");
                if (plainText.length() > 0) {
                    assistantMsg.put("content", plainText.toString());
                } else {
                    assistantMsg.put("content", "");
                }
                List<Map<String, Object>> tcList = new ArrayList<>();
                for (JsonNode tu : toolUses) {
                    Map<String, Object> tc = new LinkedHashMap<>();
                    tc.put("id", tu.path("id").asText(""));
                    tc.put("type", "function");
                    Map<String, Object> fn = new LinkedHashMap<>();
                    fn.put("name", tu.path("name").asText(""));
                    JsonNode input = tu.path("input");
                    fn.put("arguments", input.isMissingNode() || input.isNull() ? "{}" : input.toString());
                    tc.put("function", fn);
                    tcList.add(tc);
                }
                assistantMsg.put("tool_calls", tcList);
                result.add(assistantMsg);
                continue;
            }

            // 普通消息：有图片走多模态数组，否则纯文本
            if (plainText.length() > 0 || hasImage) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("role", role);
                if (hasImage) {
                    m.put("content", objectMapper.convertValue(multimodal, List.class));
                } else {
                    m.put("content", plainText.toString());
                }
                result.add(m);
            }
        }
        return result;
    }

    /** Anthropic image source → data URI（供内部 vision 走 OpenAI image_url 格式） */
    private String anthropicImageToDataUrl(JsonNode source) {
        String type = source.path("type").asText("");
        if ("base64".equals(type)) {
            String mediaType = source.path("media_type").asText("image/png");
            String data = source.path("data").asText("");
            if (data.isEmpty()) return null;
            return "data:" + mediaType + ";base64," + data;
        }
        if ("url".equals(type)) {
            return source.path("url").asText(null);
        }
        return null;
    }

    /** Anthropic tool_result.content（string 或 block 数组）→ 纯文本 */
    private String anthropicToolResultToText(JsonNode content) {
        if (content.isMissingNode() || content.isNull()) return "";
        if (content.isTextual()) return content.asText();
        if (content.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : content) {
                if ("text".equals(block.path("type").asText(""))) {
                    if (sb.length() > 0) sb.append("\n");
                    sb.append(block.path("text").asText(""));
                } else {
                    // 非文本块（如 image）序列化保留
                    if (sb.length() > 0) sb.append("\n");
                    sb.append(block.toString());
                }
            }
            return sb.toString();
        }
        return content.toString();
    }

    /** Anthropic tools（input_schema）→ 内部 ToolDefinition */
    private List<ToolDefinition> parseTools(JsonNode toolsNode) {
        List<ToolDefinition> tools = new ArrayList<>();
        if (toolsNode == null || !toolsNode.isArray()) return tools;
        for (JsonNode tool : toolsNode) {
            String name = tool.path("name").asText("");
            if (name.isBlank()) continue;
            JsonNode schema = tool.path("input_schema");
            ObjectNode parameters = schema.isObject()
                    ? (ObjectNode) schema
                    : objectMapper.createObjectNode().put("type", "object");
            tools.add(new ToolDefinition(name, tool.path("description").asText(""), parameters));
        }
        return tools;
    }

    private Boolean extractThinking(JsonNode request) {
        JsonNode thinking = request.path("thinking");
        if (thinking.isObject()) {
            return "enabled".equals(thinking.path("type").asText(""));
        }
        return null;
    }

    private Integer extractThinkingBudget(JsonNode request) {
        JsonNode thinking = request.path("thinking");
        if (thinking.isObject() && thinking.has("budget_tokens")) {
            return thinking.path("budget_tokens").asInt();
        }
        return null;
    }

    // ==================== 响应转换：OpenAI → Anthropic ====================

    private ObjectNode toAnthropicResponse(JsonNode raw, String requestedModel) {
        JsonNode message = raw.path("choices").path(0).path("message");
        String finishReason = raw.path("choices").path(0).path("finish_reason").asText("stop");
        JsonNode toolCalls = message.path("tool_calls");
        boolean hasToolCalls = toolCalls.isArray() && !toolCalls.isEmpty();

        ObjectNode body = objectMapper.createObjectNode();
        body.put("id", "msg_" + UUID.randomUUID().toString().replace("-", ""));
        body.put("type", "message");
        body.put("role", "assistant");
        body.put("model", requestedModel != null ? requestedModel : raw.path("model").asText(""));

        ArrayNode content = body.putArray("content");
        String text = message.path("content").asText("");
        if (text != null && !text.isEmpty()) {
            ObjectNode textBlock = content.addObject();
            textBlock.put("type", "text");
            textBlock.put("text", text);
        }
        if (hasToolCalls) {
            for (JsonNode tc : toolCalls) {
                ObjectNode toolUse = content.addObject();
                toolUse.put("type", "tool_use");
                toolUse.put("id", tc.path("id").asText(""));
                toolUse.put("name", tc.path("function").path("name").asText(""));
                String args = tc.path("function").path("arguments").asText("");
                toolUse.set("input", parseArgsToObject(args));
            }
        }

        body.put("stop_reason", hasToolCalls ? "tool_use" : mapStopReason(finishReason));
        body.putNull("stop_sequence");

        ObjectNode usage = body.putObject("usage");
        usage.put("input_tokens", raw.path("usage").path("prompt_tokens").asInt(0));
        usage.put("output_tokens", raw.path("usage").path("completion_tokens").asInt(0));
        return body;
    }

    private JsonNode parseArgsToObject(String args) {
        if (args == null || args.isBlank()) return objectMapper.createObjectNode();
        try {
            return objectMapper.readTree(args);
        } catch (Exception e) {
            return objectMapper.createObjectNode();
        }
    }

    private String mapStopReason(String openAiFinishReason) {
        if (openAiFinishReason == null) return "end_turn";
        return switch (openAiFinishReason) {
            case "tool_calls" -> "tool_use";
            case "length" -> "max_tokens";
            case "content_filter" -> "end_turn";
            default -> "end_turn";
        };
    }

    // ==================== 认证 / 用量 / 错误 ====================

    private UserApiKeyService.AuthenticatedApiKey authenticate(String authorization, String xApiKey) {
        // 优先 Authorization: Bearer；否则用 x-api-key（Anthropic 客户端默认头）包装成 Bearer
        if (authorization != null && authorization.startsWith("Bearer ")) {
            return userApiKeyService.authenticate(authorization);
        }
        if (xApiKey != null && !xApiKey.isBlank()) {
            return userApiKeyService.authenticate("Bearer " + xApiKey.trim());
        }
        return null;
    }

    private void trackSuccess(UserApiKeyService.AuthenticatedApiKey auth, JsonNode raw, String fallbackModel,
                              long start, HttpServletRequest servletRequest) {
        String model = raw.path("model").asText(fallbackModel != null ? fallbackModel : "unknown");
        int inputTokens = raw.path("usage").path("prompt_tokens").asInt(0);
        int outputTokens = raw.path("usage").path("completion_tokens").asInt(0);
        int cached = raw.path("usage").path("prompt_tokens_details").path("cached_tokens").asInt(0);
        usageTrackingService.trackFull(auth.getUserId(), model, inputTokens, cached, outputTokens,
                elapsed(start), "api", null, clientIp(servletRequest), null, auth.getKeyPrefix());
    }

    private ResponseEntity<ObjectNode> unauthorized() {
        return anthropicError(HttpStatus.UNAUTHORIZED, "authentication_error", "Invalid or missing API key");
    }

    private ResponseEntity<ObjectNode> anthropicError(HttpStatus status, String type, String message) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("type", "error");
        ObjectNode error = body.putObject("error");
        error.put("type", type);
        error.put("message", message != null ? message : "Request failed");
        return ResponseEntity.status(status).body(body);
    }

    private int elapsed(long start) {
        return (int) Math.max(0, System.currentTimeMillis() - start);
    }

    private String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) return realIp.trim();
        return request.getRemoteAddr();
    }
}
