package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 记忆索引表 — JSON 结构化元数据，快速检索
 * 对应 Coze 的 recent_memory/index.json
 */
@Data
@TableName("memory_index")
public class MemoryIndex {
    @TableId(type = IdType.AUTO)
    private Long id;

    /** 所属用户 */
    private Long userId;

    /** 关联 memory_document.id */
    private Long docId;

    /** 分类：project / skill / user_setting */
    private String category;

    /** 简要摘要 */
    private String summary;

    /** 逗号分隔标签 */
    private String tags;

    /** 重要性 1-5 */
    private Integer importance;

    /** 过期时间 */
    private LocalDateTime expiresAt;

    /**
     * 记忆层级（五层模型）：L1 热 / L2 温 / L3 冷 / L4 归档
     */
    private String layer;

    /** VFS 虚拟路径 */
    private String virtualPath;

    /** 访问计数 */
    private Integer accessCount;

    /** 最近访问时间 */
    private LocalDateTime lastAccessedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
