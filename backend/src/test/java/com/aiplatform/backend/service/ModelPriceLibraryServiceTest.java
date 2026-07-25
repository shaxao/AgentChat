package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ModelPriceLibraryDTO;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ModelPriceLibraryServiceTest {

    private ModelConfigMapper modelConfigMapper;
    private ModelPriceLibraryService service;

    @BeforeEach
    void setUp() {
        modelConfigMapper = mock(ModelConfigMapper.class);
        service = new ModelPriceLibraryService(new ObjectMapper(), modelConfigMapper);
    }

    @Test
    void convertsUsdPriceToCnyWithExchangeRateAndMultiplier() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of());

        ModelPriceLibraryDTO.PreviewRequest req = request(
                List.of(target("gpt-5.6-luna", "OpenAI")),
                "7.30",
                "1.00",
                true,
                true);

        ModelPriceLibraryDTO.PreviewItem item = service.preview(req).getItems().get(0);

        assertThat(item.getAction()).isEqualTo("create");
        assertMoney(item.getImportedInputPrice(), "7.3000");
        assertMoney(item.getImportedCachedInputPrice(), "0.7300");
        assertMoney(item.getImportedOutputPrice(), "43.8000");
    }

    @Test
    void cnyPriceDoesNotApplyUsdExchangeRateButAppliesMultiplier() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of());

        ModelPriceLibraryDTO.PreviewRequest req = request(
                List.of(target("deepseek-v4-pro", "DeepSeek")),
                "100.00",
                "2.00",
                true,
                true);

        ModelPriceLibraryDTO.PreviewItem item = service.preview(req).getItems().get(0);

        assertMoney(item.getImportedInputPrice(), "6.0000");
        assertMoney(item.getImportedCachedInputPrice(), "0.0500");
        assertMoney(item.getImportedOutputPrice(), "12.0000");
    }

    @Test
    void existingModelIsSkippedWhenOverwriteIsFalse() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of(existing("gpt-5.6-luna")));

        ModelPriceLibraryDTO.PreviewRequest req = request(
                List.of(target("gpt-5.6-luna", "OpenAI")),
                "7.30",
                "1.00",
                false,
                true);

        ModelPriceLibraryDTO.PreviewItem item = service.preview(req).getItems().get(0);

        assertThat(item.getExisting()).isTrue();
        assertThat(item.getAction()).isEqualTo("skip");
        assertThat(item.getReason()).contains("未启用覆盖更新");
    }

    @Test
    void existingModelIsUpdatedWhenOverwriteIsTrue() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of(existing("gpt-5.6-luna")));

        ModelPriceLibraryDTO.ApplyRequest req = applyRequest(
                List.of(target("gpt-5.6-luna", "OpenAI")),
                List.of("gpt-5.6-luna"),
                "7.30",
                "1.00",
                true,
                true);

        ModelPriceLibraryDTO.ApplyResponse response = service.apply(req);

        assertThat(response.getUpdated()).isEqualTo(1);
        verify(modelConfigMapper).updateById(any(ModelConfig.class));
    }

    @Test
    void unmatchedModelIsSkippedAndNeverWrittenWithZeroPrices() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of());

        ModelPriceLibraryDTO.ApplyRequest req = applyRequest(
                List.of(target("gpt-5.4-mini", "OpenAI")),
                List.of("gpt-5.4-mini"),
                "7.30",
                "1.00",
                true,
                true);

        ModelPriceLibraryDTO.ApplyResponse response = service.apply(req);

        assertThat(response.getUnmatched()).isEqualTo(1);
        assertThat(response.getCreated()).isZero();
        verify(modelConfigMapper, never()).insert(any(ModelConfig.class));
    }

    @Test
    void dateSuffixModelMatchesBaseLibraryPriceButKeepsTargetModelIdOnCreate() {
        when(modelConfigMapper.selectList(any())).thenReturn(List.of());

        ModelPriceLibraryDTO.ApplyRequest req = applyRequest(
                List.of(target("gpt-5.6-luna-2026-06-17", "OpenAI")),
                List.of("gpt-5.6-luna-2026-06-17"),
                "7.30",
                "1.00",
                true,
                true);

        ModelPriceLibraryDTO.ApplyResponse response = service.apply(req);

        assertThat(response.getCreated()).isEqualTo(1);
        assertThat(response.getModels()).hasSize(1);
        assertThat(response.getModels().get(0).getModelId()).isEqualTo("gpt-5.6-luna-2026-06-17");
        assertThat(response.getModels().get(0).getAliases()).contains("gpt-5.6-luna");
    }

    private ModelPriceLibraryDTO.PreviewRequest request(
            List<ModelPriceLibraryDTO.ModelTarget> targets,
            String exchangeRate,
            String multiplier,
            boolean overwrite,
            boolean createMissing) {
        ModelPriceLibraryDTO.PreviewRequest req = new ModelPriceLibraryDTO.PreviewRequest();
        req.setModels(targets);
        req.setExchangeRate(new BigDecimal(exchangeRate));
        req.setMultiplier(new BigDecimal(multiplier));
        req.setOverwrite(overwrite);
        req.setCreateMissing(createMissing);
        return req;
    }

    private ModelPriceLibraryDTO.ApplyRequest applyRequest(
            List<ModelPriceLibraryDTO.ModelTarget> targets,
            List<String> selected,
            String exchangeRate,
            String multiplier,
            boolean overwrite,
            boolean createMissing) {
        ModelPriceLibraryDTO.ApplyRequest req = new ModelPriceLibraryDTO.ApplyRequest();
        req.setModels(targets);
        req.setSelectedModelIds(selected);
        req.setExchangeRate(new BigDecimal(exchangeRate));
        req.setMultiplier(new BigDecimal(multiplier));
        req.setOverwrite(overwrite);
        req.setCreateMissing(createMissing);
        return req;
    }

    private ModelPriceLibraryDTO.ModelTarget target(String modelId, String provider) {
        ModelPriceLibraryDTO.ModelTarget target = new ModelPriceLibraryDTO.ModelTarget();
        target.setModelId(modelId);
        target.setName(modelId);
        target.setProvider(provider);
        return target;
    }

    private ModelConfig existing(String modelId) {
        ModelConfig model = new ModelConfig();
        model.setId(1L);
        model.setModelId(modelId);
        model.setProvider("OpenAI");
        model.setInputPrice(new BigDecimal("1.0000"));
        model.setCachedInputPrice(new BigDecimal("0.1000"));
        model.setOutputPrice(new BigDecimal("2.0000"));
        model.setEnabled(true);
        return model;
    }

    private void assertMoney(BigDecimal actual, String expected) {
        assertThat(actual).isEqualByComparingTo(new BigDecimal(expected));
    }
}
