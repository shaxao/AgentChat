package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 用户通知记录实体
 * <p>
 * 记录每个用户收到的通知及其已读状态。
 */
@Data
@TableName("user_notification")
public class UserNotification {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 用户ID */
    private Long userId;

    /** 关联 sys_notification.id */
    private Long notificationId;

    /** 是否已读: 0=未读, 1=已读 */
    private Integer isRead;

    /** 阅读时间 */
    private LocalDateTime readAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
