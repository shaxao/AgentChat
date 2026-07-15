package com.aiplatform.backend.controller;

import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.ModelRoutingRule;
import com.aiplatform.backend.entity.ModelRoutingStats;
import com.aiplatform.backend.mapper.ModelRoutingRuleMapper;
import com.aiplatform.backend.mapper.ModelRoutingStatsMapper;
import com.aiplatform.backend.service.ModelRoutingService;
import com.aiplatform.backend.service.ModelRoutingService.RouteContext;
import com.aiplatform.backend.service.ModelRoutingService.RouteResult;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/routing")
public class ModelRoutingController {

    private static final String ADMIN_ROUTE_RULE_MESSAGE = "无权限，仅管理员可操作全局路由规则";

    @Autowired
    private ModelRoutingService modelRoutingService;

    @Autowired
    private ModelRoutingRuleMapper routingRuleMapper;

    @Autowired
    private ModelRoutingStatsMapper routingStatsMapper;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @GetMapping("/rules")
    public ResponseEntity<?> getRoutingRules(
            @RequestAttribute(required = false) Long userId,
            @RequestAttribute(required = false) String userRole,
            @RequestParam(required = false, defaultValue = "false") Boolean enabledOnly,
            @RequestParam(required = false, defaultValue = "effective") String scope,
            @RequestParam(required = false, name = "agent_type") String agentType,
            @RequestParam(required = false) String complexity,
            @RequestParam(required = false) Boolean enabled,
            @RequestParam(required = false, defaultValue = "1") Integer page,
            @RequestParam(required = false, name = "page_size", defaultValue = "20") Integer pageSize) {
        try {
            if (isAdminOnlyScope(scope) && !isAdmin(userRole)) {
                return ResponseEntity.status(403).body(Map.of("error", "无权查看全局路由规则"));
            }
            List<ModelRoutingRule> rules = routingRulesForScope(enabledOnly, userId, userRole, scope);
            List<ModelRoutingRule> filtered = rules.stream()
                    .filter(rule -> agentType == null || agentType.isBlank() || agentType.equals(rule.getAgentType()))
                    .filter(rule -> complexity == null || complexity.isBlank() || complexity.equals(rule.getComplexity()))
                    .filter(rule -> enabled == null || enabled.equals(rule.getEnabled()))
                    .toList();

            int safePage = Math.max(1, page == null ? 1 : page);
            int safePageSize = Math.max(1, pageSize == null ? 20 : pageSize);
            int total = filtered.size();
            int from = Math.min((safePage - 1) * safePageSize, total);
            int to = Math.min(from + safePageSize, total);

            Map<String, Object> pagination = new HashMap<>();
            pagination.put("page", safePage);
            pagination.put("page_size", safePageSize);
            pagination.put("total", total);
            pagination.put("total_pages", (int) Math.ceil(total / (double) safePageSize));

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("data", filtered.subList(from, to));
            response.put("pagination", pagination);
            return ResponseEntity.ok(response);
        } catch (AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/models")
    public ResponseEntity<?> getRoutingModels() {
        try {
            List<Map<String, Object>> models = modelRoutingService.getAvailableModels().stream()
                    .map(this::toRoutingModelOption)
                    .toList();
            return ResponseEntity.ok(Map.of("success", true, "data", models, "total", models.size()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/rules")
    public ResponseEntity<?> createRoutingRule(
            @RequestAttribute(required = false) String userRole,
            @RequestAttribute(required = false) Long userId,
            @RequestParam(required = false, defaultValue = "mine") String scope,
            @RequestBody ModelRoutingRule rule) {
        try {
            if ("global".equalsIgnoreCase(scope)) {
                requireAdmin(userRole);
                rule.setUserId(null);
            } else {
                if (userId == null) {
                    return ResponseEntity.status(401).body(Map.of("error", "未登录"));
                }
                rule.setUserId(userId);
            }
            rule.setDeleted(0);
            routingRuleMapper.insert(rule);
            return ResponseEntity.ok(Map.of("success", true, "id", rule.getId()));
        } catch (AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PutMapping("/rules/{id}")
    public ResponseEntity<?> updateRoutingRule(
            @RequestAttribute(required = false) String userRole,
            @RequestAttribute(required = false) Long userId,
            @PathVariable Long id,
            @RequestBody ModelRoutingRule rule) {
        try {
            ModelRoutingRule existing = routingRuleMapper.selectById(id);
            if (!canModifyRule(existing, userId, userRole)) {
                return ResponseEntity.status(403).body(Map.of("error", ADMIN_ROUTE_RULE_MESSAGE));
            }
            rule.setId(id);
            rule.setUserId(existing.getUserId());
            routingRuleMapper.updateById(rule);
            return ResponseEntity.ok(Map.of("success", true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @DeleteMapping("/rules/{id}")
    public ResponseEntity<?> deleteRoutingRule(
            @RequestAttribute(required = false) String userRole,
            @RequestAttribute(required = false) Long userId,
            @PathVariable Long id) {
        try {
            ModelRoutingRule existing = routingRuleMapper.selectById(id);
            if (!canModifyRule(existing, userId, userRole)) {
                return ResponseEntity.status(403).body(Map.of("error", ADMIN_ROUTE_RULE_MESSAGE));
            }
            int affected = routingRuleMapper.deleteById(id);
            if (affected <= 0) {
                return ResponseEntity.status(404).body(Map.of("error", "路由规则不存在或已删除"));
            }
            return ResponseEntity.ok(Map.of("success", true, "deleted", true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/stats")
    public ResponseEntity<?> getRoutingStats(
            @RequestAttribute(required = false) Long userId,
            @RequestAttribute(required = false) String userRole,
            @RequestParam(required = false) String sceneType,
            @RequestParam(required = false, defaultValue = "effective") String scope) {
        try {
            if (isAdminOnlyScope(scope) && !isAdmin(userRole)) {
                return ResponseEntity.status(403).body(Map.of("error", "无权查看全局路由规则"));
            }
            LambdaQueryWrapper<ModelRoutingStats> wrapper = new LambdaQueryWrapper<>();
            if (sceneType != null && !sceneType.isEmpty()) {
                wrapper.eq(ModelRoutingStats::getSceneType, sceneType);
            }
            List<ModelRoutingStats> stats = routingStatsMapper.selectList(wrapper);

            List<ModelRoutingRule> rules = routingRulesForScope(false, userId, userRole, scope);
            Map<String, Long> byAgentType = new HashMap<>();
            rules.forEach(rule -> {
                String key = rule.getAgentType() == null ? "*" : rule.getAgentType();
                byAgentType.put(key, byAgentType.getOrDefault(key, 0L) + 1);
            });

            Map<String, Long> byModel = new HashMap<>();
            for (ModelConfig model : modelRoutingService.getAvailableModels()) {
                byModel.put(model.getModelId(), 1L);
            }

            Map<String, Object> rulesSummary = new HashMap<>();
            rulesSummary.put("total", rules.size());
            rulesSummary.put("by_agent_type", byAgentType);
            rulesSummary.put("by_model", byModel);

            Map<String, Object> breaker = new HashMap<>();
            breaker.put("broken", modelRoutingService.getCircuitBreakerBrokenSeconds());
            breaker.put("failure_counts", modelRoutingService.getCircuitBreakerFailureCounts());

            Map<String, Object> cache = new HashMap<>();
            cache.put("entries", modelRoutingService.getCircuitBreakerCacheSize());

            Map<String, Object> data = new HashMap<>();
            data.put("rules", rulesSummary);
            data.put("circuit_breaker", breaker);
            data.put("cache", cache);
            data.put("history", stats);

            return ResponseEntity.ok(Map.of("success", true, "data", data));
        } catch (AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/stats/candidates")
    public ResponseEntity<?> getCandidates(
            @RequestAttribute(required = false) Long userId,
            @RequestParam String sceneType,
            @RequestParam(required = false) String agentType,
            @RequestParam(required = false, defaultValue = "moderate") String complexity) {
        try {
            RouteContext context = new RouteContext();
            if (userId != null) {
                context.setUserId(String.valueOf(userId));
            }
            context.setSceneType(sceneType);
            context.setAgentType(agentType);
            context.setComplexity(complexity);

            switch (sceneType) {
                case "vision" -> context.setRequiredCapabilities(List.of("vision"));
                case "code" -> context.setRequiredCapabilities(List.of("code"));
                case "image" -> context.setRequiredCapabilities(List.of("image"));
                case "agent" -> context.setRequiredCapabilities(List.of("tool"));
                default -> {
                }
            }

            RouteResult result = modelRoutingService.selectModel(context);
            if (result == null) {
                return ResponseEntity.ok(Map.of("success", false, "message", "没有可用的模型"));
            }

            Map<String, Object> response = new HashMap<>();
            response.put("selected", Map.of(
                    "modelId", result.getModelId(),
                    "provider", result.getProvider(),
                    "score", result.getScore(),
                    "reason", result.getReason()
            ));
            response.put("candidates", result.getCandidates());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/test")
    public ResponseEntity<?> testRouting(
            @RequestAttribute(required = false) Long userId,
            @RequestBody RouteContext context) {
        try {
            if (context != null && userId != null) {
                context.setUserId(String.valueOf(userId));
            }
            RouteResult result = modelRoutingService.selectModel(context);
            if (result == null) {
                return ResponseEntity.ok(Map.of("success", false, "message", "没有可用的模型"));
            }

            Map<String, Object> data = new HashMap<>();
            data.put("selected", Map.of(
                    "modelId", result.getModelId(),
                    "provider", result.getProvider(),
                    "score", result.getScore(),
                    "reason", result.getReason()
            ));
            data.put("candidates", result.getCandidates());
            data.put("total", result.getCandidates() == null ? 0 : result.getCandidates().size());
            return ResponseEntity.ok(Map.of("success", true, "data", data));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/stats/success")
    public ResponseEntity<?> recordSuccess(
            @RequestParam String modelId,
            @RequestParam(required = false) String sceneType,
            @RequestParam int responseTimeMs) {
        try {
            modelRoutingService.recordSuccess(modelId, sceneType, responseTimeMs);
            return ResponseEntity.ok(Map.of("success", true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/stats/failure")
    public ResponseEntity<?> recordFailure(
            @RequestParam String modelId,
            @RequestParam(required = false) String sceneType) {
        try {
            modelRoutingService.recordFailure(modelId, sceneType);
            return ResponseEntity.ok(Map.of("success", true));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    @PostMapping("/stats/reset-circuit-breaker")
    public ResponseEntity<?> resetCircuitBreaker(
            @RequestAttribute String userRole,
            @RequestParam(required = false) String modelId,
            @RequestParam(required = false, name = "model_id") String modelIdSnake) {
        try {
            requireAdmin(userRole);
            if ((modelId == null || modelId.isBlank()) && modelIdSnake != null) {
                modelId = modelIdSnake;
            }
            boolean success = modelRoutingService.resetCircuitBreaker(modelId);
            return ResponseEntity.ok(Map.of("success", success));
        } catch (AccessDeniedException e) {
            return ResponseEntity.status(403).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.internalServerError().body(Map.of("error", e.getMessage()));
        }
    }

    private void requireAdmin(String role) {
        if (!isAdmin(role)) {
            throw new AccessDeniedException(ADMIN_ROUTE_RULE_MESSAGE);
        }
    }

    private Map<String, Object> toRoutingModelOption(ModelConfig model) {
        Map<String, Object> item = new HashMap<>();
        item.put("id", model.getId());
        item.put("model_id", model.getModelId());
        item.put("modelId", model.getModelId());
        item.put("name", model.getName());
        item.put("provider", model.getProvider());
        item.put("channel_name", model.getProvider());
        item.put("capabilities", parseCsv(model.getCapabilities()));
        item.put("strengths", parseJsonList(model.getStrengths()));
        item.put("task_types", parseJsonList(model.getTaskTypes()));
        item.put("context_length", model.getContextLength());
        item.put("contextLength", model.getContextLength());
        item.put("input_price", model.getInputPrice());
        item.put("inputPrice", model.getInputPrice());
        item.put("cached_input_price", model.getCachedInputPrice());
        item.put("cachedInputPrice", model.getCachedInputPrice());
        item.put("output_price", model.getOutputPrice());
        item.put("outputPrice", model.getOutputPrice());
        item.put("code_quality", model.getCodeQuality() == null ? 0 : model.getCodeQuality());
        item.put("codeQuality", model.getCodeQuality() == null ? 0 : model.getCodeQuality());
        item.put("routing_priority", model.getRoutingPriority());
        item.put("routingPriority", model.getRoutingPriority());
        item.put("status", Map.of(
                "available", true,
                "failures", modelRoutingService.getCircuitBreakerFailureCounts().getOrDefault(model.getModelId(), 0)
        ));
        return item;
    }

    private List<ModelRoutingRule> routingRulesForScope(Boolean enabledOnly, Long userId, String userRole, String scope) {
        String normalizedScope = scope == null ? "effective" : scope.trim().toLowerCase();
        boolean admin = isAdmin(userRole);
        if ("global".equals(normalizedScope)) {
            if (!admin) {
                throw new AccessDeniedException(ADMIN_ROUTE_RULE_MESSAGE);
            }
            return modelRoutingService.getRoutingRules(Boolean.TRUE.equals(enabledOnly), null, true);
        }
        if ("mine".equals(normalizedScope) || "personal".equals(normalizedScope)) {
            if (userId == null) {
                return List.of();
            }
            return modelRoutingService.getRoutingRules(Boolean.TRUE.equals(enabledOnly), userId, false);
        }
        if ("all".equals(normalizedScope)) {
            if (!admin) {
                throw new AccessDeniedException(ADMIN_ROUTE_RULE_MESSAGE);
            }
            return routingRuleMapper.selectList(new LambdaQueryWrapper<ModelRoutingRule>()
                    .eq(ModelRoutingRule::getDeleted, 0));
        }
        if (userId == null) {
            return modelRoutingService.getRoutingRules(Boolean.TRUE.equals(enabledOnly), null, true);
        }
        return modelRoutingService.getRoutingRules(Boolean.TRUE.equals(enabledOnly), userId, true);
    }

    private boolean canModifyRule(ModelRoutingRule rule, Long userId, String userRole) {
        if (rule == null || Integer.valueOf(1).equals(rule.getDeleted())) {
            return false;
        }
        if (rule.getUserId() == null) {
            return isAdmin(userRole);
        }
        return userId != null && userId.equals(rule.getUserId());
    }

    private boolean isAdminOnlyScope(String scope) {
        if (scope == null) {
            return false;
        }
        String normalized = scope.trim().toLowerCase();
        return "global".equals(normalized) || "all".equals(normalized);
    }

    private boolean isAdmin(String role) {
        return "admin".equalsIgnoreCase(role) || "super_admin".equalsIgnoreCase(role);
    }

    private List<String> parseCsv(String value) {
        if (value == null || value.isBlank()) {
            return List.of();
        }
        return Arrays.stream(value.split(","))
                .map(String::trim)
                .filter(s -> !s.isBlank())
                .distinct()
                .toList();
    }

    private List<String> parseJsonList(String value) {
        if (value == null || value.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(value, new TypeReference<List<String>>() {});
        } catch (Exception ignored) {
            return parseCsv(value);
        }
    }
}
