package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 钱包流水实体
 */
@Data
@TableName("wallet_transaction")
public class WalletTransaction {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 用户 ID */
    private Long userId;

    /** 交易类型：deposit/withdraw/consume/earn/refund */
    private String type;

    /** 交易金额（¥） */
    private BigDecimal amount;

    /** 交易前余额 */
    private BigDecimal balanceBefore;

    /** 交易后余额 */
    private BigDecimal balanceAfter;

    /** 交易描述 */
    private String description;

    /** 关联类型：chat/agent_share/recharge/withdraw */
    private String refType;

    /** 关联 ID */
    private String refId;

    /** 交易状态：success/pending/failed */
    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
