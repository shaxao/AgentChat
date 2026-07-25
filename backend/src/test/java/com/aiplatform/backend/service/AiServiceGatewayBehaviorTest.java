package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AiServiceGatewayBehaviorTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void strictModelRoutingDoesNotFallbackToDifferentModel() throws Exception {
        ModelChannelMapper channelMapper = mock(ModelChannelMapper.class);
        when(channelMapper.selectList(any())).thenReturn(List.of(
                channel(1L, "new-api 5.4", "[\"5.4-mini\"]"),
                channel(2L, "deepseek fallback", "[\"deepseek-v4-flash\"]")
        ));
        AiService service = new AiService(channelMapper, null, mapper, null);
        Method method = AiService.class.getDeclaredMethod("resolveAllChannels", String.class, String.class, boolean.class);
        method.setAccessible(true);

        List<?> candidates = (List<?>) method.invoke(service, "5.4-mini", "chat", true);

        assertThat(candidates).hasSize(1);
        assertThat(channelModel(candidates.get(0))).isEqualTo("5.4-mini");
    }

    @Test
    void resolveGatewayChannelsFiltersApiFormat() {
        ModelChannelMapper channelMapper = mock(ModelChannelMapper.class);
        when(channelMapper.selectList(any())).thenReturn(List.of(
                channel(1L, "responses", "[\"5.4-mini\"]", "responses"),
                channel(2L, "chat", "[\"5.4-mini\"]", "chat_completions"),
                channel(3L, "messages", "[\"5.4-mini\"]", "messages")
        ));
        AiService service = new AiService(channelMapper, null, mapper, null);

        List<AiService.GatewayChannel> channels = service.resolveGatewayChannels("5.4-mini", Set.of("responses"));

        assertThat(channels).hasSize(1);
        assertThat(channels.get(0).apiFormat()).isEqualTo("responses");
    }

    @Test
    void nativeResponsesNonStreamPreservesResponsesPayload() throws Exception {
        AtomicReference<String> captured = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/responses", exchange -> {
            captured.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] payload = """
                    {"id":"resp_up","object":"response","status":"completed","model":"5.4-mini","error":null,"output_text":"ok","output":[],"usage":{"input_tokens":3,"output_tokens":2}}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, payload.length);
            exchange.getResponseBody().write(payload);
            exchange.close();
        });
        server.start();
        try {
            AiService service = new AiService(null, null, mapper, null);
            ObjectNode request = mapper.createObjectNode();
            request.put("model", "client-model");
            request.put("previous_response_id", "resp_prev");
            request.putArray("input").addObject().put("type", "function_call_output").put("call_id", "call_1").put("output", "done");
            request.putArray("tools").addObject().put("type", "function").put("name", "read_file");

            JsonNode response = service.responsesCompletionRawOnGatewayChannel(
                    gatewayChannel("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "responses"),
                    request,
                    5);

            JsonNode outbound = mapper.readTree(captured.get());
            assertThat(response.path("id").asText()).isEqualTo("resp_up");
            assertThat(outbound.path("model").asText()).isEqualTo("5.4-mini");
            assertThat(outbound.path("stream").asBoolean()).isFalse();
            assertThat(outbound.path("previous_response_id").asText()).isEqualTo("resp_prev");
            assertThat(outbound.path("input")).hasSize(1);
            assertThat(outbound.path("tools")).hasSize(1);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void nativeResponsesStreamRelaysTerminalAndAddsDone() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/responses", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] payload = """
                    event: response.output_text.delta
                    data: {"type":"response.output_text.delta","delta":"hi"}
                    
                    event: response.completed
                    data: {"type":"response.completed","response":{"id":"resp_up","object":"response","status":"completed","model":"5.4-mini","output_text":"hi","output":[],"usage":{"input_tokens":4,"output_tokens":1}}}
                    
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(payload);
            exchange.close();
        });
        server.start();
        try {
            AiService service = new AiService(null, null, mapper, null);
            ObjectNode request = mapper.createObjectNode();
            request.put("model", "client-model");
            request.put("stream", true);
            request.putArray("input").addObject().put("type", "message").put("role", "user")
                    .putArray("content").addObject().put("type", "input_text").put("text", "hello");
            List<String> events = new ArrayList<>();

            AiService.GatewayResponsesStreamResult result = service.streamResponsesRawOnGatewayChannel(
                    gatewayChannel("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "responses"),
                    request,
                    5,
                    event -> events.add(event.eventName()));

            assertThat(events).containsExactly(
                    "response.output_text.delta",
                    "response.completed",
                    "response.done");
            assertThat(result.finalResponse().path("id").asText()).isEqualTo("resp_up");
            assertThat(result.failed()).isFalse();
            assertThat(result.sawTerminal()).isTrue();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void nativeResponsesStreamErrorBeforeOutputIsMarkedEmptyFailure() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/responses", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] payload = """
                    event: error
                    data: {"type":"error","error":{"message":"upstream failed"}}
                    
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(payload);
            exchange.close();
        });
        server.start();
        try {
            AiService service = new AiService(null, null, mapper, null);
            ObjectNode request = mapper.createObjectNode();
            request.put("model", "client-model");
            request.put("stream", true);
            request.putArray("input").addObject().put("type", "message").put("role", "user")
                    .putArray("content").addObject().put("type", "input_text").put("text", "hello");
            List<String> events = new ArrayList<>();

            AiService.GatewayResponsesStreamResult result = service.streamResponsesRawOnGatewayChannel(
                    gatewayChannel("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "responses"),
                    request,
                    5,
                    event -> events.add(event.eventName()));

            assertThat(events).containsExactly("error");
            assertThat(result.failed()).isTrue();
            assertThat(result.sawOutputOrTool()).isFalse();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void buildRequestBodyDowngradesToolMessageWithoutToolCallId() throws Exception {
        AiService service = new AiService(null, null, mapper, null);
        Method method = AiService.class.getDeclaredMethod(
                "buildRequestBodyWithTools",
                String.class, String.class, List.class, Double.class, Integer.class, List.class,
                Boolean.class, Integer.class, boolean.class, JsonNode.class);
        method.setAccessible(true);

        ObjectNode body = (ObjectNode) method.invoke(service,
                "5.4-mini", null,
                List.of(Map.of("role", "tool", "content", "orphan tool output")),
                null, null, null, null, null, false, null);

        JsonNode message = body.path("messages").get(0);
        assertThat(message.path("role").asText()).isEqualTo("user");
        assertThat(message.has("tool_call_id")).isFalse();
        assertThat(message.path("content").asText()).contains("orphan tool output");
    }

    @Test
    void streamingUnexpectedEofSynthesizesLengthFinishReason() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] payload = """
                    data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}
                    
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(payload);
            exchange.close();
        });
        server.start();
        try {
            AiService service = new AiService(null, null, mapper, null);
            ObjectNode body = mapper.createObjectNode();
            body.put("model", "5.4-mini");
            body.put("stream", true);
            body.putArray("messages").addObject().put("role", "user").put("content", "hello");
            Object channel = channelConfig("http://127.0.0.1:" + server.getAddress().getPort() + "/v1");
            Class<?> channelClass = Class.forName("com.aiplatform.backend.service.AiService$ChannelConfig");
            Method method = AiService.class.getDeclaredMethod(
                    "callLlmApiStreaming", channelClass, ObjectNode.class, int.class, Consumer.class);
            method.setAccessible(true);
            StringBuilder tokens = new StringBuilder();

            JsonNode response = (JsonNode) method.invoke(service, channel, body, 5, (Consumer<String>) tokens::append);

            assertThat(tokens.toString()).isEqualTo("partial");
            assertThat(response.path("choices").path(0).path("finish_reason").asText()).isEqualTo("length");
        } finally {
            server.stop(0);
        }
    }

    private ModelChannel channel(Long id, String name, String models) {
        return channel(id, name, models, "chat_completions");
    }

    private ModelChannel channel(Long id, String name, String models, String apiFormat) {
        ModelChannel channel = new ModelChannel();
        channel.setId(id);
        channel.setName(name);
        channel.setProvider("OpenAI");
        channel.setApiFormat(apiFormat);
        channel.setApiKey("sk-test-key-1234567890");
        channel.setBaseUrl("https://new-api.example/v1");
        channel.setModels(models);
        channel.setStatus("active");
        channel.setDeleted(0);
        return channel;
    }

    private String channelModel(Object channelConfig) throws Exception {
        Method method = channelConfig.getClass().getDeclaredMethod("model");
        method.setAccessible(true);
        return (String) method.invoke(channelConfig);
    }

    private Object channelConfig(String baseUrl) throws Exception {
        Class<?> channelClass = Class.forName("com.aiplatform.backend.service.AiService$ChannelConfig");
        Constructor<?> constructor = channelClass.getDeclaredConstructor(
                Long.class, String.class, String.class, String.class, String.class, String.class);
        constructor.setAccessible(true);
        return constructor.newInstance(null, "sk-test-key-1234567890", baseUrl,
                "5.4-mini", "OpenAI", "chat_completions");
    }

    private AiService.GatewayChannel gatewayChannel(String baseUrl, String apiFormat) {
        return new AiService.GatewayChannel(null, "sk-test-key-1234567890", baseUrl,
                "5.4-mini", "OpenAI", apiFormat);
    }
}
