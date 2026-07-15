package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.ManualPreferenceRequest;
import com.aiplatform.backend.dto.ModelFeedbackRequest;
import com.aiplatform.backend.dto.ResetPreferencesRequest;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.UserModelFeedback;
import com.aiplatform.backend.entity.UserModelPreference;
import com.aiplatform.backend.entity.UserModelUsageDaily;
import com.aiplatform.backend.service.UserPreferenceService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 用户模型偏好控制器
 */
@RestController
@RequestMapping("/api/user")
@RequiredArgsConstructor
@Slf4j
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
        if (userId == null) return Result.fail("未登录");

        List<UserModelPreference> prefs = sceneType != null
            ? userPreferenceService.getPreferencesByScene(userId, sceneType)
            : userPreferenceService.getPreferencesByUser(userId).values().stream().toList();
        return Result.ok(prefs);
    }

    /**
     * POST /api/user/preferences/manual
     * 手动设置偏好权重
     */
    @PostMapping("/preferences/manual")
    public Result<Void> setManualPreference(@RequestBody ManualPreferenceRequest req) {
        Long userId = getCurrentUserId();
        if (userId == null) return Result.fail("未登录");
        if (req.getModelId() == null || req.getSceneType() == null) {
            return Result.fail("modelId 和 sceneType 不能为空");
        }

        userPreferenceService.setManualPreference(
            userId, req.getModelId(), req.getSceneType(), req.getWeight()
        );
        return Result.ok(null);
    }

    /**
     * DELETE /api/user/preferences
     * 恢复默认（清除用户偏好）
     */
    @DeleteMapping("/preferences")
    public Result<Void> resetPreferences(@RequestBody(required = false) ResetPreferencesRequest req) {
        Long userId = getCurrentUserId();
        if (userId == null) return Result.fail("未登录");

        String sceneType = req != null ? req.getSceneType() : null;
        userPreferenceService.resetPreferences(userId, sceneType);
        return Result.ok(null);
    }

    /**
     * POST /api/user/model-feedback
     * 提交模型反馈（点赞/点踩/评分）
     */
    @PostMapping("/model-feedback")
    public Result<Void> submitFeedback(@RequestBody ModelFeedbackRequest req) {
        Long userId = getCurrentUserId();
        if (userId == null) return Result.fail("未登录");
        if (req.getModelId() == null) return Result.fail("modelId 不能为空");

        UserModelFeedback feedback = new UserModelFeedback();
        feedback.setUserId(userId);
        feedback.setModelId(req.getModelId());
        feedback.setSceneType(req.getSceneType() != null ? req.getSceneType() : "chat");
        feedback.setConversationId(req.getConversationId());
        feedback.setRating(req.getRating());
        feedback.setLiked(req.getLiked() != null && req.getLiked() ? 1 : 0);
        feedback.setDisliked(req.getDisliked() != null && req.getDisliked() ? 1 : 0);
        feedback.setFeedbackText(req.getFeedbackText());
        feedback.setResponseTimeMs(req.getResponseTimeMs());

        userPreferenceService.recordFeedback(feedback);
        return Result.ok(null);
    }

    /**
     * GET /api/user/model-usage-stats?days=30
     * 获取用户最近 N 天的模型使用统计
     */
    @GetMapping("/model-usage-stats")
    public Result<List<UserModelUsageDaily>> getUsageStats(@RequestParam(defaultValue = "30") int days) {
        Long userId = getCurrentUserId();
        if (userId == null) return Result.fail("未登录");

        return Result.ok(userPreferenceService.getUsageStats(userId, Math.min(days, 90)));
    }

    // ═══════════════════════════════════════
    // 辅助方法
    // ═══════════════════════════════════════

    private Long getCurrentUserId() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || authentication.getPrincipal() == null) return null;
        Object principal = authentication.getPrincipal();
        if (principal instanceof Long userId) return userId;
        try {
            return Long.parseLong(authentication.getName());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
