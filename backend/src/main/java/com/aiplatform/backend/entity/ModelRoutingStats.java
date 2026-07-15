package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 模型路由统计实体（熔断器状态）
 * DB 表: model_routing_stats
 */
@Data
@TableName("model_routing_stats")
public class ModelRoutingStats {
    @TableId(type = IdType.AUTO)
    private Long id;
    
    private String modelId;            // 模型ID → model_id
    private String sceneType;           // 场景类型 → scene_type
    
    @TableField("total_calls")
    private Integer totalRequests;      // 总请求数
    
    @TableField("success_calls")
    private Integer successRequests;    // 成功请求数
    
    @TableField("failed_calls")
    private Integer failedRequests;     // 失败请求数
    
    private Integer avgResponseTime;    // 平均响应时间(ms) → avg_response_time
    
    @TableField("last_success_at")
    private LocalDateTime lastSuccessTime;   // 最后成功时间
    
    @TableField("last_failure_at")
    private LocalDateTime lastFailureTime;   // 最后失败时间
    
    private Integer consecutiveFailures;     // 连续失败次数 → consecutive_failures
    
    @TableField("circuit_breaker_state")
    private String circuitBreakerState;     // 熔断器状态: closed/open/half-open
    
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    
    @TableLogic
    private Integer deleted;
}
