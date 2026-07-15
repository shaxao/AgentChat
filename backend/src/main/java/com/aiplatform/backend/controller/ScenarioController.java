package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.ScenarioDTO;
import com.aiplatform.backend.service.ScenarioService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.web.bind.annotation.*;

import java.util.Collection;
import java.util.List;

/**
 * 场景系统控制器（战略改造 v2.0）
 */
@Slf4j
@RestController
@RequestMapping("/api/scenarios")
@RequiredArgsConstructor
public class ScenarioController {

    private final ScenarioService scenarioService;

    // =============================================
    // 查询（公开，需登录）
    // =============================================

    /**
     * 获取所有职业分组（用于场景广场左侧导航）
     */
    @GetMapping("/professions")
    public Result<List<ScenarioDTO.ProfessionGroupVO>> listProfessions() {
        return Result.ok(scenarioService.listProfessionGroups());
    }

    /**
     * 按职业列出场景
     */
    @GetMapping
    public Result<List<ScenarioDTO.ScenarioBriefVO>> list(
            @RequestParam(required = false) String profession) {
        return Result.ok(scenarioService.listByProfession(profession));
    }

    /**
     * 搜索场景
     */
    @GetMapping("/search")
    public Result<List<ScenarioDTO.ScenarioBriefVO>> search(
            @RequestParam String keyword) {
        return Result.ok(scenarioService.search(keyword));
    }

    /**
     * 获取官方场景
     */
    @GetMapping("/official")
    public Result<List<ScenarioDTO.ScenarioBriefVO>> listOfficial() {
        return Result.ok(scenarioService.listOfficial());
    }

    /**
     * 获取社区公开场景（用户创建且公开）
     */
    @GetMapping("/community")
    public Result<List<ScenarioDTO.ScenarioBriefVO>> listCommunity() {
        return Result.ok(scenarioService.listCommunity());
    }

    /**
     * 获取当前用户创建的场景（我的场景，包含私有场景）
     */
    @GetMapping("/my")
    public Result<List<ScenarioDTO.ScenarioBriefVO>> listMy(
            @RequestAttribute Long userId) {
        return Result.ok(scenarioService.listByCreator(userId));
    }

    /**
     * 获取场景详情
     */
    @GetMapping("/{id}")
    public Result<ScenarioDTO.ScenarioVO> detail(@PathVariable Long id) {
        try {
            return Result.ok(scenarioService.getById(id));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 管理员接口（需 ADMIN 角色）
    // =============================================

    /**
     * 管理员：获取所有场景（不过滤 isPublic）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/admin/all")
    public Result<List<ScenarioDTO.ScenarioBriefVO>> listAll() {
        return Result.ok(scenarioService.listAll());
    }

    // =============================================
    // 创建/更新/删除（需登录，权限在 Service 层控制）
    // =============================================

    /**
     * 创建场景（用户自定义/社区贡献）
     */
    @PreAuthorize("hasAuthority('PERM_scenario:publish')")
    @PostMapping
    public Result<ScenarioDTO.ScenarioVO> create(
            @RequestBody ScenarioDTO.ScenarioCreateRequest request,
            @RequestAttribute Long userId) {
        if (request.getName() == null || request.getName().trim().isEmpty()) {
            return Result.fail("场景名称不能为空");
        }
        if (request.getName().length() > 50) {
            return Result.fail("场景名称不能超过50个字符");
        }
        if (request.getDescription() != null && request.getDescription().length() > 500) {
            return Result.fail("场景描述不能超过500个字符");
        }
        if (request.getSystemPrompt() != null && request.getSystemPrompt().length() > 10000) {
            return Result.fail("系统提示词不能超过10000个字符");
        }
        try {
            return Result.ok(scenarioService.create(request, userId));
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            String msg = e.getMessage();
            if (msg != null && msg.contains("Duplicate entry") && msg.contains("uk_scenario_name_profession")) {
                log.warn("[Scenario] 重复名称冲突: {}", msg);
                return Result.fail("场景名称已存在，同一职业下不能有重名场景，请修改名称");
            }
            log.error("[Scenario] 数据完整性冲突", e);
            return Result.fail("数据保存失败，请检查输入信息后重试");
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 更新场景
     */
    @PreAuthorize("hasAuthority('PERM_scenario:edit')")
    @PutMapping("/{id}")
    public Result<ScenarioDTO.ScenarioVO> update(
            @PathVariable Long id,
            @RequestBody ScenarioDTO.ScenarioUpdateRequest request,
            @RequestAttribute Long userId) {
        if (request.getName() != null && request.getName().length() > 50) {
            return Result.fail("场景名称不能超过50个字符");
        }
        if (request.getDescription() != null && request.getDescription().length() > 500) {
            return Result.fail("场景描述不能超过500个字符");
        }
        if (request.getSystemPrompt() != null && request.getSystemPrompt().length() > 10000) {
            return Result.fail("系统提示词不能超过10000个字符");
        }
        try {
            boolean isAdmin = isAdmin();
            return Result.ok(scenarioService.update(id, request, userId, isAdmin));
        } catch (org.springframework.dao.DataIntegrityViolationException e) {
            String msg = e.getMessage();
            if (msg != null && msg.contains("Duplicate entry") && msg.contains("uk_scenario_name_profession")) {
                log.warn("[Scenario] 重复名称冲突: {}", msg);
                return Result.fail("场景名称已存在，同一职业下不能有重名场景，请修改名称");
            }
            log.error("[Scenario] 数据完整性冲突", e);
            return Result.fail("数据保存失败，请检查输入信息后重试");
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 删除场景（逻辑删除）
     */
    @PreAuthorize("hasAuthority('PERM_scenario:delete')")
    @DeleteMapping("/{id}")
    public Result<Void> delete(
            @PathVariable Long id,
            @RequestAttribute Long userId) {
        try {
            boolean isAdmin = isAdmin();
            scenarioService.delete(id, userId, isAdmin);
            return Result.ok();
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 激活（公开，需登录）
    // =============================================

    /**
     * 激活场景——返回完整配置（systemPrompt + 推荐技能列表）
     * 前端收到后自动应用配置：设置 system prompt、安装推荐技能
     */
    @PostMapping("/{id}/activate")
    public Result<ScenarioDTO.ScenarioActivateResponse> activate(@PathVariable Long id) {
        try {
            return Result.ok(scenarioService.activate(id));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 切换场景公开/私有状态（创作者可切换）
     */
    @PostMapping("/{id}/toggle-public")
    public Result<ScenarioDTO.ScenarioVO> togglePublic(
            @PathVariable Long id,
            @RequestAttribute Long userId) {
        try {
            boolean isAdmin = isAdmin();
            return Result.ok(scenarioService.togglePublic(id, userId, isAdmin));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // =============================================
    // 工具方法
    // =============================================

    /**
     * 检查当前用户是否是管理员
     */
    private boolean isAdmin() {
        Authentication authentication = org.springframework.security.core.context.SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null) {
            return false;
        }
        Collection<? extends GrantedAuthority> authorities = authentication.getAuthorities();
        return authorities != null && authorities.stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }
}
