package com.aiplatform.backend.service.provider;

/**
 * 翻译适配器接口 — 统一不同 AI 供应商的翻译能力。
 * <p>
 * 这是 Provider 架构重构 Phase 4 新增的接口，将翻译能力纳入统一的 Provider 体系。
 * <p>
 * 能力接口体系：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link VoiceAdapter} — 语音识别（ASR），Phase 2 新增</li>
 *   <li>{@link ImageAdapter} — 图片生成，Phase 3 新增</li>
 *   <li>{@link TranslateAdapter} — 翻译，Phase 4 新增（本接口）</li>
 * </ul>
 * <p>
 * 当前实现基于 Chat Completion API（通过构建翻译 prompt 让大模型完成翻译）。
 * 未来可扩展为各供应商的原生翻译 API（如阿里云 DashScope 翻译模型）。
 * <p>
 * 已实现适配器：
 * <ul>
 *   <li>{@link OpenAiTranslateAdapter} — OpenAI 兼容翻译（适用于所有 OpenAI 兼容供应商）</li>
 *   <li>{@link AlibabaTranslateAdapter} — 阿里云 DashScope 翻译</li>
 * </ul>
 *
 * @see TranslateAdapterFactory
 * @see TextAdapter
 * @see ImageAdapter
 * @see VoiceAdapter
 */
public interface TranslateAdapter {

    /**
     * 翻译文本
     *
     * @param baseUrl    渠道 base URL
     * @param apiKey     API Key
     * @param model      模型名称
     * @param text       待翻译文本
     * @param targetLang 目标语言（如 "中文"、"English" 等）
     * @return 翻译结果（包含译文、token 用量、延迟）
     * @throws Exception 请求失败时抛出
     */
    TranslateResult translate(String baseUrl, String apiKey, String model, String text, String targetLang) throws Exception;

    /**
     * 翻译结果
     */
    record TranslateResult(String content, int inputTokens, int outputTokens, int latencyMs) {}
}
