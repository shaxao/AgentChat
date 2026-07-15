package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.SysRole;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

/**
 * RBAC 角色 Mapper
 */
@Mapper
public interface SysRoleMapper extends BaseMapper<SysRole> {
}
