package com.aiplatform.backend.mapper;

import com.aiplatform.backend.entity.MemoryDocument;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.List;

@Mapper
public interface MemoryDocumentMapper extends BaseMapper<MemoryDocument> {

    /**
     * 轻量级语义搜索（MySQL FULLTEXT + ngram 解析器，支持中文）。
     * 仅当 memory_document 上存在 ft_doc_content 索引时可用；调用方需 catch 异常回退到 LIKE。
     * 返回结果按 相关性*重要性 加权排序。
     */
    @Select("<script>" +
            "SELECT *, MATCH(title, content) AGAINST(#{query} IN NATURAL LANGUAGE MODE) AS relevance " +
            "FROM memory_document " +
            "WHERE user_id = #{userId} AND deleted = 0 " +
            "  AND MATCH(title, content) AGAINST(#{query} IN NATURAL LANGUAGE MODE) &gt; 0 " +
            "<if test='layer != null and layer != \"\"'>" +
            "  AND layer = #{layer} " +
            "</if>" +
            "ORDER BY (relevance * (1 + IFNULL(importance,3) * 0.1)) DESC " +
            "LIMIT #{limit}" +
            "</script>")
    List<MemoryDocument> fullTextSearch(@Param("userId") Long userId,
                                         @Param("query") String query,
                                         @Param("layer") String layer,
                                         @Param("limit") int limit);

    /** 记录访问：自增 access_count 并更新 last_accessed_at */
    @Update("UPDATE memory_document SET access_count = IFNULL(access_count,0) + 1, " +
            "last_accessed_at = NOW() WHERE id = #{docId} AND deleted = 0")
    int touchAccess(@Param("docId") Long docId);
}
