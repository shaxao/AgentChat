# 用户级模型偏好系统 — 完整设计方案

> 基于现有四维加权路由体系（能力40% + 场景25% + 成本20% + 可用性15%）叠加用户个性化层

---

## 一、架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                         ChatController                                │
│              resolveModelWithRouting(rawModel, ...)                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     ModelRoutingService.selectModel(ctx)              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  五维加权评分                                                  │   │
│  │                                                                │   │
│  │  Layer 1 (40%)      Layer 2 (25%)    Layer 3 (18%)           │   │
│  │  能力匹配 ← model_config.capabilities                          │   │
│  │  场景亲和 ← model_config.strengths/taskTypes                  │   │
│  │  成本效率 ← model_config.inputPrice/outputPrice               │   │
│  │                                                                │   │
│  │  Layer 4 (12%)      Layer 5 (5%)   ← NEW                      │   │
│  │  可用性 ← model_routing_stats (全局)                           │   │
│  │  用户偏好 ← user_model_preference (用户级) ★                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  RouteContext 注入用户偏好:                                          │
│  context.userId → UserPreferenceService.getPreferences(userId)       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 二、数据库设计

### 2.1 新增表：`user_model_preference` — 用户模型偏好

```sql
CREATE TABLE IF NOT EXISTS user_model_preference (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL COMMENT '用户ID → sys_user.id',
    model_id    VARCHAR(100) NOT NULL COMMENT '模型ID → model_config.model_id',
    scene_type  VARCHAR(50)  NOT NULL DEFAULT 'chat' COMMENT '场景: chat/vision/code/image/agent',

    -- 偏好数据
    preference_weight DECIMAL(4,3) DEFAULT 0.000 COMMENT '偏好权重 (-1.0 ~ +1.0)，正数偏好、负数排斥',
    usage_count       INT          DEFAULT 0     COMMENT '该场景下使用该模型的累计次数',
    like_count        INT          DEFAULT 0     COMMENT '用户点赞次数',
    dislike_count     INT          DEFAULT 0     COMMENT '用户点踩次数',
    avg_response_time INT          DEFAULT 0     COMMENT '该用户在该模型上的平均响应时间(ms)',
    last_used_at      DATETIME     COMMENT '最后使用时间',
    source            VARCHAR(20)  DEFAULT 'auto' COMMENT '来源: auto=系统学习, manual=用户手动设定',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_user_model_scene (user_id, model_id, scene_type),
    INDEX idx_user_scene (user_id, scene_type),
    INDEX idx_user_model (user_id, model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型偏好表';
```

### 2.2 新增表：`user_model_feedback` — 用户反馈明细

```sql
CREATE TABLE IF NOT EXISTS user_model_feedback (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户ID',
    conversation_id VARCHAR(100) COMMENT '关联对话ID',
    model_id        VARCHAR(100) NOT NULL COMMENT '模型ID',
    scene_type      VARCHAR(50)  DEFAULT 'chat' COMMENT '场景类型',

    -- 反馈
    rating          TINYINT      COMMENT '评分 1-5 (null=未评分)',
    liked           TINYINT(1)   DEFAULT 0 COMMENT '是否点赞',
    disliked        TINYINT(1)   DEFAULT 0 COMMENT '是否点踩',
    feedback_text   TEXT         COMMENT '文字反馈',

    -- 上下文
    response_time_ms INT         COMMENT '响应耗时(ms)',
    token_usage      INT         COMMENT '消耗token数',
    was_retry        TINYINT(1)  DEFAULT 0 COMMENT '是否重试后的结果',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_model (user_id, model_id),
    INDEX idx_user_conv (user_id, conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型反馈记录表';
```

### 2.3 新增表：`user_model_usage_daily` — 用户模型使用日汇总（异步计算用）

```sql
CREATE TABLE IF NOT EXISTS user_model_usage_daily (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    model_id    VARCHAR(100) NOT NULL,
    scene_type  VARCHAR(50)  NOT NULL DEFAULT 'chat',
    stat_date   DATE         NOT NULL COMMENT '统计日期',

    call_count       INT DEFAULT 0 COMMENT '当天调用次数',
    success_count    INT DEFAULT 0 COMMENT '成功次数',
    total_tokens     BIGINT DEFAULT 0 COMMENT '消耗token数',
    total_cost       DECIMAL(10,6) DEFAULT 0 COMMENT '消耗费用',
    avg_response_time INT DEFAULT 0 COMMENT '平均响应时间(ms)',

    UNIQUE KEY uk_user_model_date (user_id, model_id, scene_type, stat_date),
    INDEX idx_user_date (user_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型使用日汇总表';
```

---

## 三、路由评分算法改造

### 3.1 权重调整

```
现有（四维）:          改造后（五维）:
  能力匹配    40%  →   能力匹配    38%
  场景亲和    25%  →   场景亲和    23%
  成本效率    20%  →   成本效率    18%
  可用性      15%  →   可用性      12%
                      用户偏好      9%  ← NEW
```

用户偏好权重设在 9%，确保：
- 不会覆盖全局规则的决定性优势（如能力匹配）
- 但在能力相近的模型之间，用户偏好能起决定性作用
- 如果用户从未使用过任何模型（冷启动），该维度得 0 分

### 3.2 用户偏好评分算法 `scoreUserPreference(model, context)`

```java
/**
 * 用户偏好评分 (0-10)
 */
private double scoreUserPreference(ModelConfig model, RouteContext context) {
    if (context.getUserId() == null) return 5.0; // 未登录，中等分

    String sceneType = context.getSceneType() != null ? context.getSceneType() : "chat";

    // 1. 查找用户对该模型在对应场景下的偏好
    UserModelPreference pref = userPreferenceService.getPreference(
        Long.parseLong(context.getUserId()), model.getModelId(), sceneType
    );

    if (pref == null) {
        // 冷启动：检查用户是否在其他场景使用过该模型（品牌忠诚度）
        List<UserModelPreference> otherScenePrefs = userPreferenceService.getPreferencesByModel(
            Long.parseLong(context.getUserId()), model.getModelId()
        );
        if (!otherScenePrefs.isEmpty()) {
            // 用户在其他场景用过这个模型，给轻微加分
            return 5.5;
        }
        return 5.0; // 完全没用过，中等分
    }

    double score = 5.0;

    // 2. 手动偏好权重（用户明确设定）
    if ("manual".equals(pref.getSource())) {
        // manual weight ∈ [-1, +1]，直接映射到 [0, 10]
        score += pref.getPreferenceWeight().doubleValue() * 5.0;
    }

    // 3. 自动学习权重
    if ("auto".equals(pref.getSource())) {
        // 点赞加分（每次点赞 +0.5，最多 +2.0）
        int likes = pref.getLikeCount() != null ? pref.getLikeCount() : 0;
        score += Math.min(likes * 0.5, 2.0);

        // 点踩扣分（每次点踩 -1.0，最多 -3.0）
        int dislikes = pref.getDislikeCount() != null ? pref.getDislikeCount() : 0;
        score -= Math.min(dislikes * 1.0, 3.0);

        // 使用频率加分：次数越多越习惯（对数平滑）
        int usage = pref.getUsageCount() != null ? pref.getUsageCount() : 0;
        score += Math.min(Math.log(usage + 1) * 0.3, 2.0);

        // 响应时间趋势（比全局平均快则加分）
        if (pref.getAvgResponseTime() != null && pref.getAvgResponseTime() > 0) {
            ModelRoutingStats globalStats = getModelStats(model.getModelId(), sceneType);
            if (globalStats != null && globalStats.getAvgResponseTime() != null && globalStats.getAvgResponseTime() > 0) {
                double ratio = (double) pref.getAvgResponseTime() / globalStats.getAvgResponseTime();
                // 比全局快 20% 以上加 1.0 分，慢 20% 以上扣 0.5 分
                if (ratio < 0.8) score += 1.0;
                else if (ratio > 1.2) score -= 0.5;
            }
        }
    }

    return Math.max(0, Math.min(score, 10.0));
}
```

### 3.3 RouteContext 改造

```java
@Data
public static class RouteContext {
    private String sceneType;
    private String agentType;
    private String complexity;
    private List<String> requiredCapabilities;
    private String preferredProvider;
    private Integer minContextLength;
    private Double maxCost;
    private String userId;          // ← 已有字段，现启用
    private Map<String, Object> metadata;

    // ★ 新增：用户偏好注入（由 resolveModelWithRouting 设置）
    private Map<String, UserModelPreference> userPreferences;
}
```

### 3.4 ChatController.resolveModelWithRouting() 改造

```java
private String resolveModelWithRouting(String requestedModel, boolean isAgentMode, boolean hasImages) {
    // ... 现有逻辑 ...

    ModelRoutingService.RouteContext ctx = new ModelRoutingService.RouteContext();

    // ★ 注入当前用户ID
    Long currentUserId = getCurrentUserId(); // 从 SecurityContext/Session 获取
    if (currentUserId != null) {
        ctx.setUserId(String.valueOf(currentUserId));
        // 预加载用户偏好（减少后续 DB 查询）
        ctx.setUserPreferences(userPreferenceService.getPreferencesByUser(currentUserId));
    }

    // ... 其余现有逻辑 ...
}
```

---

## 四、偏好学习引擎 — UserPreferenceService

### 4.1 核心服务

```java
@Service
@Slf4j
public class UserPreferenceService {

    @Autowired
    private UserModelPreferenceMapper preferenceMapper;

    @Autowired
    private UserModelFeedbackMapper feedbackMapper;

    @Autowired
    private UserModelUsageDailyMapper usageDailyMapper;

    // 内存缓存：用户偏好权重（高频读取）
    private final Cache<Long, Map<String, Double>> preferenceCache =
        Caffeine.newBuilder()
            .maximumSize(1000)
            .expireAfterWrite(30, TimeUnit.MINUTES)
            .build();

    /**
     * 获取用户在指定场景下对某模型的偏好权重
     */
    public UserModelPreference getPreference(Long userId, String modelId, String sceneType) {
        return preferenceMapper.findByUserModelScene(userId, modelId, sceneType);
    }

    /**
     * 获取用户所有偏好（用于预加载）
     */
    public Map<String, UserModelPreference> getPreferencesByUser(Long userId) {
        List<UserModelPreference> list = preferenceMapper.findByUserId(userId);
        Map<String, UserModelPreference> map = new HashMap<>();
        for (UserModelPreference p : list) {
            map.put(p.getModelId() + ":" + p.getSceneType(), p);
        }
        return map;
    }

    /**
     * 获取用户在某个模型的所有场景偏好（用于冷启动品牌忠诚度）
     */
    public List<UserModelPreference> getPreferencesByModel(Long userId, String modelId) {
        return preferenceMapper.findByUserIdAndModel(userId, modelId);
    }

    // ═══════════════════════════════════════
    // 事件驱动更新（对话完成后调用）
    // ═══════════════════════════════════════

    /**
     * 对话完成时记录使用情况
     * 调用时机：ChatController.recordRoutingResult() 之后
     */
    @Async
    public void recordUsage(ModelUsageEvent event) {
        try {
            // 1. Upsert 偏好记录
            UserModelPreference pref = preferenceMapper.findByUserModelScene(
                event.userId, event.modelId, event.sceneType
            );

            if (pref == null) {
                pref = new UserModelPreference();
                pref.setUserId(event.userId);
                pref.setModelId(event.modelId);
                pref.setSceneType(event.sceneType);
                pref.setPreferenceWeight(BigDecimal.ZERO);
                pref.setSource("auto");
            }

            // 更新累计使用数据
            pref.setUsageCount((pref.getUsageCount() != null ? pref.getUsageCount() : 0) + 1);
            pref.setLastUsedAt(LocalDateTime.now());

            // 更新平均响应时间（增量平均）
            int oldCount = pref.getUsageCount() - 1;
            int oldAvg = pref.getAvgResponseTime() != null ? pref.getAvgResponseTime() : 0;
            if (oldCount > 0) {
                pref.setAvgResponseTime(
                    (int)((oldAvg * oldCount + event.responseTimeMs) / (double)pref.getUsageCount())
                );
            } else {
                pref.setAvgResponseTime(event.responseTimeMs);
            }

            preferenceMapper.insertOrUpdate(pref);

            // 2. 写入日汇总表（供定时任务聚合使用）
            UserModelUsageDaily daily = usageDailyMapper.findOrCreate(
                event.userId, event.modelId, event.sceneType, LocalDate.now()
            );
            daily.setCallCount(daily.getCallCount() + 1);
            if (event.success) daily.setSuccessCount(daily.getSuccessCount() + 1);
            if (event.tokenUsage != null) daily.setTotalTokens(daily.getTotalTokens() + event.tokenUsage);
            if (event.cost != null) daily.setTotalCost(daily.getTotalCost().add(event.cost));
            usageDailyMapper.insertOrUpdate(daily);

            // 3. 清除内存缓存（下次读取时重新加载）
            preferenceCache.invalidate(event.userId);

        } catch (Exception e) {
            log.error("记录用户模型使用失败: userId={}, modelId={}", event.userId, event.modelId, e);
        }
    }

    /**
     * 用户手动反馈（点赞/点踩/评分）
     */
    @Async
    public void recordFeedback(UserModelFeedback feedback) {
        feedbackMapper.insert(feedback);

        // 同步更新偏好表
        UserModelPreference pref = preferenceMapper.findByUserModelScene(
            feedback.getUserId(), feedback.getModelId(), feedback.getSceneType()
        );
        if (pref == null) {
            pref = new UserModelPreference();
            pref.setUserId(feedback.getUserId());
            pref.setModelId(feedback.getModelId());
            pref.setSceneType(feedback.getSceneType());
            pref.setPreferenceWeight(BigDecimal.ZERO);
            pref.setSource("auto");
        }

        if (feedback.getLiked() != null && feedback.getLiked()) {
            pref.setLikeCount((pref.getLikeCount() != null ? pref.getLikeCount() : 0) + 1);
        }
        if (feedback.getDisliked() != null && feedback.getDisliked()) {
            pref.setDislikeCount((pref.getDislikeCount() != null ? pref.getDislikeCount() : 0) + 1);
        }

        // 根据点赞/点踩比例自动调整权重
        int likes = pref.getLikeCount() != null ? pref.getLikeCount() : 0;
        int dislikes = pref.getDislikeCount() != null ? pref.getDislikeCount() : 0;
        int total = likes + dislikes;
        if (total >= 3) {
            double autoWeight = (likes - dislikes) / (double)(total + 2); // 加2平滑防止极端值
            pref.setPreferenceWeight(BigDecimal.valueOf(Math.max(-1.0, Math.min(1.0, autoWeight))));
            pref.setSource("auto"); // 由反馈驱动，仍标记为 auto
        }

        preferenceMapper.insertOrUpdate(pref);
        preferenceCache.invalidate(feedback.getUserId());

        log.info("记录用户反馈: userId={}, modelId={}, liked={}, disliked={}, rating={}",
            feedback.getUserId(), feedback.getModelId(), feedback.getLiked(), feedback.getDisliked(), feedback.getRating());
    }

    /**
     * 用户手动设置模型偏好权重
     */
    public void setManualPreference(Long userId, String modelId, String sceneType, double weight) {
        UserModelPreference pref = preferenceMapper.findByUserModelScene(userId, modelId, sceneType);
        if (pref == null) {
            pref = new UserModelPreference();
            pref.setUserId(userId);
            pref.setModelId(modelId);
            pref.setSceneType(sceneType);
        }
        pref.setPreferenceWeight(BigDecimal.valueOf(Math.max(-1.0, Math.min(1.0, weight))));
        pref.setSource("manual"); // ← 标记为手动，路由评分时更重
        pref.setUpdatedAt(LocalDateTime.now());
        preferenceMapper.insertOrUpdate(pref);
        preferenceCache.invalidate(userId);
    }
}
```

### 4.2 事件模型

```java
@Data
@AllArgsConstructor
@NoArgsConstructor
public class ModelUsageEvent {
    private Long userId;
    private String modelId;
    private String sceneType;
    private boolean success;
    private int responseTimeMs;
    private Long tokenUsage;
    private BigDecimal cost;
}
```

### 4.3 Mapper 扩展

```java
@Mapper
public interface UserModelPreferenceMapper extends BaseMapper<UserModelPreference> {

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId} AND model_id = #{modelId} AND scene_type = #{sceneType}")
    UserModelPreference findByUserModelScene(@Param("userId") Long userId,
                                              @Param("modelId") String modelId,
                                              @Param("sceneType") String sceneType);

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId}")
    List<UserModelPreference> findByUserId(@Param("userId") Long userId);

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId} AND model_id = #{modelId}")
    List<UserModelPreference> findByUserIdAndModel(@Param("userId") Long userId,
                                                    @Param("modelId") String modelId);

    @Insert("INSERT INTO user_model_preference (user_id, model_id, scene_type, preference_weight, usage_count, " +
            "like_count, dislike_count, avg_response_time, last_used_at, source, created_at, updated_at) " +
            "VALUES (#{userId}, #{modelId}, #{sceneType}, #{preferenceWeight}, #{usageCount}, " +
            "#{likeCount}, #{dislikeCount}, #{avgResponseTime}, #{lastUsedAt}, #{source}, NOW(), NOW()) " +
            "ON DUPLICATE KEY UPDATE preference_weight=VALUES(preference_weight), usage_count=VALUES(usage_count), " +
            "like_count=VALUES(like_count), dislike_count=VALUES(dislike_count), " +
            "avg_response_time=VALUES(avg_response_time), last_used_at=VALUES(last_used_at), " +
            "source=VALUES(source), updated_at=NOW()")
    int insertOrUpdate(UserModelPreference pref);
}
```

---

## 五、前端设计

### 5.1 用户设置页 — "模型偏好" Tab

位置：设置页面新增 `ModelPreferencesTab`

```
┌─────────────────────────────────────────────────────────────┐
│  模型偏好                                      手动 · 自动   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📊 我的使用统计                                            │
│  ┌─────────┬──────────┬──────────┬──────────┬──────────┐  │
│  │ 模型     │ 总调用次数 │ 成功次数  │ 平均耗时  │ 偏好度   │  │
│  ├─────────┼──────────┼──────────┼──────────┼──────────┤  │
│  │ GPT-4o  │   156    │   152    │  1.2s    │  ████░░  │  │
│  │ Claude  │    89    │    87    │  1.5s    │  ███░░░  │  │
│  │ Gemini  │    12    │    10    │  2.3s    │  █░░░░░  │  │
│  └─────────┴──────────┴──────────┴──────────┴──────────┘  │
│                                                             │
│  ⚙️  场景偏好设置                                            │
│  ┌─ 通用对话 ─────────────────────────────────────────┐    │
│  │  GPT-4o        [████████░░] +0.6  👍3  👎0         │    │
│  │  Claude 3.5    [██████░░░░] +0.4  👍2  👎0         │    │
│  │  Gemini 2.5    [████░░░░░░]  0.0  从未使用          │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌─ 代码生成 ─────────────────────────────────────────┐    │
│  │  Claude 3.5    [██████████] +0.9  👍5  👎0         │    │
│  │  GPT-4o        [██████░░░░] +0.3  👍1  👎1         │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  💡 偏好生效方式:                                           │
│  · 智能路由选择模型时，你的偏好会影响最终决策（权重 9%）      │
│  · 手动调整的权重优先级高于自动学习                          │
│  · 点踩 3 次以上的模型将自动降低优先级                       │
│                                                             │
│  [恢复默认]                              [保存设置]         │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 对话中隐式反馈入口（轻量）

在对话完成后，消息气泡下方增加微反馈按钮：

```
┌──────────────────────────────────────────┐
│  [🤖 GPT-4o]                             │
│  这是回答内容...                          │
│                                          │
│  👍 有用   👎 不太对   ⭐ 评分            │
│  ───────────────────────────             │
│  此回答由 GPT-4o 生成 · 1.2s · ¥0.003    │
└──────────────────────────────────────────┘
```

反馈后数据写入 `user_model_feedback`，异步触发偏好更新。

### 5.3 API 类型定义（前端 `api.ts`）

```typescript
// 用户模型偏好
export interface UserModelPreference {
  id: number
  userId: number
  modelId: string
  sceneType: string // 'chat' | 'vision' | 'code' | 'image' | 'agent'
  preferenceWeight: number // -1.0 ~ 1.0
  usageCount: number
  likeCount: number
  dislikeCount: number
  avgResponseTime: number
  lastUsedAt: string
  source: 'auto' | 'manual'
}

// 反馈
export interface ModelFeedbackRequest {
  conversationId?: string
  modelId: string
  sceneType?: string
  rating?: number      // 1-5
  liked?: boolean
  disliked?: boolean
  feedbackText?: string
  responseTimeMs?: number
}

// API
export const userPreferenceApi = {
  listPreferences: (sceneType?: string) =>
    api<UserModelPreference[]>(`/api/user/preferences${sceneType ? `?sceneType=${sceneType}` : ''}`),

  setManualPreference: (modelId: string, sceneType: string, weight: number) =>
    api.post('/api/user/preferences/manual', { modelId, sceneType, weight }),

  resetPreferences: (sceneType?: string) =>
    api.delete('/api/user/preferences', { data: { sceneType } }),

  submitFeedback: (feedback: ModelFeedbackRequest) =>
    api.post('/api/user/model-feedback', feedback),

  getUsageStats: (days?: number) =>
    api.get(`/api/user/model-usage-stats?days=${days || 30}`),
}
```

---

## 六、后端 API 设计

### 6.1 UserPreferenceController

```java
@RestController
@RequestMapping("/api/user")
@RequiredArgsConstructor
public class UserPreferenceController {

    private final UserPreferenceService userPreferenceService;

    /**
     * GET /api/user/preferences?sceneType=chat
     * 获取当前用户的模型偏好列表
     */
    @GetMapping("/preferences")
    public Result<List<UserModelPreference>> listPreferences(
        @RequestParam(required = false) String sceneType
    ) {
        Long userId = getCurrentUserId();
        List<UserModelPreference> prefs = sceneType != null
            ? userPreferenceService.getPreferencesByScene(userId, sceneType)
            : userPreferenceService.getPreferencesByUserRaw(userId);
        return Result.ok(prefs);
    }

    /**
     * POST /api/user/preferences/manual
     * 手动设置偏好权重
     */
    @PostMapping("/preferences/manual")
    public Result<Void> setManualPreference(@RequestBody ManualPreferenceRequest req) {
        userPreferenceService.setManualPreference(
            getCurrentUserId(), req.getModelId(), req.getSceneType(), req.getWeight()
        );
        return Result.ok(null);
    }

    /**
     * DELETE /api/user/preferences
     * 恢复默认（清除用户偏好）
     */
    @DeleteMapping("/preferences")
    public Result<Void> resetPreferences(@RequestBody(required = false) ResetRequest req) {
        userPreferenceService.resetPreferences(getCurrentUserId(), req != null ? req.getSceneType() : null);
        return Result.ok(null);
    }

    /**
     * POST /api/user/model-feedback
     * 提交模型反馈
     */
    @PostMapping("/model-feedback")
    public Result<Void> submitFeedback(@RequestBody ModelFeedbackRequest req) {
        req.setUserId(getCurrentUserId());
        userPreferenceService.recordFeedback(toEntity(req));
        return Result.ok(null);
    }

    /**
     * GET /api/user/model-usage-stats?days=30
     * 获取用户最近 N 天的模型使用统计
     */
    @GetMapping("/model-usage-stats")
    public Result<List<UserModelUsageStats>> getUsageStats(@RequestParam(defaultValue = "30") int days) {
        return Result.ok(userPreferenceService.getUsageStats(getCurrentUserId(), days));
    }
}
```

---

## 七、性能与频率控制

### 7.1 核心原则：事件驱动 + 缓存 + 异步

```
请求流程                         性能影响
─────────────────────────────────────────
对话请求到达
  │
  ├─ resolveModelWithRouting()
  │    │
  │    ├─ 预加载用户偏好     ← Caffeine 缓存命中 < 0.1ms
  │    └─ selectModel(ctx)
  │         └─ scoreUserPreference()  ← 纯内存计算，O(1)
  │
  ├─ 对话执行 (SSE 流式)
  │
  └─ 对话完成回调
       ├─ recordUsage()     ← @Async 异步执行，不阻塞
       └─ 写入日汇总         ← INSERT ON DUPLICATE KEY，1次DB操作
```

### 7.2 触发频率控制

| 操作 | 触发时机 | 频率 | 是否异步 |
|------|---------|------|---------|
| 偏好评分计算 | 每次路由选择 | 每对话 1 次 | 同步（纯内存） |
| 偏好权重自动更新 | 对话完成后 + 用户反馈后 | 每次对话结束 | **异步 @Async** |
| 日汇总写入 | 对话完成后 | 每次对话结束 | **异步** |
| 定时全量重算 | 每日凌晨 3:00 | 每天 1 次 | 定时任务 |
| 用户偏好缓存刷新 | 偏好数据变更时 | 稀疏 | 自动失效 |

### 7.3 缓存策略

```java
// Caffeine 缓存配置
Cache<Long, Map<String, UserModelPreference>> preferenceCache =
    Caffeine.newBuilder()
        .maximumSize(1000)           // 最多缓存1000个用户
        .expireAfterWrite(30, TimeUnit.MINUTES)  // 30分钟过期
        .recordStats()               // 记录命中率
        .build();
```

预估：1000个活跃用户 × 平均5条偏好记录 = 5000条记录在内存中，约 500KB，完全可接受。

### 7.4 高负载场景考虑

```
最坏情况: 1000 并发对话请求
  ├─ preferenceCache 命中率 > 95%（Caffeine 本地缓存）
  ├─ 每个请求的 scoreUserPreference(): 几条内存 Map get + 简单数学 → < 0.01ms
  ├─ 对话完成后 @Async recordUsage(): 线程池串行处理，不阻塞主线程
  └─ 日汇总写入: 少量 DB UPSERT，合并到 @Async 线程池
```

不会成为瓶颈。

---

## 八、冷启动与降级策略

### 8.1 新用户冷启动

- 新用户没有任何偏好记录 → `scoreUserPreference()` 返回 5.0（中等分）
- 路由完全由全局四维评分决定
- 使用 3-5 次后开始积累数据，偏好维度逐渐发挥作用

### 8.2 新模型冷启动

- 已有用户在现有场景下切换新模型 → 最初无偏好，5.0 中等分
- 不影响全局评分，但在能力相近的模型间不占优（这是合理的）

### 8.3 异常降级

```java
private double scoreUserPreference(ModelConfig model, RouteContext context) {
    try {
        // ... 正常逻辑 ...
    } catch (Exception e) {
        log.warn("用户偏好评分异常，降级为中等分: userId={}, modelId={}",
            context.getUserId(), model.getModelId(), e);
        return 5.0; // 降级：不影响路由决策
    }
}
```

---

## 九、实施计划

### Phase 1: 数据库 + 后端基础（预计 2-3h）
1. 创建三张新表的 SQL 迁移脚本
2. 创建实体类 + Mapper
3. 实现 UserPreferenceService 核心方法
4. 创建 UserPreferenceController API

### Phase 2: 路由评分集成（预计 1-2h）
1. 改造 RouteContext 添加用户偏好字段
2. ChatController.resolveModelWithRouting() 注入用户ID和偏好
3. ModelRoutingService 新增 scoreUserPreference() 方法
4. 调整权重常量（四维→五维）
5. 对话完成时调用 recordUsage() + 降级保护

### Phase 3: 前端体验（预计 2-3h）
1. 设置页新增 ModelPreferencesTab
2. 偏好权重滑块/可视化
3. 使用统计展示
4. 对话气泡微反馈按钮（👍 👎）
5. api.ts 扩展

### Phase 4: 验证与优化（预计 1h）
1. 单元测试：评分逻辑、冷启动、降级
2. 集成测试：对话流程端到端
3. 性能验证：1000并发场景下缓存命中率
4. 编译部署

---

## 十、风险与边界

| 风险 | 缓解措施 |
|------|---------|
| 用户偏好权重 9% 太小，效果不明显 | 可调整为 10-15%，但需验证不会覆盖全局能力匹配 |
| 恶意用户反复点赞/点踩操纵排名 | 每个用户对每个模型每天最多计 1 次有效反馈 |
| 缓存与 DB 数据不一致 | 30分钟过期 + 写入时主动 invalidate |
| 老用户历史数据缺失导致冷启动 | 根据历史 `chat_conversation` 表回填部分使用数据（可选） |
