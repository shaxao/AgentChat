package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.ModelRoutingStats;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import java.util.List;

/**
 * 模型路由统计 Mapper
 */
@Mapper
public interface ModelRoutingStatsMapper extends BaseMapper<ModelRoutingStats> {
    
    /**
     * 根据模型ID和场景类型查询统计信息
     */
    @Select("SELECT * FROM model_routing_stats WHERE model_id = #{modelId} AND " +
            "(scene_type = #{sceneType} OR scene_type IS NULL) AND deleted = 0 LIMIT 1")
    ModelRoutingStats findByModelIdAndScene(String modelId, String sceneType);
    
    /**
     * 重置熔断器状态
     */
    @Update("UPDATE model_routing_stats SET circuit_breaker_state = 'closed', " +
            "consecutive_failures = 0 WHERE model_id = #{modelId}")
    int resetCircuitBreaker(String modelId);
}
