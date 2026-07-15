package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("model_channel")
public class ModelChannel {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    private String name;
    private String provider;
    private String apiKey;
    private String baseUrl;
    private String models;        // JSON array
    private String channelType;   // chat / translate / tts（默认 chat）
    private String tags;          // JSON 数组，如 ["tool","vision"]
    /** TTS 音色配置 JSON 数组，如 [{"id":"alloy","label":"标准"},...] */
    private String ttsVoices;     // 仅 channelType=tts 时有效
    /** 翻译支持语言配置 JSON 数组，如 [{"code":"英文","label":"🇺🇸 英文"},...] */
    private String translateLangs; // 仅 channelType=translate 时有效
    private String status;        // active / error / disabled
    private Integer priority;
    private Integer rateLimit;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
