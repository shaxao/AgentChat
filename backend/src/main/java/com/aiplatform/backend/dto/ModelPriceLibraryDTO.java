package com.aiplatform.backend.dto;

import com.aiplatform.backend.entity.ModelConfig;
import lombok.Data;
import lombok.EqualsAndHashCode;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class ModelPriceLibraryDTO {

    @Data
    public static class LibrarySnapshot {
        private String schemaVersion;
        private String updatedAt;
        private BigDecimal defaultExchangeRate;
        private BigDecimal defaultMultiplier;
        private List<ProviderSource> sources = new ArrayList<>();
        private List<LibraryItem> items = new ArrayList<>();
    }

    @Data
    public static class ProviderSource {
        private String provider;
        private String sourceUrl;
        private String sourceAccessedAt;
        private String notes;
        private Boolean reserved;
    }

    @Data
    public static class LibraryItem {
        private String provider;
        private String modelId;
        private String name;
        private List<String> aliases = new ArrayList<>();
        private Integer contextLength;
        private List<String> capabilities = new ArrayList<>();
        private String currency;
        private BigDecimal inputPricePer1M;
        private BigDecimal cachedInputPricePer1M;
        private BigDecimal outputPricePer1M;
        private String sourceUrl;
        private String sourceAccessedAt;
        private String notes;
    }

    @Data
    public static class LibraryResponse {
        private String schemaVersion;
        private String updatedAt;
        private BigDecimal defaultExchangeRate;
        private BigDecimal defaultMultiplier;
        private List<String> providers = new ArrayList<>();
        private List<ProviderSource> sources = new ArrayList<>();
        private List<LibraryItem> items = new ArrayList<>();
    }

    @Data
    public static class ModelTarget {
        private String modelId;
        private String name;
        private String provider;

        public static ModelTarget of(String modelId) {
            ModelTarget target = new ModelTarget();
            target.setModelId(modelId);
            target.setName(modelId);
            return target;
        }
    }

    @Data
    public static class PreviewRequest {
        private List<ModelTarget> models = new ArrayList<>();
        private BigDecimal exchangeRate;
        private BigDecimal multiplier;
        private Boolean overwrite;
        private Boolean createMissing;
    }

    @Data
    @EqualsAndHashCode(callSuper = true)
    public static class ApplyRequest extends PreviewRequest {
        private List<String> selectedModelIds = new ArrayList<>();
    }

    @Data
    public static class PreviewResponse {
        private String updatedAt;
        private BigDecimal exchangeRate;
        private BigDecimal multiplier;
        private Boolean overwrite;
        private Boolean createMissing;
        private int total;
        private int matched;
        private int actionable;
        private int unmatched;
        private List<PreviewItem> items = new ArrayList<>();
    }

    @Data
    public static class PreviewItem {
        private String targetModelId;
        private String targetProvider;
        private String targetName;
        private Boolean existing;
        private Boolean matched;
        /**
         * create / update / skip / unmatched
         */
        private String action;
        private String reason;

        private String libraryModelId;
        private String libraryName;
        private String provider;
        private String currency;
        private Integer contextLength;
        private List<String> capabilities = new ArrayList<>();
        private List<String> aliases = new ArrayList<>();

        private BigDecimal currentInputPrice;
        private BigDecimal currentCachedInputPrice;
        private BigDecimal currentOutputPrice;
        private BigDecimal officialInputPrice;
        private BigDecimal officialCachedInputPrice;
        private BigDecimal officialOutputPrice;
        private BigDecimal importedInputPrice;
        private BigDecimal importedCachedInputPrice;
        private BigDecimal importedOutputPrice;
        private BigDecimal inputDelta;
        private BigDecimal cachedInputDelta;
        private BigDecimal outputDelta;

        private Boolean cachePriceDefaulted;
        private String sourceUrl;
        private String sourceAccessedAt;
        private String notes;
    }

    @Data
    public static class ApplyResponse {
        private int created;
        private int updated;
        private int skipped;
        private int unmatched;
        private List<ModelConfig> models = new ArrayList<>();
        private List<PreviewItem> items = new ArrayList<>();
        private Map<String, Integer> summary;
    }
}
