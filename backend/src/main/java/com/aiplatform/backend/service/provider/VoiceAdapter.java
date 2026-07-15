package com.aiplatform.backend.service.provider;

/**
 * 语音识别适配器接口 — 统一不同 AI 供应商的 ASR（语音识别）能力。
 * <p>
 * 这是 Provider 架构重构 Phase 2 新增的接口，将 ASR 能力从 {@link com.aiplatform.backend.service.AiService}
 * 中抽取出来，使职责更清晰。
 * <p>
 * TTS（语音合成）暂留在 {@link ProviderAdapter} 中，后续 Phase 会迁移到本接口。
 * <p>
 * 能力接口体系：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link VoiceAdapter} — 语音识别（ASR），Phase 2 新增</li>
 * </ul>
 * <p>
 * 已实现适配器：
 * <ul>
 *   <li>{@link OpenAiVoiceAdapter} — OpenAI Whisper ASR</li>
 *   <li>{@link AlibabaVoiceAdapter} — 阿里云 DashScope ASR（同步 + 异步）</li>
 * </ul>
 *
 * @see TextAdapter
 * @see OpenAiVoiceAdapter
 * @see AlibabaVoiceAdapter
 */
public interface VoiceAdapter {

    /**
     * 是否支持 ASR（语音识别）
     */
    boolean supportsAsr();

    /**
     * 语音转文字 — 通过音频文件 URL
     *
     * @param fileUrl  音频文件的公开可访问 URL
     * @param apiKey   供应商 API Key
     * @param baseUrl  渠道 base URL
     * @param model    ASR 模型名称
     * @return 识别出的文字
     */
    String speechToText(String fileUrl, String apiKey, String baseUrl, String model) throws Exception;

    /**
     * 语音转文字 — 直接接收音频字节
     *
     * @param audioData 音频文件字节数据
     * @param fileName  音频文件名（含扩展名，如 "voice.mp3"）
     * @param apiKey    供应商 API Key
     * @param baseUrl   渠道 base URL
     * @param model     ASR 模型名称
     * @return 识别出的文字
     */
    String speechToTextFromBytes(byte[] audioData, String fileName, String apiKey, String baseUrl, String model) throws Exception;
}
