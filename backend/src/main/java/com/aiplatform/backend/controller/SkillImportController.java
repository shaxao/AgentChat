package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.AgentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.SkillRevenueRecord;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.AgentRegistryMapper;
import com.aiplatform.backend.mapper.SkillRevenueRecordMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.service.AgentRegistryService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@Slf4j
@RestController
@RequestMapping("/api/skills")
@RequiredArgsConstructor
public class SkillImportController {

    private final AgentRegistryService agentRegistryService;
    private final AgentRegistryMapper agentRegistryMapper;
    private final SkillRevenueRecordMapper revenueRecordMapper;
    private final SysUserMapper sysUserMapper;

    /** 导入ZIP最大大小：20MB */
    private static final long MAX_IMPORT_SIZE = 20 * 1024 * 1024;

    /**
     * 上传单个技能ZIP包并导入
     */
    @PreAuthorize("hasAuthority('PERM_skill:publish')")
    @PostMapping("/import")
    public ResponseEntity<Result<Map<String, Object>>> importSkill(
            @RequestParam("file") MultipartFile file,
            @RequestAttribute Long userId) {
        // OOM 防护：拒绝超大文件
        if (file.getSize() > MAX_IMPORT_SIZE) {
            return ResponseEntity.badRequest().body(
                Result.fail("ZIP文件过大（" + (file.getSize() / 1024 / 1024) + "MB），最大允许 "
                    + (MAX_IMPORT_SIZE / 1024 / 1024) + "MB"));
        }
        if (file.getSize() == 0) {
            return ResponseEntity.badRequest().body(Result.fail("ZIP文件为空"));
        }

        try {
            Map<String, Object> result = agentRegistryService.importFromZip(file, userId);
            return ResponseEntity.ok(Result.ok(result));
        } catch (Exception e) {
            log.error("技能导入失败", e);
            return ResponseEntity.badRequest().body(Result.fail("导入失败: " + e.getMessage()));
        }
    }

    /**
     * 批量导入技能ZIP包
     */
    @PreAuthorize("hasAuthority('PERM_skill:publish')")
    @PostMapping("/import-batch")
    public ResponseEntity<Result<Map<String, Object>>> importSkillsBatch(
            @RequestParam("files") MultipartFile[] files,
            @RequestAttribute Long userId) {

        // OOM 防护：批量导入限制总大小 50MB，最多 10 个文件
        if (files.length > 10) {
            return ResponseEntity.badRequest().body(
                Result.fail("批量导入最多 10 个文件，当前 " + files.length));
        }
        long totalSize = 0;
        for (MultipartFile f : files) totalSize += f.getSize();
        if (totalSize > 50 * 1024 * 1024) {
            return ResponseEntity.badRequest().body(
                Result.fail("批量导入总大小过大（" + (totalSize / 1024 / 1024) + "MB），最大允许 50MB"));
        }

        int success = 0, fail = 0;
        StringBuilder sb = new StringBuilder();

        for (MultipartFile file : files) {
            try {
                agentRegistryService.importFromZip(file, userId);
                success++;
                sb.append(file.getOriginalFilename()).append(": 成功\n");
            } catch (Exception e) {
                fail++;
                sb.append(file.getOriginalFilename()).append(": ").append(e.getMessage()).append("\n");
            }
        }

        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("successCount", success);
        summary.put("failCount", fail);
        summary.put("details", sb.toString());

        return ResponseEntity.ok(Result.ok(summary));
    }

    /**
     * 下载技能 ZIP 包（导出技能）
     * <p>
     * 优先返回导入时保存的原始 ZIP（含 scripts/、config、图标等完整内容）；
     * 若无原始文件则从数据库动态生成（仅 SKILL.md + package.json）。
     */
    @GetMapping("/{agentId}/download")
    public void downloadSkill(@PathVariable String agentId, HttpServletResponse response) {
        try {
            AgentRegistry entity = agentRegistryMapper.selectOne(
                new LambdaQueryWrapper<AgentRegistry>()
                    .eq(AgentRegistry::getAgentId, agentId)
            );
            if (entity == null) {
                response.sendError(404, "技能不存在: " + agentId);
                return;
            }

            String fileName = entity.getAgentId() + ".zip";
            byte[] zipBytes = agentRegistryService.getZipBytes(agentId);

            if (zipBytes == null || zipBytes.length == 0) {
                // 降级：从数据库动态生成
                zipBytes = generateSkillZip(entity);
                log.info("[SkillImport] 动态生成ZIP: {} (无原始文件)", agentId);
            } else {
                log.info("[SkillImport] 返回ZIP: {} ({} 字节)", agentId, zipBytes.length);
            }

            response.setContentType("application/zip");
            // 简化 Content-Disposition，避免使用 RFC 5987 编码（某些浏览器无法解析）
            // 格式: attachment; filename="xxx.zip"
            String safeFileName = fileName.replace("\"", "_").replace(";", "_");
            response.setHeader(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"" + safeFileName + "\"");
            response.setContentLength(zipBytes.length);
            response.getOutputStream().write(zipBytes);
            response.getOutputStream().flush();

        } catch (Exception e) {
            log.error("[SkillImport] 下载技能失败: {}", agentId, e);
            try {
                response.sendError(500, "下载失败: " + e.getMessage());
            } catch (Exception ignored) {}
        }
    }

    /** 从数据库字段动态生成 ZIP（降级方案，含脚本文件） */
    private byte[] generateSkillZip(AgentRegistry entity) throws Exception {
            StringBuilder skillMd = new StringBuilder();
            skillMd.append("# ").append(entity.getName()).append("\n\n");
            if (entity.getDescription() != null && !entity.getDescription().isBlank()) {
                skillMd.append("## 描述\n\n").append(entity.getDescription()).append("\n\n");
            }
            skillMd.append("## 系统提示词\n\n").append(entity.getSystemPrompt()).append("\n\n");
            if (entity.getToolsJson() != null && !entity.getToolsJson().isEmpty() && !"[]".equals(entity.getToolsJson())) {
                skillMd.append("## 工具定义\n\n```json\n").append(entity.getToolsJson()).append("\n```\n\n");
            }
            if (entity.getCategories() != null && !entity.getCategories().isBlank()) {
                skillMd.append("## 分类\n\n").append(entity.getCategories()).append("\n\n");
            }
            skillMd.append("## 版本\n\n").append(entity.getVersion()).append("\n");

            // 生成 ZIP
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            try (ZipOutputStream zos = new ZipOutputStream(baos, StandardCharsets.UTF_8)) {
                // SKILL.md
                ZipEntry skillEntry = new ZipEntry("SKILL.md");
                zos.putNextEntry(skillEntry);
                zos.write(skillMd.toString().getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();

                // package.json (元信息)
                String packageJson = String.format(
                    "{\n  \"name\": \"%s\",\n  \"version\": \"%s\",\n  \"description\": \"%s\",\n  \"author\": \"%s\",\n  \"model\": \"%s\"\n}",
                    escapeJson(entity.getAgentId()),
                    entity.getVersion(),
                    escapeJson(entity.getDescription() != null ? entity.getDescription() : ""),
                    escapeJson(entity.getAuthor() != null ? entity.getAuthor() : ""),
                    escapeJson(entity.getModel())
                );
                ZipEntry pkgEntry = new ZipEntry("package.json");
                zos.putNextEntry(pkgEntry);
                zos.write(packageJson.getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();

                // ── scripts/ 目录：从 toolsJson 中提取脚本 ──
                Set<String> addedScripts = new LinkedHashSet<>();
                if (entity.getToolsJson() != null && !entity.getToolsJson().isEmpty()) {
                    try {
                        com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
                        com.fasterxml.jackson.databind.JsonNode tools = mapper.readTree(entity.getToolsJson());
                        for (com.fasterxml.jackson.databind.JsonNode tool : tools) {
                            // 优先从 code 字段直接写入脚本
                            if (tool.has("code") && !tool.get("code").isNull() && !tool.get("code").asText().isBlank()) {
                                String toolName = tool.has("name") ? tool.get("name").asText() : "tool";
                                String code = tool.get("code").asText();
                                String scriptFileName = toolName.endsWith(".py") ? toolName : toolName + ".py";
                                String zipEntryName = "scripts/" + scriptFileName;
                                if (addedScripts.add(zipEntryName)) {
                                    ZipEntry scriptEntry = new ZipEntry(zipEntryName);
                                    zos.putNextEntry(scriptEntry);
                                    zos.write(code.getBytes(StandardCharsets.UTF_8));
                                    zos.closeEntry();
                                    log.info("[SkillImport] 从 code 字段添加脚本: {}", zipEntryName);
                                }
                            }
                            // 也检查 endpoint 字段（兼容旧数据）
                            if (tool.has("endpoint")) {
                                String endpoint = tool.get("endpoint").asText();
                                if (endpoint.startsWith("script://")) {
                                    String scriptPath = endpoint.substring("script://".length());
                                    addScriptToZip(zos, scriptPath, addedScripts);
                                } else if (endpoint.startsWith("file://")) {
                                    String scriptPath = endpoint.substring("file://".length());
                                    addScriptToZip(zos, scriptPath, addedScripts);
                                }
                            }
                        }
                    } catch (Exception e) {
                        log.warn("[SkillImport] 解析 toolsJson 提取脚本失败: {}", e.getMessage());
                    }
                }
                // 兜底：检查 agent_scripts 目录下是否有同名脚本（agentId 相关）
                if (addedScripts.isEmpty()) {
                    try {
                        Path scriptsDir = Paths.get("agent_scripts");
                        if (Files.isDirectory(scriptsDir)) {
                            String prefix = entity.getAgentId().replace("-", "_");
                            try (var stream = Files.list(scriptsDir)) {
                                stream.filter(Files::isRegularFile)
                                    .filter(p -> {
                                        String name = p.getFileName().toString();
                                        return name.startsWith(prefix) || name.contains(prefix);
                                    })
                                    .forEach(p -> {
                                        try {
                                            addScriptToZip(zos, p.toAbsolutePath().toString(), addedScripts);
                                        } catch (Exception ignored) {}
                                    });
                            }
                        }
                    } catch (Exception e) {
                        log.warn("[SkillImport] agent_scripts 目录扫描失败: {}", e.getMessage());
                    }
                }
            }
            return baos.toByteArray();
    }

    /** 将脚本文件添加到 ZIP 的 scripts/ 目录下 */
    private void addScriptToZip(ZipOutputStream zos, String scriptPath, Set<String> addedScripts) {
        try {
            Path path = Paths.get(scriptPath);
            if (!Files.exists(path) || !Files.isRegularFile(path)) {
                log.debug("[SkillImport] 脚本文件不存在，跳过: {}", scriptPath);
                return;
            }
            String fileName = path.getFileName().toString();
            String zipEntryName = "scripts/" + fileName;
            if (!addedScripts.add(zipEntryName)) return; // 避免重复添加

            ZipEntry entry = new ZipEntry(zipEntryName);
            zos.putNextEntry(entry);
            zos.write(Files.readAllBytes(path));
            zos.closeEntry();
            log.info("[SkillImport] 已添加脚本到ZIP: {} → {}", scriptPath, zipEntryName);
        } catch (Exception e) {
            log.warn("[SkillImport] 添加脚本到ZIP失败: {} - {}", scriptPath, e.getMessage());
        }
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    // =============================================
    // P3-4: 创作者排行榜
    // =============================================

    /**
     * 获取技能创作者排行榜
     * @param period 时间范围：week/month/all（默认 all）
     * @param limit  返回数量（默认 20）
     */
    @GetMapping("/leaderboard")
    public Result<AgentDTO.CreatorLeaderboardResponse> leaderboard(
            @RequestParam(defaultValue = "all") String period,
            @RequestParam(defaultValue = "20") int limit) {

        try {
            // 计算时间范围
            LocalDateTime since = null;
            if ("week".equals(period)) {
                since = LocalDateTime.now().minusWeeks(1);
            } else if ("month".equals(period)) {
                since = LocalDateTime.now().minusMonths(1);
            }

            // 查询收益记录并按 user_id + agent_id 聚合
            QueryWrapper<SkillRevenueRecord> qw = new QueryWrapper<>();
            qw.select("user_id", "agent_id",
                    "SUM(amount) as total_revenue",
                    "COUNT(*) as use_count");
            if (since != null) {
                qw.ge("created_at", since);
            }
            qw.groupBy("user_id", "agent_id");
            qw.orderByDesc("total_revenue");
            qw.last("LIMIT " + Math.min(limit, 100));

            List<Map<String, Object>> rows = revenueRecordMapper.selectMaps(qw);

            List<AgentDTO.CreatorRankVO> rankings = new ArrayList<>();
            int rank = 0;
            for (Map<String, Object> row : rows) {
                rank++;
                Long userId = (Long) row.get("user_id");
                Long agentId = (Long) row.get("agent_id");
                BigDecimal totalRevenue = row.get("total_revenue") != null
                        ? new BigDecimal(row.get("total_revenue").toString()) : BigDecimal.ZERO;
                int useCount = row.get("use_count") != null
                        ? ((Number) row.get("use_count")).intValue() : 0;

                // 获取用户信息
                String username = "未知用户";
                String avatar = null;
                if (userId != null) {
                    SysUser user = sysUserMapper.selectById(userId);
                    if (user != null) {
                        username = user.getUsername();
                        avatar = user.getAvatar();
                    }
                }

                // 获取 Agent 信息
                String agentName = "未知技能";
                String agentIcon = null;
                String agentIdStr = null;
                boolean isCertified = false;
                if (agentId != null) {
                    AgentRegistry agent = agentRegistryMapper.selectById(agentId);
                    if (agent != null) {
                        agentName = agent.getName();
                        agentIcon = agent.getIcon();
                        agentIdStr = agent.getAgentId();
                        isCertified = agent.getIsCertified() != null && agent.getIsCertified();
                    }
                }

                AgentDTO.CreatorRankVO vo = new AgentDTO.CreatorRankVO();
                vo.setRank(rank);
                vo.setUserId(userId);
                vo.setUsername(username);
                vo.setAvatar(avatar);
                vo.setAgentId(agentIdStr);
                vo.setAgentName(agentName);
                vo.setAgentIcon(agentIcon);
                vo.setTotalRevenue(totalRevenue);
                vo.setUseCount(useCount);
                vo.setCertified(isCertified);
                rankings.add(vo);
            }

            AgentDTO.CreatorLeaderboardResponse response = new AgentDTO.CreatorLeaderboardResponse();
            response.setRankings(rankings);
            response.setPeriod(period);
            response.setUpdatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));

            return Result.ok(response);
        } catch (Exception e) {
            log.error("[Leaderboard] 排行榜查询失败: {}", e.getMessage(), e);
            return Result.fail("排行榜查询失败: " + e.getMessage());
        }
    }
}
