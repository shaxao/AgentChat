package com.aiplatform.backend.service.provider.openai;

import com.aiplatform.backend.service.provider.TextAdapter.StreamContext;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class OpenAiTextAdapterTest {

    private final OpenAiTextAdapter adapter = new OpenAiTextAdapter();

    @Test
    void streamToolCallBlankFieldsDoNotOverwriteExistingIdAndName() {
        StreamContext ctx = new StreamContext();

        adapter.parseStreamLine("""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]},"finish_reason":null}]}
                """.trim(), ctx);
        adapter.parseStreamLine("""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}
                """.trim(), ctx);
        adapter.parseStreamLine("""
                data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}
                """.trim(), ctx);

        assertThat(ctx.toolCallsBuilder).hasSize(1);
        assertThat(ctx.toolCallsBuilder.get(0).id).isEqualTo("call_abc");
        assertThat(ctx.toolCallsBuilder.get(0).functionName).isEqualTo("read_file");
        assertThat(ctx.toolCallsBuilder.get(0).arguments.toString()).isEqualTo("{\"path\":\"README.md\"}");
        assertThat(ctx.finishReason).isEqualTo("tool_calls");
    }
}
