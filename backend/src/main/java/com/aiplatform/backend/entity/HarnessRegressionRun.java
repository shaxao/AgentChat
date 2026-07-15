package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("harness_regression_run")
public class HarnessRegressionRun {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String runUuid;
    private String surface;
    private Long versionId;
    private String version;
    private String status;
    private Integer totalCases;
    private Integer passedCases;
    private Integer failedCases;
    private Integer blockedCases;
    private String summary;
    private String resultJson;
    private Long createdBy;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    private LocalDateTime completedAt;
}
