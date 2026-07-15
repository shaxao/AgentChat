package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * RBAC 角色实体
 */
@Data
@TableName("sys_role")
public class SysRole {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;            // 唯一标识 UUID
    private String roleName;        // 角色名称（显示用）
    private String roleCode;        // 角色代码（如 super_admin/admin/editor）
    private String description;     // 角色描述
    private String status;          // 状态：active/disabled
    private Integer sortOrder;      // 排序权重
    private Integer isSystem;       // 是否系统内置角色（1=不可删除）

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
