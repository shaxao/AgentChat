package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("harness_failure_case")
public class HarnessFailureCase {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long traceId;
    private String surface;
    private String failureType;
    private String severity;
    private String summary;
    private String evidenceJson;
    private String status;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    private LocalDateTime resolvedAt;
}
