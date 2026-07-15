package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.aiplatform.backend.memory.MemoryTierService;
import com.aiplatform.backend.service.AiService.AiResult;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 对话记忆系统核心服务
 * 基于 Coze 记忆架构设计，实现完整的记忆读写与检索逻辑
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MemoryService {

    private final MemorySettingMapper settingMapper;
    private final MemoryDocumentMapper documentMapper;
    private final MemoryIndexMapper indexMapper;
    private final MemoryWorkFileMapper workFileMapper;
    private final WorkflowExecutionMapper workflowExecutionMapper;
    private final WorkflowMapper workflowMapper;
    private final AiService aiService;
    private final KnowledgeGraphService knowledgeGraphService;
    private final UsageTrackingService usageTrackingService;
    private final MemoryTierService tierService;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    private String buildDefaultUserSystemPrompt(Long userId, String profileContent) {
        return "请根据用户长期画像调整回答方式：\n"
                + "1. 优先尊重用户显式要求，其次参考长期画像。\n"
                + "2. 区分稳定偏好和当前任务，不要过度推断。\n"
                + "3. 回答风格贴合用户的表达习惯、专业背景和决策方式。\n"
                + "4. 当画像信息不足或冲突时，先用当前对话事实，不要假装了解用户。\n\n"
                + "当前画像摘要会由系统随对话动态注入。";
    }

    // =============================================
    // 1. 基础设定（对应 Coze 基础设定/ 目录）
    // =============================================

    public List<MemoryDTO.SettingVO> listSettings() {
        return settingMapper.selectList(
                new QueryWrapper<MemorySetting>().eq("deleted", 0).orderByAsc("sort_order")
        ).stream().map(this::toSettingVO).collect(Collectors.toList());
    }

    public MemoryDTO.SettingVO getSetting(String settingKey) {
        MemorySetting s = settingMapper.selectOne(
                new QueryWrapper<MemorySetting>().eq("setting_key", settingKey).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        return s == null ? null : toSettingVO(s);
    }

    @Transactional
    public MemoryDTO.SettingVO saveSetting(MemoryDTO.SettingRequest req) {
        MemorySetting s = settingMapper.selectOne(
                new QueryWrapper<MemorySetting>().eq("setting_key", req.getSettingKey()).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (s == null) {
            s = new MemorySetting();
            s.setSettingKey(req.getSettingKey());
            s.setSettingName(req.getSettingName() != null ? req.getSettingName() : req.getSettingKey());
            s.setContent(req.getContent());
            s.setSortOrder(req.getSortOrder() != null ? req.getSortOrder() : 0);
            settingMapper.insert(s);
        } else {
            if (req.getSettingName() != null) s.setSettingName(req.getSettingName());
            if (req.getContent() != null) s.setContent(req.getContent());
            if (req.getSortOrder() != null) s.setSortOrder(req.getSortOrder());
            settingMapper.updateById(s);
        }
        return toSettingVO(s);
    }

    @Transactional
    public MemoryDTO.DocumentVO getOrCreateUserProfile(Long userId) {
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "user_profile")
                        .isNull("conversation_id")
                        .eq("deleted", 0)
                        .orderByDesc("updated_at")
                        .last("LIMIT 1"));
        if (doc != null) return toDocumentVO(doc);

        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setDocType("user_profile");
        req.setTitle("USER.md");
        req.setCategory("user_profile");
        req.setImportance(5);
        req.setContent(buildDefaultUserProfile(userId));
        return saveDocument(userId, req);
    }

    @Transactional
    public MemoryDTO.DocumentVO saveUserProfile(Long userId, String content) {
        MemoryDTO.DocumentVO existing = getOrCreateUserProfile(userId);
        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setUuid(existing.getUuid());
        req.setDocType("user_profile");
        req.setTitle("USER.md");
        req.setCategory("user_profile");
        req.setImportance(5);
        req.setContent(content != null ? content : "");
        return saveDocument(userId, req);
    }

    @Transactional
    public MemoryDTO.DocumentVO getUserSystemPrompt(Long userId) {
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "user_system_prompt")
                        .isNull("conversation_id")
                        .eq("deleted", 0)
                        .orderByDesc("updated_at")
                        .last("LIMIT 1"));
        if (doc != null) return toDocumentVO(doc);

        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setDocType("user_system_prompt");
        req.setTitle("USER_SYSTEM_PROMPT.md");
        req.setCategory("user_profile");
        req.setImportance(5);
        req.setContent(buildDefaultUserSystemPrompt(userId, getOrCreateUserProfile(userId).getContent())
                + "\n\n## Persona Challenge Policy\n"
                + "- Cold start: ask one lightweight, task-relevant preference question when helpful; never interrogate the user.\n"
                + "- Preference drift: if current instructions conflict with old profile, follow the current turn and ask a brief confirmation.\n"
                + "- Inference control: treat one-off requests as temporary until repeated or explicitly confirmed.\n"
                + "- Privacy: minimize sensitive profile use and respect user edits/deletion.");
        return saveDocument(userId, req);
    }

    @Transactional
    public MemoryDTO.DocumentVO saveUserSystemPrompt(Long userId, String content) {
        MemoryDTO.DocumentVO existing = getUserSystemPrompt(userId);
        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setUuid(existing.getUuid());
        req.setDocType("user_system_prompt");
        req.setTitle("USER_SYSTEM_PROMPT.md");
        req.setCategory("user_profile");
        req.setImportance(5);
        req.setContent(content != null ? content : "");
        return saveDocument(userId, req);
    }

    @Transactional
    public void forgetUserProfile(Long userId) {
        List<MemoryDocument> docs = documentMapper.selectList(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .in("doc_type", "user_profile", "user_system_prompt")
                        .isNull("conversation_id")
                        .eq("deleted", 0));
        for (MemoryDocument doc : docs) {
            documentMapper.deleteById(doc.getId());
        }
    }

    @Transactional
    public void deleteSetting(String settingKey) {
        MemorySetting s = settingMapper.selectOne(
                new QueryWrapper<MemorySetting>().eq("setting_key", settingKey).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (s != null) settingMapper.deleteById(s.getId());
    }

    // =============================================
    // 2. 记忆文档（对应 MEMORY.md / USER.md / SECRET.md / project/*.md）
    // =============================================

    /** 获取用户的记忆文档列表（支持按类型/分类/对话筛选） */
    public List<MemoryDTO.DocumentVO> listDocuments(Long userId, String docType, String category, Long conversationId) {
        QueryWrapper<MemoryDocument> qw = new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("deleted", 0);
        if (docType != null && !docType.isEmpty()) qw.eq("doc_type", docType);
        if (category != null && !category.isEmpty()) qw.eq("category", category);
        if (conversationId != null) qw.eq("conversation_id", conversationId);
        qw.orderByDesc("importance").orderByDesc("updated_at");

        return documentMapper.selectList(qw).stream()
                .map(this::toDocumentVO)
                .collect(Collectors.toList());
    }

    /** 根据 UUID 获取文档详情 */
    public MemoryDTO.DocumentVO getDocument(Long userId, String uuid) {
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>().eq("uuid", uuid).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (doc == null) throw new RuntimeException("文档不存在");
        return toDocumentVO(doc);
    }

    /** 根据标题获取对话专属文档（用于记忆工具 memory_read_document） */
    public MemoryDTO.DocumentVO getDocumentByTitle(Long userId, Long conversationId, String title) {
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId).eq("conversation_id", conversationId)
                        .eq("title", title).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        return doc != null ? toDocumentVO(doc) : null;
    }

    /** 搜索文档（按关键词匹配标题和内容），支持对话范围过滤 */
    public List<MemoryDTO.DocumentVO> searchDocuments(Long userId, Long conversationId, String query) {
        QueryWrapper<MemoryDocument> qw = new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("deleted", 0);
        if (conversationId != null) {
            qw.eq("conversation_id", conversationId);
        }
        qw.and(w -> w.like("title", query).or().like("content", query));
        qw.orderByDesc("importance").orderByDesc("updated_at");
        return documentMapper.selectList(qw).stream()
                .map(this::toDocumentVO)
                .collect(Collectors.toList());
    }

    /** 创建或更新记忆文档（按 title + conversation_id 匹配，用于记忆工具） */
    @Transactional
    public MemoryDTO.DocumentVO saveDocument(Long userId, Long conversationId, MemoryDTO.DocumentRequest req) {
        // 先查找是否已有同标题的文档
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId).eq("conversation_id", conversationId)
                        .eq("title", req.getTitle()).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));

        if (doc != null) {
            // 更新已有
            if (req.getContent() != null) doc.setContent(req.getContent());
            if (req.getDocType() != null) doc.setDocType(req.getDocType());
            if (req.getCategory() != null) doc.setCategory(req.getCategory());
            if (req.getTags() != null) doc.setTags(String.join(",", req.getTags()));
            if (req.getImportance() != null) doc.setImportance(req.getImportance());
            tierService.applyTier(doc);
            documentMapper.updateById(doc);
            log.info("[Memory] 更新文档: title={}, conversationId={}, contentLen={}", req.getTitle(), conversationId,
                    req.getContent() != null ? req.getContent().length() : 0);
        } else {
            // 新建
            doc = new MemoryDocument();
            doc.setUuid(UUID.randomUUID().toString());
            doc.setUserId(userId);
            doc.setConversationId(conversationId);
            doc.setTitle(req.getTitle());
            doc.setContent(req.getContent());
            doc.setDocType(req.getDocType() != null ? req.getDocType() : "conversation_summary");
            doc.setCategory(req.getCategory());
            doc.setTags(req.getTags() != null ? String.join(",", req.getTags()) : null);
            doc.setImportance(req.getImportance() != null ? req.getImportance() : 3);
            doc.setStatus("active");
            tierService.applyTier(doc);
            documentMapper.insert(doc);
            log.info("[Memory] 创建文档: title={}, conversationId={}, contentLen={}", req.getTitle(), conversationId,
                    req.getContent() != null ? req.getContent().length() : 0);
        }

        return toDocumentVO(doc);
    }

    /** 创建或更新记忆文档 */
    @Transactional
    public MemoryDTO.DocumentVO saveDocument(Long userId, MemoryDTO.DocumentRequest req) {
        return saveDocument(userId, req, null);
    }

    /** 创建或更新记忆文档（可指定来源对话 uuid） */
    @Transactional
    public MemoryDTO.DocumentVO saveDocument(Long userId, MemoryDTO.DocumentRequest req, String sourceConvUuid) {
        MemoryDocument doc;
        if (req.getUuid() != null && !req.getUuid().isEmpty()) {
            // 更新已有文档
            doc = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>().eq("uuid", req.getUuid()).eq("user_id", userId).eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (doc == null) throw new RuntimeException("文档不存在: " + req.getUuid());
        } else {
            // 新建文档
            doc = new MemoryDocument();
            doc.setUuid(UUID.randomUUID().toString());
            doc.setUserId(userId);
            doc.setSourceConvUuid(sourceConvUuid);
            doc.setStatus("active");
        }

        if (req.getDocType() != null) doc.setDocType(req.getDocType());
        if (req.getTitle() != null) doc.setTitle(req.getTitle());
        if (req.getContent() != null) doc.setContent(req.getContent());
        if (req.getCategory() != null) doc.setCategory(req.getCategory());
        if (req.getTags() != null) doc.setTags(String.join(",", req.getTags()));
        if (req.getImportance() != null) doc.setImportance(req.getImportance());
        if (req.getStatus() != null) doc.setStatus(req.getStatus());
        if (req.getExpiresAt() != null) doc.setExpiresAt(LocalDateTime.parse(req.getExpiresAt(), FMT));

        tierService.applyTier(doc);

        if (doc.getId() == null) {
            documentMapper.insert(doc);
        } else {
            documentMapper.updateById(doc);
        }

        // 同步更新或创建索引
        upsertIndex(userId, doc, req.getTags());

        log.info("[Memory] 保存文档: type={}, title={}, uuid={}", doc.getDocType(), doc.getTitle(), doc.getUuid());
        return toDocumentVO(doc);
    }

    @Transactional
    public void deleteDocument(Long userId, String uuid) {
        MemoryDocument doc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>().eq("uuid", uuid).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (doc != null) {
            documentMapper.deleteById(doc.getId());
            // 联动删除索引
            indexMapper.delete(new QueryWrapper<MemoryIndex>().eq("doc_id", doc.getId()));
        }
    }

    // =============================================
    // 3. 记忆索引（对应 index.json）
    // =============================================

    public List<MemoryDTO.IndexVO> listIndexes(Long userId, String category) {
        QueryWrapper<MemoryIndex> qw = new QueryWrapper<MemoryIndex>()
                .eq("user_id", userId).eq("deleted", 0)
                .orderByDesc("importance").orderByDesc("updated_at");
        if (category != null && !category.isEmpty()) qw.eq("category", category);
        return indexMapper.selectList(qw).stream()
                .map(idx -> toIndexVO(idx, null))
                .collect(Collectors.toList());
    }

    @Transactional
    public MemoryDTO.IndexVO saveIndex(Long userId, MemoryDTO.IndexRequest req) {
        MemoryIndex idx = indexMapper.selectOne(
                new QueryWrapper<MemoryIndex>().eq("doc_id", req.getDocId()).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (idx == null) {
            idx = new MemoryIndex();
            idx.setUserId(userId);
            idx.setDocId(req.getDocId());
        }
        if (req.getCategory() != null) idx.setCategory(req.getCategory());
        if (req.getSummary() != null) idx.setSummary(req.getSummary());
        if (req.getTags() != null) idx.setTags(String.join(",", req.getTags()));
        if (req.getImportance() != null) idx.setImportance(req.getImportance());
        if (req.getExpiresAt() != null) idx.setExpiresAt(LocalDateTime.parse(req.getExpiresAt(), FMT));

        if (idx.getId() == null) {
            indexMapper.insert(idx);
        } else {
            indexMapper.updateById(idx);
        }
        return toIndexVO(idx, null);
    }

    // =============================================
    // 4. 工作文件（对话中产生/上传的文件）
    // =============================================

    public List<MemoryDTO.WorkFileVO> listWorkFiles(Long userId, Long conversationId, String fileType) {
        QueryWrapper<MemoryWorkFile> qw = new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId).eq("deleted", 0)
                .orderByDesc("created_at");
        if (conversationId != null) qw.eq("conversation_id", conversationId);
        if (fileType != null && !fileType.isEmpty()) qw.eq("file_type", fileType);
        return workFileMapper.selectList(qw).stream()
                .map(this::toWorkFileVO)
                .collect(Collectors.toList());
    }

    @Transactional
    public MemoryDTO.WorkFileVO saveWorkFile(Long userId, Long conversationId,
                                              String fileName, String fileType, Long fileSize,
                                              String mimeType, String ossUrl, String thumbUrl) {
        MemoryWorkFile wf = new MemoryWorkFile();
        wf.setUuid(UUID.randomUUID().toString());
        wf.setUserId(userId);
        wf.setConversationId(conversationId);
        wf.setFileName(fileName);
        wf.setFileType(fileType);
        wf.setFileSize(fileSize);
        wf.setMimeType(mimeType);
        wf.setOssUrl(ossUrl);
        wf.setThumbUrl(thumbUrl);
        workFileMapper.insert(wf);

        // 同时创建 memory_document（元数据）
        MemoryDocument doc = new MemoryDocument();
        doc.setUuid(UUID.randomUUID().toString());
        doc.setUserId(userId);
        doc.setConversationId(conversationId);
        doc.setDocType("work_file_meta");
        doc.setTitle(fileName);
        doc.setCategory("work_file");
        doc.setFileSize(fileSize);
        doc.setFileType(fileType);
        doc.setOssUrl(ossUrl);
        doc.setImportance(2);
        doc.setStatus("active");
        doc.setContent(buildWorkFileMetadataContent(fileName, fileType, fileSize, mimeType, ossUrl, thumbUrl));
        tierService.applyTier(doc);
        documentMapper.insert(doc);
        upsertIndex(userId, doc, List.of("work_file", fileType != null ? fileType : "file"));

        // 关联
        wf.setDocId(doc.getId());
        workFileMapper.updateById(wf);

        log.info("[Memory] 保存工作文件: name={}, type={}, size={}", fileName, fileType, fileSize);
        return toWorkFileVO(wf);
    }

    private String buildWorkFileMetadataContent(String fileName, String fileType, Long fileSize,
                                                String mimeType, String ossUrl, String thumbUrl) {
        StringBuilder sb = new StringBuilder();
        sb.append("# ").append(fileName != null ? fileName : "未命名文件").append("\n\n");
        sb.append("- type: ").append(fileType != null ? fileType : "unknown").append("\n");
        sb.append("- size: ").append(fileSize != null ? fileSize : 0).append(" bytes\n");
        if (mimeType != null && !mimeType.isBlank()) sb.append("- mime: ").append(mimeType).append("\n");
        if (ossUrl != null && !ossUrl.isBlank()) sb.append("- oss_url: ").append(ossUrl).append("\n");
        if (thumbUrl != null && !thumbUrl.isBlank()) sb.append("- thumb_url: ").append(thumbUrl).append("\n");
        return sb.toString();
    }

    @Transactional
    public void deleteWorkFile(Long userId, Long fileId) {
        MemoryWorkFile wf = workFileMapper.selectById(fileId);
        if (wf != null && wf.getUserId().equals(userId)) {
            workFileMapper.deleteById(fileId);
            if (wf.getDocId() != null) {
                documentMapper.deleteById(wf.getDocId());
            }
        }
    }

    // =============================================
    // 5. 文件树（前端面板用，模拟 Coze 界面）
    // =============================================

    /**
     * 构建文件树结构，模拟 Coze 的右侧面板
     * 树结构：
     *   - 工作文件/
     *     - {项目A}/  (仅当 conversationId==null 时按项目分组)
     *       - 按类型分组（图片/文档/表格/技能/其他）
     *   - 记忆/
     *     - 基础设定/
     *       - SOUL.md / TOOLS.md / RULES.md
     *     - 对话记忆/
     *       - MEMORY.md / USER.md
     *     - 项目记忆/
     *       - {文档列表}
     *
     * @param userId         用户ID
     * @param conversationId 可选：按项目过滤（null 时显示所有项目）
     */
    public List<MemoryDTO.FileTreeNode> buildFileTree(Long userId, Long conversationId) {
        List<MemoryDTO.FileTreeNode> roots = new ArrayList<>();

        // --- 根节点 A: 工作文件 ---
        MemoryDTO.FileTreeNode workFilesNode = new MemoryDTO.FileTreeNode();
        workFilesNode.setKey("work_files");
        workFilesNode.setTitle("工作文件");
        workFilesNode.setType("folder");
        workFilesNode.setIcon("folder");

        // 子分组：按文件类型
        Map<String, List<MemoryDTO.FileTreeNode>> typeGroups = new LinkedHashMap<>();
        typeGroups.put("image", new ArrayList<>());
        typeGroups.put("document", new ArrayList<>());
        typeGroups.put("spreadsheet", new ArrayList<>());
        typeGroups.put("skill", new ArrayList<>());
        typeGroups.put("other", new ArrayList<>());

        QueryWrapper<MemoryWorkFile> wfQw = new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId).eq("deleted", 0);
        if (conversationId != null) {
            wfQw.eq("conversation_id", conversationId);
        }
        wfQw.orderByDesc("created_at");

        List<MemoryWorkFile> workFiles = workFileMapper.selectList(wfQw);
        for (MemoryWorkFile wf : workFiles) {
            MemoryDTO.FileTreeNode leaf = new MemoryDTO.FileTreeNode();
            leaf.setKey("wf_" + wf.getId());
            leaf.setTitle(wf.getFileName());
            leaf.setType("file");
            leaf.setFileType(wf.getFileType());
            leaf.setIsLeaf(true);
            leaf.setIcon(getFileIcon(wf.getFileType(), wf.getMimeType()));

            String group = typeGroups.containsKey(wf.getFileType()) ? wf.getFileType() : "other";
            typeGroups.get(group).add(leaf);
        }

        // 构建文件夹子节点
        List<MemoryDTO.FileTreeNode> wfChildren = new ArrayList<>();
        Map<String, String> groupNames = new LinkedHashMap<>();
        groupNames.put("image", "图片");
        groupNames.put("document", "文件");
        groupNames.put("spreadsheet", "表格");
        groupNames.put("skill", "技能");
        groupNames.put("other", "其他");
        for (Map.Entry<String, List<MemoryDTO.FileTreeNode>> entry : typeGroups.entrySet()) {
            if (!entry.getValue().isEmpty()) {
                MemoryDTO.FileTreeNode groupNode = new MemoryDTO.FileTreeNode();
                groupNode.setKey("wf_group_" + entry.getKey());
                groupNode.setTitle(groupNames.get(entry.getKey()));
                groupNode.setType("folder");
                groupNode.setIcon("folder");
                groupNode.setChildren(entry.getValue());
                groupNode.setIsLeaf(false);
                wfChildren.add(groupNode);
            }
        }
        workFilesNode.setChildren(wfChildren);
        workFilesNode.setIsLeaf(false);
        roots.add(workFilesNode);

        // --- 根节点 B: 记忆 ---
        MemoryDTO.FileTreeNode memoryNode = new MemoryDTO.FileTreeNode();
        memoryNode.setKey("memory");
        memoryNode.setTitle("记忆");
        memoryNode.setType("folder");
        memoryNode.setIcon("folder");

        List<MemoryDTO.FileTreeNode> memChildren = new ArrayList<>();

        // B1: 基础设定
        MemoryDTO.FileTreeNode settingsNode = new MemoryDTO.FileTreeNode();
        settingsNode.setKey("mem_settings");
        settingsNode.setTitle("基础设定");
        settingsNode.setType("folder");
        settingsNode.setIcon("folder");
        List<MemoryDTO.FileTreeNode> settingLeaves = new ArrayList<>();
        for (MemorySetting s : settingMapper.selectList(
                new QueryWrapper<MemorySetting>().eq("deleted", 0).orderByAsc("sort_order"))) {
            MemoryDTO.FileTreeNode leaf = new MemoryDTO.FileTreeNode();
            leaf.setKey("setting_" + s.getSettingKey());
            leaf.setTitle(s.getSettingKey().toUpperCase() + ".md");
            leaf.setType("file");
            leaf.setFileType("markdown");
            leaf.setDocType("setting");
            leaf.setDocId("setting:" + s.getSettingKey());
            leaf.setIsLeaf(true);
            leaf.setIcon("file-text");
            settingLeaves.add(leaf);
        }
        settingsNode.setChildren(settingLeaves);
        settingsNode.setIsLeaf(false);
        memChildren.add(settingsNode);

        // B2: 对话记忆（按项目过滤）
        List<MemoryDTO.FileTreeNode> convLeaves = new ArrayList<>();
        QueryWrapper<MemoryDocument> convQw = new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("deleted", 0)
                .in("doc_type", "conversation_summary", "user_profile", "secret");
        if (conversationId != null) {
            convQw.eq("conversation_id", conversationId);
        }
        convQw.orderByDesc("updated_at");
        List<MemoryDocument> convDocs = documentMapper.selectList(convQw);
        for (MemoryDocument doc : convDocs) {
            MemoryDTO.FileTreeNode leaf = new MemoryDTO.FileTreeNode();
            leaf.setKey("doc_" + doc.getUuid());
            leaf.setTitle(doc.getTitle());
            leaf.setType("file");
            leaf.setFileType("markdown");
            leaf.setDocType(doc.getDocType());
            leaf.setDocId(doc.getUuid());
            leaf.setIsLeaf(true);
            leaf.setIcon(doc.getDocType().equals("secret") ? "shield" : "file-text");
            leaf.setLayer(doc.getLayer());
            leaf.setVirtualPath(doc.getVirtualPath());
            convLeaves.add(leaf);
        }
        MemoryDTO.FileTreeNode convDocNode = new MemoryDTO.FileTreeNode();
        convDocNode.setKey("mem_conversation");
        convDocNode.setTitle("对话记忆");
        convDocNode.setType("folder");
        convDocNode.setIcon("folder");
        convDocNode.setChildren(convLeaves);
        convDocNode.setIsLeaf(false);
        memChildren.add(convDocNode);

        // B3: 项目记忆（按项目分组）
        MemoryDTO.FileTreeNode projectNode = new MemoryDTO.FileTreeNode();
        projectNode.setKey("mem_projects");
        projectNode.setTitle("项目记忆");
        projectNode.setType("folder");
        projectNode.setIcon("folder");
        List<MemoryDTO.FileTreeNode> projectLeaves = new ArrayList<>();
        QueryWrapper<MemoryDocument> projQw = new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("deleted", 0)
                .in("doc_type", "project_memory", "skill_memory");
        if (conversationId != null) {
            projQw.eq("conversation_id", conversationId);
        }
        projQw.orderByDesc("importance").orderByDesc("updated_at");
        List<MemoryDocument> projDocs = documentMapper.selectList(projQw);
        for (MemoryDocument doc : projDocs) {
            MemoryDTO.FileTreeNode leaf = new MemoryDTO.FileTreeNode();
            leaf.setKey("doc_" + doc.getUuid());
            leaf.setTitle(doc.getTitle());
            leaf.setType("file");
            leaf.setFileType("markdown");
            leaf.setDocType(doc.getDocType());
            leaf.setDocId(doc.getUuid());
            leaf.setIsLeaf(true);
            leaf.setIcon("code");
            leaf.setLayer(doc.getLayer());
            leaf.setVirtualPath(doc.getVirtualPath());
            projectLeaves.add(leaf);
        }
        projectNode.setChildren(projectLeaves);
        projectNode.setIsLeaf(false);
        memChildren.add(projectNode);

        memoryNode.setChildren(memChildren);
        memoryNode.setIsLeaf(false);
        roots.add(memoryNode);

        return roots;
    }

    // =============================================
    // 6. 搜索
    // =============================================

    public MemoryDTO.SearchResult search(Long userId, MemoryDTO.SearchRequest req) {
        int page = req.getPage() != null ? req.getPage() : 1;
        int size = req.getSize() != null ? req.getSize() : 20;

        // 文档搜索
        QueryWrapper<MemoryDocument> docQw = new QueryWrapper<MemoryDocument>()
                .eq("user_id", userId).eq("deleted", 0);
        if (req.getDocType() != null) docQw.eq("doc_type", req.getDocType());
        if (req.getCategory() != null) docQw.eq("category", req.getCategory());
        if (req.getKeyword() != null && !req.getKeyword().isEmpty()) {
            docQw.and(w -> w.like("title", req.getKeyword()).or().like("content", req.getKeyword()));
        }
        if (req.getTags() != null && !req.getTags().isEmpty()) {
            for (String tag : req.getTags()) {
                docQw.like("tags", tag);
            }
        }
        docQw.orderByDesc("importance").orderByDesc("updated_at");

        Page<MemoryDocument> docPage = new Page<>(page, size);
        Page<MemoryDocument> docResult = documentMapper.selectPage(docPage, docQw);

        // 索引搜索
        QueryWrapper<MemoryIndex> idxQw = new QueryWrapper<MemoryIndex>()
                .eq("user_id", userId).eq("deleted", 0);
        if (req.getCategory() != null) idxQw.eq("category", req.getCategory());
        if (req.getKeyword() != null && !req.getKeyword().isEmpty()) {
            idxQw.and(w -> w.like("summary", req.getKeyword()).or().like("tags", req.getKeyword()));
        }
        idxQw.orderByDesc("importance");

        List<MemoryIndex> idxResult = indexMapper.selectList(idxQw);

        MemoryDTO.SearchResult result = new MemoryDTO.SearchResult();
        result.setDocuments(docResult.getRecords().stream().map(this::toDocumentVO).collect(Collectors.toList()));
        result.setIndexes(idxResult.stream().map(idx -> toIndexVO(idx, null)).collect(Collectors.toList()));
        result.setTotal(docResult.getTotal());
        result.setPage(page);
        result.setSize(size);
        return result;
    }

    /**
     * 轻量级语义搜索（VO 版）：委托 MemoryTierService，返回 DocumentVO 列表。
     * 内部已对 FULLTEXT 失败做 LIKE 回退。
     */
    public List<MemoryDTO.DocumentVO> semanticSearch(Long userId, String query, int limit) {
        return tierService.semanticSearch(userId, query, limit).stream()
                .map(this::toDocumentVO)
                .collect(Collectors.toList());
    }

    // =============================================
    // 7. 记忆上下文注入（对话开始时自动注入）
    // =============================================

    /**
     * 构建记忆上下文，用于对话开始时注入 system prompt
     * 注入策略（对应 Coze 的三层记忆架构）：
     *   L1 基础设定 → 直接注入
     *   L2 对话记忆 → 注入摘要和用户画像
     *   L3 项目记忆 → 注入索引（标题+摘要），不注入全文
     */
    public MemoryDTO.MemoryContext buildMemoryContext(Long userId, Long conversationId) {
        return buildMemoryContext(userId, conversationId, null);
    }

    public MemoryDTO.MemoryContext buildMemoryContext(Long userId, Long conversationId, String currentQuery) {
        MemoryDTO.MemoryContext ctx = new MemoryDTO.MemoryContext();

        // L1: 基础设定 — 优先读对话专属 SOUL.md，回退到全局 setting
        if (conversationId != null) {
            MemoryDocument soulDoc = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>()
                            .eq("user_id", userId).eq("conversation_id", conversationId)
                            .eq("title", "SOUL.md").eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (soulDoc != null && soulDoc.getContent() != null && !soulDoc.getContent().isBlank()) {
                ctx.setSoul(soulDoc.getContent());
                tierService.recordAccess(soulDoc.getId());
            }
        }
        // 回退：全局记忆设定
        if (ctx.getSoul() == null) {
            MemorySetting soul = settingMapper.selectOne(
                    new QueryWrapper<MemorySetting>().eq("setting_key", "soul").eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (soul != null) ctx.setSoul(soul.getContent());
        }

        // 全局工具/规则设定
        MemorySetting tools = settingMapper.selectOne(
                new QueryWrapper<MemorySetting>().eq("setting_key", "tools").eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (tools != null) ctx.setTools(tools.getContent());

        MemorySetting rules = settingMapper.selectOne(
                new QueryWrapper<MemorySetting>().eq("setting_key", "rules").eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (rules != null) ctx.setRules(rules.getContent());

        // L2: 对话记忆 — 读取 MEMORY.md（对话专属）
        if (conversationId != null) {
            MemoryDocument memDoc = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>()
                            .eq("user_id", userId).eq("conversation_id", conversationId)
                            .eq("title", "MEMORY.md").eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (memDoc != null && memDoc.getContent() != null && !memDoc.getContent().isBlank()) {
                ctx.setConversationMemory(memDoc.getContent());
                tierService.recordAccess(memDoc.getId());
            }
        }

        // L2: 用户画像 — 优先读对话专属 USER.md，回退到全局
        if (conversationId != null) {
            MemoryDocument userDoc = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>()
                            .eq("user_id", userId).eq("conversation_id", conversationId)
                            .eq("title", "USER.md").eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (userDoc != null && userDoc.getContent() != null && !userDoc.getContent().isBlank()) {
                ctx.setUserProfile(userDoc.getContent());
                tierService.recordAccess(userDoc.getId());
            }
        }
        if (ctx.getUserProfile() == null) {
            MemoryDocument globalProfile = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>()
                            .eq("user_id", userId).eq("doc_type", "user_profile")
                            .isNull("conversation_id").eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            if (globalProfile != null) {
                ctx.setUserProfile(globalProfile.getContent());
                tierService.recordAccess(globalProfile.getId());
            }
        }
        MemoryDocument userPrompt = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId).eq("doc_type", "user_system_prompt")
                        .isNull("conversation_id").eq("deleted", 0)
                        .orderByDesc("updated_at")
                        .last("LIMIT 1"));
        if (userPrompt != null && userPrompt.getContent() != null && !userPrompt.getContent().isBlank()) {
            ctx.setUserProfile((ctx.getUserProfile() != null ? ctx.getUserProfile() + "\n\n" : "")
                    + "## 用户系统提示词\n" + userPrompt.getContent().trim());
            tierService.recordAccess(userPrompt.getId());
        }

        // L2: 工作文件索引 — 告诉 LLM 有哪些文件可用
        if (conversationId != null) {
            List<MemoryWorkFile> workFiles = workFileMapper.selectList(
                    new QueryWrapper<MemoryWorkFile>()
                            .eq("user_id", userId).eq("conversation_id", conversationId)
                            .eq("deleted", 0));
            if (!workFiles.isEmpty()) {
                List<String> fileList = workFiles.stream()
                        .map(f -> {
                            String base = f.getFileName() + " (" + f.getFileType() + ", " + f.getFileSize() + " bytes)";
                            if (f.getOssUrl() != null && !f.getOssUrl().isBlank()) {
                                base += " [URL: " + f.getOssUrl() + "]";
                            }
                            return base;
                        })
                        .collect(Collectors.toList());
                ctx.setConversationFiles(fileList);
            }
        }

        // L3: 项目/技能记忆（仅注入索引摘要，不注入全文节省 token）
        if (conversationId != null) {
            MemoryDocument workDoc = documentMapper.selectOne(
                    new QueryWrapper<MemoryDocument>()
                            .eq("user_id", userId)
                            .eq("conversation_id", conversationId)
                            .eq("title", "WORK.md")
                            .eq("deleted", 0)
                            .orderByDesc("id")
                            .last("LIMIT 1"));
            if (workDoc != null && workDoc.getContent() != null && !workDoc.getContent().isBlank()) {
                ctx.setWorkIndex(workDoc.getContent());
            }
        }

        ctx.setRelevantSkills(buildRelevantMemoryItems(userId, conversationId, currentQuery));

        // P2-2: 注入最近工作流执行结果摘要
        ctx.setWorkflowResults(buildWorkflowResultsSummary(userId));

        // P3-1: 注入知识图谱上下文
        ctx.setGraphContext(buildKnowledgeGraphContext(userId));

        // 拼接注入文本
        ctx.setInjectedSystemPrompt(buildInjectedPrompt(ctx, conversationId));

        return ctx;
    }

    private List<MemoryDTO.SkillMemoryItem> buildRelevantMemoryItems(Long userId, Long conversationId, String currentQuery) {
        List<MemoryDTO.SkillMemoryItem> items = new ArrayList<>();
        Set<Long> seenDocIds = new LinkedHashSet<>();

        if (currentQuery != null && !currentQuery.isBlank()) {
            for (MemoryDocument doc : tierService.semanticSearch(userId, currentQuery, 8)) {
                if (doc == null || doc.getId() == null || !seenDocIds.add(doc.getId())) continue;
                if ("secret".equals(doc.getDocType())) continue;
                if ("SOUL.md".equalsIgnoreCase(doc.getTitle())) continue;
                if ("archived".equalsIgnoreCase(doc.getStatus())) continue;
                if (doc.getConversationId() != null && conversationId != null
                        && !doc.getConversationId().equals(conversationId)
                        && "conversation_summary".equals(doc.getDocType())) {
                    continue;
                }

                MemoryDTO.SkillMemoryItem item = new MemoryDTO.SkillMemoryItem();
                item.setTitle((doc.getCategory() != null ? doc.getCategory() : doc.getDocType())
                        + "/" + doc.getTitle());
                item.setSummary(buildDocSummary(doc));
                item.setContent(safeClip(cleanMarkdown(doc.getContent()), 360));
                item.setTags(doc.getTags() != null ? Arrays.asList(doc.getTags().split(",")) : List.of());
                items.add(item);
                tierService.recordAccess(doc.getId());
            }
        }

        if (items.size() < 8) {
            List<MemoryIndex> activeIndexes = indexMapper.selectList(
                    new QueryWrapper<MemoryIndex>()
                            .eq("user_id", userId).eq("deleted", 0)
                            .ge("importance", 3)
                            .orderByDesc("importance").orderByDesc("updated_at")
                            .last("LIMIT " + (8 - items.size())));
            for (MemoryIndex idx : activeIndexes) {
                if (idx == null || idx.getDocId() == null || !seenDocIds.add(idx.getDocId())) continue;
                MemoryDTO.SkillMemoryItem item = new MemoryDTO.SkillMemoryItem();
                item.setTitle((idx.getCategory() != null ? idx.getCategory() : "memory") + "/" + idx.getDocId());
                item.setSummary(idx.getSummary());
                item.setTags(idx.getTags() != null ? Arrays.asList(idx.getTags().split(",")) : List.of());
                items.add(item);
            }
        }

        return items;
    }

    private String buildDocSummary(MemoryDocument doc) {
        String prefix = doc.getTitle() != null ? doc.getTitle() + "：" : "";
        String content = cleanMarkdown(doc.getContent());
        if (content.isBlank()) return prefix + (doc.getCategory() != null ? doc.getCategory() : doc.getDocType());
        return prefix + safeClip(content, 180);
    }

    private String cleanMarkdown(String text) {
        if (text == null) return "";
        return text.replaceAll("#+\\s*", "")
                .replace("**", "")
                .replaceAll("\\s+", " ")
                .trim();
    }

    /**
     * 拼接记忆注入文本，嵌入到系统提示中
     */
    private String buildInjectedPrompt(MemoryDTO.MemoryContext ctx, Long conversationId) {
        StringBuilder sb = new StringBuilder();

        // ─── 记忆工作区指引（告诉 LLM 可以使用记忆 API 管理文件）───
        if (conversationId != null) {
            sb.append("## 记忆工作区\n\n");
            sb.append("本对话拥有独立的记忆空间，包含以下可由你管理的文件：\n\n");
            sb.append("- **SOUL.md** — 角色设定，定义你的行为和能力边界\n");
            sb.append("- **MEMORY.md** — 对话记忆，记录关键决策和上下文，由你自动维护\n");
            sb.append("- **USER.md** — 用户画像，记录用户偏好和习惯\n");
            sb.append("- **WORK.md** — 工作文件索引，列出本对话中上传的所有文件\n\n");
            sb.append("你可以使用以下记忆 API 来读写这些文件：\n");
            sb.append("- `memory_get_document(title)` — 读取指定记忆文件内容\n");
            sb.append("- `memory_save_document(title, content)` — 保存/更新记忆文件\n");
            sb.append("- `memory_search_documents(query)` — 搜索记忆文档\n\n");
            sb.append("**重要规则**：\n");
            sb.append("1. 每次对话的关键决策应自动更新到 MEMORY.md\n");
            sb.append("2. 发现用户偏好/习惯时应更新 USER.md\n");
            sb.append("3. 用户上传文件后应更新 WORK.md 索引\n");
            sb.append("4. SOUL.md 是只读参考，不应修改\n\n");
        }

        if (ctx.getSoul() != null && !ctx.getSoul().isBlank()) {
            sb.append("## 角色设定\n").append(ctx.getSoul().trim()).append("\n\n");
        }
        if (ctx.getRules() != null && !ctx.getRules().isBlank()) {
            sb.append("## 行为规则\n").append(ctx.getRules().trim()).append("\n\n");
        }
        if (ctx.getTools() != null && !ctx.getTools().isBlank()) {
            sb.append("## 工具使用技巧\n").append(ctx.getTools().trim()).append("\n\n");
        }
        if (ctx.getUserProfile() != null && !ctx.getUserProfile().isBlank()) {
            sb.append("## 用户信息\n").append(ctx.getUserProfile().trim()).append("\n\n");
        }
        if (ctx.getUserProfile() != null && !ctx.getUserProfile().isBlank()) {
            sb.append("## Persona Adaptation Policy\n");
            sb.append("- Cold start: if the profile is sparse, ask at most one lightweight, task-relevant preference question when it helps the task.\n");
            sb.append("- Preference drift: if the current turn conflicts with old profile evidence, follow the current turn and briefly confirm the change.\n");
            sb.append("- Inference control: do not treat a one-off request as a stable preference unless repeated or explicitly confirmed.\n");
            sb.append("- Privacy: use profile data only to improve this conversation, minimize sensitive details, and respect user edits or deletion.\n\n");
        }
        if (ctx.getConversationMemory() != null && !ctx.getConversationMemory().isBlank()) {
            sb.append("## 对话记忆\n").append(ctx.getConversationMemory().trim()).append("\n\n");
        }
        if (ctx.getConversationFiles() != null && !ctx.getConversationFiles().isEmpty()) {
            sb.append("## 已上传文件\n");
            for (String file : ctx.getConversationFiles()) {
                sb.append("- ").append(file).append("\n");
            }
            sb.append("\n");
        }
        if (ctx.getWorkIndex() != null && !ctx.getWorkIndex().isBlank()) {
            sb.append("## WORK.md\n").append(ctx.getWorkIndex().trim()).append("\n\n");
        }
        if (ctx.getRelevantSkills() != null && !ctx.getRelevantSkills().isEmpty()) {
            sb.append("## 相关记忆召回\n");
            sb.append("以下内容来自 L2/L3 记忆与文件索引，是按当前问题召回的参考信息；如与用户当前表达冲突，以当前表达为准。\n");
            for (MemoryDTO.SkillMemoryItem item : ctx.getRelevantSkills()) {
                sb.append("- **").append(item.getTitle()).append("**：").append(item.getSummary()).append("\n");
                if (item.getContent() != null && !item.getContent().isBlank()) {
                    sb.append("  片段：").append(item.getContent()).append("\n");
                }
            }
            sb.append("\n");
        }
        if (ctx.getWorkflowResults() != null && !ctx.getWorkflowResults().isBlank()) {
            sb.append("## 最近工作流执行结果\n");
            sb.append(ctx.getWorkflowResults().trim()).append("\n\n");
        }
        if (ctx.getGraphContext() != null && !ctx.getGraphContext().isBlank()) {
            sb.append(ctx.getGraphContext().trim()).append("\n\n");
        }

        // P1-4: 主动提醒 — 告诉 AI 可以在回复中主动提及记住的信息
        boolean hasMemoryContext = (ctx.getUserProfile() != null && !ctx.getUserProfile().isBlank())
                || (ctx.getConversationMemory() != null && !ctx.getConversationMemory().isBlank());
        if (hasMemoryContext) {
            sb.append("## 主动提醒\n");
            sb.append("你已经从之前的对话中了解到关于用户的一些信息（见上方「用户信息」和「对话记忆」）。\n");
            sb.append("在回复时，如果相关信息有用或自然，请**主动提及**。例如：\n");
            sb.append("- 如果用户之前提到过偏好，你可以在推荐时提及「我记得你喜欢...」\n");
            sb.append("- 如果用户之前处理过类似任务，你可以提及「上次我们处理XX时...」\n");
            sb.append("- 如果用户有项目正在进行，你可以询问进展\n\n");
            sb.append("**重要**：不要生硬地插入这些信息，而是在合适的时机**自然地提及**。\n");
            sb.append("如果用户问「你记得我上次...？」，请使用 `memory_search_documents` 工具搜索相关记忆并回答。\n\n");
        }

        return sb.toString();
    }

    // =============================================
    // 8. 对话记忆初始化（创建对话时自动调用）
    // 基于 Coze 架构：每个对话独立项目空间，自动初始化基础记忆文件
    // =============================================

    /**
     * 创建对话时自动初始化记忆文档。
     * 为每个对话建立独立的记忆空间，预置基础文件：
     *   - SOUL.md    — 角色设定（来自 Agent systemPrompt 或默认值）
     *   - MEMORY.md  — 对话记忆（空白，对话过程中由 AI 填充）
     *   - USER.md    — 用户画像（首次使用全局模板，后续对话继承）
     *   - WORK.md    — 工作文件索引（空白，文件上传时自动更新）
     *
     * @param userId         用户 ID
     * @param conversationId 对话 database ID
     * @param convUuid       对话 UUID（用于 sourceConvUuid 关联）
     * @param agentId        可选的 Agent ID（如已选择 Agent，用其 systemPrompt 初始化 SOUL）
     */
    @Transactional
    public void initializeConversationMemory(Long userId, Long conversationId,
                                               String convUuid, String agentId) {
        log.info("[Memory] 初始化对话记忆, userId={}, conversationId={}, convUuid={}, agentId={}",
                userId, conversationId, convUuid, agentId);

        // 1. SOUL.md — 角色设定
        String soulContent = buildDefaultSoul(agentId);
        MemoryDocument soulDoc = new MemoryDocument();
        soulDoc.setUuid(UUID.randomUUID().toString());
        soulDoc.setUserId(userId);
        soulDoc.setConversationId(conversationId);
        soulDoc.setDocType("conversation_summary");  // 归类为对话记忆
        soulDoc.setTitle("SOUL.md");
        soulDoc.setContent(soulContent);
        soulDoc.setCategory("base_setting");
        soulDoc.setTags("soul,role,agent");
        soulDoc.setImportance(5);
        soulDoc.setStatus("active");
        soulDoc.setSourceConvUuid(convUuid);
        tierService.applyTier(soulDoc);
        documentMapper.insert(soulDoc);
        upsertIndex(userId, soulDoc, List.of("soul", "role"));
        log.info("[Memory] SOUL.md 已创建, convUuid={}", convUuid);

        // 2. MEMORY.md — 对话记忆（空白，后续 AI 自动填充）
        MemoryDocument memDoc = new MemoryDocument();
        memDoc.setUuid(UUID.randomUUID().toString());
        memDoc.setUserId(userId);
        memDoc.setConversationId(conversationId);
        memDoc.setDocType("conversation_summary");
        memDoc.setTitle("MEMORY.md");
        memDoc.setContent("# 对话记忆\n\n> 此文件记录本对话的关键决策与信息，由 AI 自动维护。\n\n暂无内容。");
        memDoc.setCategory("conversation");
        memDoc.setTags("memory,conversation");
        memDoc.setImportance(4);
        memDoc.setStatus("active");
        memDoc.setSourceConvUuid(convUuid);
        tierService.applyTier(memDoc);
        documentMapper.insert(memDoc);
        log.info("[Memory] MEMORY.md 已创建, convUuid={}", convUuid);

        // 3. USER.md — 用户画像
        // 先查全局用户画像作为模板
        String userProfileContent = buildDefaultUserProfile(userId);
        MemoryDocument userDoc = new MemoryDocument();
        userDoc.setUuid(UUID.randomUUID().toString());
        userDoc.setUserId(userId);
        userDoc.setConversationId(conversationId);
        userDoc.setDocType("user_profile");
        userDoc.setTitle("USER.md");
        userDoc.setContent(userProfileContent);
        userDoc.setCategory("user_profile");
        userDoc.setTags("user,profile");
        userDoc.setImportance(3);
        userDoc.setStatus("active");
        userDoc.setSourceConvUuid(convUuid);
        tierService.applyTier(userDoc);
        documentMapper.insert(userDoc);
        log.info("[Memory] USER.md 已创建, convUuid={}", convUuid);

        // 4. WORK.md — 工作文件索引
        MemoryDocument workDoc = new MemoryDocument();
        workDoc.setUuid(UUID.randomUUID().toString());
        workDoc.setUserId(userId);
        workDoc.setConversationId(conversationId);
        workDoc.setDocType("project_memory");
        workDoc.setTitle("WORK.md");
        workDoc.setContent("# 工作文件索引\n\n> 上传到本对话的文件会自动在此记录。\n\n暂无文件。");
        workDoc.setCategory("work_file_index");
        workDoc.setTags("work,files,index");
        workDoc.setImportance(2);
        workDoc.setStatus("active");
        workDoc.setSourceConvUuid(convUuid);
        tierService.applyTier(workDoc);
        documentMapper.insert(workDoc);
        log.info("[Memory] WORK.md 已创建, convUuid={}", convUuid);

        log.info("[Memory] 对话记忆初始化完成, conversationId={}", conversationId);
    }

    // =============================================
    // 9. 工作流执行结果摘要（P2-2）
    // =============================================

    /**
     * 构建最近工作流执行结果摘要，用于注入 system prompt
     * 读取用户最近 5 条工作流执行记录，生成简洁摘要
     */
    private String buildWorkflowResultsSummary(Long userId) {
        try {
            List<WorkflowExecution> recentExecs = workflowExecutionMapper.selectList(
                    new QueryWrapper<WorkflowExecution>()
                            .eq("user_id", userId)
                            .eq("deleted", 0)
                            .orderByDesc("finished_at")
                            .last("LIMIT 5"));

            if (recentExecs == null || recentExecs.isEmpty()) {
                return null;
            }

            // 批量查询关联的工作流名称
            Set<Long> workflowIds = recentExecs.stream()
                    .map(WorkflowExecution::getWorkflowId)
                    .filter(Objects::nonNull)
                    .collect(Collectors.toSet());
            Map<Long, String> workflowNames = new HashMap<>();
            if (!workflowIds.isEmpty()) {
                List<Workflow> workflows = workflowMapper.selectBatchIds(workflowIds);
                for (Workflow wf : workflows) {
                    workflowNames.put(wf.getId(), wf.getName());
                }
            }

            StringBuilder sb = new StringBuilder();
            sb.append("以下是你最近执行的工作流结果，可以参考其中的结论和数据：\n\n");
            DateTimeFormatter briefFmt = DateTimeFormatter.ofPattern("MM-dd HH:mm");
            for (WorkflowExecution exec : recentExecs) {
                String wfName = workflowNames.getOrDefault(exec.getWorkflowId(), "未知工作流");
                String time = exec.getFinishedAt() != null
                        ? exec.getFinishedAt().format(briefFmt) : "未知时间";
                String statusEmoji = switch (exec.getStatus()) {
                    case "success" -> "✅";
                    case "failed" -> "❌";
                    case "running" -> "🔄";
                    default -> "⏸️";
                };

                sb.append("- ").append(statusEmoji).append(" **").append(wfName).append("**")
                        .append(" (").append(time).append(")");
                if (exec.getDurationMs() != null) {
                    sb.append(" 耗时 ").append(formatDuration(exec.getDurationMs()));
                }
                sb.append("\n");

                // 输出摘要
                if (exec.getOutputJson() != null && !exec.getOutputJson().isBlank()) {
                    String output = exec.getOutputJson();
                    // 截断过长的输出
                    if (output.length() > 200) {
                        output = output.substring(0, 200) + "...";
                    }
                    sb.append("  输出: ").append(output).append("\n");
                }
                if (exec.getErrorMsg() != null && !exec.getErrorMsg().isBlank()) {
                    String err = exec.getErrorMsg();
                    if (err.length() > 150) {
                        err = err.substring(0, 150) + "...";
                    }
                    sb.append("  错误: ").append(err).append("\n");
                }
            }
            return sb.toString();
        } catch (Exception e) {
            log.warn("[Memory] 构建工作流结果摘要失败: {}", e.getMessage());
            return null;
        }
    }

    private String formatDuration(int ms) {
        if (ms < 1000) return ms + "ms";
        if (ms < 60000) return String.format("%.1fs", ms / 1000.0);
        return String.format("%dm%ds", ms / 60000, (ms % 60000) / 1000);
    }

    /**
     * P3-1: 构建知识图谱上下文文本，注入到系统提示词
     */
    private String buildKnowledgeGraphContext(Long userId) {
        try {
            var ctx = knowledgeGraphService.buildGraphContext(userId);
            return (ctx != null && ctx.getText() != null && !ctx.getText().isBlank())
                    ? ctx.getText() : null;
        } catch (Exception e) {
            log.warn("[Memory] 构建知识图谱上下文失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 构建默认角色设定（SOUL.md 内容）
     */
    private String buildDefaultSoul(String agentId) {
        StringBuilder sb = new StringBuilder();
        sb.append("# 角色设定\n\n");
        sb.append("你是一个智能 AI 助手，能够理解和执行各种任务。\n\n");
        sb.append("## 核心能力\n\n");
        sb.append("- 阅读、创建和编辑文件\n");
        sb.append("- 运行代码和脚本\n");
        sb.append("- 搜索和分析数据\n");
        sb.append("- 生成报告和文档\n\n");
        sb.append("## 行为准则\n\n");
        sb.append("- 优先使用内置工具完成任务\n");
        sb.append("- 对不确定的信息主动确认\n");
        sb.append("- 对敏感操作给出警告\n");
        if (agentId != null && !agentId.isBlank()) {
            sb.append("\n## Agent 配置\n\n");
            sb.append("Agent ID: ").append(agentId).append("\n");
        }
        return sb.toString();
    }

    /**
     * 构建默认用户画像（USER.md 内容）
     */
    private String buildDefaultUserProfile(Long userId) {
        // 尝试复用已有的全局用户画像
        MemoryDocument existing = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId).eq("doc_type", "user_profile")
                        .isNull("conversation_id").eq("deleted", 0)
                        .orderByDesc("updated_at").last("LIMIT 1"));
        if (existing != null && existing.getContent() != null && !existing.getContent().isBlank()) {
            return existing.getContent();
        }
        return "# USER.md\n\n"
                + "> 长期用户画像。系统会基于 Query / Response / Action 信号持续融合，用户可随时查看和修改。\n\n"
                + "## 1. 身份与角色\n- 待观察\n\n"
                + "## 2. 行为模式\n- 待观察\n\n"
                + "## 3. 偏好与需求\n- 待观察\n\n"
                + "## 4. 认知与表达风格\n- 待观察\n\n"
                + "## 5. 决策模式\n- 待观察\n\n"
                + "## 6. 个性与价值取向\n- 待观察\n\n"
                + "## 临时标签\n- 用于记录一次性任务语境或短期偏好，不直接进入稳定画像。\n\n"
                + "## 稳定偏好\n- 至少两次一致信号或一次强显式表达后再沉淀。\n\n"
                + "## 偏好漂移与变化检测\n- 记录与旧画像冲突的新证据；必要时提示 AI 向用户自然确认。\n\n"
                + "## 主动验证建议\n- 当某维度置信度低时，记录可在自然对话中验证的问题方向，避免问卷式打扰。\n\n"
                + "## 隐私边界\n- 不记录密钥、支付、健康、身份证件、联系方式等高敏信息；用户可随时编辑或删除画像。\n\n"
                + "## 证据与置信度\n- 每条画像应尽量记录来源、时间和置信度，避免把一次性需求固化为长期特征。\n";
    }

    // =============================================
    // 10. 自动保存：技能/项目记忆
    // =============================================

    /**
     * 自动保存技能记忆（对话完成后调用）
     * 当用户在对话中创建了技能，AI 生成技能摘要后自动保存
     */
    @Transactional
    public MemoryDTO.DocumentVO autoSaveSkillMemory(Long userId, String convUuid,
                                                      String skillName, String summary, String content, List<String> tags) {
        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setDocType("skill_memory");
        req.setTitle(skillName);
        req.setCategory("skill");
        req.setContent(content);
        req.setTags(tags);
        req.setImportance(4);

        MemoryDTO.DocumentVO doc = saveDocument(userId, req, convUuid);

        // 同步创建索引
        MemoryDTO.IndexRequest idxReq = new MemoryDTO.IndexRequest();
        idxReq.setDocId(doc.getId());
        idxReq.setCategory("skill");
        idxReq.setSummary(summary);
        idxReq.setTags(tags);
        idxReq.setImportance(4);
        saveIndex(userId, idxReq);

        return doc;
    }

    /**
     * 自动保存项目记忆（项目完成后调用）
     */
    @Transactional
    public MemoryDTO.DocumentVO autoSaveProjectMemory(Long userId, String convUuid,
                                                       String projectName, String summary, String content, List<String> tags) {
        MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
        req.setDocType("project_memory");
        req.setTitle(projectName);
        req.setCategory("project");
        req.setContent(content);
        req.setTags(tags);
        req.setImportance(4);

        MemoryDTO.DocumentVO doc = saveDocument(userId, req, convUuid);

        MemoryDTO.IndexRequest idxReq = new MemoryDTO.IndexRequest();
        idxReq.setDocId(doc.getId());
        idxReq.setCategory("project");
        idxReq.setSummary(summary);
        idxReq.setTags(tags);
        idxReq.setImportance(4);
        saveIndex(userId, idxReq);

        return doc;
    }

    /**
     * 对话完成后自动更新记忆文件（MEMORY.md 和 WORK.md）
     * 优先使用 LLM 摘要，失败则降级为简单截断
     */
    public void autoUpdateConversationMemory(Long userId, Long conversationId,
            String userMessage, String assistantReply, List<String> fileNames,
            String convUuid) {
        autoUpdateConversationMemory(userId, conversationId, userMessage, assistantReply, fileNames, convUuid, null);
    }

    public void autoUpdateConversationMemory(Long userId, Long conversationId,
            String userMessage, String assistantReply, List<String> fileNames,
            String convUuid, String requestIp) {
        if (conversationId == null) return;

        String timestamp = java.time.LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"));

        // ── 1. 更新 MEMORY.md（优先使用 LLM 摘要）──
        try {
            String summaryEntry = summarizeWithLlm(userId, userMessage, assistantReply, timestamp, requestIp);

            MemoryDTO.DocumentRequest memReq = new MemoryDTO.DocumentRequest();
            memReq.setTitle("MEMORY.md");
            memReq.setDocType("conversation_memory");
            memReq.setCategory("memory");

            MemoryDTO.DocumentVO existingMem = getDocumentByTitle(userId, conversationId, "MEMORY.md");
            String existingContent = (existingMem != null && existingMem.getContent() != null)
                    ? existingMem.getContent() : "";

            // 清理初始空白占位符
            existingContent = existingContent
                    .replaceAll("暂无内容|暂无[^\\n]*\\n?", "").trim();

            String newContent = existingContent + summaryEntry;
            log.info("[Memory] 摘要更新 MEMORY.md: oldLen={}, newLen={}, summaryLen={}",
                    existingContent.length(), newContent.length(), summaryEntry.length());
            memReq.setContent(newContent);
            saveDocument(userId, conversationId, memReq);
        } catch (Exception e) {
            log.warn("[Memory] LLM 摘要失败，降级为简单截断: {}", e.getMessage());
            updateMemoryWithTruncation(userId, conversationId, userMessage, assistantReply, timestamp);
        }

        // ── 2. 如有文件，更新 WORK.md ──
        if (fileNames != null && !fileNames.isEmpty()) {
            try {
                MemoryDTO.DocumentRequest workReq = new MemoryDTO.DocumentRequest();
                workReq.setTitle("WORK.md");
                workReq.setDocType("work_index");
                workReq.setCategory("work");

                MemoryDTO.DocumentVO existingWork = getDocumentByTitle(userId, conversationId, "WORK.md");
                String workContent = (existingWork != null && existingWork.getContent() != null)
                        ? existingWork.getContent() : "";

                workContent = workContent
                        .replaceAll("暂无[^\\n]*\\n?", "").trim();

                int addedFiles = 0;
                for (String fileName : fileNames) {
                    if (fileName != null && !workContent.contains(fileName)) {
                        workContent += "\n- " + fileName + " (" + timestamp + ")";
                        addedFiles++;
                    }
                }

                if (addedFiles > 0) {
                    workReq.setContent(workContent.trim());
                    log.info("[Memory] 自动更新 WORK.md: addedFiles={}", addedFiles);
                    saveDocument(userId, conversationId, workReq);
                }
            } catch (Exception e) {
                log.warn("[Memory] 自动更新 WORK.md 失败: {}", e.getMessage());
            }
        }

        // ── 3. 异步提取知识图谱实体/关系（P3-1）──
        if (convUuid != null && !convUuid.isBlank()) {
            knowledgeGraphService.extractAndUpsertAsync(userId, convUuid, userMessage, assistantReply);
        }

        try {
            updateUserProfileFromTurn(userId, userMessage, assistantReply, timestamp);
        } catch (Exception e) {
            log.warn("[Memory] 更新长期用户画像失败: {}", e.getMessage());
        }
    }

    @Transactional
    public void updateUserProfileFromTurn(Long userId, String userMessage, String assistantReply, String timestamp) {
        MemoryDTO.DocumentVO profile = getOrCreateUserProfile(userId);
        String existing = profile.getContent() != null ? profile.getContent() : "";
        String next;
        try {
            next = mergeUserProfileWithLlm(userId, existing, userMessage, assistantReply, timestamp);
        } catch (Exception e) {
            log.warn("[Memory] LLM 融合用户画像失败，降级为证据追加: {}", e.getMessage());
            next = appendProfileEvidence(existing, userMessage, timestamp);
        }
        if (next != null && !next.isBlank() && !next.equals(existing)) {
            saveUserProfile(userId, next);
        }
    }

    private String mergeUserProfileWithLlm(Long userId, String existingProfile,
                                           String userMessage, String assistantReply, String timestamp) {
        String prompt = String.format(
                "请基于新的对话信号更新长期用户画像 USER.md。\n"
                        + "要求：\n"
                        + "1. 使用六层结构：身份与角色、行为模式、偏好与需求、认知与表达风格、决策模式、个性与价值取向。\n"
                        + "2. 冷启动：画像很少时允许放大前几次明确行为信号，但必须标注为“初始假设/待验证”。\n"
                        + "3. 偏好漂移：旧证据权重随时间降低；如果新信号和旧画像冲突，保留冲突记录并标注“可能变化”，不要直接覆盖。\n"
                        + "4. 过度推断控制：一次性语境只进入“临时标签”，同一偏好至少需要两次一致信号或一次强显式表达才进入“稳定偏好”。\n"
                        + "5. 推断不足控制：如果某维度长期为空，可加入自然验证建议，但不要像问卷调查。\n"
                        + "6. 隐私安全：避免记录敏感身份、密钥、联系方式、财务/健康等高敏信息；用户明确要求记住时也要最小化。\n"
                        + "7. 每条重要结论附简短证据、时间、置信度（低/中/高）和标签类型（临时/稳定/待验证）。\n"
                        + "8. 输出完整 USER.md，不要解释。\n\n"
                        + "现有画像：\n%s\n\n"
                        + "新对话信号（%s）：\n用户：%s\nAI：%s\n\n"
                        + "更新后的 USER.md：",
                safeClip(existingProfile, 3500),
                timestamp,
                safeClip(userMessage, 1000),
                safeClip(assistantReply, 1200)
        );

        AiResult result = aiService.chatWithFallback(
                java.util.List.of("gpt-oss-20b", "gpt-oss-120b"),
                "你是用户画像研究助手，负责把对话信号融合为长期、可编辑、可审计的用户画像。",
                prompt,
                0.2,
                1200
        );
        String content = result.content() != null ? result.content().trim() : "";
        if (content.isBlank()) throw new RuntimeException("画像融合返回为空");
        try {
            usageTrackingService.trackFull(userId,
                    result.model() != null ? result.model() : "auto",
                    result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                    result.latencyMs(), "user_profile_update", null);
        } catch (Exception ex) {
            log.warn("[Memory] 用户画像计费追踪失败: {}", ex.getMessage());
        }
        return content.length() > 6000 ? content.substring(0, 6000) : content;
    }

    private String appendProfileEvidence(String existingProfile, String userMessage, String timestamp) {
        String signal = safeClip(userMessage, 500).replace("\n", " ").trim();
        if (signal.isBlank()) return existingProfile;
        String base = existingProfile != null ? existingProfile.trim() : "";
        return base + "\n\n## 待融合证据\n"
                + "- [" + timestamp + "] 用户表达/需求信号：" + signal + "（置信度：低，待后续验证）\n";
    }

    private String safeClip(String text, int maxLen) {
        if (text == null) return "";
        return text.length() <= maxLen ? text : text.substring(0, maxLen);
    }

    /**
     * 调用 LLM 生成对话摘要（用于 MEMORY.md 更新）
     * 优先使用 gpt-oss-120b / gpt-oss-20b，失败则降级为默认模型
     */
    private String summarizeWithLlm(Long userId, String userMessage, String assistantReply, String timestamp, String requestIp) {
        String prompt = String.format(
                "请简要总结以下对话的关键信息（不超过80字），用于长期记忆。\n" +
                "要求：提取核心决策、代码要点、用户意图，不要啰嗦，不要加\"摘要\"前缀。\n\n" +
                "用户：%s\n\nAI：%s\n\n摘要：",
                userMessage != null ? userMessage.substring(0, Math.min(userMessage.length(), 500)) : "",
                assistantReply != null ? assistantReply.substring(0, Math.min(assistantReply.length(), 1000)) : ""
        );

        java.util.List<String> modelPriority = java.util.List.of("gpt-oss-20b", "gpt-oss-120b");

        AiResult result = aiService.chatWithFallback(
                modelPriority,
                "你是一个记忆摘要助手。请将对话内容压缩为简洁的中文摘要（不超过80字），保留关键信息，不要加任何前缀。",
                prompt,
                0.3,
                200
        );

        String summary = result.content() != null ? result.content().trim() : "";
        summary = summary.replaceAll("^(摘要|总结|对话摘要|关键信息)[：:\\s]*", "").trim();

        // ★ 计费追踪 — 记忆摘要生成
        try {
            usageTrackingService.trackFull(userId,
                    result.model() != null ? result.model() : "auto",
                    result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                    result.latencyMs(), "memory_summary", null,
                    requestIp, null, null);
        } catch (Exception ex) {
            log.warn("[Memory] 计费追踪失败: {}", ex.getMessage());
        }

        if (summary.length() > 200) {
            summary = summary.substring(0, 200) + "...";
        }
        if (summary.isEmpty()) {
            throw new RuntimeException("LLM 返回空摘要");
        }

        return String.format("\n### [%s]\n> %s\n", timestamp, summary);
    }

    /**
     * Fallback: 简单截断（原逻辑）
     */
    private void updateMemoryWithTruncation(Long userId, Long conversationId,
                                            String userMessage, String assistantReply, String timestamp) {
        MemoryDTO.DocumentRequest memReq = new MemoryDTO.DocumentRequest();
        memReq.setTitle("MEMORY.md");
        memReq.setDocType("conversation_memory");
        memReq.setCategory("memory");

        MemoryDTO.DocumentVO existingMem = getDocumentByTitle(userId, conversationId, "MEMORY.md");
        String existingContent = (existingMem != null && existingMem.getContent() != null)
                ? existingMem.getContent() : "";

        String assistantSummary = assistantReply != null && assistantReply.length() > 250
                ? assistantReply.substring(0, 250).replace("\n", " ") + "..."
                : (assistantReply != null ? assistantReply.replace("\n", " ") : "");
        String userSummary = userMessage != null && userMessage.length() > 200
                ? userMessage.substring(0, 200).replace("\n", " ") + "..."
                : (userMessage != null ? userMessage : "");

        existingContent = existingContent
                .replaceAll("暂无内容|暂无[^\\n]*\\n?", "").trim();

        String entry = String.format("\n### [%s]\n> 用户：%s\n> AI：%s\n",
                timestamp, userSummary, assistantSummary);

        String newContent = existingContent + entry;
        log.info("[Memory] 截断更新 MEMORY.md: oldLen={}, newLen={}, userLen={}, aiLen={}",
                existingContent.length(), newContent.length(), userSummary.length(), assistantSummary.length());
        memReq.setContent(newContent);
        try {
            saveDocument(userId, conversationId, memReq);
        } catch (Exception e) {
            log.warn("[Memory] 简单截断更新也失败: {}", e.getMessage());
        }
    }

    // =============================================
    // 私有辅助
    // =============================================

    private MemoryDTO.SettingVO toSettingVO(MemorySetting s) {
        MemoryDTO.SettingVO vo = new MemoryDTO.SettingVO();
        vo.setId(s.getId());
        vo.setSettingKey(s.getSettingKey());
        vo.setSettingName(s.getSettingName());
        vo.setContent(s.getContent());
        vo.setSortOrder(s.getSortOrder());
        if (s.getCreatedAt() != null) vo.setCreatedAt(s.getCreatedAt().format(FMT));
        if (s.getUpdatedAt() != null) vo.setUpdatedAt(s.getUpdatedAt().format(FMT));
        return vo;
    }

    private MemoryDTO.DocumentVO toDocumentVO(MemoryDocument doc) {
        MemoryDTO.DocumentVO vo = new MemoryDTO.DocumentVO();
        vo.setId(doc.getId());
        vo.setUuid(doc.getUuid());
        vo.setDocType(doc.getDocType());
        vo.setTitle(doc.getTitle());
        vo.setContent(doc.getContent());
        vo.setCategory(doc.getCategory());
        vo.setTags(doc.getTags() != null ? Arrays.asList(doc.getTags().split(",")) : List.of());
        vo.setImportance(doc.getImportance());
        vo.setStatus(doc.getStatus());
        vo.setSourceConvUuid(doc.getSourceConvUuid());
        if (doc.getExpiresAt() != null) vo.setExpiresAt(doc.getExpiresAt().format(FMT));
        vo.setFileSize(doc.getFileSize());
        vo.setFileType(doc.getFileType());
        vo.setOssUrl(doc.getOssUrl());
        vo.setLayer(doc.getLayer());
        vo.setVirtualPath(doc.getVirtualPath());
        if (doc.getCreatedAt() != null) vo.setCreatedAt(doc.getCreatedAt().format(FMT));
        if (doc.getUpdatedAt() != null) vo.setUpdatedAt(doc.getUpdatedAt().format(FMT));
        return vo;
    }

    private MemoryDTO.IndexVO toIndexVO(MemoryIndex idx, MemoryDocument doc) {
        MemoryDTO.IndexVO vo = new MemoryDTO.IndexVO();
        vo.setId(idx.getId());
        vo.setDocId(idx.getDocId());
        vo.setCategory(idx.getCategory());
        vo.setSummary(idx.getSummary());
        vo.setTags(idx.getTags() != null ? Arrays.asList(idx.getTags().split(",")) : List.of());
        vo.setImportance(idx.getImportance());
        if (idx.getExpiresAt() != null) vo.setExpiresAt(idx.getExpiresAt().format(FMT));
        if (idx.getCreatedAt() != null) vo.setCreatedAt(idx.getCreatedAt().format(FMT));
        if (idx.getUpdatedAt() != null) vo.setUpdatedAt(idx.getUpdatedAt().format(FMT));
        if (doc != null) {
            vo.setDocUuid(doc.getUuid());
            vo.setDocType(doc.getDocType());
        }
        vo.setLayer(idx.getLayer());
        vo.setVirtualPath(idx.getVirtualPath());
        return vo;
    }

    private MemoryDTO.WorkFileVO toWorkFileVO(MemoryWorkFile wf) {
        MemoryDTO.WorkFileVO vo = new MemoryDTO.WorkFileVO();
        vo.setId(wf.getId());
        vo.setUuid(wf.getUuid());
        vo.setFileName(wf.getFileName());
        vo.setFileType(wf.getFileType());
        vo.setFileSize(wf.getFileSize());
        vo.setMimeType(wf.getMimeType());
        vo.setOssUrl(wf.getOssUrl());
        vo.setThumbUrl(wf.getThumbUrl());
        vo.setDescription(wf.getDescription());
        vo.setTags(wf.getTags() != null ? Arrays.asList(wf.getTags().split(",")) : List.of());
        if (wf.getCreatedAt() != null) vo.setCreatedAt(wf.getCreatedAt().format(FMT));
        vo.setHasDoc(wf.getDocId() != null);
        return vo;
    }

    private void upsertIndex(Long userId, MemoryDocument doc, List<String> tags) {
        MemoryIndex idx = indexMapper.selectOne(
                new QueryWrapper<MemoryIndex>().eq("doc_id", doc.getId()).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id").last("LIMIT 1"));
        if (idx == null) {
            idx = new MemoryIndex();
            idx.setUserId(userId);
            idx.setDocId(doc.getId());
        }
        idx.setCategory(doc.getCategory() != null ? doc.getCategory() : doc.getDocType());
        // 自动生成摘要：取标题 + 内容前 100 字符
        String summary = (doc.getTitle() != null ? doc.getTitle() : "") + "：";
        if (doc.getContent() != null) {
            String clean = doc.getContent().replaceAll("#+ ", "").replaceAll("\\*\\*", "")
                    .replaceAll("\\n", " ").trim();
            summary += clean.length() > 200 ? clean.substring(0, 200) + "..." : clean;
        }
        idx.setSummary(summary);
        idx.setTags(doc.getTags());
        idx.setImportance(doc.getImportance());
        idx.setLayer(doc.getLayer());
        idx.setVirtualPath(doc.getVirtualPath());

        if (idx.getId() == null) {
            indexMapper.insert(idx);
        } else {
            indexMapper.updateById(idx);
        }
    }

    private String getFileIcon(String fileType, String mimeType) {
        if (fileType == null) return "file";
        return switch (fileType) {
            case "image" -> "image";
            case "document" -> "file-text";
            case "spreadsheet" -> "table";
            case "audio" -> "music";
            case "video" -> "video";
            case "skill" -> "zap";
            default -> "file";
        };
    }

    // =============================================
    // 记忆统计（P1-4 记忆可视化）
    // =============================================

    /**
     * 获取用户记忆统计数据
     * 用于前端记忆摘要卡展示
     */
    public MemoryDTO.MemoryStatsVO getMemoryStats(Long userId) {
        MemoryDTO.MemoryStatsVO stats = new MemoryDTO.MemoryStatsVO();

        // 总记忆文档数
        long totalDocs = documentMapper.selectCount(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
        );
        stats.setTotalDocs(totalDocs);

        // 用户偏好数（user_profile）
        long preferences = documentMapper.selectCount(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "user_profile")
                        .eq("deleted", 0)
        );
        stats.setPreferences(preferences);

        // 项目记忆数（project_memory）
        long projectMemories = documentMapper.selectCount(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "project_memory")
                        .eq("deleted", 0)
        );
        stats.setProjectMemories(projectMemories);

        // 对话记忆数（conversation_summary）
        long conversationMemories = documentMapper.selectCount(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "conversation_summary")
                        .eq("deleted", 0)
        );
        stats.setConversationMemories(conversationMemories);

        // 技能记忆数（skill_memory）
        long skillMemories = documentMapper.selectCount(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("doc_type", "skill_memory")
                        .eq("deleted", 0)
        );
        stats.setSkillMemories(skillMemories);

        // 工作文件数
        long workFiles = workFileMapper.selectCount(
                new QueryWrapper<MemoryWorkFile>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
        );
        stats.setWorkFiles(workFiles);

        // 记忆索引数
        long indexes = indexMapper.selectCount(
                new QueryWrapper<MemoryIndex>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
        );
        stats.setIndexes(indexes);

        // 最近更新时间
        MemoryDocument latestDoc = documentMapper.selectOne(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("updated_at")
                        .last("LIMIT 1")
        );
        if (latestDoc != null && latestDoc.getUpdatedAt() != null) {
            stats.setLastUpdated(latestDoc.getUpdatedAt().format(FMT));
        }

        // 按类别统计（用于时间线视图）
        Map<String, Long> byCategory = new HashMap<>();
        byCategory.put("user_profile", preferences);
        byCategory.put("project_memory", projectMemories);
        byCategory.put("conversation_summary", conversationMemories);
        byCategory.put("skill_memory", skillMemories);
        stats.setByCategory(byCategory);

        return stats;
    }

    /**
     * 获取记忆时间线（按更新时间倒序）
     * 用于时间线视图
     */
    public List<MemoryDTO.DocumentVO> getMemoryTimeline(Long userId, int limit) {
        List<MemoryDocument> docs = documentMapper.selectList(
                new QueryWrapper<MemoryDocument>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("updated_at")
                        .last("LIMIT " + limit)
        );
        return docs.stream().map(this::toDocumentVO).collect(Collectors.toList());
    }
}
