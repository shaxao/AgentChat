package com.aiplatform.backend.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

class OpenAiCompatibleControllerMappingTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void responsesToolRoleMessageKeepsToolCallIdWhenPriorCallExists() throws Exception {
        OpenAiCompatibleController controller = new OpenAiCompatibleController(
                null, null, null, null, null, null, null, null, mapper);
        Method method = OpenAiCompatibleController.class.getDeclaredMethod("responseToChatRequest", JsonNode.class);
        method.setAccessible(true);

        ObjectNode request = mapper.createObjectNode();
        request.put("model", "5.4-mini");
        ArrayNode input = request.putArray("input");
        ObjectNode assistant = input.addObject();
        assistant.put("type", "function_call");
        assistant.put("call_id", "call_123");
        assistant.put("name", "read_file");
        assistant.put("arguments", "{\"path\":\"README.md\"}");
        ObjectNode tool = input.addObject();
        tool.put("role", "tool");
        tool.put("tool_call_id", "call_123");
        tool.put("content", "file content");

        ObjectNode chat = (ObjectNode) method.invoke(controller, request);

        JsonNode messages = chat.path("messages");
        assertThat(messages).hasSize(2);
        assertThat(messages.get(1).path("role").asText()).isEqualTo("tool");
        assertThat(messages.get(1).path("tool_call_id").asText()).isEqualTo("call_123");
        assertThat(messages.get(1).path("content").asText()).isEqualTo("file content");
    }

    @Test
    void responsesToolRoleWithoutIdDowngradesToUserContext() throws Exception {
        OpenAiCompatibleController controller = new OpenAiCompatibleController(
                null, null, null, null, null, null, null, null, mapper);
        Method method = OpenAiCompatibleController.class.getDeclaredMethod("responseToChatRequest", JsonNode.class);
        method.setAccessible(true);

        ObjectNode request = mapper.createObjectNode();
        request.put("model", "5.4-mini");
        ArrayNode input = request.putArray("input");
        ObjectNode tool = input.addObject();
        tool.put("role", "tool");
        tool.put("content", "orphan tool result");

        ObjectNode chat = (ObjectNode) method.invoke(controller, request);

        JsonNode messages = chat.path("messages");
        assertThat(messages).hasSize(1);
        assertThat(messages.get(0).path("role").asText()).isEqualTo("user");
        assertThat(messages.get(0).has("tool_call_id")).isFalse();
        assertThat(messages.get(0).path("content").asText()).contains("orphan tool result");
    }

    @Test
    void responsesFormatKeepsRequestedModelWhenUpstreamReturnsSnapshotModel() throws Exception {
        OpenAiCompatibleController controller = new OpenAiCompatibleController(
                null, null, null, null, null, null, null, null, mapper);
        Method method = OpenAiCompatibleController.class.getDeclaredMethod("toResponsesFormat", JsonNode.class, JsonNode.class);
        method.setAccessible(true);

        ObjectNode raw = mapper.createObjectNode();
        raw.put("model", "gpt-5.4-mini-2026-03-17");
        ObjectNode choice = raw.putArray("choices").addObject();
        ObjectNode message = choice.putObject("message");
        message.put("role", "assistant");
        message.put("content", "ok");
        choice.put("finish_reason", "stop");
        raw.putObject("usage").put("prompt_tokens", 1).put("completion_tokens", 1);
        ObjectNode request = mapper.createObjectNode();
        request.put("model", "gpt-5.4-mini");

        ObjectNode response = (ObjectNode) method.invoke(controller, raw, request);

        assertThat(response.path("model").asText()).isEqualTo("gpt-5.4-mini");
    }

    @Test
    void previousResponseStateRestoresToolCallForNextToolOutputRound() throws Exception {
        OpenAiCompatibleController controller = new OpenAiCompatibleController(
                null, null, null, null, null, null, null, null, mapper);
        Method store = OpenAiCompatibleController.class.getDeclaredMethod("storeResponsesState", String.class, JsonNode.class, JsonNode.class);
        store.setAccessible(true);
        Method convert = OpenAiCompatibleController.class.getDeclaredMethod("responseToChatRequest", JsonNode.class);
        convert.setAccessible(true);

        ArrayNode previousMessages = mapper.createArrayNode();
        previousMessages.addObject().put("role", "user").put("content", "Use the tool");
        ObjectNode raw = mapper.createObjectNode();
        ObjectNode choice = raw.putArray("choices").addObject();
        ObjectNode assistant = choice.putObject("message");
        assistant.put("role", "assistant");
        assistant.put("content", "");
        ObjectNode toolCall = assistant.putArray("tool_calls").addObject();
        toolCall.put("id", "call_123");
        toolCall.put("type", "function");
        toolCall.putObject("function").put("name", "read_file").put("arguments", "{\"path\":\"README.md\"}");

        store.invoke(controller, "resp_local", previousMessages, raw);

        ObjectNode next = mapper.createObjectNode();
        next.put("model", "5.4-mini");
        next.put("previous_response_id", "resp_local");
        next.putArray("input").addObject()
                .put("type", "function_call_output")
                .put("call_id", "call_123")
                .put("output", "file content");

        ObjectNode chat = (ObjectNode) convert.invoke(controller, next);

        JsonNode messages = chat.path("messages");
        assertThat(messages).hasSize(3);
        assertThat(messages.get(1).path("role").asText()).isEqualTo("assistant");
        assertThat(messages.get(1).path("tool_calls").get(0).path("id").asText()).isEqualTo("call_123");
        assertThat(messages.get(2).path("role").asText()).isEqualTo("tool");
        assertThat(messages.get(2).path("tool_call_id").asText()).isEqualTo("call_123");
    }
}
