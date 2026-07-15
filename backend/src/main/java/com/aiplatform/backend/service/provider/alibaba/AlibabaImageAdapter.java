package com.aiplatform.backend.service.provider.alibaba;

import com.aiplatform.backend.service.provider.ImageAdapter;
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
 * 阿里云 DashScope / Qwen-Image 图片生成适配器。
 * <p>
 * 适用于：qwen-image-2.0 系列、wan2.6-t2i 等支持同步调用的 DashScope 图片生成模型。
 * <p>
 * API 格式（同步）：POST {host}/api/v1/services/aigc/multimodal-generation/generation
 * 请求头：Authorization: Bearer {apiKey}, Content-Type: application/json
 * 请求体：
 * <pre>
 * {
 *   "model": "qwen-image-2.0-pro-2026-04-22",
 *   "input": {
 *     "messages": [
 *       { "role": "user", "content": [ { "text": "prompt" } ] }
 *     ]
 *   },
 *   "parameters": {
 *     "n": 1,
 *     "size": "1024*1024",
 *     "prompt_extend": true,
 *     "watermark": false
 *   }
 * }
 * </pre>
 * 响应：
 * <pre>
 * {
 *   "output": {
 *     "choices": [
 *       { "message": { "content": [ { "image": "https://..." } ] } }
 *     ]
 *   }
 * }
 * </pre>
 * <p>
 * 注意：DashScope 的 size 格式用星号分隔（1024*1024），而非 OpenAI 的 x 分隔（1024x1024）。
 * 图片 URL 有效期 24 小时。
 */
public class AlibabaImageAdapter implements ImageAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public String generateImage(String baseUrl, String apiKey, String model, String prompt, String size) throws Exception {
        // DashScope 的图片生成 API 不在 compatible-mode 路径下，需要从 baseUrl 提取 host
        // baseUrl 可能是 https://dashscope.aliyuncs.com/compatible-mode/v1
        // 也可能是 https://dashscope.aliyuncs.com/api/v1
        // 统一提取 https://dashscope.aliyuncs.com 作为 host
        String host = extractHost(baseUrl);

        // 判断使用哪个 endpoint
        // qwen-image-2.0 系列 / wan2.6-t2i：同步 multimodal-generation/generation
        // wan2.5 及以下：异步 text2image/image-synthesis（需轮询）
        boolean useSyncApi = isSyncModel(model);

        if (useSyncApi) {
            return doSyncRequest(host, apiKey, model, prompt, size);
        } else {
            return doAsyncRequest(host, apiKey, model, prompt, size);
        }
    }

    /**
     * 同步调用（qwen-image-2.0 / wan2.6-t2i）
     */
    private String doSyncRequest(String host, String apiKey, String model, String prompt, String size) throws Exception {
        String url = host + "/api/v1/services/aigc/multimodal-generation/generation";

        // 构建 DashScope 格式的请求体
        ObjectNode requestBody = MAPPER.createObjectNode();
        requestBody.put("model", model);

        ObjectNode input = requestBody.putObject("input");
        ArrayNode messages = input.putArray("messages");
        ObjectNode message = messages.addObject();
        message.put("role", "user");
        ArrayNode content = message.putArray("content");
        ObjectNode textItem = content.addObject();
        textItem.put("text", prompt);

        ObjectNode parameters = requestBody.putObject("parameters");
        parameters.put("n", 1);
        parameters.put("size", convertSizeFormat(size));  // 1024x1024 → 1024*1024
        parameters.put("prompt_extend", true);
        parameters.put("watermark", false);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .build();

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(requestBody)))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            throw new RuntimeException("DashScope 图片生成错误: HTTP " + response.statusCode() + " " + response.body());
        }

        JsonNode root = MAPPER.readTree(response.body());
        JsonNode choices = root.path("output").path("choices");
        if (choices.isArray() && choices.size() > 0) {
            JsonNode contentArray = choices.get(0).path("message").path("content");
            if (contentArray.isArray()) {
                for (JsonNode item : contentArray) {
                    if (item.has("image")) {
                        return item.get("image").asText();
                    }
                }
            }
        }
        throw new RuntimeException("DashScope 图片生成响应格式异常: " + response.body());
    }

    /**
     * 异步调用（wan2.5 及以下旧模型 — 创建任务 + 轮询）
     */
    private String doAsyncRequest(String host, String apiKey, String model, String prompt, String size) throws Exception {
        // Step 1: 创建任务
        String createUrl = host + "/api/v1/services/aigc/text2image/image-synthesis";

        ObjectNode requestBody = MAPPER.createObjectNode();
        requestBody.put("model", model);

        ObjectNode input = requestBody.putObject("input");
        input.put("prompt", prompt);

        ObjectNode parameters = requestBody.putObject("parameters");
        parameters.put("size", convertSizeFormat(size));
        parameters.put("n", 1);

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .build();

        HttpRequest createRequest = HttpRequest.newBuilder()
                .uri(URI.create(createUrl))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .header("X-DashScope-Async", "enable")
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(requestBody)))
                .build();

        HttpResponse<String> createResponse = client.send(createRequest, HttpResponse.BodyHandlers.ofString());

        if (createResponse.statusCode() != 200) {
            throw new RuntimeException("DashScope 创建图片任务错误: HTTP " + createResponse.statusCode() + " " + createResponse.body());
        }

        JsonNode createRoot = MAPPER.readTree(createResponse.body());
        String taskId = createRoot.path("output").path("task_id").asText(null);
        if (taskId == null) {
            throw new RuntimeException("DashScope 创建图片任务失败: " + createResponse.body());
        }

        // Step 2: 轮询查询结果
        String pollUrl = host + "/api/v1/tasks/" + taskId;
        int maxAttempts = 30;  // 最多轮询 30 次（约 5 分钟）
        for (int i = 0; i < maxAttempts; i++) {
            Thread.sleep(10000);  // 每 10 秒轮询一次

            HttpRequest pollRequest = HttpRequest.newBuilder()
                    .uri(URI.create(pollUrl))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + apiKey)
                    .GET()
                    .build();

            HttpResponse<String> pollResponse = client.send(pollRequest, HttpResponse.BodyHandlers.ofString());
            JsonNode pollRoot = MAPPER.readTree(pollResponse.body());
            String status = pollRoot.path("output").path("task_status").asText("");

            if ("SUCCEEDED".equals(status)) {
                JsonNode results = pollRoot.path("output").path("results");
                if (results.isArray() && results.size() > 0) {
                    String imageUrl = results.get(0).path("url").asText(null);
                    if (imageUrl != null) return imageUrl;
                }
                // wan2.6 异步格式
                JsonNode choices = pollRoot.path("output").path("choices");
                if (choices.isArray() && choices.size() > 0) {
                    JsonNode contentArray = choices.get(0).path("message").path("content");
                    if (contentArray.isArray()) {
                        for (JsonNode item : contentArray) {
                            if (item.has("image")) {
                                return item.get("image").asText();
                            }
                        }
                    }
                }
                throw new RuntimeException("DashScope 图片生成成功但未找到图片 URL: " + pollResponse.body());
            } else if ("FAILED".equals(status)) {
                throw new RuntimeException("DashScope 图片生成失败: " + pollResponse.body());
            }
            // PENDING / RUNNING → 继续轮询
        }
        throw new RuntimeException("DashScope 图片生成超时（轮询 30 次未完成）");
    }

    /**
     * 从 baseUrl 提取 host（去掉路径部分）
     * 如 https://dashscope.aliyuncs.com/compatible-mode/v1 → https://dashscope.aliyuncs.com
     */
    private String extractHost(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) {
            return "https://dashscope.aliyuncs.com";
        }
        try {
            URI uri = URI.create(baseUrl);
            String scheme = uri.getScheme() != null ? uri.getScheme() : "https";
            String host = uri.getHost();
            int port = uri.getPort();
            if (port > 0) {
                return scheme + "://" + host + ":" + port;
            }
            return scheme + "://" + host;
        } catch (Exception e) {
            return "https://dashscope.aliyuncs.com";
        }
    }

    /**
     * 将 OpenAI 格式的 size（1024x1024）转换为 DashScope 格式（1024*1024）
     */
    private String convertSizeFormat(String size) {
        if (size == null || size.isBlank()) {
            return "1024*1024";
        }
        return size.replace("x", "*");
    }

    /**
     * 判断模型是否支持同步调用
     * - qwen-image-2.0 系列：同步
     * - wan2.6-t2i：同步
     * - 其他（wan2.5 及以下）：异步
     */
    private boolean isSyncModel(String model) {
        if (model == null) return true;
        String lower = model.toLowerCase();
        // qwen-image-2.0 系列和 wan2.6 支持同步
        return lower.startsWith("qwen-image") || lower.startsWith("wan2.6");
    }
}
