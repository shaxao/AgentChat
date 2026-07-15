package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.WorkflowExecution;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface WorkflowExecutionMapper extends BaseMapper<WorkflowExecution> {
}
