package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.AuthDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class AdminService {

    private final SysUserMapper userMapper;
    private final ModelChannelMapper channelMapper;
    private final ModelConfigMapper modelConfigMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final ApiLogMapper apiLogMapper;
    private final BCryptPasswordEncoder passwordEncoder;
    private final ObjectMapper objectMapper;
    private final SubscriptionPlanMapper planMapper;
    private final SysRoleMapper sysRoleMapper;
    private final SysUserRoleMapper sysUserRoleMapper;
    private static final DateTimeFormatter FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;


    public Result.PageResult<AuthDTO.UserVO> listUsers(int page, int size, String keyword, String role, String status) {
        QueryWrapper<SysUser> qw = new QueryWrapper<SysUser>().eq("deleted", 0);
        if (keyword != null && !keyword.isEmpty()) {
            qw.and(w -> w.like("username", keyword).or().like("email", keyword));
        }
        if (role != null && !role.isEmpty()) qw.eq("role", role);
        if (status != null && !status.isEmpty()) qw.eq("status", status);
        qw.orderByDesc("created_at");

        Page<SysUser> pg = userMapper.selectPage(new Page<>(page, size), qw);
        List<AuthDTO.UserVO> list = pg.getRecords().stream().map(this::toUserVO).collect(Collectors.toList());
        return new Result.PageResult<>(list, pg.getTotal(), page, size);
    }

    public AuthDTO.UserVO createUser(String username, String email, String password,
            String role, String plan, BigDecimal costLimit, Long tokensLimit, String status) {
        assertUserUnique(username, email, null);
        SysUser user = new SysUser();
        user.setUuid(UUID.randomUUID().toString());
        user.setUsername(username);
        user.setEmail(email);
        String pwd = (password != null && !password.isBlank()) ? password : "Admin@123456";
        user.setPassword(passwordEncoder.encode(pwd));
        user.setRole(role != null ? role : "user");
        user.setPlan(plan != null ? plan : "free");
        user.setStatus(status != null ? status : "active");
        user.setEmailVerified(true);
        user.setTokensUsed(0L);
        user.setTokensLimit(tokensLimit != null ? tokensLimit : 50000L);
        user.setCostUsed(BigDecimal.ZERO);
        user.setCostLimit(costLimit != null ? costLimit : BigDecimal.ZERO);
        userMapper.insert(user);
        return toUserVO(user);
    }

    public void resetUserPassword(String uuid, String newPassword) {
        SysUser user = findUserByUuidOrId(uuid);
        if (user == null) throw new RuntimeException("用户不存在");
        if (newPassword == null || newPassword.length() < 8) throw new RuntimeException("密码至少 8 位");
        user.setPassword(passwordEncoder.encode(newPassword));
        int updated = userMapper.updateById(user);
        if (updated <= 0) throw new RuntimeException("密码更新失败");
    }

    public AuthDTO.UserVO updateUser(String uuid, String username, String email, String role,
            String plan, BigDecimal costLimit, Long tokensLimit, String status) {
        SysUser user = findUserByUuidOrId(uuid);
        if (user == null) throw new RuntimeException("用户不存在");
        assertUserUnique(username, email, user.getId());
        if (username != null) user.setUsername(username);
        if (email != null) user.setEmail(email);
        if (role != null) user.setRole(role);
        if (plan != null) user.setPlan(plan);
        if (costLimit != null) user.setCostLimit(costLimit);
        if (tokensLimit != null) user.setTokensLimit(tokensLimit);
        if (status != null) user.setStatus(status);
        int updated = userMapper.updateById(user);
        if (updated <= 0) throw new RuntimeException("用户更新失败");
        SysUser latest = userMapper.selectById(user.getId());
        return toUserVO(latest != null ? latest : user);
    }

    public void deleteUser(String uuid) {
        SysUser user = findUserByUuidOrId(uuid);
        if (user == null) throw new RuntimeException("用户不存在");
        int updated = userMapper.update(null,
                new com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper<SysUser>()
                        .set("deleted", 1)
                        .eq("id", user.getId())
                        .eq("deleted", 0));
        if (updated <= 0) throw new RuntimeException("用户删除失败");
    }

    private void assertUserUnique(String username, String email, Long excludeUserId) {
        if (username != null && !username.isBlank()) {
            QueryWrapper<SysUser> query = new QueryWrapper<SysUser>()
                    .eq("username", username)
                    .eq("deleted", 0);
            if (excludeUserId != null) {
                query.ne("id", excludeUserId);
            }
            if (userMapper.selectOne(query.last("LIMIT 1")) != null) {
                throw new RuntimeException("用户名已存在");
            }
        }
        if (email != null && !email.isBlank()) {
            QueryWrapper<SysUser> query = new QueryWrapper<SysUser>()
                    .eq("email", email)
                    .eq("deleted", 0);
            if (excludeUserId != null) {
                query.ne("id", excludeUserId);
            }
            if (userMapper.selectOne(query.last("LIMIT 1")) != null) {
                throw new RuntimeException("邮箱已存在");
            }
        }
    }

    private SysUser findUserByUuidOrId(String uuidOrId) {
        if (uuidOrId == null || uuidOrId.isBlank()) return null;
        SysUser user = userMapper.selectOne(new QueryWrapper<SysUser>().eq("uuid", uuidOrId).eq("deleted", 0));
        if (user != null) return user;
        try {
            Long id = Long.valueOf(uuidOrId);
            return userMapper.selectOne(new QueryWrapper<SysUser>().eq("id", id).eq("deleted", 0));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    public List<ModelChannel> listChannels() {
        return channelMapper.selectList(new QueryWrapper<ModelChannel>().orderByAsc("priority"));
    }

    public ModelChannel saveChannel(ModelChannel channel) {
        if (channel.getId() == null) {
            channel.setUuid(UUID.randomUUID().toString());
            channelMapper.insert(channel);
        } else {
            channelMapper.updateById(channel);
        }
        return channel;
    }

    public void deleteChannel(String uuid) {
        ModelChannel ch = findChannelByUuidOrId(uuid);
        if (ch == null) throw new RuntimeException("渠道不存在");
        channelMapper.update(null,
                new com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper<ModelChannel>()
                        .set("deleted", 1)
                        .eq("id", ch.getId()));
    }

    /** Find channel by uuid or numeric id. */
    private ModelChannel findChannelByUuidOrId(String uuidOrId) {
        ModelChannel ch = channelMapper.selectOne(
                new QueryWrapper<ModelChannel>().eq("uuid", uuidOrId).eq("deleted", 0));
        if (ch != null) return ch;
        try {
            long numId = Long.parseLong(uuidOrId);
            ch = channelMapper.selectOne(
                    new QueryWrapper<ModelChannel>().eq("id", numId).eq("deleted", 0));
        } catch (NumberFormatException ignored) {}
        return ch;
    }

    /** 从渠道 API 获取可用模型列表（调用 GET /models 接口） */
    public List<String> fetchModelsFromChannel(String uuid) {
        ModelChannel ch = findChannelByUuidOrId(uuid);
        if (ch == null) throw new RuntimeException("渠道不存在");
        if (ch.getApiKey() == null || ch.getApiKey().isBlank())
            throw new RuntimeException("渠道未配置 API Key");

        String baseUrl = normalizeBaseUrl(ch.getBaseUrl());
        String url = baseUrl.endsWith("/") ? baseUrl + "models" : baseUrl + "/models";

        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(15))
                    .header("Authorization", "Bearer " + ch.getApiKey())
                    .GET().build();

            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                throw new RuntimeException("API 返回错误 " + resp.statusCode() + ": " + resp.body().substring(0, Math.min(200, resp.body().length())));
            }

            JsonNode root = objectMapper.readTree(resp.body());
            JsonNode data = root.path("data");
            if (data.isMissingNode()) data = root; // 部分 API 直接返回数组

            List<String> models = new ArrayList<>();
            if (data.isArray()) {
                for (JsonNode item : data) {
                    String id = item.path("id").asText(null);
                    if (id != null && !id.isBlank()) models.add(id);
                }
            }
            // 按名称排序
            models.sort(String::compareTo);
            return models;
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            log.error("获取渠道模型列表失败: {}", e.getMessage());
            throw new RuntimeException("获取模型列表失败: " + e.getMessage());
        }
    }

    /** 真实连接测试：发送最小请求验证 API Key 可用性 */
    public Map<String, Object> testChannel(String uuid) {
        ModelChannel ch = findChannelByUuidOrId(uuid);
        if (ch == null) throw new RuntimeException("渠道不存在");

        String baseUrl = normalizeBaseUrl(ch.getBaseUrl());
        String url = baseUrl.endsWith("/") ? baseUrl + "models" : baseUrl + "/models";

        long start = System.currentTimeMillis();
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .timeout(Duration.ofSeconds(10))
                    .header("Authorization", "Bearer " + ch.getApiKey())
                    .GET().build();

            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            int latency = (int) (System.currentTimeMillis() - start);

            boolean ok = resp.statusCode() == 200;
            channelMapper.updateById(ch);

            Map<String, Object> result = new HashMap<>();
            result.put("ok", ok);
            result.put("latency", latency);
            result.put("status", resp.statusCode());
            if (!ok) result.put("message", "HTTP " + resp.statusCode());
            return result;
        } catch (Exception e) {
            int latency = (int) (System.currentTimeMillis() - start);
            ch.setStatus("error");
            channelMapper.updateById(ch);
            return Map.of("ok", false, "latency", latency, "message", e.getMessage());
        }
    }


    public List<ModelConfig> listModels() {
        return modelConfigMapper.selectList(new QueryWrapper<ModelConfig>().eq("deleted", 0).orderByAsc("provider"));
    }

    public ModelConfig saveModel(ModelConfig model) {
        if (model.getId() == null) {
            modelConfigMapper.insert(model);
        } else {
            modelConfigMapper.updateById(model);
        }
        return model;
    }

    public void deleteModelConfig(String modelId) {
        Long numericId = parseLongOrNull(modelId);
        UpdateWrapper<ModelConfig> wrapper = new UpdateWrapper<ModelConfig>()
                .eq("deleted", 0)
                .set("deleted", 1);
        if (numericId != null) {
            wrapper.eq("id", numericId);
        } else {
            wrapper.eq("model_id", modelId);
        }
        int updated = modelConfigMapper.update(null, wrapper);
        if (updated <= 0) throw new RuntimeException("模型不存在或已删除");
    }

    private Long parseLongOrNull(String value) {
        if (value == null || value.isBlank()) return null;
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public void deleteModel(String modelId) {
        deleteModelConfig(modelId);
    }

    public Result.PageResult<Object> listSubscriptions(int page, int size) {
        Page<Subscription> pg = subscriptionMapper.selectPage(
                new Page<>(page, size),
                new QueryWrapper<Subscription>().eq("deleted", 0).orderByDesc("created_at"));
        List<Object> list = pg.getRecords().stream().map(s -> {
            SysUser user = userMapper.selectOne(new QueryWrapper<SysUser>().eq("id", s.getUserId()));
            return (Object) new java.util.HashMap<String, Object>() {{
                put("id", s.getUuid());
                put("userId", s.getUserId());
                put("userName", user != null ? user.getUsername() : "");
                put("plan", s.getPlan());
                put("planName", s.getPlanName() != null ? s.getPlanName() : s.getPlan());
                put("status", s.getStatus());
                put("price", s.getPrice());
                put("costLimit", s.getCostLimit() != null ? s.getCostLimit() : BigDecimal.ZERO);
                put("costUsed", s.getCostUsed() != null ? s.getCostUsed() : BigDecimal.ZERO);
                put("tokensLimit", s.getTokensLimit() != null ? s.getTokensLimit() : 50000L);
                put("modelLimit", s.getModelLimit() != null ? s.getModelLimit() : "");
                put("startDate", s.getStartDate() != null ? s.getStartDate().toString() : "");
                put("endDate", s.getEndDate() != null ? s.getEndDate().toString() : "");
            }};
        }).collect(Collectors.toList());
        return new Result.PageResult<>(list, pg.getTotal(), page, size);
    }

    public void createSubscription(Long userId, String plan, String endDate) {
        Subscription sub = new Subscription();
        sub.setUuid(UUID.randomUUID().toString());
        sub.setUserId(userId);
        sub.setPlan(plan);
        sub.setStatus("active");
        sub.setPrice(planPrice(plan));
        sub.setStartDate(LocalDate.now());
        sub.setEndDate(LocalDate.parse(endDate));
        sub.setTokensLimit(planTokenLimit(plan));
        subscriptionMapper.insert(sub);

        SysUser user = userMapper.selectById(userId);
        if (user != null) {
            user.setPlan(plan);
            user.setTokensLimit(planTokenLimit(plan));
            userMapper.updateById(user);

            SubscriptionPlan planEntity = planMapper.selectOne(
                    new QueryWrapper<SubscriptionPlan>().eq("code", plan).eq("deleted", 0));
            upgradeUserRole(userId, planEntity != null ? planEntity.getRoleId() : null, plan);
        }
    }

    public void createSubscriptionFull(Long userId, String plan, String planName,
                                       BigDecimal price, BigDecimal costLimit, Long tokensLimit, String modelLimit,
                                       String startDate, String endDate) {
        Subscription sub = new Subscription();
        sub.setUuid(UUID.randomUUID().toString());
        sub.setUserId(userId);
        sub.setPlan(plan != null ? plan : "custom");
        sub.setPlanName(planName);
        sub.setStatus("active");
        sub.setPrice(price != null ? price : BigDecimal.ZERO);
        sub.setCostLimit(costLimit != null ? costLimit : (price != null ? price : BigDecimal.ZERO));
        sub.setCostUsed(BigDecimal.ZERO);
        sub.setTokensLimit(tokensLimit != null ? tokensLimit : planTokenLimit(plan));
        sub.setModelLimit(modelLimit);
        sub.setStartDate(startDate != null ? LocalDate.parse(startDate) : LocalDate.now());
        sub.setEndDate(endDate != null ? LocalDate.parse(endDate) : LocalDate.now().plusMonths(1));
        subscriptionMapper.insert(sub);

        SysUser user = userMapper.selectById(userId);
        if (user != null) {
            user.setPlan(sub.getPlan());
            user.setTokensLimit(sub.getTokensLimit());
            user.setCostLimit(sub.getCostLimit());
            user.setCostUsed(BigDecimal.ZERO);
            userMapper.updateById(user);

            SubscriptionPlan planEntity = planMapper.selectOne(
                    new QueryWrapper<SubscriptionPlan>().eq("code", plan).eq("deleted", 0));
            upgradeUserRole(userId, planEntity != null ? planEntity.getRoleId() : null, plan);
        }
    }

    public void updateSubscriptionFull(String uuid, String planName, BigDecimal price, BigDecimal costLimit,
                                       Long tokensLimit, String modelLimit,
                                       String status, String endDate) {
        Subscription sub = subscriptionMapper.selectOne(
                new QueryWrapper<Subscription>().eq("uuid", uuid).eq("deleted", 0));
        if (sub == null) throw new RuntimeException("订阅不存在");
        if (planName != null) sub.setPlanName(planName);
        if (price != null) {
            sub.setPrice(price);
        }
        if (costLimit != null) {
            sub.setCostLimit(costLimit);
            SysUser user = userMapper.selectById(sub.getUserId());
            if (user != null) { user.setCostLimit(costLimit); userMapper.updateById(user); }
        }
        if (tokensLimit != null) {
            sub.setTokensLimit(tokensLimit);
            SysUser user = userMapper.selectById(sub.getUserId());
            if (user != null) { user.setTokensLimit(tokensLimit); userMapper.updateById(user); }
        }
        if (modelLimit != null) sub.setModelLimit(modelLimit);
        if (status != null) sub.setStatus(status);
        if (endDate != null) sub.setEndDate(LocalDate.parse(endDate));
        subscriptionMapper.updateById(sub);
    }

    public void cancelSubscription(String uuid) {
        Subscription sub = subscriptionMapper.selectOne(new QueryWrapper<Subscription>().eq("uuid", uuid).eq("deleted", 0));
        if (sub == null) throw new RuntimeException("订阅不存在");
        sub.setStatus("cancelled");
        subscriptionMapper.updateById(sub);
    }


    public Result.PageResult<ApiLog> listLogs(int page, int size, String model, String sceneType) {
        QueryWrapper<ApiLog> qw = new QueryWrapper<>();
        if (model != null && !model.isEmpty()) qw.eq("model", model);
        if (sceneType != null && !sceneType.isEmpty()) qw.eq("scene_type", sceneType);
        qw.orderByDesc("created_at");
        Page<ApiLog> pg = apiLogMapper.selectPage(new Page<>(page, size), qw);
        enrichLogsWithChannelName(pg.getRecords());
        return new Result.PageResult<>(pg.getRecords(), pg.getTotal(), page, size);
    }

    private void enrichLogsWithChannelName(List<ApiLog> logs) {
        if (logs == null || logs.isEmpty()) return;
        Set<String> channelRefs = logs.stream()
                .map(ApiLog::getChannelId)
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .collect(Collectors.toSet());
        if (channelRefs.isEmpty()) return;

        Map<String, String> channelNameByRef = new HashMap<>();
        channelMapper.selectList(new QueryWrapper<ModelChannel>()).forEach(ch -> {
            if (ch.getName() == null || ch.getName().isBlank()) return;
            if (ch.getId() != null) channelNameByRef.put(String.valueOf(ch.getId()), ch.getName());
            if (ch.getUuid() != null && !ch.getUuid().isBlank()) channelNameByRef.put(ch.getUuid(), ch.getName());
        });
        logs.forEach(log -> {
            String channelId = log.getChannelId();
            if (channelId != null) {
                log.setChannelName(channelNameByRef.get(channelId.trim()));
            }
        });
    }


    public java.util.Map<String, Object> getStats() {
        long totalUsers = userMapper.selectCount(new QueryWrapper<SysUser>().eq("deleted", 0));
        long activeUsers = userMapper.selectCount(new QueryWrapper<SysUser>().eq("deleted", 0).eq("status", "active"));
        long activeSubs = subscriptionMapper.selectCount(new QueryWrapper<Subscription>().eq("deleted", 0).eq("status", "active"));
        long totalLogs = apiLogMapper.selectCount(null);
        Long totalTokens = userMapper.selectList(new QueryWrapper<SysUser>().eq("deleted", 0))
                .stream().mapToLong(u -> u.getTokensUsed() != null ? u.getTokensUsed() : 0).sum();
        BigDecimal totalCostUsed = userMapper.selectList(new QueryWrapper<SysUser>().eq("deleted", 0))
                .stream()
                .map(u -> u.getCostUsed() != null ? u.getCostUsed() : BigDecimal.ZERO)
                .reduce(BigDecimal.ZERO, BigDecimal::add);

        return new java.util.HashMap<>() {{
            put("totalUsers", totalUsers);
            put("activeUsers", activeUsers);
            put("activeSubscriptions", activeSubs);
            put("totalRequests", totalLogs);
            put("totalTokens", totalTokens);
            put("totalCostUsed", totalCostUsed);
        }};
    }

    // ============ 套餐管理 ============

    public List<SubscriptionPlan> listPlans() {
        List<SubscriptionPlan> plans = planMapper.selectList(new QueryWrapper<SubscriptionPlan>().eq("deleted", 0).orderByAsc("sort_order"));
        plans.forEach(this::enrichPlanWithRoleName);
        return plans;
    }

    public List<SubscriptionPlan> listEnabledPlans() {
        List<SubscriptionPlan> plans = planMapper.selectList(new QueryWrapper<SubscriptionPlan>().eq("deleted", 0).eq("enabled", true).orderByAsc("sort_order"));
        plans.forEach(this::enrichPlanWithRoleName);
        return plans;
    }

    private void enrichPlanWithRoleName(SubscriptionPlan plan) {
        if (plan.getRoleId() != null) {
            SysRole role = sysRoleMapper.selectOne(new QueryWrapper<SysRole>().eq("id", plan.getRoleId()).eq("deleted", 0));
            if (role != null) plan.setRoleName(role.getRoleName());
        }
    }

    public SubscriptionPlan savePlan(String uuid, Map<String, Object> body) {
        SubscriptionPlan plan;
        if (uuid != null) {
            plan = planMapper.selectOne(new QueryWrapper<SubscriptionPlan>().eq("uuid", uuid).eq("deleted", 0));
            if (plan == null) throw new RuntimeException("套餐不存在");
        } else {
            plan = new SubscriptionPlan();
            plan.setUuid(UUID.randomUUID().toString());
        }
        if (body.get("name") != null) plan.setName((String) body.get("name"));
        if (body.get("code") != null) plan.setCode((String) body.get("code"));
        if (body.get("description") != null) plan.setDescription((String) body.get("description"));
        if (body.get("price") != null) plan.setPrice(new BigDecimal(body.get("price").toString()));
        if (body.get("costLimit") != null) plan.setCostLimit(new BigDecimal(body.get("costLimit").toString()));
        if (body.get("tokensLimit") != null) plan.setTokensLimit(Long.valueOf(body.get("tokensLimit").toString()));
        if (body.get("modelLimit") != null) plan.setModelLimit((String) body.get("modelLimit"));
        if (body.get("features") != null) {
            Object f = body.get("features");
            plan.setFeatures(f instanceof String ? (String) f : f.toString());
        }
        if (body.get("sortOrder") != null) plan.setSortOrder(Integer.valueOf(body.get("sortOrder").toString()));
        if (body.get("isPopular") != null) plan.setIsPopular(Boolean.valueOf(body.get("isPopular").toString()));
        if (body.get("enabled") != null) plan.setEnabled(Boolean.valueOf(body.get("enabled").toString()));
        if (body.get("roleId") != null) {
            Long roleId = Long.valueOf(body.get("roleId").toString());
            if (roleId > 0) {
                SysRole role = sysRoleMapper.selectOne(new QueryWrapper<SysRole>().eq("id", roleId).eq("deleted", 0));
                if (role == null) throw new RuntimeException("绑定的角色不存在");
                plan.setRoleId(roleId);
            }
        }

        if (plan.getId() == null) planMapper.insert(plan);
        else planMapper.updateById(plan);
        return plan;
    }

    public void deletePlan(String uuid) {
        SubscriptionPlan plan = planMapper.selectOne(new QueryWrapper<SubscriptionPlan>().eq("uuid", uuid).eq("deleted", 0));
        if (plan == null) throw new RuntimeException("套餐不存在");
        plan.setDeleted(1);
        planMapper.updateById(plan);
    }

    /** Synchronize modelLimit from enabled plans to active subscriptions. */
    public int syncSubscriptionModelLimits() {
        List<SubscriptionPlan> plans = planMapper.selectList(
                new QueryWrapper<SubscriptionPlan>().eq("deleted", 0).eq("enabled", true));
        Map<String, String> planModelLimits = new HashMap<>();
        for (SubscriptionPlan p : plans) {
            planModelLimits.put(p.getCode(), p.getModelLimit());
        }

        List<Subscription> subs = subscriptionMapper.selectList(
                new QueryWrapper<Subscription>().eq("status", "active").eq("deleted", 0));

        int updated = 0;
        for (Subscription sub : subs) {
            String expectedLimit = planModelLimits.get(sub.getPlan());
            if (expectedLimit != null && !expectedLimit.equals(sub.getModelLimit())) {
                sub.setModelLimit(expectedLimit);
                subscriptionMapper.updateById(sub);
                updated++;
            }
        }
        log.info("Subscription modelLimit sync completed, updated {} records", updated);
        return updated;
    }

    public void userSubscribe(Long userId, String planUuid, String paymentMethod) {
        SubscriptionPlan plan = planMapper.selectOne(new QueryWrapper<SubscriptionPlan>()
                .eq("uuid", planUuid)
                .eq("deleted", 0)
                .eq("enabled", true));
        if (plan == null) throw new RuntimeException("套餐不存在或已下架");

        Subscription oldSub = subscriptionMapper.selectOne(new QueryWrapper<Subscription>()
                .eq("user_id", userId)
                .eq("status", "active")
                .eq("deleted", 0));
        if (oldSub != null) {
            oldSub.setStatus("cancelled");
            subscriptionMapper.updateById(oldSub);
        }

        Subscription sub = new Subscription();
        sub.setUuid(UUID.randomUUID().toString());
        sub.setUserId(userId);
        sub.setPlan(plan.getCode());
        sub.setPlanName(plan.getName());
        sub.setStatus("active");
        sub.setPrice(plan.getPrice());
        sub.setCostLimit(plan.getCostLimit() != null ? plan.getCostLimit() : plan.getPrice());
        sub.setCostUsed(BigDecimal.ZERO);
        sub.setTokensLimit(plan.getTokensLimit());
        sub.setModelLimit(plan.getModelLimit());
        sub.setStartDate(LocalDate.now());
        sub.setEndDate(LocalDate.now().plusMonths(1));
        subscriptionMapper.insert(sub);

        SysUser user = userMapper.selectById(userId);
        if (user != null) {
            user.setPlan(plan.getCode());
            user.setTokensLimit(plan.getTokensLimit());
            user.setCostLimit(sub.getCostLimit());
            user.setCostUsed(BigDecimal.ZERO);
            user.setTokensUsed(0L);
            userMapper.updateById(user);
            upgradeUserRole(userId, plan.getRoleId(), plan.getCode());
        }
    }

    private void upgradeUserRole(Long userId, Long planRoleId, String planCode) {
        if (planRoleId == null) {
            SysRole defaultRole = sysRoleMapper.selectOne(
                    new QueryWrapper<SysRole>().eq("role_code", "user").eq("deleted", 0));
            if (defaultRole != null) planRoleId = defaultRole.getId();
            else return;
        }

        SysRole role = sysRoleMapper.selectOne(
                new QueryWrapper<SysRole>().eq("id", planRoleId).eq("deleted", 0));
        if (role == null) {
            log.warn("Plan {} configured role id {} not found; skip role upgrade", planCode, planRoleId);
            return;
        }

        SysUser user = userMapper.selectById(userId);
        if (user != null) {
            user.setRole(role.getRoleCode());
            userMapper.updateById(user);
        }

        sysUserRoleMapper.delete(new QueryWrapper<SysUserRole>().eq("user_id", userId));

        SysUserRole userRole = new SysUserRole();
        userRole.setUserId(userId);
        userRole.setRoleId(role.getId());
        sysUserRoleMapper.insert(userRole);

        log.info("User {} role upgraded to {} (roleCode={}, plan={})",
                userId, role.getRoleName(), role.getRoleCode(), planCode);
    }
    private String normalizeBaseUrl(String url) {
        if (url == null || url.isBlank()) return "https://api.openai.com/v1";
        if (!url.contains("/v1") && !url.contains("/api/")) {
            return url.endsWith("/") ? url + "v1" : url + "/v1";
        }
        return url;
    }

    private AuthDTO.UserVO toUserVO(SysUser user) {
        AuthDTO.UserVO vo = new AuthDTO.UserVO();
        vo.setId(user.getUuid() != null && !user.getUuid().isBlank()
                ? user.getUuid()
                : String.valueOf(user.getId()));
        vo.setName(user.getUsername());
        vo.setEmail(user.getEmail());
        vo.setAvatar(user.getAvatar());
        vo.setRole(user.getRole());
        vo.setPlan(user.getPlan());
        vo.setTokensUsed(user.getTokensUsed());
        vo.setTokensLimit(user.getTokensLimit());
        vo.setCostUsed(user.getCostUsed());
        vo.setCostLimit(user.getCostLimit());
        vo.setStatus(user.getStatus());
        if (user.getCreatedAt() != null) vo.setCreatedAt(user.getCreatedAt().format(FMT));
        return vo;
    }

    private BigDecimal planPrice(String plan) {
        return switch (plan) {
            case "pro" -> BigDecimal.valueOf(99);
            case "enterprise" -> BigDecimal.valueOf(299);
            default -> BigDecimal.ZERO;
        };
    }

    private long planTokenLimit(String plan) {
        return switch (plan) {
            case "pro" -> 500000L;
            case "enterprise" -> 5000000L;
            default -> 50000L;
        };
    }
}
