package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

/**
 * 技能对话式编辑服务
 * <p>
 * 处理自然语言指令，智能识别用户想要修改的技能文件和修改内容。
 */
@Slf4j
@Service
public class SkillConversationService {

    private final SkillFileManager skillFileManager;
    private final ObjectMapper objectMapper;
    private final RestTemplate restTemplate;

    @Value("${aiplatform.llm.url:http://localhost:11434/api/generate}")
    private String llmUrl;

    public SkillConversationService(SkillFileManager skillFileManager) {
        this.skillFileManager = skillFileManager;
        this.objectMapper = new ObjectMapper();
        this.restTemplate = new RestTemplate();
    }

    /**
     * 处理对话式编辑请求
     * @param agentId 技能ID
     * @param userMessage 用户消息（自然语言指令）
     * @param conversationHistory 对话历史
     * @return 处理结果，包含建议的文件修改
     */
    public ConversationResponse processConversation(String agentId, String userMessage, 
                                                  List<Message> conversationHistory) throws IOException {
        log.info("[SkillConversationService] 处理对话式编辑请求: agentId={}, message={}", 
                  agentId, userMessage);

        // 1. 获取技能文件树
        List<SkillFileManager.FileNode> fileTree = skillFileManager.getFileTree(agentId);

        // 2. 构建提示词
        String prompt = buildPrompt(agentId, fileTree, userMessage, conversationHistory);

        // 3. 调用LLM进行理解
        String llmResponse = callLLM(prompt);

        // 4. 解析LLM响应，提取文件修改建议
        List<FileModification> modifications = parseModifications(llmResponse);

        // 5. 读取被修改文件的原始内容
        Map<String, String> originalContents = new HashMap<>();
        for (FileModification mod : modifications) {
            try {
                String original = skillFileManager.readFile(agentId, mod.getFilePath());
                originalContents.put(mod.getFilePath(), original);
            } catch (IOException e) {
                log.warn("[SkillConversationService] 无法读取文件原始内容: {}", mod.getFilePath());
            }
        }

        // 6. 构建响应
        ConversationResponse response = new ConversationResponse();
        response.setSuccess(true);
        response.setMessage("我已理解您的需求，以下是建议的修改：");
        response.setModifications(modifications);
        response.setOriginalContents(originalContents);

        return response;
    }

    /**
     * 应用文件修改
     * @param agentId 技能ID
     * @param modifications 文件修改列表
     */
    public void applyModifications(String agentId, List<FileModification> modifications) throws IOException {
        for (FileModification mod : modifications) {
            if ("create".equals(mod.getAction())) {
                // 创建新文件
                skillFileManager.createFile(agentId, mod.getFilePath(), mod.getNewContent(), false);
            } else if ("update".equals(mod.getAction())) {
                // 更新现有文件
                skillFileManager.updateFile(agentId, mod.getFilePath(), mod.getNewContent());
            } else if ("delete".equals(mod.getAction())) {
                // 删除文件
                skillFileManager.deleteFile(agentId, mod.getFilePath());
            }
        }
        log.info("[SkillConversationService] 已应用 {} 个文件修改", modifications.size());
    }

    /**
     * 构建提示词 - 优化版本，提高LLM理解准确性
     */
    private String buildPrompt(String agentId, List<SkillFileManager.FileNode> fileTree, 
                               String userMessage, List<Message> history) {
        StringBuilder prompt = new StringBuilder();
        
        // ========== 角色定义 ==========
        prompt.append("# 角色\n");
        prompt.append("你是一个专业的技能文件编辑助手。你的任务是通过自然语言对话，\n");
        prompt.append("精准理解用户的修改意图，并生成正确的文件修改建议。\n\n");
        
        // ========== 上下文信息 ==========
        prompt.append("## 当前技能信息\n");
        prompt.append("- 技能ID: ").append(agentId).append("\n");
        prompt.append("- 技能文件结构:\n");
        prompt.append(fileTreeToMarkdown(fileTree, 0));
        prompt.append("\n");

        // 读取SKILL.md内容（如果存在）提供更多上下文
        try {
            String skillMdContent = skillFileManager.readFile(agentId, "SKILL.md");
            if (skillMdContent != null && !skillMdContent.isEmpty()) {
                prompt.append("- 技能说明文档 (SKILL.md):\n");
                prompt.append("```\n");
                // 只取前2000字符，避免提示词过长
                String truncated = skillMdContent.length() > 2000 ? 
                    skillMdContent.substring(0, 2000) + "\n...(内容过长已截断)" : skillMdContent;
                prompt.append(truncated).append("\n");
                prompt.append("```\n\n");
            }
        } catch (IOException e) {
            // SKILL.md不存在，跳过
        }

        // ========== 对话历史 ==========
        if (history != null && !history.isEmpty()) {
            prompt.append("## 对话历史\n");
            for (Message msg : history) {
                prompt.append("- ").append(msg.getRole()).append(": ").append(msg.getContent()).append("\n");
            }
            prompt.append("\n");
        }

        // ========== 用户当前请求 ==========
        prompt.append("## 用户当前请求\n");
        prompt.append(userMessage).append("\n\n");
        
        // ========== 任务说明 ==========
        prompt.append("## 你的任务\n");
        prompt.append("分析用户的请求，确定需要修改的文件，并生成修改建议。\n\n");
        
        // ========== 输出格式 ==========
        prompt.append("## 输出格式\n");
        prompt.append("你必须严格按照以下JSON格式返回结果，不要添加任何额外的文本或解释：\n");
        prompt.append("```json\n");
        prompt.append("{\n");
        prompt.append("  \"understanding\": \"简洁描述你对用户需求的理解（50字以内）\",\n");
        prompt.append("  \"clarificationNeeded\": false,  // 如果需要用户澄清，设为true\n");
        prompt.append("  \"clarificationQuestion\": \"\",  // 如果需要澄清，在这里提问\n");
        prompt.append("  \"modifications\": [\n");
        prompt.append("    {\n");
        prompt.append("      \"action\": \"update\",  // 必需：update(修改) | create(创建) | delete(删除)\n");
        prompt.append("      \"filePath\": \"文件路径\",  // 必需：相对于技能根目录的路径\n");
        prompt.append("      \"reason\": \"修改原因的简短说明\",  // 必需\n");
        prompt.append("      \"newContent\": \"文件的完整新内容\"  // 必需：update/create时必须提供\n");
        prompt.append("    }\n");
        prompt.append("  ]\n");
        prompt.append("}\n");
        prompt.append("```\n\n");
        
        // ========== 详细规则 ==========
        prompt.append("## 重要规则和约束\n");
        prompt.append("\n### 1. 文件修改规则\n");
        prompt.append("- **update**: 修改现有文件，必须在 `newContent` 中提供文件的**完整新内容**\n");
        prompt.append("  - ❌ 错误：只提供修改的部分代码或diff\n");
        prompt.append("  - ✅ 正确：提供整个文件的完整内容\n");
        prompt.append("- **create**: 创建新文件，必须提供完整的初始内容\n");
        prompt.append("- **delete**: 删除文件，不需要提供 `newContent`\n\n");
        
        prompt.append("### 2. 文件路径规则\n");
        prompt.append("- 使用相对于技能根目录的路径，例如：`scripts/main.py` 或 `config.json`\n");
        prompt.append("- 路径使用正斜杠 `/` 作为分隔符\n");
        prompt.append("- 创建新文件时，如果父目录不存在，会自动创建\n\n");
        
        prompt.append("### 3. 内容生成规则\n");
        prompt.append("- 保持文件原有格式和编码（通常是UTF-8）\n");
        prompt.append("- 对于代码文件，保持原有的代码风格和缩进\n");
        prompt.append("- 对于配置文件（JSON/YAML），保持正确的格式\n");
        prompt.append("- 不要删除原有的重要信息（如版权声明、重要注释等）\n\n");
        
        prompt.append("### 4. 安全规则\n");
        prompt.append("- 不要修改核心系统文件（如 `__init__.py` 中的系统代码）\n");
        prompt.append("- 不要删除关键文件（如 `SKILL.md`、`scripts/main.py` 等）\n");
        prompt.append("- 如果用户请求可能有风险，在 `reason` 中说明风险\n\n");
        
        prompt.append("### 5. 处理不明确请求\n");
        prompt.append("- 如果用户的请求不够明确，设置 `clarificationNeeded: true`\n");
        prompt.append("- 在 `clarificationQuestion` 中提出1-2个具体问题\n");
        prompt.append("- 示例：`\"您是想修改配置文件的超时时间，还是想添加新的配置项？\"`\n\n");
        
        prompt.append("### 6. JSON格式要求\n");
        prompt.append("- 确保JSON格式正确，可以被程序解析\n");
        prompt.append("- 字符串中的引号使用转义：`\\\"`\n");
        prompt.append("- 换行符使用 `\\n`\n");
        prompt.append("- 如果内容中包含JSON特殊字符，必须正确转义\n\n");
        
        // ========== 示例 ==========
        prompt.append("## 示例\n\n");
        
        prompt.append("### 示例1：修改现有文件\n");
        prompt.append("**用户输入**：`在SKILL.md中添加一个新功能说明`\n\n");
        prompt.append("**你的输出**：\n");
        prompt.append("```json\n");
        prompt.append("{\n");
        prompt.append("  \"understanding\": \"用户想在SKILL.md文档中添加新功能说明\",\n");
        prompt.append("  \"clarificationNeeded\": false,\n");
        prompt.append("  \"clarificationQuestion\": \"\",\n");
        prompt.append("  \"modifications\": [\n");
        prompt.append("    {\n");
        prompt.append("      \"action\": \"update\",\n");
        prompt.append("      \"filePath\": \"SKILL.md\",\n");
        prompt.append("      \"reason\": \"在文档末尾添加新功能说明章节\",\n");
        prompt.append("      \"newContent\": \"# 技能说明\\n\\n...（完整的SKILL.md内容）...\\n\\n## 新功能\\n\\n添加了新功能说明\\n\"\n");
        prompt.append("    }\n");
        prompt.append("  ]\n");
        prompt.append("}\n");
        prompt.append("```\n\n");
        
        prompt.append("### 示例2：创建新文件\n");
        prompt.append("**用户输入**：`创建一个新的配置文件 config/settings.json`\n\n");
        prompt.append("**你的输出**：\n");
        prompt.append("```json\n");
        prompt.append("{\n");
        prompt.append("  \"understanding\": \"用户想创建一个新的JSON配置文件\",\n");
        prompt.append("  \"clarificationNeeded\": false,\n");
        prompt.append("  \"clarificationQuestion\": \"\",\n");
        prompt.append("  \"modifications\": [\n");
        prompt.append("    {\n");
        prompt.append("      \"action\": \"create\",\n");
        prompt.append("      \"filePath\": \"config/settings.json\",\n");
        prompt.append("      \"reason\": \"创建新的配置文件\",\n");
        prompt.append("      \"newContent\": \"{\\n  \\\"enabled\\\": true,\\n  \\\"timeout\\\": 30\\n}\\n\"\n");
        prompt.append("    }\n");
        prompt.append("  ]\n");
        prompt.append("}\n");
        prompt.append("```\n\n");
        
        prompt.append("### 示例3：请求不明确\n");
        prompt.append("**用户输入**：`修改一下配置`\n\n");
        prompt.append("**你的输出**：\n");
        prompt.append("```json\n");
        prompt.append("{\n");
        prompt.append("  \"understanding\": \"用户想修改配置，但未指定具体要修改哪个配置文件或配置项\",\n");
        prompt.append("  \"clarificationNeeded\": true,\n");
        prompt.append("  \"clarificationQuestion\": \"请问您想修改哪个配置文件？\n1. config.json - 主配置文件\n2. settings.yaml - 用户设置\n3. 其他文件？\",\n");
        prompt.append("  \"modifications\": []\n");
        prompt.append("}\n");
        prompt.append("```\n\n");
        
        // ========== 最终提醒 ==========
        prompt.append("## 最后提醒\n");
        prompt.append("1. 只返回JSON，不要添加任何解释性文字\n");
        prompt.append("2. 确保JSON可以被程序正确解析\n");
        prompt.append("3. 如果不需要修改文件，`modifications` 数组可以为空 `[]`\n");
        prompt.append("4. 始终优先考虑用户意图，但也要遵循安全规则\n");

        return prompt.toString();
    }

    /**
     * 文件树转Markdown
     */
    private String fileTreeToMarkdown(List<SkillFileManager.FileNode> nodes, int depth) {
        StringBuilder sb = new StringBuilder();
        for (SkillFileManager.FileNode node : nodes) {
            for (int i = 0; i < depth; i++) {
                sb.append("  ");
            }
            if (node.isDirectory()) {
                sb.append("- 📁 ").append(node.getName()).append("\n");
                if (node.getChildren() != null) {
                    sb.append(fileTreeToMarkdown(node.getChildren(), depth + 1));
                }
            } else {
                sb.append("- 📄 ").append(node.getName());
                if (node.getSize() > 0) {
                    sb.append(" (").append(formatSize(node.getSize())).append(")");
                }
                sb.append("\n");
            }
        }
        return sb.toString();
    }

    private String formatSize(long bytes) {
        if (bytes < 1024) return bytes + "B";
        if (bytes < 1024 * 1024) return (bytes / 1024) + "KB";
        return (bytes / (1024 * 1024)) + "MB";
    }

    /**
     * 调用LLM
     */
    private String callLLM(String prompt) {
        try {
            Map<String, Object> request = new HashMap<>();
            request.put("model", "qwen2.5:14b");
            request.put("prompt", prompt);
            request.put("stream", false);

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(request, headers);
            
            ResponseEntity<String> response = restTemplate.postForEntity(llmUrl, entity, String.class);
            
            if (response.getStatusCode() == HttpStatus.OK) {
                JsonNode root = objectMapper.readTree(response.getBody());
                return root.path("response").asText();
            } else {
                log.error("[SkillConversationService] LLM调用失败: {}", response.getStatusCode());
                return "{}";
            }
        } catch (Exception e) {
            log.error("[SkillConversationService] LLM调用异常", e);
            return "{}";
        }
    }

    /**
     * 解析LLM响应
     */
    private List<FileModification> parseModifications(String llmResponse) {
        List<FileModification> modifications = new ArrayList<>();
        
        try {
            // 尝试提取JSON
            String jsonStr = extractJson(llmResponse);
            JsonNode root = objectMapper.readTree(jsonStr);
            
            JsonNode modsNode = root.path("modifications");
            if (modsNode.isArray()) {
                for (JsonNode modNode : modsNode) {
                    FileModification mod = new FileModification();
                    mod.setAction(modNode.path("action").asText("update"));
                    mod.setFilePath(modNode.path("filePath").asText(""));
                    mod.setReason(modNode.path("reason").asText(""));
                    mod.setNewContent(modNode.path("newContent").asText(""));
                    modifications.add(mod);
                }
            }
        } catch (Exception e) {
            log.error("[SkillConversationService] 解析LLM响应失败", e);
        }
        
        return modifications;
    }

    /**
     * 从文本中提取JSON
     */
    private String extractJson(String text) {
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start != -1 && end != -1 && end > start) {
            return text.substring(start, end + 1);
        }
        return text;
    }

    /**
     * 对话响应
     */
    public static class ConversationResponse {
        private boolean success;
        private String message;
        private List<FileModification> modifications;
        private Map<String, String> originalContents;

        // Getters and Setters
        public boolean isSuccess() { return success; }
        public void setSuccess(boolean success) { this.success = success; }

        public String getMessage() { return message; }
        public void setMessage(String message) { this.message = message; }

        public List<FileModification> getModifications() { return modifications; }
        public void setModifications(List<FileModification> modifications) { this.modifications = modifications; }

        public Map<String, String> getOriginalContents() { return originalContents; }
        public void setOriginalContents(Map<String, String> originalContents) { this.originalContents = originalContents; }
    }

    /**
     * 文件修改建议
     */
    public static class FileModification {
        private String action;  // update, create, delete
        private String filePath;
        private String reason;
        private String newContent;

        // Getters and Setters
        public String getAction() { return action; }
        public void setAction(String action) { this.action = action; }

        public String getFilePath() { return filePath; }
        public void setFilePath(String filePath) { this.filePath = filePath; }

        public String getReason() { return reason; }
        public void setReason(String reason) { this.reason = reason; }

        public String getNewContent() { return newContent; }
        public void setNewContent(String newContent) { this.newContent = newContent; }
    }

    /**
     * 对话消息
     */
    public static class Message {
        private String role;  // user, assistant
        private String content;

        public Message() {}

        public Message(String role, String content) {
            this.role = role;
            this.content = content;
        }

        // Getters and Setters
        public String getRole() { return role; }
        public void setRole(String role) { this.role = role; }

        public String getContent() { return content; }
        public void setContent(String content) { this.content = content; }
    }
}
