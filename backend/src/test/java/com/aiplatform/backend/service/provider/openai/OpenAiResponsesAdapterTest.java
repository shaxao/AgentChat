package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class OpenAiResponsesAdapterTest {

    private final OpenAiResponsesAdapter adapter = new OpenAiResponsesAdapter();
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void chatUrlAppendsResponsesPath() {
        assertThat(adapter.chatUrl("https://api.openai.com/v1", "gpt-4o", "k"))
                .isEqualTo("https://api.openai.com/v1/responses");
        assertThat(adapter.chatUrl("https://api.openai.com/v1/chat/completions", "gpt-4o", "k"))
                .isEqualTo("https://api.openai.com/v1/responses");
        assertThat(adapter.chatUrl("https://api.openai.com/v1/responses", "gpt-4o", "k"))
                .isEqualTo("https://api.openai.com/v1/responses");
    }

    @Test
    void transformRequestMovesSystemToInstructionsAndConvertsMessages() {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", "gpt-4o");
        body.put("max_tokens", 1024);
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "system").put("content", "You are helpful");
        messages.addObject().put("role", "user").put("content", "Hello");

        ObjectNode out = adapter.transformRequest(body, "OpenAI");

        assertThat(out.path("instructions").asText()).isEqualTo("You are helpful");
        assertThat(out.path("max_output_tokens").asInt()).isEqualTo(1024);
        assertThat(out.has("max_tokens")).isFalse();
        JsonNode input = out.path("input");
        assertThat(input).hasSize(1);
        assertThat(input.get(0).path("role").asText()).isEqualTo("user");
        assertThat(input.get(0).path("content").get(0).path("type").asText()).isEqualTo("input_text");
        assertThat(input.get(0).path("content").get(0).path("text").asText()).isEqualTo("Hello");
    }

    @Test
    void transformRequestFlattensToolsAndConvertsToolMessages() {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", "gpt-4o");
        ArrayNode messages = body.putArray("messages");
        // assistant with tool_calls
        ObjectNode assistant = messages.addObject();
        assistant.put("role", "assistant");
        assistant.put("content", "");
        ArrayNode tcs = assistant.putArray("tool_calls");
        ObjectNode tc = tcs.addObject();
        tc.put("id", "call_1");
        tc.put("type", "function");
        tc.putObject("function").put("name", "get_weather").put("arguments", "{\"city\":\"SF\"}");
        // tool result
        ObjectNode toolMsg = messages.addObject();
        toolMsg.put("role", "tool");
        toolMsg.put("tool_call_id", "call_1");
        toolMsg.put("content", "sunny");

        ArrayNode tools = body.putArray("tools");
        ObjectNode t = tools.addObject();
        t.put("type", "function");
        ObjectNode fn = t.putObject("function");
        fn.put("name", "get_weather");
        fn.put("description", "Get weather");
        fn.putObject("parameters").put("type", "object");

        ObjectNode out = adapter.transformRequest(body, "OpenAI");

        // tools flattened
        JsonNode outTools = out.path("tools");
        assertThat(outTools).hasSize(1);
        assertThat(outTools.get(0).path("type").asText()).isEqualTo("function");
        assertThat(outTools.get(0).path("name").asText()).isEqualTo("get_weather");
        assertThat(outTools.get(0).has("function")).isFalse();

        // input has function_call + function_call_output
        JsonNode input = out.path("input");
        assertThat(input).hasSize(2);
        assertThat(input.get(0).path("type").asText()).isEqualTo("function_call");
        assertThat(input.get(0).path("call_id").asText()).isEqualTo("call_1");
        assertThat(input.get(0).path("name").asText()).isEqualTo("get_weather");
        assertThat(input.get(1).path("type").asText()).isEqualTo("function_call_output");
        assertThat(input.get(1).path("call_id").asText()).isEqualTo("call_1");
        assertThat(input.get(1).path("output").asText()).isEqualTo("sunny");
    }

    @Test
    void normalizeResponseConvertsOutputToChoices() {
        ObjectNode resp = mapper.createObjectNode();
        resp.put("model", "gpt-4o");
        ArrayNode output = resp.putArray("output");
        ObjectNode message = output.addObject();
        message.put("type", "message");
        ArrayNode content = message.putArray("content");
        content.addObject().put("type", "output_text").put("text", "Hi there");
        ObjectNode usage = resp.putObject("usage");
        usage.put("input_tokens", 10);
        usage.put("output_tokens", 5);

        JsonNode norm = adapter.normalizeResponse(resp);
        JsonNode choice = norm.path("choices").path(0);
        assertThat(choice.path("message").path("content").asText()).isEqualTo("Hi there");
        assertThat(choice.path("finish_reason").asText()).isEqualTo("stop");
        assertThat(norm.path("usage").path("prompt_tokens").asInt()).isEqualTo(10);
        assertThat(norm.path("usage").path("completion_tokens").asInt()).isEqualTo(5);
    }

    @Test
    void normalizeResponseExtractsFunctionCall() {
        ObjectNode resp = mapper.createObjectNode();
        ArrayNode output = resp.putArray("output");
        ObjectNode fc = output.addObject();
        fc.put("type", "function_call");
        fc.put("call_id", "call_9");
        fc.put("name", "search");
        fc.put("arguments", "{\"q\":\"x\"}");

        JsonNode norm = adapter.normalizeResponse(resp);
        JsonNode choice = norm.path("choices").path(0);
        assertThat(choice.path("finish_reason").asText()).isEqualTo("tool_calls");
        JsonNode toolCalls = choice.path("message").path("tool_calls");
        assertThat(toolCalls).hasSize(1);
        assertThat(toolCalls.get(0).path("id").asText()).isEqualTo("call_9");
        assertThat(toolCalls.get(0).path("function").path("name").asText()).isEqualTo("search");
        assertThat(toolCalls.get(0).path("function").path("arguments").asText()).isEqualTo("{\"q\":\"x\"}");
    }

    @Test
    void normalizeResponseMapsIncompleteToLength() {
        ObjectNode resp = mapper.createObjectNode();
        resp.put("status", "incomplete");
        resp.putObject("incomplete_details").put("reason", "max_output_tokens");
        ArrayNode output = resp.putArray("output");
        ObjectNode message = output.addObject();
        message.put("type", "message");
        ArrayNode content = message.putArray("content");
        content.addObject().put("type", "output_text").put("text", "partial");

        JsonNode norm = adapter.normalizeResponse(resp);

        assertThat(norm.path("choices").path(0).path("finish_reason").asText()).isEqualTo("length");
        assertThat(norm.path("choices").path(0).path("message").path("content").asText()).isEqualTo("partial");
    }

    @Test
    void transformRequestPassesThroughCodingAgentOptions() {
        ObjectNode body = mapper.createObjectNode();
        body.put("model", "gpt-4o");
        body.put("top_p", 0.2);
        body.put("stop", "END");
        body.put("parallel_tool_calls", false);
        body.putObject("response_format").put("type", "json_object");
        ArrayNode messages = body.putArray("messages");
        messages.addObject().put("role", "user").put("content", "Return JSON");
        ArrayNode tools = body.putArray("tools");
        ObjectNode tool = tools.addObject();
        tool.put("type", "function");
        tool.putObject("function")
                .put("name", "write_file")
                .put("description", "Write a file")
                .putObject("parameters").put("type", "object");
        body.putObject("tool_choice").put("type", "function")
                .putObject("function").put("name", "write_file");

        ObjectNode out = adapter.transformRequest(body, "OpenAI");

        assertThat(out.path("top_p").asDouble()).isEqualTo(0.2);
        assertThat(out.path("stop").asText()).isEqualTo("END");
        assertThat(out.path("parallel_tool_calls").asBoolean()).isFalse();
        assertThat(out.path("text").path("format").path("type").asText()).isEqualTo("json_object");
        assertThat(out.path("tool_choice").path("type").asText()).isEqualTo("function");
        assertThat(out.path("tool_choice").path("function").path("name").asText()).isEqualTo("write_file");
    }

    @Test
    void streamAccumulatesTextAndToolCalls() {
        StreamContext ctx = new StreamContext();
        StringBuilder text = new StringBuilder();

        String delta1 = adapter.parseStreamLine("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}", ctx);
        if (delta1 != null) text.append(delta1);
        String delta2 = adapter.parseStreamLine("data: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}", ctx);
        if (delta2 != null) text.append(delta2);

        // function_call item added
        adapter.parseStreamLine("data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_5\",\"name\":\"lookup\"}}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"a\\\":\"}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"1}\"}", ctx);

        adapter.parseStreamLine("data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":8}}}", ctx);

        assertThat(text.toString()).isEqualTo("Hello");
        assertThat(adapter.isStreamDone(ctx)).isTrue();
        assertThat(ctx.finishReason).isEqualTo("tool_calls");
        assertThat(ctx.toolCallsBuilder).hasSize(1);
        assertThat(ctx.toolCallsBuilder.get(0).id).isEqualTo("call_5");
        assertThat(ctx.toolCallsBuilder.get(0).functionName).isEqualTo("lookup");
        assertThat(ctx.toolCallsBuilder.get(0).arguments.toString()).isEqualTo("{\"a\":1}");
        int[] usage = adapter.getStreamUsage(ctx);
        assertThat(usage).containsExactly(12, 8, 0);
    }

    @Test
    void streamIncompleteUsesLengthFinishReason() {
        StreamContext ctx = new StreamContext();

        adapter.parseStreamLine("data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_partial\",\"name\":\"edit\"}}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"path\\\":\\\"a\"}", ctx);
        adapter.parseStreamLine("data: {\"type\":\"response.incomplete\",\"response\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":4}}}", ctx);

        assertThat(adapter.isStreamDone(ctx)).isTrue();
        assertThat(ctx.finishReason).isEqualTo("length");
        assertThat(ctx.toolCallsBuilder).hasSize(1);
        assertThat(ctx.toolCallsBuilder.get(0).id).isEqualTo("call_partial");
        assertThat(ctx.toolCallsBuilder.get(0).functionName).isEqualTo("edit");
        assertThat(ctx.toolCallsBuilder.get(0).arguments.toString()).isEqualTo("{\"path\":\"a");
        assertThat(adapter.getStreamUsage(ctx)).containsExactly(9, 4, 0);
    }
}
