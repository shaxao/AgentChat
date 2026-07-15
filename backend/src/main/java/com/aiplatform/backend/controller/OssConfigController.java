package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.OssConfig;
import com.aiplatform.backend.service.OssConfigService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * OSS 存储配置管理（仅管理员）。
 */
@RestController
@RequestMapping("/api/admin/oss")
@RequiredArgsConstructor
public class OssConfigController {

    private final OssConfigService ossConfigService;

    private void requireAdmin(String role) {
        if (!"admin".equals(role)) throw new RuntimeException("无权限，仅管理员可操作");
    }

    @GetMapping
    public Result<List<OssConfig>> list(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(ossConfigService.listAll());
    }

    @GetMapping("/{uuid}")
    public Result<OssConfig> detail(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        return Result.ok(ossConfigService.getByUuid(uuid));
    }

    @PostMapping
    public Result<OssConfig> create(@RequestAttribute String userRole, @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        var cfg = ossConfigService.create(
                (String) body.get("name"),
                (String) body.get("provider"),
                (String) body.get("endpoint"),
                (String) body.get("region"),
                (String) body.get("bucket"),
                (String) body.get("accessKey"),
                (String) body.get("secretKey"),
                (String) body.getOrDefault("basePath", "tool_results")
        );
        return Result.ok(cfg);
    }

    @PutMapping("/{uuid}")
    public Result<OssConfig> update(@RequestAttribute String userRole, @PathVariable String uuid,
                                     @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        var cfg = ossConfigService.update(uuid,
                (String) body.get("name"),
                (String) body.get("provider"),
                (String) body.get("endpoint"),
                (String) body.get("region"),
                (String) body.get("bucket"),
                (String) body.get("accessKey"),
                (String) body.get("secretKey"),
                (String) body.get("basePath")
        );
        return Result.ok(cfg);
    }

    @DeleteMapping("/{uuid}")
    public Result<Void> delete(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        ossConfigService.delete(uuid);
        return Result.ok(null);
    }

    @PostMapping("/{uuid}/toggle")
    public Result<OssConfig> toggle(@RequestAttribute String userRole, @PathVariable String uuid,
                                     @RequestBody Map<String, String> body) {
        requireAdmin(userRole);
        return Result.ok(ossConfigService.toggleStatus(uuid, body.get("status")));
    }

    @PostMapping("/{uuid}/default")
    public Result<OssConfig> setDefault(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        return Result.ok(ossConfigService.setDefault(uuid));
    }

    @PostMapping("/{uuid}/test")
    public Result<String> testConnection(@RequestAttribute String userRole, @PathVariable String uuid) {
        requireAdmin(userRole);
        return Result.ok(ossConfigService.testConnection(uuid));
    }
}
