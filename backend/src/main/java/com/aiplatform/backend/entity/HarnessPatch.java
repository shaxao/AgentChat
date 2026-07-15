package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("harness_patch")
public class HarnessPatch {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String patchUuid;
    private String surface;
    private String targetType;
    private String targetId;
    private String title;
    private String rationale;
    private String patchJson;
    private String status;
    private Long createdByTraceId;
    private Long reviewedBy;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    private LocalDateTime reviewedAt;
}
