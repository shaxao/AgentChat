package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

/**
 * 对话记忆系统 DTO
 * 基于 Coze 记忆架构设计
 */
public class MemoryDTO {

    // ===== 基础设定 =====

    @Data
    public static class SettingVO {
        private Long id;
        private String settingKey;
        private String settingName;
        private String content;
        private Integer sortOrder;
        private String createdAt;
        private String updatedAt;
    }

    @Data
    public static class SettingRequest {
        private String settingKey;
        private String settingName;
        private String content;
        private Integer sortOrder;
    }

    // ===== 记忆文档 =====

    @Data
    public static class DocumentVO {
        private Long id;
        private String uuid;
        private String docType;
        private String title;
        private String content;
        private String category;
        private List<String> tags;
        private Integer importance;
        private String status;
        private String sourceConvUuid;
        private String expiresAt;
        private Long fileSize;
        private String fileType;
        private String ossUrl;
        private String createdAt;
        private String updatedAt;
        /** 关联的索引摘要 */
        private String indexSummary;
        /** 记忆层级 L1热/L2温/L3冷/L4归档 */
        private String layer;
        /** VFS 虚拟路径 */
        private String virtualPath;
    }

    @Data
    public static class DocumentRequest {
        private String uuid;           // 更新时用
        private String docType;
        private String title;
        private String content;
        private String category;
        private List<String> tags;     // 前端发数组，后端存逗号分隔
        private Integer importance;
        private String status;
        private String expiresAt;
    }

    // ===== 记忆索引 =====

    @Data
    public static class IndexVO {
        private Long id;
        private Long docId;
        private String category;
        private String summary;
        private List<String> tags;
        private Integer importance;
        private String expiresAt;
        private String createdAt;
        private String updatedAt;
        /** 关联文档 UUID */
        private String docUuid;
        /** 关联文档类型 */
        private String docType;
        /** 记忆层级 */
        private String layer;
        /** VFS 虚拟路径 */
        private String virtualPath;
    }

    @Data
    public static class IndexRequest {
        private Long docId;
        private String category;
        private String summary;
        private List<String> tags;
        private Integer importance;
        private String expiresAt;
    }

    // ===== 工作文件 =====

    @Data
    public static class WorkFileVO {
        private Long id;
        private String uuid;
        private String fileName;
        private String fileType;       // image/document/spreadsheet/audio/video/skill/other
        private Long fileSize;
        private String mimeType;
        private String ossUrl;
        private String thumbUrl;
        private String description;
        private List<String> tags;
        private String createdAt;
        /** 是否已关联记忆文档 */
        private Boolean hasDoc;
        private String docUuid;
    }

    // ===== 记忆上下文注入 =====

    @Data
    public static class MemoryContext {
        /** 角色定义 */
        private String soul;
        /** 工具使用技巧 */
        private String tools;
        /** 行为规则 */
        private String rules;
        /** 对话记忆摘要 */
        private String conversationMemory;
        /** 用户画像 */
        private String userProfile;
        /** 当前对话的工作文件列表 */
        private List<String> conversationFiles;
        /** Current conversation work index content (WORK.md). */
        private String workIndex;
        /** 相关技能/项目记忆列表 */
        private List<SkillMemoryItem> relevantSkills;
        /** 最近工作流执行结果摘要（P2-2） */
        private String workflowResults;
        /** 知识图谱上下文（P3-1） */
        private String graphContext;
        /** 全文注入文本（用于 system prompt 拼接） */
        private String injectedSystemPrompt;
    }

    @Data
    public static class SkillMemoryItem {
        private String title;
        private String summary;
        private String content;
        private List<String> tags;
    }

    // ===== 文件树（前端面板用） =====

    @Data
    public static class FileTreeNode {
        private String key;            // 唯一路径标识
        private String title;          // 显示名称
        private String type;           // folder / file
        private String fileType;       // markdown/json/image/... (文件类型)
        private String docType;        // 文档类型（memory 内部用）
        private String docId;          // 关联文档 ID（用于加载内容）
        private String icon;           // 图标名称
        private String layer;          // 记忆层级（L1-L4），前端徽标展示
        private String virtualPath;    // VFS 虚拟路径
        private List<FileTreeNode> children;
        private Boolean isLeaf;
    }

    // ===== 搜索 =====

    @Data
    public static class SearchRequest {
        private String keyword;
        private String docType;
        private String category;
        private List<String> tags;
        private Integer page;
        private Integer size;
    }

    @Data
    public static class SearchResult {
        private List<DocumentVO> documents;
        private List<IndexVO> indexes;
        private long total;
        private int page;
        private int size;
    }

    // ===== 记忆统计（P1-4 记忆可视化） =====

    @Data
    public static class MemoryStatsVO {
        private long totalDocs;              // 总记忆文档数
        private long preferences;            // 用户偏好数（user_profile）
        private long projectMemories;        // 项目记忆数（project_memory）
        private long conversationMemories;   // 对话记忆数（conversation_summary）
        private long skillMemories;          // 技能记忆数（skill_memory）
        private long workFiles;              // 工作文件数
        private long indexes;                // 记忆索引数
        private String lastUpdated;          // 最近更新时间
        private java.util.Map<String, Long> byCategory;  // 按类别统计
    }
}
