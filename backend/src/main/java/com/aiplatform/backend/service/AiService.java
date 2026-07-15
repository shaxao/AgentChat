package com.aiplatform.backend.service;

import com.aiplatform.backend.agent.AgentConfig;
import com.aiplatform.backend.agent.AgentSessionContext;
import com.aiplatform.backend.agent.ToolCallRecord;
import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.agent.ToolExecutor;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.service.provider.AdapterFactory;
import com.aiplatform.backend.service.provider.ProviderAdapter;
import com.aiplatform.backend.service.provider.ProviderAdapterFactory;
import com.aiplatform.backend.service.provider.SearchAdapter;
import com.aiplatform.backend.service.provider.SearchAdapterFactory;
import com.aiplatform.backend.service.provider.VoiceAdapter;
import com.aiplatform.backend.service.provider.VoiceAdapterFactory;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

@Slf4j
@Service
@RequiredArgsConstructor
public class AiService {

    private final ModelChannelMapper channelMapper;
    private final ModelConfigMapper modelConfigMapper;
    private final ObjectMapper objectMapper;
    private final ModelRoutingService modelRoutingService;
    private final ThreadLocal<Consumer<String>> thinkingTokenConsumer = new ThreadLocal<>();
    private final ThreadLocal<UsedChannel> usedChannelHolder = new ThreadLocal<>();
    private final ThreadLocal<String> promptCacheKeyHolder = new ThreadLocal<>();

    public void setThinkingTokenConsumer(Consumer<String> consumer) {
        if (consumer == null) {
            thinkingTokenConsumer.remove();
        } else {
            thinkingTokenConsumer.set(consumer);
        }
    }

    public void clearThinkingTokenConsumer() {
        thinkingTokenConsumer.remove();
    }

    public UsedChannel getCurrentUsedChannel() {
        return usedChannelHolder.get();
    }

    public void clearCurrentUsedChannel() {
        usedChannelHolder.remove();
    }

    public void setPromptCacheKey(String promptCacheKey) {
        if (promptCacheKey == null || promptCacheKey.isBlank()) {
            promptCacheKeyHolder.remove();
        } else {
            promptCacheKeyHolder.set(promptCacheKey);
        }
    }

    public void clearPromptCacheKey() {
        promptCacheKeyHolder.remove();
    }

    /**
     * 渠道级令牌桶限流器映射
     * key = channelId，value = 令牌桶
     * 令牌桶算法：每分钟填充 rateLimit 个令牌，每次请求消耗 1 个令牌
     */
    private final ConcurrentHashMap<Long, TokenBucket> rateLimiterMap = new ConcurrentHashMap<>();

    /**
     * 从 ModelConfig 中解析有效的 max_tokens。
     * 优先使用调用方显式传入的值；若为 null，查 model_config 表的 contextLength。
     * 上下文长度的 80% 作为 max_tokens（预留 20% 给输入），最小 8192。
     */
    private int resolveEffectiveMaxTokens(String model, Integer requestedMax) {
        if (requestedMax != null && requestedMax > 0) return requestedMax;
        try {
            ModelConfig config = modelConfigMapper.selectOne(
                    new QueryWrapper<ModelConfig>().eq("model_id", model).eq("deleted", 0));
            if (config != null && config.getContextLength() != null && config.getContextLength() > 0) {
                int resolved = (int) (config.getContextLength() * 0.8);
                log.debug("[MaxTokens] 模型 {} 上下文长度={} → max_tokens={}", model, config.getContextLength(), resolved);
                return Math.max(resolved, 8192);
            }
        } catch (Exception e) {
            log.warn("[MaxTokens] 查询 ModelConfig 失败: model={}, error={}", model, e.getMessage());
        }
        return 8192; // fallback
    }

    /**
     * 将项目内置格式规范附加到 system prompt 尾部。
     * 对所有模型调用生效，不影响调用方传入的原始 prompt。
     */
    private String enhanceSystemPrompt(String basePrompt) {
        if (basePrompt == null || basePrompt.isBlank()) return basePrompt;
        return basePrompt + SYSTEM_PROMPT_FORMAT_RULES;
    }

    /**
     * ReAct 循环中工具参数最大保留长度（用于 LLM 上下文历史）。
     * 超过此长度的参数被截断为摘要，防止 1M+ 的 code_content 在消息历史中
     * 不断膨胀导致 OOM。截断不影响工具执行——执行时仍使用完整参数。
     */
    private static final int MAX_TOOL_ARG_IN_HISTORY = 2000;

    /**
     * ReAct 循环中工具结果最大保留长度（用于 LLM 上下文历史）。
     * 前端通过 SSE 独立截断，此处是针对发送给 LLM 的上下文。
     */
    private static final int MAX_TOOL_RESULT_IN_HISTORY = 8000;

    /**
     * 项目内置回复格式规范，自动附加到每次模型调用的 system prompt 尾部。
     * 确保所有模型输出遵循统一的格式和视觉表达标准。
     */
    private static final String SYSTEM_PROMPT_FORMAT_RULES = """
            
            ---
            # 回复格式规范
            - 标题从 ## 起，子层级用 ###；禁用 #。
            - 使用简体中文。
            - 保持高信息密度，回复紧凑不松散，避免阅读疲劳。
            - 代码块标注语言，优先完整可运行，复杂逻辑加注释。
            
            # HTML 可视化
            当纯 Markdown 无法清晰紧凑表达复杂结构时，主动使用内联 HTML 片段。禁止使用 <style> 标签和 class 属性，100% 纯内联样式（style="..."）。默认黑白灰为主色调，用线条和留白建立层次，突出处控制使用高级色彩。必须用 HTML 的场景：流程图/架构图/树状层级、横向对比排版、信息卡片、折叠收拢长内容。Vision+ 模式下可绘制矢量图和图表，但禁止装饰性插画。仅输出自包含片段（div 等），自然穿插 Markdown 文本间，禁止 DOCTYPE/html/head/body 全量页面框架。
            ---""";

    /**
     * 简单令牌桶实现（无外部依赖）
     * 按 rateLimit（req/min）配置；每次 tryAcquire() 非阻塞，返回 false 表示超限
     */
    static class TokenBucket {
        private final int maxTokens;           // 令牌桶容量 = rateLimit（每分钟）
        private final long refillIntervalMs;   // 每个令牌的补充间隔（ms）
        private final AtomicLong tokens;
        private volatile long lastRefillTime;

        TokenBucket(int ratePerMinute) {
            this.maxTokens = ratePerMinute;
            this.refillIntervalMs = 60_000L / Math.max(ratePerMinute, 1); // 均匀分配到每毫秒
            this.tokens = new AtomicLong(ratePerMinute);
            this.lastRefillTime = System.currentTimeMillis();
        }

        synchronized boolean tryAcquire() {
            refill();
            long current = tokens.get();
            if (current > 0) {
                tokens.decrementAndGet();
                return true;
            }
            return false;
        }

        /** 根据时间流逝补充令牌 */
        private void refill() {
            long now = System.currentTimeMillis();
            long elapsed = now - lastRefillTime;
            if (elapsed >= refillIntervalMs) {
                long tokensToAdd = elapsed / refillIntervalMs;
                long newTokens = Math.min(maxTokens, tokens.get() + tokensToAdd);
                tokens.set(newTokens);
                lastRefillTime = now - (elapsed % refillIntervalMs);
            }
        }

        /** 离下次令牌刷新还有多少毫秒（用于提示用户等待时间） */
        long millisUntilNextToken() {
            long elapsed = System.currentTimeMillis() - lastRefillTime;
            return Math.max(0, refillIntervalMs - elapsed);
        }
    }

    @Value("${app.ai.default-api-key:}")
    private String defaultApiKey;

    @Value("${app.ai.default-base-url:https://api.openai.com/v1}")
    private String defaultBaseUrl;

    @Value("${app.ai.default-model:deepseek-v4-pro}")
    private String defaultModel;

    @Value("${app.ai.timeout:120}")
    private int timeoutSeconds;

    /**
     * 流式调用 AI，每收到一个 token 就回调 onToken，结束后回调 onDone
     *
     * @param model        模型 ID
     * @param systemPrompt 系统提示词
     * @param history      历史消息列表，每条含 role/content，按时间正序
     * @param userMessage  当前用户消息
     * @param temperature  温度
     * @param maxTokens    最大 token
     * @param onToken      每个 token 的回调，参数为 delta 文本
     * @param onDone       完成回调，参数为 (完整内容, inputTokens, outputTokens, latencyMs)
     */
    public void streamChat(String model, String systemPrompt,
                           List<Map<String, String>> history,
                           String userMessage,
                           Double temperature, Integer maxTokens,
                           Consumer<String> onToken,
                           StreamDoneCallback onDone) {
        streamChat(model, systemPrompt, history, userMessage, null, temperature, maxTokens, null, null, onToken, onDone);
    }

    public void streamChat(String model, String systemPrompt,
                           List<Map<String, String>> history,
                           String userMessage,
                           List<String> imageUrls,
                           Double temperature, Integer maxTokens,
                           Boolean thinking, Integer thinkingBudget,
                           Consumer<String> onToken,
                           Consumer<String> onThinking,
                           StreamDoneCallback onDone) {
        streamChat(model, systemPrompt, history, userMessage, imageUrls, temperature, maxTokens, thinking, thinkingBudget, onToken, onDone);
    }

    public void streamChat(String model, String systemPrompt,
                           List<Map<String, String>> history,
                           String userMessage,
                           Double temperature, Integer maxTokens,
                           Boolean thinking, Integer thinkingBudget,
                           Consumer<String> onToken,
                           StreamDoneCallback onDone) {
        streamChat(model, systemPrompt, history, userMessage, null, temperature, maxTokens, thinking, thinkingBudget, onToken, onDone);
    }

    /** 支持 Vision 图片的流式聊天 */
    public void streamChat(String model, String systemPrompt,
                           List<Map<String, String>> history,
                           String userMessage,
                           List<String> imageUrls,
                           Double temperature, Integer maxTokens,
                           Consumer<String> onToken,
                           StreamDoneCallback onDone) {
        streamChat(model, systemPrompt, history, userMessage, imageUrls, temperature, maxTokens, null, null, onToken, onDone);
    }

    /** 支持 Vision 图片 + 深度思考的流式聊天 */
    public void streamChat(String model, String systemPrompt,
                           List<Map<String, String>> history,
                           String userMessage,
                           List<String> imageUrls,
                           Double temperature, Integer maxTokens,
                           Boolean thinking, Integer thinkingBudget,
                           Consumer<String> onToken,
                           StreamDoneCallback onDone) {

        // ===== 多渠道降级重试：获取所有可用渠道候选列表 =====
        List<ChannelConfig> candidates = resolveAllChannels(model, "chat");
        if (candidates.isEmpty()) {
            throw new RuntimeException("无可用的 AI 渠道，请检查渠道配置");
        }

        // 用户未显式传 maxTokens → 从 ModelConfig.contextLength 动态计算
        int effectiveMaxTokens = resolveEffectiveMaxTokens(model, maxTokens);

        Exception lastEx = null;
        for (int attempt = 0; attempt < candidates.size(); attempt++) {
            ChannelConfig channel = candidates.get(attempt);
            String actualModel = channel.model;
            log.info("[AiService] 流式请求 尝试 {}/{}, 渠道={}, 模型={}", attempt + 1, candidates.size(),
                    channel.channelId != null ? channel.channelId : "default", actualModel);

            try {
                // 执行单次流式请求
                StreamResult result = doStreamRequest(channel, actualModel, systemPrompt, history,
                        userMessage, imageUrls, temperature, effectiveMaxTokens, thinking, thinkingBudget, onToken);
                usedChannelHolder.set(new UsedChannel(channel.channelId, channel.provider));

                // ===== 自动续写：finish_reason="length" 时追加续写请求，最多 3 轮 =====
                StringBuilder totalContent = new StringBuilder(result.fullContent());
                int totalInput = result.inputTokens();
                int totalOutput = result.outputTokens();
                int totalCached = result.cachedInputTokens();
                int totalLatency = result.latencyMs();
                String finishReason = result.finishReason();
                int continuationsLeft = 3;

                while ("length".equals(finishReason) && continuationsLeft > 0 && totalContent.length() > 0) {
                    continuationsLeft--;
                    log.info("[AiService] finish_reason=length → 自动续写 (剩余{}次), 已生成{}字符",
                            continuationsLeft, totalContent.length());

                    // 构建续写历史：原始历史 + 原始用户消息 + 已生成的助手回复
                    List<Map<String, String>> contHistory = new ArrayList<>();
                    if (history != null) contHistory.addAll(history);
                    Map<String, String> origUser = new HashMap<>();
                    origUser.put("role", "user");
                    origUser.put("content", userMessage != null ? userMessage : "");
                    contHistory.add(origUser);
                    Map<String, String> partialAssistant = new HashMap<>();
                    partialAssistant.put("role", "assistant");
                    partialAssistant.put("content", totalContent.toString());
                    contHistory.add(partialAssistant);

                    // 续写请求（不传图片，避免重复上传）
                    StreamResult contResult = doStreamRequest(channel, actualModel, systemPrompt,
                            contHistory, "继续", null, temperature, effectiveMaxTokens, thinking, thinkingBudget, onToken);

                    totalContent.append(contResult.fullContent());
                    totalInput += contResult.inputTokens();
                    totalOutput += contResult.outputTokens();
                    totalCached += contResult.cachedInputTokens();
                    totalLatency += contResult.latencyMs();
                    finishReason = contResult.finishReason();
                }

                if (totalContent.length() > result.fullContent().length()) {
                    log.info("[AiService] 自动续写完成: 总长{}字符(续写{}), finishReason={}, 轮次={}",
                            totalContent.length(), totalContent.length() - result.fullContent().length(),
                            finishReason, 3 - continuationsLeft);
                }

                // 成功！回调 done（传合并后的总量）
                String finalContent = totalContent.toString();
                onDone.accept(finalContent, totalInput, totalOutput, totalCached,
                        totalLatency, result.usedModel, result.thinkingContent);
                return;

            } catch (Exception e) {
                lastEx = e;
                String errMsg = e.getMessage() != null ? e.getMessage() : "";

                // 判断是否为可重试错误（HTTP 5xx / 429 / 409 / 402 等）
                boolean retriable = false;
                int statusCode = extractStatusCode(errMsg);
                if (statusCode > 0 && isRetriableStatusCode(statusCode)) {
                    retriable = true;
                }
                // 也处理包含"负载较高""过载""限流""rate limit"等关键词的错误
                if (!retriable && (errMsg.contains("负载") || errMsg.contains("过载")
                        || errMsg.contains("限流") || errMsg.toLowerCase().contains("rate limit")
                        || errMsg.contains("busy") || errMsg.contains("overloaded")
                        || errMsg.contains("当前模型"))) {
                    retriable = true;
                }

                if (retriable && attempt < candidates.size() - 1) {
                    // 还有其他渠道可用 → 禁用当前渠道，尝试下一个
                    log.warn("[AiService] 渠道 {} 返回可恢复错误({})，自动切换到下一个渠道。错误: {}",
                            channel.channelId != null ? channel.channelId : "default", statusCode > 0 ? statusCode : "unknown", errMsg);
                    if (channel.channelId != null) {
                        disableChannel(channel.channelId, "降级切换: HTTP " + (statusCode > 0 ? statusCode : "retryable") + " - " + errMsg);
                    }
                    continue; // 重试下一个
                }

                // 不可重试的错误，或已经是最后一个渠道了 → 抛出
                break;
            }
        }

        // 所有渠道都失败
        log.error("[AiService] 所有 {} 个渠道均失败，最后错误: {}", candidates.size(),
                lastEx != null ? lastEx.getMessage() : "unknown");
        if (lastEx instanceof RuntimeException) {
            throw (RuntimeException) lastEx;
        }
        throw new RuntimeException("AI 服务暂时不可用: 所有渠道均返回错误", lastEx);
    }

    /**
     * 单次流式请求的核心实现（无降级逻辑）
     */
    private StreamResult doStreamRequest(ChannelConfig channel, String actualModel,
                                          String systemPrompt, List<Map<String, String>> history,
                                          String userMessage, List<String> imageUrls,
                                          Double temperature, Integer maxTokens,
                                          Boolean thinking, Integer thinkingBudget,
                                          Consumer<String> onToken) {
        if (actualModel == null) {
            throw new RuntimeException("无法确定调用模型，请检查渠道配置");
        }

        // 通过适配器处理供应商差异
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        ObjectNode body = buildRequestBody(actualModel, systemPrompt, history, userMessage, imageUrls, temperature, maxTokens, true, thinking, thinkingBudget);
        body = adapter.transformRequest(body, channel.provider);
        String url = adapter.streamUrl(channel.baseUrl, actualModel, channel.apiKey);

        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(30))
                    .build();

            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(timeoutSeconds))
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream")
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            // 添加适配器认证头
            adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
            HttpRequest request = reqBuilder.build();

            long start = System.currentTimeMillis();
            StringBuilder fullContent = new StringBuilder();

            // 使用 InputStream 流式读取
            HttpResponse<java.io.InputStream> response = client.send(request,
                    HttpResponse.BodyHandlers.ofInputStream());

            if (response.statusCode() != 200) {
                String errBody = new String(response.body().readAllBytes());
                throw new RuntimeException("AI 服务返回错误: HTTP " + response.statusCode()
                        + " - " + extractErrorMessage(errBody));
            }

            // 使用适配器解析 SSE 流
            ProviderAdapter.StreamContext ctx = new ProviderAdapter.StreamContext();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (adapter.isStreamDone(ctx)) break;
                    int thinkingLenBefore = ctx.thinkingBuilder.length();
                    String tokenText = adapter.parseStreamLine(line, ctx);
                    emitThinkingDelta(ctx, thinkingLenBefore);
                    if (tokenText != null && !tokenText.isEmpty()) {
                        fullContent.append(tokenText);
                        onToken.accept(tokenText);
                    }
                }
            }

            int latency = (int) (System.currentTimeMillis() - start);
            int[] tokenCounts = {0, 0, 0};
            int[] usage = adapter.getStreamUsage(ctx);
            if (usage != null) {
                tokenCounts[0] = usage.length > 0 ? usage[0] : 0;
                tokenCounts[1] = usage.length > 1 ? usage[1] : 0;
                tokenCounts[2] = usage.length > 2 ? usage[2] : 0;
            }
            // outputTokens 估算（部分模型不返回 usage，用内容长度估算）
            if (tokenCounts[1] == 0 && fullContent.length() > 0) {
                tokenCounts[1] = Math.max(1, fullContent.length() / 3);
            }
            if (tokenCounts[0] == 0 && userMessage != null) {
                tokenCounts[0] = Math.max(1, userMessage.length() / 3);
            }

            // 提取深度思考内容
            String thinkingContent = adapter.getThinkingContent(ctx);

            return new StreamResult(fullContent.toString(), tokenCounts[0], tokenCounts[1], tokenCounts[2],
                    latency, actualModel, thinkingContent, ctx.finishReason);

        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            log.error("流式 AI 调用失败: {}", e.getMessage(), e);
            throw new RuntimeException("AI 服务暂时不可用: " + e.getMessage());
        }
    }

    /**
     * 非流式调用（保留，供内部使用）- 带多渠道降级重试
     */
    public AiResult chat(String model, String systemPrompt,
                         List<Map<String, String>> history,
                         String userMessage,
                         Double temperature, Integer maxTokens) {
        return chat(model, systemPrompt, history, userMessage, temperature, maxTokens, null, null);
    }

    public AiResult chat(String model, String systemPrompt,
                         List<Map<String, String>> history,
                         String userMessage,
                         Double temperature, Integer maxTokens,
                         Boolean thinking, Integer thinkingBudget) {

        // ===== 多渠道降级重试 =====
        List<ChannelConfig> candidates = resolveAllChannels(model, "chat");
        if (candidates.isEmpty()) {
            throw new RuntimeException("无可用的 AI 渠道，请检查渠道配置");
        }

        Exception lastEx = null;
        for (int attempt = 0; attempt < candidates.size(); attempt++) {
            ChannelConfig channel = candidates.get(attempt);
            String actualModel = channel.model;

            log.info("[AiService] 非流式请求 尝试 {}/{}, 渠道={}, 模型={}", attempt + 1, candidates.size(),
                    channel.channelId != null ? channel.channelId : "default", actualModel);

            try {
                return doChatRequest(channel, actualModel, systemPrompt, history, userMessage, temperature, maxTokens, thinking, thinkingBudget);

            } catch (RuntimeException e) {
                lastEx = e;
                String errMsg = e.getMessage() != null ? e.getMessage() : "";

                // 判断是否为可重试错误
                boolean retriable = false;
                int statusCode = extractStatusCode(errMsg);
                if (statusCode > 0 && isRetriableStatusCode(statusCode)) {
                    retriable = true;
                }
                if (!retriable && (errMsg.contains("负载") || errMsg.contains("过载")
                        || errMsg.contains("限流") || errMsg.toLowerCase().contains("rate limit")
                        || errMsg.contains("busy") || errMsg.contains("overloaded")
                        || errMsg.contains("当前模型"))) {
                    retriable = true;
                }

                if (retriable && attempt < candidates.size() - 1) {
                    log.warn("[AiService] 非流式渠道 {} 返回可恢复错误({})，自动切换。错误: {}",
                            channel.channelId != null ? channel.channelId : "default", statusCode > 0 ? statusCode : "unknown", errMsg);
                    if (channel.channelId != null) {
                        disableChannel(channel.channelId, "降级切换: HTTP " + (statusCode > 0 ? statusCode : "retryable") + " - " + errMsg);
                    }
                    continue;
                }
                break;
            }
        }

        log.error("[AiService] 所有 {} 个渠道均失败(非流式)，最后错误: {}", candidates.size(),
                lastEx != null ? lastEx.getMessage() : "unknown");
        if (lastEx instanceof RuntimeException) {
            throw (RuntimeException) lastEx;
        }
        throw new RuntimeException("AI 服务暂时不可用: 所有渠道均返回错误", lastEx);
    }

    /**
     * 单次非流式请求核心实现（无降级逻辑）
     */
    private AiResult doChatRequest(ChannelConfig channel, String actualModel,
                                   String systemPrompt, List<Map<String, String>> history,
                                   String userMessage, Double temperature, Integer maxTokens,
                                   Boolean thinking, Integer thinkingBudget) {
        if (actualModel == null) {
            throw new RuntimeException("无法确定调用模型，请检查渠道配置");
        }

        // 通过适配器处理供应商差异
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        ObjectNode body = buildRequestBody(actualModel, systemPrompt, history, userMessage, temperature, maxTokens, false, thinking, thinkingBudget);
        body = adapter.transformRequest(body, channel.provider);
        String url = adapter.chatUrl(channel.baseUrl, actualModel, channel.apiKey);

        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(30))
                    .build();

            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(timeoutSeconds))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
            HttpRequest request = reqBuilder.build();

            long start = System.currentTimeMillis();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            int latency = (int) (System.currentTimeMillis() - start);

            if (response.statusCode() != 200) {
                String errMsg = extractErrorMessage(response.body());
                log.error("[AiService] chat() HTTP {} - {} (model={})", response.statusCode(), errMsg, actualModel);

                // 🔧 渠道自动禁用：401/403 表示 API Key 无效或权限不足
                if ((response.statusCode() == 401 || response.statusCode() == 403) && channel.channelId != null) {
                    disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                }
                // 🔧 渠道自动禁用：5xx 服务端故障
                if (response.statusCode() >= 500 && response.statusCode() < 600 && channel.channelId != null) {
                    disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                }

                throw new RuntimeException("AI 服务返回错误: HTTP " + response.statusCode()
                        + " - " + errMsg);
            }

            JsonNode resp = objectMapper.readTree(response.body());
            // 通过适配器解析响应
            String content = adapter.extractContent(resp);
            int inputTokens = adapter.extractInputTokens(resp, userMessage != null ? Math.max(1, userMessage.length() / 3) : 1);
            int outputTokens = adapter.extractOutputTokens(resp, content.length() > 0 ? Math.max(1, content.length() / 3) : 1);
            int cachedInputTokens = adapter.extractCachedInputTokens(resp);
            String thinkingContent = adapter.extractThinkingContent(resp);

            return new AiResult(content, inputTokens, outputTokens, latency, actualModel, thinkingContent, cachedInputTokens);

        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            log.error("调用 AI API 失败: {}", e.getMessage(), e);
            throw new RuntimeException("AI 服务暂时不可用: " + e.getMessage());
        }
    }

    /**
     * 按模型优先级依次尝试非流式调用，任一成功即返回。
     * 用于记忆摘要等后台任务，优先使用高质量模型。
     *
     * @param modelPriority 模型优先级列表（如 ["gpt-oss-120b", "gpt-oss-20b"]）
     * @param systemPrompt  系统提示词
     * @param userMessage   用户消息
     * @param temperature   温度（默认 0.3）
     * @param maxTokens     最大 token（默认 512）
     * @return 第一个成功调用的结果
     */
    public AiResult chatWithFallback(List<String> modelPriority, String systemPrompt,
                                     String userMessage, Double temperature, Integer maxTokens) {
        if (temperature == null) temperature = 0.3;
        if (maxTokens == null) maxTokens = 512;

        if (modelPriority != null) {
            Exception lastEx = null;
            for (String model : modelPriority) {
                if (model == null || model.isBlank()) continue;
                try {
                    AiResult result = chat(model, systemPrompt, null, userMessage, temperature, maxTokens);
                    if (result != null && result.content() != null && !result.content().isBlank()) {
                        log.info("[AiService] 记忆摘要使用模型: {}", model);
                        return result;
                    }
                } catch (Exception e) {
                    log.warn("[AiService] 模型 {} 调用失败，尝试下一个: {}", model, e.getMessage());
                    lastEx = e;
                }
            }
            if (lastEx != null) {
                log.warn("[AiService] 所有优先模型均失败，降级为默认模型。最后错误: {}", lastEx.getMessage());
            }
        }

        // 所有优先模型都失败，或没有指定优先模型 → 使用默认模型
        return chat(null, systemPrompt, null, userMessage, temperature, maxTokens);
    }

    /**
     * Internal non-streaming chat completion for AutoCode.
     * Reuses Java chat channel routing, provider adapters and fallback, but
     * returns OpenAI-compatible JSON without executing tools in Java.
     */
    public JsonNode chatCompletionRaw(String model, String systemPrompt,
                                      List<Map<String, Object>> messages,
                                      Double temperature, Integer maxTokens,
                                      List<ToolDefinition> tools,
                                      Boolean thinking, Integer thinkingBudget) {
        List<ChannelConfig> candidates = resolveAllChannels(model, "chat");
        if (candidates.isEmpty()) {
            throw new RuntimeException("无可用的 AI 渠道，请检查渠道配置");
        }

        Exception lastEx = null;
        for (int attempt = 0; attempt < candidates.size(); attempt++) {
            ChannelConfig channel = candidates.get(attempt);
            String actualModel = channel.model;
            try {
                ObjectNode body = buildRequestBodyWithTools(
                        actualModel, systemPrompt, messages,
                        temperature, maxTokens, tools, thinking, thinkingBudget);
                body.put("stream", false);
                body.remove("stream_options");

                JsonNode response = callLlmApi(channel, body, timeoutSeconds);
                JsonNode choice = response.path("choices").path(0);
                JsonNode message = choice.path("message");
                String content = message.path("content").asText("");
                JsonNode toolCalls = message.path("tool_calls");
                boolean hasToolCalls = toolCalls.isArray() && !toolCalls.isEmpty();
                if (!content.isBlank() || hasToolCalls) {
                    return response;
                }
                throw new RuntimeException("AI 服务返回空消息: model=" + actualModel
                        + ", finish=" + choice.path("finish_reason").asText(""));
            } catch (Exception e) {
                lastEx = e;
                String errMsg = e.getMessage() != null ? e.getMessage() : "";
                int statusCode = extractStatusCode(errMsg);
                boolean retriable = statusCode <= 0 || isRetriableStatusCode(statusCode)
                        || errMsg.contains("空消息")
                        || errMsg.toLowerCase().contains("empty")
                        || errMsg.toLowerCase().contains("rate limit")
                        || errMsg.toLowerCase().contains("busy")
                        || errMsg.toLowerCase().contains("overloaded");
                if (retriable && attempt < candidates.size() - 1) {
                    log.warn("[AiService] AutoCode internal completion failed on model={}, channel={}, retrying next. error={}",
                            actualModel, channel.channelId, errMsg);
                    continue;
                }
                break;
            }
        }

        if (lastEx instanceof RuntimeException) {
            throw (RuntimeException) lastEx;
        }
        throw new RuntimeException("AI 服务暂时不可用: AutoCode internal completion failed", lastEx);
    }

    /**
     * Vision 路由：使用 vision 模型描述图片，返回纯文本描述。
     * 用于非 vision 模型（如纯 tool 模型）接收图片时，委托 vision 模型识别后再传给当前模型。
     *
     * @param model        vision 模型名称
     * @param prompt       描述提示词（如 "请详细描述以下图片的内容"）
     * @param imageUrls    图片 URL 列表（OSS URL 或 base64 data URL）
     * @return 图片的文字描述
     */
    public AiResult describeImages(String model, String prompt, List<String> imageUrls) {
        ChannelConfig channel = resolveChannel(model);
        // 使用渠道配置的真实模型名（channel.model），而非 model_id
        String actualModel = (channel != null && channel.model != null && !channel.model.isBlank())
                ? channel.model
                : (model != null && !model.isBlank() ? model : null);
        if (actualModel == null) {
            throw new RuntimeException("无法确定调用模型，请检查渠道配置");
        }

        // 通过适配器处理供应商差异
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        // 使用 Vision 格式的请求体
        ObjectNode body = buildRequestBody(actualModel, null, null, prompt, imageUrls, 0.3, 1024, false);
        body = adapter.transformRequest(body, channel.provider);
        String url = adapter.chatUrl(channel.baseUrl, actualModel, channel.apiKey);

        try {
            HttpClient client = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(30))
                    .build();

            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(timeoutSeconds))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
            HttpRequest request = reqBuilder.build();

            long start = System.currentTimeMillis();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
            int latency = (int) (System.currentTimeMillis() - start);

            if (response.statusCode() != 200) {
                String errMsg = extractErrorMessage(response.body());
                log.warn("[AiService] describeImages HTTP {} - {} (model={})", response.statusCode(), errMsg, actualModel);
                throw new RuntimeException("Vision 模型调用失败: HTTP " + response.statusCode() + " - " + errMsg);
            }

            JsonNode resp = objectMapper.readTree(response.body());
            // 通过适配器解析响应
            String content = adapter.extractContent(resp);
            int inputTokens = adapter.extractInputTokens(resp, 0);
            int outputTokens = adapter.extractOutputTokens(resp, 0);

            log.info("[AiService] describeImages 成功: model={}, latency={}ms, tokens={}/{}",
                    actualModel, latency, inputTokens, outputTokens);
            return new AiResult(content, inputTokens, outputTokens, latency, actualModel, null);

        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            log.error("[AiService] describeImages 失败: {}", e.getMessage(), e);
            throw new RuntimeException("Vision 模型暂时不可用: " + e.getMessage());
        }
    }

    // ==================== Agent 模式：Tool Calling 支持 ====================

    /**
     * Agent 模式流式调用：支持 OpenAI Function Calling 的 ReAct 循环
     * <p>
     * 工作流程：
     * 1. 调用 LLM（非流式，因为需要完整解析 tool_calls）
     * 2. 如果 LLM 返回 tool_calls → 执行工具 → 将结果返回 LLM → 重复
     * 3. 如果 LLM 直接返回文本 → 推送给前端 → 结束
     * <p>
     * 关键设计：循环内部非流式，但文本内容通过 onToken 模拟流式推送给前端
     *
     * @param model         模型 ID
     * @param systemPrompt  系统提示词
     * @param messages      消息列表（支持 user/assistant/tool 等 role），按时间正序
     * @param temperature   温度
     * @param maxTokens     最大 token
     * @param tools         可调用的工具列表
     * @param toolExecutor  工具执行器
     * @param onToken       文本内容回调
     * @param onToolCall    工具调用开始回调
     * @param onToolResult  工具执行完成回调
     * @param onDone        完成回调
     */
    public void streamChatWithTools(String model, String systemPrompt,
                                    List<Map<String, Object>> messages,
                                    Double temperature, Integer maxTokens,
                                    List<ToolDefinition> tools,
                                    ToolExecutor toolExecutor,
                                    Consumer<String> onToken,
                                    Consumer<ToolCallRecord> onToolCall,
                                    Consumer<ToolCallRecord> onToolResult,
                                    StreamDoneCallback onDone,
                                    Boolean thinking, Integer thinkingBudget) {

        this.streamChatWithTools(model, systemPrompt, messages, temperature, maxTokens,
                tools, toolExecutor, onToken, onToolCall, onToolResult, onDone, null,
                thinking, thinkingBudget);
    }

    /**
     * Agent 模式流式调用（支持 sessionId）
     */
    public void streamChatWithTools(String model, String systemPrompt,
                                    List<Map<String, Object>> messages,
                                    Double temperature, Integer maxTokens,
                                    List<ToolDefinition> tools,
                                    ToolExecutor toolExecutor,
                                    Consumer<String> onToken,
                                    Consumer<ToolCallRecord> onToolCall,
                                    Consumer<ToolCallRecord> onToolResult,
                                    StreamDoneCallback onDone,
                                    String sessionId,
                                    Boolean thinking, Integer thinkingBudget) {

        ChannelConfig channel = resolveChannel(model);
        // 使用渠道配置的真实模型名（channel.model），而非 model_id
        String actualModel = (channel != null && channel.model != null && !channel.model.isBlank())
                ? channel.model
                : (model != null && !model.isBlank() ? model : null);
        if (actualModel == null) {
            throw new RuntimeException("无法确定调用模型，请检查渠道配置");
        }

        // 用户未显式传 maxTokens → 从 ModelConfig.contextLength 动态计算
        int effectiveMaxTokens = resolveEffectiveMaxTokens(model, maxTokens);

        int maxTurns = 25; // ReAct 最大轮次，防止无限循环（台账场景 N 个商品需约 3N+2 轮）
        long start = System.currentTimeMillis();
        int totalInputTokens = 0;
        int totalOutputTokens = 0;
        int totalCachedInputTokens = 0;

        try {
            // 设置会话上下文（供 ToolExecutor 访问）
            if (sessionId != null) {
                AgentSessionContext.setSessionId(sessionId);
            }
            // 将当前 effectiveModel 注入上下文，工具执行时可通过 AgentSessionContext.getModel() 取到
            AgentSessionContext.setModel(actualModel);

            // OOM 监控：记录初始内存和消息列表大小
            logMemoryUsage("ReAct开始");
            int initialMsgSize = estimateMessagesSize(messages);
            log.info("[OOM-Monitor] ReAct开始: messages={}条, 估算字符数={}",
                    (messages != null ? messages.size() : 0), initialMsgSize);

            for (int turn = 0; turn < maxTurns; turn++) {
                log.info("[Agent] ReAct 第 {} 轮, model={}, tools数量={}", turn + 1, actualModel,
                        (tools != null ? tools.size() : 0));

                // OOM 监控：每轮开始前记录内存和消息列表大小
                logMemoryUsage("ReAct第" + (turn + 1) + "轮开始");
                int currentMsgSize = estimateMessagesSize(messages);
                log.info("[OOM-Monitor] 第{}轮: messages={}条, 估算字符数={}",
                        turn + 1, messages.size(), currentMsgSize);
                if (currentMsgSize > 500_000) {
                    log.warn("[OOM-WARN] 第{}轮 messages 估算字符数已达 {}（>500K），接近 OOM 风险！",
                            turn + 1, currentMsgSize);
                }
                // 消息列表大小硬上限：超过 1MB 估算字符数时，抛出友好错误避免 OOM
                if (currentMsgSize > 1_000_000) {
                    log.error("[OOM-ERROR] messages 估算字符数 {} 超过 1MB 上限！强制结束 ReAct 循环", currentMsgSize);
                    onDone.accept(
                            "⚠️ 对话上下文过长（" + (currentMsgSize / 1024) + "KB），无法继续。请新建对话后重试。",
                            0, 0, 0, (int) (System.currentTimeMillis() - start), actualModel, null);
                    return;
                }

                // 每次循环重新解析渠道，确保 channel 与 actualModel 匹配
                ChannelConfig currentChannel = resolveChannel(actualModel);
                log.info("[Agent] 使用渠道: baseUrl={}, model={}", currentChannel.baseUrl, currentChannel.model);

                // 1. 构建请求体（非流式 + tools）
                ObjectNode body = buildRequestBodyWithTools(actualModel, systemPrompt,
                        messages, temperature, effectiveMaxTokens, tools, thinking, thinkingBudget);

                // OOM 监控：记录请求体大小
                try {
                    String bodyJsonForLog = objectMapper.writeValueAsString(body);
                    int bodySize = bodyJsonForLog.length();
                    log.info("[OOM-Monitor] 第{}轮 请求体大小: {} 字符 ({} KB)",
                            turn + 1, bodySize, bodySize / 1024);
                    if (bodySize > 1_000_000) {
                        log.warn("[OOM-WARN] 第{}轮 请求体大小 {} KB 超过 1MB，有 OOM 风险！",
                                turn + 1, bodySize / 1024);
                    }
                } catch (Exception e) {
                    log.warn("[OOM-Monitor] 计算请求体大小失败: {}", e.getMessage());
                }

                // 2. 流式调用 LLM（内容逐 token 推送前端，tool_calls 流式累积）
                //    Agent 模式用10分钟超时，工具执行可能耗时长
                JsonNode response = callLlmApiStreaming(currentChannel, body, 600, onToken);

                // 3. 解析响应
                JsonNode choices = response.path("choices");
                if (!choices.isArray() || choices.isEmpty()) {
                    log.error("[Agent] LLM 返回空 choices, response={}", response);
                    throw new RuntimeException("AI 服务返回空响应，可能是模型不支持 tool calling 或请求格式错误");
                }
                JsonNode choice = choices.get(0);
                JsonNode message = choice.path("message");
                String finishReason = choice.path("finish_reason").asText("");
                String content = message.path("content").asText(null);

                // 诊断日志：打印 LLM 完整响应（前500字符），方便排查代理不支持 tools 等问题
                String responsePreview = response.toString();
                log.info("[Agent] LLM 响应: finishReason={}, hasToolCalls={}, contentLength={}, responsePreview={}",
                        finishReason,
                        message.has("tool_calls") && message.get("tool_calls").isArray(),
                        content != null ? content.length() : -1,
                        responsePreview.length() > 500 ? responsePreview.substring(0, 500) + "..." : responsePreview);

                // 提取 usage
                JsonNode usage = response.path("usage");
                totalInputTokens += usage.path("prompt_tokens").asInt(0);
                totalOutputTokens += usage.path("completion_tokens").asInt(0);
                totalCachedInputTokens += usage.path("prompt_tokens_details").path("cached_tokens").asInt(0);

                // 5. 检测伪工具调用（LLM 输出了 ```tool 代码块而非真正的 function calling）
                //    当 API 代理不支持 Function Calling 时，LLM 会在文本中用代码块格式调用工具
                List<ParsedToolCall> parsedCalls = parsePseudoToolCalls(content, tools);

                // 5.1 如果检测到伪工具调用，将其作为真实工具执行（降级方案）
                if (!parsedCalls.isEmpty()) {
                    log.info("[Agent] 检测到 {} 个伪工具调用（API 不支持 Function Calling），将作为真实工具执行", parsedCalls.size());

                    // 构造 assistant 消息（含 tool_calls），以便后续 ReAct 循环中 LLM 能看到历史
                    ArrayNode pseudoToolCalls = objectMapper.createArrayNode();
                    for (int i = 0; i < parsedCalls.size(); i++) {
                        ParsedToolCall ptc = parsedCalls.get(i);
                        ObjectNode tcNode = pseudoToolCalls.addObject();
                        tcNode.put("id", ptc.toolCallId);
                        tcNode.put("type", "function");
                        ObjectNode func = tcNode.putObject("function");
                        func.put("name", ptc.toolName);
                        func.put("arguments", ptc.arguments);
                    }

                    Map<String, Object> assistantMsg = new LinkedHashMap<>();
                    assistantMsg.put("role", "assistant");
                    assistantMsg.put("content", content);
                    assistantMsg.put("tool_calls", objectMapper.convertValue(pseudoToolCalls,
                            new TypeReference<List<Object>>() {}));
                    // OOM 防护：截断超大工具参数
                    truncateToolArgsInHistory(assistantMsg);
                    messages.add(assistantMsg);

                    // 执行每个伪工具调用
                    for (ParsedToolCall ptc : parsedCalls) {
                        log.info("[Agent] 执行伪工具调用: {}({})", ptc.toolName,
                                ptc.arguments.length() > 100 ? ptc.arguments.substring(0, 100) + "..." : ptc.arguments);

                        // 通知前端：开始调用工具
                        onToolCall.accept(new ToolCallRecord(ptc.toolCallId, ptc.toolName, truncateForSse(ptc.arguments), null));

                        // 执行工具
                        String result;
                        try {
                            result = toolExecutor.execute(ptc.toolName, ptc.arguments);
                        } catch (Exception e) {
                            log.error("[Agent] 伪工具执行异常: {} - {}", ptc.toolName, e.getMessage());
                            result = "{\"error\": \"工具执行失败: " + e.getMessage() + "\"}";
                        }

                        // 通知前端：工具执行完成
                        onToolResult.accept(new ToolCallRecord(ptc.toolCallId, ptc.toolName, ptc.arguments, result));

                        // 将 tool result 加入消息列表（OOM 防护：截断超大结果）
                        String truncatedPseudo = result != null && result.length() > MAX_TOOL_RESULT_IN_HISTORY
                            ? result.substring(0, MAX_TOOL_RESULT_IN_HISTORY)
                                + "\n\n[... 结果已截断，原 " + result.length() + " 字符 ...]"
                            : result;
                        Map<String, Object> toolMessage = new LinkedHashMap<>();
                        toolMessage.put("role", "tool");
                        toolMessage.put("tool_call_id", ptc.toolCallId);
                        toolMessage.put("content", truncatedPseudo);
                        messages.add(toolMessage);
                    }
                    // 不推送文本内容（工具调用才是主要意图，避免把伪代码块推给用户）
                    // 继续循环，让 LLM 根据工具结果决定下一步
                    continue;
                }

                // 5.2 没有伪工具调用 → 文本内容已在 callLlmApiStreaming() 中逐 token 推送前端
                //    （流式模式下无需再整体推送 content）
                //    非伪工具调用场景下，content 已实时流式显示给用户

                // 5. 检查是否有 tool_calls
                JsonNode toolCalls = message.path("tool_calls");
                boolean hasToolCalls = toolCalls.isArray() && !toolCalls.isEmpty();

                // 6. 没有 tool_calls 但也没有内容 → 可能是模型不支持 tool calling
                if (!hasToolCalls && (content == null || content.isEmpty())) {
                    log.warn("[Agent] LLM 未返回 tool_calls 也未返回内容，模型可能不支持 function calling: model={}, channel={}",
                            actualModel, currentChannel.baseUrl);
                    onToken.accept("当前模型（" + actualModel + "）可能不支持工具调用（Function Calling），请尝试切换到支持工具调用的模型（如 gpt-4o、gpt-4o-mini、claude-3.5-sonnet 等）。");
                }

                // 7. 没有 tool_calls → 检查是否是"稍等"类占位回复
                //    某些模型（尤其是思考型）会在调用工具前先说"请稍等/我先..."，
                //    但不带 tool_calls。此时不应结束对话，而应将消息加入历史继续循环。
                if (!hasToolCalls && content != null && !content.isEmpty()
                        && tools != null && !tools.isEmpty() && turn < maxTurns - 1) {
                    if (isWaitMessage(content)) {
                        log.info("[Agent] 检测到'请稍等'占位回复（{} 字符），追加到历史并继续循环", content.length());
                        Map<String, Object> waitMsg = new LinkedHashMap<>();
                        waitMsg.put("role", "assistant");
                        waitMsg.put("content", content);
                        messages.add(waitMsg);
                        continue; // 让 LLM 看到自己说的"请稍等"并继续调用工具
                    }
                }

                // 8. 没有 tool_calls → 任务完成
                if (!hasToolCalls) {
                    int latency = (int) (System.currentTimeMillis() - start);
                    if (totalOutputTokens == 0 && content != null && !content.isEmpty()) {
                        totalOutputTokens = Math.max(1, content.length() / 3);
                    }
                    if (totalInputTokens == 0) {
                        totalInputTokens = 1;
                    }
                    onDone.accept(content != null ? content : "",
                            totalInputTokens, totalOutputTokens, totalCachedInputTokens, latency, actualModel,
                            message.path("reasoning_content").asText(null));
                    return;
                }

                // 7. 有 tool_calls → 执行工具
                log.info("[Agent] LLM 请求调用 {} 个工具", toolCalls.size());

                // 将 assistant 的 tool_calls 消息加入历史
                Map<String, Object> assistantMsg = objectMapper.convertValue(message,
                        new TypeReference<LinkedHashMap<String, Object>>() {});
                // OOM 防护：截断超大工具参数（如 1M 的 code_content），保留摘要
                truncateToolArgsInHistory(assistantMsg);
                messages.add(assistantMsg);

                for (JsonNode toolCall : toolCalls) {
                    String toolCallId = toolCall.path("id").asText();
                    String funcName = toolCall.path("function").path("name").asText();
                    String args = toolCall.path("function").path("arguments").asText();

                    log.info("[Agent] 调用工具: {}({})", funcName,
                            args.length() > 100 ? args.substring(0, 100) + "..." : args);

                    // 通知前端：开始调用工具（OOM 防护：SSE 层截断到 3K，工具执行仍用完整参数）
                    onToolCall.accept(new ToolCallRecord(toolCallId, funcName,
                            truncateForSse(args), null));

                    // 执行工具
                    String result;
                    try {
                        result = toolExecutor.execute(funcName, args);
                    } catch (Exception e) {
                        log.error("[Agent] 工具执行异常: {} - {}", funcName, e.getMessage());
                        result = "{\"error\": \"工具执行失败: " + e.getMessage() + "\"}";
                    }

                    // OOM 监控：记录工具结果大小
                    if (result != null) {
                        log.info("[OOM-Monitor] 工具 {} 返回结果大小: {} 字符 ({} KB)",
                                funcName, result.length(), result.length() / 1024);
                        if (result.length() > 100_000) {
                            log.warn("[OOM-WARN] 工具 {} 返回结果 {} KB 超过 100KB，有 OOM 风险！",
                                    funcName, result.length() / 1024);
                        }
                    }

                    // 通知前端：工具执行完成
                    onToolResult.accept(new ToolCallRecord(toolCallId, funcName, args, result));

                    // 将 tool result 加入消息列表（OpenAI 格式）
                    // OOM 防护：截断超大工具结果（前端 SSE 独立截断，此处限制 LLM 上下文大小）
                    String truncated = result != null && result.length() > MAX_TOOL_RESULT_IN_HISTORY
                        ? result.substring(0, MAX_TOOL_RESULT_IN_HISTORY)
                            + "\n\n[... 结果已截断，原 " + result.length() + " 字符 ...]"
                        : result;
                    Map<String, Object> toolMessage = new LinkedHashMap<>();
                    toolMessage.put("role", "tool");
                    toolMessage.put("tool_call_id", toolCallId);
                    toolMessage.put("content", truncated);
                    messages.add(toolMessage);
                }
                // 继续循环，让 LLM 根据工具结果决定下一步
            }

            // 达到最大轮次
            log.warn("[Agent] 达到最大 ReAct 轮次 ({})，强制结束", maxTurns);
            int latency = (int) (System.currentTimeMillis() - start);
            onDone.accept("[Agent 已达到最大调用轮次]", totalInputTokens, totalOutputTokens, latency, actualModel, null);

        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            log.error("[Agent] Tool Calling 流程失败: {}", e.getMessage(), e);
            throw new RuntimeException("Agent 执行失败: " + e.getMessage());
        } finally {
            AgentSessionContext.clear();
        }
    }

    // ==================== OOM 监控和诊断 ====================

    private static final MemoryMXBean MEMORY_BEAN = ManagementFactory.getMemoryMXBean();

    /** 记录当前 JVM 内存使用情况 */
    private void logMemoryUsage(String tag) {
        try {
            MemoryUsage heap = MEMORY_BEAN.getHeapMemoryUsage();
            long usedMB = heap.getUsed() / 1024 / 1024;
            long maxMB = heap.getMax() / 1024 / 1024;
            double usagePct = maxMB > 0 ? (double) usedMB / maxMB * 100 : 0;
            log.info("[OOM-Monitor] {}: Heap {}/{} MB ({})", tag, usedMB, maxMB,
                    String.format("%.1f%%", usagePct));
        } catch (Exception e) {
            log.warn("[OOM-Monitor] 获取内存使用情况失败: {}", e.getMessage());
        }
    }

    /** 估算消息列表中所有文本的字符总数（用于 OOM 监控） */
    private int estimateMessagesSize(List<Map<String, Object>> messages) {
        if (messages == null) return 0;
        int total = 0;
        for (Map<String, Object> msg : messages) {
            Object content = msg.get("content");
            if (content instanceof String) {
                total += ((String) content).length();
            }
            Object toolCalls = msg.get("tool_calls");
            if (toolCalls instanceof List) {
                for (Object tc : (List<?>) toolCalls) {
                    if (tc instanceof Map) {
                        Object func = ((Map<?, ?>) tc).get("function");
                        if (func instanceof Map) {
                            Object args = ((Map<?, ?>) func).get("arguments");
                            if (args instanceof String) {
                                total += ((String) args).length();
                            }
                        }
                    }
                }
            }
            Object toolCallId = msg.get("tool_call_id");
            if (toolCallId != null) {
                // tool 角色消息，content 是工具结果
                if (content instanceof String) {
                    // 已经计入上面的 content
                }
            }
        }
        return total;
    }

    /**
     * 截断消息中的 tool_calls 参数为摘要（防止 OOM）。
     * 工具执行时使用完整参数，此处仅截断存储到消息历史中的副本。
     */
    @SuppressWarnings("unchecked")
    private void truncateToolArgsInHistory(Map<String, Object> assistantMsg) {
        Object toolCallsObj = assistantMsg.get("tool_calls");
        if (!(toolCallsObj instanceof List)) return;
        List<Map<String, Object>> toolCalls = (List<Map<String, Object>>) toolCallsObj;
        for (Map<String, Object> tc : toolCalls) {
            Object funcObj = tc.get("function");
            if (!(funcObj instanceof Map)) continue;
            Map<String, Object> func = (Map<String, Object>) funcObj;
            Object argsObj = func.get("arguments");
            if (!(argsObj instanceof String args)) continue;
            if (args.length() > MAX_TOOL_ARG_IN_HISTORY) {
                func.put("arguments",
                    "{\"__truncated__\":\"参数过长已被截断，原 " + args.length()
                    + " 字符。工具执行时已使用完整参数。摘要："
                    + truncateToSummary(args, 200) + "\"}");
            }
        }
    }

    /** 从长文本中提取前 N 字符作为摘要 */
    private String truncateToSummary(String text, int maxLen) {
        if (text == null || text.isEmpty()) return "";
        // 尝试找到第一个合理的断点
        String stripped = text.replaceAll("[\\s]+", " ").trim();
        if (stripped.length() <= maxLen) return stripped;
        // 在断词处截断
        int cut = stripped.lastIndexOf(' ', maxLen);
        if (cut < maxLen / 2) cut = maxLen;
        return stripped.substring(0, cut) + "...";
    }

    /**
     * 检测 LLM 是否输出了"稍等"类占位回复。
     * 某些模型在调用工具前会说"请稍等/让我先/马上/Let me..."，
     * 但不带 tool_calls。这种情况应继续循环而不是结束对话。
     *
     * 判断条件：
     * 1. 消息较短（<500 字符）—— 长回复通常是真实答案
     * 2. 包含等待/准备类关键词
     * 3. 不含代码块、列表等实质性内容
     */
    private static final java.util.regex.Pattern WAIT_PATTERN = java.util.regex.Pattern.compile(
        "请稍等|稍等[一一下]|等一下|稍后|马上|这就|我先|让我|正在|准备|开始为您|Let me|just a moment|one moment|hold on|working on|let me",
        java.util.regex.Pattern.CASE_INSENSITIVE
    );

    private static final java.util.regex.Pattern SUBSTANTIVE_PATTERN = java.util.regex.Pattern.compile(
        "```|\\n\\s*[-*+]\\s|\\n\\s*\\d+[.)]\\s|✅|❌|成功|失败|结果|完成|已创建|已保存|已注册",
        java.util.regex.Pattern.CASE_INSENSITIVE
    );

    private boolean isWaitMessage(String content) {
        if (content == null || content.isBlank()) return false;
        if (content.length() > 500) return false; // 长回复不是"稍等"
        if (SUBSTANTIVE_PATTERN.matcher(content).find()) return false; // 有实质性内容
        return WAIT_PATTERN.matcher(content).find();
    }

    /** SSE 层 tool_args 截断上限（发送给前端的参数显示） */
    private static final int MAX_TOOL_ARGS_SSE = 3000;

    /**
     * 截断 tool_args 用于 SSE 发送。
     * 工具执行时仍使用完整参数，此处仅截断前端显示用的副本。
     */
    private String truncateForSse(String args) {
        if (args == null || args.length() <= MAX_TOOL_ARGS_SSE) return args;
        return args.substring(0, MAX_TOOL_ARGS_SSE)
            + "\n\n[... tool_args 已截断，原 " + args.length()
            + " 字符。执行时使用完整参数 ...]";
    }

    /**
     * 构建 Vision 格式的用户消息（支持图片 + 文本）
     * <p>
     * 图片作为 image_url 内容块传入（OpenAI Vision API 格式），
     * LLM 直接看到图片内容，无需额外 OCR 工具。
     *
     * @param text           文本消息
     * @param imageBase64List 图片 base64 列表（需包含 data: 前缀，如 "data:image/png;base64,..."）
     * @return OpenAI Vision 格式的消息 Map
     */
    public Map<String, Object> buildVisionMessage(String text, List<String> imageBase64List) {
        ArrayNode contentArray = objectMapper.createArrayNode();

        // 文本部分
        if (text != null && !text.isEmpty()) {
            contentArray.addObject().put("type", "text").put("text", text);
        }

        // 图片部分
        if (imageBase64List != null) {
            for (String base64 : imageBase64List) {
                ObjectNode imageNode = contentArray.addObject();
                imageNode.put("type", "image_url");
                ObjectNode imageUrl = imageNode.putObject("image_url");
                imageUrl.put("url", base64);
                // 可选：设置图片细节级别
                // imageUrl.put("detail", "high");
            }
        }

        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("role", "user");
        msg.put("content", contentArray);
        return msg;
    }

    // ==================== 私有辅助（Tool Calling） ====================

    /**
     * 供工具类调用的 Vision 图片识别接口。
     * <p>
     * 优先使用 AgentSessionContext 中当前 model 对应渠道；若该模型不支持图片（HTTP 400 image_url），
     * 自动遍历所有 active 渠道，依次尝试找到支持 Vision 的模型来识别图片。
     *
     * @param model       Vision 模型名（null 则自动选）
     * @param prompt      给 LLM 的提示词
     * @param imageBase64 图片 base64（不含 data: 前缀）
     * @param mimeType    图片 MIME 类型，如 "image/jpeg"
     * @return LLM 返回的文本内容
     */
    public String callVisionForTool(String model, String prompt, String imageBase64, String mimeType) throws Exception {
        // 先用指定/当前渠道尝试
        ChannelConfig firstChannel = resolveChannel(model);
        String firstModel = (model != null && !model.isBlank()) ? model : firstChannel.model();
        try {
            String result = doVisionCall(firstChannel, firstModel, prompt, imageBase64, mimeType);
            log.info("[Vision] 使用模型 {} 图片识别成功", firstModel);
            return result;
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "";
            boolean isVisionError = msg.contains("image_url") || msg.contains("vision")
                    || msg.contains("multimodal") || msg.contains("400")
                    || msg.contains("unsupported") || msg.contains("unknown variant");
            if (!isVisionError) {
                throw e; // 与 Vision 无关的错误，直接抛出
            }
            log.warn("[Vision] 模型 {} 不支持图片识别（{}），自动搜索支持 Vision 的渠道...", firstModel, msg);
        }

        // 遍历所有渠道找支持 Vision 的模型
        List<ChannelConfig> visionCandidates = resolveVisionChannels(firstModel);
        if (visionCandidates.isEmpty()) {
            throw new RuntimeException(
                    "当前模型不支持图片识别，且未找到其他支持 Vision 的渠道/模型。" +
                    "请在管理后台配置支持视觉的模型（如 gpt-4o、claude-3-sonnet、qwen-vl 等）");
        }

        // 依次尝试每个候选，成功即返回
        Exception lastException = null;
        for (ChannelConfig vc : visionCandidates) {
            try {
                log.info("[Vision] 尝试 Vision 候选: model={}, baseUrl={}", vc.model(), vc.baseUrl());
                String result = doVisionCall(vc, vc.model(), prompt, imageBase64, mimeType);
                log.info("[Vision] 使用降级模型 {} 图片识别成功", vc.model());
                return result;
            } catch (Exception e) {
                log.warn("[Vision] 候选 {} 也不支持 Vision: {}", vc.model(), e.getMessage());
                lastException = e;
            }
        }
        throw new RuntimeException("所有 Vision 候选模型均失败，最后错误: " +
                (lastException != null ? lastException.getMessage() : "未知"));
    }

    /**
     * 实际发送 Vision 请求的内部方法（不含降级逻辑）
     */
    private String doVisionCall(ChannelConfig channel, String actualModel,
                                 String prompt, String imageBase64, String mimeType) throws Exception {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("model", actualModel);
        body.put("max_tokens", 4096);
        body.put("stream", false);

        ArrayNode messages = body.putArray("messages");
        ObjectNode userMsg = messages.addObject();
        userMsg.put("role", "user");

        ArrayNode content = userMsg.putArray("content");
        content.addObject().put("type", "text").put("text", prompt);

        if (imageBase64 != null && !imageBase64.isEmpty()) {
            String dataUrl = imageBase64.startsWith("data:") ? imageBase64
                    : "data:" + mimeType + ";base64," + imageBase64;
            ObjectNode imageContent = content.addObject();
            imageContent.put("type", "image_url");
            imageContent.putObject("image_url").put("url", dataUrl).put("detail", "high");
        }

        JsonNode response = callLlmApi(channel, body, 300); // Vision 最多5分钟
        // callLlmApi 已通过适配器归一化为 OpenAI 格式响应
        return response.path("choices").path(0).path("message").path("content").asText();
    }

    /**
     * 遍历所有 active 渠道，收集所有支持 Vision 的模型候选列表。
     * Vision 识别规则：模型名包含以下关键字（不区分大小写）
     *
     * @param excludeModel 排除此模型（已知不支持，避免重复尝试）
     * @return 按渠道优先级排序的 ChannelConfig 列表
     */
    private List<ChannelConfig> resolveVisionChannels(String excludeModel) {
        // Vision 模型关键词白名单（小写匹配）
        List<String> visionKeywords = List.of(
                "gpt-4o", "gpt-4-vision", "gpt-4-turbo",
                "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
                "qwen-vl", "qwen2-vl",
                "gemini",
                "llava",
                "yi-vision", "yi-vl",
                "internvl",
                "cogvlm",
                "deepseek-vl",
                "moonshot-v1",
                "glm-4v",
                "vision",   // 通用：模型名含 vision 的
                "-vl"       // 通用：模型名含 -vl 的（visual language 缩写）
        );

        List<ChannelConfig> results = new ArrayList<>();
        try {
            List<ModelChannel> channels = channelMapper.selectList(
                    new QueryWrapper<ModelChannel>()
                            .eq("status", "active")
                            .eq("deleted", 0)
                            .orderByAsc("priority"));

            for (ModelChannel ch : channels) {
                if (!isValidApiKey(ch.getApiKey())) continue;
                if (ch.getModels() == null || ch.getModels().isBlank()) continue;

                // 解析 models 字段（支持 JSON 数组和逗号分隔字符串两种格式）
                List<String> modelList = parseModelsField(ch.getModels());

                for (String m : modelList) {
                    String mt = m.trim();
                    if (mt.isBlank()) continue;
                    if (excludeModel != null && mt.equalsIgnoreCase(excludeModel)) continue;

                    String ml = mt.toLowerCase();
                    boolean isVision = visionKeywords.stream().anyMatch(ml::contains);
                    if (isVision) {
                        results.add(new ChannelConfig(ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()), mt, ch.getProvider()));
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[Vision] 查找 Vision 渠道失败: {}", e.getMessage());
        }
        log.info("[Vision] 找到 {} 个 Vision 候选渠道", results.size());
        return results;
    }

    /**
     * 解析 model_channel.models 字段：支持 JSON 数组和逗号分隔字符串两种格式
     */
    private List<String> parseModelsField(String models) {
        if (models == null || models.isBlank()) return List.of();
        try {
            JsonNode node = objectMapper.readTree(models.trim());
            if (node.isArray()) {
                List<String> list = new ArrayList<>();
                for (JsonNode item : node) {
                    // 可能是字符串，也可能是对象 {model_id, id, name...}
                    if (item.isTextual()) {
                        list.add(item.asText());
                    } else {
                        // 尝试各种 key
                        String id = item.path("model_id").asText(
                                item.path("id").asText(
                                item.path("modelId").asText("")));
                        if (!id.isBlank()) list.add(id);
                    }
                }
                return list;
            }
        } catch (Exception ignored) {
            // 不是 JSON，按逗号分隔处理
        }
        return Arrays.asList(models.split(","));
    }

    /**
     * 构建 Agent 模式的请求体（非流式 + tools）
     */
    private ObjectNode buildRequestBodyWithTools(String model, String systemPrompt,
                                                 List<Map<String, Object>> messages,
                                                 Double temperature, Integer maxTokens,
                                                 List<ToolDefinition> tools,
                                                 Boolean thinking, Integer thinkingBudget) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("model", model);
        body.put("temperature", temperature != null ? temperature : 0.7);
        body.put("max_tokens", maxTokens != null ? maxTokens : 8192);
        body.put("stream", true); // Agent 模式流式传输 — 内容逐 token 返回前端
        ObjectNode streamOptions = objectMapper.createObjectNode();
        streamOptions.put("include_usage", true);
        body.set("stream_options", streamOptions);

        // 深度思考参数（各适配器 transformRequest 时会按厂商格式转换）
        if (thinking != null && thinking) {
            body.put("_thinking", true);
            if (thinkingBudget != null) {
                body.put("_thinking_budget", thinkingBudget);
            }
        }

        // messages（支持 Object 类型值，兼容 tool role）
        ArrayNode messagesArray = body.putArray("messages");

        // 1. system prompt（自动附加项目格式规范）
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messagesArray.addObject().put("role", "system").put("content", enhanceSystemPrompt(systemPrompt));
        }

        // 2. 历史消息
        if (messages != null) {
            for (Map<String, Object> msg : messages) {
                ObjectNode msgNode = messagesArray.addObject();
                msgNode.put("role", (String) msg.get("role"));

                Object contentObj = msg.get("content");
                if (contentObj instanceof String s) {
                    msgNode.put("content", s);
                } else if (contentObj != null) {
                    msgNode.set("content", objectMapper.valueToTree(contentObj));
                }

                // tool_calls（assistant 消息可能携带）
                Object toolCallsObj = msg.get("tool_calls");
                if (toolCallsObj != null) {
                    msgNode.set("tool_calls", objectMapper.valueToTree(toolCallsObj));
                }

                // tool_call_id（tool 消息必须携带）
                Object toolCallId = msg.get("tool_call_id");
                if (toolCallId != null) {
                    msgNode.put("tool_call_id", (String) toolCallId);
                }
            }
        }

        // 3. tools 定义
        if (tools != null && !tools.isEmpty()) {
            ArrayNode toolsArray = body.putArray("tools");
            for (ToolDefinition tool : tools) {
                ObjectNode toolNode = toolsArray.addObject();
                toolNode.put("type", "function");
                ObjectNode function = toolNode.putObject("function");
                function.put("name", tool.name());
                function.put("description", tool.description());
                function.set("parameters", tool.parameters());
            }
            body.put("tool_choice", "auto");

            // 诊断日志：打印完整 tools 定义，排查 LLM 无法识别工具的问题
            try {
                String toolsJson = objectMapper.writeValueAsString(body.get("tools"));
                log.info("[Agent] 发送 {} 个工具定义: {}",
                        tools.size(), toolsJson.length() > 2000 ? toolsJson.substring(0, 2000) + "..." : toolsJson);
            } catch (Exception e) {
                log.warn("[Agent] 打印 tools 定义失败: {}", e.getMessage());
            }
        } else {
            log.warn("[Agent] 警告：tools 为空！LLM 将无法调用任何工具。请检查 AgentConfig.tools() 是否返回了工具列表。");
        }

        applyPromptCacheKey(body);
        return body;
    }

    /**
     * 非流式调用 LLM API，返回完整 JSON 响应
     */
    private JsonNode callLlmApi(ChannelConfig channel, ObjectNode body) throws Exception {
        return callLlmApi(channel, body, timeoutSeconds);
    }

    /** Agent 模式专用：支持自定义超时（Agent 工具执行可能耗时很长） */
    private JsonNode callLlmApi(ChannelConfig channel, ObjectNode body, int requestTimeoutSeconds) throws Exception {
        // 通过适配器处理供应商差异
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        String actualModel = body.path("model").asText(channel.model);
        body = adapter.transformRequest(body, channel.provider);
        String url = adapter.chatUrl(channel.baseUrl, actualModel, channel.apiKey);

        // 提前序列化，同时用于日志和请求体
        String bodyJson = objectMapper.writeValueAsString(body);

        // OOM 监控：记录请求体大小
        int requestSize = bodyJson.length();
        log.info("[OOM-Monitor] callLlmApi: 请求体大小={} 字符 ({} KB, {} MB)",
                requestSize, requestSize / 1024, requestSize / 1024 / 1024);
        if (requestSize > 2_000_000) {
            log.error("[OOM-ERROR] 请求体大小 {} MB 超过 2MB！极易导致 OOM！",
                    requestSize / 1024 / 1024);
            logMemoryUsage("callLlmApi-大请求体");
        }

        // 诊断日志：打印发给 LLM 的请求体（截断到 8000 字符，足够看到 tools 定义）
        try {
            String toLog = bodyJson.length() > 8000
                    ? bodyJson.substring(0, 8000) + "...(truncated, total=" + bodyJson.length() + ")"
                    : bodyJson;
            log.info("[Agent] 发给 LLM 的请求体:\n{}", toLog);
        } catch (Exception e) {
            log.warn("[Agent] 打印请求体失败: {}", e.getMessage());
        }

        // 指数退避重试：针对网络层错误（Connection reset、Timeout 等）
        int maxRetries = 3;
        Exception lastException = null;
        for (int attempt = 0; attempt < maxRetries; attempt++) {
            if (attempt > 0) {
                long backoffMs = (long) Math.pow(2, attempt - 1) * 500; // 500ms, 1000ms, 2000ms
                log.warn("[Agent] LLM API 请求失败，第 {} 次重试（等待 {}ms）...", attempt + 1, backoffMs);
                try { Thread.sleep(backoffMs); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
            }

            try {
                HttpClient client = HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(30))
                        .build();

                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(bodyJson));
                adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
                HttpRequest request = reqBuilder.build();

                HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

                if (response.statusCode() != 200) {
                    String errMsg = extractErrorMessage(response.body());
                    log.error("[Agent] LLM API 错误: HTTP {} - {}", response.statusCode(), errMsg);

                    // 🔧 渠道自动禁用：401/403 表示 API Key 无效或权限不足，立即禁用
                    if ((response.statusCode() == 401 || response.statusCode() == 403) && channel.channelId != null) {
                        disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                    }

                    // 降级处理：如果错误是因为模型不支持 image_url（视觉）
                    if (response.statusCode() == 400
                            && (errMsg.contains("image_url") || response.body().contains("image_url"))) {
                        log.warn("[Agent] 模型 {} 不支持 vision，尝试用其他 Vision 模型识别图片后再回到原模型处理",
                                body.path("model").asText());

                        // 策略1：尝试提取图片，用支持 Vision 的模型识别后，把文字描述替换回来再重试
                        ObjectNode visionReplacedBody = replaceImagesWithVisionRecognition(body);
                        if (visionReplacedBody != body) {
                            // 成功识别并替换了图片
                            String retryJson = objectMapper.writeValueAsString(visionReplacedBody);
                            HttpRequest.Builder retryBuilder = HttpRequest.newBuilder()
                                    .uri(URI.create(url))
                                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                                    .header("Content-Type", "application/json")
                                    .POST(HttpRequest.BodyPublishers.ofString(retryJson));
                            adapter.authHeaders(channel.apiKey).forEach((k, v) -> retryBuilder.header(k, v));
                            HttpRequest retryRequest = retryBuilder.build();
                            HttpResponse<String> retryResponse = client.send(retryRequest, HttpResponse.BodyHandlers.ofString());
                            if (retryResponse.statusCode() == 200) {
                                log.info("[Agent] Vision 识别替换后，原模型重试成功");
                                JsonNode retryRespJson = objectMapper.readTree(retryResponse.body());
                                if (retryRespJson.has("error")) {
                                    String retryErr = retryRespJson.path("error").path("message").asText("未知错误");
                                    throw new RuntimeException("AI 服务返回错误: " + retryErr);
                                }
                                return adapter.normalizeResponse(retryRespJson);
                            } else {
                                log.warn("[Agent] Vision 替换后原模型仍失败: HTTP {}", retryResponse.statusCode());
                            }
                        }

                        // 策略2：找不到 Vision 模型或识别失败，降级为纯文本（图片替换为占位符）
                        log.warn("[Agent] Vision 识别降级失败，最终方案：剥除图片（占位符替代）后重试原模型");
                        ObjectNode strippedBody = stripImageUrlFromMessages(body);
                        if (strippedBody != body) {
                            String strippedJson = objectMapper.writeValueAsString(strippedBody);
                            HttpRequest.Builder stripBuilder = HttpRequest.newBuilder()
                                    .uri(URI.create(url))
                                    .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                                    .header("Content-Type", "application/json")
                                    .POST(HttpRequest.BodyPublishers.ofString(strippedJson));
                            adapter.authHeaders(channel.apiKey).forEach((k, v) -> stripBuilder.header(k, v));
                            HttpRequest stripRequest = stripBuilder.build();
                            HttpResponse<String> stripResponse = client.send(stripRequest, HttpResponse.BodyHandlers.ofString());
                            if (stripResponse.statusCode() == 200) {
                                log.info("[Agent] 剥除图片后重试成功（最终降级方案）");
                                JsonNode stripRespJson = objectMapper.readTree(stripResponse.body());
                                if (stripRespJson.has("error")) {
                                    String stripErr = stripRespJson.path("error").path("message").asText("未知错误");
                                    throw new RuntimeException("AI 服务返回错误: " + stripErr);
                                }
                                return adapter.normalizeResponse(stripRespJson);
                            } else {
                                String stripErrMsg = extractErrorMessage(stripResponse.body());
                                log.error("[Agent] 剥除图片重试仍失败: HTTP {} - {}", stripResponse.statusCode(), stripErrMsg);
                                throw new RuntimeException("AI 服务返回错误（已剥除图片）: HTTP " + stripResponse.statusCode() + " - " + stripErrMsg);
                            }
                        }
                    }

                    // 🔧 非 retryable HTTP 错误（5xx 服务端故障）→ 自动禁用
                    if (response.statusCode() >= 500 && response.statusCode() < 600 && channel.channelId != null) {
                        disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                    }

                    throw new RuntimeException("AI 服务返回错误: HTTP " + response.statusCode() + " - " + errMsg);
                }

                // 检查响应体是否包含 error 字段（某些 API 返回 HTTP 200 但 body 里有 error）
                JsonNode responseJson = objectMapper.readTree(response.body());

                // OOM 监控：记录响应体大小
                int responseSize = response.body().length();
                log.info("[OOM-Monitor] callLlmApi: 响应体大小={} 字符 ({} KB)",
                        responseSize, responseSize / 1024);
                if (responseSize > 1_000_000) {
                    log.warn("[OOM-WARN] 响应体大小 {} KB 超过 1MB！", responseSize / 1024);
                }

                if (responseJson.has("error")) {
                    JsonNode errorNode = responseJson.get("error");
                    String errMsg = errorNode.has("message")
                            ? errorNode.get("message").asText("未知错误")
                            : errorNode.asText("未知错误");
                    String errType = errorNode.has("type") ? errorNode.get("type").asText("") : "";
                    log.error("[Agent] LLM API 返回错误: type={}, message={}", errType, errMsg);

                    // 🔧 配额/认证/账户问题 → 自动禁用渠道
                    if (channel.channelId != null) {
                        String lowerErr = (errType + errMsg).toLowerCase();
                        if (lowerErr.contains("insufficient_quota")
                                || lowerErr.contains("quota")
                                || lowerErr.contains("billing")
                                || lowerErr.contains("invalid_api_key")
                                || lowerErr.contains("access_terminated")
                                || lowerErr.contains("account")) {
                            disableChannel(channel.channelId, errType + ": " + errMsg);
                        }
                    }

                    throw new RuntimeException("AI 服务返回错误: " + errMsg);
                }

                return adapter.normalizeResponse(responseJson);

            } catch (java.io.IOException e) {
                // 网络层错误（Connection reset、Timeout 等，均为 IOException 子类）→ 记录并进入重试
                lastException = e;
                log.warn("[Agent] LLM API 网络异常（尝试 {}/{}）: {}", attempt + 1, maxRetries, e.getMessage());
                if (attempt == maxRetries - 1) {
                    break; // 最后一次也失败了，跳出循环抛异常
                }
            }
        }

        // 🔧 所有重试失败 → 自动禁用渠道
        if (channel.channelId != null) {
            disableChannel(channel.channelId, "网络请求连续失败 " + maxRetries + " 次: " +
                    (lastException != null ? lastException.getMessage() : "未知错误"));
        }

        throw new RuntimeException("AI 服务网络请求失败（已重试 " + maxRetries + " 次）: " +
                (lastException != null ? lastException.getMessage() : "未知错误"), lastException);
    }

    /**
     * Agent 模式流式调用 LLM API — 流式读取 SSE 响应，逐 token 推送到前端，
     * 同时累积 tool_calls 和 reasoning_content，最终构建与非流式响应相同格式的 JsonNode 返回。
     * <p>
     * 这是 Agent 模式流式传输的核心方法。与 {@link #callLlmApi} 的区别：
     * <ul>
     *   <li>使用 HTTP InputStream 流式读取 SSE，而非 ofString 一次性读取</li>
     *   <li>每个 content token 通过 onToken 实时推送前端（实现流式显示）</li>
     *   <li>tool_calls 按 index 累积拼接（OpenAI 流式格式分片返回）</li>
     *   <li>reasoning_content（深度思考）通过 ctx.thinkingBuilder 累积</li>
     *   <li>返回合成 JsonNode，格式与非流式响应完全一致，下游 ReAct 循环无需修改</li>
     * </ul>
     *
     * @param channel              渠道配置
     * @param body                 请求体（必须已设置 stream=true）
     * @param requestTimeoutSeconds 请求超时秒数
     * @param onToken              内容 token 回调（每个 token 实时推送前端）
     * @return 合成响应 JsonNode（格式与非流式响应一致）
     */
    private JsonNode callLlmApiStreaming(ChannelConfig channel, ObjectNode body,
                                          int requestTimeoutSeconds, Consumer<String> onToken) throws Exception {
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        String actualModel = body.path("model").asText(channel.model);
        body = adapter.transformRequest(body, channel.provider);
        String url = adapter.streamUrl(channel.baseUrl, actualModel, channel.apiKey);
        String bodyJson = objectMapper.writeValueAsString(body);

        // OOM 监控：记录请求体大小
        int requestSize = bodyJson.length();
        log.info("[OOM-Monitor] callLlmApiStreaming: 请求体大小={} 字符 ({} KB)", requestSize, requestSize / 1024);
        if (requestSize > 1_000_000) {
            log.warn("[OOM-WARN] 流式请求体大小 {} KB 超过 1MB！", requestSize / 1024);
        }

        // 指数退避重试：针对网络层错误
        int maxRetries = 3;
        Exception lastException = null;
        for (int attempt = 0; attempt < maxRetries; attempt++) {
            if (attempt > 0) {
                long backoffMs = (long) Math.pow(2, attempt - 1) * 500;
                log.warn("[Agent] 流式 LLM 请求失败，第 {} 次重试（等待 {}ms）...", attempt + 1, backoffMs);
                try { Thread.sleep(backoffMs); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
            }

            try {
                HttpClient client = HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(30))
                        .build();

                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(Duration.ofSeconds(requestTimeoutSeconds))
                        .header("Content-Type", "application/json")
                        .header("Accept", "text/event-stream")
                        .POST(HttpRequest.BodyPublishers.ofString(bodyJson));
                adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
                HttpRequest request = reqBuilder.build();

                long streamStart = System.currentTimeMillis();
                HttpResponse<java.io.InputStream> response = client.send(request,
                        HttpResponse.BodyHandlers.ofInputStream());

                if (response.statusCode() != 200) {
                    String errBody = new String(response.body().readAllBytes());
                    String errMsg = extractErrorMessage(errBody);
                    log.error("[Agent] 流式 LLM API 错误: HTTP {} - {}", response.statusCode(), errMsg);

                    // 渠道自动禁用：401/403
                    if ((response.statusCode() == 401 || response.statusCode() == 403) && channel.channelId != null) {
                        disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                    }
                    // 5xx 服务端故障 → 自动禁用
                    if (response.statusCode() >= 500 && response.statusCode() < 600 && channel.channelId != null) {
                        disableChannel(channel.channelId, "HTTP " + response.statusCode() + " - " + errMsg);
                    }
                    throw new RuntimeException("AI 服务返回错误: HTTP " + response.statusCode() + " - " + errMsg);
                }

                // 流式读取 SSE
                ProviderAdapter.StreamContext ctx = new ProviderAdapter.StreamContext();
                StringBuilder fullContent = new StringBuilder();

                try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body()))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (adapter.isStreamDone(ctx)) break;
                        int thinkingLenBefore = ctx.thinkingBuilder.length();
                        String tokenText = adapter.parseStreamLine(line, ctx);
                        emitThinkingDelta(ctx, thinkingLenBefore);
                        if (tokenText != null && !tokenText.isEmpty()) {
                            fullContent.append(tokenText);
                            onToken.accept(tokenText); // 🚀 逐 token 实时推送前端！
                        }
                    }
                }

                int latency = (int) (System.currentTimeMillis() - streamStart);
                log.info("[Agent] 流式 LLM 响应完成: contentLength={}, toolCalls={}, finishReason={}, latency={}ms",
                        fullContent.length(), ctx.toolCallsBuilder.size(), ctx.finishReason, latency);

                // 构建合成响应（与非流式响应格式完全一致，下游 ReAct 循环无需修改）
                ObjectNode syntheticResponse = objectMapper.createObjectNode();
                ArrayNode choices = syntheticResponse.putArray("choices");
                ObjectNode choice0 = choices.addObject();
                choice0.put("index", 0);
                ObjectNode message = choice0.putObject("message");
                message.put("role", "assistant");
                message.put("content", fullContent.toString());

                // tool_calls（从流式累积的 ctx.toolCallsBuilder 构建）
                if (!ctx.toolCallsBuilder.isEmpty()) {
                    ArrayNode toolCallsArray = message.putArray("tool_calls");
                    for (ProviderAdapter.StreamToolCall stc : ctx.toolCallsBuilder) {
                        ObjectNode tcNode = toolCallsArray.addObject();
                        tcNode.put("id", stc.id != null ? stc.id : "");
                        tcNode.put("type", stc.type != null ? stc.type : "function");
                        ObjectNode func = tcNode.putObject("function");
                        func.put("name", stc.functionName != null ? stc.functionName : "");
                        func.put("arguments", stc.arguments.toString());
                    }
                }

                // reasoning_content（深度思考内容）
                String thinkingContent = adapter.getThinkingContent(ctx);
                if (thinkingContent != null && !thinkingContent.isEmpty()) {
                    message.put("reasoning_content", thinkingContent);
                }

                // finish_reason
                choice0.put("finish_reason", ctx.finishReason != null ? ctx.finishReason : "stop");

                // usage
                ObjectNode usage = syntheticResponse.putObject("usage");
                int inT = 0, outT = 0, cachedT = 0;
                int[] streamUsage = adapter.getStreamUsage(ctx);
                if (streamUsage != null) {
                    inT = streamUsage.length > 0 ? streamUsage[0] : 0;
                    outT = streamUsage.length > 1 ? streamUsage[1] : 0;
                    cachedT = streamUsage.length > 2 ? streamUsage[2] : 0;
                }
                if (outT == 0 && fullContent.length() > 0) {
                    outT = Math.max(1, fullContent.length() / 3);
                }
                usage.put("prompt_tokens", inT);
                usage.put("completion_tokens", outT);
                ObjectNode promptDetails = usage.putObject("prompt_tokens_details");
                promptDetails.put("cached_tokens", cachedT);

                return syntheticResponse;

            } catch (java.io.IOException e) {
                lastException = e;
                log.warn("[Agent] 流式 LLM API 网络异常（尝试 {}/{}）: {}", attempt + 1, maxRetries, e.getMessage());
                if (attempt == maxRetries - 1) break;
            }
        }

        // 所有重试失败 → 自动禁用渠道
        if (channel.channelId != null) {
            disableChannel(channel.channelId, "流式网络请求连续失败 " + maxRetries + " 次: " +
                    (lastException != null ? lastException.getMessage() : "未知错误"));
        }
        throw new RuntimeException("AI 流式服务网络请求失败（已重试 " + maxRetries + " 次）: " +
                (lastException != null ? lastException.getMessage() : "未知错误"), lastException);
    }

    // ==================== 私有辅助 ====================

    private ObjectNode buildRequestBody(String model, String systemPrompt,
                                        List<Map<String, String>> history,
                                        String userMessage,
                                        Double temperature, Integer maxTokens, boolean stream) {
        return buildRequestBody(model, systemPrompt, history, userMessage, null, temperature, maxTokens, stream, null, null);
    }

    private ObjectNode buildRequestBody(String model, String systemPrompt,
                                        List<Map<String, String>> history,
                                        String userMessage,
                                        Double temperature, Integer maxTokens, boolean stream,
                                        Boolean thinking, Integer thinkingBudget) {
        return buildRequestBody(model, systemPrompt, history, userMessage, null, temperature, maxTokens, stream, thinking, thinkingBudget);
    }

    /** 支持 Vision 图片的请求体构建 */
    private ObjectNode buildRequestBody(String model, String systemPrompt,
                                        List<Map<String, String>> history,
                                        String userMessage,
                                        List<String> imageUrls,
                                        Double temperature, Integer maxTokens, boolean stream) {
        return buildRequestBody(model, systemPrompt, history, userMessage, imageUrls, temperature, maxTokens, stream, null, null);
    }

    /** 支持 Vision 图片 + 深度思考的请求体构建 */
    private ObjectNode buildRequestBody(String model, String systemPrompt,
                                        List<Map<String, String>> history,
                                        String userMessage,
                                        List<String> imageUrls,
                                        Double temperature, Integer maxTokens, boolean stream,
                                        Boolean thinking, Integer thinkingBudget) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("model", model);
        body.put("temperature", temperature != null ? temperature : 0.7);
        body.put("max_tokens", maxTokens != null ? maxTokens : 8192);
        body.put("stream", stream);
        if (stream) {
            // 正确写法：stream_options 是嵌套对象
            ObjectNode streamOptions = objectMapper.createObjectNode();
            streamOptions.put("include_usage", true);
            body.set("stream_options", streamOptions);
        }

        // 深度思考参数（各适配器 transformRequest 时会按厂商格式转换）
        if (thinking != null && thinking) {
            body.put("_thinking", true);
            if (thinkingBudget != null) {
                body.put("_thinking_budget", thinkingBudget);
            }
        }

        ArrayNode messages = body.putArray("messages");
        // 1. system prompt（自动附加项目格式规范）
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.addObject().put("role", "system").put("content", enhanceSystemPrompt(systemPrompt));
        }
        // 2. 历史消息（按时间正序，role=user/assistant 交替）
        if (history != null) {
            for (Map<String, String> msg : history) {
                String role = msg.get("role");
                String content = msg.get("content");
                if (role != null && content != null && !content.isBlank()) {
                    messages.addObject().put("role", role).put("content", content);
                }
            }
        }
        // 3. 当前用户消息（支持 Vision 图片格式）
        if (imageUrls != null && !imageUrls.isEmpty()) {
            // Vision 格式：content 是 [{"type":"text","text":"..."}, {"type":"image_url","image_url":{"url":"..."}}]
            ArrayNode contentArray = objectMapper.createArrayNode();
            if (userMessage != null && !userMessage.isEmpty()) {
                contentArray.addObject().put("type", "text").put("text", userMessage);
            }
            for (String url : imageUrls) {
                ObjectNode imageNode = contentArray.addObject();
                imageNode.put("type", "image_url");
                ObjectNode imageUrlNode = imageNode.putObject("image_url");
                imageUrlNode.put("url", url);
            }
            messages.addObject().put("role", "user").set("content", contentArray);
        } else {
            messages.addObject().put("role", "user").put("content", userMessage);
        }
        applyPromptCacheKey(body);
        return body;
    }

    private void applyPromptCacheKey(ObjectNode body) {
        String promptCacheKey = promptCacheKeyHolder.get();
        if (promptCacheKey == null || promptCacheKey.isBlank()) {
            return;
        }
        body.put("prompt_cache_key", promptCacheKey);
        body.put("_autocode_prompt_cache_key", promptCacheKey);
    }

    private String buildUrl(String baseUrl) {
        String url = baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
        return url;
    }

    private ChannelConfig resolveChannel(String model) {
        return resolveChannelByType(model, "chat");
    }

    /** 按渠道类型选择渠道（chat / translate / tts），并执行限流检查 */
    public ChannelConfig resolveChannelByType(String model, String channelType) {
        // 先找指定类型的渠道
        List<ModelChannel> typed = channelMapper.selectList(
                new QueryWrapper<ModelChannel>()
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .eq("channel_type", channelType)
                        .orderByAsc("priority"));

        // 如果没有专用渠道，回退到 chat 渠道
        List<ModelChannel> channels = typed.isEmpty()
                ? channelMapper.selectList(new QueryWrapper<ModelChannel>().eq("status", "active").eq("deleted", 0).orderByAsc("priority"))
                : typed;

        if (model != null && !model.isBlank()) {
            for (ModelChannel ch : channels) {
                if (isValidApiKey(ch.getApiKey()) && ch.getModels() != null && ch.getModels().contains(model)) {
                    checkRateLimit(ch);
                    // 使用匹配到的模型名作为实际 API 模型名
                    return new ChannelConfig(ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()),
                            model, ch.getProvider());
                }
            }
        }
        // 第二轮回退：指定模型的渠道不可用，使用任意可用渠道的自身实际模型
        for (ModelChannel ch : channels) {
            if (isValidApiKey(ch.getApiKey())) {
                // 从 models 字段解析第一个模型作为实际 API 模型名
                String actualModel = parseFirstModel(ch.getModels());
                checkRateLimit(ch);
                log.info("[AiService] 模型 {} 在活跃渠道中未找到，回退使用渠道 {} 的实际模型: {}", model, ch.getName(), actualModel);
                return new ChannelConfig(ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()),
                        actualModel, ch.getProvider());
            }
        }
        if (defaultApiKey == null || defaultApiKey.isBlank()) {
            throw new RuntimeException("未配置 " + channelType + " 渠道，请在管理后台添加对应类型的渠道");
        }
        // 最终回退：使用 defaultModel 而非原始 model
        log.info("[AiService] 模型 {} 无可用渠道，最终回退使用默认模型: {}", model, defaultModel);
        return new ChannelConfig(null, defaultApiKey, defaultBaseUrl, defaultModel, "OpenAI");
    }

    /**
     * 解析模型的所有可用渠道（按优先级排序），用于降级重试
     * 返回渠道列表，每个渠道都带有其自身支持的实际模型名
     */
    private List<ChannelConfig> resolveAllChannels(String model, String channelType) {
        List<ChannelConfig> result = new ArrayList<>();

        // 先找指定类型的渠道
        List<ModelChannel> typed = channelMapper.selectList(
                new QueryWrapper<ModelChannel>()
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .eq("channel_type", channelType)
                        .orderByAsc("priority"));

        // 如果没有专用渠道，回退到 chat 渠道
        List<ModelChannel> channels = typed.isEmpty()
                ? channelMapper.selectList(new QueryWrapper<ModelChannel>().eq("status", "active").eq("deleted", 0).orderByAsc("priority"))
                : typed;

        Set<Long> seenIds = new HashSet<>();

        if (model != null && !model.isBlank()) {
            // 第一优先：精确匹配模型的渠道
            // 注意：ChannelConfig 第4个参数是实际发给 API 的模型名
            for (ModelChannel ch : channels) {
                if (isValidApiKey(ch.getApiKey()) && ch.getModels() != null && ch.getModels().contains(model)) {
                    if (seenIds.add(ch.getId())) {
                        try { checkRateLimit(ch); } catch (Exception e) { continue; }
                        // 匹配成功：用用户指定的模型名（它一定被该渠道支持）
                        result.add(new ChannelConfig(ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()),
                                model, ch.getProvider()));
                    }
                }
            }
        }
        // 第二优先：其他可用渠道（使用渠道自身配置的实际模型名）
        for (ModelChannel ch : channels) {
            if (isValidApiKey(ch.getApiKey()) && seenIds.add(ch.getId())) {
                try { checkRateLimit(ch); } catch (Exception e) { continue; }
                // 使用渠道自身 models 字段的第一个模型作为实际 API 模型名
                String actualModel = parseFirstModel(ch.getModels());
                result.add(new ChannelConfig(ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()),
                        actualModel, ch.getProvider()));
            }
        }
        // 最终兜底：默认 API（用默认渠道的第一个模型名）
        if (result.isEmpty() && defaultApiKey != null && !defaultApiKey.isBlank()) {
            String fallbackModel = defaultModel;
            // 尝试从数据库中取一个可用渠道的实际模型名
            List<ModelChannel> activeChannels = channelMapper.selectList(
                    new QueryWrapper<ModelChannel>().eq("status", "active").eq("deleted", 0).last("LIMIT 1"));
            if (!activeChannels.isEmpty()) {
                fallbackModel = parseFirstModel(activeChannels.get(0).getModels());
            }
            result.add(new ChannelConfig(null, defaultApiKey, defaultBaseUrl, fallbackModel, "OpenAI"));
        }
        return result;
    }

    /**
     * 判断 HTTP 状态码是否为可重试错误（应触发降级切换到下一个渠道）
     * 包含 400：模型名不被支持时，应切换到下一个渠道（该渠道可能不支持此模型）
     */
    private boolean isRetriableStatusCode(int statusCode) {
        return statusCode >= 400 && statusCode != 401 && statusCode != 403 && statusCode != 404;
    }

    /**
     * 检查渠道限流，超限则抛出异常（非阻塞）
     * rate_limit 字段含义：每分钟最大请求数（0 或 null 表示不限流）
     */
    private void checkRateLimit(ModelChannel channel) {
        if (channel.getRateLimit() == null || channel.getRateLimit() <= 0) {
            return; // 0 表示不限流
        }
        TokenBucket bucket = rateLimiterMap.computeIfAbsent(
            channel.getId(),
            id -> new TokenBucket(channel.getRateLimit())
        );
        if (!bucket.tryAcquire()) {
            long waitMs = bucket.millisUntilNextToken();
            log.warn("[RateLimit] 渠道 '{}' 超出限流 {}/min，需等待 {}ms",
                    channel.getName(), channel.getRateLimit(), waitMs);
            throw new RuntimeException(
                String.format("请求过于频繁，渠道 '%s' 每分钟最多 %d 次请求，请 %.1f 秒后重试",
                    channel.getName(), channel.getRateLimit(), waitMs / 1000.0)
            );
        }
        log.debug("[RateLimit] 渠道 '{}' 通过限流检查，剩余令牌已减少", channel.getName());
    }

    /**
     * 从 models 字段（逗号分隔字符串）解析第一个模型名作为实际 API 模型名
     */
    private String parseFirstModel(String modelsStr) {
        if (modelsStr == null || modelsStr.isBlank()) return defaultModel;
        String[] parts = modelsStr.split(",");
        return parts[0].trim();
    }

    /**
     * 从 models 字段中选出第一个图片生成模型（排除 vision 等非图片生成模型）
     * 识别关键词：qwen-image, wan2, wanx, dall-e, stable-diffusion, sdxl
     */
    private String parseFirstImageModel(String modelsStr) {
        if (modelsStr == null || modelsStr.isBlank()) return defaultModel;
        String[] parts = modelsStr.split(",");
        for (String p : parts) {
            String m = p.trim().toLowerCase();
            if (m.contains("qwen-image") || m.contains("wan2") || m.contains("wanx")
                || m.contains("dall-e") || m.contains("dall_e") || m.contains("stable-diffusion")
                || m.contains("sdxl") || m.contains("sd-") || m.contains("flux")) {
                return p.trim();
            }
        }
        // 没匹配到已知图片模型名，返回第一个
        return parts[0].trim();
    }

    /**
     * 自动禁用失败的渠道，防止后续请求继续使用
     */
    private void disableChannel(Long channelId, String reason) {
        try {
            ModelChannel ch = channelMapper.selectById(channelId);
            if (ch != null && !"disabled".equals(ch.getStatus()) && !"error".equals(ch.getStatus())) {
                ch.setStatus("error");
                channelMapper.updateById(ch);
                log.warn("[Channel] 自动禁用渠道: id={}, name={}, reason={}", channelId, ch.getName(), reason);
                // 清除限流器缓存
                rateLimiterMap.remove(channelId);
            }
        } catch (Exception e) {
            log.error("[Channel] 自动禁用渠道失败: id={}, error={}", channelId, e.getMessage());
        }
    }

    /**
     * 翻译专用调用（使用 translate 类型渠道）
     * <p>
     * Phase 4: 通过 {@link com.aiplatform.backend.service.provider.TranslateAdapterFactory}
     * 分发到对应供应商的翻译适配器，翻译逻辑（prompt 构建、API 调用、响应提取）封装在适配器内。
     */
    public AiResult translateWithChannel(String text, String targetLang) {
        ChannelConfig channel = resolveChannelByType(null, "translate");

        // Phase 5: 通过 AdapterFactory 统一工厂分发到对应供应商的翻译适配器
        com.aiplatform.backend.service.provider.TranslateAdapter adapter =
            AdapterFactory.getTranslateAdapter(channel.provider);

        String baseUrl = channel.baseUrl;
        if (baseUrl == null) baseUrl = defaultBaseUrl;

        log.info("[AiService] 翻译: provider={}, model={}, targetLang={}, adapter={}",
                 channel.provider, channel.model, targetLang, adapter.getClass().getSimpleName());

        try {
            var result = adapter.translate(baseUrl, channel.apiKey, channel.model, text, targetLang);
            return new AiResult(result.content(), result.inputTokens(), result.outputTokens(),
                                result.latencyMs(), channel.model, null);
        } catch (RuntimeException e) { throw e; }
        catch (Exception e) { throw new RuntimeException("翻译调用失败: " + e.getMessage()); }
    }

    /** TTS 专用调用（使用 tts 类型渠道），返回 base64 MP3 */
    public String textToSpeechWithChannel(String text, String voice) {
        ChannelConfig channel = resolveChannelByType(null, "tts");
        return doTtsRequest(channel, text, voice);
    }

    /**
     * TTS 调用（指定渠道标识）— 用于预览时使用当前编辑的渠道。
     * 前端传入渠道标识（UUID 或数字 ID 字符串），后端查找匹配的渠道。
     *
     * @param channelIdentifier 渠道 UUID（如 "ch-uuid-0005"）或数字 ID 字符串（如 "3"）
     * @param text              预览文本
     * @param voice             音色 ID
     * @return base64 编码的音频数据
     */
    public String textToSpeechByChannelIdentifier(String channelIdentifier, String text, String voice) {
        // 先尝试按 UUID 查找，再尝试按数字 ID 查找
        ModelChannel ch = channelMapper.selectOne(
                new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelChannel>()
                        .eq("uuid", channelIdentifier).eq("deleted", 0));
        if (ch == null) {
            // 尝试按数字 ID 解析
            try {
                Long numericId = Long.parseLong(channelIdentifier);
                ch = channelMapper.selectById(numericId);
            } catch (NumberFormatException ignored) {
                // 不是数字，跳过
            }
        }
        if (ch == null || ch.getDeleted() == null || ch.getDeleted() != 0) {
            throw new RuntimeException("渠道不存在或已删除 (identifier=" + channelIdentifier + ")");
        }
        if (!"active".equals(ch.getStatus()) && !"enabled".equals(ch.getStatus())) {
            throw new RuntimeException("渠道 '" + ch.getName() + "' 状态非活跃，当前状态: " + ch.getStatus());
        }
        if (!isValidApiKey(ch.getApiKey())) {
            throw new RuntimeException("渠道 '" + ch.getName() + "' 的 API Key 无效，请检查配置");
        }
        // 使用渠道配置的第一个模型作为 TTS 模型
        String model = ch.getModels() != null && !ch.getModels().isEmpty()
                ? ch.getModels().split("[,;]")[0].trim()
                : defaultModel;
        ChannelConfig channelConfig = new ChannelConfig(
                ch.getId(), ch.getApiKey(), normalizeBaseUrl(ch.getBaseUrl()),
                model, ch.getProvider());
        checkRateLimit(ch);
        log.info("[TTS Preview] 使用指定渠道: identifier={}, id={}, name={}, provider={}, baseUrl={}, model={}, voice={}",
                channelIdentifier, ch.getId(), ch.getName(), ch.getProvider(), channelConfig.baseUrl(), model, voice);
        return doTtsRequest(channelConfig, text, voice);
    }

    /** 执行实际的 TTS HTTP 请求（统一入口） */
    private String doTtsRequest(ChannelConfig channel, String text, String voice) {
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        if (!adapter.supportsTts()) {
            throw new RuntimeException(String.format(
                    "供应商 %s 不支持 TTS。当前渠道 provider=%s，请将渠道类型设为 TTS 并使用支持语音合成的模型（如 cosyvoice-v1、tts-1 等）",
                    channel.provider, channel.provider));
        }
        // 使用渠道配置的模型，而非硬编码 tts-1
        String ttsModel = channel.model() != null && !channel.model().isBlank()
                ? channel.model() : "tts-1";
        String url = adapter.ttsUrl(channel.baseUrl);
        log.info("[TTS] 发起请求: url={}, model={}, voice={}, provider={}", url, ttsModel, voice, channel.provider);
        try {
            // 通过适配器构建 TTS 请求体（不同供应商格式不同）
            String requestBody = adapter.transformTtsRequest(objectMapper, ttsModel, text, voice);
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url)).timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody));
            adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
            HttpRequest request = reqBuilder.build();
            HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() != 200) {
                String respBody = "";
                try { respBody = new String(response.body(), java.nio.charset.StandardCharsets.UTF_8); } catch (Exception ignored) {}
                throw new RuntimeException(String.format(
                        "TTS API 错误: HTTP %d | provider=%s | model=%s | url=%s | 响应: %s",
                        response.statusCode(), channel.provider, ttsModel, url,
                        respBody.length() > 300 ? respBody.substring(0, 300) : respBody));
            }
            // 通过适配器处理响应（OpenAI 直接返回二进制，阿里云返回 JSON 含音频 URL 需下载）
            byte[] audioBytes = adapter.processTtsResponse(response.body());
            return java.util.Base64.getEncoder().encodeToString(audioBytes);
        } catch (RuntimeException e) { throw e; }
        catch (Exception e) { throw new RuntimeException("TTS 调用失败: " + e.getMessage()); }
    }

    private boolean isValidApiKey(String key) {
        if (key == null || key.isBlank()) return false;
        if (key.contains("****") || key.contains("配置你的") || key.contains("your-")) return false;
        return key.length() >= 20;
    }

    public SearchAdapter.SearchResponse searchWeb(String query) {
        if (query == null || query.isBlank()) {
            return new SearchAdapter.SearchResponse("", "", 0, List.of(), "", "EMPTY_QUERY", "搜索词为空");
        }
        ModelChannel channel = resolveSearchChannel();
        if (channel == null) {
            return new SearchAdapter.SearchResponse(query, "", 0, List.of(), "", "NO_SEARCH_CHANNEL", "未配置搜索渠道");
        }
        try {
            SearchAdapter adapter = SearchAdapterFactory.getAdapter(channel.getProvider());
            return adapter.search(channel.getBaseUrl(), channel.getApiKey(), query.trim(), 8, 800, 2);
        } catch (Exception e) {
            log.warn("[Search] 联网搜索失败: provider={}, query={}, error={}", channel.getProvider(), query, e.getMessage());
            return new SearchAdapter.SearchResponse(query, channel.getProvider(), 0, List.of(), "", "SEARCH_ERROR", e.getMessage());
        }
    }

    public String buildSearchContext(SearchAdapter.SearchResponse response) {
        if (response == null || response.documents() == null || response.documents().isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        sb.append("以下是联网搜索结果，请基于这些信息回答，并在需要时引用来源标题或链接：\n");
        int index = 1;
        for (SearchAdapter.SearchDocument doc : response.documents()) {
            if (index > 8) break;
            sb.append("\n[").append(index).append("] ").append(nullToEmpty(doc.title())).append("\n");
            sb.append("URL: ").append(nullToEmpty(doc.url())).append("\n");
            if (doc.host() != null && doc.host().hostname() != null && !doc.host().hostname().isBlank()) {
                sb.append("来源: ").append(doc.host().hostname()).append("\n");
            }
            if (doc.publishTime() != null && !doc.publishTime().isBlank()) {
                sb.append("发布时间: ").append(doc.publishTime()).append("\n");
            }
            String snippet = doc.snippet() != null ? doc.snippet() : "";
            if (snippet.length() > 1200) snippet = snippet.substring(0, 1200) + "...";
            sb.append("摘要: ").append(snippet).append("\n");
            index++;
        }
        return sb.toString();
    }

    private ModelChannel resolveSearchChannel() {
        List<ModelChannel> channels = channelMapper.selectList(
                new QueryWrapper<ModelChannel>()
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .eq("channel_type", "search")
                        .orderByAsc("priority"));
        for (ModelChannel ch : channels) {
            if (isValidApiKey(ch.getApiKey())) {
                checkRateLimit(ch);
                return ch;
            }
        }
        return null;
    }

    private String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private String normalizeBaseUrl(String url) {
        if (url == null || url.isBlank()) return defaultBaseUrl;
        if (!url.contains("/v1") && !url.contains("/api/")) {
            return url.endsWith("/") ? url + "v1" : url + "/v1";
        }
        return url;
    }

    /**
     * 从请求体中提取所有 image_url 内容，调用 Vision 模型识别，把识别结果文字替换回消息内容。
     * <p>
     * 流程：
     * 1. 遍历 messages，找到包含 image_url 块的消息
     * 2. 对每张图片调用 callVisionForTool（内部会自动找支持 Vision 的模型）
     * 3. 把 image_url 块替换为识别结果文本
     * 4. 返回修改后的深拷贝（无图片则返回原 body 避免死循环）
     *
     * @param body 原始请求体
     * @return 替换图片为识别结果后的副本，或原 body（无图片/识别全部失败时）
     */
    private ObjectNode replaceImagesWithVisionRecognition(ObjectNode body) {
        try {
            // 先检查有没有 image_url
            boolean hasImages = false;
            JsonNode msgs = body.get("messages");
            if (msgs == null || !msgs.isArray()) return body;
            for (JsonNode msg : msgs) {
                JsonNode c = msg.get("content");
                if (c != null && c.isArray()) {
                    for (JsonNode blk : c) {
                        if ("image_url".equals(blk.path("type").asText(""))) {
                            hasImages = true;
                            break;
                        }
                    }
                }
                if (hasImages) break;
            }
            if (!hasImages) return body;

            // 找支持 Vision 的渠道（排除当前模型）
            String currentModel = body.path("model").asText("");
            List<ChannelConfig> visionChannels = resolveVisionChannels(currentModel);
            if (visionChannels.isEmpty()) {
                log.warn("[Vision] 无 Vision 候选渠道可用，跳过图片识别替换");
                return body;
            }

            ObjectNode copy = body.deepCopy();
            ArrayNode messagesCopy = (ArrayNode) copy.get("messages");
            boolean anyReplaced = false;

            for (JsonNode msgNode : messagesCopy) {
                JsonNode contentNode = msgNode.get("content");
                if (contentNode == null || !contentNode.isArray()) continue;

                ArrayNode contentArray = (ArrayNode) contentNode;
                ArrayNode newContent = objectMapper.createArrayNode();
                boolean msgModified = false;

                for (JsonNode block : contentArray) {
                    if (!"image_url".equals(block.path("type").asText(""))) {
                        newContent.add(block);
                        continue;
                    }

                    // 提取图片 base64
                    String imageUrl = block.path("image_url").path("url").asText("");
                    if (imageUrl.isBlank()) {
                        newContent.add(block);
                        continue;
                    }

                    // 解析 data URL
                    String base64Data = imageUrl;
                    String mimeType = "image/jpeg";
                    if (imageUrl.startsWith("data:")) {
                        int commaIdx = imageUrl.indexOf(',');
                        if (commaIdx > 0) {
                            String header = imageUrl.substring(5, commaIdx); // "image/jpeg;base64"
                            mimeType = header.contains(";") ? header.split(";")[0] : header;
                            base64Data = imageUrl.substring(commaIdx + 1);
                        }
                    }

                    // 调用 Vision 识别（自动找可用模型）
                    String recognitionPrompt = "请描述这张图片中的所有内容，包括文字、数字、表格等信息，尽量详细完整。如果是送货单/单据类图片，请识别所有字段和数值。";
                    String recognizedText = null;
                    for (ChannelConfig vc : visionChannels) {
                        try {
                            recognizedText = doVisionCall(vc, vc.model(), recognitionPrompt, base64Data, mimeType);
                            log.info("[Vision] 图片识别成功（模型={}），识别结果长度={}", vc.model(), recognizedText.length());
                            break;
                        } catch (Exception ex) {
                            log.warn("[Vision] 候选 {} 识别失败: {}", vc.model(), ex.getMessage());
                        }
                    }

                    if (recognizedText != null && !recognizedText.isBlank()) {
                        // 替换图片块为识别结果文本
                        String replacementText = "[图片识别结果（由 Vision 模型识别）]\n" + recognizedText;
                        newContent.addObject().put("type", "text").put("text", replacementText);
                        msgModified = true;
                        anyReplaced = true;
                    } else {
                        // 识别失败，使用占位符
                        newContent.addObject().put("type", "text").put("text", "[图片无法识别：当前无可用的 Vision 模型]");
                        msgModified = true;
                        anyReplaced = true;
                    }
                }

                if (msgModified) {
                    ((ObjectNode) msgNode).set("content", newContent);
                }
            }

            return anyReplaced ? copy : body;
        } catch (Exception e) {
            log.warn("[Vision] 图片识别替换时出错: {}", e.getMessage());
            return body;
        }
    }

    /**
     * 从请求体的 messages 中剥除所有 image_url 内容块，只保留 text 块。
     * 用于降级处理：当模型不支持 Vision 时自动降级为纯文本。
     *
     * @param body 原始请求体
     * @return 修改后的副本（如果有修改），或原 body（如果无图片内容，不触发重试）
     */
    private ObjectNode stripImageUrlFromMessages(ObjectNode body) {
        try {
            // 深拷贝，不修改原始 body
            ObjectNode copy = body.deepCopy();
            ArrayNode messages = (ArrayNode) copy.get("messages");
            if (messages == null) return body;

            boolean modified = false;
            for (JsonNode msgNode : messages) {
                JsonNode contentNode = msgNode.get("content");
                if (contentNode == null || !contentNode.isArray()) continue;

                ArrayNode contentArray = (ArrayNode) contentNode;
                ArrayNode stripped = objectMapper.createArrayNode();
                boolean hadImage = false;

                for (JsonNode block : contentArray) {
                    String type = block.path("type").asText("");
                    if ("image_url".equals(type)) {
                        hadImage = true;
                        // 用占位文本替代图片，让 LLM 知道原来有图片
                        stripped.addObject().put("type", "text").put("text", "[图片已省略，当前模型不支持图片输入]");
                    } else {
                        stripped.add(block);
                    }
                }

                if (hadImage) {
                    ((ObjectNode) msgNode).set("content", stripped);
                    modified = true;
                }
            }

            return modified ? copy : body;
        } catch (Exception e) {
            log.warn("[Agent] 剥除 image_url 时出错: {}", e.getMessage());
            return body;
        }
    }

    /**
     * 从错误消息中提取 HTTP 状态码
     * 支持格式: "HTTP 500 - ..." 或 "HTTP 429..."
     */
    private int extractStatusCode(String errMsg) {
        if (errMsg == null) return 0;
        java.util.regex.Pattern p = java.util.regex.Pattern.compile("HTTP\\s+(\\d{3})");
        java.util.regex.Matcher m = p.matcher(errMsg);
        if (m.find()) {
            try { return Integer.parseInt(m.group(1)); } catch (Exception ignored) {}
        }
        return 0;
    }

    private String extractErrorMessage(String body) {
        try {
            JsonNode node = objectMapper.readTree(body);
            JsonNode errMsg = node.path("error").path("message");
            if (!errMsg.isMissingNode()) return errMsg.asText();
        } catch (Exception ignored) {}
        return body.length() > 200 ? body.substring(0, 200) : body;
    }

    /**
     * 伪工具调用解析结果
     */
    private record ParsedToolCall(String toolCallId, String toolName, String arguments) {}

    /**
     * 解析文本中的伪工具调用（当 API 不支持 Function Calling 时的降级方案）
     * <p>
     * 支持的格式：
     * 1. ```tool\ntool_name({"param": "value"})\n```
     * 2. ```function\ntool_name({"param": "value"})\n```
     * 3. ```json\n{"tool": "tool_name", "arguments": {...}}\n```
     * 4. 行内格式：tool_name({"param": "value"})
     *
     * @param content LLM 返回的文本内容
     * @param tools   可用工具列表（用于校验工具名称是否合法）
     * @return 解析出的工具调用列表，可能为空
     */
    private List<ParsedToolCall> parsePseudoToolCalls(String content, List<ToolDefinition> tools) {
        if (content == null || content.isEmpty() || tools == null || tools.isEmpty()) {
            return List.of();
        }

        // 收集合法的工具名称
        Set<String> validToolNames = tools.stream()
                .map(ToolDefinition::name)
                .collect(java.util.stream.Collectors.toSet());

        List<ParsedToolCall> results = new ArrayList<>();

        // 格式1/2: ```tool 或 ```function 代码块中的 tool_name({...})
        // 匹配: ```tool\nupload_kg_table({"file_path": "xxx"})\n```
        java.util.regex.Pattern codeBlockPattern = java.util.regex.Pattern.compile(
            "```(?:tool|function)\\s*\\n\\s*(\\w+)\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)\\s*\\n\\s*```",
            java.util.regex.Pattern.MULTILINE
        );
        java.util.regex.Matcher codeBlockMatcher = codeBlockPattern.matcher(content);
        while (codeBlockMatcher.find()) {
            String toolName = codeBlockMatcher.group(1).trim();
            String args = codeBlockMatcher.group(2).trim();
            if (validToolNames.contains(toolName)) {
                String toolCallId = "pseudo_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
                results.add(new ParsedToolCall(toolCallId, toolName, args));
                log.info("[Agent] 解析到伪工具调用（代码块格式）: {} args长度={}", toolName, args.length());
            } else {
                log.warn("[Agent] 忽略未知的伪工具调用: {}", toolName);
            }
        }

        // 格式3: ```json 代码块中的 {"tool": "name", "arguments": {...}}
        java.util.regex.Pattern jsonBlockPattern = java.util.regex.Pattern.compile(
            "```json\\s*\\n\\s*(\\{[\\s\\S]*?\\})\\s*\\n\\s*```",
            java.util.regex.Pattern.MULTILINE
        );
        java.util.regex.Matcher jsonBlockMatcher = jsonBlockPattern.matcher(content);
        while (jsonBlockMatcher.find()) {
            try {
                JsonNode json = objectMapper.readTree(jsonBlockMatcher.group(1));
                String toolName = json.path("tool").asText(json.path("name").asText(""));
                String args = json.has("arguments")
                        ? objectMapper.writeValueAsString(json.get("arguments"))
                        : json.path("parameters").toString();
                if (validToolNames.contains(toolName) && !toolName.isEmpty()) {
                    String toolCallId = "pseudo_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
                    results.add(new ParsedToolCall(toolCallId, toolName, args));
                    log.info("[Agent] 解析到伪工具调用（JSON格式）: {} args长度={}", toolName, args.length());
                }
            } catch (Exception e) {
                log.debug("[Agent] 解析 JSON 代码块失败: {}", e.getMessage());
            }
        }

        // 格式4: 行内 tool_name({...})  （排除已被代码块匹配的部分）
        if (results.isEmpty()) {
            java.util.regex.Pattern inlinePattern = java.util.regex.Pattern.compile(
                "\\b(\\w+)\\s*\\(\\s*(\\{[^}]*\\})\\s*\\)"
            );
            java.util.regex.Matcher inlineMatcher = inlinePattern.matcher(content);
            while (inlineMatcher.find()) {
                String toolName = inlineMatcher.group(1).trim();
                String args = inlineMatcher.group(2).trim();
                if (validToolNames.contains(toolName)) {
                    // 验证 args 是合法 JSON
                    try {
                        objectMapper.readTree(args);
                        String toolCallId = "pseudo_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
                        results.add(new ParsedToolCall(toolCallId, toolName, args));
                        log.info("[Agent] 解析到伪工具调用（行内格式）: {}", toolName);
                    } catch (Exception e) {
                        log.debug("[Agent] 行内参数不是合法 JSON: {}", args);
                    }
                }
            }
        }

        return results;
    }

    private void emitThinkingDelta(ProviderAdapter.StreamContext ctx, int previousLength) {
        Consumer<String> consumer = thinkingTokenConsumer.get();
        if (consumer == null || ctx == null || ctx.thinkingBuilder.length() <= previousLength) return;
        String delta = ctx.thinkingBuilder.substring(previousLength);
        if (!delta.isEmpty()) consumer.accept(delta);
    }

    @FunctionalInterface
    public interface StreamDoneCallback {
        void accept(String content, int inputTokens, int outputTokens, int cachedInputTokens,
                    int latencyMs, String model, String thinkingContent);

        default void accept(String content, int inputTokens, int outputTokens,
                            int latencyMs, String model, String thinkingContent) {
            accept(content, inputTokens, outputTokens, 0, latencyMs, model, thinkingContent);
        }
    }

    public record AiResult(String content, int inputTokens, int outputTokens, int latencyMs, String model,
                           String thinkingContent, int cachedInputTokens) {
        public AiResult(String content, int inputTokens, int outputTokens, int latencyMs, String model,
                        String thinkingContent) {
            this(content, inputTokens, outputTokens, latencyMs, model, thinkingContent, 0);
        }
    }

    /** 流式请求结果（用于降级重试 + 自动续写判断） */
    private record StreamResult(String fullContent, int inputTokens, int outputTokens, int cachedInputTokens,
                                int latencyMs, String usedModel, String thinkingContent, String finishReason) {}

    public record UsedChannel(Long channelId, String provider) {}

    private record ChannelConfig(Long channelId, String apiKey, String baseUrl, String model, String provider) {}

    /**
     * 清除指定渠道的令牌桶缓存（当渠道 rate_limit 被修改时调用，确保新值立即生效）
     */
    public void evictRateLimiter(Long channelId) {
        if (channelId != null) {
            rateLimiterMap.remove(channelId);
        }
    }

    /**
     * OpenAI TTS API，返回 base64 编码的 MP3
     */
    public String textToSpeech(String text, String voice) {
        ChannelConfig channel = resolveChannel(null);
        ProviderAdapter adapter = AdapterFactory.getProviderAdapter(channel.provider);
        String url = adapter.supportsTts() ? adapter.ttsUrl(channel.baseUrl) : null;
        if (url == null) {
            throw new RuntimeException("供应商 " + channel.provider + " 不支持 TTS");
        }

        try {
            String requestBody = String.format(
                    "{\"model\":\"tts-1\",\"input\":\"%s\",\"voice\":\"%s\"}",
                    text.replace("\"", "\\\"").replace("\n", "\\n"),
                    voice
            );

            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build();
            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(60))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody));
            adapter.authHeaders(channel.apiKey).forEach((k, v) -> reqBuilder.header(k, v));
            HttpRequest request = reqBuilder.build();

            HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() != 200) {
                throw new RuntimeException("TTS API 返回错误: HTTP " + response.statusCode());
            }
            return java.util.Base64.getEncoder().encodeToString(response.body());
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("TTS 调用失败: " + e.getMessage());
        }
    }

    // ==================== 语音转文字 (ASR) ====================

    /**
     * 语音转文字 — 通过 asr 渠道类型自动选择提供商
     * 支持提供商：Alibaba(DashScope qwen3-asr-flash)、OpenAI(Whisper)
     * 注：paraformer-v2 等异步模型会自动降级为 qwen3-asr-flash 同步模式
     *
     * @param fileUrl 音频文件 URL（公网可访问或本地服务 URL，sync 模式也支持 base64）
     * @return 识别出的文字
     */
    public String speechToText(String fileUrl) {
        ChannelConfig channel = resolveChannelByType(null, "asr");
        log.info("[ASR] 使用渠道: provider={}, model={}, baseUrl={}", channel.provider, channel.model, channel.baseUrl);
        VoiceAdapter adapter = AdapterFactory.getVoiceAdapter(channel.provider);
        if (!adapter.supportsAsr()) {
            throw new RuntimeException("供应商 " + channel.provider + " 不支持 ASR，请在管理后台配置支持 ASR 的渠道");
        }
        try {
            return adapter.speechToText(fileUrl, channel.apiKey(), channel.baseUrl(), channel.model());
        } catch (Exception e) {
            throw new RuntimeException("语音识别失败: " + e.getMessage(), e);
        }
    }

    /**
     * 语音转文字 — 直接接收音频字节（用于 HTTP 环境无法访问麦克风时的文件上传方案）
     * 支持提供商：Alibaba(qwen3-asr-flash)、OpenAI(Whisper)
     * 注：paraformer-v2 等异步模型会自动降级为 qwen3-asr-flash 同步模式
     *
     * @param audioData 音频文件字节数据
     * @param fileName  音频文件名（含扩展名，如 "voice.mp3"）
     * @return 识别出的文字
     */
    public String speechToTextFromBytes(byte[] audioData, String fileName) {
        ChannelConfig channel = resolveChannelByType(null, "asr");
        log.info("[ASR] 使用渠道(字节模式): provider={}, model={}", channel.provider, channel.model);
        VoiceAdapter adapter = AdapterFactory.getVoiceAdapter(channel.provider);
        if (!adapter.supportsAsr()) {
            throw new RuntimeException("供应商 " + channel.provider + " 不支持 ASR，请在管理后台配置支持 ASR 的渠道");
        }
        try {
            return adapter.speechToTextFromBytes(audioData, fileName, channel.apiKey(), channel.baseUrl(), channel.model());
        } catch (Exception e) {
            throw new RuntimeException("语音识别失败: " + e.getMessage(), e);
        }
    }


    /**
     * 生成图片（图标生成等场景使用）
     * @param prompt 图片描述提示词
     * @param size   图片尺寸，如 "1024x1024"（默认 "1024x1024"）
     * @return 图片 URL 或 base64 data URI
     */
    public String generateImage(String prompt, String size) {
        // 直接查询 channel_type='image' 的活跃渠道（按优先级排序）
        List<ModelChannel> imageChannels = channelMapper.selectList(
            new QueryWrapper<ModelChannel>()
                .eq("channel_type", "image")
                .eq("status", "active")
                .eq("deleted", 0)
                .orderByAsc("priority")
        );
        if (imageChannels == null || imageChannels.isEmpty()) {
            throw new RuntimeException("未找到图片生成渠道，请在管理后台添加渠道用途为「图片生成」的渠道");
        }

        // 构建 ChannelConfig 列表，每个渠道使用其自身的图片模型
        List<ChannelConfig> candidates = new ArrayList<>();
        for (ModelChannel ch : imageChannels) {
            String actualModel = parseFirstImageModel(ch.getModels());
            checkRateLimit(ch);
            candidates.add(new ChannelConfig(
                ch.getId(),
                ch.getApiKey(),
                normalizeBaseUrl(ch.getBaseUrl()),
                actualModel,
                ch.getProvider()
            ));
        }
        log.info("[AiService] 图片生成候选渠道 {} 个", candidates.size());

        // 多渠道降级重试
        Exception lastEx = null;
        for (ChannelConfig channel : candidates) {
            try {
                log.info("[AiService] 尝试图片生成: provider={}, model={}", channel.provider, channel.model);
                return doImageRequest(channel, channel.model, prompt, size != null ? size : "1024x1024");
            } catch (Exception e) {
                lastEx = e;
                log.warn("[AiService] 图片生成失败, 渠道={}, provider={}, 错误={}", channel.channelId, channel.provider, e.getMessage());
            }
        }
        throw new RuntimeException("所有图片生成渠道均失败: " + (lastEx != null ? lastEx.getMessage() : "未知错误"));
    }

    /**
     * 单次图片生成请求 — 通过 AdapterFactory 统一工厂分发到对应供应商适配器
     */
    private String doImageRequest(ChannelConfig channel, String model, String prompt, String size) throws Exception {
        String baseUrl = channel.baseUrl;
        if (baseUrl == null) baseUrl = defaultBaseUrl;

        // 通过 AdapterFactory 统一工厂选择对应的图片生成适配器（Phase 5: 统一入口）
        com.aiplatform.backend.service.provider.ImageAdapter adapter =
            AdapterFactory.getImageAdapter(channel.provider);

        log.info("[AiService] 图片生成: provider={}, model={}, adapter={}", channel.provider, model,
                 adapter.getClass().getSimpleName());

        return adapter.generateImage(baseUrl, channel.apiKey, model, prompt, size);
    }
}
