package com.aiplatform.backend.service.provider.anthropic;

import com.aiplatform.backend.service.provider.ProviderAdapter;
import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Anthropic Claude 适配器。
 * <p>
 * 请求：POST {baseUrl}/v1/messages
 * 认证：x-api-key + anthropic-version header
 * 请求体：system 提升到顶层，messages 只含 user/assistant
 * 响应：content[0].text, usage.input_tokens / usage.output_tokens
 * 流式：event: + data: 双行格式，content_block_delta 含增量文本
 */
public class AnthropicTextAdapter implements ProviderAdapter {

    private static final String ANTHROPIC_VERSION = "2023-06-01";
    private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER = new com.fasterxml.jackson.databind.ObjectMapper();

    @Override
    public String chatUrl(String baseUrl, String model, String apiKey) {
        // baseUrl 如 https://api.anthropic.com → https://api.anthropic.com/v1/messages
        String b = baseUrl.replaceAll("/+$", "");
        if (b.endsWith("/v1")) {
            return b + "/messages";
        }
        return b + "/v1/messages";
    }

    @Override
    public Map<String, String> authHeaders(String apiKey) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("x-api-key", apiKey);
        headers.put("anthropic-version", ANTHROPIC_VERSION);
        return headers;
    }

    @Override
    public ObjectNode transformRequest(ObjectNode openAiBody, String provider) {
        ObjectNode anthropicBody = openAiBody.deepCopy();

        // 1. 提取 system 消息到顶层，并把 OpenAI 消息（含 tool_calls / tool role）转换为 Anthropic content block 格式
        JsonNode messages = anthropicBody.path("messages");
        if (messages.isArray()) {
            StringBuilder systemText = new StringBuilder();
            ArrayNode converted = MAPPER.createArrayNode();
            for (JsonNode msg : messages) {
                String role = msg.path("role").asText("");
                if ("system".equals(role)) {
                    String content = msg.path("content").asText("");
                    if (!content.isEmpty()) {
                        if (systemText.length() > 0) systemText.append("\n\n");
                        systemText.append(content);
                    }
                    continue;
                }
                if ("tool".equals(role)) {
                    // OpenAI tool 结果 → Anthropic user 消息，content 含 tool_result 块
                    // 相邻的多个 tool 结果合并到同一个 user 消息中（Anthropic 要求 tool_result 紧跟 assistant 的 tool_use）
                    ObjectNode target;
                    JsonNode last = converted.size() > 0 ? converted.get(converted.size() - 1) : null;
                    if (last != null && "user".equals(last.path("role").asText("")) && last.path("_toolResultCarrier").asBoolean(false)) {
                        target = (ObjectNode) last;
                    } else {
                        target = converted.addObject();
                        target.put("role", "user");
                        target.put("_toolResultCarrier", true);
                        target.putArray("content");
                    }
                    ArrayNode contentArr = (ArrayNode) target.path("content");
                    ObjectNode toolResult = contentArr.addObject();
                    toolResult.put("type", "tool_result");
                    toolResult.put("tool_use_id", msg.path("tool_call_id").asText(""));
                    JsonNode toolContent = msg.get("content");
                    toolResult.put("content", toolContent != null && !toolContent.isNull()
                            ? (toolContent.isTextual() ? toolContent.asText("") : toolContent.toString())
                            : "");
                    continue;
                }

                JsonNode toolCalls = msg.path("tool_calls");
                if ("assistant".equals(role) && toolCalls.isArray() && !toolCalls.isEmpty()) {
                    // OpenAI assistant.tool_calls → Anthropic assistant content 含 text + tool_use 块
                    ObjectNode out = converted.addObject();
                    out.put("role", "assistant");
                    ArrayNode contentArr = out.putArray("content");
                    JsonNode textContent = msg.get("content");
                    if (textContent != null && textContent.isTextual() && !textContent.asText("").isEmpty()) {
                        contentArr.addObject().put("type", "text").put("text", textContent.asText(""));
                    }
                    for (JsonNode tc : toolCalls) {
                        JsonNode fn = tc.path("function");
                        ObjectNode toolUse = contentArr.addObject();
                        toolUse.put("type", "tool_use");
                        toolUse.put("id", tc.path("id").asText(""));
                        toolUse.put("name", fn.path("name").asText(""));
                        String argsStr = fn.path("arguments").asText("");
                        JsonNode input;
                        try {
                            input = (argsStr == null || argsStr.isBlank()) ? MAPPER.createObjectNode() : MAPPER.readTree(argsStr);
                        } catch (Exception e) {
                            input = MAPPER.createObjectNode();
                        }
                        toolUse.set("input", input);
                    }
                    continue;
                }

                // 普通 user / assistant 消息（content 可能是字符串或多模态数组，Anthropic 均兼容）
                converted.add(msg);
            }
            if (systemText.length() > 0) {
                anthropicBody.put("system", systemText.toString());
            }
            // 清理临时标记字段
            for (JsonNode m : converted) {
                if (m instanceof ObjectNode on) on.remove("_toolResultCarrier");
            }
            anthropicBody.set("messages", converted);
        }

        // 2. 转换 tools 定义：OpenAI {type:function, function:{name,description,parameters}} → Anthropic {name,description,input_schema}
        JsonNode tools = anthropicBody.path("tools");
        if (tools.isArray() && !tools.isEmpty()) {
            ArrayNode anthTools = MAPPER.createArrayNode();
            for (JsonNode t : tools) {
                JsonNode fn = t.has("function") ? t.path("function") : t;
                ObjectNode at = anthTools.addObject();
                at.put("name", fn.path("name").asText(""));
                String desc = fn.path("description").asText("");
                if (!desc.isEmpty()) at.put("description", desc);
                JsonNode params = fn.path("parameters");
                at.set("input_schema", params.isObject() ? params : MAPPER.createObjectNode().put("type", "object"));
            }
            anthropicBody.set("tools", anthTools);
        }
        // tool_choice: OpenAI "auto"/"none"/{...} → Anthropic {type:auto/any/tool}
        JsonNode toolChoice = anthropicBody.path("tool_choice");
        if (!toolChoice.isMissingNode() && !toolChoice.isNull()) {
            ObjectNode tc = MAPPER.createObjectNode();
            if (toolChoice.isTextual()) {
                String v = toolChoice.asText("");
                if ("required".equals(v)) tc.put("type", "any");
                else if ("none".equals(v)) tc.put("type", "auto"); // Anthropic 无 none，退化为 auto（tools 仍可不调用）
                else tc.put("type", "auto");
                anthropicBody.set("tool_choice", tc);
            } else if (toolChoice.isObject() && toolChoice.path("function").has("name")) {
                tc.put("type", "tool");
                tc.put("name", toolChoice.path("function").path("name").asText(""));
                anthropicBody.set("tool_choice", tc);
            }
        }

        // 3. 移除 OpenAI 特有字段
        anthropicBody.remove("stream_options");
        anthropicBody.remove("prompt_cache_key");
        anthropicBody.remove("_autocode_prompt_cache_key");
        // Anthropic 不支持 frequency_penalty / presence_penalty 在某些模型上，保留但不强制

        // 3. 深度思考参数 → Anthropic thinking block
        boolean hasThinking = anthropicBody.has("_thinking") && anthropicBody.path("_thinking").asBoolean(false);
        int thinkingBudget = anthropicBody.path("_thinking_budget").asInt(8000);
        anthropicBody.remove("_thinking");
        anthropicBody.remove("_thinking_budget");
        if (hasThinking) {
            // Anthropic 的 thinking budget_tokens 必须小于 max_tokens
            int maxTokens = anthropicBody.path("max_tokens").asInt(4096);
            if (thinkingBudget >= maxTokens) {
                thinkingBudget = Math.max(1024, maxTokens - 1024);
            }
            ObjectNode thinkingBlock = anthropicBody.putObject("thinking");
            thinkingBlock.put("type", "enabled");
            thinkingBlock.put("budget_tokens", thinkingBudget);
        }

        // 4. Anthropic 要求 max_tokens（已存在）
        // 5. stream 字段保留

        return anthropicBody;
    }

    @Override
    public String extractContent(JsonNode response) {
        // content 是数组，取第一个 text 块
        JsonNode content = response.path("content");
        if (content.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : content) {
                if ("text".equals(block.path("type").asText(""))) {
                    sb.append(block.path("text").asText(""));
                }
            }
            return sb.toString();
        }
        return "";
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

    /**
     * 将 Anthropic 响应归一化为 OpenAI 格式。
     * <p>
     * Anthropic: { content: [{type:"text",text:"..."}, {type:"tool_use",id:"...",name:"...",input:{}}], stop_reason:"tool_use", usage:{input_tokens,output_tokens} }
     * → OpenAI: { choices: [{ message: { role:"assistant", content:"...", tool_calls:[...] }, finish_reason:"tool_calls"/"stop" }], usage: { prompt_tokens, completion_tokens } }
     */
    @Override
    public JsonNode normalizeResponse(JsonNode response) {
        // 如果已经是 OpenAI 格式（有 choices），直接返回
        if (response.has("choices")) return response;

        ObjectNode openAi = MAPPER.createObjectNode();
        ArrayNode choices = openAi.putArray("choices");
        ObjectNode choice = choices.addObject();
        ObjectNode message = choice.putObject("message");
        message.put("role", "assistant");

        // 转换 content 数组
        JsonNode contentArr = response.path("content");
        StringBuilder textContent = new StringBuilder();
        StringBuilder thinkingContent = new StringBuilder();
        ArrayNode toolCalls = null;
        int toolIndex = 0;

        if (contentArr.isArray()) {
            for (JsonNode block : contentArr) {
                String type = block.path("type").asText("");
                if ("text".equals(type)) {
                    textContent.append(block.path("text").asText(""));
                } else if ("thinking".equals(type)) {
                    thinkingContent.append(block.path("thinking").asText(""));
                } else if ("tool_use".equals(type)) {
                    if (toolCalls == null) toolCalls = message.putArray("tool_calls");
                    ObjectNode tc = toolCalls.addObject();
                    tc.put("id", block.path("id").asText(""));
                    tc.put("type", "function");
                    ObjectNode func = tc.putObject("function");
                    func.put("name", block.path("name").asText(""));
                    // input 是对象，转为 JSON 字符串（OpenAI 格式）
                    func.put("arguments", block.path("input").toString());
                }
            }
        }
        message.put("content", textContent.toString());
        // 保留思考内容到 OpenAI 兼容字段
        if (thinkingContent.length() > 0) {
            message.put("reasoning_content", thinkingContent.toString());
        }

        // 转换 stop_reason → finish_reason
        String stopReason = response.path("stop_reason").asText("end_turn");
        String finishReason = "tool_use".equals(stopReason) ? "tool_calls" : "stop";
        choice.put("finish_reason", finishReason);

        // 转换 usage
        ObjectNode usage = openAi.putObject("usage");
        usage.put("prompt_tokens", response.path("usage").path("input_tokens").asInt(0));
        usage.put("completion_tokens", response.path("usage").path("output_tokens").asInt(0));

        return openAi;
    }

    @Override
    public String parseStreamLine(String line, StreamContext ctx) {
        // Anthropic SSE: event: xxx \n data: {json}
        if (line.startsWith("event: ")) {
            ctx.eventType = line.substring(7).trim();
            return null;
        }
        if (!line.startsWith("data: ")) return null;

        String data = line.substring(6).trim();
        if (data.isEmpty()) return null;

        try {
            JsonNode json = MAPPER.readTree(data);
            String type = json.path("type").asText("");

            switch (type) {
                case "message_start":
                    // 提取 input_tokens
                    int inputTokens = json.path("message").path("usage").path("input_tokens").asInt(0);
                    if (inputTokens > 0) {
                        ctx.inputTokens = inputTokens;
                        ctx.hasUsage = true;
                    }
                    break;
                case "content_block_start": {
                    // tool_use 块开始：记录 id + name，按 Anthropic 的 index 建立 StreamToolCall
                    JsonNode block = json.path("content_block");
                    if ("tool_use".equals(block.path("type").asText(""))) {
                        int idx = json.path("index").asInt(0);
                        StreamToolCall stc = findOrCreateToolCall(ctx, idx);
                        stc.id = block.path("id").asText("");
                        stc.type = "function";
                        stc.functionName = block.path("name").asText("");
                        // Anthropic tool_use.input 可能在 start 事件里已带部分对象（通常为空 {}）
                    }
                    break;
                }
                case "content_block_delta": {
                    // 提取增量文本、思考内容或工具参数增量
                    JsonNode delta = json.path("delta");
                    String deltaType = delta.path("type").asText("");
                    if ("thinking_delta".equals(deltaType)) {
                        String thinking = delta.path("thinking").asText(null);
                        if (thinking != null && !thinking.isEmpty()) {
                            ctx.thinkingBuilder.append(thinking);
                        }
                    } else if ("input_json_delta".equals(deltaType)) {
                        // 工具参数 JSON 增量拼接到对应 index 的 StreamToolCall
                        int idx = json.path("index").asInt(0);
                        String partial = delta.path("partial_json").asText(null);
                        if (partial != null && !partial.isEmpty()) {
                            findOrCreateToolCall(ctx, idx).arguments.append(partial);
                        }
                    } else if ("text_delta".equals(deltaType)) {
                        String text = delta.path("text").asText(null);
                        return text != null && !text.isEmpty() ? text : null;
                    } else {
                        // 兼容旧格式 delta.text（部分旧版 API）
                        String text = delta.path("text").asText(null);
                        return text != null && !text.isEmpty() ? text : null;
                    }
                    break;
                }
                case "message_delta": {
                    // 提取 output_tokens 与 stop_reason
                    int outputTokens = json.path("usage").path("output_tokens").asInt(0);
                    if (outputTokens > 0) {
                        ctx.outputTokens = outputTokens;
                        ctx.hasUsage = true;
                    }
                    String stopReason = json.path("delta").path("stop_reason").asText(null);
                    if (stopReason != null && !stopReason.isEmpty()) {
                        ctx.finishReason = "tool_use".equals(stopReason) ? "tool_calls"
                                : ("max_tokens".equals(stopReason) ? "length" : "stop");
                    }
                    break;
                }
                case "message_stop":
                    ctx.done = true;
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            // JSON 解析失败，跳过
        }
        return null;
    }

    /** 按 Anthropic content block 的 index 查找或新建 StreamToolCall（工具参数增量拼接用） */
    private static StreamToolCall findOrCreateToolCall(StreamContext ctx, int index) {
        for (StreamToolCall existing : ctx.toolCallsBuilder) {
            if (existing.index == index) return existing;
        }
        StreamToolCall stc = new StreamToolCall();
        stc.index = index;
        ctx.toolCallsBuilder.add(stc);
        return stc;
    }

    @Override
    public boolean isStreamDone(StreamContext ctx) {
        return ctx.done;
    }

    @Override
    public int[] getStreamUsage(StreamContext ctx) {
        return ctx.hasUsage ? new int[]{ctx.inputTokens, ctx.outputTokens, ctx.cachedInputTokens} : null;
    }

    @Override
    public String extractThinkingContent(JsonNode response) {
        // 非流式 Anthropic 响应：content 数组中 type="thinking" 的块
        JsonNode contentArr = response.path("content");
        if (contentArr.isArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonNode block : contentArr) {
                if ("thinking".equals(block.path("type").asText(""))) {
                    sb.append(block.path("thinking").asText(""));
                }
            }
            return sb.length() > 0 ? sb.toString() : null;
        }
        return null;
    }

    // Anthropic 不支持 OpenAI 格式的 TTS
    @Override
    public boolean supportsTts() { return false; }
}
