package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.ImageAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * OpenAI / DALL-E 兼容的图片生成适配器。
 * <p>
 * 适用于：OpenAI (DALL-E 2/3)、DeepSeek、Azure OpenAI、以及其他兼容 OpenAI 图片生成格式的平台。
 * <p>
 * API 格式：POST {baseUrl}/images/generations
 * 请求体：{"model":"...","prompt":"...","n":1,"size":"1024x1024"}
 * 响应：{"data":[{"url":"..."} 或 {"b64_json":"..."}]}
 */
public class OpenAiImageAdapter implements ImageAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String generateImage(String baseUrl, String apiKey, String model, String prompt, String size) throws Exception {
        // 确保 baseUrl 以 / 结尾
        if (baseUrl == null || baseUrl.isBlank()) {
            baseUrl = "https://api.openai.com/v1/";
        }
        if (!baseUrl.endsWith("/")) {
            baseUrl = baseUrl + "/";
        }
        String url = baseUrl + "images/generations";

        // 构建请求体
        String requestBody = MAPPER.writeValueAsString(MAPPER.createObjectNode()
                .put("model", model)
                .put("prompt", prompt)
                .put("n", 1)
                .put("size", size)
        );

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .build();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("OpenAI 图片生成错误: HTTP " + response.statusCode() + " " + response.body());
        }

        JsonNode root = MAPPER.readTree(response.body());
        JsonNode dataNode = root.get("data");
        if (dataNode != null && dataNode.isArray() && dataNode.size() > 0) {
            JsonNode first = dataNode.get(0);
            if (first.has("url")) {
                return first.get("url").asText();
            } else if (first.has("b64_json")) {
                return "data:image/png;base64," + first.get("b64_json").asText();
            }
        }
        throw new RuntimeException("OpenAI 图片生成响应格式异常: " + response.body());
    }
}
