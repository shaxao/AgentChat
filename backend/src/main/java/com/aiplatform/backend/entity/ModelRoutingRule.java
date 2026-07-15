package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("model_routing_rule")
public class ModelRoutingRule {
    @TableId(type = IdType.AUTO)
    private Long id;

    @TableField("user_id")
    private Long userId;

    @TableField("rule_name")
    private String name;
    private String description;
    private String sceneType;
    private String agentType;
    private String complexity;

    @TableField("required_tags")
    private String requiredCapabilities;
    private String preferredProviders;
    private Integer minContextLength;
    private BigDecimal maxInputPrice;
    private BigDecimal maxOutputPrice;
    private Integer priority;
    private Boolean enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
