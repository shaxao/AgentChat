package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 记忆文档表 — 统一存储所有记忆内容
 * 对应 Coze 的 MEMORY.md / USER.md / SECRET.md / recent_memory/project/*.md
 */
@Data
@TableName("memory_document")
public class MemoryDocument {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 所属用户 */
    private Long userId;

    /** 所属对话（NULL = 全局） */
    private Long conversationId;

    /**
     * 文档类型：
     *   conversation_summary — 对话摘要（对应 MEMORY.md）
     *   project_memory       — 项目/技能记忆（对应 recent_memory/project/*.md）
     *   user_profile         — 用户画像（对应 USER.md）
     *   secret               — 凭据管理（对应 SECRET.md）
     *   skill_memory         — 技能记忆
     *   work_file_meta       — 工作文件元数据
     */
    private String docType;

    private String title;

    /** Markdown 内容（secret 类型可加密） */
    private String content;

    private String category;

    /** 逗号分隔标签 */
    private String tags;

    /** 重要性 1-5，默认 3 */
    private Integer importance;

    /** active / archived / expired */
    private String status;

    /** 来源对话 UUID */
    private String sourceConvUuid;

    /** 过期时间，NULL 永不过期 */
    private LocalDateTime expiresAt;

    /** 关联文件大小（bytes） */
    private Long fileSize;

    /** 关联文件类型 */
    private String fileType;

    /** 关联文件 OSS URL */
    private String ossUrl;

    /**
     * 记忆层级（五层模型）：L1 热 / L2 温 / L3 冷 / L4 归档
     * 见 docs/memory_layered_architecture.md
     */
    private String layer;

    /** VFS 虚拟路径，如 /memory/hot/USER.md */
    private String virtualPath;

    /** 访问计数，用于归档/压缩决策 */
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
