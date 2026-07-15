package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.memory.MemoryTierService;
import com.aiplatform.backend.service.MemoryService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 对话记忆系统 API
 * 基于 Coze 记忆架构设计，提供文件树、文档管理、搜索和上下文注入
 */
@Slf4j
@RestController
@RequestMapping("/api/memory")
@RequiredArgsConstructor
public class MemoryController {

    private final MemoryService memoryService;
    private final ChatConversationMapper conversationMapper;
    private final MemoryTierService tierService;

    @GetMapping("/user-profile")
    public Result<MemoryDTO.DocumentVO> getUserProfile(@RequestAttribute Long userId) {
        return Result.ok(memoryService.getOrCreateUserProfile(userId));
    }

    @PutMapping("/user-profile")
    public Result<MemoryDTO.DocumentVO> saveUserProfile(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.DocumentRequest req) {
        return Result.ok(memoryService.saveUserProfile(userId, req.getContent()));
    }

    @GetMapping("/user-system-prompt")
    public Result<MemoryDTO.DocumentVO> getUserSystemPrompt(@RequestAttribute Long userId) {
        return Result.ok(memoryService.getUserSystemPrompt(userId));
    }

    @PutMapping("/user-system-prompt")
    public Result<MemoryDTO.DocumentVO> saveUserSystemPrompt(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.DocumentRequest req) {
        return Result.ok(memoryService.saveUserSystemPrompt(userId, req.getContent()));
    }

    @DeleteMapping("/user-profile")
    public Result<String> forgetUserProfile(@RequestAttribute Long userId) {
        memoryService.forgetUserProfile(userId);
        return Result.ok("已清除用户画像和用户系统提示词");
    }

    // =============================================
    // 基础设定
    // =============================================

    @GetMapping("/settings")
    public Result<List<MemoryDTO.SettingVO>> listSettings() {
        return Result.ok(memoryService.listSettings());
    }

    @GetMapping("/settings/{settingKey}")
    public Result<MemoryDTO.SettingVO> getSetting(@PathVariable String settingKey) {
        MemoryDTO.SettingVO vo = memoryService.getSetting(settingKey);
        return vo != null ? Result.ok(vo) : Result.fail(404, "设定不存在");
    }

    @PutMapping("/settings")
    public Result<MemoryDTO.SettingVO> saveSetting(@RequestAttribute Long userId,
                                                     @RequestBody MemoryDTO.SettingRequest req) {
        return Result.ok(memoryService.saveSetting(req));
    }

    @DeleteMapping("/settings/{settingKey}")
    public Result<String> deleteSetting(@RequestAttribute Long userId,
                                         @PathVariable String settingKey) {
        memoryService.deleteSetting(settingKey);
        return Result.ok("已删除");
    }

    // =============================================
    // 记忆文档
    // =============================================

    @GetMapping("/documents")
    public Result<List<MemoryDTO.DocumentVO>> listDocuments(
            @RequestAttribute Long userId,
            @RequestParam(required = false) String docType,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) Long conversationId) {
        return Result.ok(memoryService.listDocuments(userId, docType, category, conversationId));
    }

    @GetMapping("/documents/{uuid}")
    public Result<MemoryDTO.DocumentVO> getDocument(
            @RequestAttribute Long userId,
            @PathVariable String uuid) {
        return Result.ok(memoryService.getDocument(userId, uuid));
    }

    @PostMapping("/documents")
    public Result<MemoryDTO.DocumentVO> saveDocument(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.DocumentRequest req) {
        return Result.ok(memoryService.saveDocument(userId, req));
    }

    @PutMapping("/documents/{uuid}")
    public Result<MemoryDTO.DocumentVO> updateDocument(
            @RequestAttribute Long userId,
            @PathVariable String uuid,
            @RequestBody MemoryDTO.DocumentRequest req) {
        req.setUuid(uuid);
        return Result.ok(memoryService.saveDocument(userId, req));
    }

    @DeleteMapping("/documents/{uuid}")
    public Result<String> deleteDocument(
            @RequestAttribute Long userId,
            @PathVariable String uuid) {
        memoryService.deleteDocument(userId, uuid);
        return Result.ok("已删除");
    }

    // =============================================
    // 记忆索引
    // =============================================

    @GetMapping("/indexes")
    public Result<List<MemoryDTO.IndexVO>> listIndexes(
            @RequestAttribute Long userId,
            @RequestParam(required = false) String category) {
        return Result.ok(memoryService.listIndexes(userId, category));
    }

    @PostMapping("/indexes")
    public Result<MemoryDTO.IndexVO> saveIndex(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.IndexRequest req) {
        return Result.ok(memoryService.saveIndex(userId, req));
    }

    // =============================================
    // 工作文件
    // =============================================

    @GetMapping("/work-files")
    public Result<List<MemoryDTO.WorkFileVO>> listWorkFiles(
            @RequestAttribute Long userId,
            @RequestParam(required = false) Long conversationId,
            @RequestParam(required = false) String fileType) {
        return Result.ok(memoryService.listWorkFiles(userId, conversationId, fileType));
    }

    @DeleteMapping("/work-files/{fileId}")
    public Result<String> deleteWorkFile(
            @RequestAttribute Long userId,
            @PathVariable Long fileId) {
        memoryService.deleteWorkFile(userId, fileId);
        return Result.ok("已删除");
    }

    // =============================================
    // 文件树（前端面板用）
    // =============================================

    @GetMapping("/file-tree")
    public Result<List<MemoryDTO.FileTreeNode>> getFileTree(
            @RequestAttribute Long userId,
            @RequestParam(required = false) Long conversationId,
            @RequestParam(required = false) String convUuid) {
        // convUuid → conversationId 转换
        Long resolvedConvId = conversationId;
        if (resolvedConvId == null && convUuid != null && !convUuid.isEmpty()) {
            ChatConversation conv = conversationMapper.selectOne(
                    new QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("user_id", userId).eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            resolvedConvId = conv != null ? conv.getId() : null;
        }
        return Result.ok(memoryService.buildFileTree(userId, resolvedConvId));
    }

    // =============================================
    // 搜索
    // =============================================

    @PostMapping("/search")
    public Result<MemoryDTO.SearchResult> search(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.SearchRequest req) {
        return Result.ok(memoryService.search(userId, req));
    }

    // =============================================
    // 轻量级语义搜索（替代 ES/Milvus：MySQL FULLTEXT ngram）
    // =============================================

    @PostMapping("/search/semantic")
    public Result<List<MemoryDTO.DocumentVO>> semanticSearch(
            @RequestAttribute Long userId,
            @RequestBody MemoryDTO.SearchRequest req) {
        int limit = req.getSize() != null ? req.getSize() : 20;
        return Result.ok(memoryService.semanticSearch(userId, req.getKeyword(), limit));
    }

    // =============================================
    // 分层统计与手动审计（轻量级五层模型）
    // =============================================

    /**
     * 获取各层记忆统计（L1-L4 文档数、归档数、预算）
     */
    @GetMapping("/tier/stats")
    public Result<Map<String, Object>> tierStats(@RequestAttribute Long userId) {
        return Result.ok(tierService.tierStats(userId));
    }

    /**
     * 手动触发压缩审计 + 归档（建议由管理员调用；当前与对话级鉴权保持一致）。
     * 归档为全局任务；压缩审计作用于当前用户。
     */
    @PostMapping("/tier/audit")
    public Result<Map<String, Object>> triggerAudit(@RequestAttribute Long userId) {
        int archived = tierService.archiveJob();
        int demoted = tierService.compressionAudit(userId);
        Map<String, Object> res = new java.util.LinkedHashMap<>();
        res.put("archived", archived);
        res.put("demotedFromL1", demoted);
        return Result.ok(res);
    }

    // =============================================
    // 上下文注入
    // =============================================

    @GetMapping("/context")
    public Result<MemoryDTO.MemoryContext> getMemoryContext(
            @RequestAttribute Long userId,
            @RequestParam(required = false) Long conversationId,
            @RequestParam(required = false) String convUuid) {
        // convUuid → conversationId 转换
        Long resolvedConvId = conversationId;
        if (resolvedConvId == null && convUuid != null && !convUuid.isEmpty()) {
            ChatConversation conv = conversationMapper.selectOne(
                    new QueryWrapper<ChatConversation>()
                            .eq("uuid", convUuid).eq("user_id", userId).eq("deleted", 0)
                            .orderByDesc("id").last("LIMIT 1"));
            resolvedConvId = conv != null ? conv.getId() : null;
        }
        return Result.ok(memoryService.buildMemoryContext(userId, resolvedConvId));
    }

    // =============================================
    // 记忆可视化（P1-4）
    // =============================================

    /**
     * 获取记忆统计数据
     * 用于前端记忆摘要卡
     */
    @GetMapping("/stats")
    public Result<MemoryDTO.MemoryStatsVO> getMemoryStats(@RequestAttribute Long userId) {
        return Result.ok(memoryService.getMemoryStats(userId));
    }

    /**
     * 获取记忆时间线（按更新时间倒序）
     * 用于时间线视图
     */
    @GetMapping("/timeline")
    public Result<List<MemoryDTO.DocumentVO>> getMemoryTimeline(
            @RequestAttribute Long userId,
            @RequestParam(defaultValue = "20") int limit) {
        return Result.ok(memoryService.getMemoryTimeline(userId, limit));
    }

    // =============================================
    // 自动保存（由 AI 在对话完成后调用）
    // =============================================

    @PostMapping("/auto-save/skill")
    public Result<MemoryDTO.DocumentVO> autoSaveSkill(
            @RequestAttribute Long userId,
            @RequestParam String convUuid,
            @RequestParam String skillName,
            @RequestParam String summary,
            @RequestBody String content,
            @RequestParam(required = false) List<String> tags) {
        return Result.ok(memoryService.autoSaveSkillMemory(userId, convUuid, skillName, summary, content, tags));
    }

    @PostMapping("/auto-save/project")
    public Result<MemoryDTO.DocumentVO> autoSaveProject(
            @RequestAttribute Long userId,
            @RequestParam String convUuid,
            @RequestParam String projectName,
            @RequestParam String summary,
            @RequestBody String content,
            @RequestParam(required = false) List<String> tags) {
        return Result.ok(memoryService.autoSaveProjectMemory(userId, convUuid, projectName, summary, content, tags));
    }
}
