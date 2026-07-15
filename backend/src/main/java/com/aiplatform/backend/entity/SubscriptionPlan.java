package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("subscription_plan")
public class SubscriptionPlan {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    private String name;
    private String code;          // free/pro/enterprise/custom
    private String description;
    private BigDecimal price;
    private BigDecimal costLimit;
    private Long tokensLimit;
    private String modelLimit;    // 逗号分隔，空表示不限
    private String features;      // JSON 数组字符串
    private Integer sortOrder;
    private Boolean isPopular;
    private Boolean enabled;

    @TableField("role_id")
    private Long roleId;           // 绑定的角色ID (FK→sys_role.id)

    @TableField(exist = false)
    private String roleName;       // 角色名称（非DB字段，由Service填充）
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
