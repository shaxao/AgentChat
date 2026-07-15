package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("model_config")
public class ModelConfig {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String modelId;
    private String name;
    private String provider;
    private String description;
    private Integer contextLength;
    private BigDecimal inputPrice;
    private BigDecimal cachedInputPrice;
    private BigDecimal outputPrice;
    private String capabilities;   // comma-separated

    // 路由所需字段
    private Integer codeQuality;       // 代码质量评分 (1-100)
    private String strengths;          // 优势领域 JSON 数组，如 ["reasoning","code","vision"]
    private String taskTypes;          // 适用任务类型 JSON 数组，如 ["chat","code","image"]
    @TableField("routing_priority")
    private Integer routingPriority;  // 路由优先级 (1~10, 越高越优先)

    private Boolean enabled;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableLogic
    private Integer deleted;
}
