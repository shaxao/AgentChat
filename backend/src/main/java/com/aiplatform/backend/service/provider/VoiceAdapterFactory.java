package com.aiplatform.backend.service.provider;

import com.aiplatform.backend.service.provider.alibaba.AlibabaVoiceAdapter;
import com.aiplatform.backend.service.provider.openai.OpenAiVoiceAdapter;

import java.util.Map;
import java.util.Set;

/**
 * 语音适配器工厂 — 根据 provider 名称返回对应 VoiceAdapter 实例。
 * <p>
 * 这是 Provider 架构重构 Phase 2 新增的工厂类，与 {@link ProviderAdapterFactory} 平行。
 * <p>
 * 供应商分类：
 * <ul>
 *   <li>OpenAI 兼容（使用 {@link OpenAiVoiceAdapter}）: OpenAI / DeepSeek / Baidu / Zhipu / Mistral / Cohere / Custom / MiniMax</li>
 *   <li>阿里云 DashScope（使用 {@link AlibabaVoiceAdapter}）: Alibaba</li>
 * </ul>
 * <p>
 * 注意：Anthropic 和 Google 目前不支持语音能力，工厂暂不注册。
 *
 * @deprecated Phase 5 起请使用统一工厂 {@link AdapterFactory}。
 * 调用 {@code AdapterFactory.getVoiceAdapter(provider)} 替代本工厂的 {@link #getAdapter(String)}。
 * 本类仍可正常使用，后续 Phase 6 将作为内部委托保留。
 *
 * @see VoiceAdapter
 * @see OpenAiVoiceAdapter
 * @see AlibabaVoiceAdapter
 * @see AdapterFactory
 */
@Deprecated(since = "Phase 5", forRemoval = false)
public class VoiceAdapterFactory {

    // 单例适配器（无状态，可安全共享）
    private static final OpenAiVoiceAdapter OPENAI = new OpenAiVoiceAdapter();
    private static final AlibabaVoiceAdapter ALIBABA = new AlibabaVoiceAdapter();

    /** 使用 OpenAI 兼容语音适配器的供应商集合 */
    private static final Set<String> OPENAI_COMPATIBLE = Set.of(
            "OpenAI", "DeepSeek", "Baidu", "Zhipu",
            "Mistral", "Cohere", "Custom", "Minimax"
    );

    /** 使用阿里云 DashScope 语音适配器的供应商集合 */
    private static final Set<String> ALIBABA_NATIVE = Set.of("Alibaba");

    /**
     * 获取供应商对应的语音适配器（大小写不敏感）
     *
     * @param provider 供应商名称（对应 model_channel.provider 字段）
     * @return VoiceAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static VoiceAdapter getAdapter(String provider) {
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
     * 判断供应商是否支持语音能力（TTS 或 ASR）
     *
     * @param provider 供应商名称
     * @return 是否支持
     */
    public static boolean supportsVoice(String provider) {
        if (provider == null || provider.isBlank()) {
            return true; // OpenAI 兼容默认支持
        }
        return OPENAI_COMPATIBLE.contains(provider) || ALIBABA_NATIVE.contains(provider);
    }
}
