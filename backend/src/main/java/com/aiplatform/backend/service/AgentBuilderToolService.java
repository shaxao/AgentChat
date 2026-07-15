package com.aiplatform.backend.service;

import com.aiplatform.backend.agent.AgentSessionContext;
import com.aiplatform.backend.agent.ToolDefinition;
import com.aiplatform.backend.dto.AgentDTO;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.util.*;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Agent Builder 工具服务
 * <p>
 * 为 "agent-builder" 内置 Agent 提供工具定义和执行逻辑，
 * 帮助用户通过对话创建、编辑和管理自己的 Agent。
 */
@Slf4j
@Service
public class AgentBuilderToolService {

    @Autowired
    @Lazy
    private AgentRegistryService agentRegistryService;

    @Autowired
    @Lazy
    private AiService aiService;

    @Autowired
    private IconStorageService iconStorageService;

    @Autowired
    private SkillFileManager skillFileManager;

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** Agent 工具脚本存储目录 */
    private static final String AGENT_SCRIPTS_DIR = resolveScriptsDir();

    /** 单个脚本最大大小：2MB，防止 OOM */
    private static final int MAX_SCRIPT_SIZE_BYTES = 2 * 1024 * 1024;

    /** 单条 code_content 最大字符数：1M chars ≈ 2MB utf-8 */
    private static final int MAX_CODE_CONTENT_CHARS = 1_000_000;

    private static String resolveScriptsDir() {
        String custom = System.getenv("AGENT_SCRIPTS_DIR");
        if (custom != null && !custom.isBlank()) return custom;
        return Paths.get("agent_scripts").toAbsolutePath().toString();
    }

    // ─── 工具定义 ─────────────────────────────────

    /**
     * 返回 Agent Builder 的所有工具定义
     */
    public List<ToolDefinition> getAgentBuilderTools() {
        return List.of(
            ToolDefinition.of("quick_create_skill",
                "【推荐优先使用】一步创建技能：分析代码→提取工具定义→保存脚本→注册技能。"
                + "AI 必须先分析代码中的函数签名，提取出真正的工具定义（name/description/parameters），传入 tools 参数。"
                + "绝对不要用 execute+query 通用占位——那是低质量兜底。每个工具必须精确对应代码中的一个实际函数。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "code_content", Map.of("type", "string", "description", "【可选】精简后的 Python 代码。如果不填（空字符串），quick_create_skill 会自动从 save_script 已保存的脚本文件（script_name 参数指定）中读取代码。推荐留空，让后端自动读取。"),
                        "skill_name", Map.of("type", "string", "description", "技能名称，根据功能起名，如 数据分析助手、翻译工具、网页抓取器"),
                        "agent_id", Map.of("type", "string", "description", "技能唯一标识（纯英文+数字+短横线），如 data-analyzer。不填则从名称自动生成"),
                        "description", Map.of("type", "string", "description", "一句话描述技能功能"),
                        "system_prompt", Map.of("type", "string", "description", "【必填！核心】系统提示词。必须写清楚：角色定义、输入输出格式、如何使用工具、限制和边界。禁止用模板占位！"),
                        "categories", Map.of("type", "array", "items", Map.of("type", "string"), "description", "分类标签，如实反映技能用途，如 [\"工具\",\"数据分析\"]"),
                        "model", Map.of("type", "string", "description", "推荐模型，默认 gpt-4o"),
                        "script_name", Map.of("type", "string", "description", "脚本文件名，如 analyze.py，不填则自动生成"),
                        "icon_prompt", Map.of("type", "string", "description", "【可选】图标生成提示词。用英文描述想要的图标，如 'a data analysis chart icon, blue theme, flat design'。提供后后端会自动调用AI生成图标。不填则使用默认图标"),
                        "tools", Map.of("type", "array", "items", Map.of("type", "object",
                            "properties", Map.of(
                                "name", Map.of("type", "string", "description", "工具名称，必须精确对应代码中的实际函数名（如 process_data、fetch_api）"),
                                "description", Map.of("type", "string", "description", "工具功能描述，告诉 LLM 何时调用、做什么、返回什么"),
                                "parameters", Map.of("type", "object", "description", "【核心】工具参数 JSON Schema (OpenAI Function Calling 格式)。必须精确对应函数的实际参数签名，参数名、类型、是否必填都必须准确。例如 date_str 对应 {\"date_str\":{\"type\":\"string\",\"description\":\"查询日期 YYYY-MM-DD\"}}")
                            ),
                            "required", List.of("name", "description", "parameters")
                        ), "description", "【核心】从代码中提取的工具定义列表。每个工具对应一个实际函数，参数 schema 必须精确匹配函数签名。最少 1 个工具")
                    ),
                    "required", List.of("skill_name", "description", "system_prompt", "tools")
                )),

            ToolDefinition.of("create_agent", "注册一个新的 AI Agent。创建后状态为 pending（待审核），需管理员审批后才能上线使用。可以在 tools 中定义该 Agent 拥有的工具。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "agentId", Map.of("type", "string", "description", "Agent 唯一标识，字母数字+短横线，如 my-translator"),
                        "name", Map.of("type", "string", "description", "Agent 显示名称，如 翻译助手"),
                        "description", Map.of("type", "string", "description", "Agent 功能描述，说明它做什么"),
                        "systemPrompt", Map.of("type", "string", "description", "系统提示词，定义 Agent 的角色、能力和限制"),
                        "model", Map.of("type", "string", "description", "推荐使用的模型名称，如 gpt-4o"),
                        "categories", Map.of("type", "array", "items", Map.of("type", "string"), "description", "分类标签列表，如 [\"翻译\",\"文档处理\"]"),
                        "icon_prompt", Map.of("type", "string", "description", "【可选】图标生成提示词。用英文描述想要的图标，如 'a translator icon, purple theme, minimal style'。提供后后端会自动调用AI生成图标。不填则使用默认图标"),
                        "tools", Map.of("type", "array", "items", Map.of("type", "object",
                            "properties", Map.of(
                                "name", Map.of("type", "string", "description", "工具名称，英文标识如 get_weather"),
                                "description", Map.of("type", "string", "description", "工具功能描述，告诉 LLM 何时调用"),
                                "parameters", Map.of("type", "object", "description", "工具参数 JSON Schema，遵循 OpenAI Function Calling 格式"),
                                "endpoint", Map.of("type", "string", "description", "此工具的独立 HTTP 端点（可选，有统一 endpoint 时可不填）")
                            ),
                            "required", List.of("name", "description")
                        ), "description", "该 Agent 拥有的工具列表")
                    ),
                    "required", List.of("agentId", "name", "description", "systemPrompt")
                )),

            ToolDefinition.of("update_agent", "更新已有 Agent 的信息（名称、描述、系统提示词、模型、工具等）。只能更新自己创建的 Agent。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "agentId", Map.of("type", "string", "description", "要更新的 Agent ID"),
                        "name", Map.of("type", "string", "description", "新的显示名称（可选）"),
                        "description", Map.of("type", "string", "description", "新的功能描述（可选）"),
                        "systemPrompt", Map.of("type", "string", "description", "新的系统提示词（可选）"),
                        "model", Map.of("type", "string", "description", "新的推荐模型（可选）"),
                        "tools", Map.of("type", "array", "items", Map.of("type", "object",
                            "properties", Map.of(
                                "name", Map.of("type", "string", "description", "工具名称"),
                                "description", Map.of("type", "string", "description", "工具功能描述"),
                                "parameters", Map.of("type", "object", "description", "工具参数 JSON Schema"),
                                "endpoint", Map.of("type", "string", "description", "此工具的独立 HTTP 端点（可选）")
                            ),
                            "required", List.of("name", "description")
                        ), "description", "该 Agent 拥有的工具列表（完整替换）")
                    ),
                    "required", List.of("agentId")
                )),

            ToolDefinition.of("list_my_agents", "列出当前用户创建的所有 Agent，包括待审核、已启用、已拒绝等各状态。",
                Map.of("type", "object", "properties", Map.of())),

            ToolDefinition.of("get_agent_detail", "查询指定 Agent 的完整详情，包括系统提示词、工具列表、审核状态等。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "agentId", Map.of("type", "string", "description", "要查询的 Agent ID")
                    ),
                    "required", List.of("agentId")
                )),

            ToolDefinition.of("delete_agent", "删除自己创建的 Agent（仅在 pending 或 rejected 状态可删除）。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "agentId", Map.of("type", "string", "description", "要删除的 Agent ID")
                    ),
                    "required", List.of("agentId")
                )),

            ToolDefinition.of("save_script",
                "将用户提供的 Python/Shell 脚本保存到服务器本地脚本目录。保存后返回 script:// 路径，可在创建 Agent 工具时作为 endpoint 使用。"
                + "脚本执行时通过 stdin 接收 JSON：{\"tool_name\":\"xxx\",\"arguments\":{...},\"session_id\":\"xxx\"}，结果通过 stdout 输出 JSON。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "name", Map.of("type", "string", "description", "脚本文件名，如 analyze.py（仅允许字母数字下划线+点+短横线）"),
                        "content", Map.of("type", "string", "description", "脚本完整代码内容"),
                        "description", Map.of("type", "string", "description", "脚本功能描述（可选）")
                    ),
                    "required", List.of("name", "content")
                ))
        );
    }

    // ─── 工具执行 ─────────────────────────────────

    /**
     * 执行 Agent Builder 工具
     */
    public String executeBuilderTool(String toolName, String argumentsJson) {
        Long userId = AgentSessionContext.getUserId();
        if (userId == null) {
            return jsonError("无法获取当前用户信息，请重新进入对话");
        }

        try {
            JsonNode args = objectMapper.readTree(argumentsJson);
            return switch (toolName) {
                case "quick_create_skill" -> quickCreateSkill(args, userId);
                case "create_agent" -> createAgent(args, userId);
                case "update_agent" -> updateAgent(args, userId);
                case "list_my_agents" -> listMyAgents(userId);
                case "get_agent_detail" -> getAgentDetail(args);
                case "delete_agent" -> deleteAgent(args, userId);
                case "save_script" -> saveScript(args);
                default -> jsonError("未知工具: " + toolName);
            };
        } catch (Exception e) {
            log.error("[AgentBuilder] 工具执行失败: toolName={}, error={}", toolName, e.getMessage());
            return jsonError("工具执行失败: " + e.getMessage());
        }
    }

    // ─── 具体实现 ─────────────────────────────────

    private String createAgent(JsonNode args, Long userId) throws Exception {
        String agentId = getString(args, "agentId");
        String name = getString(args, "name");
        String description = getString(args, "description");
        String systemPrompt = getString(args, "systemPrompt");
        String model = getString(args, "model", "gpt-4o");
        List<String> categories = getStringList(args, "categories");
        String iconPrompt = getString(args, "icon_prompt");

        AgentDTO.RegisterRequest req = new AgentDTO.RegisterRequest();
        req.setAgentId(agentId);
        req.setName(name);
        req.setDescription(description);
        req.setSystemPrompt(systemPrompt);
        req.setModel(model);
        req.setCategories(categories);
        req.setTemperature(0.3);
        req.setMaxTokens(8192);
        req.setVersion("1.0.0");

        // AI 自动生成图标（如果提供了 icon_prompt）
        if (iconPrompt != null && !iconPrompt.isBlank()) {
            try {
                String iconUrl = iconStorageService.persistRemoteIcon(aiService.generateImage(iconPrompt, "1024x1024"), name);
                req.setIcon(iconUrl);
                log.info("[AgentBuilder] createAgent: AI图标生成成功: {} → {}", name, iconUrl);
            } catch (Exception e) {
                log.warn("[AgentBuilder] createAgent: AI图标生成失败，使用默认图标: {}", e.getMessage());
            }
        }

        // 解析工具列表
        List<AgentDTO.ToolDef> toolDefs = parseToolDefs(args, "tools");
        if (!toolDefs.isEmpty()) {
            req.setTools(toolDefs);
        }

        // skipReview=true：直接激活，无需审核
        AgentDTO.AgentDetail detail = agentRegistryService.register(req, userId, true);
        
        // 自动安装到用户的技能中
        agentRegistryService.installSkill(userId, agentId);
        
        int toolCount = toolDefs.size();
        String toolMsg = toolCount > 0 ? "，配置了 " + toolCount + " 个工具" : "";
        log.info("[AgentBuilder] 用户 {} 创建 Agent: {} ({}){}，状态=active（已激活并自动安装）", userId, agentId, name, toolMsg);

        return jsonResult(Map.of(
            "success", true,
            "message", "Agent '" + name + "' 创建成功！已激活并自动添加到「我的技能」中，可以立即使用。" + toolMsg,
            "agentId", detail.getAgentId(),
            "status", "active",
            "toolCount", toolCount
        ));
    }

    private String updateAgent(JsonNode args, Long userId) throws Exception {
        String agentId = getString(args, "agentId");

        AgentDTO.AgentDetail existing = agentRegistryService.getDetail(agentId);
        if (existing == null || !Objects.equals(existing.getCreatedBy(), userId)) {
            return jsonError("Agent '" + agentId + "' 不存在或无权限修改");
        }

        AgentDTO.RegisterRequest req = new AgentDTO.RegisterRequest();
        req.setAgentId(agentId);
        if (args.has("name")) req.setName(getString(args, "name"));
        if (args.has("description")) req.setDescription(getString(args, "description"));
        if (args.has("systemPrompt")) req.setSystemPrompt(getString(args, "systemPrompt"));
        if (args.has("model")) req.setModel(getString(args, "model"));

        List<AgentDTO.ToolDef> toolDefs = parseToolDefs(args, "tools");
        if (!toolDefs.isEmpty()) {
            req.setTools(toolDefs);
        }

        AgentDTO.AgentDetail detail = agentRegistryService.update(agentId, req, userId);
        int toolCount = toolDefs.isEmpty() ? (existing.getTools() != null ? existing.getTools().size() : 0) : toolDefs.size();
        log.info("[AgentBuilder] 用户 {} 更新 Agent: {} (tools={})", userId, agentId, toolCount);

        return jsonResult(Map.of(
            "success", true,
            "message", "Agent '" + agentId + "' 更新成功！（工具数: " + toolCount + "）",
            "agentId", detail.getAgentId(),
            "status", detail.getStatus()
        ));
    }

    private String listMyAgents(Long userId) {
        List<AgentDTO.AgentListItem> agents = agentRegistryService.listByCreator(userId);

        List<Map<String, Object>> result = agents.stream()
            .map(a -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("agentId", a.getAgentId());
                m.put("name", a.getName());
                m.put("description", a.getDescription());
                m.put("status", a.getStatus());
                m.put("model", a.getModel());
                m.put("categories", a.getCategories());
                m.put("createdAt", a.getCreatedAt());
                return m;
            })
            .toList();

        return jsonResult(Map.of(
            "success", true,
            "count", result.size(),
            "agents", result
        ));
    }

    private String getAgentDetail(JsonNode args) throws Exception {
        String agentId = getString(args, "agentId");

        try {
            AgentDTO.AgentDetail detail = agentRegistryService.getDetail(agentId);
            if (detail == null) {
                return jsonError("Agent '" + agentId + "' 不存在");
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("agentId", detail.getAgentId());
            result.put("name", detail.getName());
            result.put("description", detail.getDescription());
            result.put("systemPrompt", detail.getSystemPrompt());
            result.put("model", detail.getModel());
            result.put("status", detail.getStatus());
            result.put("categories", detail.getCategories());
            result.put("isBuiltin", detail.getIsBuiltin());
            result.put("toolCount", detail.getTools() != null ? detail.getTools().size() : 0);
            result.put("createdAt", detail.getCreatedAt());
            result.put("reviewComment", detail.getReviewComment());

            if (detail.getTools() != null && !detail.getTools().isEmpty()) {
                List<Map<String, String>> tools = detail.getTools().stream()
                    .map(t -> Map.of("name", t.getName(), "description", t.getDescription() != null ? t.getDescription() : ""))
                    .toList();
                result.put("tools", tools);
            }

            return jsonResult(Map.of("success", true, "agent", result));
        } catch (Exception e) {
            return jsonError("查询失败: " + e.getMessage());
        }
    }

    private String deleteAgent(JsonNode args, Long userId) throws Exception {
        String agentId = getString(args, "agentId");

        AgentDTO.AgentDetail existing = agentRegistryService.getDetail(agentId);
        if (existing == null) {
            return jsonError("Agent '" + agentId + "' 不存在");
        }
        if (!Objects.equals(existing.getCreatedBy(), userId)) {
            return jsonError("无权限删除 Agent '" + agentId + "'");
        }

        if (!"pending".equals(existing.getStatus()) && !"rejected".equals(existing.getStatus())) {
            return jsonError("只能删除 pending 或 rejected 状态的 Agent，当前状态: " + existing.getStatus());
        }

        agentRegistryService.delete(agentId, userId);
        log.info("[AgentBuilder] 用户 {} 删除 Agent: {}", userId, agentId);

        return jsonResult(Map.of(
            "success", true,
            "message", "Agent '" + agentId + "' 已删除"
        ));
    }

    private String saveScript(JsonNode args) throws Exception {
        String fileName = getString(args, "name");
        String content = getString(args, "content");
        String description = getString(args, "description", "");

        // OOM 防护：拒绝超大脚本
        if (content != null && content.length() > MAX_CODE_CONTENT_CHARS) {
            return jsonError("脚本内容过大 (" + content.length() + " 字符)，最大允许 " + MAX_CODE_CONTENT_CHARS
                + " 字符。请精简代码，移除不必要的注释和冗余逻辑。");
        }

        log.info("[OOM-Monitor] saveScript: 保存脚本 {}, 大小={} 字符 ({} KB)",
                fileName, content != null ? content.length() : 0, 
                content != null ? content.length() / 1024 : 0);

        if (!fileName.matches("^[a-zA-Z0-9_.-]+$")) {
            return jsonError("文件名包含非法字符，仅允许字母、数字、下划线、点和短横线: " + fileName);
        }

        if (!fileName.endsWith(".py") && !fileName.endsWith(".sh")) {
            fileName = fileName + ".py";
        }

        Path dir = Paths.get(AGENT_SCRIPTS_DIR);
        if (!Files.exists(dir)) {
            Files.createDirectories(dir);
            log.info("[AgentBuilder] 创建脚本目录: {}", dir.toAbsolutePath());
        }

        Path scriptPath = dir.resolve(fileName);
        Files.writeString(scriptPath, content, StandardCharsets.UTF_8);

        String osName = System.getProperty("os.name", "").toLowerCase();
        if (!osName.contains("win")) {
            scriptPath.toFile().setExecutable(true);
        }

        String absolutePath = scriptPath.toAbsolutePath().toString();
        String endpoint = "script://" + absolutePath;
        log.info("[AgentBuilder] 保存脚本: {} ({}) endpoint={}", fileName, description, endpoint);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("success", true);
        result.put("message", "脚本 '" + fileName + "' 已保存" + (!description.isEmpty() ? "（" + description + "）" : ""));
        result.put("script_path", absolutePath);
        result.put("endpoint", endpoint);
        return jsonResult(result);
    }

    /**
     * 一步创建技能：分析代码→提取工具→保存脚本→注册技能
     * <p>
     * 核心改进：不再用 execute+query 占位工具，而是要求 AI 传入真实的工具定义（tools 参数）。
     * 工具定义来自对代码中函数签名的精确分析，参数 schema 必须匹配实际函数。
     */
    private String quickCreateSkill(JsonNode args, Long userId) throws Exception {
        String codeContent = getString(args, "code_content");
        String skillName = getString(args, "skill_name");
        String agentId = getString(args, "agent_id");
        String description = getString(args, "description");
        String systemPrompt = getString(args, "system_prompt");
        List<String> categories = getStringList(args, "categories");
        String model = getString(args, "model", "gpt-4o");
        String scriptName = getString(args, "script_name");
        String iconPrompt = getString(args, "icon_prompt");

        // OOM 监控：记录 code_content 来源和大小
        if (codeContent != null) {
            log.info("[OOM-Monitor] quick_create_skill: code_content 来源=参数, 大小={} 字符 ({} KB)",
                    codeContent.length(), codeContent.length() / 1024);
        }

        // OOM 防护：拒绝超大 code_content
        if (codeContent != null && codeContent.length() > MAX_CODE_CONTENT_CHARS) {
            log.error("[OOM-ERROR] quick_create_skill: code_content 大小 {} 超过上限 {}！",
                    codeContent.length(), MAX_CODE_CONTENT_CHARS);
            return jsonError("发布失败：脚本内容过大 (" + codeContent.length() + " 字符)，最大允许 "
                + MAX_CODE_CONTENT_CHARS + " 字符。请精简代码或分批处理。");
        }

        // 如果 code_content 为空但提供了 script_name，尝试从已保存的脚本文件读取代码
        // 场景：step2 已通过 save_script 保存代码，step5 时上下文裁剪导致 code_content 丢失
        if ((codeContent == null || codeContent.isBlank()) && scriptName != null && !scriptName.isBlank()) {
            String safeName = scriptName.replaceAll("[^a-zA-Z0-9_.-]", "_");
            Path savedPath = Paths.get(AGENT_SCRIPTS_DIR).resolve(safeName);
            if (Files.exists(savedPath)) {
                // OOM 防护：检查文件大小再读取
                long fileSize = Files.size(savedPath);
                if (fileSize > MAX_SCRIPT_SIZE_BYTES) {
                    return jsonError("发布失败：脚本文件过大 (" + fileSize + " bytes)，最大允许 "
                        + (MAX_SCRIPT_SIZE_BYTES / 1024 / 1024) + "MB。请精简代码。");
                }
                codeContent = Files.readString(savedPath, StandardCharsets.UTF_8);

                // OOM 监控：记录从文件读取的 code_content 大小
                log.info("[OOM-Monitor] quick_create_skill: code_content 来源=文件, path={}, 大小={} 字符 ({} KB)",
                        savedPath, codeContent.length(), codeContent.length() / 1024);
            } else {
                return "❌ 错误：code_content 为空，且找不到已保存的脚本文件 " + safeName
                     + "。请先在第2步调用 save_script 保存精简后的代码。";
            }
        }

        // 自动生成 agentId（纯英文+数字+短横线，不含中文）
        if (agentId == null || agentId.isBlank()) {
            // 从中文名称提取拼音首字母或直接用英文描述
            agentId = skillName
                .replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fff\\s]", "")
                .replaceAll("\\s+", "-")
                .toLowerCase();
            // 如果含中文，用时间戳兜底
            if (agentId.matches(".*[\\u4e00-\\u9fff].*")) {
                agentId = "skill-" + System.currentTimeMillis() % 100000;
            }
            if (agentId.isEmpty()) agentId = "skill-" + System.currentTimeMillis() % 100000;
        }
        // 确保 agentId 纯英文
        agentId = agentId.replaceAll("[^a-zA-Z0-9-]", "").toLowerCase();

        // 自动生成脚本名
        if (scriptName == null || scriptName.isBlank()) {
            scriptName = agentId.replace("-", "_") + ".py";
        }

        // OOM 防护：codeContent 必须非空且大小合理
        if (codeContent == null || codeContent.isBlank()) {
            return jsonError("发布失败：code_content 为空。请先在第2步保存脚本代码。");
        }
        if (codeContent.length() > MAX_CODE_CONTENT_CHARS) {
            return jsonError("发布失败：脚本内容过大 (" + codeContent.length() + " 字符)，最大允许 "
                + MAX_CODE_CONTENT_CHARS + " 字符。请精简代码。");
        }

        // 1. 保存脚本到技能的 skills_storage/{agentId}/scripts/ 目录
        String safeName = scriptName.replaceAll("[^a-zA-Z0-9_.-]", "_");
        if (!safeName.endsWith(".py")) safeName += ".py";

        skillFileManager.saveScriptFile(agentId, safeName, codeContent);

        String relativeScriptPath = "scripts/" + safeName;
        String endpoint = "script://" + relativeScriptPath;
        log.info("[AgentBuilder] quick_create_skill: 保存脚本到技能目录 {}/scripts/{} → {}", agentId, safeName, endpoint);

        // 2. 解析工具定义
        List<AgentDTO.ToolDef> toolDefs = parseToolDefs(args, "tools");

        // 如果 AI 没有提供工具定义，回退到通用 execute 工具（但给出警告）
        if (toolDefs.isEmpty()) {
            log.warn("[AgentBuilder] quick_create_skill: AI 未提供 tools 参数，回退到通用 execute 工具。技能={}", skillName);
            AgentDTO.ToolDef fallback = new AgentDTO.ToolDef();
            fallback.setName("execute");
            fallback.setDescription("执行" + skillName + "的核心功能");
            fallback.setEndpoint(endpoint);
            fallback.setParameters(Map.of(
                "type", "object",
                "properties", Map.of(
                    "query", Map.of("type", "string", "description", "用户的查询内容")
                ),
                "required", List.of("query")
            ));
            toolDefs = List.of(fallback);
        } else {
            // 给每个工具设置正确的 endpoint（使用 skills_storage 下的相对路径）
            // AI 可能从 save_script 拿到绝对路径传入，这里统一规范化为相对路径
            for (AgentDTO.ToolDef td : toolDefs) {
                if (td.getEndpoint() == null || td.getEndpoint().isBlank() || td.getEndpoint().startsWith("script://")) {
                    td.setEndpoint(endpoint);
                }
            }
        }

        // 3. 使用提供的 system_prompt，不自动生成模板
        if (systemPrompt == null || systemPrompt.isBlank()) {
            systemPrompt = "你是一个专业的" + skillName + "助手。使用提供的工具帮助用户完成任务。";
            log.warn("[AgentBuilder] quick_create_skill: AI 未提供 system_prompt，使用默认模板。技能={}", skillName);
        }

        // 4. 注册 Agent
        AgentDTO.RegisterRequest req = new AgentDTO.RegisterRequest();
        req.setAgentId(agentId);
        req.setName(skillName);
        req.setDescription(description);
        req.setSystemPrompt(systemPrompt);
        req.setModel(model);
        req.setCategories(categories != null ? categories : List.of("工具"));
        req.setTemperature(0.3);
        req.setMaxTokens(8192);
        req.setVersion("1.0.0");
        req.setTools(toolDefs);

        // 4.5 AI 自动生成图标（如果提供了 icon_prompt）
        if (iconPrompt != null && !iconPrompt.isBlank()) {
            try {
                String iconUrl = iconStorageService.persistRemoteIcon(aiService.generateImage(iconPrompt, "1024x1024"), skillName);
                req.setIcon(iconUrl);
                log.info("[AgentBuilder] quick_create_skill: AI图标生成成功: {} → {}", skillName, iconUrl);
            } catch (Exception e) {
                log.warn("[AgentBuilder] quick_create_skill: AI图标生成失败，使用默认图标: {}", e.getMessage());
            }
        }

        // skipReview=true：直接激活，无需审核
        AgentDTO.AgentDetail detail = agentRegistryService.register(req, userId, true);

        // 自动安装到用户的技能中
        agentRegistryService.installSkill(userId, agentId);

        // 5. 生成并保存技能 ZIP 包（供下载时返回完整包，含脚本文件）
        try {
            byte[] zipBytes = buildSkillZip(agentId, skillName, description, systemPrompt,
                    categories, model, "1.0.0", toolDefs, safeName, codeContent);
            agentRegistryService.saveZipBytes(agentId, zipBytes);
            log.info("[AgentBuilder] quick_create_skill: 技能ZIP已保存 {} ({} 字节)", agentId, zipBytes.length);
        } catch (Exception e) {
            log.warn("[AgentBuilder] quick_create_skill: 生成技能ZIP失败: {}", e.getMessage(), e);
        }

        log.info("[AgentBuilder] quick_create_skill: 注册技能 {} (agentId={}, tools={}, script={}), 状态=active（已激活并自动安装）",
            skillName, agentId, toolDefs.size(), safeName);

        // 5. 构建 tool 摘要
        List<Map<String, String>> toolSummary = toolDefs.stream()
            .map(t -> {
                Map<String, String> m = new LinkedHashMap<>();
                m.put("name", t.getName());
                m.put("description", t.getDescription() != null ? t.getDescription() : "");
                return m;
            })
            .toList();

        return jsonResult(Map.of(
            "success", true,
            "message", "✅ 技能 '" + skillName + "' 创建成功！已激活并自动添加到「我的技能」中，可以立即使用。agentId: " + agentId
                + "，配置了 " + toolDefs.size() + " 个工具。",
            "agentId", detail.getAgentId(),
            "skillName", skillName,
            "status", "active",
            "toolCount", toolDefs.size(),
            "tools", toolSummary,
            "scriptPath", relativeScriptPath,
            "endpoint", endpoint
        ));
    }

    /**
     * 构建技能 ZIP 包，包含 SKILL.md、package.json 和 scripts/ 目录下的脚本文件。
     * 供 quick_create_skill 注册成功后调用，确保下载时返回完整包（而非仅元数据）。
     */
    private byte[] buildSkillZip(String agentId, String skillName, String description,
            String systemPrompt, List<String> categories, String model, String version,
            List<AgentDTO.ToolDef> toolDefs, String scriptName, String codeContent) throws Exception {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos, StandardCharsets.UTF_8)) {

            // ── SKILL.md ──
            StringBuilder skillMd = new StringBuilder();
            skillMd.append("---\n");
            skillMd.append("name: ").append(skillName).append("\n");
            skillMd.append("description: ").append(description != null ? description : "").append("\n");
            skillMd.append("version: ").append(version).append("\n");
            if (categories != null && !categories.isEmpty()) {
                skillMd.append("categories: [").append(String.join(", ", categories)).append("]\n");
            }
            skillMd.append("model: ").append(model).append("\n");
            skillMd.append("---\n\n");
            skillMd.append("# ").append(skillName).append("\n\n");
            skillMd.append(description != null ? description : "").append("\n\n");
            skillMd.append("## 系统提示词\n\n").append(systemPrompt).append("\n\n");
            if (toolDefs != null && !toolDefs.isEmpty()) {
                skillMd.append("## 工具定义\n\n```json\n");
                try {
                    skillMd.append(objectMapper.writerWithDefaultPrettyPrinter()
                            .writeValueAsString(toolDefs));
                } catch (Exception e) {
                    skillMd.append("[]");
                }
                skillMd.append("\n```\n\n");
            }

            ZipEntry skillEntry = new ZipEntry("SKILL.md");
            zos.putNextEntry(skillEntry);
            zos.write(skillMd.toString().getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();

            // ── package.json ──
            String packageJson = String.format(
                "{\n  \"name\": \"%s\",\n  \"version\": \"%s\",\n  \"description\": \"%s\",\n  \"model\": \"%s\"\n}",
                escapeJsonString(agentId),
                version,
                escapeJsonString(description != null ? description : ""),
                escapeJsonString(model)
            );
            ZipEntry pkgEntry = new ZipEntry("package.json");
            zos.putNextEntry(pkgEntry);
            zos.write(packageJson.getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();

            // ── scripts/{scriptName} ──
            if (codeContent != null && !codeContent.isBlank()) {
                String scriptPath = "scripts/" + scriptName;
                ZipEntry scriptEntry = new ZipEntry(scriptPath);
                zos.putNextEntry(scriptEntry);
                zos.write(codeContent.getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
        }
        return baos.toByteArray();
    }

    private String escapeJsonString(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    // ─── JSON 工具方法 ─────────────────────────────────

    private List<AgentDTO.ToolDef> parseToolDefs(JsonNode args, String key) {
        if (!args.has(key) || args.get(key).isNull() || !args.get(key).isArray()) {
            return List.of();
        }
        List<AgentDTO.ToolDef> result = new ArrayList<>();
        for (JsonNode toolNode : args.get(key)) {
            AgentDTO.ToolDef td = new AgentDTO.ToolDef();
            td.setName(getString(toolNode, "name"));
            td.setDescription(getString(toolNode, "description"));
            if (td.getName() == null || td.getName().isEmpty()) continue;

            if (toolNode.has("parameters") && !toolNode.get("parameters").isNull()) {
                try {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> params = objectMapper.convertValue(toolNode.get("parameters"), Map.class);
                    td.setParameters(params);
                } catch (Exception e) {
                    log.warn("[AgentBuilder] 解析工具 {} 的 parameters 失败: {}", td.getName(), e.getMessage());
                }
            }
            if (toolNode.has("endpoint") && !toolNode.get("endpoint").isNull()) {
                td.setEndpoint(toolNode.get("endpoint").asText());
            }
            result.add(td);
        }
        return result;
    }

    private String getString(JsonNode node, String key) {
        return node.has(key) && !node.get(key).isNull() ? node.get(key).asText() : null;
    }

    private String getString(JsonNode node, String key, String defaultValue) {
        String val = getString(node, key);
        return val != null ? val : defaultValue;
    }

    private List<String> getStringList(JsonNode node, String key) {
        if (!node.has(key) || node.get(key).isNull()) return List.of();
        List<String> result = new ArrayList<>();
        for (JsonNode item : node.get(key)) {
            result.add(item.asText());
        }
        return result;
    }

    private String jsonResult(Map<String, Object> data) {
        try {
            return objectMapper.writeValueAsString(data);
        } catch (Exception e) {
            return "{\"error\":\"序列化失败\"}";
        }
    }

    private String jsonError(String message) {
        return "{\"error\":\"" + message.replace("\"", "\\\"") + "\"}";
    }
}
