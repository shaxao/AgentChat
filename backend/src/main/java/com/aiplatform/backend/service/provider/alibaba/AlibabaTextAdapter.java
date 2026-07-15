package com.aiplatform.backend.service.provider.alibaba;

import com.aiplatform.backend.service.provider.openai.OpenAiTextAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * 阿里云 DashScope 文本适配器。
 * <p>
 * Chat / Streaming: 与 OpenAI 兼容（继承 {@link OpenAiTextAdapter}），使用 /compatible-mode/v1/chat/completions
 * <p>
 * TTS: DashScope 的 OpenAI 兼容模式 <b>不支持</b> /audio/speech 端点（返回 404），
 * 需使用 DashScope 原生多模态生成 API：
 * <ul>
 *   <li>URL: {@code https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation}</li>
 *   <li>请求体格式: {@code {"model":"...", "input":{"text":"...", "voice":"..."}, "parameters":{}}}</li>
 *   <li>响应: JSON 格式，包含 audio.url 字段（音频下载链接，有效期 24 小时）</li>
 *   <li>认证: Bearer Token（与 OpenAI 相同）</li>
 * </ul>
 * 支持的 TTS 模型: qwen3-tts-flash, qwen3-tts-instruct-flash, cosyvoice-v1, cosyvoice-v2, sambert-* 等
 */
public class AlibabaTextAdapter extends OpenAiTextAdapter {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 覆盖 transformRequest 以支持 DashScope 深度思考参数。
     * <p>
     * DashScope 使用 {@code enable_thinking: true} 作为顶层请求体字段，
     * 而非常规的 reasoning_effort（OpenAI 风格）。
     * 先由父类 OpenAiTextAdapter 处理通用转换并移除规范字段，
     * 然后根据规范字段值决定是否添加 enable_thinking。
     */
    @Override
    public ObjectNode transformRequest(ObjectNode canonicalBody, String provider) {
        // 在父类移除规范字段前读取 _thinking 值
        boolean hasThinking = canonicalBody.has("_thinking") && canonicalBody.path("_thinking").asBoolean(false);

        // 调用父类处理消息转换并清理规范字段
        canonicalBody = super.transformRequest(canonicalBody, provider);

        // DashScope 使用 enable_thinking 作为顶层字段
        if (hasThinking) {
            canonicalBody.put("enable_thinking", true);
        }

        return canonicalBody;
    }

    @Override
    public boolean supportsTts() {
        return true;
    }

    @Override
    public String ttsUrl(String baseUrl) {
        // 从 baseUrl 提取域名，拼接 DashScope 原生 TTS 端点
        // baseUrl 形如 https://dashscope.aliyuncs.com/compatible-mode/v1
        String domain = baseUrl.replaceAll("^(https?://[^/]+).*$", "$1");
        return domain + "/api/v1/services/aigc/multimodal-generation/generation";
    }

    @Override
    public String transformTtsRequest(ObjectMapper mapper, String model, String text, String voice) throws Exception {
        // DashScope Qwen-TTS 请求格式（与 OpenAI 不同）:
        // {
        //   "model": "qwen3-tts-instruct-flash",
        //   "input": {
        //     "text": "你好，这是语音预览。",
        //     "voice": "sambert-zhixiao"
        //   },
        //   "parameters": {}
        // }
        ObjectNode root = mapper.createObjectNode();
        root.put("model", model);

        ObjectNode input = root.putObject("input");
        input.put("text", text);
        input.put("voice", voice);

        root.putObject("parameters");

        return mapper.writeValueAsString(root);
    }

    /**
     * DashScope TTS 响应为 JSON（包含音频 URL），需下载音频后返回二进制数据。
     * <p>
     * 响应格式:
     * <pre>{@code
     * {
     *   "output": {
     *     "audio": {
     *       "url": "https://dashscope-result-xx.oss-xx.aliyuncs.com/..."
     *     }
     *   },
     *   "request_id": "xxx",
     *   "usage": { ... }
     * }
     * }</pre>
     */
    @Override
    public byte[] processTtsResponse(byte[] responseBody) throws Exception {
        JsonNode root = MAPPER.readTree(responseBody);

        // 检查错误
        JsonNode codeNode = root.path("code");
        if (!codeNode.isMissingNode() && !codeNode.asText("").isEmpty()) {
            String message = root.path("message").asText("未知错误");
            throw new RuntimeException("DashScope TTS 错误: " + codeNode.asText() + " - " + message);
        }

        // 提取音频 URL
        String audioUrl = root.path("output").path("audio").path("url").asText("");
        if (audioUrl.isEmpty()) {
            // 尝试其他可能的路径
            audioUrl = root.path("output").path("audio").asText("");
        }
        if (audioUrl.isEmpty()) {
            throw new RuntimeException("DashScope TTS 响应中未找到音频 URL，原始响应: " +
                    new String(responseBody).substring(0, Math.min(500, responseBody.length)));
        }

        // 下载音频文件
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(audioUrl))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        HttpResponse<byte[]> resp = client.send(req, HttpResponse.BodyHandlers.ofByteArray());
        if (resp.statusCode() != 200) {
            throw new RuntimeException("下载 DashScope 音频失败: HTTP " + resp.statusCode());
        }
        return resp.body();
    }
}
