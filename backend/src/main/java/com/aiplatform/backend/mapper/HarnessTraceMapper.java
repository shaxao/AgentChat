package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.HarnessTrace;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Mapper
public interface HarnessTraceMapper extends BaseMapper<HarnessTrace> {

    /**
     * Aggregate trace metrics grouped by harness_version for a surface within a time window.
     * When {@code surface} is null the filter is relaxed to all surfaces.
     */
    @Select("""
            SELECT harness_version                            AS version,
                   COUNT(*)                                   AS total,
                   SUM(status = 'success')                    AS successCount,
                   SUM(status = 'failed')                     AS failedCount,
                   SUM(status = 'running')                    AS runningCount,
                   AVG(NULLIF(latency_ms, 0))                 AS avgLatencyMs,
                   SUM(COALESCE(input_tokens, 0))             AS inputTokens,
                   SUM(COALESCE(output_tokens, 0))            AS outputTokens
            FROM harness_trace
            WHERE (#{surface} IS NULL OR surface = #{surface})
              AND created_at >= #{since}
              AND harness_version IS NOT NULL AND harness_version <> ''
            GROUP BY harness_version
            """)
    List<Map<String, Object>> aggregateByVersion(@Param("surface") String surface,
                                                  @Param("since") LocalDateTime since);
}
