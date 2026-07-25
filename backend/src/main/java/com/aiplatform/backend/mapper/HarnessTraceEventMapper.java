package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.HarnessTraceEvent;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Mapper
public interface HarnessTraceEventMapper extends BaseMapper<HarnessTraceEvent> {
    @Select("SELECT COALESCE(MAX(seq), 0) FROM harness_trace_event WHERE trace_id = #{traceId}")
    Integer selectMaxSeq(Long traceId);

    /**
     * Aggregate tool_result outcomes grouped by the owning trace's harness_version. The event table
     * has no harness_version column, so we join back to harness_trace. When {@code surface} is null
     * the filter is relaxed to all surfaces.
     */
    @Select("""
            SELECT t.harness_version                                        AS version,
                   SUM(e.event_name = 'tool_result')                        AS toolResults,
                   SUM(e.event_name = 'tool_result' AND e.status = 'error') AS toolErrors
            FROM harness_trace_event e
            JOIN harness_trace t ON t.id = e.trace_id
            WHERE (#{surface} IS NULL OR t.surface = #{surface})
              AND t.created_at >= #{since}
              AND t.harness_version IS NOT NULL AND t.harness_version <> ''
            GROUP BY t.harness_version
            """)
    List<Map<String, Object>> aggregateToolOutcomesByVersion(@Param("surface") String surface,
                                                             @Param("since") LocalDateTime since);
}
