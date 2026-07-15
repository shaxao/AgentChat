package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("chat_message")
public class ChatMessage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    @TableField("conversation_id")
    private Long conversationId;
    private String role;       // user / assistant / system
    private String content;
    private String model;
    private Integer inputTokens;
    private Integer outputTokens;
    private BigDecimal cost;
    private Integer latencyMs;
    private String status;     // success / error
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableLogic
    private Integer deleted;
}
