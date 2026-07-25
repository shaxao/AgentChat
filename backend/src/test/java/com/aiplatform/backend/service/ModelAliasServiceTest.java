package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ModelAliasServiceTest {

    private ModelConfigMapper mapper;
    private ModelAliasService service;

    @BeforeEach
    void setUp() {
        mapper = mock(ModelConfigMapper.class);
        service = new ModelAliasService(mapper);
    }

    private ModelConfig model(String modelId, String aliases) {
        ModelConfig mc = new ModelConfig();
        mc.setModelId(modelId);
        mc.setAliases(aliases);
        return mc;
    }

    @Test
    void resolvesExactModelIdCaseInsensitive() {
        when(mapper.selectList(any())).thenReturn(List.of(
                model("deepseek-v4-pro", null)));

        assertThat(service.resolveModelId("deepseek-v4-pro")).isEqualTo("deepseek-v4-pro");
        assertThat(service.resolveModelId("DeepSeek-V4-Pro")).isEqualTo("deepseek-v4-pro");
    }

    @Test
    void resolvesAliasToModelId() {
        when(mapper.selectList(any())).thenReturn(List.of(
                model("deepseek-v4-pro", "claude-3-5-sonnet-20241022, claude-sonnet-4")));

        assertThat(service.resolveModelId("claude-3-5-sonnet-20241022")).isEqualTo("deepseek-v4-pro");
        assertThat(service.resolveModelId("CLAUDE-SONNET-4")).isEqualTo("deepseek-v4-pro");
    }

    @Test
    void returnsOriginalWhenNoMatch() {
        when(mapper.selectList(any())).thenReturn(List.of(
                model("deepseek-v4-pro", "claude-sonnet-4")));

        assertThat(service.resolveModelId("gpt-4o-mini")).isEqualTo("gpt-4o-mini");
    }

    @Test
    void modelIdTakesPrecedenceOverAlias() {
        // 一个模型的 model_id 恰好是另一个模型的别名时，精确匹配优先
        when(mapper.selectList(any())).thenReturn(List.of(
                model("gpt-4o", null),
                model("internal-model", "gpt-4o")));

        assertThat(service.resolveModelId("gpt-4o")).isEqualTo("gpt-4o");
    }

    @Test
    void passesThroughNullAndBlank() {
        when(mapper.selectList(any())).thenReturn(List.of(model("m", null)));
        assertThat(service.resolveModelId(null)).isNull();
        assertThat(service.resolveModelId("   ")).isEqualTo("   ");
    }
}
