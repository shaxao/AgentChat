package com.aiplatform.backend.service.provider.alibaba;

import com.aiplatform.backend.service.provider.VoiceAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * 阿里云 DashScope ASR 适配器 — 语音识别。
 * <p>
 * 统一使用 Qwen3-ASR-Flash OpenAI 兼容 chat completions API：
 * <ul>
 *   <li>端点: POST /compatible-mode/v1/chat/completions</li>
 *   <li>音频输入: input_audio.data 支持 URL 或 data:audio/{format};base64,{data}</li>
 *   <li>同步返回结果，无需异步轮询</li>
 * </ul>
 * <p>
 * 对于异步-only 模型（paraformer-v2, qwen3-asr-flash-filetrans 等），
 * 自动降级为 qwen3-asr-flash 同步模式，避免公网 URL 依赖。
 * <p>
 * TTS（语音合成）暂留在 {@link AlibabaTextAdapter} 中。
 */
public class AlibabaVoiceAdapter implements VoiceAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DASHSCOPE_HOST = "https://dashscope.aliyuncs.com";

    @Override
    public boolean supportsAsr() {
        return true;
    }

    @Override
    public String speechToText(String fileUrl, String apiKey, String baseUrl, String model) throws Exception {
        String effectiveModel = (model != null && !model.isBlank()) ? model : "qwen3-asr-flash";

        // 判断是否为异步-only模型（paraformer-v2, qwen3-asr-flash-filetrans 等）
        boolean useAsync = effectiveModel.toLowerCase().contains("realtime")
                || effectiveModel.toLowerCase().contains("filetrans")
                || effectiveModel.toLowerCase().contains("paraformer");

        if (useAsync) {
            // 异步模型降级策略：下载音频 → base64 → 用 qwen3-asr-flash 同步 chat completions API
            log("[ASR-DashScope] 异步模型 {} 降级为 qwen3-asr-flash 同步模式, fileUrl={}", effectiveModel, fileUrl);
            try {
                byte[] audioBytes = downloadFile(fileUrl);
                String base64Data = encodeToDataUri(audioBytes, fileUrl);
                return doQwenAsrChatCompletions(base64Data, apiKey, "qwen3-asr-flash");
            } catch (Exception downloadEx) {
                // 下载失败，尝试直接用 URL 调用同步 API（DashScope 可能否访问取决于网络）
                log("[ASR-DashScope] 下载音频失败，尝试直接用 URL 调用同步 API: {}", downloadEx.getMessage());
                return doQwenAsrChatCompletions(fileUrl, apiKey, "qwen3-asr-flash");
            }
        } else {
            // 同步模式（qwen3-asr-flash）: 直接用 URL 调用 OpenAI 兼容 chat completions API
            return doQwenAsrChatCompletions(fileUrl, apiKey, effectiveModel);
        }
    }

    @Override
    public String speechToTextFromBytes(byte[] audioData, String fileName, String apiKey, String baseUrl, String model) throws Exception {
        String effectiveModel = (model != null && !model.isBlank()) ? model : "qwen3-asr-flash";

        // 判断是否为异步-only模型
        boolean useAsync = effectiveModel.toLowerCase().contains("realtime")
                || effectiveModel.toLowerCase().contains("filetrans")
                || effectiveModel.toLowerCase().contains("paraformer");

        // 实际使用的模型：异步模型降级为 qwen3-asr-flash 同步模式
        String actualModel = useAsync ? "qwen3-asr-flash" : effectiveModel;
        if (useAsync) {
            log("[ASR-DashScope] 异步模型 {} 降级为 qwen3-asr-flash 同步模式(字节输入)", effectiveModel);
        }

        // 所有模型统一使用 OpenAI 兼容 chat completions API + base64 编码
        String base64Data = encodeToDataUri(audioData, fileName);
        return doQwenAsrChatCompletions(base64Data, apiKey, actualModel);
    }

    // ===== Private ASR Helpers =====

    /**
     * Qwen3-ASR-Flash OpenAI 兼容 chat completions API
     * <p>
     * 端点: POST /compatible-mode/v1/chat/completions
     * 音频输入: input_audio.data 支持 URL 或 data:audio/{format};base64,{data}
     * 返回: choices[0].message.content 为识别文本
     *
     * @param audioInput URL 字符串或 data URI (data:audio/xxx;base64,...)
     * @param apiKey     DashScope API Key
     * @param model      模型名（如 qwen3-asr-flash）
     */
    private String doQwenAsrChatCompletions(String audioInput, String apiKey, String model) throws Exception {
        String url = DASHSCOPE_HOST + "/compatible-mode/v1/chat/completions";
        log("[ASR-Qwen] 调用 chat completions: model={}, inputType={}", model,
                audioInput.startsWith("data:") ? "base64" : "url");

        ObjectNode requestBody = MAPPER.createObjectNode();
        requestBody.put("model", model);

        ArrayNode messages = MAPPER.createArrayNode();
        ObjectNode userMsg = MAPPER.createObjectNode();
        userMsg.put("role", "user");
        ArrayNode content = MAPPER.createArrayNode();
        ObjectNode audioContent = MAPPER.createObjectNode();
        audioContent.put("type", "input_audio");
        ObjectNode inputAudio = MAPPER.createObjectNode();
        inputAudio.put("data", audioInput);
        audioContent.set("input_audio", inputAudio);
        content.add(audioContent);
        userMsg.set("content", content);
        messages.add(userMsg);
        requestBody.set("messages", messages);

        // asr_options
        ObjectNode asrOptions = MAPPER.createObjectNode();
        asrOptions.put("enable_itn", false);
        requestBody.set("asr_options", asrOptions);

        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody.toString()))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new RuntimeException("Qwen ASR 同步识别失败: HTTP " + response.statusCode() + " | " + truncate(response.body(), 500));
        }

        var respNode = MAPPER.readTree(response.body());
        String text = respNode.path("choices").path(0)
                .path("message").path("content").asText("");
        if (text.isEmpty()) {
            throw new RuntimeException("Qwen ASR 返回空内容: " + truncate(response.body(), 300));
        }
        log("[ASR-Qwen] 识别成功: text={}...", truncate(text, 100));
        return text;
    }

    /**
     * 将音频字节数组编码为 data URI（data:audio/{format};base64,{data}）
     * @param audioData 音频字节数组
     * @param fileNameOrUrl 文件名或 URL（用于推断音频格式）
     */
    private String encodeToDataUri(byte[] audioData, String fileNameOrUrl) {
        String format = guessAudioFormat(fileNameOrUrl);
        String base64 = java.util.Base64.getEncoder().encodeToString(audioData);
        return "data:audio/" + format + ";base64," + base64;
    }

    /**
     * 从文件名或 URL 推断音频格式
     */
    private String guessAudioFormat(String name) {
        if (name == null) return "mp3";
        String lower = name.toLowerCase();
        if (lower.endsWith(".wav")) return "wav";
        if (lower.endsWith(".mp3")) return "mp3";
        if (lower.endsWith(".m4a")) return "m4a";
        if (lower.endsWith(".aac")) return "aac";
        if (lower.endsWith(".ogg")) return "ogg";
        if (lower.endsWith(".flac")) return "flac";
        if (lower.endsWith(".webm")) return "webm";
        return "mp3";
    }

    private byte[] downloadFile(String fileUrl) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(fileUrl))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() != 200) {
            throw new RuntimeException("下载音频文件失败: HTTP " + response.statusCode() + ", url=" + fileUrl);
        }
        return response.body();
    }

    private String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() > max ? s.substring(0, max) + "..." : s;
    }

    private void log(String format, Object... args) {
        System.out.printf("[AlibabaVoiceAdapter] " + format.replace("{}", "%s") + "%n", args);
    }
}
