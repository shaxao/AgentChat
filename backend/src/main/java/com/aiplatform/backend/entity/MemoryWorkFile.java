package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 工作文件物理存储表 — 对话中产生/上传的文件
 */
@Data
@TableName("memory_work_file")
public class MemoryWorkFile {
    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 所属用户 */
    private Long userId;

    /** 来源对话 */
    private Long conversationId;

    /** 关联 memory_document.id */
    private Long docId;

    /** 原始文件名 */
    private String fileName;

    /**
     * 文件类型：
     *   image / document / spreadsheet / audio / video / skill / other
     */
    private String fileType;

    private Long fileSize;

    private String mimeType;

    /** OSS 存储 URL */
    private String ossUrl;

    /** 缩略图 URL */
    private String thumbUrl;

    private String description;

    /** 逗号分隔标签 */
    private String tags;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
