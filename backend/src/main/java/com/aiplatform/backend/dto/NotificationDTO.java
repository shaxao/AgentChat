package com.aiplatform.backend.dto;

import lombok.Data;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 通知系统 DTO
 */
public class NotificationDTO {

    /** 创建/更新通知请求 */
    @Data
    public static class CreateRequest {
        private String title;
        private String content;
        private String type;          // announcement / skill_review / system
        private String targetType;    // all / specific
        private List<Long> targetUserIds;
        private String extraData;     // JSON
    }

    /** 更新通知请求 */
    @Data
    public static class UpdateRequest {
        private String title;
        private String content;
        private String type;
        private String targetType;
        private List<Long> targetUserIds;
        private String extraData;
        private String status;       // draft / published
    }

    /** 通知管理列表 VO */
    @Data
    public static class NotificationAdminVO {
        private Long id;
        private String uuid;
        private String title;
        private String content;
        private String type;
        private String targetType;
        private List<Long> targetUserIds;
        private String extraData;
        private Long createdBy;
        private String createdByName;
        private String status;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
        private Integer totalRecipients;
        private Integer totalRead;
    }

    /** 用户端通知 VO */
    @Data
    public static class UserNotificationVO {
        private Long id;              // user_notification.id
        private Long notificationId;  // sys_notification.id
        private String title;
        private String content;
        private String type;
        private String extraData;
        private Boolean isRead;
        private LocalDateTime readAt;
        private LocalDateTime createdAt;
    }

    /** 未读计数 VO */
    @Data
    public static class UnreadCountVO {
        private Integer count;
    }

    /** 用户通知分页结果 */
    @Data
    public static class UserNotificationPageVO {
        private List<UserNotificationVO> list;
        private Long total;
        private Integer page;
        private Integer size;
        private Boolean hasMore;
    }

    /** 隐私设置 VO */
    @Data
    public static class PrivacySettingVO {
        private Boolean saveHistory;
        private Boolean dataImprovement;
        private Boolean twoFactorAuth;
    }

    /** 更新隐私设置请求 */
    @Data
    public static class UpdatePrivacyRequest {
        private Boolean saveHistory;
        private Boolean dataImprovement;
        private Boolean twoFactorAuth;
    }
}
