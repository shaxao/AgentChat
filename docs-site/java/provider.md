# Provider 架构

上一章 [SSE 流式对话](/java/sse-chat) 里，`AiService` 把「怎么解析一行 SSE」全权交给了一个 `adapter`。这一章就讲这个适配器体系 —— 它是全项目里适配器模式（Adapter Pattern）用得最典型、也最值得学的一处。

## 要解决的问题

平台要同时接入 OpenAI、Anthropic、Google、阿里云、豆包……每一家的 API 都不一样：

- 请求体格式不同（OpenAI 的 `messages` vs Anthropic 的 `system` 单独拎出来）。
- 流式响应的分帧、结束标记不同。
- 有的支持 TTS，有的不支持。

如果在 `AiService` 里写一堆 `if (provider.equals("Anthropic")) { ... }`，代码很快就会烂掉。**适配器模式的作用，就是把这些差异收敛到一组实现同一接口的类里。**

## 能力分层的接口体系

项目没有用一个巨大的接口，而是**按能力分层**：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/provider/ProviderAdapter.java:35"
  :notes="[
    { lines: '1', text: 'ProviderAdapter 继承 TextAdapter —— 文本对话能力全部抽在 TextAdapter 里。' },
    { lines: '4-6', text: 'TTS（文字转语音）能力用 default 方法给出默认实现：默认不支持、返回 null。支持 TTS 的厂商覆写即可。这样不支持 TTS 的适配器一行都不用写。' }
  ]">

```java
public interface ProviderAdapter extends TextAdapter {

    // ===== TTS =====
    default String ttsUrl(String baseUrl) { return null; }
    default boolean supportsTts() { return false; }

    default String transformTtsRequest(ObjectMapper mapper, String model,
                                        String text, String voice) throws Exception {
        // OpenAI 格式默认实现
    }
}
```

</SourceExplainer>

能力接口的层次是：`TextAdapter`（纯文本对话）→ `ProviderAdapter`（文本 + TTS，当前主力）→ `VoiceAdapter`（语音，规划中）。源码注释里明确写了这是分阶段重构的产物 —— **用 `default` 方法保证向后兼容，是接口演进的标准手法**。

## 工厂：按 provider 名字分派

具体用哪个适配器，由工厂根据 `provider` 字段决定：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/provider/ProviderAdapterFactory.java:58"
  :notes="[
    { lines: '1-3', text: 'provider 为空时，默认用 OpenAI 兼容适配器 —— 这是最宽容的兜底。' },
    { lines: '4-9', text: '阿里云、Anthropic、Google 各自有原生适配器，命中就返回对应实例。' },
    { lines: '10-11', text: '其余全部降级为 OpenAI 兼容。因为 DeepSeek、智谱、Mistral 等大量厂商都兼容 OpenAI 格式，一个适配器就能覆盖。' }
  ]">

```java
public static ProviderAdapter getAdapter(String provider) {
    if (provider == null || provider.isBlank()) {
        return OPENAI;
    }
    if (ALIBABA_NATIVE.contains(provider)) return ALIBABA;
    if (ANTHROPIC_NATIVE.contains(provider)) return ANTHROPIC;
    if (GOOGLE_NATIVE.contains(provider)) return GOOGLE;
    // 其余全部降级为 OpenAI 兼容
    return OPENAI;
}
```

</SourceExplainer>

适配器都是**无状态单例**（`private static final OpenAiTextAdapter OPENAI = new OpenAiTextAdapter()`），可以安全共享，不用每次 new。

## 一个值得注意的细节：新旧工厂并存

`ProviderAdapterFactory` 类上标了 `@Deprecated(since = "Phase 5", forRemoval = false)`，注释说请改用统一工厂 `AdapterFactory`。这是一个**渐进式重构**的真实现场：

- 新代码走 `AdapterFactory.getProviderAdapter(provider)`。
- 老工厂保留、不删除（`forRemoval = false`），作为内部委托，避免一次性大改动引入风险。

::: tip 从这里能学到什么
适配器模式的价值不在「现在能接几家」，而在「以后加一家要改多少代码」。这里加一个新厂商只需两步：实现 `ProviderAdapter` 接口、在工厂里注册。`AiService` 一行都不用动。这就是「对扩展开放、对修改封闭」的开闭原则落地。
:::

## 厂商实现的组织

`service/provider/` 下按厂商建了子目录：`openai/`、`anthropic/`、`google/`、`alibaba/`、`doubao/`。每个子目录里是该厂商的 `TextAdapter` 实现。除了文本，还有并列的 `ImageAdapter` / `SearchAdapter` / `TranslateAdapter` / `VoiceAdapter` 及各自工厂 —— 图片、搜索、翻译、语音每种能力都套用同一套「接口 + 工厂 + 多厂商实现」的骨架。

理解了文本适配器，其余几种能力的结构是完全一样的，可以举一反三。
