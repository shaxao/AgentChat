package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ModelUsageEvent;
import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * 用户模型偏好服务
 * 
 * 负责：
 * 1. 用户模型偏好的 CRUD
 * 2. 对话完成后的自动学习（异步）
 * 3. 用户反馈处理（异步）
 * 4. 手动偏好设置
 * 5. 偏好缓存管理
 */
@Service
@Slf4j
public class UserPreferenceService {

    @Autowired
    private UserModelPreferenceMapper preferenceMapper;

    @Autowired
    private UserModelFeedbackMapper feedbackMapper;

    @Autowired
    private UserModelUsageDailyMapper usageDailyMapper;

    @Autowired
    private ModelRoutingStatsMapper routingStatsMapper;

    /**
     * 内存缓存：用户偏好权重（高频读取）
     * Key: userId, Value: "modelId:sceneType" -> preferenceWeight
     */
    private final Cache<Long, Map<String, Double>> preferenceCache =
        Caffeine.newBuilder()
            .maximumSize(1000)
            .expireAfterWrite(30, TimeUnit.MINUTES)
            .build();

    // ═══════════════════════════════════════
    // 查询方法
    // ═══════════════════════════════════════

    /**
     * 获取用户在指定场景下对某模型的偏好
     */
    public UserModelPreference getPreference(Long userId, String modelId, String sceneType) {
        return preferenceMapper.findByUserModelScene(userId, modelId, sceneType);
    }

    /**
     * 获取用户所有偏好（用于预加载到 RouteContext）
     */
    public Map<String, UserModelPreference> getPreferencesByUser(Long userId) {
        List<UserModelPreference> list = preferenceMapper.findByUserId(userId);
        Map<String, UserModelPreference> map = new LinkedHashMap<>();
        for (UserModelPreference p : list) {
            map.put(p.getModelId() + ":" + p.getSceneType(), p);
        }
        return map;
    }

    /**
     * 获取用户在指定场景下的所有偏好（List形式，用于API返回）
     */
    public List<UserModelPreference> getPreferencesByScene(Long userId, String sceneType) {
        return preferenceMapper.findByUserIdAndScene(userId, sceneType);
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
     * 调用时机：ChatController 中 SSE 完成回调
     */
    @Async
    public void recordUsage(ModelUsageEvent event) {
        if (event == null || event.getUserId() == null || event.getModelId() == null) {
            return;
        }
        String sceneType = event.getSceneType() != null ? event.getSceneType() : "chat";

        try {
            // 1. Upsert 偏好记录
            UserModelPreference pref = preferenceMapper.findByUserModelScene(
                event.getUserId(), event.getModelId(), sceneType
            );

            if (pref == null) {
                pref = new UserModelPreference();
                pref.setUserId(event.getUserId());
                pref.setModelId(event.getModelId());
                pref.setSceneType(sceneType);
                pref.setPreferenceWeight(BigDecimal.ZERO);
                pref.setUsageCount(0);
                pref.setLikeCount(0);
                pref.setDislikeCount(0);
                pref.setAvgResponseTime(0);
                pref.setSource("auto");
            }

            // 更新累计使用数据
            int oldCount = pref.getUsageCount() != null ? pref.getUsageCount() : 0;
            pref.setUsageCount(oldCount + 1);
            pref.setLastUsedAt(LocalDateTime.now());

            // 更新平均响应时间（增量平均）
            int oldAvg = pref.getAvgResponseTime() != null ? pref.getAvgResponseTime() : 0;
            if (oldCount > 0 && oldAvg > 0) {
                pref.setAvgResponseTime(
                    (int)((oldAvg * oldCount + event.getResponseTimeMs()) / (double)(oldCount + 1))
                );
            } else {
                pref.setAvgResponseTime(event.getResponseTimeMs());
            }

            preferenceMapper.upsert(pref);

            // 2. 写入日汇总表（供定时任务聚合使用）
            UserModelUsageDaily daily = usageDailyMapper.findByUserModelSceneDate(
                event.getUserId(), event.getModelId(), sceneType, LocalDate.now()
            );
            if (daily == null) {
                daily = new UserModelUsageDaily();
                daily.setUserId(event.getUserId());
                daily.setModelId(event.getModelId());
                daily.setSceneType(sceneType);
                daily.setStatDate(LocalDate.now());
                daily.setCallCount(0);
                daily.setSuccessCount(0);
                daily.setTotalTokens(0L);
                daily.setTotalCost(BigDecimal.ZERO);
                daily.setAvgResponseTime(0);
            }
            daily.setCallCount(daily.getCallCount() + 1);
            if (event.isSuccess()) {
                daily.setSuccessCount(daily.getSuccessCount() + 1);
            }
            if (event.getTokenUsage() != null) {
                daily.setTotalTokens(daily.getTotalTokens() + event.getTokenUsage());
            }
            if (event.getCost() != null) {
                daily.setTotalCost(daily.getTotalCost().add(event.getCost()));
            }
            usageDailyMapper.upsert(daily);

            // 3. 清除内存缓存（下次读取时重新加载）
            preferenceCache.invalidate(event.getUserId());

        } catch (Exception e) {
            log.error("记录用户模型使用失败: userId={}, modelId={}", event.getUserId(), event.getModelId(), e);
        }
    }

    // ═══════════════════════════════════════
    // 用户反馈处理
    // ═══════════════════════════════════════

    /**
     * 用户手动反馈（点赞/点踩/评分）
     */
    @Async
    public void recordFeedback(UserModelFeedback feedback) {
        if (feedback.getUserId() == null || feedback.getModelId() == null) {
            return;
        }
        String sceneType = feedback.getSceneType() != null ? feedback.getSceneType() : "chat";

        feedbackMapper.insert(feedback);

        // 同步更新偏好表
        UserModelPreference pref = preferenceMapper.findByUserModelScene(
            feedback.getUserId(), feedback.getModelId(), sceneType
        );
        if (pref == null) {
            pref = new UserModelPreference();
            pref.setUserId(feedback.getUserId());
            pref.setModelId(feedback.getModelId());
            pref.setSceneType(sceneType);
            pref.setPreferenceWeight(BigDecimal.ZERO);
            pref.setUsageCount(0);
            pref.setLikeCount(0);
            pref.setDislikeCount(0);
            pref.setAvgResponseTime(0);
            pref.setSource("auto");
        }

        int oldLikes = pref.getLikeCount() != null ? pref.getLikeCount() : 0;
        int oldDislikes = pref.getDislikeCount() != null ? pref.getDislikeCount() : 0;

        if (feedback.getLiked() != null && feedback.getLiked() == 1) {
            pref.setLikeCount(oldLikes + 1);
        }
        if (feedback.getDisliked() != null && feedback.getDisliked() == 1) {
            pref.setDislikeCount(oldDislikes + 1);
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

        preferenceMapper.upsert(pref);
        preferenceCache.invalidate(feedback.getUserId());

        log.info("记录用户反馈: userId={}, modelId={}, liked={}, disliked={}, rating={}",
            feedback.getUserId(), feedback.getModelId(),
            feedback.getLiked(), feedback.getDisliked(), feedback.getRating());
    }

    // ═══════════════════════════════════════
    // 手动设置
    // ═══════════════════════════════════════

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
            pref.setUsageCount(0);
            pref.setLikeCount(0);
            pref.setDislikeCount(0);
            pref.setAvgResponseTime(0);
        }
        pref.setPreferenceWeight(BigDecimal.valueOf(Math.max(-1.0, Math.min(1.0, weight))));
        pref.setSource("manual"); // ← 标记为手动，路由评分时给予更高权重
        pref.setUpdatedAt(LocalDateTime.now());
        preferenceMapper.upsert(pref);
        preferenceCache.invalidate(userId);
    }

    /**
     * 重置用户偏好（恢复默认）
     */
    public void resetPreferences(Long userId, String sceneType) {
        preferenceMapper.deleteByUserAndScene(userId, sceneType);
        preferenceCache.invalidate(userId);
    }

    // ═══════════════════════════════════════
    // 统计查询
    // ═══════════════════════════════════════

    /**
     * 获取用户最近 N 天的模型使用统计
     */
    public List<UserModelUsageDaily> getUsageStats(Long userId, int days) {
        LocalDate since = LocalDate.now().minusDays(days);
        return usageDailyMapper.getUsageStats(userId, since);
    }

    // ═══════════════════════════════════════
    // 缓存管理
    // ═══════════════════════════════════════

    /**
     * 清除指定用户的偏好缓存
     */
    public void invalidateCache(Long userId) {
        preferenceCache.invalidate(userId);
    }
}
