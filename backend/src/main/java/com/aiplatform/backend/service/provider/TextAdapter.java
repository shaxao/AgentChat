package com.aiplatform.backend.service.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * 文本对话适配器接口 — 统一不同 AI 供应商的 Chat/Completion API 调用差异。
 * <p>
 * 这是 Provider 架构重构 Phase 1 新增的接口，从原 {@link ProviderAdapter} 中
 * 抽取所有文本对话（Chat/Completion + Streaming）相关方法，使职责更清晰。
 * <p>
 * 能力接口体系（重构目标）：
 * <ul>
 *   <li>{@link TextAdapter} — 文本对话（Chat/Completion + Streaming）</li>
 *   <li>{@link VoiceAdapter} — 语音（TTS + ASR）</li>
 *   <li>{@link ImageAdapter} — 图片生成，Phase 3</li>
 *   <li>{@link TranslateAdapter} — 翻译，Phase 4</li>
 * </ul>
 * <p>
 * 向后兼容：{@link ProviderAdapter} 继承本接口，现有代码无需修改即可编译运行。
 *
 * @see ProviderAdapter
 * @see VoiceAdapter
 */
public interface TextAdapter {

    // ===== Chat / Completion =====

    /**
     * 构建非流式 Chat 请求 URL
     *
     * @param baseUrl 渠道配置的 base_url
     * @param model   模型 ID（Google 需要拼入 URL）
     * @param apiKey  API Key（Google 需要拼入 URL 作为 query param）
     * @return 完整请求 URL
     */
    String chatUrl(String baseUrl, String model, String apiKey);

    /**
     * 构建流式 Chat 请求 URL
     * <p>
     * 默认与非流式相同，Google 等供应商需覆写为不同端点
     */
    default String streamUrl(String baseUrl, String model, String apiKey) {
        return chatUrl(baseUrl, model, apiKey);
    }

    /**
     * 构建认证头（附加到所有请求）
     *
     * @param apiKey 渠道 API Key
     * @return HTTP 头映射
     */
    Map<String, String> authHeaders(String apiKey);

    /**
     * 将标准 OpenAI 格式请求体转换为供应商原生格式。
     * 对 OpenAI 兼容供应商，直接返回原 body。
     *
     * @param canonicalBody OpenAI 格式请求体（含 model, messages, temperature, max_tokens, stream 等，
     *                      以及 _thinking / _thinking_budget 等 canonical 深度思考字段）
     * @param provider      供应商标识（如 "openai", "deepseek", "anthropic" 等），
     *                      用于适配器区分不同供应商的思考参数格式
     * @return 供应商原生格式请求体
     */
    ObjectNode transformRequest(ObjectNode canonicalBody, String provider);

    /**
     * 从非流式响应中提取回复文本
     */
    String extractContent(JsonNode response);

    /**
     * 从非流式响应中提取输入 token 数
     *
     * @param fallback 估算兜底值
     */
    int extractInputTokens(JsonNode response, int fallback);

    /**
     * 从非流式响应中提取输出 token 数
     *
     * @param fallback 估算兜底值
     */
    int extractOutputTokens(JsonNode response, int fallback);

    default int extractCachedInputTokens(JsonNode response) {
        return response.path("usage").path("prompt_tokens_details").path("cached_tokens").asInt(0);
    }

    /**
     * 将供应商原生响应归一化为 OpenAI 格式响应。
     * <p>
     * 对于 OpenAI 兼容供应商，直接返回原响应。
     * 对于 Anthropic/Google 等，转换 choices[0].message.content / tool_calls / usage 到 OpenAI 结构。
     * 这样所有下游代码（Agent 模式、Vision 等）无需感知供应商差异。
     * <p>
     * 默认实现返回原响应（OpenAI 兼容）。
     *
     * @param response 供应商原生响应 JSON
     * @return OpenAI 格式响应 JSON
     */
    default JsonNode normalizeResponse(JsonNode response) {
        return response;
    }

    // ===== Streaming =====

    /**
     * 解析 SSE 流的一行，返回增量文本。
     * <p>
     * 适配器负责跟踪自身状态（如 Anthropic 的 event 类型），
     * 通过 {@link StreamContext} 在行间传递。
     *
     * @param line 原始 SSE 行（不含换行符）
     * @param ctx  流上下文（跨行状态）
     * @return 增量文本，或 null 表示该行不产生文本（如 event 行、心跳行等）
     */
    String parseStreamLine(String line, StreamContext ctx);

    /**
     * 检查流是否已结束
     */
    boolean isStreamDone(StreamContext ctx);

    /**
     * 从流上下文中获取 token 用量
     *
     * @return [inputTokens, outputTokens, cachedInputTokens]，未获取到返回 null
     */
    int[] getStreamUsage(StreamContext ctx);

    // ===== Stream Context =====

    /**
     * 流式解析上下文，在逐行解析中跨行传递状态
     */
    class StreamContext {
        /** Anthropic 当前事件类型 */
        public String eventType;
        /** 流是否已结束 */
        public boolean done;
        /** 输入 token 数（从流中提取） */
        public int inputTokens;
        /** 输出 token 数（从流中提取） */
        public int outputTokens;
        /** 缓存输入 token 数（从流中提取） */
        public int cachedInputTokens;
        /** 是否已获取到 usage */
        public boolean hasUsage;
        /** 深度思考/推理内容（从流中累积） */
        public final StringBuilder thinkingBuilder = new StringBuilder();
        /** finish_reason（从最后一个 chunk 获取，如 "stop"/"tool_calls"） */
        public String finishReason;
        /** 流式累积的 tool_calls（Agent 模式流式调用时按 index 累积） */
        public final java.util.List<StreamToolCall> toolCallsBuilder = new java.util.ArrayList<>();
    }

    /**
     * 流式 tool_call 累积器 — 在 SSE 流中逐 chunk 累积 tool_calls。
     * <p>
     * OpenAI 兼容流式格式中，tool_calls 分片返回：
     * <ul>
     *   <li>首个 chunk：包含 index, id, type, function.name</li>
     *   <li>后续 chunks：仅包含 index + function.arguments 增量</li>
     * </ul>
     * 每个 tool_call 通过 index 关联，arguments 需要拼接。
     */
    class StreamToolCall {
        /** 工具调用序号（用于匹配分片） */
        public int index;
        /** 工具调用 ID（首个 chunk 包含） */
        public String id;
        /** 调用类型，固定为 "function" */
        public String type;
        /** 函数名（首个 chunk 包含） */
        public String functionName;
        /** 函数参数 JSON（增量拼接） */
        public final StringBuilder arguments = new StringBuilder();
    }

    // ===== Thinking / Reasoning =====

    /**
     * 从 StreamContext 获取累积的思考内容。
     * <p>
     * 默认返回 null。适配器需在 {@link #parseStreamLine} 中向 ctx.thinkingBuilder 追加内容，
     * 然后由 AiService 在流结束后调用此方法获取完整思考内容。
     */
    default String getThinkingContent(StreamContext ctx) {
        return ctx.thinkingBuilder.length() > 0 ? ctx.thinkingBuilder.toString() : null;
    }

    /**
     * 从非流式响应中提取思考/推理内容。
     * <p>
     * 用于 Agent 模式（非流式调用）。默认返回 null。
     *
     * @param response 供应商原生响应 JSON
     * @return 思考内容文本，无可提取时返回 null
     */
    default String extractThinkingContent(JsonNode response) {
        return null;
    }
}
