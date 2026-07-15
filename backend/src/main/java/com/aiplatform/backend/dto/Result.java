package com.aiplatform.backend.dto;

import lombok.Data;
import java.util.List;

/** 统一响应体。 */
@Data
public class Result<T> {
    private Integer code;
    private String message;
    private T data;

    public static <T> Result<T> ok(T data) {
        Result<T> r = new Result<>();
        r.code = 200;
        r.message = "success";
        r.data = data;
        return r;
    }

    public static <T> Result<T> ok() {
        return ok(null);
    }

    public static <T> Result<T> fail(int code, String message) {
        Result<T> r = new Result<>();
        r.code = code;
        r.message = sanitizeMessage(message);
        return r;
    }

    public static <T> Result<T> fail(String message) {
        return fail(400, message);
    }

    private static String sanitizeMessage(String message) {
        if (message == null || message.isBlank()) {
            return "请求处理失败";
        }
        if (containsInternalDatabaseDetail(message)) {
            String lowerMessage = message.toLowerCase();
            boolean duplicate = lowerMessage.contains("duplicate entry") || lowerMessage.contains("duplicate key");
            if (message.contains("sys_user.email") || (duplicate && lowerMessage.contains("email"))) {
                return "邮箱已存在";
            }
            if (message.contains("sys_user.username") || (duplicate && lowerMessage.contains("username"))) {
                return "用户名已存在";
            }
            if (message.contains("Duplicate entry")) {
                return "数据已存在，请检查唯一字段";
            }
            return "请求处理失败，请稍后重试或联系管理员";
        }
        return message;
    }

    private static boolean containsInternalDatabaseDetail(String message) {
        return message.contains("### Error")
                || message.contains("SQLIntegrityConstraintViolationException")
                || message.contains("java.sql.")
                || message.contains("bad SQL grammar")
                || message.contains("Mapper.java")
                || message.contains("Duplicate entry");
    }

    @Data
    public static class PageResult<T> {
        private List<T> list;
        private long total;
        private int page;
        private int size;

        public PageResult(List<T> list, long total, int page, int size) {
            this.list = list;
            this.total = total;
            this.page = page;
            this.size = size;
        }
    }
}
