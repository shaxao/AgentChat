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

    /** 模型别名，逗号分隔。入站网关（/v1/messages 等）用它把 IDE 工具发来的模型名（如 claude-3-5-sonnet-20241022）映射到本平台 model_id。 */
    private String aliases;

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
