package com.aiplatform.backend.service.provider;

import com.aiplatform.backend.service.provider.alibaba.AlibabaTextAdapter;
import com.aiplatform.backend.service.provider.anthropic.AnthropicTextAdapter;
import com.aiplatform.backend.service.provider.google.GoogleTextAdapter;
import com.aiplatform.backend.service.provider.openai.OpenAiTextAdapter;

import java.util.Set;

/**
 * 供应商适配器工厂 — 根据 provider 名称返回对应适配器实例。
 * <p>
 * 供应商分类：
 * - OpenAI 兼容（使用 {@link OpenAiTextAdapter}）：OpenAI / DeepSeek / Baidu / Zhipu / Mistral / Cohere / Custom / MiniMax
 * - 阿里云 DashScope（使用 {@link AlibabaTextAdapter}）：Alibaba — Chat 兼容 OpenAI，TTS 用原生 API
 * - Anthropic 原生（使用 {@link AnthropicTextAdapter}）：Anthropic
 * - Google 原生（使用 {@link GoogleTextAdapter}）：Google
 * <p>
 * 扩展新供应商：
 * 1. 实现 {@link ProviderAdapter} 接口
 * 2. 在此工厂的 PROVIDER_MAP 中注册
 *
 * @deprecated Phase 5 起请使用统一工厂 {@link AdapterFactory}。
 * 调用 {@code AdapterFactory.getProviderAdapter(provider)} 或
 * {@code AdapterFactory.getTextAdapter(provider)} 替代本工厂的 {@link #getAdapter(String)}。
 * 本类仍可正常使用，后续 Phase 6 将作为内部委托保留。
 */
@Deprecated(since = "Phase 5", forRemoval = false)
public class ProviderAdapterFactory {

    // 单例适配器（无状态，可安全共享）
    private static final OpenAiTextAdapter OPENAI = new OpenAiTextAdapter();
    private static final AlibabaTextAdapter ALIBABA = new AlibabaTextAdapter();
    private static final AnthropicTextAdapter ANTHROPIC = new AnthropicTextAdapter();
    private static final GoogleTextAdapter GOOGLE = new GoogleTextAdapter();

    /** 使用 OpenAI 兼容适配器的供应商集合 */
    private static final Set<String> OPENAI_COMPATIBLE = Set.of(
            "OpenAI", "DeepSeek", "Baidu", "Zhipu",
            "Mistral", "Cohere", "Custom", "Minimax"
    );

    /** 使用阿里云 DashScope 适配器的供应商集合 */
    private static final Set<String> ALIBABA_NATIVE = Set.of("Alibaba");

    /** 使用 Anthropic 原生适配器的供应商集合 */
    private static final Set<String> ANTHROPIC_NATIVE = Set.of("Anthropic");

    /** 使用 Google 原生适配器的供应商集合 */
    private static final Set<String> GOOGLE_NATIVE = Set.of("Google");

    /**
     * 获取供应商对应的适配器
     *
     * @param provider 供应商名称（对应 model_channel.provider 字段）
     * @return 适配器实例，未知供应商降级为 OpenAI 兼容
     */
    public static ProviderAdapter getAdapter(String provider) {
        if (provider == null || provider.isBlank()) {
            return OPENAI;
        }
        if (ALIBABA_NATIVE.contains(provider)) {
            return ALIBABA;
        }
        if (ANTHROPIC_NATIVE.contains(provider)) {
            return ANTHROPIC;
        }
        if (GOOGLE_NATIVE.contains(provider)) {
            return GOOGLE;
        }
        // 其余全部降级为 OpenAI 兼容
        return OPENAI;
    }

    /**
     * 判断供应商是否使用 OpenAI 兼容格式
     */
    public static boolean isOpenAiCompatible(String provider) {
        return provider == null || provider.isBlank() || OPENAI_COMPATIBLE.contains(provider);
    }

    /**
     * 判断供应商是否需要原生适配器
     */
    public static boolean isNativeAdapter(String provider) {
        return ANTHROPIC_NATIVE.contains(provider) || GOOGLE_NATIVE.contains(provider);
    }
}
