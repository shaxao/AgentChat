package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 基础设定表 — 对应 Coze 的 基础设定/ 目录
 * SOUL.md / TOOLS.md / EMAIL_RULES.md
 */
@Data
@TableName("memory_setting")
public class MemorySetting {
    @TableId(type = IdType.AUTO)
    private Long id;

    /** 设定键：soul / tools / rules / email_rules */
    private String settingKey;

    /** 显示名称 */
    private String settingName;

    /** Markdown 内容 */
    private String content;

    private Integer sortOrder;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
