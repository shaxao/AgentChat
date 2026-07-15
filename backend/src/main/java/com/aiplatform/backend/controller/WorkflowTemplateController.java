package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.WorkflowDTO;
import com.aiplatform.backend.service.WorkflowTemplateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 工作流模板市场控制器（战略改造 v3.0 P3-2）
 * <p>
 * 提供模板搜索/浏览/详情、发布/取消发布、
 * 克隆为工作流、评分等 REST API。
 */
@Slf4j
@RestController
@RequestMapping("/api/workflow-templates")
@RequiredArgsConstructor
public class WorkflowTemplateController {

    private final WorkflowTemplateService templateService;

    // =============================================
    // 模板市场浏览
    // =============================================

    /**
     * 搜索/浏览模板市场
     */
    @PostMapping("/search")
    public Result<WorkflowDTO.TemplatePageResult> search(
            @RequestBody(required = false) WorkflowDTO.TemplateSearchRequest request) {
        if (request == null) {
            request = new WorkflowDTO.TemplateSearchRequest();
        }
        try {
            return Result.ok(templateService.searchTemplates(request));
        } catch (RuntimeException e) {
            log.error("[TemplateMarket] 搜索失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 获取模板详情
     */
    @GetMapping("/{uuid}")
    public Result<WorkflowDTO.WorkflowTemplateVO> detail(@PathVariable String uuid) {
        try {
            return Result.ok(templateService.getTemplate(uuid));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 获取所有分类及每个分类的模板数
     */
    @GetMapping("/categories")
    public Result<List<Map<String, Object>>> categories() {
        try {
            return Result.ok(templateService.getCategories());
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 发布/取消发布
    // =============================================

    /**
     * 用户将工作流发布为模板
     */
    @PreAuthorize("hasAuthority('PERM_workflow:publish')")
    @PostMapping("/publish")
    public Result<WorkflowDTO.WorkflowTemplateVO> publish(
            @RequestBody WorkflowDTO.TemplatePublishRequest request,
            @RequestAttribute Long userId) {
        if (request.getWorkflowId() == null) {
            return Result.fail("请指定要发布的工作流ID");
        }
        if (request.getName() == null || request.getName().trim().isEmpty()) {
            return Result.fail("模板名称不能为空");
        }
        if (request.getName().length() > 128) {
            return Result.fail("模板名称不能超过128个字符");
        }
        try {
            return Result.ok(templateService.publishTemplate(userId, request));
        } catch (RuntimeException e) {
            log.error("[TemplateMarket] 发布失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 取消发布（作者或管理员）
     */
    @PreAuthorize("hasAuthority('PERM_workflow:delete')")
    @DeleteMapping("/{uuid}")
    public Result<Void> unpublish(
            @PathVariable String uuid,
            @RequestAttribute Long userId) {
        try {
            templateService.unpublishTemplate(uuid, userId);
            return Result.ok();
        } catch (RuntimeException e) {
            log.error("[TemplateMarket] 取消发布失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 克隆
    // =============================================

    /**
     * 克隆模板为用户自己的工作流
     */
    @PostMapping("/{uuid}/clone")
    public Result<WorkflowDTO.WorkflowVO> clone(
            @PathVariable String uuid,
            @RequestBody(required = false) WorkflowDTO.TemplateCloneRequest request,
            @RequestAttribute Long userId) {
        if (request == null) {
            request = new WorkflowDTO.TemplateCloneRequest();
        }
        try {
            return Result.ok(templateService.cloneTemplate(uuid, userId, request));
        } catch (RuntimeException e) {
            log.error("[TemplateMarket] 克隆失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 评分
    // =============================================

    /**
     * 给模板评分（1-5分）
     */
    @PostMapping("/{uuid}/rate")
    public Result<Void> rate(
            @PathVariable String uuid,
            @RequestBody WorkflowDTO.TemplateRateRequest request,
            @RequestAttribute Long userId) {
        if (request.getRating() == null || request.getRating() < 1 || request.getRating() > 5) {
            return Result.fail("评分必须在 1-5 之间");
        }
        try {
            templateService.rateTemplate(uuid, userId, request.getRating());
            return Result.ok();
        } catch (RuntimeException e) {
            log.error("[TemplateMarket] 评分失败: {}", e.getMessage());
            return Result.fail(e.getMessage());
        }
    }
}
