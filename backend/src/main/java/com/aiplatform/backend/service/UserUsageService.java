package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.UserUsageDTO;
import com.aiplatform.backend.entity.ApiLog;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.ApiLogMapper;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class UserUsageService {

    private final ApiLogMapper apiLogMapper;
    private final ModelConfigMapper modelConfigMapper;
    private final ModelChannelMapper modelChannelMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final SubscriptionPlanMapper subscriptionPlanMapper;
    private final SysUserMapper sysUserMapper;
    private final UsageTrackingService usageTrackingService;

    public UserUsageDTO.UsageSummary summary(Long userId, int days) {
        int windowDays = Math.max(1, Math.min(days, 90));
        LocalDateTime since = LocalDate.now().minusDays(windowDays - 1L).atStartOfDay();
        List<ApiLog> logs = apiLogMapper.selectList(new QueryWrapper<ApiLog>()
                .eq("user_id", userId)
                .ge("created_at", since));

        UserUsageDTO.UsageSummary summary = new UserUsageDTO.UsageSummary();
        summary.setDays(windowDays);
        summary.setRequestCount(logs.size());
        summary.setSuccessCount(logs.stream().filter(this::isSuccessLike).count());
        summary.setErrorCount(logs.size() - summary.getSuccessCount());

        long inputTokens = logs.stream().mapToLong(log -> safeInt(log.getInputTokens())).sum();
        long cachedInputTokens = logs.stream().mapToLong(log -> safeInt(log.getCachedInputTokens())).sum();
        long outputTokens = logs.stream().mapToLong(log -> safeInt(log.getOutputTokens())).sum();
        BigDecimal totalCost = logs.stream()
                .map(log -> safeMoney(log.getCost()))
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        summary.setInputTokens(inputTokens);
        summary.setCachedInputTokens(Math.min(cachedInputTokens, inputTokens));
        summary.setBillableInputTokens(Math.max(0, inputTokens - summary.getCachedInputTokens()));
        summary.setOutputTokens(outputTokens);
        summary.setTotalTokens(inputTokens + outputTokens);
        summary.setCacheHitRate(rate(summary.getCachedInputTokens(), inputTokens));
        summary.setTotalCost(totalCost);
        summary.setAvgCost(logs.isEmpty()
                ? BigDecimal.ZERO
                : totalCost.divide(BigDecimal.valueOf(logs.size()), 10, RoundingMode.HALF_UP));
        return summary;
    }

    public Result.PageResult<UserUsageDTO.UsageLogItem> logs(Long userId,
                                                             int page,
                                                             int size,
                                                             String model,
                                                             String sceneType,
                                                             String status,
                                                             String from,
                                                             String to) {
        int safePage = Math.max(1, page);
        int safeSize = Math.max(1, Math.min(size, 100));
        QueryWrapper<ApiLog> qw = new QueryWrapper<ApiLog>().eq("user_id", userId);
        if (hasText(model) && !"all".equalsIgnoreCase(model)) qw.eq("model", model.trim());
        if (hasText(sceneType) && !"all".equalsIgnoreCase(sceneType)) qw.eq("scene_type", sceneType.trim());
        if (hasText(status) && !"all".equalsIgnoreCase(status)) qw.eq("status", status.trim());
        LocalDateTime fromTime = parseDateTime(from, false);
        LocalDateTime toTime = parseDateTime(to, true);
        if (fromTime != null) qw.ge("created_at", fromTime);
        if (toTime != null) qw.le("created_at", toTime);
        qw.orderByDesc("created_at");

        Page<ApiLog> pg = apiLogMapper.selectPage(new Page<>(safePage, safeSize), qw);
        Map<String, String> channelNames = channelNameMap(pg.getRecords());
        List<UserUsageDTO.UsageLogItem> items = pg.getRecords().stream()
                .map(log -> toLogItem(log, channelNames))
                .toList();
        return new Result.PageResult<>(items, pg.getTotal(), safePage, safeSize);
    }

    public List<UserUsageDTO.ModelPriceItem> modelPrices(Long userId) {
        Set<String> allowed = getAllowedModelSet(userId);
        List<ModelConfig> modelConfigs = modelConfigMapper.selectList(
                new QueryWrapper<ModelConfig>()
                        .eq("deleted", 0)
                        .eq("enabled", true)
                        .orderByAsc("provider")
                        .orderByAsc("model_id"));

        List<ModelChannel> activeChatChannels = modelChannelMapper.selectList(
                new QueryWrapper<ModelChannel>()
                        .eq("deleted", 0)
                        .eq("status", "active")
                        .and(w -> w.isNull("channel_type").or().eq("channel_type", "").or().eq("channel_type", "chat"))
                        .orderByAsc("priority"));

        Set<String> activeChannelModelIds = new LinkedHashSet<>();
        Map<String, Set<String>> channelTagsByModel = new LinkedHashMap<>();
        for (ModelChannel ch : activeChatChannels) {
            List<String> channelModels = parseLooseList(ch.getModels());
            List<String> channelTags = parseLooseList(ch.getTags());
            for (String id : channelModels) {
                activeChannelModelIds.add(id);
                channelTagsByModel.computeIfAbsent(id, k -> new LinkedHashSet<>()).addAll(channelTags);
            }
        }

        boolean restrictToChannels = !activeChannelModelIds.isEmpty();
        List<UserUsageDTO.ModelPriceItem> result = new ArrayList<>();
        for (ModelConfig mc : modelConfigs) {
            String modelId = mc.getModelId();
            if (!hasText(modelId)) continue;
            if (restrictToChannels && !activeChannelModelIds.contains(modelId)) continue;
            if (allowed != null && !allowed.isEmpty() && allowed.stream().noneMatch(m -> m.equalsIgnoreCase(modelId))) {
                continue;
            }
            UserUsageDTO.ModelPriceItem item = new UserUsageDTO.ModelPriceItem();
            item.setId(modelId);
            item.setName(hasText(mc.getName()) ? mc.getName() : modelId);
            item.setProvider(hasText(mc.getProvider()) ? mc.getProvider() : "");
            item.setDescription(hasText(mc.getDescription()) ? mc.getDescription() : "");
            item.setContextLength(mc.getContextLength() != null ? mc.getContextLength() : 0);
            item.setInputPrice(safeMoney(mc.getInputPrice()));
            item.setCachedInputPrice(mc.getCachedInputPrice() != null ? mc.getCachedInputPrice() : item.getInputPrice());
            item.setOutputPrice(safeMoney(mc.getOutputPrice()));
            Set<String> caps = new LinkedHashSet<>(parseLooseList(mc.getCapabilities()));
            caps.addAll(channelTagsByModel.getOrDefault(modelId, Set.of()));
            if (caps.isEmpty()) caps.add("text");
            item.setCapabilities(new ArrayList<>(caps));
            result.add(item);
        }
        return result;
    }

    private UserUsageDTO.UsageLogItem toLogItem(ApiLog log, Map<String, String> channelNames) {
        UserUsageDTO.UsageLogItem item = new UserUsageDTO.UsageLogItem();
        int inputTokens = safeInt(log.getInputTokens());
        int cachedInputTokens = Math.min(safeInt(log.getCachedInputTokens()), inputTokens);
        int outputTokens = safeInt(log.getOutputTokens());
        boolean hasAnyBreakdownColumn = log.getInputCost() != null
                || log.getCachedInputCost() != null
                || log.getOutputCost() != null
                || log.getInputPriceSnapshot() != null
                || log.getCachedInputPriceSnapshot() != null
                || log.getOutputPriceSnapshot() != null;
        boolean hasNonZeroBreakdown = positive(log.getInputCost())
                || positive(log.getCachedInputCost())
                || positive(log.getOutputCost())
                || positive(log.getInputPriceSnapshot())
                || positive(log.getCachedInputPriceSnapshot())
                || positive(log.getOutputPriceSnapshot());
        boolean looksLikeLegacyZeroBreakdown = hasAnyBreakdownColumn
                && !hasNonZeroBreakdown
                && positive(log.getCost())
                && (inputTokens + outputTokens) > 0;
        boolean hasPersistedBreakdown = hasAnyBreakdownColumn && !looksLikeLegacyZeroBreakdown;

        UsageTrackingService.CostBreakdown estimated = null;
        if (!hasPersistedBreakdown) {
            estimated = usageTrackingService.calculateCostBreakdown(log.getModel(), inputTokens, cachedInputTokens, outputTokens);
        }

        BigDecimal inputCost = hasPersistedBreakdown ? safeMoney(log.getInputCost()) : estimated.getInputCost();
        BigDecimal cachedInputCost = hasPersistedBreakdown ? safeMoney(log.getCachedInputCost()) : estimated.getCachedInputCost();
        BigDecimal outputCost = hasPersistedBreakdown ? safeMoney(log.getOutputCost()) : estimated.getOutputCost();
        BigDecimal computedTotal = inputCost.add(cachedInputCost).add(outputCost);
        BigDecimal totalCost = log.getCost() != null ? log.getCost() : computedTotal;

        item.setId(log.getId());
        item.setModel(hasText(log.getModel()) ? log.getModel() : "unknown");
        item.setSceneType(hasText(log.getSceneType()) ? log.getSceneType() : "chat");
        item.setStatus(hasText(log.getStatus()) ? log.getStatus() : "success");
        item.setErrorMsg(log.getErrorMsg());
        item.setRequestIp(log.getRequestIp());
        item.setProvider(log.getProvider());
        item.setChannelId(log.getChannelId());
        item.setChannelName(channelNames.getOrDefault(safeTrim(log.getChannelId()), log.getChannelName()));
        item.setInputTokens(inputTokens);
        item.setCachedInputTokens(cachedInputTokens);
        item.setBillableInputTokens(Math.max(0, inputTokens - cachedInputTokens));
        item.setOutputTokens(outputTokens);
        item.setTotalTokens(inputTokens + outputTokens);
        item.setCacheHitRate(rate(cachedInputTokens, inputTokens));
        item.setInputPrice(hasPersistedBreakdown ? safeMoney(log.getInputPriceSnapshot()) : estimated.getInputPrice());
        item.setCachedInputPrice(hasPersistedBreakdown ? safeMoney(log.getCachedInputPriceSnapshot()) : estimated.getCachedInputPrice());
        item.setOutputPrice(hasPersistedBreakdown ? safeMoney(log.getOutputPriceSnapshot()) : estimated.getOutputPrice());
        item.setInputCost(inputCost);
        item.setCachedInputCost(cachedInputCost);
        item.setOutputCost(outputCost);
        item.setTotalCost(totalCost);
        item.setCostEstimated(!hasPersistedBreakdown);
        item.setLatencyMs(log.getLatencyMs());
        item.setCreatedAt(log.getCreatedAt());
        return item;
    }

    private Map<String, String> channelNameMap(Collection<ApiLog> logs) {
        Set<String> refs = logs == null ? Set.of() : logs.stream()
                .map(ApiLog::getChannelId)
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toSet());
        if (refs.isEmpty()) return Map.of();
        Map<String, String> result = new HashMap<>();
        modelChannelMapper.selectList(new QueryWrapper<ModelChannel>()).forEach(ch -> {
            if (!hasText(ch.getName())) return;
            if (ch.getId() != null) result.put(String.valueOf(ch.getId()), ch.getName());
            if (hasText(ch.getUuid())) result.put(ch.getUuid().trim(), ch.getName());
        });
        return result;
    }

    private Set<String> getAllowedModelSet(Long userId) {
        String modelLimit = null;
        Subscription sub = subscriptionMapper.selectOne(
                new QueryWrapper<Subscription>()
                        .eq("user_id", userId)
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .orderByDesc("created_at")
                        .last("LIMIT 1"));
        if (sub != null && hasText(sub.getModelLimit())) {
            modelLimit = sub.getModelLimit();
        }
        if (!hasText(modelLimit)) {
            SysUser user = sysUserMapper.selectById(userId);
            if (user != null && hasText(user.getPlan())) {
                SubscriptionPlan plan = subscriptionPlanMapper.selectOne(
                        new QueryWrapper<SubscriptionPlan>()
                                .eq("code", user.getPlan())
                                .eq("deleted", 0)
                                .orderByDesc("id")
                                .last("LIMIT 1"));
                if (plan != null && hasText(plan.getModelLimit())) {
                    modelLimit = plan.getModelLimit();
                }
            }
        }
        if (!hasText(modelLimit)) return null;
        Set<String> allowed = new LinkedHashSet<>();
        for (String item : parseLooseList(modelLimit)) {
            if (hasText(item)) allowed.add(item.trim());
        }
        return allowed;
    }

    private List<String> parseLooseList(String raw) {
        if (!hasText(raw)) return List.of();
        String s = raw.trim();
        if (s.startsWith("[") && s.endsWith("]")) {
            s = s.substring(1, s.length() - 1);
        }
        s = s.replace("\"", "").replace("'", "");
        List<String> result = new ArrayList<>();
        for (String part : s.split(",")) {
            String item = part.trim();
            if (!item.isBlank()) result.add(item);
        }
        return result;
    }

    private LocalDateTime parseDateTime(String raw, boolean endOfDay) {
        if (!hasText(raw)) return null;
        String value = raw.trim();
        try {
            return LocalDateTime.parse(value);
        } catch (Exception ignored) {
        }
        try {
            LocalDate date = LocalDate.parse(value);
            return endOfDay ? LocalDateTime.of(date, LocalTime.MAX) : date.atStartOfDay();
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean isSuccessLike(ApiLog log) {
        String status = log != null ? log.getStatus() : null;
        return status == null
                || status.isBlank()
                || "success".equalsIgnoreCase(status)
                || "completed".equalsIgnoreCase(status);
    }

    private BigDecimal rate(long numerator, long denominator) {
        if (denominator <= 0) return BigDecimal.ZERO;
        return BigDecimal.valueOf(numerator)
                .multiply(BigDecimal.valueOf(100))
                .divide(BigDecimal.valueOf(denominator), 2, RoundingMode.HALF_UP);
    }

    private BigDecimal safeMoney(BigDecimal value) {
        return value != null ? value : BigDecimal.ZERO;
    }

    private boolean positive(BigDecimal value) {
        return value != null && value.compareTo(BigDecimal.ZERO) > 0;
    }

    private int safeInt(Integer value) {
        return value != null ? Math.max(0, value) : 0;
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private String safeTrim(String value) {
        return value != null ? value.trim() : "";
    }
}
