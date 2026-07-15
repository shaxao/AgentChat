package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

public class ChatDTO {

    @Data
    public static class ConversationVO {
        private String id;
        private String title;
        private String model;
        private Boolean pinned;
        private List<String> tags;
        private String createdAt;
        private String updatedAt;
        private List<MessageVO> messages;
        private Boolean hasMore; // 是否还有更早的消息（分页加载用）
    }

    @Data
    public static class MessageVO {
        private String id;
        private String role;
        private String content;
        private String model;
        private Integer tokens;
        private String timestamp;
        private Boolean isStreaming;
        private String error;
    }

    @Data
    public static class CreateConversationRequest {
        private String title;
        private String model;
        private String systemPrompt;
        private List<String> tags;
        /** 可选：创建对话时绑定 Agent，用于自动初始化记忆文件 */
        private String agentId;
    }

    @Data
    public static class SendMessageRequest {
        private String content;
        private String model;
        private Double temperature;
        private Integer maxTokens;
        private Double topP;
        private String systemPrompt;
        /** Agent ID（可选），启用 Agent 模式后 LLM 可调用工具 */
        private String agentId;
        /** 图片 base64 列表（可选），用于 Vision 模式 */
        private List<String> imageBase64List;
        /** 已上传文件路径列表（可选），Agent 模式下供工具使用（如 Excel 台账文件） */
        private List<String> uploadedFilePaths;
        /** 文件 OSS URL 列表（可选），文件已上传至 OSS，传递 URL 替代直接上传 */
        private List<String> fileUrls;
        /** 深度思考模式（可选），启用后模型将展示推理过程 */
        private Boolean thinking;
        /** 深度思考预算（可选），控制推理深度，不同厂商语义不同 */
        private Integer thinkingBudget;
        /** 内联继续对话（可选）：传入现有 AI 消息 UUID，新内容追加到该消息而非创建新消息 */
        private String continueMessageId;
        /** 内联继续对话时前端的已有内容（可选）：消息不存在于 DB 时用于补全完整内容 */
        private String existingContent;
    }

    @Data
    public static class PageRequest {
        private Integer page = 1;
        private Integer size = 20;
    }
}
