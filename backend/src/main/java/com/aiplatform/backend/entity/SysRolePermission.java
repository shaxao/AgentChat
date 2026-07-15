package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 角色-权限关联实体
 */
@Data
@TableName("sys_role_permission")
public class SysRolePermission {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long roleId;            // 关联 sys_role.id
    private Long permissionId;      // 关联 sys_permission.id

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
