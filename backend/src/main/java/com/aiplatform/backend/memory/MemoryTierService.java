package com.aiplatform.backend.memory;

import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 记忆分层策略服务（五层模型 + 轻量级语义搜索 + 容量/生命周期管理）。
 *
 * 设计要点（与 ES/Milvus 解耦的轻量方案）：
 *  - 层级：layer 字段（L1-L4）+ 自动定级
 *  - 搜索：MySQL FULLTEXT ngram（中文分词）作为 L3 语义检索的轻量替代；失败回退 LIKE
 *  - 生命周期：压缩审计（L1 超预算下沉 L2）+ 定时归档（30/60 天规则）
 *  - VFS：virtual_path 字段作为 Agent/前端与物理存储的解耦键
 *
 * 见 docs/memory_layered_architecture.md
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MemoryTierService {

    private final MemoryDocumentMapper documentMapper;
    private final MemoryIndexMapper indexMapper;
    private final MemoryArchiveMapper archiveMapper;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    // =========================================================
    // 定级 & 虚拟路径
    // =========================================================

    /** 基于文档当前字段计算层级并回写到实体（不落库，由调用方 save） */
    public void applyTier(MemoryDocument doc) {
        if (doc.getLayer() == null || doc.getLayer().isBlank()) {
            doc.setLayer(MemoryLayer.assignLayer(doc.getDocType(), doc.getTitle(), doc.getCategory(), doc.getImportance()));
        }
        if (doc.getVirtualPath() == null || doc.getVirtualPath().isBlank()) {
            doc.setVirtualPath(MemoryLayer.virtualPathFor(doc.getLayer(), doc.getConversationId(), doc.getTitle()));
        }
        if (doc.getAccessCount() == null) doc.setAccessCount(0);
    }

    /** 记录一次访问（注入到上下文时调用） */
    public void recordAccess(Long docId) {
        if (docId == null) return;
        try {
            documentMapper.touchAccess(docId);
        } catch (Exception e) {
            log.warn("[Tier] 记录访问失败 docId={}: {}", docId, e.getMessage());
        }
    }

    // =========================================================
    // 轻量级语义搜索（替代 Milvus）
    // =========================================================

    /**
     * 轻量级语义搜索：优先 FULLTEXT ngram，失败回退 LIKE 关键词。
     * 合并文档表与索引表的命中，按相关性（近似：importance + 命中索引）去重排序。
     */
    public List<MemoryDocument> semanticSearch(Long userId, String query, int limit) {
        if (query == null || query.isBlank()) return List.of();
        int cap = (limit <= 0) ? 20 : limit;

        // 1) 文档全文
        Set<Long> seen = new LinkedHashSet<>();
        List<MemoryDocument> merged = new ArrayList<>();
        try {
            List<MemoryDocument> docs = documentMapper.fullTextSearch(userId, query, null, cap);
            for (MemoryDocument d : docs) {
                if (seen.add(d.getId())) merged.add(d);
            }
        } catch (Exception e) {
            log.warn("[Tier] FULLTEXT 文档搜索不可用，回退 LIKE: {}", e.getMessage());
        }

        // 2) 索引摘要/标签全文 → 关联文档
        try {
            List<MemoryIndex> idxHits = indexMapper.fullTextSearch(userId, query, null, cap);
            for (MemoryIndex idx : idxHits) {
                MemoryDocument d = documentMapper.selectById(idx.getDocId());
                if (d != null && d.getDeleted() != null && d.getDeleted() == 0 && seen.add(d.getId())) {
                    merged.add(d);
                }
            }
        } catch (Exception e) {
            log.warn("[Tier] FULLTEXT 索引搜索不可用，回退 LIKE: {}", e.getMessage());
        }

        // 3) 若 FULLTEXT 都没命中，回退 LIKE（关键词）
        if (merged.isEmpty()) {
            QueryWrapper<MemoryDocument> qw = new QueryWrapper<MemoryDocument>()
                    .eq("user_id", userId).eq("deleted", 0)
                    .and(w -> w.like("title", query).or().like("content", query))
                    .orderByDesc("importance").last("LIMIT " + cap);
            merged.addAll(documentMapper.selectList(qw));
        }

        // 按重要性粗排（FULLTEXT 相关性已在 SQL 内排序，这里仅做索引命中补偿）
        merged.sort((a, b) -> Integer.compare(
                b.getImportance() != null ? b.getImportance() : 3,
                a.getImportance() != null ? a.getImportance() : 3));
        return merged.stream().limit(cap).collect(Collectors.toList());
    }

    // =========================================================
    // L1 压缩审计（容量管理）
    // =========================================================

    /**
     * 压缩审计：L1 内容总字节数 ≥ 阈值（12KB，即 15KB 预算的 80%）时，
     * 将近 14 天未访问的非核心 L1 项降级为 L2，逐条降级直到回到阈值以下。
     * 返回被降级的文档数。
     */
    @Transactional
    public int compressionAudit(Long userId) {
        // 拉取所有 L1 文档
        List<MemoryDocument> l1Docs = documentMapper.selectList(new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("layer", MemoryLayer.L1).eq("deleted", 0));

        // 计算 L1 内容总字节数
        long totalBytes = 0;
        for (MemoryDocument d : l1Docs) {
            if (d.getContent() != null) totalBytes += d.getContent().length();
        }
        if (totalBytes < MemoryLayer.L1_BUDGET_THRESHOLD_BYTES) return 0;

        // 按 access_count 升序 + importance 升序（最不重要的排前面，优先降级）
        l1Docs.sort((a, b) -> {
            int ac = Integer.compare(
                    a.getAccessCount() != null ? a.getAccessCount() : 0,
                    b.getAccessCount() != null ? b.getAccessCount() : 0);
            if (ac != 0) return ac;
            return Integer.compare(
                    a.getImportance() != null ? a.getImportance() : 3,
                    b.getImportance() != null ? b.getImportance() : 3);
        });

        LocalDateTime recencyCutoff = LocalDateTime.now().minusDays(MemoryLayer.COMPRESSION_RECENCY_DAYS);
        int demoted = 0;

        for (MemoryDocument d : l1Docs) {
            if (totalBytes < MemoryLayer.L1_BUDGET_THRESHOLD_BYTES) break;

            // 保护核心类型：user_profile / secret 始终 L1，不降级
            if ("user_profile".equals(d.getDocType()) || "secret".equals(d.getDocType())) continue;

            // 14 天 recency 保护：近期被访问过 → 跳过
            if (d.getLastAccessedAt() != null && d.getLastAccessedAt().isAfter(recencyCutoff)) continue;

            int contentLen = (d.getContent() != null) ? d.getContent().length() : 0;
            d.setLayer(MemoryLayer.L2);
            d.setVirtualPath(MemoryLayer.virtualPathFor(MemoryLayer.L2, d.getConversationId(), d.getTitle()));
            documentMapper.updateById(d);
            demoted++;
            totalBytes -= contentLen;
        }

        if (demoted > 0) log.info("[Tier] 压缩审计降级 L1→L2: userId={}, demoted={}, remainingBytes={}", userId, demoted, totalBytes);
        return demoted;
    }

    // =========================================================
    // L2/L3 → L4 归档（定时任务）
    // =========================================================

    /**
     * 归档任务：扫描 L2/L3 且长期未访问的文档。
     *  - 30 天未访问 → status='archived'（保留内容，仅不主动注入）
     *  - 60 天未访问 → 内容下沉 memory_archive，原文档置为 L4 + 摘要指针
     * 返回处理文档数。
     */
    @Transactional
    public int archiveJob() {
        int processed = 0;

        // 60 天硬性归档：内容下沉
        List<MemoryDocument> hard = documentMapper.selectList(new QueryWrapper<MemoryDocument>()
                .in("layer", MemoryLayer.L2, MemoryLayer.L3)
                .eq("status", "active").eq("deleted", 0)
                .apply("COALESCE(last_accessed_at, updated_at) < DATE_SUB(NOW(), INTERVAL " + MemoryLayer.ARCHIVE_HARD_DAYS + " DAY)"));
        for (MemoryDocument d : hard) {
            sinkToArchive(d);
            processed++;
        }

        // 30 天软归档：仅标记（若尚未下沉）
        List<MemoryDocument> soft = documentMapper.selectList(new QueryWrapper<MemoryDocument>()
                .in("layer", MemoryLayer.L2, MemoryLayer.L3)
                .eq("status", "active").eq("deleted", 0)
                .apply("COALESCE(last_accessed_at, updated_at) < DATE_SUB(NOW(), INTERVAL " + MemoryLayer.ARCHIVE_SOFT_DAYS + " DAY)"));
        for (MemoryDocument d : soft) {
            if ("L4".equals(d.getLayer())) continue; // 已下沉
            d.setStatus("archived");
            documentMapper.updateById(d);
            processed++;
        }

        if (processed > 0) log.info("[Tier] 归档任务处理文档数={}", processed);
        return processed;
    }

    private void sinkToArchive(MemoryDocument d) {
        MemoryArchive a = new MemoryArchive();
        a.setUserId(d.getUserId());
        a.setSourceDocId(d.getId());
        a.setTitle(d.getTitle());
        a.setDocType(d.getDocType());
        a.setCategory(d.getCategory());
        a.setContent(d.getContent());
        a.setTags(d.getTags());
        a.setLayerFrom(d.getLayer());
        a.setArchivedAt(LocalDateTime.now());
        a.setRestoreKey(UUID.randomUUID().toString());
        archiveMapper.insert(a);

        // 原文档仅留摘要指针
        String summary = (d.getContent() != null && d.getContent().length() > 200)
                ? d.getContent().substring(0, 200) + "..." : d.getContent();
        d.setContent("# 已归档\n\n> 内容已于 " + LocalDateTime.now().format(FMT)
                + " 下沉至 L4 归档（restore_key=" + a.getRestoreKey() + "）。\n\n摘要：\n" + (summary != null ? summary : ""));
        d.setLayer(MemoryLayer.L4);
        d.setStatus("archived");
        d.setVirtualPath(MemoryLayer.virtualPathFor(MemoryLayer.L4, d.getConversationId(), d.getTitle()));
        documentMapper.updateById(d);

        // 同步索引层级
        MemoryIndex idx = indexMapper.selectOne(new QueryWrapper<MemoryIndex>()
                .eq("doc_id", d.getId()).eq("user_id", d.getUserId()).eq("deleted", 0)
                .orderByDesc("id").last("LIMIT 1"));
        if (idx != null) {
            idx.setLayer(MemoryLayer.L4);
            idx.setVirtualPath(d.getVirtualPath());
            indexMapper.updateById(idx);
        }
    }

    /**
     * 从归档恢复：把内容拉回原文档（恢复为 L2）。
     */
    @Transactional
    public boolean restoreFromArchive(Long archiveId) {
        MemoryArchive a = archiveMapper.selectById(archiveId);
        if (a == null) return false;
        MemoryDocument d = documentMapper.selectById(a.getSourceDocId());
        if (d == null) {
            // 原文档已不存在，则新建一条 L2 文档
            d = new MemoryDocument();
            d.setUuid(UUID.randomUUID().toString());
            d.setUserId(a.getUserId());
            d.setDocType(a.getDocType() != null ? a.getDocType() : "project_memory");
            d.setTitle(a.getTitle());
            d.setCategory(a.getCategory());
            d.setTags(a.getTags());
            d.setImportance(3);
            d.setStatus("active");
        }
        d.setContent(a.getContent());
        d.setLayer(MemoryLayer.L2);
        d.setStatus("active");
        d.setVirtualPath(MemoryLayer.virtualPathFor(MemoryLayer.L2, d.getConversationId(), d.getTitle()));
        if (d.getId() == null) documentMapper.insert(d); else documentMapper.updateById(d);
        archiveMapper.deleteById(archiveId);
        log.info("[Tier] 从归档恢复: archiveId={}, docId={}", archiveId, d.getId());
        return true;
    }

    // =========================================================
    // 分层统计
    // =========================================================

    public Map<String, Object> tierStats(Long userId) {
        Map<String, Object> stats = new LinkedHashMap<>();
        for (String layer : List.of(MemoryLayer.L1, MemoryLayer.L2, MemoryLayer.L3, MemoryLayer.L4)) {
            long c = documentMapper.selectCount(new QueryWrapper<MemoryDocument>()
                    .eq("user_id", userId).eq("layer", layer).eq("deleted", 0));
            stats.put(layer, c);
        }
        long archived = documentMapper.selectCount(new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("status", "archived").eq("deleted", 0));
        long sinked = archiveMapper.selectCount(new QueryWrapper<MemoryArchive>().eq("user_id", userId));
        stats.put("archived_status", archived);
        stats.put("archive_table_rows", sinked);
        stats.put("l1_budget_bytes", MemoryLayer.L1_BUDGET_BYTES);
        stats.put("l1_threshold_bytes", MemoryLayer.L1_BUDGET_THRESHOLD_BYTES);
        stats.put("recency_days", MemoryLayer.COMPRESSION_RECENCY_DAYS);
        return stats;
    }
}
