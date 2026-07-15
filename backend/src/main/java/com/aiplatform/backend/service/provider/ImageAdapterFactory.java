package com.aiplatform.backend.service.provider;

import com.aiplatform.backend.service.provider.alibaba.AlibabaImageAdapter;
import com.aiplatform.backend.service.provider.openai.OpenAiImageAdapter;

import java.util.Set;

/**
 * 图片生成适配器工厂 — 根据 provider 名称返回对应的 ImageAdapter 实例。
 * <p>
 * 这是 Provider 架构重构 Phase 3 新增的工厂类，与 {@link VoiceAdapterFactory} 平行。
 * <p>
 * 供应商分类：
 * <ul>
 *   <li>OpenAI 兼容（DALL-E 等）：OpenAI / DeepSeek / Azure / Custom 等 → {@link OpenAiImageAdapter}</li>
 *   <li>阿里云 DashScope（Qwen-Image / 万相）：Alibaba → {@link AlibabaImageAdapter}</li>
 * </ul>
 * <p>
 * 已在 Phase 6 中删除，新代码应使用本工厂。
 *
 * @deprecated Phase 5 起请使用统一工厂 {@link AdapterFactory}。
 * 调用 {@code AdapterFactory.getImageAdapter(provider)} 替代本工厂的 {@link #getAdapter(String)}。
 * 本类仍可正常使用，后续 Phase 6 将作为内部委托保留。
 *
 * @see ImageAdapter
 * @see OpenAiImageAdapter
 * @see AlibabaImageAdapter
 * @see AdapterFactory
 */
@Deprecated(since = "Phase 5", forRemoval = false)
public class ImageAdapterFactory {

    // 单例适配器（无状态，可安全共享）
    private static final OpenAiImageAdapter OPENAI = new OpenAiImageAdapter();
    private static final AlibabaImageAdapter ALIBABA = new AlibabaImageAdapter();

    /** 使用 OpenAI 兼容图片生成格式的供应商集合 */
    private static final Set<String> OPENAI_COMPATIBLE = Set.of(
            "OpenAI", "DeepSeek", "Baidu", "Zhipu",
            "Mistral", "Cohere", "Custom", "Minimax", "Azure"
    );

    /** 使用阿里云 DashScope 原生图片生成格式的供应商集合 */
    private static final Set<String> ALIBABA_NATIVE = Set.of("Alibaba");

    /**
     * 获取供应商对应的图片生成适配器（大小写不敏感）
     *
     * @param provider 供应商名称（对应 model_channel.provider 字段）
     * @return ImageAdapter 实例，未知供应商降级为 OpenAI 兼容
     */
    public static ImageAdapter getAdapter(String provider) {
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
     * 判断供应商是否支持图片生成
     *
     * @param provider 供应商名称
     * @return 是否支持
     */
    public static boolean supportsImage(String provider) {
        if (provider == null || provider.isBlank()) {
            return true; // OpenAI 兼容默认支持
        }
        return OPENAI_COMPATIBLE.contains(provider) || ALIBABA_NATIVE.contains(provider);
    }
}
