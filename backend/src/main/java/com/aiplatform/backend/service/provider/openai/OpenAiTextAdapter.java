package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.ProviderAdapter;
import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * OpenAI 兼容文本适配器 — 适用于所有提供 OpenAI 兼容端点的供应商。
 * <p>
 * 覆盖供应商：OpenAI / DeepSeek / 阿里云(兼容模式) / 智谱 / Mistral / Cohere / 百度(兼容模式) / Custom / MiniMax
 * <p>
 * 请求格式：POST {baseUrl}/chat/completions, Authorization: Bearer {apiKey}
 * 响应格式：choices[0].message.content, usage.prompt_tokens / usage.completion_tokens
 * 流式格式：data: {choices[0].delta.content}, data: [DONE]
 */
public class OpenAiTextAdapter implements ProviderAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String chatUrl(String baseUrl, String model, String apiKey) {
        return baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
    }

    @Override
    public Map<String, String> authHeaders(String apiKey) {
        return Map.of("Authorization", "Bearer " + apiKey);
    }

    @Override
    public ObjectNode transformRequest(ObjectNode canonicalBody, String provider) {
        // 检查是否有深度思考 canonical 字段
        boolean hasThinking = canonicalBody.has("_thinking") && canonicalBody.path("_thinking").asBoolean(false);
        if (!hasThinking) {
            // 无思考参数，直接返回（清理 canonical 字段以防万一）
            canonicalBody.remove("_thinking");
            canonicalBody.remove("_thinking_budget");
            return canonicalBody;
        }

        int budget = canonicalBody.path("_thinking_budget").asInt(8000);
        // 先移除 canonical 字段
        canonicalBody.remove("_thinking");
        canonicalBody.remove("_thinking_budget");

        // 根据 provider 转换为不同格式
        if ("openai".equalsIgnoreCase(provider)) {
            // OpenAI: reasoning_effort = low / medium / high
            String effort;
            if (budget <= 1000) {
                effort = "low";
            } else if (budget <= 5000) {
                effort = "medium";
            } else {
                effort = "high";
            }
            canonicalBody.put("reasoning_effort", effort);
        }
        // DeepSeek: 不需要请求参数（模型自动返回 reasoning_content）
        // 百度/智谱/MiniMax/Mistral/Cohere/Custom: 不支持思考，移除 canonical 字段即可
        // canonical 字段已在上方移除

        return canonicalBody;
    }

    @Override
    public String extractContent(JsonNode response) {
        return response.path("choices").path(0).path("message").path("content").asText("");
    }

    @Override
    public int extractInputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usage").path("prompt_tokens").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    @Override
    public int extractOutputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usage").path("completion_tokens").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    // ===== Streaming =====

    @Override
    public String parseStreamLine(String line, StreamContext ctx) {
        if (!line.startsWith("data: ")) return null;
        String data = line.substring(6).trim();
        if ("[DONE]".equals(data)) {
            ctx.done = true;
            return null;
        }
        if (data.isEmpty()) return null;
        try {
            JsonNode chunk = MAPPER.readTree(data);
            JsonNode choice = chunk.path("choices").path(0);
            JsonNode delta = choice.path("delta");

            // 提取 finish_reason（最后一个 chunk 包含）
            String fr = choice.path("finish_reason").asText(null);
            if (fr != null && !fr.isEmpty() && !"null".equals(fr)) {
                ctx.finishReason = fr;
            }

            // 提取 reasoning_content（深度思考/推理内容）
            String reasoning = delta.path("reasoning_content").asText(null);
            if (reasoning != null && !reasoning.isEmpty()) {
                ctx.thinkingBuilder.append(reasoning);
            }

            // 提取 delta.tool_calls（Agent 模式流式 — 按 index 累积拼接）
            JsonNode toolCallsDelta = delta.path("tool_calls");
            if (toolCallsDelta.isArray()) {
                for (JsonNode tcDelta : toolCallsDelta) {
                    int idx = tcDelta.path("index").asInt(0);
                    // 找到或创建对应 index 的 StreamToolCall
                    StreamToolCall stc = null;
                    for (StreamToolCall existing : ctx.toolCallsBuilder) {
                        if (existing.index == idx) { stc = existing; break; }
                    }
                    if (stc == null) {
                        stc = new StreamToolCall();
                        stc.index = idx;
                        ctx.toolCallsBuilder.add(stc);
                    }
                    // 累积字段（首个 chunk 包含 id/type/name，后续 chunks 只有 arguments 增量）
                    if (tcDelta.has("id")) stc.id = tcDelta.path("id").asText();
                    if (tcDelta.has("type")) stc.type = tcDelta.path("type").asText();
                    JsonNode func = tcDelta.path("function");
                    if (func.has("name")) stc.functionName = func.path("name").asText();
                    String argsDelta = func.path("arguments").asText(null);
                    if (argsDelta != null) stc.arguments.append(argsDelta);
                }
            }

            // 提取 delta content
            String text = delta.path("content").asText(null);

            // 提取 usage（部分模型在最后一个 chunk 里返回）
            JsonNode usage = chunk.path("usage");
            if (!usage.isMissingNode()) {
                int inT = usage.path("prompt_tokens").asInt(0);
                int outT = usage.path("completion_tokens").asInt(0);
                int cachedT = usage.path("prompt_tokens_details").path("cached_tokens").asInt(0);
                if (inT > 0) { ctx.inputTokens = inT; ctx.hasUsage = true; }
                if (outT > 0) { ctx.outputTokens = outT; ctx.hasUsage = true; }
                if (cachedT > 0) { ctx.cachedInputTokens = cachedT; ctx.hasUsage = true; }
            }
            return (text != null && !text.isEmpty()) ? text : null;
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    public String extractThinkingContent(JsonNode response) {
        // 非流式 OpenAI 响应：choices[0].message.reasoning_content
        String thinking = response.path("choices").path(0).path("message")
                .path("reasoning_content").asText(null);
        return (thinking != null && !thinking.isEmpty()) ? thinking : null;
    }

    @Override
    public boolean isStreamDone(StreamContext ctx) {
        return ctx.done;
    }

    @Override
    public int[] getStreamUsage(StreamContext ctx) {
        return ctx.hasUsage ? new int[]{ctx.inputTokens, ctx.outputTokens, ctx.cachedInputTokens} : null;
    }

    // ===== TTS =====

    @Override
    public boolean supportsTts() {
        return true;
    }

    @Override
    public String ttsUrl(String baseUrl) {
        String b = baseUrl.replaceAll("/chat/completions$", "");
        if (!b.endsWith("/v1")) {
            b = b.replaceAll("(/v1)?$", "/v1");
        }
        return b + "/audio/speech";
    }
}
