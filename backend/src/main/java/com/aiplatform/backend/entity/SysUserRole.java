package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 用户-角色关联实体
 */
@Data
@TableName("sys_user_role")
public class SysUserRole {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;            // 关联 sys_user.id
    private Long roleId;            // 关联 sys_role.id

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
