package com.aiplatform.backend.memory;

/**
 * 五层记忆模型常量与定级/路径助手。
 * 对应 docs/memory_layered_architecture.md。
 *
 * <pre>
 * L0 工作记忆  → LLM 上下文窗口（不落库）
 * L1 热记忆    → user_profile / secret / SOUL.md，每次对话注入
 * L2 温记忆    → MEMORY.md / 项目记忆 / 技能记忆
 * L3 冷记忆    → 低频访问的基础/项目记忆，仍可被 FULLTEXT 检索
 * L4 归档      → memory_archive，内容下沉，原表留摘要指针
 * </pre>
 */
public final class MemoryLayer {

    public static final String L0 = "L0";
    public static final String L1 = "L1";
    public static final String L2 = "L2";
    public static final String L3 = "L3";
    public static final String L4 = "L4";

    /** L1 容量预算（字节），超过阈值触发压缩审计。提案：≤15KB，阈值 80% = 12KB */
    public static final int L1_BUDGET_BYTES = 15_000;
    public static final int L1_BUDGET_THRESHOLD_BYTES = 12_000;  // 80%

    /** 压缩审计：仅降级近 N 天未访问的文档（提案 14 天 recency） */
    public static final int COMPRESSION_RECENCY_DAYS = 14;

    /** 归档阈值（天）：超过该天数未访问 → 标记 archived */
    public static final int ARCHIVE_SOFT_DAYS = 30;

    /** 归档阈值（天）：超过该天数未访问 → 内容下沉 L4 */
    public static final int ARCHIVE_HARD_DAYS = 60;

    private MemoryLayer() {
    }

    /**
     * 根据文档类型/标题/分类/重要性自动定级。
     */
    public static String assignLayer(String docType, String title, String category, Integer importance) {
        if (docType == null) return L2;
        if ("user_profile".equals(docType) || "secret".equals(docType)) return L1;
        if ("conversation_summary".equals(docType) && "SOUL.md".equals(title)) return L1;
        if ("work_file_meta".equals(docType)) return L4;
        int imp = (importance != null) ? importance : 3;
        // 低重要性且非基础文件 → 冷层
        if (imp <= 2 && !"conversation_summary".equals(docType)) return L3;
        return L2;
    }

    /**
     * 生成 VFS 虚拟路径（轻量文件抽象层）。
     */
    public static String virtualPathFor(String layer, Long conversationId, String title) {
        String root = switch (layer == null ? L2 : layer) {
            case L1 -> "/memory/hot";
            case L2 -> "/memory/warm";
            case L3 -> "/memory/cold";
            case L4 -> "/archive";
            default -> "/memory/warm";
        };
        String scope = (conversationId != null) ? String.valueOf(conversationId) : "global";
        String safeTitle = (title == null) ? "untitled" : title.replace(' ', '_');
        return root + "/" + scope + "/" + safeTitle;
    }
}
