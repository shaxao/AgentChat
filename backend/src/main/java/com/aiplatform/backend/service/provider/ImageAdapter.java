package com.aiplatform.backend.service.provider;

/**
 * 图片生成适配器接口 — 统一不同 AI 供应商的图片生成能力。
 * <p>
 * 这是 Provider 架构重构 Phase 3 新增的接口，将图片生成能力纳入统一的 Provider 体系。
 * <p>
 * 能力接口体系：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link VoiceAdapter} — 语音识别（ASR），Phase 2 新增</li>
 *   <li>{@link ImageAdapter} — 图片生成，Phase 3 新增（本接口）</li>
 *   <li>{@link TranslateAdapter} — 翻译，Phase 4 新增</li>
 * </ul>
 * <p>
 * 已实现适配器：
 * <ul>
 *   <li>{@link com.aiplatform.backend.service.provider.openai.OpenAiImageAdapter} — OpenAI / DALL-E 兼容</li>
 *   <li>{@link com.aiplatform.backend.service.provider.alibaba.AlibabaImageAdapter} — 阿里云 DashScope / Qwen-Image</li>
 * </ul>
 *
 * @see ImageAdapterFactory
 * @see TextAdapter
 * @see VoiceAdapter
 */
public interface ImageAdapter {

    /**
     * 生成图片
     *
     * @param baseUrl   渠道 base URL
     * @param apiKey    API Key
     * @param model     模型名称（实际 API 模型名）
     * @param prompt    图片描述提示词
     * @param size      图片尺寸，如 "1024x1024"（适配器内部负责转换为各平台格式）
     * @return 图片 URL 或 data URI（base64）
     * @throws Exception 请求失败时抛出
     */
    String generateImage(String baseUrl, String apiKey, String model, String prompt, String size) throws Exception;
}
