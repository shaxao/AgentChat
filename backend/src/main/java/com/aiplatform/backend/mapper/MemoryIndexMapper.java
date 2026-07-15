package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.MemoryIndex;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface MemoryIndexMapper extends BaseMapper<MemoryIndex> {

    /**
     * 轻量级语义搜索（索引摘要/标签，MySQL FULLTEXT + ngram）。
     * 调用方需 catch 异常回退到 LIKE。
     */
    @Select("<script>" +
            "SELECT *, MATCH(summary, tags) AGAINST(#{query} IN NATURAL LANGUAGE MODE) AS relevance " +
            "FROM memory_index " +
            "WHERE user_id = #{userId} AND deleted = 0 " +
            "  AND MATCH(summary, tags) AGAINST(#{query} IN NATURAL LANGUAGE MODE) &gt; 0 " +
            "<if test='layer != null and layer != \"\"'>" +
            "  AND layer = #{layer} " +
            "</if>" +
            "ORDER BY (relevance * (1 + IFNULL(importance,3) * 0.1)) DESC " +
            "LIMIT #{limit}" +
            "</script>")
    List<MemoryIndex> fullTextSearch(@Param("userId") Long userId,
                                      @Param("query") String query,
                                      @Param("layer") String layer,
                                      @Param("limit") int limit);
}
