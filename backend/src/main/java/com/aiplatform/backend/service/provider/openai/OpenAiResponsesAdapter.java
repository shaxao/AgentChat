package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.ProviderAdapter;
import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * OpenAI Responses API 适配器（出站）— 当渠道 api_format=responses 时使用。
 * <p>
 * 请求：POST {baseUrl}/responses, Authorization: Bearer {apiKey}
 * <p>
 * 与 Chat Completions 的主要差异：
 * <ul>
 *   <li>messages → input[]（角色 + content 块），system → instructions（顶层字符串）</li>
 *   <li>max_tokens → max_output_tokens</li>
 *   <li>tools 使用扁平结构：{type:"function", name, description, parameters}（无 function 包裹）</li>
 *   <li>响应 output[] 数组含 message / function_call 项，usage 用 input_tokens/output_tokens</li>
 *   <li>流式事件：response.output_text.delta / response.function_call_arguments.delta / response.completed</li>
 * </ul>
 * <p>
 * 内部 canonical 仍为 OpenAI Chat 格式，故 {@link #transformRequest} 负责 Chat→Responses，
 * {@link #normalizeResponse} 与流式解析负责 Responses→Chat 归一化，使下游无感知。
 */
public class OpenAiResponsesAdapter implements ProviderAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String chatUrl(String baseUrl, String model, String apiKey) {
        String b = baseUrl.replaceAll("/+$", "");
        b = b.replaceAll("/chat/completions$", "");
        b = b.replaceAll("/responses$", "");
        return b + "/responses";
    }

    @Override
    public Map<String, String> authHeaders(String apiKey) {
        return Map.of("Authorization", "Bearer " + apiKey);
    }

    @Override
    public ObjectNode transformRequest(ObjectNode canonicalBody, String provider) {
        ObjectNode out = MAPPER.createObjectNode();
        out.put("model", canonicalBody.path("model").asText(""));
        if (canonicalBody.has("temperature")) out.set("temperature", canonicalBody.get("temperature"));
        if (canonicalBody.has("top_p")) out.set("top_p", canonicalBody.get("top_p"));
        if (canonicalBody.has("stop")) out.set("stop", canonicalBody.get("stop"));
        if (canonicalBody.has("max_tokens")) out.put("max_output_tokens", canonicalBody.path("max_tokens").asInt());
        if (canonicalBody.has("stream")) out.set("stream", canonicalBody.get("stream"));
        if (canonicalBody.has("parallel_tool_calls")) out.set("parallel_tool_calls", canonicalBody.get("parallel_tool_calls"));
        if (canonicalBody.has("response_format")) {
            ObjectNode text = out.putObject("text");
            text.set("format", canonicalBody.get("response_format"));
        } else if (canonicalBody.has("text")) {
            out.set("text", canonicalBody.get("text"));
        }
        if (canonicalBody.path("stream").asBoolean(false)) {
            // Responses 流式默认包含 usage，无需 stream_options
            out.put("stream", true);
        }

        // messages → instructions + input[]
        StringBuilder instructions = new StringBuilder();
        ArrayNode input = out.putArray("input");
        JsonNode messages = canonicalBody.path("messages");
        if (messages.isArray()) {
            for (JsonNode msg : messages) {
                String role = msg.path("role").asText("");
                if ("system".equals(role)) {
                    String text = contentToText(msg.path("content"));
                    if (!text.isEmpty()) {
                        if (instructions.length() > 0) instructions.append("\n\n");
                        instructions.append(text);
                    }
                    continue;
                }
                if ("tool".equals(role)) {
                    // tool 结果 → function_call_output 项
                    ObjectNode item = input.addObject();
                    item.put("type", "function_call_output");
                    item.put("call_id", msg.path("tool_call_id").asText(""));
                    item.put("output", contentToText(msg.path("content")));
                    continue;
                }
                if ("assistant".equals(role) && msg.path("tool_calls").isArray()
                        && !msg.path("tool_calls").isEmpty()) {
                    // assistant 的 tool_calls → function_call 项（附带可选文本）
                    String text = contentToText(msg.path("content"));
                    if (!text.isEmpty()) {
                        input.add(buildMessageItem("assistant", text));
                    }
                    for (JsonNode tc : msg.path("tool_calls")) {
                        ObjectNode item = input.addObject();
                        item.put("type", "function_call");
                        item.put("call_id", tc.path("id").asText(""));
                        item.put("name", tc.path("function").path("name").asText(""));
                        item.put("arguments", tc.path("function").path("arguments").asText("{}"));
                    }
                    continue;
                }
                // 普通 user/assistant 消息
                JsonNode contentNode = msg.path("content");
                if (contentNode.isArray()) {
                    input.add(buildMultimodalMessageItem(role, contentNode));
                } else {
                    input.add(buildMessageItem(role, contentToText(contentNode)));
                }
            }
        }
        if (instructions.length() > 0) {
            out.put("instructions", instructions.toString());
        }

        // tools：Chat 的 {type:function, function:{name,description,parameters}}
        //   → Responses 扁平 {type:function, name, description, parameters}
        JsonNode tools = canonicalBody.path("tools");
        if (tools.isArray() && !tools.isEmpty()) {
            ArrayNode outTools = out.putArray("tools");
            for (JsonNode tool : tools) {
                JsonNode fn = tool.path("function").isMissingNode() ? tool : tool.path("function");
                ObjectNode t = outTools.addObject();
                t.put("type", "function");
                t.put("name", fn.path("name").asText(""));
                t.put("description", fn.path("description").asText(""));
                t.set("parameters", fn.path("parameters").isObject()
                        ? fn.path("parameters")
                        : MAPPER.createObjectNode().put("type", "object"));
            }
            if (canonicalBody.has("tool_choice")) {
                out.set("tool_choice", canonicalBody.get("tool_choice"));
            }
        }

        // 深度思考：Responses 用 reasoning.effort
        boolean hasThinking = canonicalBody.path("_thinking").asBoolean(false);
        if (hasThinking) {
            int budget = canonicalBody.path("_thinking_budget").asInt(8000);
            String effort = budget <= 1000 ? "low" : (budget <= 5000 ? "medium" : "high");
            out.putObject("reasoning").put("effort", effort);
        }

        return out;
    }

    private ObjectNode buildMessageItem(String role, String text) {
        ObjectNode item = MAPPER.createObjectNode();
        item.put("type", "message");
        item.put("role", role);
        ArrayNode content = item.putArray("content");
        ObjectNode block = content.addObject();
        // assistant 用 output_text，user/其他用 input_text
        block.put("type", "assistant".equals(role) ? "output_text" : "input_text");
        block.put("text", text != null ? text : "");
        return item;
    }

    private ObjectNode buildMultimodalMessageItem(String role, JsonNode contentArray) {
        ObjectNode item = MAPPER.createObjectNode();
        item.put("type", "message");
        item.put("role", role);
        ArrayNode content = item.putArray("content");
        for (JsonNode block : contentArray) {
            String type = block.path("type").asText("");
            if ("text".equals(type)) {
                content.addObject()
                        .put("type", "assistant".equals(role) ? "output_text" : "input_text")
                        .put("text", block.path("text").asText(""));
            } else if ("image_url".equals(type)) {
                ObjectNode img = content.addObject();
                img.put("type", "input_image");
                img.put("image_url", block.path("image_url").path("url").asText(""));
            }
        }
        return item;
    }

    private String contentToText(JsonNode content) {
        if (content == null || content.isNull() || content.isMissingNode()) return "";
        if (content.isTextual()) return content.asText("");
        if (content.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : content) {
                if (block.has("text")) sb.append(block.path("text").asText(""));
                else if (block.has("output")) sb.append(block.path("output").asText(""));
            }
            return sb.toString();
        }
        return content.toString();
    }

    // ===== 非流式响应归一化 =====

    @Override
    public JsonNode normalizeResponse(JsonNode response) {
        if (response.has("choices")) return response; // 已是 OpenAI 格式

        ObjectNode openAi = MAPPER.createObjectNode();
        ArrayNode choices = openAi.putArray("choices");
        ObjectNode choice = choices.addObject();
        choice.put("index", 0);
        ObjectNode message = choice.putObject("message");
        message.put("role", "assistant");

        StringBuilder text = new StringBuilder();
        ArrayNode toolCalls = null;

        // 优先用 output_text 快捷字段
        JsonNode output = response.path("output");
        if (output.isArray()) {
            for (JsonNode item : output) {
                String type = item.path("type").asText("");
                if ("message".equals(type)) {
                    for (JsonNode block : item.path("content")) {
                        if ("output_text".equals(block.path("type").asText(""))) {
                            text.append(block.path("text").asText(""));
                        }
                    }
                } else if ("function_call".equals(type)) {
                    if (toolCalls == null) toolCalls = message.putArray("tool_calls");
                    ObjectNode tc = toolCalls.addObject();
                    tc.put("id", item.path("call_id").asText(item.path("id").asText("")));
                    tc.put("type", "function");
                    ObjectNode fn = tc.putObject("function");
                    fn.put("name", item.path("name").asText(""));
                    fn.put("arguments", item.path("arguments").asText("{}"));
                }
            }
        }
        if (text.length() == 0 && response.has("output_text")) {
            text.append(response.path("output_text").asText(""));
        }
        message.put("content", text.toString());

        String status = response.path("status").asText("");
        JsonNode incompleteDetails = response.path("incomplete_details");
        boolean incomplete = "incomplete".equals(status) || !incompleteDetails.isMissingNode() && !incompleteDetails.isNull();
        choice.put("finish_reason", incomplete ? "length" : (toolCalls != null ? "tool_calls" : "stop"));

        ObjectNode usage = openAi.putObject("usage");
        JsonNode respUsage = response.path("usage");
        usage.put("prompt_tokens", respUsage.path("input_tokens").asInt(0));
        usage.put("completion_tokens", respUsage.path("output_tokens").asInt(0));
        int cached = respUsage.path("input_tokens_details").path("cached_tokens").asInt(0);
        usage.putObject("prompt_tokens_details").put("cached_tokens", cached);

        if (response.has("model")) openAi.put("model", response.path("model").asText());
        return openAi;
    }

    @Override
    public String extractContent(JsonNode response) {
        return normalizeResponse(response)
                .path("choices").path(0).path("message").path("content").asText("");
    }

    @Override
    public int extractInputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usage").path("input_tokens").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    @Override
    public int extractOutputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usage").path("output_tokens").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    @Override
    public int extractCachedInputTokens(JsonNode response) {
        return response.path("usage").path("input_tokens_details").path("cached_tokens").asInt(0);
    }

    // ===== 流式解析 =====

    @Override
    public String parseStreamLine(String line, StreamContext ctx) {
        // Responses SSE：event: xxx\n data: {json}。只解析 data 行。
        if (line.startsWith("event: ")) {
            ctx.eventType = line.substring(7).trim();
            return null;
        }
        if (!line.startsWith("data: ")) return null;
        String data = line.substring(6).trim();
        if (data.isEmpty() || "[DONE]".equals(data)) {
            if ("[DONE]".equals(data)) ctx.done = true;
            return null;
        }
        try {
            JsonNode json = MAPPER.readTree(data);
            String type = json.path("type").asText("");
            switch (type) {
                case "response.output_text.delta": {
                    String delta = json.path("delta").asText(null);
                    return (delta != null && !delta.isEmpty()) ? delta : null;
                }
                case "response.reasoning_summary_text.delta": {
                    String delta = json.path("delta").asText(null);
                    if (delta != null && !delta.isEmpty()) ctx.thinkingBuilder.append(delta);
                    return null;
                }
                case "response.output_item.added": {
                    JsonNode item = json.path("item");
                    if ("function_call".equals(item.path("type").asText(""))) {
                        StreamToolCall stc = new StreamToolCall();
                        stc.index = ctx.toolCallsBuilder.size();
                        stc.id = item.path("call_id").asText(item.path("id").asText(""));
                        stc.type = "function";
                        stc.functionName = item.path("name").asText("");
                        ctx.toolCallsBuilder.add(stc);
                    }
                    return null;
                }
                case "response.function_call_arguments.delta": {
                    String delta = json.path("delta").asText("");
                    if (!ctx.toolCallsBuilder.isEmpty() && !delta.isEmpty()) {
                        ctx.toolCallsBuilder.get(ctx.toolCallsBuilder.size() - 1).arguments.append(delta);
                    }
                    return null;
                }
                case "response.function_call_arguments.done": {
                    String arguments = json.path("arguments").asText(null);
                    if (!ctx.toolCallsBuilder.isEmpty() && arguments != null) {
                        StreamToolCall stc = ctx.toolCallsBuilder.get(ctx.toolCallsBuilder.size() - 1);
                        stc.arguments.setLength(0);
                        stc.arguments.append(arguments);
                    }
                    return null;
                }
                case "response.output_item.done": {
                    JsonNode item = json.path("item");
                    if ("function_call".equals(item.path("type").asText(""))) {
                        StreamToolCall stc = findOrCreateToolCall(ctx, item.path("call_id").asText(item.path("id").asText("")));
                        stc.type = "function";
                        stc.functionName = item.path("name").asText(stc.functionName != null ? stc.functionName : "");
                        String arguments = item.path("arguments").asText(null);
                        if (arguments != null) {
                            stc.arguments.setLength(0);
                            stc.arguments.append(arguments);
                        }
                    }
                    return null;
                }
                case "response.completed": {
                    JsonNode usage = json.path("response").path("usage");
                    int inT = usage.path("input_tokens").asInt(0);
                    int outT = usage.path("output_tokens").asInt(0);
                    int cachedT = usage.path("input_tokens_details").path("cached_tokens").asInt(0);
                    if (inT > 0) { ctx.inputTokens = inT; ctx.hasUsage = true; }
                    if (outT > 0) { ctx.outputTokens = outT; ctx.hasUsage = true; }
                    if (cachedT > 0) { ctx.cachedInputTokens = cachedT; ctx.hasUsage = true; }
                    ctx.finishReason = ctx.toolCallsBuilder.isEmpty() ? "stop" : "tool_calls";
                    ctx.done = true;
                    return null;
                }
                case "response.incomplete": {
                    JsonNode usage = json.path("response").path("usage");
                    int inT = usage.path("input_tokens").asInt(0);
                    int outT = usage.path("output_tokens").asInt(0);
                    int cachedT = usage.path("input_tokens_details").path("cached_tokens").asInt(0);
                    if (inT > 0) { ctx.inputTokens = inT; ctx.hasUsage = true; }
                    if (outT > 0) { ctx.outputTokens = outT; ctx.hasUsage = true; }
                    if (cachedT > 0) { ctx.cachedInputTokens = cachedT; ctx.hasUsage = true; }
                    ctx.finishReason = "length";
                    ctx.done = true;
                    return null;
                }
                case "response.failed":
                case "error":
                    ctx.done = true;
                    return null;
                default:
                    return null;
            }
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public boolean isStreamDone(StreamContext ctx) {
        return ctx.done;
    }

    @Override
    public int[] getStreamUsage(StreamContext ctx) {
        return ctx.hasUsage ? new int[]{ctx.inputTokens, ctx.outputTokens, ctx.cachedInputTokens} : null;
    }

    private StreamToolCall findOrCreateToolCall(StreamContext ctx, String id) {
        for (StreamToolCall existing : ctx.toolCallsBuilder) {
            if (id != null && !id.isBlank() && id.equals(existing.id)) {
                return existing;
            }
        }
        StreamToolCall stc = new StreamToolCall();
        stc.index = ctx.toolCallsBuilder.size();
        stc.id = id != null ? id : "";
        ctx.toolCallsBuilder.add(stc);
        return stc;
    }

    @Override
    public String extractThinkingContent(JsonNode response) {
        JsonNode output = response.path("output");
        if (output.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode item : output) {
                if ("reasoning".equals(item.path("type").asText(""))) {
                    for (JsonNode s : item.path("summary")) {
                        sb.append(s.path("text").asText(""));
                    }
                }
            }
            return sb.length() > 0 ? sb.toString() : null;
        }
        return null;
    }

    // Responses 出站不承载 TTS
    @Override
    public boolean supportsTts() { return false; }
}
