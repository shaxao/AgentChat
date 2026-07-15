package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.VoiceAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * OpenAI 兼容 ASR 适配器 — 语音识别（Whisper API）。
 * <p>
 * 适用于所有提供 OpenAI 兼容端点的供应商：
 * OpenAI / DeepSeek / 阿里云(兼容模式) / 智谱 / Mistral / Cohere / 百度 / Custom / MiniMax
 * <p>
 * ASR 端点：{baseUrl}/audio/transcriptions（OpenAI Whisper 格式）
 */
public class OpenAiVoiceAdapter implements VoiceAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public boolean supportsAsr() {
        return true;
    }

    @Override
    public String speechToText(String fileUrl, String apiKey, String baseUrl, String model) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        byte[] audioData = downloadFile(fileUrl);
        String fileName = extractFileNameFromUrl(fileUrl);
        return doWhisper(client, audioData, fileName, apiKey, baseUrl, model);
    }

    @Override
    public String speechToTextFromBytes(byte[] audioData, String fileName, String apiKey, String baseUrl, String model) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        return doWhisper(client, audioData, fileName, apiKey, baseUrl, model);
    }

    // ===== Private ASR Helpers =====

    private String doWhisper(HttpClient client, byte[] audioData, String fileName, String apiKey, String baseUrl, String model) throws Exception {
        String whisperModel = (model != null && !model.isBlank()) ? model : "whisper-1";
        String whisperUrl = buildWhisperUrl(baseUrl);

        String boundary = "----FormBoundary" + System.currentTimeMillis();
        byte[] multipartBody = buildWhisperMultipartBody(audioData, fileName, whisperModel, boundary);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(whisperUrl))
                .timeout(Duration.ofSeconds(60))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(multipartBody))
                .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new RuntimeException("OpenAI Whisper API 错误: HTTP " + response.statusCode() + " | " + truncate(response.body(), 500));
        }

        var respNode = MAPPER.readTree(response.body());
        String text = respNode.path("text").asText("");
        return text;
    }

    private String buildWhisperUrl(String baseUrl) {
        String b = baseUrl;
        b = b.replaceAll("/chat/completions.*$", "");
        if (!b.endsWith("/v1")) {
            b = b.replaceAll("/v1$", "");
            b = b + "/v1";
        }
        return b + "/audio/transcriptions";
    }

    private byte[] buildWhisperMultipartBody(byte[] audioData, String fileName, String model, String boundary) throws Exception {
        var bos = new ByteArrayOutputStream();

        // model 字段
        writeFormField(bos, "model", model, boundary);
        // language 字段（可选，默认自动检测）
        writeFormField(bos, "language", "zh", boundary);
        // file 字段（音频文件）
        bos.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        bos.write(("Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"\r\n").getBytes(StandardCharsets.UTF_8));
        bos.write(("Content-Type: application/octet-stream\r\n").getBytes(StandardCharsets.UTF_8));
        bos.write("\r\n".getBytes(StandardCharsets.UTF_8));
        bos.write(audioData);
        bos.write("\r\n".getBytes(StandardCharsets.UTF_8));

        // 结束边界
        bos.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

        return bos.toByteArray();
    }

    private void writeFormField(java.io.OutputStream os, String name, String value, String boundary) throws Exception {
        os.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        os.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n").getBytes(StandardCharsets.UTF_8));
        os.write("\r\n".getBytes(StandardCharsets.UTF_8));
        os.write((value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private String extractFileNameFromUrl(String fileUrl) {
        try {
            String path = new URI(fileUrl).getPath();
            String name = path.substring(path.lastIndexOf('/') + 1);
            if (!name.isEmpty() && name.contains(".")) return name;
        } catch (Exception ignored) {}
        return "audio.mp3";
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
}
