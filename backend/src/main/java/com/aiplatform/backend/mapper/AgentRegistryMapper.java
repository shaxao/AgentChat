package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.AgentRegistry;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface AgentRegistryMapper extends BaseMapper<AgentRegistry> {

    /**
     * 调试用：绕过 @TableLogic 过滤，返回所有记录（包括 deleted=1）
     */
    @Select("SELECT * FROM agent_registry WHERE created_by = #{userId} ORDER BY created_at DESC")
    List<AgentRegistry> selectRawByCreator(@Param("userId") Long userId);

    /**
     * 物理删除已逻辑删除的记录（deleted=1），释放 agent_id 唯一约束
     */
    @Delete("DELETE FROM agent_registry WHERE agent_id = #{agentId} AND deleted = 1")
    int physicallyDeleteSoftDeleted(@Param("agentId") String agentId);
}
