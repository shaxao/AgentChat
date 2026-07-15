package com.aiplatform.backend.service;

import com.aiplatform.backend.agent.AgentConfig;
import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.agent.ToolExecutor;
import com.aiplatform.backend.dto.AgentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.mapper.AgentRegistryMapper;
import com.aiplatform.backend.mapper.UserInstalledSkillMapper;
import com.aiplatform.backend.entity.UserInstalledSkill;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import jakarta.annotation.PostConstruct;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Agent 注册中心服务
 * <p>
 * 核心能力：
 * 1. 动态注册/更新/注销 Agent
 * 2. Agent 发现（列表、搜索、详情）
 * 3. 将 AgentRegistry 转换为可执行的 AgentConfig
 * 4. 工具执行器路由（内置工具 vs HTTP 远程工具）
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AgentRegistryService {

    private final AgentRegistryMapper agentRegistryMapper;
    private final UserInstalledSkillMapper userInstalledSkillMapper;
    private final LedgerToolService ledgerToolService;
    private final AgentBuilderToolService agentBuilderToolService;
    private final SkillRatingService skillRatingService;
    private final ObjectMapper objectMapper;
    private final ObjectProvider<AiService> aiServiceProvider;
    private final IconStorageService iconStorageService;

    /** 内置 Agent ID → 构建器映射 */
    private static final Map<String, String> BUILTIN_AGENTS = Map.of(
        "ban-biao", "台账识别",
        "agent-builder", "Agent 开发助手"
    );

    /** 运行时缓存：agentId → AgentConfig（避免每次请求都从数据库加载） */
    private final Map<String, AgentConfig> configCache = new ConcurrentHashMap<>();

    /** 缓存最大条目数：超过后清空一半，防止 OOM */
    private static final int MAX_CACHE_SIZE = 50;

    /** 防止并发时多次清空 */
    private final Object cacheLock = new Object();

    /**
     * 应用启动时初始化：确保内置 Agent 已写入数据库
     */
    @PostConstruct
    public void init() {
        log.info("[AgentRegistry] 初始化内置 Agent...");
        ensureBuiltinAgents();
        log.info("[AgentRegistry] 内置 Agent 初始化完成: {}", BUILTIN_AGENTS.keySet());
    }

    // ─── 注册 ─────────────────────────────────────────

    /**
     * 注册新 Agent
     * @param skipReview 是否跳过审核，直接激活
     */
    @Transactional
    public AgentDTO.AgentDetail register(AgentDTO.RegisterRequest request, Long userId, boolean skipReview) {
        // 检查 agentId 是否已存在
        AgentRegistry existing = findByAgentId(request.getAgentId());
        if (existing != null) {
            throw new RuntimeException("Agent ID 已存在: " + request.getAgentId());
        }

        // 清理同名的逻辑删除记录，释放唯一约束（解决删除后重建同名技能冲突）
        agentRegistryMapper.physicallyDeleteSoftDeleted(request.getAgentId());

        AgentRegistry entity = toEntity(request, userId);
        entity.setIsBuiltin(false);
        entity.setApiKey(generateApiKey());
        if (skipReview) {
            entity.setStatus("active");
            log.info("[AgentRegistry] 新 Agent 已直接激活（跳过审核）: {} by user {}", request.getAgentId(), userId);
        } else {
            entity.setStatus("pending");
            log.info("[AgentRegistry] 新 Agent 已提交审核: {} by user {}", request.getAgentId(), userId);
        }
        try {
            agentRegistryMapper.insert(entity);
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            throw new RuntimeException("Agent ID '" + request.getAgentId() + "' 创建失败：可能存在同名残留记录，请更换 ID 或联系管理员");
        }

        // 确保技能脚本文件写入磁盘（从 toolsJson 的 code 字段提取到 scripts/ 目录）
        try {
            ensureSkillFilesFromDb(entity.getAgentId(), entity);
        } catch (Exception e) {
            log.warn("[AgentRegistry] 注册后写入技能文件失败（不影响数据库记录）: {} - {}", entity.getAgentId(), e.getMessage());
        }

        log.info("[AgentRegistry] Agent 已保存到数据库: agentId={}, status={}", request.getAgentId(), entity.getStatus());
        return toDetail(entity);
    }

    /**
     * 注册新 Agent（默认状态为 pending，需管理员审核）
     */
    @Transactional
    public AgentDTO.AgentDetail register(AgentDTO.RegisterRequest request, Long userId) {
        return register(request, userId, false);
    }

    /**
     * 审核通过 Agent（管理员操作）
     */
    @Transactional
    public AgentDTO.AgentDetail approve(String agentId, AgentDTO.ReviewRequest request, Long adminUserId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) throw new RuntimeException("Agent 不存在: " + agentId);
        if (!"pending".equals(entity.getStatus())) {
            throw new RuntimeException("只能审核 pending 状态的 Agent，当前状态: " + entity.getStatus());
        }
        entity.setStatus("approved");
        entity.setReviewComment(request.getComment());
        entity.setReviewedBy(adminUserId);
        entity.setReviewedAt(LocalDateTime.now());
        agentRegistryMapper.updateById(entity);
        configCache.remove(agentId);
        log.info("[AgentRegistry] Agent 审核通过: {} by admin {}", agentId, adminUserId);
        return toDetail(entity);
    }

    /**
     * 驳回 Agent（管理员操作）
     */
    @Transactional
    public AgentDTO.AgentDetail reject(String agentId, AgentDTO.ReviewRequest request, Long adminUserId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) throw new RuntimeException("Agent 不存在: " + agentId);
        if (!"pending".equals(entity.getStatus())) {
            throw new RuntimeException("只能审核 pending 状态的 Agent，当前状态: " + entity.getStatus());
        }
        if (request.getComment() == null || request.getComment().isBlank()) {
            throw new RuntimeException("驳回时必须填写审核意见");
        }
        entity.setStatus("rejected");
        entity.setReviewComment(request.getComment());
        entity.setReviewedBy(adminUserId);
        entity.setReviewedAt(LocalDateTime.now());
        agentRegistryMapper.updateById(entity);
        configCache.remove(agentId);
        log.info("[AgentRegistry] Agent 已驳回: {} by admin {}, 理由: {}", agentId, adminUserId, request.getComment());
        return toDetail(entity);
    }

    /**
     * 立即激活 Agent（跳过审核），供 Agent 开发助手创建技能时使用
     */
    @Transactional
    public void activateImmediately(String agentId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) throw new RuntimeException("Agent 不存在: " + agentId);
        entity.setStatus("active");
        agentRegistryMapper.updateById(entity);
        configCache.remove(agentId);
        log.info("[AgentRegistry] Agent 立即激活: {} (Agent Builder 创建)", agentId);
    }

    /**
     * 切换 Agent 启用/禁用状态（管理员操作）
     */
    @Transactional
    public AgentDTO.AgentDetail toggleStatus(String agentId, String targetStatus, Long adminUserId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) throw new RuntimeException("Agent 不存在: " + agentId);
        if (!"active".equals(targetStatus) && !"disabled".equals(targetStatus)) {
            throw new RuntimeException("目标状态只能是 active 或 disabled");
        }
        entity.setStatus(targetStatus);
        agentRegistryMapper.updateById(entity);
        configCache.remove(agentId);
        log.info("[AgentRegistry] Agent {} 状态切换为 {} by admin {}", agentId, targetStatus, adminUserId);
        return toDetail(entity);
    }

    /**
     * 更新 Agent
     */
    @Transactional
    public AgentDTO.AgentDetail update(String agentId, AgentDTO.RegisterRequest request, Long userId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            throw new RuntimeException("Agent 不存在: " + agentId);
        }

        // 内置 Agent 只能由管理员修改
        if (entity.getIsBuiltin() && !isOwnerOrAdmin(entity, userId)) {
            throw new RuntimeException("内置 Agent 只有管理员可以修改");
        }

        // 更新字段
        if (request.getName() != null) entity.setName(request.getName());
        if (request.getVersion() != null) entity.setVersion(request.getVersion());
        if (request.getDescription() != null) entity.setDescription(request.getDescription());
        if (request.getCategories() != null) entity.setCategories(String.join(",", request.getCategories()));
        if (request.getModel() != null) entity.setModel(request.getModel());
        if (request.getTemperature() != null) entity.setTemperature(request.getTemperature());
        if (request.getMaxTokens() != null) entity.setMaxTokens(request.getMaxTokens());
        if (request.getSystemPrompt() != null) entity.setSystemPrompt(request.getSystemPrompt());
        if (request.getTools() != null) entity.setToolsJson(toolsToJson(request.getTools()));
        if (request.getHooks() != null) entity.setHooksJson(toJsonSafe(request.getHooks()));
        if (request.getIcon() != null) entity.setIcon(request.getIcon());
        if (request.getAuthor() != null) entity.setAuthor(request.getAuthor());
        if (request.getStatus() != null) entity.setStatus(request.getStatus());
        if (request.getScreenshots() != null) entity.setScreenshots(toJsonSafe(request.getScreenshots()));
        if (request.getUsageGuide() != null) entity.setUsageGuide(request.getUsageGuide());

        agentRegistryMapper.updateById(entity);

        // 清除缓存
        configCache.remove(agentId);

        // 如果 tools 包含 code，重新生成技能文件和 ZIP（确保下载包含脚本）
        if (request.getTools() != null && request.getTools().stream().anyMatch(t -> t.getCode() != null && !t.getCode().isBlank())) {
            regenerateSkillZip(agentId, entity);
        }

        log.info("[AgentRegistry] Agent 已更新: {}", agentId);
        return toDetail(entity);
    }

    /**
     * 注销 Agent（逻辑删除）
     */
    @Transactional
    public AgentDTO.AgentDetail submitForReview(String agentId, Long userId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            throw new RuntimeException("Agent not found: " + agentId);
        }
        if (!isOwnerOrAdmin(entity, userId)) {
            throw new RuntimeException("Only the creator or admin can submit this skill for review");
        }
        if ("pending".equals(entity.getStatus())) {
            throw new RuntimeException("Skill is already pending review");
        }
        entity.setStatus("pending");
        entity.setReviewComment(null);
        entity.setReviewedBy(null);
        entity.setReviewedAt(null);
        agentRegistryMapper.updateById(entity);
        configCache.remove(agentId);
        return toDetail(entity);
    }

    @Transactional
    public void delete(String agentId, Long userId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            throw new RuntimeException("Agent 不存在: " + agentId);
        }

        if (entity.getIsBuiltin()) {
            throw new RuntimeException("内置 Agent 不可删除");
        }

        if (!isOwnerOrAdmin(entity, userId)) {
            throw new RuntimeException("只有创建者或管理员可以删除此 Agent");
        }

        agentRegistryMapper.deleteById(entity.getId());
        configCache.remove(agentId);

        log.info("[AgentRegistry] Agent 已注销: {}", agentId);
    }

    /**
     * 确保技能文件存在（如果目录和ZIP都不存在，从数据库生成）
     * @param agentId 技能ID
     * @param entity 数据库实体
     */
    public void ensureSkillFilesFromDb(String agentId, AgentRegistry entity) {
        try {
            // 生成 SKILL.md 内容
            StringBuilder skillMd = new StringBuilder();
            skillMd.append("# ").append(entity.getName() != null ? entity.getName() : agentId).append("\n\n");
            if (entity.getDescription() != null && !entity.getDescription().isBlank()) {
                skillMd.append("## 描述\n\n").append(entity.getDescription()).append("\n\n");
            }
            if (entity.getSystemPrompt() != null && !entity.getSystemPrompt().isBlank()) {
                skillMd.append("## 系统提示词\n\n").append(entity.getSystemPrompt()).append("\n\n");
            }
            if (entity.getCategories() != null && !entity.getCategories().isBlank()) {
                skillMd.append("## 分类\n\n").append(entity.getCategories()).append("\n\n");
            }
            skillMd.append("## 版本\n\n").append(entity.getVersion() != null ? entity.getVersion() : "1.0.0").append("\n");

            // 确保目录存在 + 写入 SKILL.md 和 package.json（幂等：仅在文件不存在时写入）
            Path skillDir = Paths.get(SKILL_STORAGE_DIR, agentId);

            // 始终确保目录存在
            if (!Files.exists(skillDir)) {
                Files.createDirectories(skillDir);
                log.info("[AgentRegistry] 技能目录不存在，创建: {}", agentId);
            }

            // 始终确保 SKILL.md 存在（避免覆盖已编辑的文件）
            if (!Files.exists(skillDir.resolve("SKILL.md"))) {
                Files.writeString(skillDir.resolve("SKILL.md"), skillMd.toString(), java.nio.charset.StandardCharsets.UTF_8);
                log.info("[AgentRegistry] 从数据库生成 SKILL.md: {}", agentId);
            }

            // 始终确保 package.json 存在（避免覆盖已编辑的文件）
            if (!Files.exists(skillDir.resolve("package.json"))) {
                String packageJson = String.format(
                    "{\"name\":\"%s\",\"version\":\"%s\",\"description\":\"%s\",\"model\":\"%s\"}",
                    escapeJsonStr(agentId),
                    entity.getVersion() != null ? entity.getVersion() : "1.0.0",
                    escapeJsonStr(entity.getDescription() != null ? entity.getDescription() : ""),
                    escapeJsonStr(entity.getModel() != null ? entity.getModel() : "")
                );
                Files.writeString(skillDir.resolve("package.json"), packageJson, java.nio.charset.StandardCharsets.UTF_8);
                log.info("[AgentRegistry] 从数据库生成 package.json: {}", agentId);
            }

            // 始终确保 scripts/ 目录下的脚本文件存在（从 toolsJson 的 code 字段提取）
            // 这处理两种情况：1) 新建目录后写入脚本；2) 目录已存在但脚本缺失
            if (entity.getToolsJson() != null && !entity.getToolsJson().isEmpty() && !"[]".equals(entity.getToolsJson())) {
                try {
                    com.fasterxml.jackson.databind.JsonNode tools = objectMapper.readTree(entity.getToolsJson());
                    for (com.fasterxml.jackson.databind.JsonNode tool : tools) {
                        if (tool.has("code") && !tool.get("code").isNull() && !tool.get("code").asText().isBlank()) {
                            String code = tool.get("code").asText();
                            Path scriptPath = resolveToolScriptPath(skillDir, tool);
                            Files.createDirectories(scriptPath.getParent());
                            String scriptFileName = skillDir.relativize(scriptPath).toString().replace('\\', '/');
                            // 仅在文件不存在时写入（避免覆盖已编辑的脚本）
                            if (!Files.exists(scriptPath)) {
                                Files.writeString(scriptPath, code, java.nio.charset.StandardCharsets.UTF_8);
                                log.info("[AgentRegistry] 从数据库恢复脚本: {}/scripts/{}", agentId, scriptFileName);
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[AgentRegistry] 解析 toolsJson 恢复脚本失败: {}", e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("[AgentRegistry] 确保技能文件存在失败: {} - {}", agentId, e.getMessage());
        }
    }

    /** JSON 字符串转义辅助方法 */
    private String escapeJsonStr(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private Path resolveToolScriptPath(Path skillDir, com.fasterxml.jackson.databind.JsonNode tool) {
        String toolName = tool.has("name") ? tool.get("name").asText() : "tool";
        if (tool.has("endpoint") && !tool.get("endpoint").isNull()) {
            String endpoint = tool.get("endpoint").asText("");
            if (endpoint.startsWith("script://")) {
                String scriptPath = endpoint.substring("script://".length()).replace('\\', '/');
                if (!scriptPath.isBlank() && !Paths.get(scriptPath).isAbsolute()) {
                    Path target = skillDir.resolve(normalizeRelativeScriptPath(scriptPath)).normalize();
                    if (target.startsWith(skillDir.normalize())) {
                        return target;
                    }
                }
            }
        }
        return skillDir.resolve("scripts").resolve(safeScriptFileName(toolName)).normalize();
    }

    private String normalizeRelativeScriptPath(String scriptPath) {
        String normalized = scriptPath == null ? "" : scriptPath.replace('\\', '/').replaceAll("^\\./+", "");
        int scriptsIdx = normalized.indexOf("scripts/");
        if (scriptsIdx >= 0) {
            normalized = normalized.substring(scriptsIdx);
        } else {
            int slash = normalized.lastIndexOf('/');
            normalized = "scripts/" + (slash >= 0 ? normalized.substring(slash + 1) : normalized);
        }
        return normalized.replaceAll("/+", "/");
    }

    private String safeScriptFileName(String toolName) {
        String safe = toolName == null ? "tool" : toolName.replaceAll("[^a-zA-Z0-9_.-]", "_");
        if (safe.isBlank()) safe = "tool";
        if (!safe.endsWith(".py") && !safe.endsWith(".sh") && !safe.endsWith(".js")) {
            safe += ".py";
        }
        return safe;
    }

    /**
     * 重新生成技能文件和 ZIP（用于编辑技能后更新脚本）
     * 1. 删除旧的技能目录和 ZIP
     * 2. 从数据库重新生成目录（SKILL.md + package.json + scripts/）
     * 3. 生成新 ZIP 并保存
     */
    private void regenerateSkillZip(String agentId, AgentRegistry entity) {
        try {
            Path skillDir = Paths.get(SKILL_STORAGE_DIR, agentId);
            Path zipPath = Paths.get(SKILL_STORAGE_DIR, agentId + ".zip");

            // 1. 删除旧目录
            if (Files.exists(skillDir)) {
                Files.walk(skillDir)
                    .sorted(Comparator.reverseOrder())
                    .forEach(p -> { try { Files.delete(p); } catch (Exception ignored) {} });
            }
            // 2. 删除旧 ZIP（本地）
            Files.deleteIfExists(zipPath);
            // 3. 删除 OSS 上的旧 ZIP（通过覆盖实现）

            // 4. 从数据库重新生成目录
            ensureSkillFilesFromDb(agentId, entity);

            // 5. 生成新 ZIP
            byte[] zipBytes = buildZipFromDirectory(skillDir, agentId);
            if (zipBytes != null && zipBytes.length > 0) {
                saveZipBytes(agentId, zipBytes);
                log.info("[AgentRegistry] 技能 ZIP 已重新生成: {} ({} 字节)", agentId, zipBytes.length);
            }
        } catch (Exception e) {
            log.warn("[AgentRegistry] 重新生成技能 ZIP 失败: {} - {}", agentId, e.getMessage());
        }
    }

    /** 从目录构建 ZIP */
    private byte[] buildZipFromDirectory(Path skillDir, String agentId) {
        try (java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
             java.util.zip.ZipOutputStream zos = new java.util.zip.ZipOutputStream(baos, java.nio.charset.StandardCharsets.UTF_8)) {
            Files.walk(skillDir)
                .filter(Files::isRegularFile)
                .forEach(path -> {
                    try {
                        String relativePath = skillDir.relativize(path).toString().replace('\\', '/');
                        zos.putNextEntry(new java.util.zip.ZipEntry(relativePath));
                        zos.write(Files.readAllBytes(path));
                        zos.closeEntry();
                    } catch (Exception e) {
                        log.warn("[AgentRegistry] 添加文件到 ZIP 失败: {} - {}", path, e.getMessage());
                    }
                });
            zos.finish();
            return baos.toByteArray();
        } catch (Exception e) {
            log.warn("[AgentRegistry] 构建 ZIP 失败: {} - {}", agentId, e.getMessage());
            return null;
        }
    }

    // ─── 发现 ─────────────────────────────────────────

    /**
     * 获取所有可用 Agent 列表（市场页，仅 approved/active）
     */
    public List<AgentDTO.AgentListItem> listAll() {
        ensureBuiltinAgents();
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .orderByAsc(AgentRegistry::getSortOrder)
                .orderByDesc(AgentRegistry::getIsBuiltin)
        );
        return agents.stream().map(this::toListItem).toList();
    }

    /**
     * 分页列出市场中的 Agent（仅 approved/active）
     */
    public Result.PageResult<AgentDTO.AgentListItem> listPaged(int page, int size, String category) {
        ensureBuiltinAgents();
        LambdaQueryWrapper<AgentRegistry> wrapper = new LambdaQueryWrapper<AgentRegistry>()
            .in(AgentRegistry::getStatus, List.of("approved", "active"))
            .orderByAsc(AgentRegistry::getSortOrder)
            .orderByDesc(AgentRegistry::getIsBuiltin);

        if (category != null && !category.isBlank()) {
            wrapper.like(AgentRegistry::getCategories, category);
        }

        Page<AgentRegistry> mpPage = new Page<>(page, size);
        mpPage.setSearchCount(true);
        Page<AgentRegistry> result = agentRegistryMapper.selectPage(mpPage, wrapper);
        List<AgentDTO.AgentListItem> list = result.getRecords().stream().map(this::toListItem).toList();
        return new Result.PageResult<>(list, result.getTotal(), page, size);
    }

    /**
     * 获取所有分类标签（从已有 Agent 的 categories 中提取去重）
     */
    public List<String> getAllCategories() {
        ensureBuiltinAgents();
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .isNotNull(AgentRegistry::getCategories)
                .ne(AgentRegistry::getCategories, "")
        );
        Set<String> catSet = new LinkedHashSet<>();
        for (AgentRegistry a : agents) {
            for (String c : a.getCategories().split(",")) {
                String trimmed = c.trim();
                if (!trimmed.isEmpty()) catSet.add(trimmed);
            }
        }
        return new ArrayList<>(catSet);
    }

    /**
     * 获取技能商店统计数据
     */
    public AgentDTO.AgentStoreStats getStats() {
        ensureBuiltinAgents();
        // 上架技能总数 (status = approved 或 active)
        long totalAgents = agentRegistryMapper.selectCount(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
        );
        // 分类标签数（去重）
        int totalCategories = getAllCategories().size();
        // 累计使用次数
        List<AgentRegistry> allApproved = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .select(AgentRegistry::getTotalUsage)
        );
        long totalUsage = allApproved.stream().mapToLong(a -> a.getTotalUsage() != null ? a.getTotalUsage() : 0).sum();
        // 本周新增
        LocalDateTime weekStart = LocalDateTime.now()
            .with(java.time.temporal.TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))
            .withHour(0).withMinute(0).withSecond(0).withNano(0);
        long newThisWeek = agentRegistryMapper.selectCount(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .ge(AgentRegistry::getCreatedAt, weekStart)
        );
        AgentDTO.AgentStoreStats stats = new AgentDTO.AgentStoreStats();
        stats.setTotalAgents(totalAgents);
        stats.setTotalCategories(totalCategories);
        stats.setTotalUsage(totalUsage);
        stats.setNewThisWeek(newThisWeek);
        return stats;
    }

    /**
     * 获取待审核的 Agent 列表（管理员专用）
     */
    public List<AgentDTO.AgentListItem> listPending() {
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .eq(AgentRegistry::getStatus, "pending")
                .orderByAsc(AgentRegistry::getCreatedAt)
        );
        return agents.stream().map(this::toListItem).toList();
    }

    /**
     * 获取所有 Agent（管理员专用，包含所有状态）
     */
    public Result.PageResult<AgentDTO.AgentListItem> listAllAdmin(int page, int size, String status, String category) {
        return listAllAdmin(page, size, status, category, null);
    }

    public Result.PageResult<AgentDTO.AgentListItem> listAllAdmin(int page, int size, String status, String category, String query) {
        ensureBuiltinAgents();
        LambdaQueryWrapper<AgentRegistry> wrapper = new LambdaQueryWrapper<AgentRegistry>()
            .orderByAsc(AgentRegistry::getSortOrder)
            .orderByDesc(AgentRegistry::getIsBuiltin);

        if (status != null && !status.isBlank()) {
            wrapper.eq(AgentRegistry::getStatus, status);
        }
        if (category != null && !category.isBlank()) {
            wrapper.like(AgentRegistry::getCategories, category);
        }
        if (query != null && !query.isBlank()) {
            String q = query.trim();
            wrapper.and(w -> w
                .like(AgentRegistry::getAgentId, q)
                .or().like(AgentRegistry::getName, q)
                .or().like(AgentRegistry::getDescription, q)
                .or().like(AgentRegistry::getAuthor, q)
                .or().like(AgentRegistry::getCategories, q)
            );
        }

        Page<AgentRegistry> mpPage = new Page<>(page, size);
        mpPage.setSearchCount(true);
        Page<AgentRegistry> result = agentRegistryMapper.selectPage(mpPage, wrapper);
        List<AgentDTO.AgentListItem> list = result.getRecords().stream().map(this::toListItem).toList();
        return new Result.PageResult<>(list, result.getTotal(), page, size);
    }

    /**
     * 搜索 Agent（市场页，分页）
     */
    public Result.PageResult<AgentDTO.AgentListItem> searchPaged(String query, int page, int size) {
        ensureBuiltinAgents();
        log.info("[AgentSearch] query=\"{}\" page={} size={}", query, page, size);
        // 先查总数和所有活跃agent名称用于诊断
        long totalCount = agentRegistryMapper.selectCount(
            new LambdaQueryWrapper<AgentRegistry>().in(AgentRegistry::getStatus, List.of("approved", "active"))
        );
        List<AgentRegistry> allActive = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .select(AgentRegistry::getAgentId, AgentRegistry::getName)
                .last("LIMIT 20")
        );
        log.info("[AgentSearch] total active agents in DB: {}", totalCount);
        for (AgentRegistry a : allActive) {
            log.info("[AgentSearch]   agentId={} name={}", a.getAgentId(), a.getName());
        }

        LambdaQueryWrapper<AgentRegistry> wrapper = new LambdaQueryWrapper<AgentRegistry>()
            .in(AgentRegistry::getStatus, List.of("approved", "active"))
            .and(w -> w
                .like(AgentRegistry::getAgentId, query)
                .or().like(AgentRegistry::getName, query)
                .or().like(AgentRegistry::getDescription, query)
                .or().like(AgentRegistry::getCategories, query)
            )
            .orderByAsc(AgentRegistry::getSortOrder);

        Page<AgentRegistry> mpPage = new Page<>(page, size);
        mpPage.setSearchCount(true);
        Page<AgentRegistry> result = agentRegistryMapper.selectPage(mpPage, wrapper);
        log.info("[AgentSearch] matched count={} total={}", result.getRecords().size(), result.getTotal());
        List<AgentDTO.AgentListItem> list = result.getRecords().stream().map(this::toListItem).toList();
        return new Result.PageResult<>(list, result.getTotal(), page, size);
    }

    /**
     * 搜索 Agent（不分页，兼容旧接口）
     */
    public List<AgentDTO.AgentListItem> search(String query) {
        ensureBuiltinAgents();
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
                .and(w -> w
                    .like(AgentRegistry::getName, query)
                    .or().like(AgentRegistry::getDescription, query)
                    .or().like(AgentRegistry::getCategories, query)
                )
                .orderByAsc(AgentRegistry::getSortOrder)
        );
        return agents.stream().map(this::toListItem).toList();
    }

    /**
     * 按创建者列出 Agent（用于 Agent Builder 我的 Agent 功能）
     */
    public List<AgentDTO.AgentListItem> listByCreator(Long userId) {
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .eq(AgentRegistry::getCreatedBy, userId)
                .orderByDesc(AgentRegistry::getCreatedAt)
        );
        log.info("[AgentRegistry] listByCreator: userId={}, 返回 {} 个技能 (总计 {} 条记录)",
            userId, agents.size(), agents.size());
        // 调试：打印所有返回的技能名称
        agents.forEach(a -> log.info("  - agentId={}, name={}, status={}, deleted={}",
            a.getAgentId(), a.getName(), a.getStatus(), a.getDeleted()));
        return agents.stream().map(this::toListItem).toList();
    }

    /**
     * 调试用：返回包含所有记录（包括 deleted=1）的列表
     */
    public List<AgentRegistry> getAllByCreator(Long userId) {
        // 使用自定义 SQL 绕过 @TableLogic 过滤
        return agentRegistryMapper.selectRawByCreator(userId);
    }

    /**
     * 获取 Agent 详情
     */
    public AgentDTO.AgentDetail getDetail(String agentId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            throw new RuntimeException("Agent 不存在: " + agentId);
        }
        return toDetail(entity);
    }

    // ─── 转换为可执行 AgentConfig ─────────────────────────────

    /**
     * 从数据库加载 AgentConfig（带缓存）
     * <p>
     * 优先级：内置 Agent → 数据库动态注册的 Agent
     */
    public AgentConfig loadAgentConfig(String agentId) {
        // 1. 先查缓存
        AgentConfig cached = configCache.get(agentId);
        if (cached != null) return cached;

        // 2. 检查内置 Agent
        if (BUILTIN_AGENTS.containsKey(agentId)) {
            AgentConfig builtin = buildBuiltinAgentConfig(agentId);
            cachePut(agentId, builtin);
            return builtin;
        }

        // 3. 从数据库加载
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            throw new RuntimeException("Agent 不存在: " + agentId);
        }

        if (!"active".equals(entity.getStatus()) && !"approved".equals(entity.getStatus())) {
            throw new RuntimeException("Agent 未上架: " + agentId + " (状态: " + entity.getStatus() + ")");
        }

        AgentConfig config = buildDynamicAgentConfig(entity);
        cachePut(agentId, config);
        return config;
    }

    /** 写入缓存（带大小限制，防止 OOM） */
    private void cachePut(String agentId, AgentConfig config) {
        synchronized (cacheLock) {
            if (configCache.size() >= MAX_CACHE_SIZE) {
                // 超过上限：清空一半（保留最近添加的条目需配合 LinkedHashMap，这里简单清空全部）
                log.warn("[AgentRegistry] configCache 已达上限 {}，清空缓存", configCache.size());
                configCache.clear();
            }
        }
        configCache.put(agentId, config);
    }

    /**
     * 构建内置 Agent 的 AgentConfig
     */
    private AgentConfig buildBuiltinAgentConfig(String agentId) {
        return switch (agentId) {
            case "ban-biao" -> new AgentConfig(
                "ban-biao",
                "台账识别",
                BAN_BIAO_SYSTEM_PROMPT,
                "gpt-4o",
                0.1,
                8192,
                ledgerToolService.getBanBiaoTools(),
                this::executeBuiltinTool
            );
            case "agent-builder" -> new AgentConfig(
                "agent-builder",
                "Agent 开发助手",
                AGENT_BUILDER_SYSTEM_PROMPT,
                "gpt-4o",
                0.3,
                8192,
                agentBuilderToolService.getAgentBuilderTools(),
                this::executeBuiltinTool
            );
            default -> throw new RuntimeException("未知内置 Agent: " + agentId);
        };
    }

    /** 台账识别 Agent 的系统提示词 */
    private static final String BAN_BIAO_SYSTEM_PROMPT = """
                你是一个专业的台账识别助手，负责根据用户提供的送货单图片、千克表和台账模板，生成标准台账 Excel 文件。

                ## 工作流程（严格按照以下顺序执行）

                ### 情况1：用户同时上传了千克表、模板和送货单图片（最常见场景）
                1. **上传千克表**：调用 `upload_kg_table`，file_path 使用千克表 Excel 的「服务器路径」
                2. **上传模板**：调用 `upload_template`，file_path 使用台账模板 Excel 的「服务器路径」
                3. **识别图片**：调用 `recognize_delivery_image`，image_path 使用送货单图片的「服务器路径」
                4. **一键生成台账**：调用 `batch_generate_ledger`，传入 delivery_date（进货日期）和 ledger_title（台账标题）
                5. 告知用户文件已生成并提供下载方式

                ### 情况2：用户只上传了千克表和/或台账模板（没有送货单图片）
                1. **上传千克表**：调用 `upload_kg_table`
                2. **上传模板**：调用 `upload_template`
                3. 告知用户文件已解析，等待用户提供送货单图片

                ### 情况3：用户上传了订货 Excel
                1. **解析 Excel**：调用 `upload_procurement_excel`
                2. 然后按情况1的流程继续

                **重要**：使用 `batch_generate_ledger` 一键完成所有批量操作，不要逐个商品调用 query_kg_table / match_ledger_template / fill_ledger_template。这些细粒度工具仅保留用于特殊情况。

                ## 关于用户上传的文件

                当用户上传 Excel/文件时，消息中会出现：
                ```
                [已上传文件: 文件名.xlsx，服务器路径: C:\\Users\\...\\uploads\\xxx.xlsx]
                ```

                当用户上传图片时，消息中会出现：
                ```
                [已上传图片: 文件名.jpg，服务器路径: C:\\Users\\...\\uploads\\xxx.jpg]
                ```

                **重要**：
                - Excel 文件的「服务器路径」→ 作为 `upload_kg_table` / `upload_template` / `upload_procurement_excel` 的 `file_path` 参数
                - 图片的「服务器路径」→ 作为 `recognize_delivery_image` 的 `image_path` 参数
                - 千克表 Excel → 调用 `upload_kg_table`
                - 台账模板 Excel → 调用 `upload_template`
                - 订货 Excel → 调用 `upload_procurement_excel`
                - 送货单图片 → 调用 `recognize_delivery_image`（image_path 使用图片的服务器路径）

                ## 工具调用方式（非常重要！）

                优先使用 Function Calling（工具调用）来执行工具。如果 Function Calling 不可用（例如你发现自己无法调用工具函数），请使用以下文本格式调用工具：

                ```tool
                工具名称({"参数名": "参数值"})
                ```

                例如：
                ```tool
                upload_kg_table({"file_path": "C:\\\\Users\\\\...\\\\uploads\\\\xxx.xlsx"})
                ```

                ```tool
                recognize_delivery_image({"image_path": "C:\\\\Users\\\\...\\\\uploads\\\\img.jpg"})
                ```

                每次只调用一个工具，等待返回结果后再决定下一步。

                ## 关键规则

                - 千克表和模板可以在识别送货单之前上传，也可以同时上传
                - 如果千克表未上传，batch_generate_ledger 会使用默认单位重量0
                - 如果模板未上传，会使用默认格式生成台账
                - 识别图片时，如果图片模糊，标注不确定的字段并告知用户
                - 生成台账文件后，工具结果中的 download_url 是可直接点击的完整链接，你只需告诉用户"文件已生成"，不要自己构造任何链接地址
                - 不要在回复中输出 JSON 格式的工具调用参数，所有工具调用必须通过 Function Calling 或 ```tool 代码块完成
                """;

    private static final String AGENT_BUILDER_SYSTEM_PROMPT = """
                你是一个**通用的 Agent/Skill 开发助手**。你的唯一使命是：无论用户想创建什么类型的技能，你都能通过**对话式分步引导**帮他们从零到一完成，完全不需要用户写代码。

                ## 🎯 你的定位（极其重要）

                你服务于**所有领域、所有场景**。用户可能想创建：
                - 数据处理技能（Excel/CSV/JSON 分析）
                - API 调用技能（第三方服务集成）
                - 网页抓取技能（信息采集）
                - 自动化运维技能（定时任务/监控）
                - 内容生成技能（报告/翻译/摘要）
                - 或者你能想象到的任何其他类型

                **你绝不应该预设用户的场景是什么。** 你的每一步分析和建议都必须基于用户实际提供的代码和需求，而不是套用某个固定模板。

                ## 🔴 核心规则（违反将导致创建失败）

                1. **禁止在用户确认前调用 quick_create_skill** — 你必须先把每一步的结果展示给用户审查
                2. **每步用固定格式** — `## 📋 第X步：标题` 作为步骤标题
                3. **代码用 Markdown 代码块** — ```python ... ```
                4. **工具定义用表格** — 函数名 | 参数类型 | 返回值类型 | 作用说明
                5. **第4步必须询问确认** — 最后一行必须是「**确认创建吗？回复「发布」来执行。**」
                6. **所有示例内容必须来自用户实际代码** — 绝不使用任何与当前对话无关的预设示例
                7. **🔴 禁止重启工作流！** 当用户说「继续」「下一步」「然后呢」「go on」等跟进词时，
                   你必须**从上次完成的步骤继续**，绝不允许重新从第1步开始！
                   检查对话历史中最后一个「## 📋 第X步」来确定当前处于哪一步，然后输出下一步。
                8. **🔴 禁止说「请稍等/等一下/马上」！** 当你需要调用工具时，**直接调用工具**，
                   不要在文字中说任何等待语。对话会在你输出纯文本（不带 tool_calls）时自动结束，
                   用户永远不会等到结果。需要执行操作 → 直接调用工具，需要告诉用户进度 →
                   在工具执行后输出结果。

                ## 对话式工作流（5步）

                当用户提供代码并说「帮我创建XX技能」时，你**必须**按以下顺序分步输出。

                ⚠️ 以下所有带有「…」的内容都是**占位符**，你必须替换为用户实际代码中的真实内容。禁止直接输出占位符！

                ---

                ### 📋 第1步：分析代码函数签名

                逐行阅读用户提供的代码，找出所有顶层函数和类方法，输出分析表格：

                - 表格列出：函数名、参数列表（含默认值）、返回值类型、外部依赖、是否适合作为 LLM 工具
                - 区分「主工具函数」（暴露给 LLM 调用）和「内部辅助函数」（仅在脚本内使用）
                - 说明你的判断依据（基于函数的功能和使用方式）

                最后输出：「**→ 进入第2步：精简代码**」

                ### 🔧 第2步：精简代码

                从原始代码中提取核心逻辑，剥离无关代码：

                **必须做的事**：
                1. 删除：Flask/FastAPI 路由、CORS 配置、数据库连接初始化、main() 入口、argparse 等
                2. 保留：核心业务函数及其直接依赖的辅助函数/类
                3. 不猜不编：只保留原始代码中实际存在的逻辑，不添加任何新功能
                4. **调用 save_script 工具**将完整精简代码保存到后端脚本目录（如 analyze.py）
                5. **只输出精简摘要，不要输出完整代码！** 完整代码已通过 save_script 保存。

                摘要格式：
                - 剥离了哪些无关代码（列举）
                - 保留了哪些核心函数（表格：函数名 + 作用）
                - 共计 N 行代码
                - 脚本已保存为 xxx.py

                ⚠️ **为什么只输出摘要？** 完整代码可能有数百行，会撑爆对话上下文导致 AI 失忆重启工作流。
                save_script 已将其安全保存到后端，下一步可以直接引用脚本文件名。

                最后输出：「**→ 进入第3步：编写系统提示词**」

                ### 📝 第3步：编写系统提示词

                根据用户的实际代码功能和需求，编写一个**具体、可操作**的系统提示词：

                - **角色定义**：明确这个 Agent 的身份和核心职责（基于用户代码的实际功能）
                - **使用场景**：描述用户会如何使用它，典型的问题/指令格式
                - **工具调用规则**：何时调用哪个工具，参数如何填充（基于实际函数签名）
                - **输出格式**：成功时如何呈现结果，失败时如何反馈
                - **边界与限制**：这个 Agent 能做什么、不能做什么

                ⚠️ 提示词必须基于用户实际代码编写，禁止使用任何与当前代码无关的场景描述。

                最后输出：「**→ 进入第4步：准备发布**」

                ### ✅ 第4步：准备发布

                汇总技能信息，让用户最终确认：

                - 技能名称（根据功能自动起名，简洁有辨识度）
                - Agent ID（英文字母+连字符，基于技能名生成）
                - 工具列表（函数名 + 简要说明）
                - 脚本文件名
                - 分类标签（1-3个，反映技能的实际用途）
                - 推荐模型
                - 图标提示词（用英文描述技能图标，AI会自动生成。如 "a chart icon, blue, flat design"）

                最后一行**必须是**：「**确认创建吗？回复「发布」来执行。**」
                ——用户的确认是调用 quick_create_skill 的唯一触发条件。

                ### 🚀 第5步：创建技能

                **【绝对禁止】绝不能只输出 `quick_create_skill` 的文本示例！必须真正调用工具！**
                只在用户明确确认后，调用 quick_create_skill 工具。

                参数填充规则：
                - `code_content`：精简后的完整代码。**由于第2步已通过 save_script 保存到后端，此字段可以留空或填入代码。如果留空，quick_create_skill 会自动从已保存的脚本文件读取代码。**
                - `skill_name`：第4步确定的技能名称
                - `description`：一句话描述技能功能
                - `system_prompt`：第3步编写的完整提示词（不是占位符！）
                - `categories`：第4步确定的分类标签数组
                - `model`：推荐的模型名称
                - `script_name`：**必须填写！** 与第2步 save_script 时用的文件名一致（如 `analyze.py`）。quick_create_skill 会从此文件读取完整代码。
                - `tools`：工具定义数组，每个工具包含 name/description/parameters（JSON Schema 格式）
                - `icon_prompt`：**可选但推荐！** 用英文描述技能图标，如 "a data analysis chart icon, blue theme, flat design"。后端会自动调用AI生成图标。不填则使用默认图标。

                ## 工具定义规范（Python → JSON Schema）

                | Python 签名 | JSON Schema 映射 |
                |---|---|
                | `def f(name, age=18)` | `"required": ["name"]`，`age` 在 properties 中但不在 required 中 |
                | `def f(keyword: str)` | `"type": "string"` |
                | `def f(count: int = 10)` | `"type": "integer"`，不在 required 中 |
                | `def f(data: dict)` | `"type": "object"` |
                | `def f(items: list)` | `"type": "array"` |
                | `def f(flag: bool)` | `"type": "boolean"` |
                | `def f(value: float)` | `"type": "number"` |

                所有参数 description 用中文描述，清晰说明参数含义和格式要求。

                ## 代码精简指南

                1. **剥离无关代码**：Flask/FastAPI app、CORS、blueprint、路由注册、app.run()、数据库初始化、命令行参数解析
                2. **追踪调用链**：从用户指定的入口函数向下，递归提取所有被调用的函数和类
                3. **检查依赖**：标准库保留，pip 包保留（在脚本顶部 import），已在精简中剥离的模块不 import
                4. **保持自包含**：所有提取的函数拼成一个完整的 .py 文件，可直接被 Agent 框架加载执行

                ## 可用的其他工具

                除 quick_create_skill 外，你还可以使用：
                - **save_script** - 将 Python/Shell 脚本单独保存到本地
                - **list_my_agents** - 列出用户已有的所有技能
                - **get_agent_detail** - 查看某个技能的详细信息
                - **update_agent** - 更新已有技能
                - **delete_agent** - 删除 pending/rejected 状态的技能

                ## 快捷场景

                - 「看看我的技能」→ 调用 list_my_agents
                - 「查看XXX详情」→ 调用 get_agent_detail
                - 「更新XXX」→ 调用 update_agent
                - 「删除XXX」→ 调用 delete_agent
                """;

    /**
     * 构建动态注册 Agent 的 AgentConfig
     */
    private AgentConfig buildDynamicAgentConfig(AgentRegistry entity) {
        List<ToolDefinition> tools = parseToolsFromJson(entity.getToolsJson());

        // 加载依赖 Skill 的工具（嵌套调用支持）
        List<String> dependsOn = parseDependsOn(entity.getDependsOn());
        if (!dependsOn.isEmpty()) {
            List<ToolDefinition> mergedTools = new java.util.ArrayList<>(tools);
            for (String depAgentId : dependsOn) {
                try {
                    AgentRegistry depEntity = findByAgentId(depAgentId);
                    if (depEntity != null && "active".equals(depEntity.getStatus())) {
                        List<ToolDefinition> depTools = parseToolsFromJson(depEntity.getToolsJson());
                        // 为依赖工具加前缀避免命名冲突
                        for (ToolDefinition dt : depTools) {
                            // 如果工具名已存在，跳过（优先使用本 Skill 的定义）
                            boolean exists = mergedTools.stream().anyMatch(t -> t.name().equals(dt.name()));
                            if (!exists) {
                                mergedTools.add(dt);
                                log.info("[AgentRegistry] Skill {} 继承依赖 Skill {} 的工具: {}", entity.getAgentId(), depAgentId, dt.name());
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[AgentRegistry] 加载依赖 Skill {} 的工具失败: {}", depAgentId, e.getMessage());
                }
            }
            tools = mergedTools;
        }

        // 构建工具执行器：根据工具的 executionMode 路由到不同执行方式
        final List<ToolDefinition> finalTools = tools;
        ToolExecutor executor = (toolName, argumentsJson) -> {
            // 1. 先检查是否是内置工具（如台账工具、agent-builder 工具）
            if (isBuiltinTool(toolName)) {
                return executeBuiltinTool(toolName, argumentsJson);
            }
            // 2. 检查执行方式：script:// 本地脚本 > HTTP 端点
            AgentDTO.ToolDef toolDef = findToolDef(entity.getToolsJson(), toolName);
            if (toolDef != null && toolDef.getEndpoint() != null && !toolDef.getEndpoint().isEmpty()) {
                String ep = toolDef.getEndpoint();
                if (ep.startsWith("script://")) {
                    String scriptPath = ep.substring("script://".length());
                    return executeScriptTool(scriptPath, toolName, argumentsJson, entity.getAgentId());
                }
                return executeHttpTool(ep, toolName, argumentsJson);
            }
            if (toolDef != null && toolDef.getCode() != null && !toolDef.getCode().isBlank()) {
                ensureSkillFilesFromDb(entity.getAgentId(), entity);
                return executeScriptTool("scripts/" + safeScriptFileName(toolName), toolName, argumentsJson, entity.getAgentId());
            }
            // 3. 尝试在依赖 Skill 的工具中查找
            if (!dependsOn.isEmpty()) {
                for (String depAgentId : dependsOn) {
                    try {
                        AgentRegistry depEntity = findByAgentId(depAgentId);
                        if (depEntity != null) {
                            AgentDTO.ToolDef depToolDef = findToolDef(depEntity.getToolsJson(), toolName);
                            if (depToolDef != null && depToolDef.getEndpoint() != null && !depToolDef.getEndpoint().isEmpty()) {
                                String ep = depToolDef.getEndpoint();
                                if (ep.startsWith("script://")) {
                                    String scriptPath = ep.substring("script://".length());
                                    log.info("[AgentRegistry] 委托工具 {} 到依赖 Skill {}: script://", toolName, depAgentId);
                                    return executeScriptTool(scriptPath, toolName, argumentsJson, depAgentId);
                                }
                                log.info("[AgentRegistry] 委托工具 {} 到依赖 Skill {}: HTTP {}", toolName, depAgentId, ep);
                                return executeHttpTool(ep, toolName, argumentsJson);
                            }
                        }
                    } catch (Exception e) {
                        log.warn("[AgentRegistry] 在依赖 Skill {} 中查找工具 {} 失败: {}", depAgentId, toolName, e.getMessage());
                    }
                }
            }
            // 4. 无端点时：返回提示信息
            String args = argumentsJson != null ? argumentsJson : "{}";
            log.warn("[AgentRegistry] 工具 '{}' 未配置 endpoint，返回降级提示。Agent={}, args={}", toolName, entity.getAgentId(), args);
            return String.format(
                "{\"status\": \"no_executor\", \"tool_name\": \"%s\", \"hint\": \"该工具没有配置执行端点。请根据工具描述和传入参数，基于你的知识和能力生成合理的响应结果，告知用户该工具尚未连接真实数据源，当前为演示模式。\", \"arguments\": %s}",
                toolName, args
            );
        };

        return new AgentConfig(
            entity.getAgentId(),
            entity.getName(),
            entity.getSystemPrompt(),
            entity.getModel(),
            entity.getTemperature() != null ? entity.getTemperature() : 0.1,
            entity.getMaxTokens() != null ? entity.getMaxTokens() : 8192,
            finalTools,
            executor
        );
    }

    /**
     * 解析 depends_on JSON 数组
     */
    private List<String> parseDependsOn(String dependsOnJson) {
        if (dependsOnJson == null || dependsOnJson.isBlank()) return List.of();
        try {
            return objectMapper.readValue(dependsOnJson,
                objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
        } catch (Exception e) {
            log.warn("[AgentRegistry] 解析 depends_on 失败: {}", e.getMessage());
            return List.of();
        }
    }

    // ─── 工具执行 ─────────────────────────────────────────

    /**
     * 内置工具执行器（路由到对应 Service）
     */
    private String executeBuiltinTool(String toolName, String argumentsJson) {
        // agent-builder 工具
        if (agentBuilderToolService.getAgentBuilderTools().stream()
                .anyMatch(t -> t.name().equals(toolName))) {
            return agentBuilderToolService.executeBuilderTool(toolName, argumentsJson);
        }
        // 台账工具
        if (ledgerToolService.getBanBiaoTools().stream()
                .anyMatch(t -> t.name().equals(toolName))) {
            String sessionId = com.aiplatform.backend.agent.AgentSessionContext.getSessionId();
            return ledgerToolService.executeBanBiaoTool(toolName, argumentsJson, sessionId);
        }
        return "{\"error\": \"未知内置工具: " + toolName + "\"}";
    }

    /**
     * HTTP 远程工具执行器
     */
    private String executeHttpTool(String endpoint, String toolName, String argumentsJson) {
        try {
            // 使用 WebClient 调用远程工具端点
            org.springframework.web.reactive.function.client.WebClient webClient =
                org.springframework.web.reactive.function.client.WebClient.create();

            Map<String, Object> body = Map.of(
                "tool_name", toolName,
                "arguments", objectMapper.readTree(argumentsJson)
            );

            String response = webClient.post()
                .uri(endpoint)
                .header("Content-Type", "application/json")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(String.class)
                .block();

            return response != null ? response : "{\"error\": \"远程工具返回空响应\"}";
        } catch (Exception e) {
            log.error("[AgentRegistry] HTTP 工具调用失败: {} - {}", toolName, e.getMessage(), e);
            return "{\"error\": \"远程工具调用失败: " + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    /**
     * 本地脚本工具执行器（通过 ProcessBuilder 执行 Python/Shell 脚本）
     * <p>
     * endpoint 格式：script://tool_name.py 或 script:///absolute/path/to/script.py
     * 脚本通过 stdin 接收 JSON：{"tool_name":"xxx","arguments":{...},"session_id":"xxx"}
     * 脚本通过 stdout 输出 JSON 结果
     */
    private String executeScriptTool(String scriptPath, String toolName, String argumentsJson, String agentId) {
        try {
            // 解析脚本路径：相对路径时从 skills_storage/{agentId}/ 下查找
            String resolvedPath = scriptPath;
            if (!Paths.get(scriptPath).isAbsolute() && agentId != null) {
                // 尝试 skills_storage/{agentId}/{scriptPath}
                Path p1 = Paths.get(SKILL_STORAGE_DIR, agentId, scriptPath);
                if (Files.exists(p1)) {
                    resolvedPath = p1.toString();
                } else {
                    // 尝试 skills_storage/{agentId}/scripts/{scriptPath}（去掉 scripts/ 前缀）
                    String fileName = scriptPath;
                    if (fileName.startsWith("scripts/")) {
                        fileName = fileName.substring("scripts/".length());
                    }
                    Path p2 = Paths.get(SKILL_STORAGE_DIR, agentId, "scripts", fileName);
                    if (Files.exists(p2)) {
                        resolvedPath = p2.toString();
                    } else {
                        // 文件不存在，使用最可能正确的路径
                        resolvedPath = p2.toString();
                        log.warn("[AgentRegistry] 脚本文件不存在: {} → {} (tool={})", scriptPath, resolvedPath, toolName);
                    }
                }
                log.info("[AgentRegistry] 脚本路径解析: {} → {} (tool={}, agent={})", scriptPath, resolvedPath, toolName, agentId);
            }

            // 构建命令：优先 python3，降级 python
            String pythonCmd = "python3";
            try {
                new ProcessBuilder(pythonCmd, "--version").start().waitFor();
            } catch (Exception e) {
                pythonCmd = "python";
            }

            // 查找 skill_runner.py 包装器（Coze 风格：自动安装缺失的 Python 依赖）
            String runnerPath = resolveRunnerPath();
            ProcessBuilder pb;
            if (runnerPath != null) {
                log.info("[AgentRegistry] 使用 skill_runner.py 包装执行: {} (tool={})", resolvedPath, toolName);
                pb = new ProcessBuilder(pythonCmd, runnerPath, "--script", resolvedPath);
            } else {
                // 降级：直接执行用户脚本（无自动安装）
                log.info("[AgentRegistry] skill_runner.py 未找到，直接执行脚本: {} (tool={})", resolvedPath, toolName);
                pb = new ProcessBuilder(pythonCmd, resolvedPath);
            }
            pb.environment().put("PYTHONIOENCODING", "utf-8");
            pb.environment().put("PYTHONUTF8", "1");

            // 传入参数：stdin 传 JSON
            String sessionId = com.aiplatform.backend.agent.AgentSessionContext.getSessionId();
            Map<String, Object> stdinData = new LinkedHashMap<>();
            stdinData.put("tool_name", toolName);
            stdinData.put("arguments", objectMapper.readTree(argumentsJson != null ? argumentsJson : "{}"));
            if (sessionId != null) {
                stdinData.put("session_id", sessionId);
            }
            String stdinStr = objectMapper.writeValueAsString(stdinData);

            pb.redirectErrorStream(false);  // 分离 stdout 和 stderr，避免 skill_runner 安装日志混入 JSON
            Process proc = pb.start();

            // 写 stdin
            try (java.io.OutputStream os = proc.getOutputStream();
                 java.io.Writer writer = new java.io.OutputStreamWriter(os, java.nio.charset.StandardCharsets.UTF_8)) {
                writer.write(stdinStr);
                writer.flush();
            }

            // 后台读取 stderr（防止缓冲区满导致进程阻塞）
            StringBuilder errBuf = new StringBuilder();
            Thread stderrThread = new Thread(() -> {
                try (java.io.BufferedReader errReader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(proc.getErrorStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = errReader.readLine()) != null) {
                        errBuf.append(line).append('\n');
                    }
                } catch (Exception ignored) {}
            });
            stderrThread.setDaemon(true);
            stderrThread.start();

            // 读 stdout
            StringBuilder out = new StringBuilder();
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(proc.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    out.append(line).append('\n');
                }
            }

            int exitCode = proc.waitFor();
            stderrThread.join(2000);  // 等待 stderr 读取完成
            String output = out.toString().trim();
            String stderrOutput = errBuf.toString().trim();

            if (!stderrOutput.isEmpty()) {
                log.info("[AgentRegistry] skill_runner stderr: {}", stderrOutput.substring(0, Math.min(1000, stderrOutput.length())));
            }

            if (exitCode != 0) {
                log.error("[AgentRegistry] 脚本执行失败: exitCode={}, tool={}, output={}, stderr={}", exitCode, toolName, output, stderrOutput);
                return String.format(
                    "{\"error\": \"脚本执行失败(exit=%d): %s\", \"tool_name\": \"%s\"}",
                    exitCode, (output + (stderrOutput.isEmpty() ? "" : " | stderr: " + stderrOutput)).replace("\"", "'").substring(0, Math.min(2000, output.length() + stderrOutput.length() + 20)), toolName
                );
            }

            if (output.isEmpty()) {
                return "{\"error\": \"脚本返回空输出\", \"tool_name\": \"" + toolName + "\"}";
            }

            // 验证输出是合法 JSON
            try {
                objectMapper.readTree(output);
                return output;
            } catch (Exception jsonErr) {
                // 不是 JSON，包装成 JSON
                return String.format("{\"result\": \"%s\"}",
                    output.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n"));
            }

        } catch (Exception e) {
            log.error("[AgentRegistry] 脚本工具调用失败: {} - {}", toolName, e.getMessage(), e);
            return "{\"error\": \"脚本工具调用失败: " + e.getMessage().replace("\"", "'") + "\", \"tool_name\": \"" + toolName + "\"}";
        }
    }

    /**
     * 判断是否是内置工具
     */
    private boolean isBuiltinTool(String toolName) {
        return ledgerToolService.getBanBiaoTools().stream()
                .anyMatch(t -> t.name().equals(toolName))
            || agentBuilderToolService.getAgentBuilderTools().stream()
                .anyMatch(t -> t.name().equals(toolName));
    }

    /**
     * 从 toolsJson 中查找 ToolDef
     */
    private AgentDTO.ToolDef findToolDef(String toolsJson, String toolName) {
        try {
            List<AgentDTO.ToolDef> tools = objectMapper.readValue(toolsJson,
                new TypeReference<List<AgentDTO.ToolDef>>() {});
            return tools.stream()
                .filter(t -> toolName.equals(t.getName()))
                .findFirst()
                .orElse(null);
        } catch (Exception e) {
            return null;
        }
    }

    // ─── 内置 Agent 初始化 ─────────────────────────────────

    /**
     * 确保内置 Agent 已写入数据库（含完整系统提示词、工具定义、图标等）
     */
    private void ensureBuiltinAgents() {
        for (Map.Entry<String, String> entry : BUILTIN_AGENTS.entrySet()) {
            String agentId = entry.getKey();
            AgentRegistry existing = findByAgentId(agentId);
            if (existing == null) {
                // 新建：写入完整信息
                AgentRegistry builtin = buildBuiltinRegistryEntity(agentId, entry.getValue());
                agentRegistryMapper.insert(builtin);
                log.info("[AgentRegistry] 内置 Agent 已初始化: {}", agentId);
            } else {
                // 已存在但信息不完整（旧版本写入的占位数据）→ 升级
                upgradeBuiltinIfNeeded(existing, agentId);
            }
        }
    }

    /**
     * 构建内置 Agent 的完整数据库记录
     */
    private AgentRegistry buildBuiltinRegistryEntity(String agentId, String name) {
        AgentRegistry entity = new AgentRegistry();
        entity.setAgentId(agentId);
        entity.setName(name);
        entity.setVersion("1.0.0");
        entity.setIsBuiltin(true);
        entity.setStatus("active");
        entity.setSortOrder(0);
        entity.setAuthor("System");

        // 按 agentId 填入完整信息
        switch (agentId) {
            case "ban-biao" -> {
                entity.setDescription("识别送货单/报表图片，查询千克表，匹配台账模板，生成标准台账 Excel 文件。支持图片、千克表、模板文件三种输入方式。");
                entity.setCategories("台账,OCR,文档生成");
                entity.setModel("gpt-4o");
                entity.setTemperature(0.1);
                entity.setMaxTokens(8192);
                entity.setSystemPrompt(BAN_BIAO_SYSTEM_PROMPT);
                entity.setToolsJson(toolsToJson(ledgerToolService.getBanBiaoTools().stream()
                    .map(t -> {
                        AgentDTO.ToolDef def = new AgentDTO.ToolDef();
                        def.setName(t.name());
                        def.setDescription(t.description());
                        try {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> paramsMap = objectMapper.treeToValue(t.parameters(), Map.class);
                            def.setParameters(paramsMap);
                        } catch (Exception e) {
                            def.setParameters(Map.of());
                        }
                        return def;
                    }).toList()));
                entity.setIcon("📋");
            }
            case "agent-builder" -> {
                entity.setDescription("通过对话帮助用户创建、编辑和管理 AI Agent，无需代码。");
                entity.setCategories("工具,开发助手");
                entity.setModel("gpt-4o");
                entity.setTemperature(0.3);
                entity.setMaxTokens(8192);
                entity.setSystemPrompt(AGENT_BUILDER_SYSTEM_PROMPT);
                entity.setToolsJson(toolsToJson(agentBuilderToolService.getAgentBuilderTools().stream()
                    .map(t -> {
                        AgentDTO.ToolDef def = new AgentDTO.ToolDef();
                        def.setName(t.name());
                        def.setDescription(t.description());
                        try {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> paramsMap = objectMapper.treeToValue(t.parameters(), Map.class);
                            def.setParameters(paramsMap);
                        } catch (Exception e) {
                            def.setParameters(Map.of());
                        }
                        return def;
                    }).toList()));
                entity.setIcon("🛠️");
            }
            default -> {
                entity.setDescription("内置 Agent：" + name);
                entity.setCategories("内置");
                entity.setModel("gpt-4o");
                entity.setTemperature(0.1);
                entity.setMaxTokens(8192);
                entity.setSystemPrompt("内置 Agent");
            }
        }
        entity.setDeleted(0); // 🔴 修复（第35轮）：内置 Agent 也必须设置 deleted=0
        return entity;
    }
    /*
     * 同时也用于强制更新系统提示词和工具定义到最新版本
     */
    private void upgradeBuiltinIfNeeded(AgentRegistry existing, String agentId) {
        boolean needsUpgrade = false;

        // 检查是否是旧版本的占位数据，或系统提示词/工具需要更新
        if ("内置 Agent".equals(existing.getSystemPrompt()) ||
            (existing.getDescription() != null && existing.getDescription().startsWith("内置 Agent：")) ||
            existing.getToolsJson() == null || existing.getToolsJson().isEmpty() || "[]".equals(existing.getToolsJson()) ||
            // 如果现有描述不包含"三种输入方式"，说明是旧版提示词，需要更新
            (agentId.equals("ban-biao") && existing.getDescription() != null &&
             !existing.getDescription().contains("三种输入方式")) ||
            // 如果系统提示词不包含最新的关键内容（batch_generate_ledger 一键工具），需要更新
            (agentId.equals("ban-biao") && existing.getSystemPrompt() != null &&
             (!existing.getSystemPrompt().contains("batch_generate_ledger") ||
              !existing.getSystemPrompt().contains("```tool"))) ||

            // agent-builder：检测旧版本提示词（含特定场景示例如排班查询 → 通用版）并自动升级
            (agentId.equals("agent-builder") && existing.getSystemPrompt() != null &&
             (existing.getSystemPrompt().contains("get_banbiao_data") ||
              existing.getSystemPrompt().contains("排班查询") ||
              existing.getSystemPrompt().contains("daily-schedule") ||
              existing.getSystemPrompt().contains("门店排班") ||
              !existing.getSystemPrompt().contains("通用的 Agent/Skill 开发助手"))) ||

            // agent-builder：检测工具定义缺少 icon_prompt 参数时升级
            (agentId.equals("agent-builder") && existing.getToolsJson() != null &&
             !existing.getToolsJson().contains("icon_prompt")) ||

            // agent-builder：检测系统提示词缺少 icon_prompt 说明时升级
            (agentId.equals("agent-builder") && existing.getSystemPrompt() != null &&
             !existing.getSystemPrompt().contains("icon_prompt"))
        ) {
            needsUpgrade = true;
        }

        if (!needsUpgrade) return;

        // 从完整定义中获取最新数据
        AgentRegistry fullEntity = buildBuiltinRegistryEntity(agentId, existing.getName());

        // 更新关键字段到最新版本
        existing.setSystemPrompt(fullEntity.getSystemPrompt());
        existing.setDescription(fullEntity.getDescription());
        existing.setToolsJson(fullEntity.getToolsJson());
        if (existing.getIcon() == null || existing.getIcon().isEmpty()) {
            existing.setIcon(fullEntity.getIcon());
        }
        if (existing.getCategories() == null || "内置".equals(existing.getCategories())) {
            existing.setCategories(fullEntity.getCategories());
        }
        if (existing.getTemperature() == null) {
            existing.setTemperature(fullEntity.getTemperature());
        }
        if (existing.getMaxTokens() == null) {
            existing.setMaxTokens(fullEntity.getMaxTokens());
        }

        agentRegistryMapper.updateById(existing);

        // 清除配置缓存，确保下次加载时使用新数据
        configCache.remove(agentId);

        log.info("[AgentRegistry] 内置 Agent 已升级到最新版本: {}", agentId);
    }

    // ─── 统一工具执行 API（供 UnifiedToolService 调用）─────

    /**
     * 跨所有 active/approved Agent 查找并执行工具
     * <p>
     * 搜索顺序：先查当前 Agent 的工具 → 再查依赖 Skill 的工具
     *
     * @param toolName      工具名
     * @param argumentsJson 参数 JSON 字符串
     * @return 执行结果 JSON 字符串，找不到工具返回 error JSON
     */
    public String executeToolByName(String toolName, String argumentsJson) {
        // 1. 内置工具
        if (isBuiltinTool(toolName)) {
            return executeBuiltinTool(toolName, argumentsJson);
        }

        // 2. 搜索所有 active/approved Agent
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
        );

        for (AgentRegistry entity : agents) {
            AgentDTO.ToolDef toolDef = findToolDef(entity.getToolsJson(), toolName);
            if (toolDef != null && toolDef.getEndpoint() != null && !toolDef.getEndpoint().isEmpty()) {
                String ep = toolDef.getEndpoint();
                if (ep.startsWith("script://")) {
                    String scriptPath = ep.substring("script://".length());
                    log.info("[AgentRegistry] executeToolByName: {} → script:// {} (Agent: {})",
                            toolName, scriptPath, entity.getAgentId());
                    return executeScriptTool(scriptPath, toolName, argumentsJson, entity.getAgentId());
                }
                log.info("[AgentRegistry] executeToolByName: {} → HTTP {} (Agent: {})",
                        toolName, ep, entity.getAgentId());
                return executeHttpTool(ep, toolName, argumentsJson);
            }
            if (toolDef != null && toolDef.getCode() != null && !toolDef.getCode().isBlank()) {
                ensureSkillFilesFromDb(entity.getAgentId(), entity);
                return executeScriptTool("scripts/" + safeScriptFileName(toolName), toolName, argumentsJson, entity.getAgentId());
            }
        }

        // 3. 在依赖 Skill 中查找
        for (AgentRegistry entity : agents) {
            List<String> dependsOn = parseDependsOn(entity.getDependsOn());
            if (dependsOn != null && !dependsOn.isEmpty()) {
                for (String depAgentId : dependsOn) {
                    try {
                        AgentRegistry depEntity = findByAgentId(depAgentId);
                        if (depEntity != null && depEntity.getStatus() != null
                                && ("active".equals(depEntity.getStatus()) || "approved".equals(depEntity.getStatus()))) {
                            AgentDTO.ToolDef depToolDef = findToolDef(depEntity.getToolsJson(), toolName);
                            if (depToolDef != null && depToolDef.getEndpoint() != null && !depToolDef.getEndpoint().isEmpty()) {
                                String ep = depToolDef.getEndpoint();
                                if (ep.startsWith("script://")) {
                                    String scriptPath = ep.substring("script://".length());
                                    return executeScriptTool(scriptPath, toolName, argumentsJson, depAgentId);
                                }
                                return executeHttpTool(ep, toolName, argumentsJson);
                            }
                        }
                    } catch (Exception e) {
                        log.warn("[AgentRegistry] 在依赖 Skill {} 中查找工具 {} 失败: {}", depAgentId, toolName, e.getMessage());
                    }
                }
            }
        }

        return "{\"error\": \"未找到工具: " + toolName + "\"}";
    }

    /**
     * 判断任意 active/approved Agent 是否拥有指定工具
     */
    public boolean hasAgentTool(String toolName) {
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
        );
        for (AgentRegistry entity : agents) {
            AgentDTO.ToolDef toolDef = findToolDef(entity.getToolsJson(), toolName);
            if (toolDef != null && toolDef.getEndpoint() != null && !toolDef.getEndpoint().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    // ─── 辅助方法 ─────────────────────────────────────────

    public AgentRegistry findByAgentId(String agentId) {
        return agentRegistryMapper.selectOne(
            new LambdaQueryWrapper<AgentRegistry>()
                .eq(AgentRegistry::getAgentId, agentId)
        );
    }

    public boolean isOwnerOrAdmin(AgentRegistry entity, Long userId) {
        if (userId == null) return false;
        return entity.getCreatedBy() != null && entity.getCreatedBy().equals(userId);
    }

    /**
     * 更新 Agent 的开发者分成比例（管理员操作）
     */
    @Transactional
    public void updateRevenueRatio(String agentId, java.math.BigDecimal ratio, Long adminUserId) {
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) throw new RuntimeException("Agent 不存在: " + agentId);
        if (ratio.compareTo(java.math.BigDecimal.ZERO) < 0 || ratio.compareTo(java.math.BigDecimal.ONE) > 0) {
            throw new RuntimeException("分成比例必须在 0 ~ 1 之间");
        }
        entity.setRevenueRatio(ratio);
        agentRegistryMapper.updateById(entity);
        log.info("[AgentRegistry] Agent {} 分成比例已更新为 {} by admin {}", agentId, ratio, adminUserId);
    }

    private String generateApiKey() {
        return "agk_" + UUID.randomUUID().toString().replace("-", "").substring(0, 24);
    }

    private AgentRegistry toEntity(AgentDTO.RegisterRequest req, Long userId) {
        AgentRegistry entity = new AgentRegistry();
        entity.setAgentId(req.getAgentId());
        entity.setName(req.getName());
        entity.setVersion(req.getVersion() != null ? req.getVersion() : "1.0.0");
        entity.setDescription(req.getDescription());
        entity.setCategories(req.getCategories() != null ? String.join(",", req.getCategories()) : null);
        entity.setModel(req.getModel() != null ? req.getModel() : "gpt-4o");
        entity.setTemperature(req.getTemperature() != null ? req.getTemperature() : 0.1);
        entity.setMaxTokens(req.getMaxTokens() != null ? req.getMaxTokens() : 8192);
        entity.setSystemPrompt(req.getSystemPrompt());
        entity.setToolsJson(toolsToJson(req.getTools()));
        entity.setDependsOn(req.getDependsOn() != null && !req.getDependsOn().isEmpty()
            ? toJsonSafe(req.getDependsOn()) : null);
        entity.setHooksJson(req.getHooks() != null ? toJsonSafe(req.getHooks()) : null);
        entity.setIcon(req.getIcon());
        entity.setAuthor(req.getAuthor());
        entity.setStatus(req.getStatus() != null ? req.getStatus() : "pending");
        entity.setSortOrder(100);
        entity.setCreatedBy(userId);
        entity.setScreenshots(req.getScreenshots() != null ? toJsonSafe(req.getScreenshots()) : null);
        entity.setUsageGuide(req.getUsageGuide());
        // 🔴 修复（第35轮）：必须设置 deleted=0，否则 @TableLogic 逻辑删除过滤器
        // 会自动在所有查询中添加 WHERE deleted=0，导致 NULL 记录无法被查询到
        // → 发布后审核列表为空、技能商店看不到该技能
        entity.setDeleted(0);
        entity.setRevenueRatio(new java.math.BigDecimal("0.3000"));
        entity.setTotalUsage(0L);
        entity.setTotalRevenue(java.math.BigDecimal.ZERO);
        return entity;
    }

    private AgentDTO.AgentListItem toListItem(AgentRegistry entity) {
        AgentDTO.AgentListItem item = new AgentDTO.AgentListItem();
        item.setId(entity.getId());
        item.setAgentId(entity.getAgentId());
        item.setName(entity.getName());
        item.setVersion(entity.getVersion());
        item.setDescription(entity.getDescription());
        item.setCategories(entity.getCategories() != null
            ? Arrays.asList(entity.getCategories().split(",")) : List.of());
        item.setModel(entity.getModel());
        item.setIcon(entity.getIcon());
        item.setAuthor(entity.getAuthor());
        item.setStatus(entity.getStatus());
        item.setIsBuiltin(entity.getIsBuiltin());
        item.setToolCount(countTools(entity.getToolsJson()));
        item.setTotalUsage(entity.getTotalUsage() != null ? entity.getTotalUsage() : 0L);
        item.setAvgRating(entity.getAvgRating() != null ? entity.getAvgRating() : java.math.BigDecimal.ZERO);
        item.setRatingCount(entity.getRatingCount() != null ? entity.getRatingCount() : 0);
        item.setRevenueRatio(entity.getRevenueRatio());
        item.setReviewComment(entity.getReviewComment());
        item.setReviewedAt(formatDateTime(entity.getReviewedAt()));
        item.setCreatedAt(formatDateTime(entity.getCreatedAt()));
        return item;
    }

    private AgentDTO.AgentDetail toDetail(AgentRegistry entity) {
        AgentDTO.AgentDetail detail = new AgentDTO.AgentDetail();
        detail.setId(entity.getId());
        detail.setAgentId(entity.getAgentId());
        detail.setName(entity.getName());
        detail.setVersion(entity.getVersion());
        detail.setDescription(entity.getDescription());
        detail.setCategories(entity.getCategories() != null
            ? Arrays.asList(entity.getCategories().split(",")) : List.of());
        detail.setModel(entity.getModel());
        detail.setTemperature(entity.getTemperature());
        detail.setMaxTokens(entity.getMaxTokens());
        detail.setSystemPrompt(entity.getSystemPrompt());
        detail.setTools(parseToolDefsForDetail(entity.getToolsJson()));
        detail.setHooks(parseHooksFromJson(entity.getHooksJson()));
        detail.setIcon(entity.getIcon());
        detail.setAuthor(entity.getAuthor());
        detail.setStatus(entity.getStatus());
        detail.setIsBuiltin(entity.getIsBuiltin());
        detail.setSortOrder(entity.getSortOrder());
        detail.setScreenshots(entity.getScreenshots() != null
            ? parseScreenshots(entity.getScreenshots()) : List.of());
        detail.setUsageGuide(entity.getUsageGuide());
        detail.setRevenueRatio(entity.getRevenueRatio());
        detail.setTotalUsage(entity.getTotalUsage() != null ? entity.getTotalUsage() : 0L);
        detail.setAvgRating(entity.getAvgRating() != null ? entity.getAvgRating() : java.math.BigDecimal.ZERO);
        detail.setRatingCount(entity.getRatingCount() != null ? entity.getRatingCount() : 0);
        detail.setTotalRevenue(entity.getTotalRevenue());
        detail.setReviewComment(entity.getReviewComment());
        detail.setReviewedBy(entity.getReviewedBy());
        detail.setReviewedAt(formatDateTime(entity.getReviewedAt()));
        detail.setCreatedBy(entity.getCreatedBy());
        detail.setCreatedAt(formatDateTime(entity.getCreatedAt()));
        detail.setUpdatedAt(formatDateTime(entity.getUpdatedAt()));
        return detail;
    }

    private List<AgentDTO.ToolDef> parseToolDefsForDetail(String toolsJson) {
        if (toolsJson == null || toolsJson.isEmpty()) return List.of();
        try {
            return objectMapper.readValue(toolsJson,
                new TypeReference<List<AgentDTO.ToolDef>>() {});
        } catch (Exception e) {
            log.error("[AgentRegistry] 解析 toolsJson 失败: {}", e.getMessage());
            return List.of();
        }
    }

    private List<ToolDefinition> parseToolsFromJson(String toolsJson) {
        if (toolsJson == null || toolsJson.isEmpty()) return List.of();
        try {
            List<AgentDTO.ToolDef> toolDefs = objectMapper.readValue(toolsJson,
                new TypeReference<List<AgentDTO.ToolDef>>() {});
            return toolDefs.stream()
                .map(def -> {
                    // 确保 parameters 符合 OpenAI Function Calling 格式
                    Map<String, Object> params;
                    if (def.getParameters() != null) {
                        params = new HashMap<>(def.getParameters()); // 复制避免修改原对象
                    } else {
                        params = new HashMap<>();
                    }
                    // 确保 type = "object"（AI API 严格要求）
                    if (!params.containsKey("type") || params.get("type") == null) {
                        params.put("type", "object");
                    }
                    // 确保有 properties（至少为空对象）
                    if (!params.containsKey("properties")) {
                        params.put("properties", new HashMap<>());
                    }
                    return ToolDefinition.of(def.getName(), def.getDescription(), params);
                })
                .toList();
        } catch (Exception e) {
            log.error("[AgentRegistry] 解析 toolsJson 失败: {}", e.getMessage());
            return List.of();
        }
    }

    private AgentDTO.HooksDef parseHooksFromJson(String hooksJson) {
        if (hooksJson == null || hooksJson.isEmpty()) return null;
        try {
            return objectMapper.readValue(hooksJson, AgentDTO.HooksDef.class);
        } catch (Exception e) {
            return null;
        }
    }

    private String toolsToJson(List<AgentDTO.ToolDef> tools) {
        if (tools == null || tools.isEmpty()) return "[]";
        normalizeToolEndpoints(tools);
        return toJsonSafe(tools);
    }

    private void normalizeToolEndpoints(List<AgentDTO.ToolDef> tools) {
        for (AgentDTO.ToolDef tool : tools) {
            if (tool == null || tool.getName() == null || tool.getName().isBlank()) continue;
            String endpoint = tool.getEndpoint();
            if ((endpoint == null || endpoint.isBlank()) && tool.getCode() != null && !tool.getCode().isBlank()) {
                tool.setEndpoint("script://scripts/" + safeScriptFileName(tool.getName()));
                if (tool.getExecutionMode() == null || tool.getExecutionMode().isBlank()) {
                    tool.setExecutionMode("local");
                }
            } else if (endpoint != null && endpoint.startsWith("script://")) {
                String scriptPath = endpoint.substring("script://".length());
                if (!scriptPath.isBlank() && !Paths.get(scriptPath).isAbsolute()) {
                    tool.setEndpoint("script://" + normalizeRelativeScriptPath(scriptPath));
                }
                if (tool.getExecutionMode() == null || tool.getExecutionMode().isBlank()) {
                    tool.setExecutionMode("local");
                }
            }
        }
    }

    private String toJsonSafe(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }

    private int countTools(String toolsJson) {
        if (toolsJson == null || toolsJson.isEmpty()) return 0;
        try {
            return objectMapper.readTree(toolsJson).size();
        } catch (Exception e) {
            return 0;
        }
    }

    @SuppressWarnings("unchecked")
    private List<String> parseScreenshots(String screenshotsJson) {
        if (screenshotsJson == null || screenshotsJson.isEmpty()) return List.of();
        try {
            return objectMapper.readValue(screenshotsJson, List.class);
        } catch (Exception e) {
            return List.of();
        }
    }

    private String formatDateTime(LocalDateTime dt) {
        return dt != null ? dt.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME) : null;
    }

    /**
     * 清除指定 Agent 的配置缓存
     */
    public void evictCache(String agentId) {
        configCache.remove(agentId);
    }

    /**
     * 清除所有缓存
     */
    public void evictAllCache() {
        configCache.clear();
    }

    /**
     * 定时清理缓存，防止长期运行后 OOM。
     * 每 30 分钟清空一次。缓存重建成本低（数据库查一次），不保留太久。
     */
    @Scheduled(fixedRate = 30 * 60 * 1000)
    public void scheduledCacheCleanup() {
        if (configCache.size() > 10) {
            log.info("[AgentRegistry] 定时清理 configCache，清理前大小={}", configCache.size());
            evictAllCache();
        }
    }

    // ─── 技能ZIP导入 ─────────────────────────────────────

    /**
     * 从ZIP文件导入技能包
     * <p>
     * ZIP结构：
     * - SKILL.md（系统提示词）
     * - scripts/*.py 或 scripts/*.sh（工具脚本）
     * - package.json（可选）
     */
    @Transactional
    public java.util.Map<String, Object> importFromZip(
            org.springframework.web.multipart.MultipartFile file, Long userId) throws Exception {

        java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
        String filename = file.getOriginalFilename();

        if (filename == null || !filename.endsWith(".zip")) {
            result.put("success", false);
            result.put("message", "只支持ZIP文件");
            return result;
        }

        // 1. 解析ZIP（含格式校验，不合法会抛异常）
        AgentRegistry entity = parseSkillZipToEntity(file);

        // 2. 生成agentId（从文件名）
        String baseName = filename.replaceAll("(?i)\\.zip$", "");
        // 去掉可能的 skill-/xiaping- 前缀避免重复叠加
        String cleanName = baseName.replaceFirst("^(skill|agent)[-_]", "");
        String sanitized = sanitizeAgentId(cleanName);
        String agentId;
        if (baseName.matches(".*[0-9a-f]{8}-[0-9a-f]{4}.*")) {
            // UUID格式，直接取最后一段
            agentId = "skill-" + baseName.substring(Math.max(0, baseName.length() - 36));
        } else {
            agentId = "skill-" + sanitized;
        }

        // 检查是否已存在
        entity.setAgentId(agentId);
        ensureGeneratedIcon(entity);
        AgentRegistry existing = findByAgentId(agentId);
        if (existing != null) {
            // 已存在则更新
            entity.setId(existing.getId());
            entity.setAgentId(agentId);
            entity.setStatus(existing.getStatus());
            entity.setIsBuiltin(existing.getIsBuiltin());
            entity.setCreatedAt(existing.getCreatedAt());
            // 如果原记录 created_by 为空但当前有 userId，则补上
            if (existing.getCreatedBy() == null && userId != null) {
                entity.setCreatedBy(userId);
            }
            agentRegistryMapper.updateById(entity);
            result.put("action", "updated");
            log.info("[AgentRegistry] 更新已有技能: {} (来自: {})", agentId, filename);
        } else {
            // 清理同名的逻辑删除记录，释放唯一约束
            agentRegistryMapper.physicallyDeleteSoftDeleted(agentId);

            entity.setAgentId(agentId);
            entity.setIsBuiltin(false);
            entity.setStatus("pending");  // 走审核流程，与其他创建方式一致
            entity.setCreatedBy(userId);  // 确保设置创建者，使其出现在"我的技能"中
            entity.setRevenueRatio(new java.math.BigDecimal("0.3000"));
            entity.setTotalUsage(0L);
            entity.setTotalRevenue(java.math.BigDecimal.ZERO);
            entity.setSortOrder(100);
            try {
                agentRegistryMapper.insert(entity);
            } catch (org.springframework.dao.DataIntegrityViolationException e) {
                throw new RuntimeException("技能 ID '" + agentId + "' 创建失败：可能存在同名残留记录，请更换文件名或联系管理员");
            }
            result.put("action", "created");
            log.info("[AgentRegistry] 导入新技能（待审核）: {} (来自: {})", agentId, filename);
        }

        result.put("success", true);
        result.put("agentId", agentId);
        result.put("name", entity.getName());
        result.put("icon", entity.getIcon());
        result.put("message", "技能导入成功，已提交审核（审核通过后将在技能市场上线）");

        // 3. 保存原始 ZIP 到硬盘（供下载时使用完整包）
        saveOriginalZip(file, agentId);

        // 4. 确保技能脚本文件写入磁盘（从 toolsJson 的 code 字段提取到 scripts/ 目录）
        try {
            ensureSkillFilesFromDb(agentId, entity);
        } catch (Exception e) {
            log.warn("[AgentRegistry] ZIP导入后写入技能文件失败（不影响数据库记录）: {} - {}", agentId, e.getMessage());
        }

        // 5. 安装技能到「我的技能」（如果提供了 userId）
        if (userId != null) {
            try {
                installSkill(userId, agentId);
                log.info("[AgentRegistry] ZIP导入后自动安装到我的技能: userId={}, agentId={}", userId, agentId);
            } catch (Exception e) {
                log.warn("[AgentRegistry] ZIP导入后自动安装失败: {} - {}", agentId, e.getMessage());
            }
        }

        return result;
    }

    // 技能文件存储目录（OSS 未配置时的本地降级路径）
    private static final String SKILL_STORAGE_DIR = "skills_storage";
    // 技能脚本包装器（Coze 风格：运行时自动安装缺失的 Python 依赖）
    private static final String SKILL_RUNNER_SCRIPT = "skill_runner.py";

    /**
     * 解析 skill_runner.py 的路径。
     * 查找顺序：工作目录 → JAR 所在目录的上级（开发环境 backend/ 目录）
     * 返回 null 表示未找到，调用方应降级为直接执行脚本。
     */
    private String resolveRunnerPath() {
        // 1. 当前工作目录
        Path p1 = Paths.get(SKILL_RUNNER_SCRIPT);
        if (Files.exists(p1)) {
            return p1.toAbsolutePath().toString();
        }

        // 2. JAR 所在目录的上级（开发环境：target/ → backend/）
        try {
            String jarPath = getClass().getProtectionDomain().getCodeSource().getLocation().getPath();
            Path jarDir = Paths.get(jarPath);
            // 如果是 target/ 目录，尝试上级目录
            if (jarDir.getFileName() != null && "target".equals(jarDir.getFileName().toString())) {
                Path projectRoot = jarDir.getParent();
                if (projectRoot != null) {
                    Path p2 = projectRoot.resolve(SKILL_RUNNER_SCRIPT);
                    if (Files.exists(p2)) {
                        return p2.toString();
                    }
                }
            }
            // JAR 同级目录（生产环境使用 deploy-muhuochat.sh 将 skill_runner.py 放在 JAR 旁边）
            Path jarParent = jarDir.getParent();
            if (jarParent != null) {
                Path p3 = jarParent.resolve(SKILL_RUNNER_SCRIPT);
                if (Files.exists(p3)) {
                    return p3.toString();
                }
            }
        } catch (Exception ignored) {
            // 无法获取 JAR 路径，忽略
        }

        return null;
    }
    // OSS 对象 Key 前缀
    private static final String SKILL_OSS_KEY_PREFIX = "skills/";

    // ── OSS 辅助 ──

    /** 尝试将 ZIP 上传到 OSS；返回 true 表示成功 */
    private boolean trySaveZipToOss(byte[] zipBytes, String agentId) {
        try {
            var ossService = com.aiplatform.backend.service.impl.OssServiceFactory.getActive();
            if (ossService == null) return false;
            String objectKey = SKILL_OSS_KEY_PREFIX + agentId + ".zip";
            ossService.upload(objectKey, zipBytes, "application/zip");
            log.info("[AgentRegistry] ZIP已上传到OSS: {}", objectKey);
            return true;
        } catch (Exception e) {
            log.warn("[AgentRegistry] OSS上传失败，将降级为本地存储: {}", e.getMessage());
            return false;
        }
    }

    /** 尝试从 OSS 下载 ZIP；返回 null 表示 OSS 不可用或文件不存在 */
    private byte[] tryLoadZipFromOss(String agentId) {
        try {
            var ossService = com.aiplatform.backend.service.impl.OssServiceFactory.getActive();
            if (ossService == null) return null;
            String objectKey = SKILL_OSS_KEY_PREFIX + agentId + ".zip";
            byte[] bytes = ossService.download(objectKey);
            if (bytes != null && bytes.length > 0) {
                log.info("[AgentRegistry] 从OSS读取ZIP: {} ({} 字节)", objectKey, bytes.length);
                return bytes;
            }
        } catch (Exception e) {
            log.warn("[AgentRegistry] OSS读取失败，将尝试本地: {}", e.getMessage());
        }
        return null;
    }

    // ── 公开 API ──

    private void saveOriginalZip(org.springframework.web.multipart.MultipartFile file, String agentId) {
        try {
            byte[] zipBytes = file.getBytes();
            if (trySaveZipToOss(zipBytes, agentId)) return;
        } catch (Exception e) {
            log.warn("[AgentRegistry] 读取上传文件失败: {}", e.getMessage());
        }
        // OSS 未配置或失败 → 本地降级
        try {
            Path dir = Paths.get(SKILL_STORAGE_DIR);
            Files.createDirectories(dir);
            Path target = dir.resolve(agentId + ".zip");
            try (InputStream in = file.getInputStream();
                 FileOutputStream out = new FileOutputStream(target.toFile())) {
                byte[] buf = new byte[8192];
                int len;
                while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
            }
            log.info("[AgentRegistry] 原始ZIP已保存到本地: {}", target);
        } catch (Exception e) {
            log.warn("[AgentRegistry] 保存原始ZIP失败: {}", e.getMessage());
        }
    }

    /**
     * 保存技能 ZIP 字节数组（优先存 OSS，降级到本地）
     */
    public void saveZipBytes(String agentId, byte[] zipBytes) {
        if (trySaveZipToOss(zipBytes, agentId)) return;
        try {
            Path dir = Paths.get(SKILL_STORAGE_DIR);
            Files.createDirectories(dir);
            Path target = dir.resolve(agentId + ".zip");
            Files.write(target, zipBytes);
            log.info("[AgentRegistry] 动态ZIP已保存到本地: {} ({} 字节)", target, zipBytes.length);
        } catch (Exception e) {
            log.warn("[AgentRegistry] 保存动态ZIP失败: {}", e.getMessage());
        }
    }

    /**
     * 获取技能 ZIP 字节数组（优先 OSS，降级本地）
     * 替代 {@link #getStoredZipPath}，支持 OSS 存储
     */
    public byte[] getZipBytes(String agentId) {
        byte[] ossBytes = tryLoadZipFromOss(agentId);
        if (ossBytes != null) return ossBytes;
        Path stored = Paths.get(SKILL_STORAGE_DIR, agentId + ".zip");
        if (Files.exists(stored)) {
            try {
                return Files.readAllBytes(stored);
            } catch (Exception e) {
                log.warn("[AgentRegistry] 本地ZIP读取失败: {}", e.getMessage());
            }
        }
        return null;
    }

    /** @deprecated 使用 {@link #getZipBytes(String)} 替代 */
    public Path getStoredZipPath(String agentId) {
        Path p = Paths.get(SKILL_STORAGE_DIR, agentId + ".zip");
        return Files.exists(p) ? p : null;
    }

    /**
     * 解析ZIP文件，创建AgentRegistry实体
     */
    private AgentRegistry parseSkillZipToEntity(
            org.springframework.web.multipart.MultipartFile file) throws Exception {

        AgentRegistry entity = new AgentRegistry();
        // 默认值，会被 SKILL.md frontmatter 覆盖
        entity.setVersion("1.0.0");
        entity.setTemperature(0.1);
        entity.setMaxTokens(8192);
        entity.setIcon("📦");

        try (java.util.zip.ZipInputStream zis = new java.util.zip.ZipInputStream(
                file.getInputStream(), java.nio.charset.StandardCharsets.UTF_8)) {

            java.util.zip.ZipEntry entry;
            java.util.Map<String, String> scripts = new java.util.LinkedHashMap<>();
            java.util.List<String> allFiles = new java.util.ArrayList<>();
            StringBuilder skillMdContent = new StringBuilder();
            String packageJsonContent = null;

            while ((entry = zis.getNextEntry()) != null) {
                String entryName = entry.getName().replace('\\', '/');

                // 跳过目录
                if (entry.isDirectory()) continue;

                // 跳过 macOS 垃圾文件
                if (entryName.contains("__MACOSX") || entryName.contains(".DS_Store") ||
                    entryName.startsWith(".")) continue;

                allFiles.add(entryName);

                // 查找SKILL.md（支持任意大小写、任意路径层级）
                String lowered = entryName.toLowerCase();
                if (lowered.endsWith("skill.md") || lowered.endsWith("skool.md")) {
                    skillMdContent.append(readZipEntry(zis));
                }
                // 读取 package.json
                else if (lowered.endsWith("package.json")) {
                    packageJsonContent = readZipEntry(zis);
                }
                // 收集脚本文件（同时读取内容，用于写入 toolsJson 的 code 字段）
                else if (lowered.endsWith(".py") || lowered.endsWith(".sh") || lowered.endsWith(".js")) {
                    String scriptContent = readZipEntry(zis);
                    scripts.put(normalizeRelativeScriptPath(entryName), scriptContent);
                }
                // 收集 assets 文件
                else if (lowered.contains("assets/") || lowered.contains("references/")) {
                    // 已通过 skip 跳过
                }
            }

            // 校验：必须包含 SKILL.md
            if (skillMdContent.isEmpty()) {
                log.warn("[SkillImport] ZIP中未找到SKILL.md，文件列表: {}", allFiles);
                throw new IllegalArgumentException("ZIP中未找到SKILL.md文件。技能包必须包含SKILL.md作为入口文件。");
            }

            // 解析 SKILL.md
            String fullContent = skillMdContent.toString();
            parseSkillMdToEntity(fullContent, entity, scripts, file.getOriginalFilename());

            // 如果 SKILL.md 没有设置 author/categories/model，尝试从 package.json 读取
            if (packageJsonContent != null) {
                applyPackageJson(packageJsonContent, entity);
            }

            // 最终校验：名称和作者不能为空
            if (entity.getName() == null || entity.getName().isBlank()) {
                entity.setName(file.getOriginalFilename() != null
                    ? file.getOriginalFilename().replaceAll("(?i)\\.zip$", "")
                    : "未命名技能");
            }
            if (entity.getAuthor() == null || entity.getAuthor().isBlank()) {
                entity.setAuthor("未知");
            }
            if (entity.getCategories() == null || entity.getCategories().isBlank()) {
                entity.setCategories("工具");
            }
            if (entity.getModel() == null || entity.getModel().isBlank()) {
                entity.setModel("gpt-4o");
            }
        }
        // 🔴 修复（第35轮）：ZIP导入也必须设置 deleted=0
        entity.setDeleted(0);
        return entity;
    }

    /**
     * 读取ZIP条目内容（带大小限制，防止压缩炸弹 OOM）
     */
    private static final int MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024; // 单个条目最大 5MB

    private String readZipEntry(java.util.zip.ZipInputStream zis) throws java.io.IOException {
        java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int len;
        int total = 0;
        while ((len = zis.read(buf)) > 0) {
            total += len;
            if (total > MAX_ZIP_ENTRY_BYTES) {
                throw new java.io.IOException("ZIP条目过大（>" + MAX_ZIP_ENTRY_BYTES / 1024 / 1024
                    + "MB），可能存在压缩炸弹风险，拒绝解压。当前已读取 " + total + " bytes");
            }
            baos.write(buf, 0, len);
        }
        return baos.toString(java.nio.charset.StandardCharsets.UTF_8);
    }

    /**
     * 从SKILL.md内容中提取信息，支持YAML frontmatter
     */
    private void parseSkillMdToEntity(String content, AgentRegistry entity,
                                       java.util.Map<String, String> scripts, String filename) {
        entity.setSystemPrompt(content);
        entity.setUsageGuide("【使用说明】\n1. 此技能已导入完整内容\n2. 可以直接在对话中调用");

        // ── 1. 尝试解析 YAML frontmatter ──
        String afterFrontmatter = parseFrontmatter(content, entity);

        // ── 2. 从 Markdown 标题提取未设置字段 ──
        String[] lines = afterFrontmatter.split("\n");

        if (entity.getName() == null || entity.getName().isBlank()) {
            for (String line : lines) {
                if (line.startsWith("# ") && line.length() > 2) {
                    entity.setName(line.substring(2).trim());
                    break;
                }
            }
        }

        if (entity.getDescription() == null || entity.getDescription().isBlank()) {
            StringBuilder desc = new StringBuilder();
            boolean started = false;
            for (String line : lines) {
                String trimmed = line.trim();
                if (trimmed.startsWith("#")) continue;
                if (trimmed.isEmpty()) { if (started) break; continue; }
                started = true;
                desc.append(trimmed).append(" ");
                if (desc.length() > 500) break;
            }
            entity.setDescription(desc.toString().trim());
        }

        // ── 3. 构建工具定义 ──
        if (!scripts.isEmpty()) {
            java.util.List<java.util.Map<String, Object>> tools = new java.util.ArrayList<>();
            for (java.util.Map.Entry<String, String> scriptEntry : scripts.entrySet()) {
                String scriptPath = scriptEntry.getKey();
                String scriptCode = scriptEntry.getValue();
                java.util.Map<String, Object> tool = new java.util.LinkedHashMap<>();
                String toolName = scriptPath.replaceAll("^scripts/", "")
                    .replaceAll("\\.(py|sh|js)$", "")
                    .replaceAll("[^a-zA-Z0-9_-]", "_");
                tool.put("name", toolName);
                tool.put("description", "从技能包脚本: " + scriptPath);
                tool.put("endpoint", "script://" + scriptPath);
                tool.put("code", scriptCode);
                tool.put("parameters", java.util.Map.of(
                    "type", "object",
                    "properties", java.util.Map.of(),
                    "required", java.util.List.of()
                ));
                tools.add(tool);
            }
            entity.setToolsJson(toJsonSafe(tools));
        } else {
            try {
                entity.setToolsJson(extractToolsFromMarkdown(content));
            } catch (Exception e) {
                log.warn("[SkillImport] 从 Markdown 提取工具失败，使用空工具列表: {}", e.getMessage());
                entity.setToolsJson("[]");
            }
        }
    }

    /**
     * 解析 YAML frontmatter (--- ... ---)，返回 frontmatter 之后的内容
     */
    private String parseFrontmatter(String content, AgentRegistry entity) {
        String trimmed = content.trim();
        if (!trimmed.startsWith("---")) return content;

        int secondDelim = trimmed.indexOf("---", 3);
        if (secondDelim < 0) return content;

        String fm = trimmed.substring(3, secondDelim).trim();
        String after = trimmed.substring(secondDelim + 3).trim();

        for (String line : fm.split("\n")) {
            int colon = line.indexOf(':');
            if (colon < 0) continue;
            String key = line.substring(0, colon).trim().toLowerCase();
            String value = line.substring(colon + 1).trim();
            // 移除引号
            if ((value.startsWith("\"") && value.endsWith("\"")) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length() - 1);
            }

            switch (key) {
                case "name":
                    entity.setName(value);
                    break;
                case "description":
                    entity.setDescription(value);
                    break;
                case "version":
                    entity.setVersion(value);
                    break;
                case "author":
                    entity.setAuthor(value);
                    break;
                case "categories":
                case "category":
                    // 支持 [a, b, c] 或 a, b, c 格式
                    value = value.replaceAll("[\\[\\]\"]", "").trim();
                    entity.setCategories(value);
                    break;
                case "model":
                    entity.setModel(value);
                    break;
                case "icon":
                    entity.setIcon(value);
                    break;
            }
        }
        return after;
    }

    /**
     * 从 package.json 补充未设置的字段
     */
    private void applyPackageJson(String jsonContent, AgentRegistry entity) {
        try {
            com.fasterxml.jackson.databind.JsonNode node = objectMapper.readTree(jsonContent);
            if (entity.getName() == null || entity.getName().isBlank()) {
                if (node.has("name")) entity.setName(node.get("name").asText());
            }
            if (entity.getDescription() == null || entity.getDescription().isBlank()) {
                if (node.has("description")) entity.setDescription(node.get("description").asText());
            }
            if (entity.getAuthor() == null || entity.getAuthor().isBlank()) {
                if (node.has("author")) entity.setAuthor(node.get("author").asText());
            }
            if (entity.getVersion() == null || "1.0.0".equals(entity.getVersion())) {
                if (node.has("version")) entity.setVersion(node.get("version").asText());
            }
            if (entity.getModel() == null || entity.getModel().isBlank()) {
                if (node.has("model")) entity.setModel(node.get("model").asText());
            }
        } catch (Exception e) {
            log.debug("[SkillImport] package.json 解析失败，跳过: {}", e.getMessage());
        }
    }

    /**
     * 从Markdown中提取代码块作为工具定义
     */
    private String extractToolsFromMarkdown(String content) {
        java.util.List<java.util.Map<String, Object>> tools = new java.util.ArrayList<>();
        String[] parts = content.split("```");
        for (int i = 0; i < parts.length; i++) {
            if (i % 2 == 1) {
                String block = parts[i];
                // 兼容处理：代码块可能没有换行符（如 ```python 后面直接就是代码结尾）
                int newlineIdx = block.indexOf('\n');
                int endIdx = newlineIdx >= 0 ? Math.min(newlineIdx, 20) : Math.min(block.length(), 20);
                String lang = endIdx > 0 ? block.substring(0, endIdx).trim() : "";
                if (!lang.isEmpty()) {
                    java.util.Map<String, Object> tool = new java.util.LinkedHashMap<>();
                    tool.put("name", "code_block_" + (tools.size() + 1));
                    tool.put("description", "代码块 (" + lang + ")");
                    tool.put("parameters", java.util.Map.of(
                        "type", "object",
                        "properties", java.util.Map.of(),
                        "required", java.util.List.of()
                    ));
                    tools.add(tool);
                }
            }
        }
        return tools.isEmpty() ? "[]" : toJsonSafe(tools);
    }

    /**
     * 清理agentId（只保留英文字母、数字、连字符）
     */
    private String sanitizeAgentId(String name) {
        if (name == null || name.isBlank()) return "skill-" + System.currentTimeMillis() % 100000;
        // 中文转拼音首字母简化（直接保留英文部分，裁剪过长）
        String cleaned = name.replaceAll("[^a-zA-Z0-9_-]", "-")
            .replaceAll("-+", "-")
            .replaceAll("^-|-$", "")
            .toLowerCase();

        if (cleaned.isEmpty()) return "skill-" + System.currentTimeMillis() % 100000;
        if (cleaned.length() > 40) cleaned = cleaned.substring(0, 40);
        return cleaned;
    }

    // ─── 我的技能：安装/卸载 ──────────────────────────────

    /**
     * 安装技能到「我的技能」
     */
    @Transactional
    public java.util.Map<String, Object> installSkill(Long userId, String agentId) {
        java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
        // 1. 验证技能存在
        AgentRegistry entity = findByAgentId(agentId);
        if (entity == null) {
            result.put("success", false);
            result.put("message", "技能不存在: " + agentId);
            return result;
        }
        // 2. 检查是否已安装
        UserInstalledSkill existing = userInstalledSkillMapper.selectOne(
            new LambdaQueryWrapper<UserInstalledSkill>()
                .eq(UserInstalledSkill::getUserId, userId)
                .eq(UserInstalledSkill::getAgentId, agentId)
        );
        if (existing != null) {
            result.put("success", true);
            result.put("message", "已安装");
            result.put("alreadyInstalled", true);
            return result;
        }
        // 3. 写入安装记录
        UserInstalledSkill skill = new UserInstalledSkill();
        skill.setUserId(userId);
        skill.setAgentId(agentId);
        skill.setInstalledAt(java.time.LocalDateTime.now());
        userInstalledSkillMapper.insert(skill);

        log.info("[AgentRegistry] 用户 {} 安装技能: {}", userId, agentId);

        result.put("success", true);
        result.put("message", "安装成功");
        result.put("agentId", agentId);
        result.put("name", entity.getName());
        return result;
    }

    /**
     * 卸载技能
     */
    @Transactional
    public java.util.Map<String, Object> uninstallSkill(Long userId, String agentId) {
        java.util.Map<String, Object> result = new java.util.LinkedHashMap<>();
        UserInstalledSkill existing = userInstalledSkillMapper.selectOne(
            new LambdaQueryWrapper<UserInstalledSkill>()
                .eq(UserInstalledSkill::getUserId, userId)
                .eq(UserInstalledSkill::getAgentId, agentId)
        );
        if (existing == null) {
            result.put("success", false);
            result.put("message", "未安装此技能");
            return result;
        }
        userInstalledSkillMapper.deleteById(existing.getId());

        log.info("[AgentRegistry] 用户 {} 卸载技能: {}", userId, agentId);

        result.put("success", true);
        result.put("message", "已卸载");
        return result;
    }

    /**
     * 查询用户已安装的技能详情列表
     */
    public List<AgentDTO.AgentListItem> listInstalledSkills(Long userId) {
        // ── 自动安装内置 Agent 开发助手 ──
        autoInstallBuiltinSkills(userId);

        // 查询所有安装记录
        List<UserInstalledSkill> installed = userInstalledSkillMapper.selectList(
            new LambdaQueryWrapper<UserInstalledSkill>()
                .eq(UserInstalledSkill::getUserId, userId)
        );
        if (installed.isEmpty()) return List.of();

        // 获取对应的 agentId 列表
        List<String> agentIds = installed.stream()
            .map(UserInstalledSkill::getAgentId)
            .distinct()
            .toList();

        // 查询技能详情
        List<AgentRegistry> agents = agentRegistryMapper.selectList(
            new LambdaQueryWrapper<AgentRegistry>()
                .in(AgentRegistry::getAgentId, agentIds)
                .in(AgentRegistry::getStatus, List.of("approved", "active"))
        );
        return agents.stream().map(this::toListItem).toList();
    }

    /**
     * 自动为用户安装内置技能（如 Agent 开发助手）
     * 幂等操作，已安装则跳过
     */
    private void autoInstallBuiltinSkills(Long userId) {
        if (userId == null) return;
        for (String agentId : BUILTIN_AGENTS.keySet()) {
            try {
                UserInstalledSkill existing = userInstalledSkillMapper.selectOne(
                    new LambdaQueryWrapper<UserInstalledSkill>()
                        .eq(UserInstalledSkill::getUserId, userId)
                        .eq(UserInstalledSkill::getAgentId, agentId)
                );
                if (existing == null) {
                    UserInstalledSkill skill = new UserInstalledSkill();
                    skill.setUserId(userId);
                    skill.setAgentId(agentId);
                    skill.setInstalledAt(LocalDateTime.now());
                    userInstalledSkillMapper.insert(skill);
                    log.info("[AgentRegistry] 自动安装内置技能: {} for user {}", agentId, userId);
                }
            } catch (Exception e) {
                log.warn("[AgentRegistry] 自动安装内置技能失败: {} for user {}: {}", agentId, userId, e.getMessage());
            }
        }
    }

    /**
     * 判断用户是否已安装某个技能
     */
    public boolean isInstalled(Long userId, String agentId) {
        if (userId == null) return false;
        return userInstalledSkillMapper.selectCount(
            new LambdaQueryWrapper<UserInstalledSkill>()
                .eq(UserInstalledSkill::getUserId, userId)
                .eq(UserInstalledSkill::getAgentId, agentId)
        ) > 0;
    }

    // =============================================
    // P2-3: 社区功能 — 使用计数 + 公开/私有切换
    // =============================================

    /**
     * 增加技能使用计数（每次前端/服务调用技能时 +1）
     */
    @Transactional
    public void incrementTotalUsage(String agentId) {
        AgentRegistry agent = findByAgentId(agentId);
        if (agent == null) {
            log.warn("[AgentRegistry] incrementTotalUsage: agent {} 不存在", agentId);
            return;
        }
        agent.setTotalUsage((agent.getTotalUsage() != null ? agent.getTotalUsage() : 0) + 1);
        agentRegistryMapper.updateById(agent);
    }

    /**
     * 切换技能的公开/私有状态（仅 owner 可修改）
     */
    @Transactional
    public void updateIsPublic(String agentId, boolean isPublic, Long userId) {
        AgentRegistry agent = findByAgentId(agentId);
        if (agent == null) {
            throw new IllegalArgumentException("技能不存在");
        }
        if (!agent.getCreatedBy().equals(userId)) {
            throw new IllegalArgumentException("只有技能创建者可以修改公开状态");
        }
        // 只有 approved/active 状态的技能才能设为公开
        if (isPublic && !"approved".equals(agent.getStatus()) && !"active".equals(agent.getStatus())) {
            throw new IllegalArgumentException("只有已上架的技能才能设为公开");
        }
        agent.setIsPublic(isPublic);
        agentRegistryMapper.updateById(agent);
        log.info("用户 {} 将技能 {} 设为 {}", userId, agentId, isPublic ? "公开" : "私有");
    }

    // ─── 技能匹配辅助方法 ─────────────────────────

    /**
     * 获取所有技能实体（供技能匹配使用）
     * @return 所有技能实体列表
     */
    private void ensureGeneratedIcon(AgentRegistry entity) {
        String icon = entity.getIcon();
        if (isTemporarySignedIconUrl(icon)) {
            entity.setIcon(null);
            icon = null;
        }
        if (icon != null && !icon.isBlank() && !"📦".equals(icon)) {
            return;
        }
        try {
            AiService aiService = aiServiceProvider.getIfAvailable();
            if (aiService == null) return;
            String prompt = String.format(
                    "为技能「%s」生成一个专业、简洁、现代的应用图标。技能描述：%s。要求：正方形构图、无文字、无表情符号、适合作为技能商店图标。",
                    Optional.ofNullable(entity.getName()).orElse(entity.getAgentId()),
                    Optional.ofNullable(entity.getDescription()).orElse("通用 AI 技能"));
            String url = iconStorageService.persistRemoteIcon(
                    aiService.generateImage(prompt, "1024x1024"),
                    Optional.ofNullable(entity.getAgentId()).orElse(entity.getName()));
            if (url != null && !url.isBlank()) {
                entity.setIcon(url);
                if (entity.getId() != null) {
                    agentRegistryMapper.updateById(entity);
                }
            }
        } catch (Exception e) {
            log.warn("[AgentRegistry] 自动生成 Skill 图标失败, agentId={}, name={}, error={}",
                    entity.getAgentId(), entity.getName(), e.getMessage());
        }
    }

    private boolean isTemporarySignedIconUrl(String icon) {
        if (icon == null || icon.isBlank()) return false;
        String lower = icon.toLowerCase(Locale.ROOT);
        return lower.contains("expires=")
                || lower.contains("signature=")
                || lower.contains("x-oss-signature")
                || lower.contains("x-amz-signature")
                || lower.contains("security-token")
                || lower.contains("x-cos-security-token")
                || lower.contains("x-oss-security-token");
    }

    public List<AgentRegistry> listAllForMatching() {
        LambdaQueryWrapper<AgentRegistry> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(AgentRegistry::getDeleted, 0)
                .in(AgentRegistry::getStatus, Arrays.asList("active", "approved"))
                .orderByDesc(AgentRegistry::getCreatedAt);
        return agentRegistryMapper.selectList(wrapper);
    }

}
