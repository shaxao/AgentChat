package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 用户隐私设置实体
 */
@Data
@TableName("user_privacy_setting")
public class UserPrivacySetting {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 用户ID */
    private Long userId;

    /** 保存对话历史: 0=关闭, 1=开启 */
    private Integer saveHistory;

    /** 数据用于改进: 0=关闭, 1=开启 */
    private Integer dataImprovement;

    /** 两步验证: 0=关闭, 1=开启 */
    private Integer twoFactorAuth;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
