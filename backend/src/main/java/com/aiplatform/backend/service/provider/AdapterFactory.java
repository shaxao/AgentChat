package com.aiplatform.backend.service.provider;

/**
 * 统一适配器工厂 — 所有 AI 能力的单一入口点。
 * <p>
 * Provider 架构重构 Phase 5 新增。将 {@link ProviderAdapterFactory}（文本）、
 * {@link VoiceAdapterFactory}（语音）、{@link ImageAdapterFactory}（图片）、
 * {@link TranslateAdapterFactory}（翻译）四个能力工厂统一到一处，
 * 提供类型安全的方法按能力类型获取适配器。
 * <p>
 * 能力接口体系：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link VoiceAdapter} — 语音识别（ASR）</li>
 *   <li>{@link ImageAdapter} — 图片生成</li>
 *   <li>{@link TranslateAdapter} — 翻译</li>
 * </ul>
 * <p>
 * 使用示例：
 * <pre>{@code
 * // 文本对话
 * TextAdapter textAdapter = AdapterFactory.getTextAdapter(channel.provider);
 * 
 * // 语音识别
 * VoiceAdapter voiceAdapter = AdapterFactory.getVoiceAdapter(channel.provider);
 * 
 * // 查询能力
 * if (AdapterFactory.supportsCapability(channel.provider, Capability.IMAGE)) {
 *     ImageAdapter imgAdapter = AdapterFactory.getImageAdapter(channel.provider);
 * }
 * }</pre>
 * <p>
 * 注意：TTS 方法目前仍在 {@link ProviderAdapter} 上（Phase 6 将迁移），
 * 需要使用 TTS 时请通过 {@link #getProviderAdapter(String)} 获取。
 *
 * @see ProviderAdapterFactory
 * @see VoiceAdapterFactory
 * @see ImageAdapterFactory
 * @see TranslateAdapterFactory
 */
@SuppressWarnings("deprecation")
public class AdapterFactory {

    /**
     * AI 能力类型枚举，用于 {@link #supportsCapability(String, Capability)} 查询。
     */
    public enum Capability {
        /** 文本对话（Chat/Completion + Streaming + Vision） */
        TEXT,
        /** 语音识别（ASR） */
        VOICE,
        /** 图片生成 */
        IMAGE,
        /** 翻译 */
        TRANSLATE,
        SEARCH
    }

    private AdapterFactory() {
        // 工具类，禁止实例化
    }

    // ==================== 文本对话 ====================

    /**
     * 获取文本对话适配器（Chat/Completion + Streaming + Vision）。
     * <p>
     * 返回的 {@link TextAdapter} 包含所有文本对话所需的方法：
     * {@code chatUrl()}, {@code streamUrl()}, {@code authHeaders()},
     * {@code transformRequest()}, {@code extractContent()} 等。
     * <p>
     * 内部委托到 {@link ProviderAdapterFactory}。
     *
     * @param provider 供应商名称（对应 model_channel.provider 字段）
     * @return TextAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static TextAdapter getTextAdapter(String provider) {
        return ProviderAdapterFactory.getAdapter(provider);
    }

    /**
     * 获取 ProviderAdapter 实例（包含 TTS 能力）。
     * <p>
     * 仅用于需要 TTS（文本转语音）的场景。文本对话请优先使用
     * {@link #getTextAdapter(String)}，它返回更精确的 {@link TextAdapter} 类型。
     * <p>
     * TTS 方法将在 Phase 6 迁移到独立的 TtsAdapter 接口，届时本方法将被移除。
     *
     * @param provider 供应商名称
     * @return ProviderAdapter 实例（extends TextAdapter，额外包含 TTS 方法）
     */
    public static ProviderAdapter getProviderAdapter(String provider) {
        return ProviderAdapterFactory.getAdapter(provider);
    }

    // ==================== 语音识别 ====================

    /**
     * 获取语音识别适配器（ASR）。
     * <p>
     * 内部委托到 {@link VoiceAdapterFactory}。
     *
     * @param provider 供应商名称
     * @return VoiceAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static VoiceAdapter getVoiceAdapter(String provider) {
        return VoiceAdapterFactory.getAdapter(provider);
    }

    // ==================== 图片生成 ====================

    /**
     * 获取图片生成适配器。
     * <p>
     * 内部委托到 {@link ImageAdapterFactory}。
     *
     * @param provider 供应商名称
     * @return ImageAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static ImageAdapter getImageAdapter(String provider) {
        return ImageAdapterFactory.getAdapter(provider);
    }

    // ==================== 翻译 ====================

    /**
     * 获取翻译适配器。
     * <p>
     * 内部委托到 {@link TranslateAdapterFactory}。
     *
     * @param provider 供应商名称
     * @return TranslateAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static TranslateAdapter getTranslateAdapter(String provider) {
        return TranslateAdapterFactory.getAdapter(provider);
    }

    // ==================== 能力查询 ====================

    /**
     * 查询供应商是否支持指定能力。
     *
     * @param provider   供应商名称
     * @param capability 能力类型
     * @return 是否支持
     */
    public static boolean supportsCapability(String provider, Capability capability) {
        if (capability == null) {
            return false;
        }
        return switch (capability) {
            case TEXT -> true; // 所有已注册供应商均支持文本对话
            case VOICE -> VoiceAdapterFactory.supportsVoice(provider);
            case IMAGE -> ImageAdapterFactory.supportsImage(provider);
            case TRANSLATE -> TranslateAdapterFactory.supportsTranslate(provider);
            case SEARCH -> SearchAdapterFactory.supportsSearch(provider);
        };
    }

    /**
     * 判断供应商是否使用 OpenAI 兼容格式。
     * <p>
     * 委托到 {@link ProviderAdapterFactory#isOpenAiCompatible(String)}。
     *
     * @param provider 供应商名称
     * @return 是否使用 OpenAI 兼容格式
     */
    public static boolean isOpenAiCompatible(String provider) {
        return ProviderAdapterFactory.isOpenAiCompatible(provider);
    }
}
