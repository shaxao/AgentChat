package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.UserModelPreference;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.*;

import java.util.List;

/**
 * 用户模型偏好 Mapper
 */
@Mapper
public interface UserModelPreferenceMapper extends BaseMapper<UserModelPreference> {

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId} AND model_id = #{modelId} AND scene_type = #{sceneType}")
    UserModelPreference findByUserModelScene(@Param("userId") Long userId,
                                              @Param("modelId") String modelId,
                                              @Param("sceneType") String sceneType);

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId}")
    List<UserModelPreference> findByUserId(@Param("userId") Long userId);

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId} AND model_id = #{modelId}")
    List<UserModelPreference> findByUserIdAndModel(@Param("userId") Long userId,
                                                    @Param("modelId") String modelId);

    @Select("SELECT * FROM user_model_preference WHERE user_id = #{userId} AND scene_type = #{sceneType}")
    List<UserModelPreference> findByUserIdAndScene(@Param("userId") Long userId,
                                                    @Param("sceneType") String sceneType);

    @Insert("INSERT INTO user_model_preference (user_id, model_id, scene_type, preference_weight, usage_count, " +
            "like_count, dislike_count, avg_response_time, last_used_at, source, created_at, updated_at) " +
            "VALUES (#{userId}, #{modelId}, #{sceneType}, #{preferenceWeight}, #{usageCount}, " +
            "#{likeCount}, #{dislikeCount}, #{avgResponseTime}, #{lastUsedAt}, #{source}, NOW(), NOW()) " +
            "ON DUPLICATE KEY UPDATE preference_weight=VALUES(preference_weight), usage_count=VALUES(usage_count), " +
            "like_count=VALUES(like_count), dislike_count=VALUES(dislike_count), " +
            "avg_response_time=VALUES(avg_response_time), last_used_at=VALUES(last_used_at), " +
            "source=VALUES(source), updated_at=NOW()")
    int upsert(UserModelPreference pref);

    @Delete("<script>" +
            "DELETE FROM user_model_preference WHERE user_id = #{userId}" +
            "<if test='sceneType != null'> AND scene_type = #{sceneType}</if>" +
            "</script>")
    int deleteByUserAndScene(@Param("userId") Long userId, @Param("sceneType") String sceneType);
}
