package com.aiplatform.backend.service.provider.google;

import com.aiplatform.backend.service.provider.ProviderAdapter;
import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * Google Gemini 适配器。
 * <p>
 * 请求：POST {baseUrl}/v1beta/models/{model}:generateContent?key={apiKey}
 * 流式：POST {baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
 * 认证：API Key 在 URL query param 中，无需 auth header
 * 请求体：contents[] + systemInstruction + generationConfig
 * 响应：candidates[0].content.parts[0].text, usageMetadata.promptTokenCount / candidatesTokenCount
 * 流式：data: {candidates[0].content.parts[0].text}
 */
public class GoogleTextAdapter implements ProviderAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String chatUrl(String baseUrl, String model, String apiKey) {
        String b = baseUrl.replaceAll("/+$", "");
        return b + "/v1beta/models/" + model + ":generateContent?key=" + apiKey;
    }

    @Override
    public String streamUrl(String baseUrl, String model, String apiKey) {
        String b = baseUrl.replaceAll("/+$", "");
        return b + "/v1beta/models/" + model + ":streamGenerateContent?alt=sse&key=" + apiKey;
    }

    @Override
    public Map<String, String> authHeaders(String apiKey) {
        // Google 的 apiKey 在 URL 中，不需要 auth header
        return Map.of();
    }

    @Override
    public ObjectNode transformRequest(ObjectNode openAiBody, String provider) {
        ObjectNode geminiBody = MAPPER.createObjectNode();

        // 1. 转换 messages → contents + systemInstruction
        JsonNode messages = openAiBody.path("messages");
        if (messages.isArray()) {
            StringBuilder systemText = new StringBuilder();
            ArrayNode contents = geminiBody.putArray("contents");

            for (JsonNode msg : messages) {
                String role = msg.path("role").asText("");
                JsonNode contentNode = msg.get("content");

                if ("system".equals(role)) {
                    // system 消息提取到 systemInstruction
                    if (contentNode != null) {
                        String text = contentNode.isTextual() ? contentNode.asText() : contentNode.toString();
                        if (systemText.length() > 0) systemText.append("\n\n");
                        systemText.append(text);
                    }
                    continue;
                }

                // user → user, assistant → model
                String geminiRole = "assistant".equals(role) ? "model" : "user";

                ObjectNode contentObj = contents.addObject();
                contentObj.put("role", geminiRole);
                ArrayNode parts = contentObj.putArray("parts");

                if (contentNode == null) {
                    // tool_calls 等场景，content 可能为 null
                    parts.addObject().put("text", "");
                } else if (contentNode.isTextual()) {
                    // 纯文本
                    parts.addObject().put("text", contentNode.asText(""));
                } else if (contentNode.isArray()) {
                    // Vision 格式：[{type:text,...}, {type:image_url,...}]
                    for (JsonNode block : contentNode) {
                        String type = block.path("type").asText("");
                        if ("text".equals(type)) {
                            parts.addObject().put("text", block.path("text").asText(""));
                        } else if ("image_url".equals(type)) {
                            // image_url → inlineData
                            String imageUrl = block.path("image_url").path("url").asText("");
                            // data:image/jpeg;base64,xxxx → {mimeType, data}
                            if (imageUrl.startsWith("data:")) {
                                int commaIdx = imageUrl.indexOf(",");
                                String mimeType = commaIdx > 5
                                        ? imageUrl.substring(5, commaIdx).split(";")[0]
                                        : "image/jpeg";
                                String base64Data = commaIdx > 0 ? imageUrl.substring(commaIdx + 1) : "";
                                ObjectNode inlineData = parts.addObject().putObject("inlineData");
                                inlineData.put("mimeType", mimeType);
                                inlineData.put("data", base64Data);
                            }
                        }
                    }
                }
            }

            // 设置 systemInstruction
            if (systemText.length() > 0) {
                ObjectNode sysInstr = geminiBody.putObject("systemInstruction");
                sysInstr.putArray("parts").addObject().put("text", systemText.toString());
            }
        }

        // 2. 转换 generationConfig
        ObjectNode genConfig = geminiBody.putObject("generationConfig");
        if (openAiBody.has("temperature")) {
            genConfig.put("temperature", openAiBody.path("temperature").asDouble(0.7));
        }
        if (openAiBody.has("max_tokens")) {
            genConfig.put("maxOutputTokens", openAiBody.path("max_tokens").asInt(2048));
        }
        if (openAiBody.has("_thinking") && openAiBody.path("_thinking").asBoolean(false)) {
            int thinkingBudget = openAiBody.path("_thinking_budget").asInt(8192);
            ObjectNode thinkingConfig = genConfig.putObject("thinkingConfig");
            thinkingConfig.put("thinkingBudget", thinkingBudget);
        }

        // 3. model 不放 body（在 URL 中）
        // 4. stream 不放 body（由 URL 端点决定）

        return geminiBody;
    }

    @Override
    public String extractContent(JsonNode response) {
        JsonNode candidates = response.path("candidates");
        if (candidates.isArray() && !candidates.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            JsonNode parts = candidates.get(0).path("content").path("parts");
            if (parts.isArray()) {
                for (JsonNode part : parts) {
                    String text = part.path("text").asText("");
                    if (!text.isEmpty()) sb.append(text);
                }
            }
            return sb.toString();
        }
        return "";
    }

    @Override
    public int extractInputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usageMetadata").path("promptTokenCount").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    @Override
    public int extractOutputTokens(JsonNode response, int fallback) {
        int tokens = response.path("usageMetadata").path("candidatesTokenCount").asInt(0);
        return tokens > 0 ? tokens : fallback;
    }

    /**
     * 将 Google Gemini 响应归一化为 OpenAI 格式。
     * <p>
     * Gemini: { candidates: [{ content: { parts: [{text:"..."}], role:"model" }, finishReason:"STOP" }], usageMetadata: { promptTokenCount, candidatesTokenCount } }
     * → OpenAI: { choices: [{ message: { role:"assistant", content:"..." }, finish_reason:"stop" }], usage: { prompt_tokens, completion_tokens } }
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

        // 转换 candidates[0].content.parts → message.content
        JsonNode candidates = response.path("candidates");
        if (candidates.isArray() && !candidates.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            JsonNode parts = candidates.get(0).path("content").path("parts");
            if (parts.isArray()) {
                for (JsonNode part : parts) {
                    String text = part.path("text").asText("");
                    if (!text.isEmpty()) sb.append(text);
                }
            }
            message.put("content", sb.toString());

            // 转换 finishReason
            String finishReason = candidates.get(0).path("finishReason").asText("STOP");
            choice.put("finish_reason", "STOP".equals(finishReason) ? "stop" : finishReason.toLowerCase());
        } else {
            message.put("content", "");
            choice.put("finish_reason", "stop");
        }

        // 转换 usageMetadata → usage
        ObjectNode usage = openAi.putObject("usage");
        usage.put("prompt_tokens", response.path("usageMetadata").path("promptTokenCount").asInt(0));
        usage.put("completion_tokens", response.path("usageMetadata").path("candidatesTokenCount").asInt(0));

        return openAi;
    }

    // ===== Streaming =====

    @Override
    public String parseStreamLine(String line, StreamContext ctx) {
        if (!line.startsWith("data: ")) return null;
        String data = line.substring(6).trim();
        if (data.isEmpty() || data.equals("[DONE]")) {
            if (data.equals("[DONE]")) ctx.done = true;
            return null;
        }
        try {
            JsonNode json = MAPPER.readTree(data);
            // 提取增量文本
            JsonNode parts = json.path("candidates").path(0).path("content").path("parts");
            if (parts.isArray()) {
                StringBuilder sb = new StringBuilder();
                for (JsonNode part : parts) {
                    String text = part.path("text").asText("");
                    if (!text.isEmpty()) sb.append(text);
                }
                if (sb.length() > 0) return sb.toString();
            }
            // 提取 usage
            JsonNode usageMeta = json.path("usageMetadata");
            if (!usageMeta.isMissingNode()) {
                int inputTokens = usageMeta.path("promptTokenCount").asInt(0);
                int outputTokens = usageMeta.path("candidatesTokenCount").asInt(0);
                if (inputTokens > 0) { ctx.inputTokens = inputTokens; ctx.hasUsage = true; }
                if (outputTokens > 0) { ctx.outputTokens = outputTokens; ctx.hasUsage = true; }
            }
            // 检查 finishReason
            String finishReason = json.path("candidates").path(0).path("finishReason").asText("");
            if ("STOP".equals(finishReason)) {
                ctx.done = true;
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

    // Google 不支持 OpenAI 格式的 TTS
    @Override
    public boolean supportsTts() { return false; }
}
