package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.AuthDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.service.AdminService;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.aiplatform.backend.util.ClientIpUtil;
import com.aiplatform.backend.billing.BillingException;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import jakarta.servlet.http.HttpServletRequest;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminController {

    private final AdminService adminService;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final SysUserMapper sysUserMapper;
    private final ObjectMapper objectMapper;

    private boolean invalidInternalApiKey(String apiKey) {
        String expectedKey = System.getenv("INTERNAL_API_KEY");
        if (expectedKey == null || expectedKey.isEmpty()) {
            expectedKey = System.getenv("MUHUGOCHAT_INTERNAL_API_KEY");
        }
        return expectedKey != null && !expectedKey.isEmpty() && !expectedKey.equals(apiKey);
    }

    private String internalApiKey(String queryApiKey, HttpServletRequest request) {
        if (queryApiKey != null && !queryApiKey.isBlank()) {
            return queryApiKey;
        }
        if (request == null) {
            return null;
        }
        String header = request.getHeader("X-Internal-Api-Key");
        if (header != null && !header.isBlank()) {
            return header.trim();
        }
        return null;
    }

    private void requireAdmin(String role) {
        if (!"admin".equals(role) && !"super_admin".equals(role))
            throw new RuntimeException("无权限，仅管理员可操作");
    }

    // ====== 统计概览 ======

    @GetMapping("/stats")
    public Result<Map<String, Object>> getStats(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(adminService.getStats());
    }

    // ====== 用户管理 ======

    @GetMapping("/users")
    public Result<Result.PageResult<AuthDTO.UserVO>> listUsers(
            @RequestAttribute String userRole,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String role,
            @RequestParam(required = false) String status) {
        requireAdmin(userRole);
        return Result.ok(adminService.listUsers(page, size, keyword, role, status));
    }

    @PostMapping("/users")
    public Result<AuthDTO.UserVO> createUser(
            @RequestAttribute String userRole,
            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        // 前端发 name 字段，兼容 username
        String username = body.get("name") != null ? (String) body.get("name") : (String) body.get("username");
        return Result.ok(adminService.createUser(
                username,
                (String) body.get("email"),
                (String) body.getOrDefault("password", "Admin@123456"),
                (String) body.get("role"),
                (String) body.get("plan"),
                body.get("costLimit") != null ? new java.math.BigDecimal(body.get("costLimit").toString()) : null,
                body.get("tokensLimit") != null ? Long.valueOf(body.get("tokensLimit").toString()) : null,
                (String) body.get("status")
        ));
    }

    @PutMapping("/users/{uuid}")
    public Result<AuthDTO.UserVO> updateUser(
            @RequestAttribute String userRole,
            @PathVariable String uuid,
            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        String username = body.get("name") != null ? (String) body.get("name") : (String) body.get("username");
        String newPassword = (String) body.get("password");
        AuthDTO.UserVO vo = adminService.updateUser(
                uuid, username,
                (String) body.get("email"),
                (String) body.get("role"),
                (String) body.get("plan"),
                body.get("costLimit") != null ? new java.math.BigDecimal(body.get("costLimit").toString()) : null,
                body.get("tokensLimit") != null ? Long.valueOf(body.get("tokensLimit").toString()) : null,
                (String) body.get("status")
        );
        // 如果传了新密码，重置密码
        if (newPassword != null && !newPassword.isBlank()) {
            adminService.resetUserPassword(uuid, newPassword);
        }
        return Result.ok(vo);
    }

    @DeleteMapping("/users/{uuid}")
    public Result<String> deleteUser(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        adminService.deleteUser(uuid);
        return Result.ok("删除成功");
    }

    // ====== 渠道管理 ======

    /** 渠道请求 DTO（models 字段接收数组或字符串均可） */
    @Data
    public static class ChannelRequest {
        private String name;
        private String provider;
        private String apiKey;
        private String baseUrl;
        private Object models;
        private Object tags;
        private String status;
        private String channelType;
        private Integer priority;
        private Integer rateLimit;
        private String uuid;
        /** TTS 音色配置 JSON 数组字符串，如 [{"id":"alloy","label":"标准"}] */
        private String ttsVoices;
        /** 翻译支持语言配置 JSON 数组字符串，如 [{"code":"英文","label":"🇺🇸 英文"}] */
        private String translateLangs;

        public String getModelsAsString() {
            if (models == null) return "";
            if (models instanceof List<?> list) {
                return String.join(",", list.stream().map(Object::toString).toList());
            }
            String s = models.toString().trim();
            if (s.startsWith("[")) {
                s = s.replaceAll("[\\[\\]\"]", "").trim();
            }
            return s;
        }

        public String getTagsAsString() {
            if (tags == null) return null;
            if (tags instanceof List<?> list) {
                return "[" + String.join(",", list.stream()
                    .map(Object::toString).map(t -> "\"" + t + "\"").toList()) + "]";
            }
            return tags.toString().trim();
        }
    }

    @GetMapping("/channels")
    public Result<List<ModelChannel>> listChannels(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(adminService.listChannels());
    }

    /**
     * [内部 API] 供 Autocode 后端获取渠道配置（无需管理员权限）
     * 用于本地开发环境，Autocode 通过 HTTP 调用获取配置
     */
    @GetMapping("/internal/channels")
    public Result<List<ModelChannel>> listChannelsInternal(
            @RequestParam(required = false) String apiKey,
            HttpServletRequest servletRequest) {
        // 简单的 API Key 验证（可选）
        if (invalidInternalApiKey(internalApiKey(apiKey, servletRequest))) {
            return Result.fail(403, "Invalid API key");
        }
        return Result.ok(adminService.listChannels());
    }

    /**
     * [内部 API] 供 Autocode 后端获取模型配置（无需管理员权限）
     */
    @GetMapping("/internal/models")
    public Result<List<ModelConfig>> listModelsInternal(
            @RequestParam(required = false) String apiKey,
            HttpServletRequest servletRequest) {
        if (invalidInternalApiKey(internalApiKey(apiKey, servletRequest))) {
            return Result.fail(403, "Invalid API key");
        }
        return Result.ok(adminService.listModels());
    }

    @Data
    public static class InternalChatCompletionRequest {
        private String model;
        private String system;
        private List<Map<String, Object>> messages;
        private List<Map<String, Object>> tools;
        private Double temperature;
        private Integer maxTokens;
        private Boolean thinking;
        private Integer thinkingBudget;
    }

    /**
     * [内部 API] 供 AutoCode 复用 Java 对话系统的模型调用链路。
     * 返回 OpenAI-compatible JSON，工具只透传给模型，不在 Java 侧执行。
     */
    @PostMapping("/internal/chat/completions")
    public Result<JsonNode> chatCompletionInternal(
            @RequestParam(required = false) String apiKey,
            @RequestBody InternalChatCompletionRequest req,
            HttpServletRequest servletRequest) {
        if (invalidInternalApiKey(internalApiKey(apiKey, servletRequest))) {
            return Result.fail(403, "Invalid API key");
        }
        if (req == null) {
            return Result.fail(400, "request is required");
        }
        List<ToolDefinition> toolDefinitions = new ArrayList<>();
        if (req.getTools() != null) {
            for (Map<String, Object> rawTool : req.getTools()) {
                Object functionObj = rawTool.get("function");
                Map<?, ?> fn = functionObj instanceof Map<?, ?> m ? m : rawTool;
                String name = fn.get("name") != null ? String.valueOf(fn.get("name")) : "";
                if (name.isBlank()) continue;
                String description = fn.get("description") != null ? String.valueOf(fn.get("description")) : "";
                Object parameters = fn.get("parameters");
                ObjectNode parameterNode = parameters != null
                        ? objectMapper.valueToTree(parameters)
                        : objectMapper.createObjectNode().put("type", "object");
                toolDefinitions.add(new ToolDefinition(name, description, parameterNode));
            }
        }

        JsonNode response = aiService.chatCompletionRaw(
                req.getModel(),
                req.getSystem(),
                req.getMessages(),
                req.getTemperature(),
                req.getMaxTokens(),
                toolDefinitions,
                req.getThinking(),
                req.getThinkingBudget());
        return Result.ok(response);
    }

    @Data
    public static class InternalUsageRequest {
        private Long userId;
        private String userUuid;
        private String model;
        private Integer inputTokens;
        private Integer cachedInputTokens;
        private Integer outputTokens;
        private Integer latencyMs;
        private String status;
        private String errorMsg;
        private String sceneType;
        private String agentId;
        private String requestIp;
        private String provider;
        private String channelId;
    }

    /**
     * [内部 API] AutoCode/工作流等独立服务上报模型使用量。
     * 该接口复用主系统计费链路：钱包扣费、订阅用量、api_log、模型偏好统计。
     */
    @PostMapping("/internal/usage")
    public Result<String> trackInternalUsage(
            @RequestParam(required = false) String apiKey,
            @RequestBody InternalUsageRequest req,
            HttpServletRequest servletRequest) {
        if (invalidInternalApiKey(internalApiKey(apiKey, servletRequest))) {
            return Result.fail(403, "Invalid API key");
        }
        if (req == null) {
            return Result.fail(400, "usage request is required");
        }
        Long resolvedUserId = resolveInternalUsageUserId(req);
        if (resolvedUserId == null) {
            return Result.fail(400, "userId or userUuid is required");
        }

        int inputTokens = req.getInputTokens() != null ? req.getInputTokens() : 0;
        int cachedInputTokens = req.getCachedInputTokens() != null ? req.getCachedInputTokens() : 0;
        int outputTokens = req.getOutputTokens() != null ? req.getOutputTokens() : 0;
        int latencyMs = req.getLatencyMs() != null ? req.getLatencyMs() : 0;
        String model = req.getModel() != null && !req.getModel().isBlank() ? req.getModel() : "unknown";
        String sceneType = req.getSceneType() != null && !req.getSceneType().isBlank() ? req.getSceneType() : "autocode";
        String requestIp = req.getRequestIp() != null && !req.getRequestIp().isBlank()
                ? req.getRequestIp()
                : ClientIpUtil.getClientIp(servletRequest);

        if ("error".equalsIgnoreCase(req.getStatus()) || "failed".equalsIgnoreCase(req.getStatus())) {
            usageTrackingService.trackApiUsage(
                    resolvedUserId, model, inputTokens, cachedInputTokens, outputTokens,
                    latencyMs, "error", req.getErrorMsg(), sceneType,
                    requestIp, req.getProvider(), req.getChannelId());
            usageTrackingService.trackUserPreference(
                    resolvedUserId, model, sceneType, false, latencyMs, 0L);
        } else {
            try {
                usageTrackingService.trackFull(
                        resolvedUserId, model, inputTokens, cachedInputTokens, outputTokens,
                        latencyMs, sceneType, req.getAgentId(),
                        requestIp, req.getProvider(), req.getChannelId());
            } catch (BillingException e) {
                usageTrackingService.trackApiUsage(
                        resolvedUserId, model, inputTokens, cachedInputTokens, outputTokens,
                        latencyMs, "billing_failed", e.getMessage(), sceneType,
                        requestIp, req.getProvider(), req.getChannelId());
                usageTrackingService.trackUserPreference(
                        resolvedUserId, model, sceneType, false, latencyMs, 0L);
                return Result.fail(402, e.getMessage());
            }
        }
        return Result.ok("tracked");
    }

    private Long resolveInternalUsageUserId(InternalUsageRequest req) {
        if (req.getUserId() != null) {
            return req.getUserId();
        }
        String uuid = req.getUserUuid();
        if (uuid == null || uuid.isBlank()) {
            return null;
        }
        SysUser user = sysUserMapper.selectOne(
                new QueryWrapper<SysUser>().eq("uuid", uuid.trim()).eq("deleted", 0).last("LIMIT 1"));
        return user != null ? user.getId() : null;
    }

    @PostMapping("/channels")
    public Result<ModelChannel> createChannel(
            @RequestAttribute String userRole,
            @RequestBody ChannelRequest req) {
        requireAdmin(userRole);
        ModelChannel channel = new ModelChannel();
        channel.setUuid(UUID.randomUUID().toString());
        channel.setName(req.getName());
        channel.setProvider(req.getProvider());
        channel.setApiKey(req.getApiKey());
        channel.setBaseUrl(req.getBaseUrl());
        channel.setModels(req.getModelsAsString());
        channel.setTags(req.getTagsAsString());
        channel.setChannelType(req.getChannelType() != null ? req.getChannelType() : "chat");
        channel.setStatus(req.getStatus() != null ? req.getStatus() : "active");
        channel.setPriority(req.getPriority() != null ? req.getPriority() : 1);
        channel.setRateLimit(req.getRateLimit() != null ? req.getRateLimit() : 60);
        if (req.getTtsVoices() != null) channel.setTtsVoices(req.getTtsVoices());
        if (req.getTranslateLangs() != null) channel.setTranslateLangs(req.getTranslateLangs());
        return Result.ok(adminService.saveChannel(channel));
    }

    @PutMapping("/channels/{uuid}")
    public Result<ModelChannel> updateChannel(
            @RequestAttribute String userRole,
            @PathVariable String uuid,
            @RequestBody ChannelRequest req) {
        requireAdmin(userRole);
        // 找到已有渠道
        ModelChannel channel = adminService.listChannels().stream()
                .filter(c -> uuid.equals(c.getUuid()) || uuid.equals(String.valueOf(c.getId())))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("渠道不存在"));
        if (req.getName() != null) channel.setName(req.getName());
        if (req.getProvider() != null) channel.setProvider(req.getProvider());
        if (req.getApiKey() != null) channel.setApiKey(req.getApiKey());
        if (req.getBaseUrl() != null) channel.setBaseUrl(req.getBaseUrl());
        if (req.getModels() != null) channel.setModels(req.getModelsAsString());
        if (req.getTags() != null) channel.setTags(req.getTagsAsString());
        if (req.getChannelType() != null) channel.setChannelType(req.getChannelType());
        if (req.getStatus() != null) channel.setStatus(req.getStatus());
        if (req.getPriority() != null) channel.setPriority(req.getPriority());
        if (req.getRateLimit() != null) channel.setRateLimit(req.getRateLimit());
        if (req.getTtsVoices() != null) channel.setTtsVoices(req.getTtsVoices());
        if (req.getTranslateLangs() != null) channel.setTranslateLangs(req.getTranslateLangs());
        ModelChannel saved = adminService.saveChannel(channel);
        // 渠道限流值修改后，清除内存中的令牌桶缓存，确保新值立即生效
        aiService.evictRateLimiter(channel.getId());
        return Result.ok(saved);
    }

    @DeleteMapping("/channels/{uuid}")
    public Result<String> deleteChannel(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        adminService.deleteChannel(uuid);
        return Result.ok("删除成功");
    }

    /** 从渠道 API 获取可用模型列表（调用 /models 接口） */
    @GetMapping("/channels/{uuid}/models")
    public Result<List<String>> fetchChannelModels(
            @RequestAttribute String userRole,
            @PathVariable String uuid) {
        requireAdmin(userRole);
        return Result.ok(adminService.fetchModelsFromChannel(uuid));
    }

    /** 真实连接测试（发送一条最小请求验证 API Key 可用） */
    @PostMapping("/channels/{uuid}/test")
    public Result<Map<String, Object>> testChannel(
            @RequestAttribute String userRole,
            @PathVariable String uuid) {
        requireAdmin(userRole);
        return Result.ok(adminService.testChannel(uuid));
    }

    /** 更新渠道的模型列表（从获取结果中选择添加/移除） */
    @PutMapping("/channels/{uuid}/models")
    public Result<ModelChannel> updateChannelModels(
            @RequestAttribute String userRole,
            @PathVariable String uuid,
            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        @SuppressWarnings("unchecked")
        List<String> models = (List<String>) body.get("models");
        ModelChannel channel = adminService.listChannels().stream()
                .filter(c -> uuid.equals(c.getUuid()) || uuid.equals(String.valueOf(c.getId())))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("渠道不存在"));
        channel.setModels(String.join(",", models));
        return Result.ok(adminService.saveChannel(channel));
    }

    // ====== 模型管理 ======

    /** 模型请求 DTO（capabilities 字段接收数组或字符串均可） */
    @Data
    public static class ModelRequest {
        private String modelId;
        private String name;
        private String provider;
        private String description;
        private Integer contextLength;
        private Object inputPrice;
        private Object cachedInputPrice;
        private Object outputPrice;
        private Object capabilities;  // 接收 List<String> 或 String
        private Boolean enabled;

        public String getCapabilitiesAsString() {
            if (capabilities == null) return "text";
            if (capabilities instanceof List<?> list) {
                return String.join(",", list.stream().map(Object::toString).toList());
            }
            String s = capabilities.toString().trim();
            if (s.startsWith("[")) {
                s = s.replaceAll("[\\[\\]\"]", "").trim();
            }
            return s;
        }

        public BigDecimal getInputPriceAsBigDecimal() {
            if (inputPrice == null) return BigDecimal.ZERO;
            return new BigDecimal(inputPrice.toString());
        }

        public BigDecimal getCachedInputPriceAsBigDecimal() {
            if (cachedInputPrice == null) return null;
            return new BigDecimal(cachedInputPrice.toString());
        }

        public BigDecimal getOutputPriceAsBigDecimal() {
            if (outputPrice == null) return BigDecimal.ZERO;
            return new BigDecimal(outputPrice.toString());
        }
    }

    @GetMapping("/models")
    public Result<List<ModelConfig>> listModels(@RequestAttribute(required = false) String userRole) {
        return Result.ok(adminService.listModels());
    }

    @PostMapping("/models")
    public Result<ModelConfig> createModel(
            @RequestAttribute String userRole,
            @RequestBody ModelRequest req) {
        requireAdmin(userRole);
        ModelConfig model = new ModelConfig();
        model.setModelId(req.getModelId() != null ? req.getModelId() : req.getName());
        model.setName(req.getName());
        model.setProvider(req.getProvider());
        model.setDescription(req.getDescription());
        model.setContextLength(req.getContextLength() != null ? req.getContextLength() : 128000);
        model.setInputPrice(req.getInputPriceAsBigDecimal());
        model.setCachedInputPrice(req.getCachedInputPriceAsBigDecimal());
        model.setOutputPrice(req.getOutputPriceAsBigDecimal());
        model.setCapabilities(req.getCapabilitiesAsString());
        model.setEnabled(req.getEnabled() != null ? req.getEnabled() : true);
        return Result.ok(adminService.saveModel(model));
    }

    @PutMapping(value = "/models", params = "modelId")
    public Result<ModelConfig> updateModelByQuery(
            @RequestAttribute String userRole,
            @RequestParam String modelId,
            @RequestBody ModelRequest req) {
        requireAdmin(userRole);
        ModelConfig model = adminService.listModels().stream()
                .filter(m -> modelId.equals(m.getModelId()) || modelId.equals(String.valueOf(m.getId())))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("模型不存在"));
        if (req.getName() != null) model.setName(req.getName());
        if (req.getProvider() != null) model.setProvider(req.getProvider());
        if (req.getDescription() != null) model.setDescription(req.getDescription());
        if (req.getContextLength() != null) model.setContextLength(req.getContextLength());
        if (req.getInputPrice() != null) model.setInputPrice(req.getInputPriceAsBigDecimal());
        if (req.getCachedInputPrice() != null) model.setCachedInputPrice(req.getCachedInputPriceAsBigDecimal());
        if (req.getOutputPrice() != null) model.setOutputPrice(req.getOutputPriceAsBigDecimal());
        if (req.getCapabilities() != null) model.setCapabilities(req.getCapabilitiesAsString());
        if (req.getEnabled() != null) model.setEnabled(req.getEnabled());
        return Result.ok(adminService.saveModel(model));
    }

    @DeleteMapping(value = "/models", params = "modelId")
    public Result<String> deleteModelByQuery(@RequestAttribute String userRole, @RequestParam String modelId) {
        requireAdmin(userRole);
        adminService.deleteModelConfig(modelId);
        return Result.ok("删除成功");
    }

    @PutMapping("/models/{modelId}")
    public Result<ModelConfig> updateModel(
            @RequestAttribute String userRole,
            @PathVariable String modelId,
            @RequestBody ModelRequest req) {
        requireAdmin(userRole);
        // 找到已有模型
        ModelConfig model = adminService.listModels().stream()
                .filter(m -> modelId.equals(m.getModelId()) || modelId.equals(String.valueOf(m.getId())))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("模型不存在"));
        if (req.getName() != null) model.setName(req.getName());
        if (req.getProvider() != null) model.setProvider(req.getProvider());
        if (req.getDescription() != null) model.setDescription(req.getDescription());
        if (req.getContextLength() != null) model.setContextLength(req.getContextLength());
        if (req.getInputPrice() != null) model.setInputPrice(req.getInputPriceAsBigDecimal());
        if (req.getCachedInputPrice() != null) model.setCachedInputPrice(req.getCachedInputPriceAsBigDecimal());
        if (req.getOutputPrice() != null) model.setOutputPrice(req.getOutputPriceAsBigDecimal());
        if (req.getCapabilities() != null) model.setCapabilities(req.getCapabilitiesAsString());
        if (req.getEnabled() != null) model.setEnabled(req.getEnabled());
        return Result.ok(adminService.saveModel(model));
    }

    @DeleteMapping("/models/{modelId}")
    public Result<String> deleteModel(@RequestAttribute String userRole, @PathVariable String modelId) {
        requireAdmin(userRole);
        adminService.deleteModel(modelId);
        return Result.ok("删除成功");
    }

    // ====== 订阅管理 ======

    @GetMapping("/subscriptions")
    public Result<Result.PageResult<Object>> listSubscriptions(
            @RequestAttribute String userRole,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        requireAdmin(userRole);
        return Result.ok(adminService.listSubscriptions(page, size));
    }

    @PostMapping("/subscriptions")
    public Result<String> createSubscription(
            @RequestAttribute String userRole,
            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        adminService.createSubscriptionFull(
                Long.valueOf(body.get("userId").toString()),
                (String) body.get("plan"),
                (String) body.get("planName"),
                body.get("price") != null ? new java.math.BigDecimal(body.get("price").toString()) : null,
                body.get("costLimit") != null ? new java.math.BigDecimal(body.get("costLimit").toString()) : null,
                body.get("tokensLimit") != null ? Long.valueOf(body.get("tokensLimit").toString()) : null,
                (String) body.get("modelLimit"),
                (String) body.get("startDate"),
                (String) body.get("endDate")
        );
        return Result.ok("订阅创建成功");
    }

    @PutMapping("/subscriptions/{uuid}")
    public Result<String> updateSubscription(
            @RequestAttribute String userRole,
            @PathVariable String uuid,
            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        adminService.updateSubscriptionFull(
                uuid,
                (String) body.get("planName"),
                body.get("price") != null ? new java.math.BigDecimal(body.get("price").toString()) : null,
                body.get("costLimit") != null ? new java.math.BigDecimal(body.get("costLimit").toString()) : null,
                body.get("tokensLimit") != null ? Long.valueOf(body.get("tokensLimit").toString()) : null,
                (String) body.get("modelLimit"),
                (String) body.get("status"),
                (String) body.get("endDate")
        );
        return Result.ok("订阅更新成功");
    }

    @DeleteMapping("/subscriptions/{uuid}")
    public Result<String> cancelSubscription(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        adminService.cancelSubscription(uuid);
        return Result.ok("已取消订阅");
    }

    // ====== 日志管理 ======

    @GetMapping("/logs")
    public Result<Result.PageResult<com.aiplatform.backend.entity.ApiLog>> listLogs(
            @RequestAttribute String userRole,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String model,
            @RequestParam(required = false) String sceneType) {
        requireAdmin(userRole);
        return Result.ok(adminService.listLogs(page, size, model, sceneType));
    }

    // ====== 套餐管理 ======

    @GetMapping("/plans")
    public Result<List<SubscriptionPlan>> listPlans(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(adminService.listPlans());
    }

    @PostMapping("/plans")
    public Result<SubscriptionPlan> createPlan(@RequestAttribute String userRole, @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(adminService.savePlan(null, body));
    }

    @PutMapping("/plans/{uuid}")
    public Result<SubscriptionPlan> updatePlan(@RequestAttribute String userRole, @PathVariable String uuid, @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(adminService.savePlan(uuid, body));
    }

    @DeleteMapping("/plans/{uuid}")
    public Result<String> deletePlan(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        adminService.deletePlan(uuid);
        return Result.ok("删除成功");
    }

    /** 同步所有订阅记录的 modelLimit（管理员专用） */
    @PostMapping("/subscriptions/sync-model-limits")
    public Result<String> syncSubscriptionModelLimits(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        int updated = adminService.syncSubscriptionModelLimits();
        return Result.ok("同步完成，共更新 " + updated + " 条订阅记录");
    }
}
