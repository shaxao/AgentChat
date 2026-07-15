package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("harness_trace")
public class HarnessTrace {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String traceUuid;
    private String surface;
    private Long userId;
    private Long conversationId;
    private String conversationUuid;
    private String taskId;
    private String model;
    private String provider;
    private String channelId;
    private String harnessVersion;
    private String status;
    private String inputSummary;
    private String outputSummary;
    private String failureType;
    private String errorMsg;
    private Integer latencyMs;
    private Integer inputTokens;
    private Integer outputTokens;
    private String requestJson;
    private String contextJson;
    private String eventsJson;
    private String metricsJson;
    private String qualityJson;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    private LocalDateTime completedAt;
}
