package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.TranslateAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * OpenAI 兼容翻译适配器 — 通过 Chat Completion API 实现翻译。
 * <p>
 * 适用于所有提供 OpenAI 兼容端点的供应商：
 * OpenAI / DeepSeek / 智谱 / Mistral / Cohere / 百度 / Custom / MiniMax / Azure
 * <p>
 * 翻译策略：构建翻译 prompt，通过 Chat Completion API 让大模型完成翻译。
 * 内部组合 {@link OpenAiTextAdapter} 复用供应商特定的请求转换、URL 构建、响应提取逻辑。
 *
 * @see TranslateAdapter
 * @see com.aiplatform.backend.service.provider.TranslateAdapterFactory
 */
public class OpenAiTranslateAdapter implements TranslateAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final OpenAiTextAdapter TEXT_ADAPTER = new OpenAiTextAdapter();

    /** 默认请求超时（秒） */
    private static final int DEFAULT_TIMEOUT_SECONDS = 60;
    /** 翻译文本最大长度（超出截断） */
    private static final int MAX_TEXT_LENGTH = 2000;
    /** 翻译 temperature（低温度保证翻译准确性） */
    private static final double TRANSLATE_TEMPERATURE = 0.3;
    /** 翻译 max_tokens */
    private static final int TRANSLATE_MAX_TOKENS = 2048;

    @Override
    public TranslateResult translate(String baseUrl, String apiKey, String model, String text, String targetLang) throws Exception {
        // 1. 构建翻译 prompt
        String truncatedText = text.length() > MAX_TEXT_LENGTH
                ? text.substring(0, MAX_TEXT_LENGTH) + "..." : text;
        String prompt = String.format(
                "请将以下内容翻译成%s，只输出翻译结果，不要任何解释或额外内容：\n\n%s",
                targetLang, truncatedText
        );

        // 2. 构建 OpenAI 格式请求体
        ObjectNode body = MAPPER.createObjectNode();
        body.put("model", model);
        body.put("temperature", TRANSLATE_TEMPERATURE);
        body.put("max_tokens", TRANSLATE_MAX_TOKENS);
        body.put("stream", false);

        ArrayNode messages = body.putArray("messages");
        ObjectNode msg = messages.addObject();
        msg.put("role", "user");
        msg.put("content", prompt);

        // 3. 供应商特定的请求转换
        body = TEXT_ADAPTER.transformRequest(body, "OpenAI");

        // 4. 构建请求 URL
        String url = TEXT_ADAPTER.chatUrl(baseUrl, model, apiKey);

        // 5. 发送 HTTP 请求
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
        HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(DEFAULT_TIMEOUT_SECONDS))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)));
        TEXT_ADAPTER.authHeaders(apiKey).forEach(reqBuilder::header);

        long start = System.currentTimeMillis();
        HttpResponse<String> response = client.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString());
        int latency = (int) (System.currentTimeMillis() - start);

        if (response.statusCode() != 200) {
            throw new RuntimeException("翻译 API 错误: HTTP " + response.statusCode()
                    + " | " + truncate(response.body(), 500));
        }

        // 6. 提取翻译结果
        JsonNode resp = MAPPER.readTree(response.body());
        String content = TEXT_ADAPTER.extractContent(resp);
        int inputTokens = TEXT_ADAPTER.extractInputTokens(resp, Math.max(1, prompt.length() / 3));
        int outputTokens = TEXT_ADAPTER.extractOutputTokens(resp, Math.max(1, content.length() / 3));

        return new TranslateResult(content, inputTokens, outputTokens, latency);
    }

    private String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) + "..." : s;
    }
}
