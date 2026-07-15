package com.aiplatform.backend.service.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * 供应商适配器接口 — 统一不同 AI 供应商的 API 调用差异。
 * <p>
 * 继承自 {@link TextAdapter}（文本对话），并扩展 TTS 能力。
 * <p>
 * 能力接口体系（重构目标）：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link ProviderAdapter} — 文本对话 + TTS（当前实现，向后兼容）</li>
 *   <li>{@link VoiceAdapter} — 语音（TTS + ASR），Phase 2 新增</li>
 * </ul>
 * <p>
 * 已实现适配器（按厂商子目录组织）：
 * - {@link com.aiplatform.backend.service.provider.openai.OpenAiTextAdapter} — OpenAI / DeepSeek / 阿里云 / 智谱 / Mistral / Cohere / Custom（OpenAI 兼容）
 * - {@link com.aiplatform.backend.service.provider.alibaba.AlibabaTextAdapter} — 阿里云 DashScope（Chat 兼容 OpenAI，TTS 用原生 API）
 * - {@link com.aiplatform.backend.service.provider.anthropic.AnthropicTextAdapter} — Claude 系列（仅文本对话，无 TTS）
 * - {@link com.aiplatform.backend.service.provider.google.GoogleTextAdapter} — Gemini 系列（仅文本对话，无 TTS）
 * <p>
 * 重构说明（Phase 1）：
 * 本接口继承 {@link TextAdapter}，所有文本对话方法已抽取到 {@link TextAdapter}。
 * TTS 方法仍保留在本接口中（将在 Phase 2 迁移到 {@link VoiceAdapter}）。
 * 本接口保持所有方法不变，确保向后兼容。
 *
 * @see TextAdapter
 * @see VoiceAdapter
 */
public interface ProviderAdapter extends TextAdapter {

    // ===== TTS =====
    // Note: These methods will be moved to VoiceAdapter in Phase 2.
    // They remain here for backward compatibility during the transition.

    /**
     * 构建 TTS 请求 URL（不支持 TTS 的供应商返回 null）
     */
    default String ttsUrl(String baseUrl) { return null; }

    /**
     * 是否支持 TTS
     */
    default boolean supportsTts() { return false; }

    /**
     * 构建 TTS 请求体（JSON 字符串）。
     * <p>
     * 默认实现为 OpenAI 格式：{"model":"tts-1","input":"text","voice":"alloy"}
     * 非标准供应商（如阿里云 DashScope）需覆写此方法以使用原生请求格式。
     *
     * @param mapper Jackson ObjectMapper 实例
     * @param model   TTS 模型名称
     * @param text    要合成的文本
     * @param voice   音色 ID
     * @return TTS 请求体 JSON 字符串
     */
    default String transformTtsRequest(ObjectMapper mapper, String model, String text, String voice) throws Exception {
        ObjectNode root = mapper.createObjectNode();
        root.put("model", model);
        root.put("input", text);
        root.put("voice", voice);
        return mapper.writeValueAsString(root);
    }

    /**
     * 处理 TTS 响应，返回音频二进制数据。
     * <p>
     * 默认实现：OpenAI 兼容供应商直接返回响应体（二进制 MP3）。
     * 非标准供应商（如阿里云 DashScope）返回 JSON（含音频下载 URL），需覆写此方法下载音频。
     *
     * @param responseBody HTTP 响应体原始字节
     * @return 音频二进制数据
     */
    default byte[] processTtsResponse(byte[] responseBody) throws Exception {
        return responseBody;
    }
}
