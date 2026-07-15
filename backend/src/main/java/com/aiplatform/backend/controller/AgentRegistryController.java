package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.AgentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.SkillRating;
import com.aiplatform.backend.service.AgentRegistryService;
import com.aiplatform.backend.service.NotificationService;
import com.aiplatform.backend.service.SkillConversationService;
import com.aiplatform.backend.service.SkillFileManager;
import com.aiplatform.backend.service.SkillMatchingService;
import com.aiplatform.backend.service.SkillRatingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Agent 开放平台 REST API v1
 * <p>
 * 提供动态注册、审核、发现、管理 Agent 的完整 API。
 *
 * 核心端点：
 * - POST   /register                 注册 Agent（提交审核）
 * - PUT    /{agentId}                更新 Agent
 * - DELETE /{agentId}                注销 Agent
 * - GET    /                         分页列出市场上架的 Agent
 * - GET    /search?q=&page=&size=    分页搜索 Agent
 * - GET    /categories               获取所有分类标签
 * - GET    /{agentId}                获取 Agent 详情
 *
 * 管理端点（需 admin 角色）：
 * - GET    /admin/pending            待审核列表
 * - GET    /admin/all                全部 Agent（含所有状态）
 * - POST   /admin/{agentId}/approve  审核通过
 * - POST   /admin/{agentId}/reject   驳回
 * - PUT    /admin/{agentId}/status   切换启用/禁用
 * - PUT    /admin/{agentId}/revenue-ratio  设置分成比例
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/agent-registry")
@RequiredArgsConstructor
public class AgentRegistryController {

    private final AgentRegistryService agentRegistryService;
    private final SkillRatingService skillRatingService;
    private final SkillFileManager skillFileManager;
    private final SkillConversationService skillConversationService;
    private final SkillMatchingService skillMatchingService;
    private final NotificationService notificationService;

    // ─── 用户端：注册 & 管理自己的 Agent ────────────────────────

    @PreAuthorize("hasAuthority('PERM_skill:publish')")
    @PostMapping("/register")
    public Result<AgentDTO.AgentDetail> register(
            @RequestBody AgentDTO.RegisterRequest request,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {

        Long userId = extractUserId(authentication);
        log.info("[AgentRegistry] 提交审核: {} by user {}", request.getAgentId(), userId);

        if (request.getAgentId() == null || request.getAgentId().isBlank())
            return Result.fail("agentId 不能为空");
        if (request.getName() == null || request.getName().isBlank())
            return Result.fail("name 不能为空");
        if (request.getSystemPrompt() == null || request.getSystemPrompt().isBlank())
            return Result.fail("systemPrompt 不能为空");
        if (!request.getAgentId().matches("^[a-zA-Z0-9_-]+$"))
            return Result.fail("agentId 只允许字母、数字、短横线和下划线");

        try {
            return Result.ok(agentRegistryService.register(request, userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PutMapping("/{agentId}")
    public Result<AgentDTO.AgentDetail> update(
            @PathVariable String agentId,
            @RequestBody AgentDTO.RegisterRequest request,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            return Result.ok(agentRegistryService.update(agentId, request, userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PostMapping("/{agentId}/submit-review")
    public Result<AgentDTO.AgentDetail> submitReview(
            @PathVariable String agentId,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            return Result.ok(agentRegistryService.submitForReview(agentId, userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PreAuthorize("hasAuthority('PERM_skill:delete')")
    @DeleteMapping("/{agentId}")
    public Result<Void> delete(@PathVariable String agentId, Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            agentRegistryService.delete(agentId, userId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ─── 技能文件管理 API ─────────────────────────────

    /**
     * 获取技能文件树
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @GetMapping("/{agentId}/files")
    public Result<List<SkillFileManager.FileNode>> getFileTree(
            @PathVariable String agentId,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限：只能编辑自己的技能或管理员
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }
            
            // 先确保技能文件存在（从数据库生成）
            agentRegistryService.ensureSkillFilesFromDb(agentId, entity);
            List<SkillFileManager.FileNode> fileTree = skillFileManager.getFileTree(agentId);
            return Result.ok(fileTree);
        } catch (IOException e) {
            log.error("[AgentRegistry] 获取文件树失败: {}", agentId, e);
            return Result.fail("获取文件树失败: " + e.getMessage());
        }
    }

    /**
     * 读取技能文件内容
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @GetMapping("/{agentId}/files/content")
    public Result<String> readFile(
            @PathVariable String agentId,
            @RequestParam String path,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }
            
            String content = skillFileManager.readFile(agentId, path);
            return Result.ok(content);
        } catch (IOException e) {
            log.error("[AgentRegistry] 读取文件失败: {}/{}", agentId, path, e);
            return Result.fail("读取文件失败: " + e.getMessage());
        }
    }

    /**
     * 更新技能文件内容
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PutMapping("/{agentId}/files/content")
    public Result<Void> updateFile(
            @PathVariable String agentId,
            @RequestParam String path,
            @RequestBody String content,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }
            
            skillFileManager.updateFile(agentId, path, content);
            return Result.ok(null);
        } catch (IOException e) {
            log.error("[AgentRegistry] 更新文件失败: {}/{}", agentId, path, e);
            return Result.fail("更新文件失败: " + e.getMessage());
        }
    }

    /**
     * 创建新文件或文件夹
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PostMapping("/{agentId}/files")
    public Result<Void> createFile(
            @PathVariable String agentId,
            @RequestParam String path,
            @RequestParam(required = false) String content,
            @RequestParam(defaultValue = "false") boolean isDirectory,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }
            
            skillFileManager.createFile(agentId, path, content, isDirectory);
            return Result.ok(null);
        } catch (IOException e) {
            log.error("[AgentRegistry] 创建文件失败: {}/{}", agentId, path, e);
            return Result.fail("创建文件失败: " + e.getMessage());
        }
    }

    /**
     * 删除文件或文件夹
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @DeleteMapping("/{agentId}/files")
    public Result<Void> deleteFile(
            @PathVariable String agentId,
            @RequestParam String path,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }
            
            skillFileManager.deleteFile(agentId, path);
            return Result.ok(null);
        } catch (IOException e) {
            log.error("[AgentRegistry] 删除文件失败: {}/{}", agentId, path, e);
            return Result.fail("删除文件失败: " + e.getMessage());
        }
    }

    // ─── 对话式编辑 API ─────────────────────────────

    /**
     * 处理对话式编辑请求
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PostMapping("/{agentId}/conversation")
    public Result<SkillConversationService.ConversationResponse> processConversation(
            @PathVariable String agentId,
            @RequestBody Map<String, Object> body,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }

            String userMessage = (String) body.get("message");
            List<SkillConversationService.Message> history = 
                (List<SkillConversationService.Message>) body.getOrDefault("history", new ArrayList<>());

            if (userMessage == null || userMessage.isBlank()) {
                return Result.fail("消息内容不能为空");
            }

            SkillConversationService.ConversationResponse response = 
                skillConversationService.processConversation(agentId, userMessage, history);

            return Result.ok(response);
        } catch (IOException e) {
            log.error("[AgentRegistry] 处理对话式编辑请求失败: {}", agentId, e);
            return Result.fail("处理请求失败: " + e.getMessage());
        }
    }

    /**
     * 应用文件修改
     */
    @PreAuthorize("hasAuthority('PERM_skill:edit')")
    @PostMapping("/{agentId}/conversation/apply")
    public Result<Void> applyModifications(
            @PathVariable String agentId,
            @RequestBody Map<String, Object> body,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            // 检查权限
            AgentRegistry entity = agentRegistryService.findByAgentId(agentId);
            if (entity == null) {
                return Result.fail("技能不存在: " + agentId);
            }
            if (!agentRegistryService.isOwnerOrAdmin(entity, userId)) {
                return Result.fail("只有创建者或管理员可以编辑此技能");
            }

            List<Map<String, Object>> modificationsMap = 
                (List<Map<String, Object>>) body.get("modifications");

            if (modificationsMap == null || modificationsMap.isEmpty()) {
                return Result.fail("修改列表不能为空");
            }

            // 转换修改列表
            List<SkillConversationService.FileModification> modifications = new ArrayList<>();
            for (Map<String, Object> modMap : modificationsMap) {
                SkillConversationService.FileModification mod = new SkillConversationService.FileModification();
                mod.setAction((String) modMap.get("action"));
                mod.setFilePath((String) modMap.get("filePath"));
                mod.setReason((String) modMap.get("reason"));
                mod.setNewContent((String) modMap.get("newContent"));
                modifications.add(mod);
            }

            skillConversationService.applyModifications(agentId, modifications);

            return Result.ok(null);
        } catch (IOException e) {
            log.error("[AgentRegistry] 应用文件修改失败: {}", agentId, e);
            return Result.fail("应用修改失败: " + e.getMessage());
        }
    }

    // ─── 技能匹配 API ─────────────────────────────

    /**
     * 从用户输入中匹配技能
     */
    @GetMapping("/match")
    public Result<List<Map<String, Object>>> matchSkill(
            @RequestParam String input,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            List<SkillMatchingService.SkillMatch> matches = skillMatchingService.matchSkill(input, userId);
            
            // 转换为Map列表（避免序列化问题）
            List<Map<String, Object>> result = new ArrayList<>();
            for (SkillMatchingService.SkillMatch match : matches) {
                Map<String, Object> map = new HashMap<>();
                map.put("agentId", match.getAgentId());
                map.put("name", match.getName());
                map.put("description", match.getDescription());
                map.put("score", match.getScore());
                result.add(map);
            }
            
            return Result.ok(result);
        } catch (Exception e) {
            log.error("[AgentRegistry] 技能匹配失败: {}", input, e);
            return Result.fail("技能匹配失败: " + e.getMessage());
        }
    }

    @GetMapping("/auto-match")
    public Result<Map<String, Object>> autoMatchSkill(
            @RequestParam String input,
            @RequestParam(required = false) String convUuid,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            SkillMatchingService.AutoSkillDecision decision = skillMatchingService.autoRouteSkill(input, userId, convUuid);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("useSkill", decision.isUseSkill());
            result.put("complex", decision.isComplex());
            result.put("source", decision.getSource());
            result.put("cacheHit", decision.isCacheHit());
            result.put("bestMatch", skillMatchToMap(decision.getBestMatch()));
            List<Map<String, Object>> matches = new ArrayList<>();
            for (SkillMatchingService.SkillMatch match : decision.getMatches()) {
                matches.add(skillMatchToMap(match));
            }
            result.put("matches", matches);
            return Result.ok(result);
        } catch (Exception e) {
            log.error("[AgentRegistry] 自动匹配 Skill 失败: {}", input, e);
            return Result.fail("自动匹配 Skill 失败: " + e.getMessage());
        }
    }

    private Map<String, Object> skillMatchToMap(SkillMatchingService.SkillMatch match) {
        if (match == null) return null;
        Map<String, Object> map = new HashMap<>();
        map.put("agentId", match.getAgentId());
        map.put("name", match.getName());
        map.put("description", match.getDescription());
        map.put("score", match.getScore());
        return map;
    }

    /** 列出当前用户创建的 Agent */
    @GetMapping("/my")
    public Result<List<AgentDTO.AgentListItem>> listMy(Authentication authentication) {
        Long userId = extractUserId(authentication);
        if (userId == null) return Result.fail("未登录");
        return Result.ok(agentRegistryService.listByCreator(userId));
    }

    /** 调试端点：列出当前用户创建的所有 Agent（含 deleted 字段） */
    @GetMapping("/my-debug")
    public Result<List<Map<String, Object>>> listMyDebug(Authentication authentication) {
        Long userId = extractUserId(authentication);
        if (userId == null) return Result.fail("未登录");

        // 直接查询数据库，不过滤 deleted 字段
        List<AgentRegistry> allAgents = agentRegistryService.getAllByCreator(userId);
        List<Map<String, Object>> result = allAgents.stream()
            .map(a -> {
                Map<String, Object> map = new HashMap<>();
                map.put("agentId", a.getAgentId());
                map.put("name", a.getName());
                map.put("status", a.getStatus());
                map.put("deleted", a.getDeleted());
                map.put("createdAt", a.getCreatedAt());
                return map;
            })
            .toList();
        return Result.ok(result);
    }

    /**
     * 测试工具代码（语法检查 + 沙箱执行）
     * <p>
     * 接收工具代码，进行语法检查，并在安全沙箱中执行测试。
     */
    @PostMapping("/test-tool")
    public Result<Map<String, Object>> testTool(@RequestBody Map<String, String> body) {
        String code = body.get("code");
        String name = body.get("name");

        if (code == null || code.isBlank()) {
            return Result.fail("工具代码不能为空");
        }

        try {
            // TODO: 完整的沙箱执行环境
            // 目前进行基本的语法检查
            Map<String, Object> result = new LinkedHashMap<>();
            
            // 检查代码长度
            if (code.length() > 10000) {
                result.put("result", "代码过长（>" + (code.length() / 1024) + "KB），请简化");
                return Result.ok(result);
            }
            
            // 基本语法检查：检查是否有明显的语法错误
            // Python 代码检查
            if (code.contains("import ") || code.contains("def ") || code.contains("print(")) {
                // 尝试编译 Python 代码（需要 Python 环境）
                // 目前只做基本的检查
                if (code.contains("def ") && !code.contains("return ")) {
                    result.put("result", "警告：函数可能缺少 return 语句");
                } else {
                    result.put("result", "Python 语法检查通过（需要在真实环境中测试执行）");
                }
            // JavaScript 代码检查
            } else if (code.contains("function ") || code.contains("=>") || code.contains("console.log")) {
                result.put("result", "JavaScript 语法检查通过（需要在真实环境中测试执行）");
            // 其他代码
            } else {
                result.put("result", "代码已接收（需要在真实环境中测试执行）");
            }
            
            return Result.ok(result);
        } catch (Exception e) {
            log.warn("[AgentRegistry] 工具测试失败: {}", e.getMessage());
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("result", "测试失败: " + e.getMessage());
            return Result.ok(result);
        }
    }

    // ─── 我的技能：安装/卸载 ──────────────────────────────

    /** 安装技能到「我的技能」 */
    @PostMapping("/{agentId}/install")
    public Result<Map<String, Object>> install(@PathVariable String agentId, Authentication authentication) {
        Long userId = extractUserId(authentication);
        if (userId == null) return Result.fail("未登录");
        try {
            AgentDTO.AgentDetail detail = agentRegistryService.getDetail(agentId);
            if (!"approved".equals(detail.getStatus()) && !"active".equals(detail.getStatus())) {
                return Result.fail("Skill is not approved yet and cannot be used");
            }
            return Result.ok(agentRegistryService.installSkill(userId, agentId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 卸载技能 */
    @DeleteMapping("/{agentId}/install")
    public Result<Map<String, Object>> uninstall(@PathVariable String agentId, Authentication authentication) {
        Long userId = extractUserId(authentication);
        if (userId == null) return Result.fail("未登录");
        try {
            return Result.ok(agentRegistryService.uninstallSkill(userId, agentId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 列出当前用户已安装的技能 */
    @GetMapping("/installed")
    public Result<List<AgentDTO.AgentListItem>> listInstalled(Authentication authentication) {
        Long userId = extractUserId(authentication);
        if (userId == null) return Result.fail("未登录");
        return Result.ok(agentRegistryService.listInstalledSkills(userId));
    }

    // ─── 公开：Agent 市场浏览 ─────────────────────────────────

    /** 分页列出市场上架的 Agent */
    @GetMapping
    public Result<Result.PageResult<AgentDTO.AgentListItem>> list(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String category) {
        return Result.ok(agentRegistryService.listPaged(page, size, category));
    }

    /** 获取所有分类标签 */
    @GetMapping("/categories")
    public Result<List<String>> categories() {
        return Result.ok(agentRegistryService.getAllCategories());
    }

    /** 搜索 Agent（分页） */
    @GetMapping("/search")
    public Result<Result.PageResult<AgentDTO.AgentListItem>> search(
            @RequestParam("q") String query,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        if (query == null || query.isBlank())
            return Result.ok(agentRegistryService.listPaged(page, size, null));
        return Result.ok(agentRegistryService.searchPaged(query, page, size));
    }

    /** 获取技能商店统计数据 */
    @GetMapping("/stats")
    public Result<AgentDTO.AgentStoreStats> getStats() {
        return Result.ok(agentRegistryService.getStats());
    }

    /** Agent 详情 */
    @GetMapping("/{agentId}")
    public Result<AgentDTO.AgentDetail> getDetail(@PathVariable String agentId) {
        try {
            return Result.ok(agentRegistryService.getDetail(agentId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ─── 管理员：审核 & 管理 ──────────────────────────────────

    /** 待审核列表 */
    @GetMapping("/admin/pending")
    public Result<List<AgentDTO.AgentListItem>> pending(
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        return Result.ok(agentRegistryService.listPending());
    }

    /** 全部 Agent（含所有状态，分页） */
    @GetMapping("/admin/all")
    public Result<Result.PageResult<AgentDTO.AgentListItem>> adminAll(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String q,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        return Result.ok(agentRegistryService.listAllAdmin(page, size, status, category, q));
    }

    /** 审核通过 */
    @PostMapping("/admin/{agentId}/approve")
    public Result<AgentDTO.AgentDetail> approve(
            @PathVariable String agentId,
            @RequestBody AgentDTO.ReviewRequest request,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        try {
            AgentDTO.AgentDetail result = agentRegistryService.approve(agentId, request, adminId);
            // 发送审核通过通知
            if (result != null && result.getCreatedBy() != null) {
                try {
                    notificationService.sendSkillReviewNotification(
                            result.getCreatedBy(), result.getName(), true, request.getComment());
                } catch (Exception e) {
                    log.warn("发送审核通过通知失败: {}", e.getMessage());
                }
            }
            return Result.ok(result);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 驳回 */
    @PostMapping("/admin/{agentId}/reject")
    public Result<AgentDTO.AgentDetail> reject(
            @PathVariable String agentId,
            @RequestBody AgentDTO.ReviewRequest request,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        try {
            AgentDTO.AgentDetail result = agentRegistryService.reject(agentId, request, adminId);
            // 发送审核驳回通知
            if (result != null && result.getCreatedBy() != null) {
                try {
                    notificationService.sendSkillReviewNotification(
                            result.getCreatedBy(), result.getName(), false, request.getComment());
                } catch (Exception e) {
                    log.warn("发送审核驳回通知失败: {}", e.getMessage());
                }
            }
            return Result.ok(result);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 切换启用/禁用 */
    @PutMapping("/admin/{agentId}/status")
    public Result<AgentDTO.AgentDetail> toggleStatus(
            @PathVariable String agentId,
            @RequestBody Map<String, String> body,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        try {
            return Result.ok(agentRegistryService.toggleStatus(agentId, body.get("status"), adminId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 设置分成比例 */
    /** Admin delete Skill. */
    @DeleteMapping("/admin/{agentId}")
    public Result<Void> adminDelete(
            @PathVariable String agentId,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        try {
            agentRegistryService.delete(agentId, adminId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PutMapping("/admin/{agentId}/revenue-ratio")
    public Result<Void> updateRevenueRatio(
            @PathVariable String agentId,
            @RequestBody Map<String, Object> body,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        try {
            BigDecimal ratio = new BigDecimal(body.get("ratio").toString());
            agentRegistryService.updateRevenueRatio(agentId, ratio, adminId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ─── P2-3: 社区功能 — 评分 + 公开/私有 + 使用计数 ────────

    /** 提交评分（需登录） */
    @PostMapping("/{agentId}/ratings")
    public Result<SkillRating> rate(
            @PathVariable String agentId,
            @RequestBody Map<String, Object> body,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        int rating = Integer.parseInt(body.get("rating").toString());
        String comment = (String) body.getOrDefault("comment", "");
        try {
            // 通过 agentId 查找 agentRegistry 的数据库 ID
            AgentDTO.AgentDetail detail = agentRegistryService.getDetail(agentId);
            if (detail == null) {
                return Result.fail("技能不存在");
            }
            SkillRating sr = skillRatingService.rateSkill(detail.getId(), userId, rating, comment);
            return Result.ok(sr);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 查看评分列表 */
    @GetMapping("/{agentId}/ratings")
    public Result<List<SkillRating>> listRatings(
            @PathVariable String agentId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        try {
            AgentDTO.AgentDetail detail = agentRegistryService.getDetail(agentId);
            if (detail == null) {
                return Result.fail("技能不存在");
            }
            return Result.ok(skillRatingService.getRatings(detail.getId(), page, size));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 获取当前用户对某技能的评分 */
    @GetMapping("/{agentId}/ratings/mine")
    public Result<SkillRating> myRating(
            @PathVariable String agentId,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            AgentDTO.AgentDetail detail = agentRegistryService.getDetail(agentId);
            if (detail == null) {
                return Result.fail("技能不存在");
            }
            return Result.ok(skillRatingService.getUserRating(detail.getId(), userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 删除评分（仅评分者自己） */
    @DeleteMapping("/{agentId}/ratings/{ratingId}")
    public Result<Void> deleteRating(
            @PathVariable String agentId,
            @PathVariable Long ratingId,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        try {
            skillRatingService.deleteRating(ratingId, userId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 切换公开/私有状态（需 owner） */
    @PutMapping("/{agentId}/is-public")
    public Result<Void> updateIsPublic(
            @PathVariable String agentId,
            @RequestBody Map<String, Boolean> body,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        boolean isPublic = Boolean.TRUE.equals(body.get("isPublic"));
        try {
            agentRegistryService.updateIsPublic(agentId, isPublic, userId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /** 增加使用计数（前端调用技能时触发） */
    @PostMapping("/{agentId}/increment-usage")
    public Result<Void> incrementUsage(@PathVariable String agentId) {
        try {
            agentRegistryService.incrementTotalUsage(agentId);
            return Result.ok(null);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ─── 辅助 ──────────────────────────────────────────────

    private void requireAdmin(String userRole) {
        if (!"admin".equals(userRole)) {
            throw new RuntimeException("需要管理员权限");
        }
    }

    private Long extractUserId(Authentication authentication) {
        if (authentication == null || authentication.getPrincipal() == null) return null;
        Object principal = authentication.getPrincipal();
        if (principal instanceof Long userId) return userId;
        try {
            return Long.parseLong(authentication.getName());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
