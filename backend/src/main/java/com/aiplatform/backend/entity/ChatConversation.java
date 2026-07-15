package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("chat_conversation")
public class ChatConversation {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    private Long userId;
    private String title;
    private String model;
    private String systemPrompt;
    private Boolean pinned;
    private String tags;
    /** 早期对话摘要，超长对话时压缩历史上下文使用 */
    private String contextSummary;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
