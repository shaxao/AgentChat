package com.aiplatform.backend.agent;

import java.util.List;

/**
 * Agent 会话上下文
 * <p>
 * 使用 ThreadLocal 在 ReAct 循环中传递会话级别的上下文信息，
 * 使得 ToolExecutor 可以访问当前用户的 sessionId、userId 等信息。
 * <p>
 * 用法：
 * <pre>
 *   AgentSessionContext.setSessionId("user-123-session-456");
 *   try {
 *       // 在 ReAct 循环中执行工具
 *       toolExecutor.execute(toolName, args);
 *   } finally {
 *       AgentSessionContext.clear();
 *   }
 * </pre>
 */
public class AgentSessionContext {

    private static final ThreadLocal<String> SESSION_ID = new ThreadLocal<>();
    private static final ThreadLocal<Long> USER_ID = new ThreadLocal<>();
    /** 当前 Agent 会话使用的模型（由 ChatController 通过 effectiveModel 设置） */
    private static final ThreadLocal<String> MODEL = new ThreadLocal<>();
    /** 当前会话已上传的文件路径列表（如 Excel 台账文件），供工具直接使用 */
    private static final ThreadLocal<List<String>> UPLOADED_FILE_PATHS = new ThreadLocal<>();

    public static void setSessionId(String sessionId) {
        SESSION_ID.set(sessionId);
    }

    public static String getSessionId() {
        String sid = SESSION_ID.get();
        return sid != null ? sid : "default";
    }

    public static void setUserId(Long userId) {
        USER_ID.set(userId);
    }

    public static Long getUserId() {
        return USER_ID.get();
    }

    public static void setModel(String model) {
        MODEL.set(model);
    }

    /** 返回当前会话模型，未设置时返回 null（由下游自动选渠道） */
    public static String getModel() {
        return MODEL.get();
    }

    public static void setUploadedFilePaths(List<String> paths) {
        UPLOADED_FILE_PATHS.set(paths);
    }

    public static List<String> getUploadedFilePaths() {
        return UPLOADED_FILE_PATHS.get();
    }

    public static void clear() {
        SESSION_ID.remove();
        USER_ID.remove();
        MODEL.remove();
        UPLOADED_FILE_PATHS.remove();
    }
}
