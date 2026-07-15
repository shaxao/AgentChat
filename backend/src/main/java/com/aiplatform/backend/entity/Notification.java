package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 系统通知实体
 * <p>
 * 存储所有通知/公告信息，支持广播和定向推送。
 * 通知类型包括：系统公告(announcement)、技能审核结果(skill_review)、系统通知(system)。
 */
@Data
@TableName("sys_notification")
public class Notification {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** UUID */
    private String uuid;

    /** 通知标题 */
    private String title;

    /** 通知内容 */
    private String content;

    /** 通知类型: announcement/skill_review/system */
    private String type;

    /** 推送目标: all=全部用户, specific=指定用户 */
    private String targetType;

    /** 目标用户ID列表(逗号分隔)，target_type=specific 时有效 */
    private String targetUserIds;

    /** 附加数据(JSON)，如技能名称、审核原因等 */
    private String extraData;

    /** 创建者用户ID */
    private Long createdBy;

    /** 状态: draft/published */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
