package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("harness_trace_event")
public class HarnessTraceEvent {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long traceId;
    private String surface;
    private Integer seq;
    private String eventType;
    private String eventName;
    private String severity;
    private String status;
    private String agentId;
    private String model;
    private String provider;
    private String channelId;
    private Integer turnIndex;
    private String toolName;
    private String toolCallId;
    private Integer durationMs;
    private Integer inputChars;
    private Integer outputChars;
    private String payloadJson;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
