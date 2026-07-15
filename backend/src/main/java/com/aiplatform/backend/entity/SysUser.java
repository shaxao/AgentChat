package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("sys_user")
public class SysUser {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    private String username;
    private String email;
    private String password;
    private String avatar;
    private String role;           // admin / user
    private String plan;           // free / pro / enterprise
    private String status;         // active / suspended / pending
    private Boolean emailVerified;
    private Long tokensUsed;
    private Long tokensLimit;
    private java.math.BigDecimal costUsed;
    private java.math.BigDecimal costLimit;
    private java.math.BigDecimal balance;         // 账户余额（¥）
    private java.math.BigDecimal totalConsumed;   // 累计消费（¥）
    private java.math.BigDecimal totalEarned;     // 累计收益（开发者分成，¥）
    private java.math.BigDecimal totalRecharged;  // 累计充值（¥）
    private LocalDateTime lastLoginAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
