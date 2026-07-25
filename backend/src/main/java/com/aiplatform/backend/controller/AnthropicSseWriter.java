package com.aiplatform.backend.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.UUID;

/**
 * Anthropic Messages 流式事件写入器 — 按 Anthropic SSE 协议输出 content block 事件。
 * <p>
 * 事件序列（gateway 单轮）：
 * <pre>
 *   message_start
 *   [content_block_start(text) → content_block_delta(text_delta)* → content_block_stop]?
 *   [content_block_start(tool_use) → content_block_delta(input_json_delta) → content_block_stop]*
 *   message_delta(stop_reason, usage.output_tokens)
 *   message_stop
 * </pre>
 * <p>
 * 每个事件同时带 SSE 的 {@code event:} 名与 {@code data:} JSON（Anthropic 客户端依赖 event 名）。
 * content block 的 index 由本类维护：文本块固定 index=0（若存在），tool_use 块从其后递增。
 */
class AnthropicSseWriter {

    private final SseEmitter emitter;
    private final ObjectMapper mapper;
    private final String model;
    private final String messageId;

    private boolean textBlockOpen = false;
    private boolean textBlockClosed = false;
    private int nextIndex = 0;

    AnthropicSseWriter(SseEmitter emitter, ObjectMapper mapper, String model) {
        this.emitter = emitter;
        this.mapper = mapper;
        this.model = model;
        this.messageId = "msg_" + UUID.randomUUID().toString().replace("-", "");
    }

    /** message_start：空 content，usage 仅含 input_tokens 占位（Anthropic 规范里此处 output_tokens 通常为很小值）。 */
    void sendMessageStart() throws Exception {
        ObjectNode event = mapper.createObjectNode();
        event.put("type", "message_start");
        ObjectNode message = event.putObject("message");
        message.put("id", messageId);
        message.put("type", "message");
        message.put("role", "assistant");
        message.put("model", model);
        message.putArray("content");
        message.putNull("stop_reason");
        message.putNull("stop_sequence");
        ObjectNode usage = message.putObject("usage");
        usage.put("input_tokens", 0);
        usage.put("output_tokens", 0);
        send("message_start", event);
    }

    /** 首个文本 token 前发 content_block_start(text)，随后每个 token 发 text_delta。 */
    void onTextDelta(String token) {
        if (token == null || token.isEmpty()) return;
        try {
            if (!textBlockOpen && !textBlockClosed) {
                ObjectNode startEvent = mapper.createObjectNode();
                startEvent.put("type", "content_block_start");
                startEvent.put("index", 0);
                ObjectNode block = startEvent.putObject("content_block");
                block.put("type", "text");
                block.put("text", "");
                send("content_block_start", startEvent);
                textBlockOpen = true;
                nextIndex = 1;
            }
            if (textBlockClosed) return; // 文本块已关闭后不应再有 token（保险）
            ObjectNode deltaEvent = mapper.createObjectNode();
            deltaEvent.put("type", "content_block_delta");
            deltaEvent.put("index", 0);
            ObjectNode delta = deltaEvent.putObject("delta");
            delta.put("type", "text_delta");
            delta.put("text", token);
            send("content_block_delta", deltaEvent);
        } catch (Exception e) {
            // 静默：SSE 已断开时不应中断上游流
        }
    }

    /** 关闭文本块（若开启过）。在发送 tool_use 块或结束前调用。 */
    void closeTextBlockIfOpen() throws Exception {
        if (textBlockOpen && !textBlockClosed) {
            ObjectNode stopEvent = mapper.createObjectNode();
            stopEvent.put("type", "content_block_stop");
            stopEvent.put("index", 0);
            send("content_block_stop", stopEvent);
            textBlockClosed = true;
        }
    }

    /**
     * 发送一个完整 tool_use content block（start + 一次性 input_json_delta + stop）。
     * gateway 模式下 tool_calls 已从上游累积完整，无需逐片增量。
     */
    void sendToolUseBlock(String id, String name, String argumentsJson) throws Exception {
        int index = nextIndex++;
        ObjectNode startEvent = mapper.createObjectNode();
        startEvent.put("type", "content_block_start");
        startEvent.put("index", index);
        ObjectNode block = startEvent.putObject("content_block");
        block.put("type", "tool_use");
        block.put("id", id != null ? id : "");
        block.put("name", name != null ? name : "");
        block.putObject("input"); // 空对象占位，实际参数通过 input_json_delta 传
        send("content_block_start", startEvent);

        String partial = (argumentsJson == null || argumentsJson.isBlank()) ? "{}" : argumentsJson;
        ObjectNode deltaEvent = mapper.createObjectNode();
        deltaEvent.put("type", "content_block_delta");
        deltaEvent.put("index", index);
        ObjectNode delta = deltaEvent.putObject("delta");
        delta.put("type", "input_json_delta");
        delta.put("partial_json", partial);
        send("content_block_delta", deltaEvent);

        ObjectNode stopEvent = mapper.createObjectNode();
        stopEvent.put("type", "content_block_stop");
        stopEvent.put("index", index);
        send("content_block_stop", stopEvent);
    }

    /** message_delta：携带 stop_reason 与累计 output_tokens。 */
    void sendMessageDelta(String stopReason, int outputTokens) throws Exception {
        ObjectNode event = mapper.createObjectNode();
        event.put("type", "message_delta");
        ObjectNode delta = event.putObject("delta");
        delta.put("stop_reason", stopReason != null ? stopReason : "end_turn");
        delta.putNull("stop_sequence");
        ObjectNode usage = event.putObject("usage");
        usage.put("output_tokens", Math.max(0, outputTokens));
        send("message_delta", event);
    }

    void sendMessageStop() throws Exception {
        ObjectNode event = mapper.createObjectNode();
        event.put("type", "message_stop");
        send("message_stop", event);
    }

    /** 流式过程中出错：发送 Anthropic error 事件（best-effort）。 */
    void sendError(String message) {
        try {
            ObjectNode event = mapper.createObjectNode();
            event.put("type", "error");
            ObjectNode error = event.putObject("error");
            error.put("type", "api_error");
            error.put("message", message != null ? message : "stream failed");
            send("error", event);
        } catch (Exception ignored) {
        }
    }

    private void send(String eventName, ObjectNode data) throws Exception {
        emitter.send(SseEmitter.event().name(eventName).data(data, MediaType_APPLICATION_JSON));
    }

    // 避免额外 import：直接引用常量
    private static final org.springframework.http.MediaType MediaType_APPLICATION_JSON =
            org.springframework.http.MediaType.APPLICATION_JSON;
}
