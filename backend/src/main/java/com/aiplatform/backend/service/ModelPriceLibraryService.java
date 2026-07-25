package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ModelPriceLibraryDTO;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ModelPriceLibraryService {

    private static final String RESOURCE_PATH = "model-price-library.json";
    private static final BigDecimal DEFAULT_EXCHANGE_RATE = new BigDecimal("7.30");
    private static final BigDecimal DEFAULT_MULTIPLIER = BigDecimal.ONE;
    private static final Pattern DATE_SUFFIX = Pattern.compile("[-_](?:19|20)\\d{2}[-_]\\d{2}[-_]\\d{2}$");

    private final ObjectMapper objectMapper;
    private final ModelConfigMapper modelConfigMapper;

    private volatile ModelPriceLibraryDTO.LibrarySnapshot cachedSnapshot;

    public ModelPriceLibraryDTO.LibraryResponse library() {
        ModelPriceLibraryDTO.LibrarySnapshot snapshot = snapshot();
        ModelPriceLibraryDTO.LibraryResponse response = new ModelPriceLibraryDTO.LibraryResponse();
        response.setSchemaVersion(snapshot.getSchemaVersion());
        response.setUpdatedAt(snapshot.getUpdatedAt());
        response.setDefaultExchangeRate(defaultIfNull(snapshot.getDefaultExchangeRate(), DEFAULT_EXCHANGE_RATE));
        response.setDefaultMultiplier(defaultIfNull(snapshot.getDefaultMultiplier(), DEFAULT_MULTIPLIER));
        response.setSources(snapshot.getSources());
        response.setItems(snapshot.getItems());
        response.setProviders(snapshot.getItems().stream()
                .map(ModelPriceLibraryDTO.LibraryItem::getProvider)
                .filter(Objects::nonNull)
                .distinct()
                .sorted(String::compareToIgnoreCase)
                .collect(Collectors.toList()));
        return response;
    }

    public ModelPriceLibraryDTO.PreviewResponse preview(ModelPriceLibraryDTO.PreviewRequest request) {
        ModelPriceLibraryDTO.LibrarySnapshot snapshot = snapshot();
        BigDecimal exchangeRate = effectiveExchangeRate(request, snapshot);
        BigDecimal multiplier = effectiveMultiplier(request, snapshot);
        boolean overwrite = Boolean.TRUE.equals(request != null ? request.getOverwrite() : null);
        boolean createMissing = request == null || request.getCreateMissing() == null || Boolean.TRUE.equals(request.getCreateMissing());

        List<ModelPriceLibraryDTO.ModelTarget> targets = resolveTargets(request, snapshot);
        Map<String, ModelConfig> existingByKey = loadExistingModels();
        Map<String, List<ModelPriceLibraryDTO.LibraryItem>> libraryIndex = buildLibraryIndex(snapshot.getItems());

        ModelPriceLibraryDTO.PreviewResponse response = new ModelPriceLibraryDTO.PreviewResponse();
        response.setUpdatedAt(snapshot.getUpdatedAt());
        response.setExchangeRate(exchangeRate);
        response.setMultiplier(multiplier);
        response.setOverwrite(overwrite);
        response.setCreateMissing(createMissing);

        for (ModelPriceLibraryDTO.ModelTarget target : targets) {
            ModelPriceLibraryDTO.PreviewItem item = previewOne(
                    target,
                    existingByKey,
                    libraryIndex,
                    exchangeRate,
                    multiplier,
                    overwrite,
                    createMissing);
            response.getItems().add(item);
        }

        response.setTotal(response.getItems().size());
        response.setMatched((int) response.getItems().stream().filter(i -> Boolean.TRUE.equals(i.getMatched())).count());
        response.setUnmatched((int) response.getItems().stream().filter(i -> !Boolean.TRUE.equals(i.getMatched())).count());
        response.setActionable((int) response.getItems().stream()
                .filter(i -> "create".equals(i.getAction()) || "update".equals(i.getAction()))
                .count());
        return response;
    }

    public ModelPriceLibraryDTO.ApplyResponse apply(ModelPriceLibraryDTO.ApplyRequest request) {
        ModelPriceLibraryDTO.PreviewResponse preview = preview(request);
        Set<String> selected = request != null && request.getSelectedModelIds() != null
                ? request.getSelectedModelIds().stream().filter(Objects::nonNull).map(this::normalize).collect(Collectors.toSet())
                : Set.of();
        boolean hasExplicitSelection = !selected.isEmpty();

        Map<String, ModelConfig> existingByKey = loadExistingModels();
        ModelPriceLibraryDTO.ApplyResponse response = new ModelPriceLibraryDTO.ApplyResponse();

        for (ModelPriceLibraryDTO.PreviewItem item : preview.getItems()) {
            if (hasExplicitSelection && !selected.contains(normalize(item.getTargetModelId()))) {
                continue;
            }
            if (!Boolean.TRUE.equals(item.getMatched())) {
                response.setUnmatched(response.getUnmatched() + 1);
                response.getItems().add(item);
                continue;
            }

            if ("create".equals(item.getAction())) {
                ModelConfig model = createModelFromPreview(item);
                try {
                    modelConfigMapper.insert(model);
                    response.setCreated(response.getCreated() + 1);
                    response.getModels().add(model);
                    response.getItems().add(item);
                    existingByKey.put(normalize(model.getModelId()), model);
                } catch (Exception e) {
                    log.warn("官方价格库创建模型失败 modelId={}: {}", item.getTargetModelId(), e.getMessage());
                    item.setAction("skip");
                    item.setReason("创建失败：" + e.getMessage());
                    response.setSkipped(response.getSkipped() + 1);
                    response.getItems().add(item);
                }
                continue;
            }

            if ("update".equals(item.getAction())) {
                ModelConfig model = existingByKey.get(normalize(item.getTargetModelId()));
                if (model == null) {
                    item.setAction("skip");
                    item.setReason("已有模型记录不存在或已删除");
                    response.setSkipped(response.getSkipped() + 1);
                    response.getItems().add(item);
                    continue;
                }
                model.setInputPrice(item.getImportedInputPrice());
                model.setCachedInputPrice(item.getImportedCachedInputPrice());
                model.setOutputPrice(item.getImportedOutputPrice());
                try {
                    modelConfigMapper.updateById(model);
                    response.setUpdated(response.getUpdated() + 1);
                    response.getModels().add(model);
                    response.getItems().add(item);
                } catch (Exception e) {
                    log.warn("官方价格库更新模型价格失败 modelId={}: {}", item.getTargetModelId(), e.getMessage());
                    item.setAction("skip");
                    item.setReason("更新失败：" + e.getMessage());
                    response.setSkipped(response.getSkipped() + 1);
                    response.getItems().add(item);
                }
                continue;
            }

            response.setSkipped(response.getSkipped() + 1);
            response.getItems().add(item);
        }

        response.setSummary(Map.of(
                "created", response.getCreated(),
                "updated", response.getUpdated(),
                "skipped", response.getSkipped(),
                "unmatched", response.getUnmatched()));
        return response;
    }

    private ModelPriceLibraryDTO.PreviewItem previewOne(
            ModelPriceLibraryDTO.ModelTarget target,
            Map<String, ModelConfig> existingByKey,
            Map<String, List<ModelPriceLibraryDTO.LibraryItem>> libraryIndex,
            BigDecimal exchangeRate,
            BigDecimal multiplier,
            boolean overwrite,
            boolean createMissing) {
        ModelPriceLibraryDTO.PreviewItem item = new ModelPriceLibraryDTO.PreviewItem();
        String targetModelId = safeTargetModelId(target);
        item.setTargetModelId(targetModelId);
        item.setTargetName(target.getName() != null && !target.getName().isBlank() ? target.getName() : targetModelId);
        item.setTargetProvider(target.getProvider());

        ModelConfig existing = existingByKey.get(normalize(targetModelId));
        item.setExisting(existing != null);
        if (existing != null) {
            item.setCurrentInputPrice(zeroIfNull(existing.getInputPrice()));
            item.setCurrentCachedInputPrice(zeroIfNull(existing.getCachedInputPrice()));
            item.setCurrentOutputPrice(zeroIfNull(existing.getOutputPrice()));
            if (item.getTargetProvider() == null || item.getTargetProvider().isBlank()) {
                item.setTargetProvider(existing.getProvider());
            }
        }

        ModelPriceLibraryDTO.LibraryItem libraryItem = matchLibrary(target, libraryIndex);
        if (libraryItem == null) {
            item.setMatched(false);
            item.setAction("unmatched");
            item.setReason("官方价格库未匹配：需手动定价，不会写入 0");
            return item;
        }
        if (libraryItem.getInputPricePer1M() == null || libraryItem.getOutputPricePer1M() == null) {
            item.setMatched(false);
            item.setAction("unmatched");
            item.setReason("官方价格快照不完整：需手动定价，不会写入 0");
            item.setLibraryModelId(libraryItem.getModelId());
            item.setLibraryName(libraryItem.getName());
            item.setProvider(libraryItem.getProvider());
            item.setCurrency(libraryItem.getCurrency());
            item.setSourceUrl(libraryItem.getSourceUrl());
            item.setSourceAccessedAt(libraryItem.getSourceAccessedAt());
            item.setNotes(libraryItem.getNotes());
            return item;
        }

        BigDecimal input = libraryItem.getInputPricePer1M();
        BigDecimal cached = libraryItem.getCachedInputPricePer1M();
        boolean cacheDefaulted = cached == null;
        if (cacheDefaulted) {
            cached = input;
        }
        BigDecimal output = libraryItem.getOutputPricePer1M();
        BigDecimal importedInput = convertToCny(input, libraryItem.getCurrency(), exchangeRate, multiplier);
        BigDecimal importedCached = convertToCny(cached, libraryItem.getCurrency(), exchangeRate, multiplier);
        BigDecimal importedOutput = convertToCny(output, libraryItem.getCurrency(), exchangeRate, multiplier);

        item.setMatched(true);
        item.setLibraryModelId(libraryItem.getModelId());
        item.setLibraryName(libraryItem.getName());
        item.setProvider(libraryItem.getProvider());
        item.setCurrency(libraryItem.getCurrency());
        item.setContextLength(libraryItem.getContextLength());
        item.setCapabilities(libraryItem.getCapabilities());
        item.setAliases(libraryItem.getAliases());
        item.setOfficialInputPrice(input);
        item.setOfficialCachedInputPrice(cached);
        item.setOfficialOutputPrice(output);
        item.setImportedInputPrice(importedInput);
        item.setImportedCachedInputPrice(importedCached);
        item.setImportedOutputPrice(importedOutput);
        item.setCachePriceDefaulted(cacheDefaulted);
        item.setSourceUrl(libraryItem.getSourceUrl());
        item.setSourceAccessedAt(libraryItem.getSourceAccessedAt());
        item.setNotes(appendNote(libraryItem.getNotes(), cacheDefaulted ? "缓存价缺失，按输入价默认填充。" : null));

        if (existing == null) {
            if (createMissing) {
                item.setAction("create");
                item.setReason("模型不存在，将创建并写入官方换算价");
            } else {
                item.setAction("skip");
                item.setReason("模型不存在，且未启用创建缺失模型");
            }
        } else if (overwrite) {
            item.setAction("update");
            item.setReason("模型已存在，将仅覆盖输入/缓存输入/输出价格");
        } else {
            item.setAction("skip");
            item.setReason("模型已存在，未启用覆盖更新");
        }

        item.setInputDelta(importedInput.subtract(zeroIfNull(item.getCurrentInputPrice())));
        item.setCachedInputDelta(importedCached.subtract(zeroIfNull(item.getCurrentCachedInputPrice())));
        item.setOutputDelta(importedOutput.subtract(zeroIfNull(item.getCurrentOutputPrice())));
        return item;
    }

    private ModelConfig createModelFromPreview(ModelPriceLibraryDTO.PreviewItem item) {
        ModelConfig model = new ModelConfig();
        model.setModelId(item.getTargetModelId());
        model.setName(firstNonBlank(item.getTargetName(), item.getLibraryName(), item.getTargetModelId()));
        model.setProvider(firstNonBlank(item.getTargetProvider(), item.getProvider(), "OpenAI"));
        model.setDescription("官方价格库导入：" + firstNonBlank(item.getLibraryName(), item.getLibraryModelId(), item.getTargetModelId()));
        model.setContextLength(item.getContextLength() != null ? item.getContextLength() : 128000);
        model.setInputPrice(item.getImportedInputPrice());
        model.setCachedInputPrice(item.getImportedCachedInputPrice());
        model.setOutputPrice(item.getImportedOutputPrice());
        model.setCapabilities(item.getCapabilities() != null && !item.getCapabilities().isEmpty()
                ? String.join(",", item.getCapabilities())
                : "text");

        LinkedHashSet<String> aliases = new LinkedHashSet<>();
        if (item.getLibraryModelId() != null && !item.getLibraryModelId().equals(item.getTargetModelId())) {
            aliases.add(item.getLibraryModelId());
        }
        if (item.getAliases() != null) {
            aliases.addAll(item.getAliases());
        }
        aliases.removeIf(alias -> alias == null || alias.isBlank() || alias.equals(item.getTargetModelId()));
        if (!aliases.isEmpty()) {
            model.setAliases(String.join(",", aliases));
        }
        model.setEnabled(true);
        return model;
    }

    private ModelPriceLibraryDTO.LibraryItem matchLibrary(
            ModelPriceLibraryDTO.ModelTarget target,
            Map<String, List<ModelPriceLibraryDTO.LibraryItem>> libraryIndex) {
        String modelId = safeTargetModelId(target);
        List<String> keys = new ArrayList<>();
        addKey(keys, normalize(modelId));
        addKey(keys, normalizeBase(modelId));
        if (target.getName() != null) {
            addKey(keys, normalize(target.getName()));
            addKey(keys, normalizeBase(target.getName()));
        }

        for (String key : keys) {
            List<ModelPriceLibraryDTO.LibraryItem> candidates = libraryIndex.get(key);
            if (candidates == null || candidates.isEmpty()) continue;
            return pickProviderMatch(candidates, target.getProvider());
        }
        return null;
    }

    private ModelPriceLibraryDTO.LibraryItem pickProviderMatch(List<ModelPriceLibraryDTO.LibraryItem> candidates, String targetProvider) {
        if (targetProvider == null || targetProvider.isBlank() || candidates.size() == 1) {
            return candidates.get(0);
        }
        String wanted = normalizeProvider(targetProvider);
        return candidates.stream()
                .filter(item -> normalizeProvider(item.getProvider()).equals(wanted))
                .findFirst()
                .orElse(candidates.get(0));
    }

    private Map<String, List<ModelPriceLibraryDTO.LibraryItem>> buildLibraryIndex(List<ModelPriceLibraryDTO.LibraryItem> items) {
        Map<String, List<ModelPriceLibraryDTO.LibraryItem>> index = new LinkedHashMap<>();
        for (ModelPriceLibraryDTO.LibraryItem item : items) {
            addLibraryIndex(index, normalize(item.getModelId()), item);
            addLibraryIndex(index, normalizeBase(item.getModelId()), item);
            if (item.getAliases() != null) {
                for (String alias : item.getAliases()) {
                    addLibraryIndex(index, normalize(alias), item);
                    addLibraryIndex(index, normalizeBase(alias), item);
                }
            }
        }
        return index;
    }

    private void addLibraryIndex(Map<String, List<ModelPriceLibraryDTO.LibraryItem>> index, String key, ModelPriceLibraryDTO.LibraryItem item) {
        if (key == null || key.isBlank()) return;
        index.computeIfAbsent(key, ignored -> new ArrayList<>()).add(item);
    }

    private List<ModelPriceLibraryDTO.ModelTarget> resolveTargets(
            ModelPriceLibraryDTO.PreviewRequest request,
            ModelPriceLibraryDTO.LibrarySnapshot snapshot) {
        if (request != null && request.getModels() != null && !request.getModels().isEmpty()) {
            return request.getModels().stream()
                    .filter(Objects::nonNull)
                    .filter(target -> target.getModelId() != null && !target.getModelId().isBlank())
                    .collect(Collectors.toList());
        }
        return snapshot.getItems().stream()
                .map(item -> {
                    ModelPriceLibraryDTO.ModelTarget target = new ModelPriceLibraryDTO.ModelTarget();
                    target.setModelId(item.getModelId());
                    target.setName(item.getName());
                    target.setProvider(item.getProvider());
                    return target;
                })
                .collect(Collectors.toList());
    }

    private Map<String, ModelConfig> loadExistingModels() {
        List<ModelConfig> existing = modelConfigMapper.selectList(
                new QueryWrapper<ModelConfig>().eq("deleted", 0));
        Map<String, ModelConfig> map = new HashMap<>();
        if (existing == null) {
            return map;
        }
        for (ModelConfig model : existing) {
            if (model.getModelId() == null) continue;
            map.put(normalize(model.getModelId()), model);
        }
        return map;
    }

    private BigDecimal convertToCny(BigDecimal amount, String currency, BigDecimal exchangeRate, BigDecimal multiplier) {
        BigDecimal converted = zeroIfNull(amount);
        String normalizedCurrency = currency == null ? "" : currency.trim().toUpperCase(Locale.ROOT);
        if ("USD".equals(normalizedCurrency)) {
            converted = converted.multiply(exchangeRate);
        } else if (!"CNY".equals(normalizedCurrency) && !"RMB".equals(normalizedCurrency)) {
            log.warn("未知价格币种 {}，按人民币直接处理", currency);
        }
        return converted.multiply(multiplier).setScale(4, RoundingMode.HALF_UP);
    }

    private ModelPriceLibraryDTO.LibrarySnapshot snapshot() {
        ModelPriceLibraryDTO.LibrarySnapshot current = cachedSnapshot;
        if (current != null) {
            return current;
        }
        synchronized (this) {
            if (cachedSnapshot != null) return cachedSnapshot;
            try (InputStream in = new ClassPathResource(RESOURCE_PATH).getInputStream()) {
                ModelPriceLibraryDTO.LibrarySnapshot loaded = objectMapper.readValue(in, ModelPriceLibraryDTO.LibrarySnapshot.class);
                if (loaded.getItems() == null) loaded.setItems(new ArrayList<>());
                if (loaded.getSources() == null) loaded.setSources(new ArrayList<>());
                loaded.getItems().sort(Comparator
                        .comparing((ModelPriceLibraryDTO.LibraryItem i) -> nullToEmpty(i.getProvider()), String.CASE_INSENSITIVE_ORDER)
                        .thenComparing(i -> nullToEmpty(i.getModelId()), String.CASE_INSENSITIVE_ORDER));
                cachedSnapshot = loaded;
                return loaded;
            } catch (Exception e) {
                throw new RuntimeException("加载官方价格库失败: " + e.getMessage(), e);
            }
        }
    }

    private BigDecimal effectiveExchangeRate(ModelPriceLibraryDTO.PreviewRequest request, ModelPriceLibraryDTO.LibrarySnapshot snapshot) {
        return positiveOrDefault(request != null ? request.getExchangeRate() : null,
                defaultIfNull(snapshot.getDefaultExchangeRate(), DEFAULT_EXCHANGE_RATE));
    }

    private BigDecimal effectiveMultiplier(ModelPriceLibraryDTO.PreviewRequest request, ModelPriceLibraryDTO.LibrarySnapshot snapshot) {
        return positiveOrDefault(request != null ? request.getMultiplier() : null,
                defaultIfNull(snapshot.getDefaultMultiplier(), DEFAULT_MULTIPLIER));
    }

    private BigDecimal positiveOrDefault(BigDecimal value, BigDecimal fallback) {
        return value != null && value.compareTo(BigDecimal.ZERO) > 0 ? value : fallback;
    }

    private BigDecimal defaultIfNull(BigDecimal value, BigDecimal fallback) {
        return value != null ? value : fallback;
    }

    private BigDecimal zeroIfNull(BigDecimal value) {
        return value != null ? value : BigDecimal.ZERO;
    }

    private String safeTargetModelId(ModelPriceLibraryDTO.ModelTarget target) {
        return target != null && target.getModelId() != null ? target.getModelId().trim() : "";
    }

    private String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value.trim();
            }
        }
        return "";
    }

    private void addKey(List<String> keys, String key) {
        if (key != null && !key.isBlank() && !keys.contains(key)) {
            keys.add(key);
        }
    }

    private String normalizeBase(String value) {
        String normalized = normalize(value);
        return DATE_SUFFIX.matcher(normalized).replaceFirst("");
    }

    private String normalize(String value) {
        if (value == null) return "";
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private String normalizeProvider(String value) {
        String normalized = normalize(value).replace(" ", "").replace("_", "").replace("-", "");
        if ("google".equals(normalized)) return "gemini";
        if ("alibaba".equals(normalized) || "aliyun".equals(normalized) || "dashscope".equals(normalized)) return "qwen";
        return normalized;
    }

    private String appendNote(String base, String extra) {
        if (extra == null || extra.isBlank()) return base;
        if (base == null || base.isBlank()) return extra;
        return base + "；" + extra;
    }

    private String nullToEmpty(String value) {
        return value != null ? value : "";
    }
}
