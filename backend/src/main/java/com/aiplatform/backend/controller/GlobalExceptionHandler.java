package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> handleValidation(MethodArgumentNotValidException ex) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.joining("; "));
        return Result.fail(400, msg);
    }

    @ExceptionHandler(AccessDeniedException.class)
    public Result<Void> handleAccessDenied(AccessDeniedException ex) {
        return Result.fail(403, "权限不足，请联系管理员开通权限");
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public Result<Void> handleDataIntegrity(DataIntegrityViolationException ex) {
        log.warn("[GlobalException] 数据约束异常: {}", ex.getMessage(), ex);
        return Result.fail(400, friendlyDataIntegrityMessage(ex));
    }

    @ExceptionHandler(RuntimeException.class)
    public Result<Void> handleRuntime(RuntimeException ex) {
        String message = ex.getMessage();
        if (isInternalErrorMessage(message)) {
            log.error("[GlobalException] 内部运行异常: {}", message, ex);
            return Result.fail(500, "请求处理失败，请稍后重试或联系管理员");
        }
        return Result.fail(400, message != null && !message.isBlank() ? message : "请求处理失败");
    }

    @ExceptionHandler(Exception.class)
    public Result<Void> handleGeneral(Exception ex) {
        log.error("[GlobalException] 未处理异常: {}", ex.getMessage(), ex);
        return Result.fail(500, "服务器内部错误，请稍后重试");
    }

    private String friendlyDataIntegrityMessage(DataIntegrityViolationException ex) {
        String message = String.valueOf(ex.getMostSpecificCause() != null
                ? ex.getMostSpecificCause().getMessage()
                : ex.getMessage());
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
        return "数据不符合唯一性或完整性要求，请检查后重试";
    }

    private boolean isInternalErrorMessage(String message) {
        if (message == null) {
            return false;
        }
        return message.contains("### Error")
                || message.contains("SQLIntegrityConstraintViolationException")
                || message.contains("java.sql.")
                || message.contains("bad SQL grammar")
                || message.contains("Mapper.java")
                || message.contains("Duplicate entry");
    }
}
