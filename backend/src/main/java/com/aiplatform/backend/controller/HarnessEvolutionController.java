package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.HarnessFailureCase;
import com.aiplatform.backend.entity.HarnessPatch;
import com.aiplatform.backend.entity.HarnessRegressionRun;
import com.aiplatform.backend.entity.HarnessTrace;
import com.aiplatform.backend.entity.HarnessVersion;
import com.aiplatform.backend.service.HarnessEvolutionService;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping({"/api/admin/harness", "/api/harness"})
@RequiredArgsConstructor
public class HarnessEvolutionController {

    private final HarnessEvolutionService harnessEvolutionService;

    @GetMapping("/overview")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Map<String, Object>> overview(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "30") int limit) {
        return Result.ok(harnessEvolutionService.overview(surface, limit));
    }

    @GetMapping("/traces")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<HarnessTrace>> traces(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.recentTraces(surface, limit));
    }

    @GetMapping("/traces/page")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Result.PageResult<HarnessTrace>> tracePage(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int size) {
        return Result.ok(harnessEvolutionService.pageTraces(surface, page, size));
    }

    @GetMapping("/traces/{id}")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<HarnessTrace> trace(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.getTrace(id));
    }

    @GetMapping("/failures")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<HarnessFailureCase>> failures(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.recentFailures(surface, limit));
    }

    @GetMapping("/failures/page")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Result.PageResult<HarnessFailureCase>> failurePage(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int size) {
        return Result.ok(harnessEvolutionService.pageFailures(surface, page, size));
    }

    @GetMapping("/failures/recurring")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<Map<String, Object>>> recurringFailures(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "2") int minCount,
            @RequestParam(defaultValue = "20") int limit) {
        return Result.ok(harnessEvolutionService.recurringFailureGroups(surface, minCount, limit));
    }

    @PostMapping("/failures/recurring/promote")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<List<HarnessPatch>> promoteRecurringFailures(
            @RequestAttribute(required = false) Long userId,
            @RequestBody(required = false) Map<String, Object> body) {
        String surface = body != null ? (String) body.get("surface") : null;
        int minCount = body != null && body.get("minCount") != null
                ? Integer.parseInt(String.valueOf(body.get("minCount")))
                : 2;
        return Result.ok(harnessEvolutionService.promoteRecurringFailures(surface, minCount, userId));
    }

    @PostMapping("/patches/auto-generate")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<List<HarnessPatch>> autoGeneratePatches(
            @RequestAttribute(required = false) Long userId,
            @RequestBody(required = false) Map<String, Object> body) {
        String surface = body != null ? (String) body.get("surface") : null;
        int minCount = body != null && body.get("minCount") != null
                ? Integer.parseInt(String.valueOf(body.get("minCount")))
                : 2;
        int limit = body != null && body.get("limit") != null
                ? Integer.parseInt(String.valueOf(body.get("limit")))
                : 20;
        return Result.ok(harnessEvolutionService.autoGeneratePatches(surface, minCount, limit, userId));
    }

    @GetMapping("/regression-cases")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<Map<String, Object>>> regressionCases(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.regressionCases(surface, limit));
    }

    @GetMapping("/regression-preview")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Map<String, Object>> regressionPreview(
            @RequestParam(required = false) String surface,
            @RequestParam(required = false) Long versionId,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.regressionPreview(surface, versionId, limit));
    }

    @GetMapping("/regression-runs")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<HarnessRegressionRun>> regressionRuns(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.recentRegressionRuns(surface, limit));
    }

    @GetMapping("/regression-runs/{id}")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<HarnessRegressionRun> regressionRun(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.getRegressionRun(id));
    }

    @GetMapping("/regression-runs/{id}/bundle")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Map<String, Object>> regressionRunBundle(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.regressionRunBundle(id));
    }

    @PostMapping("/regression-runs")
    @PreAuthorize("hasAuthority('PERM_harness:regression')")
    public Result<HarnessRegressionRun> createRegressionRun(
            @RequestAttribute(required = false) Long userId,
            @RequestBody(required = false) Map<String, Object> body) {
        String surface = body != null ? (String) body.get("surface") : null;
        Long versionId = body != null && body.get("versionId") != null
                ? Long.valueOf(String.valueOf(body.get("versionId")))
                : null;
        return Result.ok(harnessEvolutionService.createRegressionRun(surface, versionId, userId));
    }

    @PutMapping("/regression-runs/{id}/start")
    @PreAuthorize("hasAuthority('PERM_harness:regression')")
    public Result<HarnessRegressionRun> startRegressionRun(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.startRegressionRun(id));
    }

    @PostMapping("/regression-runs/{id}/preflight")
    @PreAuthorize("hasAuthority('PERM_harness:regression')")
    public Result<HarnessRegressionRun> runRegressionPreflight(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.runRegressionPreflight(id));
    }

    @PutMapping("/regression-runs/{id}/complete")
    @PreAuthorize("hasAuthority('PERM_harness:regression')")
    public Result<HarnessRegressionRun> completeRegressionRun(
            @PathVariable Long id,
            @RequestBody Map<String, Object> body) {
        return Result.ok(harnessEvolutionService.completeRegressionRun(id, body));
    }

    @GetMapping("/failures/{id}")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<HarnessFailureCase> failure(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.getFailure(id));
    }

    @PutMapping("/failures/{id}/status")
    @PreAuthorize("hasAnyAuthority('PERM_harness:patch','PERM_harness:regression')")
    public Result<HarnessFailureCase> updateFailureStatus(
            @PathVariable Long id,
            @RequestBody Map<String, String> body) {
        return Result.ok(harnessEvolutionService.updateFailureStatus(id, body.get("status")));
    }

    @GetMapping("/patches")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<HarnessPatch>> patches(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.recentPatches(surface, limit));
    }

    @GetMapping("/patches/page")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<Result.PageResult<HarnessPatch>> patchPage(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "30") int size) {
        return Result.ok(harnessEvolutionService.pagePatches(surface, page, size));
    }

    @PostMapping("/patches/generate")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<HarnessPatch> generatePatch(
            @RequestAttribute(required = false) Long userId,
            @RequestBody(required = false) Map<String, String> body) {
        String surface = body != null ? body.get("surface") : null;
        String failureType = body != null ? body.get("failureType") : null;
        return Result.ok(harnessEvolutionService.generatePatch(surface, failureType, userId));
    }

    @PutMapping("/patches/{id}/status")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<HarnessPatch> updatePatchStatus(
            @RequestAttribute(required = false) Long userId,
            @PathVariable Long id,
            @RequestBody Map<String, String> body) {
        return Result.ok(harnessEvolutionService.updatePatchStatus(id, body.get("status"), userId));
    }

    @GetMapping("/versions")
    @PreAuthorize("hasAuthority('PERM_harness:view')")
    public Result<List<HarnessVersion>> versions(
            @RequestParam(required = false) String surface,
            @RequestParam(defaultValue = "50") int limit) {
        return Result.ok(harnessEvolutionService.versions(surface, limit));
    }

    @PostMapping("/versions/from-patch/{patchId}")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<HarnessVersion> createVersionFromPatch(
            @RequestAttribute(required = false) Long userId,
            @PathVariable Long patchId) {
        return Result.ok(harnessEvolutionService.createVersionFromPatch(patchId, userId));
    }

    @PutMapping("/versions/{id}/activate")
    @PreAuthorize("hasAuthority('PERM_harness:patch')")
    public Result<HarnessVersion> activateVersion(@PathVariable Long id) {
        return Result.ok(harnessEvolutionService.activateVersion(id));
    }
}
