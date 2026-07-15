package com.aiplatform.backend.service.provider;

import com.aiplatform.backend.service.provider.alibaba.AlibabaTranslateAdapter;
import com.aiplatform.backend.service.provider.openai.OpenAiTranslateAdapter;

import java.util.Set;

/**
 * 翻译适配器工厂 — 根据 provider 名称返回对应的 TranslateAdapter 实例。
 * <p>
 * 这是 Provider 架构重构 Phase 4 新增的工厂类，与 {@link VoiceAdapterFactory} 和
 * {@link ImageAdapterFactory} 平行。
 * <p>
 * 供应商分类：
 * <ul>
 *   <li>OpenAI 兼容（Chat API 翻译）：OpenAI / DeepSeek / Azure / Custom 等 → {@link OpenAiTranslateAdapter}</li>
 *   <li>阿里云 DashScope（Chat API 翻译）：Alibaba → {@link AlibabaTranslateAdapter}</li>
 * </ul>
 * <p>
 * 翻译适配器内部组合 {@link ProviderAdapter}（通过 {@link ProviderAdapterFactory}），
 * 复用供应商特定的请求转换、URL 构建、响应提取逻辑，避免代码重复。
 *
 * @deprecated Phase 5 起请使用统一工厂 {@link AdapterFactory}。
 * 调用 {@code AdapterFactory.getTranslateAdapter(provider)} 替代本工厂的 {@link #getAdapter(String)}。
 * 本类仍可正常使用，后续 Phase 6 将作为内部委托保留。
 *
 * @see TranslateAdapter
 * @see OpenAiTranslateAdapter
 * @see AlibabaTranslateAdapter
 * @see AdapterFactory
 */
@Deprecated(since = "Phase 5", forRemoval = false)
public class TranslateAdapterFactory {

    // 单例适配器（无状态，可安全共享）
    private static final OpenAiTranslateAdapter OPENAI = new OpenAiTranslateAdapter();
    private static final AlibabaTranslateAdapter ALIBABA = new AlibabaTranslateAdapter();

    /** 使用 OpenAI 兼容翻译适配器的供应商集合 */
    private static final Set<String> OPENAI_COMPATIBLE = Set.of(
            "OpenAI", "DeepSeek", "Baidu", "Zhipu",
            "Mistral", "Cohere", "Custom", "Minimax", "Azure"
    );

    /** 使用阿里云 DashScope 翻译适配器的供应商集合 */
    private static final Set<String> ALIBABA_NATIVE = Set.of("Alibaba");

    /**
     * 获取供应商对应的翻译适配器（大小写不敏感）
     *
     * @param provider 供应商名称（对应 model_channel.provider 字段）
     * @return TranslateAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static TranslateAdapter getAdapter(String provider) {
        if (provider == null || provider.isBlank()) {
            return OPENAI;
        }
        String p = provider.trim();
        // 大小写不敏感匹配
        for (String alibabaProvider : ALIBABA_NATIVE) {
            if (alibabaProvider.equalsIgnoreCase(p)) {
                return ALIBABA;
            }
        }
        // 其余全部降级为 OpenAI 兼容
        return OPENAI;
    }

    /**
     * 判断供应商是否支持翻译能力
     *
     * @param provider 供应商名称
     * @return 是否支持
     */
    public static boolean supportsTranslate(String provider) {
        if (provider == null || provider.isBlank()) {
            return true; // OpenAI 兼容默认支持
        }
        return OPENAI_COMPATIBLE.contains(provider) || ALIBABA_NATIVE.contains(provider);
    }
}
