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

        // 1. 提取 system 消息到顶层
        JsonNode messages = anthropicBody.path("messages");
        if (messages.isArray()) {
            StringBuilder systemText = new StringBuilder();
            ArrayNode filteredMessages = anthropicBody.putArray("_filtered_messages");
            for (JsonNode msg : messages) {
                if ("system".equals(msg.path("role").asText(""))) {
                    String content = msg.path("content").asText("");
                    if (!content.isEmpty()) {
                        if (systemText.length() > 0) systemText.append("\n\n");
                        systemText.append(content);
                    }
                } else {
                    filteredMessages.add(msg);
                }
            }
            if (systemText.length() > 0) {
                anthropicBody.put("system", systemText.toString());
            }
            anthropicBody.set("messages", filteredMessages);
            // 清理临时字段
            anthropicBody.remove("_filtered_messages");
        }

        // 2. 移除 OpenAI 特有字段
        anthropicBody.remove("stream_options");
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
                case "content_block_delta":
                    // 提取增量文本或思考内容
                    JsonNode delta = json.path("delta");
                    String deltaType = delta.path("type").asText("");
                    if ("thinking_delta".equals(deltaType)) {
                        String thinking = delta.path("thinking").asText(null);
                        if (thinking != null && !thinking.isEmpty()) {
                            ctx.thinkingBuilder.append(thinking);
                        }
                    } else if ("text_delta".equals(deltaType)) {
                        String text = delta.path("text").asText(null);
                        return text != null && !text.isEmpty() ? text : null;
                    } else {
                        // 兼容旧格式 delta.text（部分旧版 API）
                        String text = delta.path("text").asText(null);
                        return text != null && !text.isEmpty() ? text : null;
                    }
                case "message_delta":
                    // 提取 output_tokens
                    int outputTokens = json.path("usage").path("output_tokens").asInt(0);
                    if (outputTokens > 0) {
                        ctx.outputTokens = outputTokens;
                        ctx.hasUsage = true;
                    }
                    break;
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
