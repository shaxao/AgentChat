package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.ModelRoutingRule;
import com.aiplatform.backend.entity.ModelRoutingStats;
import com.aiplatform.backend.entity.UserModelPreference;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.ModelRoutingRuleMapper;
import com.aiplatform.backend.mapper.ModelRoutingStatsMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.annotation.JsonAlias;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Service
@RequiredArgsConstructor
public class ModelRoutingService {

    private static final int CIRCUIT_BREAKER_THRESHOLD = 3;
    private static final long CIRCUIT_BREAKER_TIMEOUT_MS = 10 * 60 * 1000L;

    private final ModelConfigMapper modelConfigMapper;
    private final ModelChannelMapper modelChannelMapper;
    private final ModelRoutingRuleMapper routingRuleMapper;
    private final ModelRoutingStatsMapper routingStatsMapper;
    private final UserPreferenceService userPreferenceService;

    private final ConcurrentHashMap<String, CircuitBreakerState> circuitBreakerCache = new ConcurrentHashMap<>();

    @Data
    public static class RouteContext {
        @JsonAlias("scene_type")
        private String sceneType;
        @JsonAlias("agent_type")
        private String agentType;
        private String complexity;
        @JsonAlias("required_capabilities")
        private List<String> requiredCapabilities;
        @JsonAlias("preferred_provider")
        private String preferredProvider;
        @JsonAlias("preferred_providers")
        private List<String> preferredProviders;
        @JsonAlias("min_context_length")
        private Integer minContextLength;
        @JsonAlias("max_cost")
        private Double maxCost;
        @JsonAlias("max_input_price")
        private Double maxInputPrice;
        @JsonAlias("max_output_price")
        private Double maxOutputPrice;
        @JsonAlias("user_id")
        private String userId;
        private Map<String, Object> metadata;
        private Map<String, UserModelPreference> userPreferences;
    }

    @Data
    public static class RouteResult {
        private String modelId;
        private String channelId;
        private String provider;
        private Double score;
        private String reason;
        private List<CandidateModel> candidates;
    }

    @Data
    public static class CandidateModel {
        private String modelId;
        private String channelId;
        private String provider;
        private Double score;
        private String reason;
    }

    private static class CircuitBreakerState {
        int consecutiveFailures;
        long lastFailureTime;
        boolean open;
    }

    public RouteResult selectModel(RouteContext context) {
        RouteContext ctx = context != null ? context : new RouteContext();
        applyBestMatchingRule(ctx);

        List<ModelConfig> filteredModels = filterModels(getAvailableModels(), ctx);
        if (filteredModels.isEmpty()) filteredModels = getAvailableModels();
        if (filteredModels.isEmpty()) return null;

        Map<String, ModelChannel> channelsByModel = activeChannelsByModel();
        List<CandidateModel> candidates = new ArrayList<>();
        for (ModelConfig model : filteredModels) {
            ModelChannel channel = channelsByModel.get(model.getModelId());
            CandidateModel candidate = new CandidateModel();
            candidate.setModelId(model.getModelId());
            candidate.setChannelId(channel == null ? null : (channel.getUuid() != null ? channel.getUuid() : String.valueOf(channel.getId())));
            candidate.setProvider(model.getProvider() != null ? model.getProvider() : (channel == null ? null : channel.getProvider()));
            candidate.setScore(scoreModel(model, ctx));
            candidate.setReason(buildReason(model, ctx));
            candidates.add(candidate);
        }
        if (candidates.isEmpty()) return null;
        candidates.sort((a, b) -> Double.compare(b.getScore(), a.getScore()));
        CandidateModel best = candidates.get(0);

        RouteResult result = new RouteResult();
        result.setModelId(best.getModelId());
        result.setChannelId(best.getChannelId());
        result.setProvider(best.getProvider());
        result.setScore(best.getScore());
        result.setReason(best.getReason());
        result.setCandidates(candidates);
        return result;
    }

    public List<ModelConfig> getAvailableModels() {
        return modelConfigMapper.selectList(new LambdaQueryWrapper<ModelConfig>()
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getDeleted, 0)
                // "auto" is a routing mode marker, not a real provider model.
                .ne(ModelConfig::getModelId, "auto")
                .orderByAsc(ModelConfig::getProvider)
                .orderByAsc(ModelConfig::getModelId));
    }

    public List<ModelRoutingRule> getRoutingRules(boolean enabledOnly) {
        return getRoutingRules(enabledOnly, null, true);
    }

    public List<ModelRoutingRule> getRoutingRules(boolean enabledOnly, Long userId, boolean includeGlobal) {
        LambdaQueryWrapper<ModelRoutingRule> wrapper = new LambdaQueryWrapper<ModelRoutingRule>()
                .eq(ModelRoutingRule::getDeleted, 0);
        if (enabledOnly) wrapper.eq(ModelRoutingRule::getEnabled, true);
        if (userId != null) {
            if (includeGlobal) {
                wrapper.and(w -> w.isNull(ModelRoutingRule::getUserId).or().eq(ModelRoutingRule::getUserId, userId));
            } else {
                wrapper.eq(ModelRoutingRule::getUserId, userId);
            }
        } else {
            wrapper.isNull(ModelRoutingRule::getUserId);
        }
        List<ModelRoutingRule> rules = routingRuleMapper.selectList(wrapper);
        rules.sort(Comparator
                .comparing((ModelRoutingRule rule) -> isPersonalRule(rule, userId) ? 0 : 1)
                .thenComparing(rule -> rule.getPriority() == null ? 0 : -rule.getPriority())
                .thenComparing(rule -> rule.getId() == null ? Long.MAX_VALUE : rule.getId()));
        return rules;
    }

    public void recordSuccess(String modelId, String sceneType, int responseTimeMs) {
        if (modelId == null || modelId.isBlank()) return;
        ModelRoutingStats stats = getOrCreateStats(modelId, sceneType);
        stats.setTotalRequests(nvl(stats.getTotalRequests()) + 1);
        stats.setSuccessRequests(nvl(stats.getSuccessRequests()) + 1);
        stats.setAvgResponseTime(newAverage(stats.getAvgResponseTime(), responseTimeMs, stats.getSuccessRequests()));
        stats.setConsecutiveFailures(0);
        stats.setCircuitBreakerState("closed");
        stats.setLastSuccessTime(LocalDateTime.now());
        routingStatsMapper.updateById(stats);
        circuitBreakerCache.remove(modelId);
    }

    public void recordFailure(String modelId, String sceneType) {
        if (modelId == null || modelId.isBlank()) return;
        ModelRoutingStats stats = getOrCreateStats(modelId, sceneType);
        int failures = nvl(stats.getConsecutiveFailures()) + 1;
        stats.setTotalRequests(nvl(stats.getTotalRequests()) + 1);
        stats.setFailedRequests(nvl(stats.getFailedRequests()) + 1);
        stats.setConsecutiveFailures(failures);
        stats.setLastFailureTime(LocalDateTime.now());
        stats.setCircuitBreakerState(failures >= CIRCUIT_BREAKER_THRESHOLD ? "open" : "closed");
        routingStatsMapper.updateById(stats);

        CircuitBreakerState state = circuitBreakerCache.computeIfAbsent(modelId, ignored -> new CircuitBreakerState());
        state.consecutiveFailures = failures;
        state.lastFailureTime = System.currentTimeMillis();
        state.open = failures >= CIRCUIT_BREAKER_THRESHOLD;
    }

    public boolean resetCircuitBreaker(String modelId) {
        if (modelId == null || modelId.isBlank()) return false;
        circuitBreakerCache.remove(modelId);
        routingStatsMapper.resetCircuitBreaker(modelId);
        return true;
    }

    public int getCircuitBreakerCacheSize() {
        return circuitBreakerCache.size();
    }

    public Map<String, Integer> getCircuitBreakerFailureCounts() {
        Map<String, Integer> result = new LinkedHashMap<>();
        circuitBreakerCache.forEach((modelId, state) -> result.put(modelId, state.consecutiveFailures));
        return result;
    }

    public Map<String, Long> getCircuitBreakerBrokenSeconds() {
        Map<String, Long> result = new LinkedHashMap<>();
        long now = System.currentTimeMillis();
        circuitBreakerCache.forEach((modelId, state) -> {
            if (state.open) result.put(modelId, Math.max(0L, (now - state.lastFailureTime) / 1000L));
        });
        return result;
    }

    private List<ModelConfig> filterModels(List<ModelConfig> models, RouteContext ctx) {
        List<ModelConfig> filtered = new ArrayList<>();
        for (ModelConfig model : models) {
            if (isCircuitBreakerOpen(model.getModelId())) continue;
            if (!hasCapabilities(model, ctx.getRequiredCapabilities())) continue;
            if (ctx.getMinContextLength() != null && model.getContextLength() != null
                    && model.getContextLength() < ctx.getMinContextLength()) continue;
            if (ctx.getMaxInputPrice() != null && model.getInputPrice() != null
                    && model.getInputPrice().doubleValue() > ctx.getMaxInputPrice()) continue;
            if (ctx.getMaxOutputPrice() != null && model.getOutputPrice() != null
                    && model.getOutputPrice().doubleValue() > ctx.getMaxOutputPrice()) continue;
            filtered.add(model);
        }
        return filtered;
    }

    private double scoreModel(ModelConfig model, RouteContext ctx) {
        double score = 50.0;
        if (hasCapabilities(model, ctx.getRequiredCapabilities())) score += 20.0;
        if (matchesPreferredProvider(model, ctx)) score += 12.0;
        score += Math.min(10.0, nvl(model.getRoutingPriority()) * 1.2);
        score += costScore(model);
        score += userPreferenceScore(model, ctx);
        if (model.getContextLength() != null && ctx.getMinContextLength() != null
                && model.getContextLength() >= ctx.getMinContextLength()) score += 5.0;
        return Math.max(0.0, Math.min(100.0, score));
    }

    private double costScore(ModelConfig model) {
        BigDecimal input = model.getInputPrice() != null ? model.getInputPrice() : BigDecimal.ZERO;
        BigDecimal output = model.getOutputPrice() != null ? model.getOutputPrice() : BigDecimal.ZERO;
        double cost = input.add(output).doubleValue();
        if (cost <= 0) return 8.0;
        if (cost <= 1) return 7.0;
        if (cost <= 5) return 4.0;
        return 1.0;
    }

    private double userPreferenceScore(ModelConfig model, RouteContext ctx) {
        Map<String, UserModelPreference> prefs = ctx.getUserPreferences();
        if ((prefs == null || prefs.isEmpty()) && ctx.getUserId() != null) {
            try {
                Long userId = Long.valueOf(ctx.getUserId());
                prefs = userPreferenceService.getPreferencesByUser(userId);
            } catch (Exception ignored) {
                return 0.0;
            }
        }
        String sceneType = ctx.getSceneType() != null ? ctx.getSceneType() : "chat";
        UserModelPreference pref = prefs != null ? prefs.get(model.getModelId() + ":" + sceneType) : null;
        if (pref == null && prefs != null) {
            pref = prefs.get(model.getModelId());
        }
        if (pref == null || pref.getPreferenceWeight() == null) return 0.0;
        return Math.max(-8.0, Math.min(8.0, pref.getPreferenceWeight().doubleValue() * 8.0));
    }

    private String buildReason(ModelConfig model, RouteContext ctx) {
        List<String> reasons = new ArrayList<>();
        if (hasCapabilities(model, ctx.getRequiredCapabilities())) reasons.add("capability matched");
        if (matchesPreferredProvider(model, ctx)) reasons.add("preferred provider");
        if (model.getRoutingPriority() != null) reasons.add("priority " + model.getRoutingPriority());
        return reasons.isEmpty() ? "default score" : String.join(", ", reasons);
    }

    private boolean hasCapabilities(ModelConfig model, List<String> required) {
        if (required == null || required.isEmpty()) return true;
        Set<String> caps = new HashSet<>(parseList(model.getCapabilities()));
        for (String item : required) {
            if (item != null && !item.isBlank() && !caps.contains(item.trim())) return false;
        }
        return true;
    }

    private boolean matchesPreferredProvider(ModelConfig model, RouteContext ctx) {
        String provider = model.getProvider();
        if (provider == null) return false;
        if (ctx.getPreferredProvider() != null && provider.equalsIgnoreCase(ctx.getPreferredProvider())) return true;
        if (ctx.getPreferredProviders() == null) return false;
        return ctx.getPreferredProviders().stream().anyMatch(p -> provider.equalsIgnoreCase(p));
    }

    private Map<String, ModelChannel> activeChannelsByModel() {
        List<ModelChannel> channels = modelChannelMapper.selectList(new LambdaQueryWrapper<ModelChannel>()
                .eq(ModelChannel::getDeleted, 0)
                .in(ModelChannel::getStatus, List.of("active", "enabled"))
                .and(w -> w.isNull(ModelChannel::getChannelType).or().eq(ModelChannel::getChannelType, "chat"))
                .orderByAsc(ModelChannel::getPriority));
        Map<String, ModelChannel> result = new LinkedHashMap<>();
        for (ModelChannel channel : channels) {
            for (String modelId : parseList(channel.getModels())) {
                result.putIfAbsent(modelId, channel);
            }
        }
        return result;
    }

    private void applyBestMatchingRule(RouteContext ctx) {
        Long userId = parseUserId(ctx.getUserId());
        for (ModelRoutingRule rule : getRoutingRules(true, userId, true)) {
            if (!matchesRule(rule, ctx)) continue;
            if ((ctx.getRequiredCapabilities() == null || ctx.getRequiredCapabilities().isEmpty())
                    && rule.getRequiredCapabilities() != null) {
                ctx.setRequiredCapabilities(parseList(rule.getRequiredCapabilities()));
            }
            if ((ctx.getPreferredProviders() == null || ctx.getPreferredProviders().isEmpty())
                    && rule.getPreferredProviders() != null) {
                ctx.setPreferredProviders(parseList(rule.getPreferredProviders()));
            }
            if (ctx.getMinContextLength() == null) ctx.setMinContextLength(rule.getMinContextLength());
            if (ctx.getMaxInputPrice() == null && rule.getMaxInputPrice() != null) {
                ctx.setMaxInputPrice(rule.getMaxInputPrice().doubleValue());
            }
            if (ctx.getMaxOutputPrice() == null && rule.getMaxOutputPrice() != null) {
                ctx.setMaxOutputPrice(rule.getMaxOutputPrice().doubleValue());
            }
            return;
        }
    }

    private boolean isPersonalRule(ModelRoutingRule rule, Long userId) {
        return userId != null && rule != null && userId.equals(rule.getUserId());
    }

    private Long parseUserId(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return Long.valueOf(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    private boolean matchesRule(ModelRoutingRule rule, RouteContext ctx) {
        return matches(rule.getSceneType(), ctx.getSceneType())
                && matches(rule.getAgentType(), ctx.getAgentType())
                && matches(rule.getComplexity(), ctx.getComplexity());
    }

    private boolean matches(String ruleValue, String actual) {
        return ruleValue == null || ruleValue.isBlank() || "any".equalsIgnoreCase(ruleValue)
                || (actual != null && ruleValue.equalsIgnoreCase(actual));
    }

    private boolean isCircuitBreakerOpen(String modelId) {
        CircuitBreakerState state = circuitBreakerCache.get(modelId);
        if (state == null || !state.open) return false;
        if (System.currentTimeMillis() - state.lastFailureTime > CIRCUIT_BREAKER_TIMEOUT_MS) {
            state.open = false;
            state.consecutiveFailures = 0;
            return false;
        }
        return true;
    }

    private ModelRoutingStats getOrCreateStats(String modelId, String sceneType) {
        String normalizedScene = sceneType != null ? sceneType : "default";
        ModelRoutingStats stats = routingStatsMapper.findByModelIdAndScene(modelId, normalizedScene);
        if (stats != null) return stats;
        stats = new ModelRoutingStats();
        stats.setModelId(modelId);
        stats.setSceneType(normalizedScene);
        stats.setTotalRequests(0);
        stats.setSuccessRequests(0);
        stats.setFailedRequests(0);
        stats.setAvgResponseTime(0);
        stats.setConsecutiveFailures(0);
        stats.setCircuitBreakerState("closed");
        routingStatsMapper.insert(stats);
        return stats;
    }

    private int newAverage(Integer currentAvg, int latest, int count) {
        if (count <= 1) return latest;
        int avg = currentAvg != null ? currentAvg : 0;
        return Math.round(((avg * (count - 1)) + latest) / (float) count);
    }

    private int nvl(Integer value) {
        return value != null ? value : 0;
    }

    private List<String> parseList(String raw) {
        if (raw == null || raw.isBlank()) return List.of();
        String s = raw.trim();
        if (s.startsWith("[") && s.endsWith("]")) s = s.substring(1, s.length() - 1);
        s = s.replace("\"", "").replace("'", "");
        List<String> result = new ArrayList<>();
        for (String part : s.split(",")) {
            String item = part.trim();
            if (!item.isBlank()) result.add(item);
        }
        return result;
    }
}
