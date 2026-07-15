package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * RBAC 权限实体（支持树形层级结构）
 */
@Data
@TableName("sys_permission")
public class SysPermission {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;            // 唯一标识 UUID
    private String permissionName;  // 权限名称（显示用）
    private String permissionCode;  // 权限代码（如 skill:publish）
    private Long parentId;          // 上级权限ID（0=顶级）
    private String resourceType;    // 资源类型：menu/button/api
    private String action;          // 操作类型：create/read/update/delete
    private String description;     // 权限描述
    private Integer sortOrder;      // 排序权重

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
