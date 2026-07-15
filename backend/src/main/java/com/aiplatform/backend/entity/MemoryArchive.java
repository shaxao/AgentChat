package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * L4 归档记忆表 — 冷数据内容下沉，原 memory_document 仅保留摘要指针
 * 见 docs/memory_layered_architecture.md
 */
@Data
@TableName("memory_archive")
public class MemoryArchive {
    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** 来源 memory_document.id */
    private Long sourceDocId;

    private String title;

    private String docType;

    private String category;

    /** 下沉的完整内容 */
    private String content;

    private String summary;

    private String tags;

    /** 归档前层级 */
    private String layerFrom;

    private LocalDateTime archivedAt;

    /** 恢复密钥，便于从归档拉回 */
    private String restoreKey;
}
