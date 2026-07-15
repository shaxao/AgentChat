package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.NotificationDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 通知系统控制器
 * <p>
 * 用户端 API：
 * - GET    /api/notifications          获取用户通知列表
 * - GET    /api/notifications/unread   获取未读数
 * - PUT    /api/notifications/{id}/read   标记单条已读
 * - PUT    /api/notifications/read-all    标记全部已读
 * - GET    /api/notifications/privacy     获取隐私设置
 * - PUT    /api/notifications/privacy     更新隐私设置
 * <p>
 * 管理端 API（需 admin）：
 * - GET    /api/notifications/admin          分页查询通知列表
 * - POST   /api/notifications/admin          创建通知
 * - PUT    /api/notifications/admin/{id}     更新通知
 * - DELETE /api/notifications/admin/{id}     删除通知
 */
@Slf4j
@RestController
@RequestMapping("/api/notifications")
@RequiredArgsConstructor
public class NotificationController {

    private final NotificationService notificationService;

    // =============================================
    // 用户端 API
    // =============================================

    /**
     * 获取用户通知列表
     */
    @GetMapping
    public Result<?> list(
            @RequestAttribute Long userId,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) Boolean read) {
        if (page != null || size != null || read != null) {
            return Result.ok(notificationService.getUserNotificationsPaged(
                    userId,
                    page != null ? page : 1,
                    size != null ? size : limit,
                    read));
        }
        return Result.ok(notificationService.getUserNotifications(userId, limit));
    }

    /**
     * 获取未读通知数
     */
    @GetMapping("/unread")
    public Result<NotificationDTO.UnreadCountVO> getUnreadCount(@RequestAttribute Long userId) {
        NotificationDTO.UnreadCountVO vo = new NotificationDTO.UnreadCountVO();
        vo.setCount(notificationService.getUnreadCount(userId));
        return Result.ok(vo);
    }

    /**
     * 标记单条通知为已读
     */
    @PutMapping("/{notificationId}/read")
    public Result<Void> markAsRead(
            @RequestAttribute Long userId,
            @PathVariable Long notificationId) {
        notificationService.markAsRead(userId, notificationId);
        return Result.ok();
    }

    /**
     * 标记所有通知为已读
     */
    @PutMapping("/read-all")
    public Result<Void> markAllAsRead(@RequestAttribute Long userId) {
        notificationService.markAllAsRead(userId);
        return Result.ok();
    }

    // =============================================
    // 隐私设置 API
    // =============================================

    /**
     * 获取用户隐私设置
     */
    @GetMapping("/privacy")
    public Result<NotificationDTO.PrivacySettingVO> getPrivacySettings(@RequestAttribute Long userId) {
        return Result.ok(notificationService.getPrivacySettings(userId));
    }

    /**
     * 更新用户隐私设置
     */
    @PutMapping("/privacy")
    public Result<NotificationDTO.PrivacySettingVO> updatePrivacySettings(
            @RequestAttribute Long userId,
            @RequestBody NotificationDTO.UpdatePrivacyRequest req) {
        return Result.ok(notificationService.updatePrivacySettings(userId, req));
    }

    // =============================================
    // 管理端 API（需 admin 权限）
    // =============================================

    /**
     * 分页查询通知列表（管理端）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/admin")
    public Result<Result.PageResult<NotificationDTO.NotificationAdminVO>> adminList(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String status) {
        return Result.ok(notificationService.adminList(page, size, type, status));
    }

    /**
     * 创建通知（管理端）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/admin")
    public Result<NotificationDTO.NotificationAdminVO> create(
            @RequestBody NotificationDTO.CreateRequest req,
            @RequestAttribute Long userId) {
        return Result.ok(notificationService.create(req, userId));
    }

    /**
     * 更新通知（管理端）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/admin/{id}")
    public Result<NotificationDTO.NotificationAdminVO> update(
            @PathVariable Long id,
            @RequestBody NotificationDTO.UpdateRequest req) {
        return Result.ok(notificationService.update(id, req));
    }

    /**
     * 删除通知（管理端）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/admin/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        notificationService.delete(id);
        return Result.ok();
    }
}
