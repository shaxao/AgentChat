# 后端 Provider 架构重构方案

## 一、现状分析

### 1.1 当前目录结构

```
service/
├── AiService.java              ← 2700 行巨型类（Chat + TTS + ASR + Translate + Image 编排）
├── provider/                  ← 仅文本对话适配器
│   ├── ProviderAdapter.java   ← 接口：Chat + TTS 方法混入（违反单一职责）
│   ├── ProviderAdapterFactory.java
│   ├── OpenAiAdapter.java    ← Chat（含 TTS URL 构建）
│   ├── AlibabaAdapter.java   ← Chat（继承 OpenAiAdapter）+ DashScope TTS 原生实现
│   ├── AnthropicAdapter.java ← Chat（Claude 原生格式）
│   └── GoogleAdapter.java   ← Chat（Gemini 原生格式）
├── image/                    ← 与 provider/ 平行的独立体系
│   ├── ImageGenAdapter.java
│   ├── ImageGenAdapterFactory.java
│   ├── OpenAiImageAdapter.java
│   └── AlibabaImageAdapter.java
└── (其他业务服务...)
```

### 1.2 核心问题

| 问题 | 具体表现 | 影响 |
|------|----------|------|
| **接口职责混乱** | `ProviderAdapter` 同时定义 Chat + TTS 方法 | 不支持 TTS 的厂商（Anthropic/Google）也要实现空方法 |
| **同一厂商代码分散** | Alibaba 的代码在 3 处：`AlibabaAdapter`、`AlibabaImageAdapter`、`AiService`（ASR/TTS） | 修改 Alibaba 能力需改多处，易遗漏 |
| **ASR 无适配器抽象** | ASR 逻辑硬编码在 `AiService.speechToText()` 里，按 provider 字符串分支 | 新增 ASR 提供商需改 AiService，违反开闭原则 |
| **Translate 复用 Chat 适配器** | `translateWithChannel()` 复用 `chatUrl/transformRequest` 发聊天请求做翻译 | 不优雅，且无法利用各提供商原生翻译 API |
| **两个平行工厂** | `ProviderAdapterFactory` 和 `ImageGenAdapterFactory` 逻辑几乎相同 | 新增能力需新建工厂，重复代码 |
| **AiService 膨胀** | 2700 行，所有能力的编排逻辑都堆在一起 | 维护困难，合并冲突频繁 |

### 1.3 当前各能力在代码中的分布

| 能力 | 接口定义 | 实现位置 | 工厂 |
|------|---------|---------|------|
| Chat（文本对话） | `ProviderAdapter` | `provider/OpenAiAdapter` 等 | `ProviderAdapterFactory` |
| TTS（语音合成） | `ProviderAdapter`（混入） | `OpenAiAdapter.ttsUrl()` / `AlibabaAdapter.transformTtsRequest()` | 无（AiService 直接调用 adapter 方法） |
| ASR（语音识别） | **无接口** | `AiService.speechToTextAlibaba()` / `speechToTextOpenAI()` | **无** |
| Image（图片生成） | `ImageGenAdapter`（独立接口） | `image/OpenAiImageAdapter` 等 | `ImageGenAdapterFactory` |
| Translate（翻译） | **无接口** | `AiService.translateWithChannel()` 复用 Chat adapter | **无** |

---

## 二、目标架构

### 2.1 目录结构

```
service/
├── AiService.java                  ← 瘦身：仅保留编排逻辑，具体实现下沉到 adapter
├── provider/                      ← 统一适配器根目录
│   ├── core/                      ← 核心抽象（能力接口 + 统一工厂）
│   │   ├── TextAdapter.java       ← 文本对话能力接口（原 ProviderAdapter 改名）
│   │   ├── VoiceAdapter.java     ← 语音能力接口（TTS + ASR）
│   │   ├── ImageAdapter.java     ← 图片生成能力接口（原 ImageGenAdapter 迁移）
│   │   ├── TranslateAdapter.java ← 翻译能力接口（新增）
│   │   └── AdapterFactory.java  ← 统一工厂：按「厂商 + 能力类型」路由
│   ├── alibaba/
│   │   ├── AlibabaTextAdapter.java   ← 原 AlibabaAdapter（Chat 部分）
│   │   ├── AlibabaVoiceAdapter.java  ← 原 AlibabaAdapter（TTS）+ AiService（ASR）
│   │   ├── AlibabaImageAdapter.java  ← 原 image/AlibabaImageAdapter（迁移）
│   │   └── AlibabaTranslateAdapter.java ← 新增（DashScope 翻译 API）
│   ├── openai/
│   │   ├── OpenAiTextAdapter.java    ← 原 OpenAiAdapter（Chat 部分）
│   │   ├── OpenAiVoiceAdapter.java   ← TTS（/audio/speech）+ Whisper ASR
│   │   ├── OpenAiImageAdapter.java   ← 原 image/OpenAiImageAdapter（迁移）
│   │   └── OpenAiTranslateAdapter.java ← 新增（OpenAI 翻译）
│   ├── anthropic/
│   │   └── AnthropicTextAdapter.java ← 原 AnthropicAdapter
│   └── google/
│       ├── GoogleTextAdapter.java     ← 原 GoogleAdapter（Chat 部分）
│       └── GoogleImageAdapter.java   ← 新增（Gemini 图片生成）
```

### 2.2 接口设计

#### `TextAdapter`（原 `ProviderAdapter`，剔除 TTS 方法）

```java
public interface TextAdapter {
    // === 非流式 ===
    String chatUrl(String baseUrl, String model, String apiKey);
    Map<String, String> authHeaders(String apiKey);
    ObjectNode transformRequest(ObjectNode canonicalBody, String provider);
    String extractContent(JsonNode response);
    int extractInputTokens(JsonNode response, int fallback);
    int extractOutputTokens(JsonNode response, int fallback);
    JsonNode normalizeResponse(JsonNode response);
    String extractThinkingContent(JsonNode response);

    // === 流式 ===
    String streamUrl(String baseUrl, String model, String apiKey);
    String parseStreamLine(String line, StreamContext ctx);
    boolean isStreamDone(StreamContext ctx);
    int[] getStreamUsage(StreamContext ctx);
    String getThinkingContent(StreamContext ctx);

    // === StreamContext ===
    class StreamContext { ... }
}
```

#### `VoiceAdapter`（TTS + ASR 统一接口）

```java
public interface VoiceAdapter {
    // === TTS（语音合成）===
    String ttsUrl(String baseUrl);
    String transformTtsRequest(ObjectMapper mapper, String model, String text, String voice) throws Exception;
    byte[] processTtsResponse(byte[] responseBody) throws Exception;

    // === ASR（语音识别）===
    /** 批量识别（文件 URL） */
    String speechToText(String fileUrl, String apiKey, String baseUrl, String model) throws Exception;
    /** 批量识别（音频字节，支持直接上传） */
    String speechToTextFromBytes(byte[] audioData, String fileName, String apiKey, String baseUrl, String model) throws Exception;
}
```

#### `ImageAdapter`（原 `ImageGenAdapter` 迁移，签名不变）

```java
public interface ImageAdapter {
    String generateImage(String baseUrl, String apiKey, String model, String prompt, String size) throws Exception;
}
```

#### `TranslateAdapter`（新增）

```java
public interface TranslateAdapter {
    String translate(String text, String targetLang, String apiKey, String baseUrl, String model) throws Exception;
}
```

### 2.3 统一工厂 `AdapterFactory`

```java
public class AdapterFactory {
    private static final Map<String, Map<String, Supplier<?>>> REGISTRY = Map.of(
        "alibaba", Map.of(
            "text", (Supplier<TextAdapter>) AlibabaTextAdapter::new,
            "voice", (Supplier<VoiceAdapter>) AlibabaVoiceAdapter::new,
            "image", (Supplier<ImageAdapter>) AlibabaImageAdapter::new,
            "translate", (Supplier<TranslateAdapter>) AlibabaTranslateAdapter::new
        ),
        "openai", Map.of(
            "text", (Supplier<TextAdapter>) OpenAiTextAdapter::new,
            "voice", (Supplier<VoiceAdapter>) OpenAiVoiceAdapter::new,
            "image", (Supplier<ImageAdapter>) OpenAiImageAdapter::new,
            "translate", (Supplier<TranslateAdapter>) OpenAiTranslateAdapter::new
        ),
        "anthropic", Map.of(
            "text", (Supplier<TextAdapter>) AnthropicTextAdapter::new
            // voice/image/translate 不支持，工厂返回 null
        ),
        "google", Map.of(
            "text", (Supplier<TextAdapter>) GoogleTextAdapter::new,
            "image", (Supplier<ImageAdapter>) GoogleImageAdapter::new
        )
    );

    @SuppressWarnings("unchecked")
    public static <T> T getAdapter(String provider, String capabilityType) {
        // 查注册表，未找到返回 null
        // 调用方决定降级策略（如 translate 不可用则复用 text adapter）
    }
}
```

---

## 三、分阶段重构计划

### 设计原则

1. **每一步都可独立编译、独立部署**，不破坏现有功能
2. **新旧适配器并存**，通过配置切换，不强制迁移
3. **先抽接口、再迁实现、最后删旧代码**
4. **每步编译通过 + 关键接口冒烟测试**

---

### Phase 1：抽取 `TextAdapter` 接口（不影响现有功能）

**目标**：从 `ProviderAdapter` 中剔除 TTS 方法，新建 `TextAdapter` 接口，让 `ProviderAdapter` 继承 `TextAdapter`（向后兼容）。

**步骤**：

1. 新建 `service/provider/core/TextAdapter.java`，内容为原 `ProviderAdapter` 去掉 TTS 方法
2. 修改 `ProviderAdapter` 改为 `extends TextAdapter`，TTS 方法保留在当前文件
3. 编译验证：`mvn compile` 通过
4. **部署**：无行为变化，可安全部署

**产出**：
- `service/provider/core/TextAdapter.java`（新接口）
- `ProviderAdapter.java` 变为 `abstract class ProviderAdapter implements TextAdapter`（向后兼容）

**风险**：⭐ 极低（仅接口拆分，无行为变化）

---

### Phase 2：新建 `VoiceAdapter` 接口 + 抽取 Alibaba/OpenAI 实现

**目标**：将 TTS 和 ASR 从 `AiService` 和 `ProviderAdapter` 中剥离，放入 `VoiceAdapter` 实现类。

**步骤**：

1. 新建 `service/provider/core/VoiceAdapter.java`（接口，含 TTS + ASR 方法）
2. 新建 `service/provider/openai/OpenAiVoiceAdapter.java`：
   - TTS：`ttsUrl()` + `transformTtsRequest()`（从 `OpenAiAdapter` 迁移）
   - ASR：`speechToText()` + `speechToTextFromBytes()`（从 `AiService` 迁移 `doOpenAIWhisper`）
3. 新建 `service/provider/alibaba/AlibabaVoiceAdapter.java`：
   - TTS：`ttsUrl()` + `transformTtsRequest()` + `processTtsResponse()`（从 `AlibabaAdapter` 迁移）
   - ASR：`speechToText()` + `speechToTextFromBytes()`（从 `AiService` 迁移 `speechToTextAlibaba`）
4. 修改 `AiService.textToSpeechWithChannel()`：优先用 `VoiceAdapter`，找不到则降级到 `ProviderAdapter`（兼容旧代码）
5. 修改 `AiService.speechToText()`：优先用 `VoiceAdapter`，找不到则降级到硬编码逻辑（兼容旧代码）
6. 编译验证 + 本地冒烟测试（TTS 预览 + 上传音频转文字）
7. **部署**

**产出**：
- `VoiceAdapter` 接口
- `OpenAiVoiceAdapter`、`AlibabaVoiceAdapter`
- `AiService` 中 TTS/ASR 入口改为优先使用 `VoiceAdapter`

**风险**：⭐⭐ 低（降级逻辑保证旧代码仍可用）

---

### Phase 3：新建 `ImageAdapter` 接口 + 迁移 `image/` 包

**目标**：将 `image/ImageGenAdapter` 迁移到 `provider/core/ImageAdapter`，统一包结构。

**步骤**：

1. 新建 `service/provider/core/ImageAdapter.java`（内容与 `image/ImageGenAdapter` 相同）
2. 修改 `image/ImageGenAdapter.java` 为 `extends ImageAdapter`（向后兼容）
3. 新建 `service/provider/alibaba/AlibabaImageAdapter.java`（从 `image/AlibabaImageAdapter` 复制，实现 `ImageAdapter`）
4. 新建 `service/provider/openai/OpenAiImageAdapter.java`（从 `image/OpenAiImageAdapter` 复制，实现 `ImageAdapter`）
5. 修改 `AiService.generateImage()`：优先用新 `ImageAdapter`，找不到则降级到 `image/ImageGenAdapter`（兼容）
6. 编译验证 + 本地冒烟测试（图片生成）
7. **部署**

**产出**：
- `ImageAdapter` 接口（在 `provider/core/`）
- 新 `AlibabaImageAdapter`、`OpenAiImageAdapter`（在 `provider/alibaba/` 和 `provider/openai/`）
- 旧 `image/` 包保留，标记 `@Deprecated`

**风险**：⭐ 低（image 生成相对独立，影响面小）

---

### Phase 4：新建 `TranslateAdapter` 接口 + 实现

**目标**：将 `AiService.translateWithChannel()` 中的翻译逻辑下沉到 `TranslateAdapter`。

**步骤**：

1. 新建 `service/provider/core/TranslateAdapter.java`
2. 新建 `OpenAiTranslateAdapter.java`（通用 OpenAI 兼容翻译：构造 messages 调 Chat API）
3. 新建 `AlibabaTranslateAdapter.java`（DashScope 翻译 API，如有原生接口）
4. 修改 `AiService.translateWithChannel()`：优先用 `TranslateAdapter`，找不到则降级到当前逻辑
5. 编译验证 + 本地冒烟测试（翻译功能）
6. **部署**

**产出**：
- `TranslateAdapter` 接口
- `OpenAiTranslateAdapter`、`AlibabaTranslateAdapter`

**风险**：⭐ 低（翻译功能独立）

---

### Phase 5：统一工厂 `AdapterFactory` + 清理旧代码

**目标**：用统一工厂替代 `ProviderAdapterFactory` 和 `ImageGenAdapterFactory`，删除旧适配器代码。

**步骤**：

1. 新建 `service/provider/core/AdapterFactory.java`（统一工厂，按「厂商 + 能力类型」路由）
2. 修改 `AiService` 中所有能力调用：统一通过 `AdapterFactory.getAdapter(provider, type)` 获取适配器
3. 标记旧工厂 `@Deprecated`，保留一个版本确保外部调用方有迁移时间
4. 编译验证 + 完整冒烟测试
5. **部署**

**产出**：
- 统一 `AdapterFactory`
- `AiService` 大幅瘦身（从 2700 行降至约 800 行）

**风险**：⭐⭐⭐ 中（涉及多个能力的调用方改动，需完整回归）

---

### Phase 6（可选）：目录结构最终整理

**目标**：将 `provider/` 下的 adapter 按「厂商/能力」组织，删除旧 `image/` 包和旧 `ProviderAdapter`。

**步骤**：

1. 将 `provider/OpenAiAdapter.java` 移至 `provider/openai/OpenAiTextAdapter.java`
2. 将 `provider/AlibabaAdapter.java` 移至 `provider/alibaba/AlibabaTextAdapter.java`
3. 将 `provider/AnthropicAdapter.java` 移至 `provider/anthropic/AnthropicTextAdapter.java`
4. 将 `provider/GoogleAdapter.java` 移至 `provider/google/GoogleTextAdapter.java`
5. 删除 `image/` 目录（已过 Deprecated 周期）
6. 删除旧 `ProviderAdapter.java`（已过 Deprecated 周期）
7. 编译验证 + 完整回归测试
8. **部署**

**风险**：⭐⭐ 低（纯文件移动 + 包名修改，IDE 重构工具可辅助）

---

## 四、执行顺序建议

```
Phase 1（TextAdapter 抽取）
   ↓
Phase 2（VoiceAdapter + TTS/ASR 迁移）← 当前最急需（ASR 硬编码问题）
   ↓
Phase 3（ImageAdapter 迁移）
   ↓
Phase 4（TranslateAdapter 新建）
   ↓
Phase 5（统一工厂 + AiService 瘦身）
   ↓
Phase 6（目录结构最终整理）
```

**推荐优先执行 Phase 1 + Phase 2**：解决当前 ASR 硬编码问题，让语音能力也有干净的适配器抽象。

---

## 五、兼容性保障

| 保障机制 | 说明 |
|---------|------|
| **接口继承** | `ProviderAdapter extends TextAdapter`，旧代码无需修改 |
| **降级逻辑** | AiService 先查新 Adapter，找不到则降级到旧实现 |
| **@Deprecated 周期** | 旧接口/类标记 Deprecated 后保留一个版本，给外部调用方迁移时间 |
| **每步编译验证** | 每完成一个 Phase 都执行 `mvn compile`，确保无语法错误 |
| **冒烟测试清单** | 每步部署前执行：对话/Chat + TTS 预览 + 上传音频转文字 + 图片生成 + 翻译 |
| **可回滚** | 每步都是一个独立 commit，出问题可 `git revert` 回到上一步 |

---

## 六、文件变更清单（按 Phase）

### Phase 1 变更

```
新增：service/provider/core/TextAdapter.java
修改：service/provider/ProviderAdapter.java（改为 implements TextAdapter）
```

### Phase 2 变更

```
新增：service/provider/core/VoiceAdapter.java
新增：service/provider/openai/OpenAiVoiceAdapter.java
新增：service/provider/alibaba/AlibabaVoiceAdapter.java
修改：service/AiService.java（TTS/ASR 入口优先用 VoiceAdapter）
```

### Phase 3 变更

```
新增：service/provider/core/ImageAdapter.java
新增：service/provider/alibaba/AlibabaImageAdapter.java
新增：service/provider/openai/OpenAiImageAdapter.java
修改：service/AiService.java（图片生成优先用新 ImageAdapter）
标记：service/image/ImageGenAdapter.java（@Deprecated）
```

### Phase 4 变更

```
新增：service/provider/core/TranslateAdapter.java
新增：service/provider/openai/OpenAiTranslateAdapter.java
新增：service/provider/alibaba/AlibabaTranslateAdapter.java
修改：service/AiService.java（翻译优先用 TranslateAdapter）
```

### Phase 5 变更

```
新增：service/provider/core/AdapterFactory.java
修改：service/AiService.java（统一通过 AdapterFactory 获取适配器）
标记：service/provider/ProviderAdapterFactory.java（@Deprecated）
标记：service/image/ImageGenAdapterFactory.java（@Deprecated）
```

### Phase 6 变更

```
删除：service/provider/OpenAiAdapter.java
删除：service/provider/AlibabaAdapter.java
删除：service/provider/AnthropicAdapter.java
删除：service/provider/GoogleAdapter.java
删除：service/image/ 目录
新增：provider/openai/OpenAiTextAdapter.java（从旧文件迁移）
新增：provider/alibaba/AlibabaTextAdapter.java（从旧文件迁移）
新增：provider/anthropic/AnthropicTextAdapter.java（从旧文件迁移）
新增：provider/google/GoogleTextAdapter.java（从旧文件迁移）
```

---

## 七、总结

| 维度 | 重构前 | 重构后 |
|------|--------|--------|
| **目录结构** | `provider/` + `image/` 两平行体系 | `provider/vendor/capability/` 统一体系 |
| **接口数量** | 2 个（`ProviderAdapter` + `ImageGenAdapter`） | 4 个（`TextAdapter` + `VoiceAdapter` + `ImageAdapter` + `TranslateAdapter`） |
| **工厂数量** | 2 个平行工厂 | 1 个统一工厂 |
| **AiService 行数** | ~2700 行 | ~800 行（编排层） |
| **新增能力** | 需改 AiService + 可能新建平行体系 | 只需在 `provider/vendor/` 下加实现 + 注册工厂 |
| **同一厂商代码** | 分散 3 处 | 集中在 `provider/vendor/` 一个目录 |
