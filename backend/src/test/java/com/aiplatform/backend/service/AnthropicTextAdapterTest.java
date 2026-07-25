package com.aiplatform.backend.service;

import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.aiplatform.backend.service.provider.anthropic.AnthropicTextAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 出站 Anthropic 适配器测试：请求体转换 + 流式工具累积。
 */
class AnthropicTextAdapterTest {

    private final AnthropicTextAdapter adapter = new AnthropicTextAdapter();
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void transformRequestLiftsSystemAndConvertsTools() throws Exception {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", "claude-3-5-sonnet");
        body.put("max_tokens", 1024);
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "system").put("content", "You are helpful");
        messages.addObject().put("role", "user").put("content", "Hi");
        ArrayNode tools = body.putArray("tools");
        ObjectNode tool = tools.addObject();
        tool.put("type", "function");
        ObjectNode fn = tool.putObject("function");
        fn.put("name", "get_weather");
        fn.put("description", "Get weather");
        ObjectNode params = fn.putObject("parameters");
        params.put("type", "object");

        ObjectNode result = adapter.transformRequest(body, "Anthropic");

        assertThat(result.path("system").asText()).isEqualTo("You are helpful");
        // system 消息应从 messages 中移除
        assertThat(result.path("messages")).hasSize(1);
        assertThat(result.path("messages").get(0).path("role").asText()).isEqualTo("user");
        // tools 转为 Anthropic 扁平格式（name/description/input_schema）
        JsonNode anthTool = result.path("tools").get(0);
        assertThat(anthTool.path("name").asText()).isEqualTo("get_weather");
        assertThat(anthTool.path("input_schema").path("type").asText()).isEqualTo("object");
        assertThat(anthTool.has("function")).isFalse();
    }

    @Test
    void transformRequestConvertsToolCallsAndToolResults() throws Exception {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", "claude-3-5-sonnet");
        body.put("max_tokens", 1024);
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "user").put("content", "weather?");
        // assistant with tool_calls
        ObjectNode assistant = messages.addObject();
        assistant.put("role", "assistant");
        assistant.put("content", "");
        ArrayNode tcs = assistant.putArray("tool_calls");
        ObjectNode tc = tcs.addObject();
        tc.put("id", "call_1");
        tc.put("type", "function");
        ObjectNode fn = tc.putObject("function");
        fn.put("name", "get_weather");
        fn.put("arguments", "{\"city\":\"SF\"}");
        // tool result
        ObjectNode toolMsg = messages.addObject();
        toolMsg.put("role", "tool");
        toolMsg.put("tool_call_id", "call_1");
        toolMsg.put("content", "sunny");

        ObjectNode result = adapter.transformRequest(body, "Anthropic");

        JsonNode msgs = result.path("messages");
        assertThat(msgs).hasSize(3);
        // assistant → content 含 tool_use 块
        JsonNode assistantContent = msgs.get(1).path("content");
        assertThat(assistantContent.isArray()).isTrue();
        JsonNode toolUse = assistantContent.get(assistantContent.size() - 1);
        assertThat(toolUse.path("type").asText()).isEqualTo("tool_use");
        assertThat(toolUse.path("id").asText()).isEqualTo("call_1");
        assertThat(toolUse.path("name").asText()).isEqualTo("get_weather");
        assertThat(toolUse.path("input").path("city").asText()).isEqualTo("SF");
        // tool result → user 消息含 tool_result 块
        JsonNode trMsg = msgs.get(2);
        assertThat(trMsg.path("role").asText()).isEqualTo("user");
        JsonNode trBlock = trMsg.path("content").get(0);
        assertThat(trBlock.path("type").asText()).isEqualTo("tool_result");
        assertThat(trBlock.path("tool_use_id").asText()).isEqualTo("call_1");
        assertThat(trBlock.path("content").asText()).isEqualTo("sunny");
    }

    @Test
    void parseStreamAccumulatesToolUseAcrossEvents() {
        StreamContext ctx = new StreamContext();
        // Anthropic 流式 tool_use 序列
        adapter.parseStreamLine("event: content_block_start", ctx);
        adapter.parseStreamLine("data: {\"type\":\"content_block_start\",\"index\":0,"
                + "\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"get_weather\"}}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"content_block_delta\",\"index\":0,"
                + "\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\"}}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"content_block_delta\",\"index\":0,"
                + "\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"SF\\\"}\"}}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},"
                + "\"usage\":{\"output_tokens\":12}}", ctx);

        assertThat(ctx.toolCallsBuilder).hasSize(1);
        var stc = ctx.toolCallsBuilder.get(0);
        assertThat(stc.id).isEqualTo("toolu_1");
        assertThat(stc.functionName).isEqualTo("get_weather");
        assertThat(stc.arguments.toString()).isEqualTo("{\"city\":\"SF\"}");
        assertThat(ctx.finishReason).isEqualTo("tool_calls");
        assertThat(ctx.outputTokens).isEqualTo(12);
    }

    @Test
    void parseStreamReturnsTextDelta() {
        StreamContext ctx = new StreamContext();
        String text = adapter.parseStreamLine(
                "data: {\"type\":\"content_block_delta\",\"index\":0,"
                        + "\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}", ctx);
        assertThat(text).isEqualTo("Hello");
    }
}
