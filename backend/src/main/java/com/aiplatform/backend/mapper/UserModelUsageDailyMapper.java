package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.UserModelUsageDaily;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.*;

import java.time.LocalDate;
import java.util.List;

/**
 * 用户模型使用日汇总 Mapper
 */
@Mapper
public interface UserModelUsageDailyMapper extends BaseMapper<UserModelUsageDaily> {

    @Select("SELECT * FROM user_model_usage_daily WHERE user_id = #{userId} " +
            "AND model_id = #{modelId} AND scene_type = #{sceneType} AND stat_date = #{statDate}")
    UserModelUsageDaily findByUserModelSceneDate(@Param("userId") Long userId,
                                                  @Param("modelId") String modelId,
                                                  @Param("sceneType") String sceneType,
                                                  @Param("statDate") LocalDate statDate);

    @Insert("INSERT INTO user_model_usage_daily (user_id, model_id, scene_type, stat_date, " +
            "call_count, success_count, total_tokens, total_cost, avg_response_time) " +
            "VALUES (#{userId}, #{modelId}, #{sceneType}, #{statDate}, " +
            "#{callCount}, #{successCount}, #{totalTokens}, #{totalCost}, #{avgResponseTime}) " +
            "ON DUPLICATE KEY UPDATE call_count=VALUES(call_count), success_count=VALUES(success_count), " +
            "total_tokens=VALUES(total_tokens), total_cost=VALUES(total_cost), " +
            "avg_response_time=VALUES(avg_response_time)")
    int upsert(UserModelUsageDaily daily);

    @Select("SELECT model_id, scene_type, SUM(call_count) as call_count, SUM(success_count) as success_count, " +
            "SUM(total_tokens) as total_tokens, SUM(total_cost) as total_cost, " +
            "CAST(AVG(avg_response_time) AS SIGNED) as avg_response_time " +
            "FROM user_model_usage_daily " +
            "WHERE user_id = #{userId} AND stat_date >= #{since} " +
            "GROUP BY model_id, scene_type")
    List<UserModelUsageDaily> getUsageStats(@Param("userId") Long userId, @Param("since") LocalDate since);
}
