package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.HarnessFailureCase;
import com.aiplatform.backend.entity.HarnessPatch;
import com.aiplatform.backend.entity.HarnessRegressionRun;
import com.aiplatform.backend.entity.HarnessTrace;
import com.aiplatform.backend.entity.HarnessTraceEvent;
import com.aiplatform.backend.entity.HarnessVersion;
import com.aiplatform.backend.mapper.HarnessFailureCaseMapper;
import com.aiplatform.backend.mapper.HarnessPatchMapper;
import com.aiplatform.backend.mapper.HarnessRegressionRunMapper;
import com.aiplatform.backend.mapper.HarnessTraceMapper;
import com.aiplatform.backend.mapper.HarnessTraceEventMapper;
import com.aiplatform.backend.mapper.HarnessVersionMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessEvolutionService {

    public static final String DEFAULT_CHAT_HARNESS = "chat-harness-v1";
    public static final String DEFAULT_AUTOCODE_HARNESS = "autocode-harness-v1";

    private static final TypeReference<List<Map<String, Object>>> EVENT_LIST_TYPE = new TypeReference<>() {};
    private static final DateTimeFormatter VERSION_TIME_FORMAT = DateTimeFormatter.ofPattern("yyyyMMddHHmmss");

    private final HarnessTraceMapper traceMapper;
    private final HarnessFailureCaseMapper failureCaseMapper;
    private final HarnessPatchMapper patchMapper;
    private final HarnessRegressionRunMapper regressionRunMapper;
    private final HarnessVersionMapper versionMapper;
    private final HarnessTraceEventMapper traceEventMapper;
    private final HarnessReplayToolSandboxService replayToolSandboxService;
    private final ObjectMapper objectMapper;

    public Long startTrace(String surface, Long userId, Long conversationId, String conversationUuid,
                           String taskId, String model, String harnessVersion,
                           String inputSummary, Map<String, Object> request, Map<String, Object> context) {
        try {
            String normalizedSurface = normalizeSurface(surface, "chat");
            HarnessTrace trace = new HarnessTrace();
            trace.setTraceUuid(UUID.randomUUID().toString());
            trace.setSurface(normalizedSurface);
            trace.setUserId(userId);
            trace.setConversationId(conversationId);
            trace.setConversationUuid(conversationUuid);
            trace.setTaskId(taskId);
            trace.setModel(model);
            trace.setHarnessVersion(blankTo(harnessVersion, runtimeVersionCode(normalizedSurface, userId, conversationUuid)));
            trace.setStatus("running");
            trace.setInputSummary(truncate(inputSummary, 1000));
            trace.setRequestJson(toJson(request));
            trace.setContextJson(toJson(context));
            trace.setEventsJson("[]");
            traceMapper.insert(trace);
            return trace.getId();
        } catch (Exception e) {
            log.warn("[Harness] startTrace failed: {}", e.getMessage());
            return null;
        }
    }

    public void addEvent(Long traceId, String type, String name, Map<String, Object> payload) {
        if (traceId == null) return;
        try {
            HarnessTrace trace = traceMapper.selectById(traceId);
            if (trace == null) return;
            Map<String, Object> safePayload = payload != null ? payload : Map.of();
            int seq = nextTraceEventSeq(traceId);

            HarnessTraceEvent row = new HarnessTraceEvent();
            row.setTraceId(traceId);
            row.setSurface(blankTo(trace.getSurface(), "chat"));
            row.setSeq(seq);
            row.setEventType(truncate(blankTo(type, "event"), 50));
            row.setEventName(truncate(blankTo(name, "unnamed"), 100));
            row.setSeverity(truncate(blankTo(valueAsString(safePayload.get("severity")), "info"), 20));
            row.setStatus(truncate(blankTo(valueAsString(safePayload.get("status")), "ok"), 20));
            row.setAgentId(truncate(valueAsString(safePayload.get("agentId")), 100));
            row.setModel(truncate(blankTo(valueAsString(safePayload.get("model")), trace.getModel()), 100));
            row.setProvider(truncate(blankTo(valueAsString(safePayload.get("provider")), trace.getProvider()), 50));
            row.setChannelId(truncate(blankTo(valueAsString(safePayload.get("channelId")), trace.getChannelId()), 100));
            row.setTurnIndex(valueAsInteger(safePayload.get("turnIndex")));
            row.setToolName(truncate(valueAsString(safePayload.get("toolName")), 120));
            row.setToolCallId(truncate(valueAsString(safePayload.get("toolCallId")), 120));
            row.setDurationMs(valueAsInteger(safePayload.get("durationMs")));
            row.setInputChars(valueAsInteger(safePayload.get("inputChars")));
            row.setOutputChars(valueAsInteger(safePayload.get("outputChars")));
            row.setPayloadJson(toJson(safePayload));
            traceEventMapper.insert(row);

            List<Map<String, Object>> events = readEvents(trace.getEventsJson());
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("ts", LocalDateTime.now().toString());
            event.put("seq", seq);
            event.put("type", type);
            event.put("name", name);
            event.put("payload", safePayload);
            events.add(event);
            List<Map<String, Object>> kept = events.size() > 200 ? events.subList(events.size() - 200, events.size()) : events;
            trace.setEventsJson(toJson(kept));
            traceMapper.updateById(trace);
        } catch (Exception e) {
            log.warn("[Harness] addEvent failed: {}", e.getMessage());
        }
    }

    public void completeTrace(Long traceId, String outputSummary, String provider, String channelId,
                              Integer inputTokens, Integer outputTokens, Integer latencyMs,
                              Map<String, Object> metrics, Map<String, Object> quality) {
        if (traceId == null) return;
        try {
            HarnessTrace trace = traceMapper.selectById(traceId);
            if (trace == null) return;
            trace.setStatus("success");
            trace.setOutputSummary(truncate(outputSummary, 1200));
            trace.setProvider(provider);
            trace.setChannelId(channelId);
            trace.setInputTokens(inputTokens);
            trace.setOutputTokens(outputTokens);
            trace.setLatencyMs(latencyMs);
            trace.setMetricsJson(toJson(metrics));
            trace.setQualityJson(toJson(quality));
            trace.setCompletedAt(LocalDateTime.now());
            traceMapper.updateById(trace);
        } catch (Exception e) {
            log.warn("[Harness] completeTrace failed: {}", e.getMessage());
        }
    }

    public void failTrace(Long traceId, String failureType, String errorMsg, String severity, Map<String, Object> evidence) {
        if (traceId == null) return;
        try {
            HarnessTrace trace = traceMapper.selectById(traceId);
            if (trace == null) return;
            String type = blankTo(failureType, "unknown");
            trace.setStatus("failed");
            trace.setFailureType(type);
            trace.setErrorMsg(truncate(errorMsg, 2000));
            trace.setCompletedAt(LocalDateTime.now());
            traceMapper.updateById(trace);

            Map<String, Object> evidenceMap = evidence != null ? new LinkedHashMap<>(evidence) : new LinkedHashMap<>();
            evidenceMap.putIfAbsent("schema", "harness.failure.evidence.v1");
            evidenceMap.putIfAbsent("traceId", traceId);
            evidenceMap.putIfAbsent("traceUuid", trace.getTraceUuid());
            evidenceMap.putIfAbsent("surface", trace.getSurface());
            evidenceMap.putIfAbsent("failureType", type);
            evidenceMap.putIfAbsent("safeReplay", true);
            evidenceMap.putIfAbsent("replayCase", buildReplayCase(trace, type, errorMsg));
            Map<String, Object> failureEvent = new LinkedHashMap<>();
            failureEvent.put("failureType", type);
            failureEvent.put("severity", blankTo(severity, "medium"));
            failureEvent.put("status", "failed");
            failureEvent.put("message", truncate(errorMsg, 1000));
            addEvent(traceId, "failure", "failure_classified", failureEvent);

            HarnessFailureCase failure = new HarnessFailureCase();
            failure.setTraceId(traceId);
            failure.setSurface(trace.getSurface());
            failure.setFailureType(type);
            failure.setSeverity(blankTo(severity, "medium"));
            failure.setSummary(truncate(errorMsg, 1000));
            failure.setEvidenceJson(toJson(evidenceMap));
            failure.setStatus("open");
            failureCaseMapper.insert(failure);
        } catch (Exception e) {
            log.warn("[Harness] failTrace failed: {}", e.getMessage());
        }
    }

    public List<HarnessTrace> recentTraces(String surface, int limit) {
        LambdaQueryWrapper<HarnessTrace> qw = traceFilter(surface);
        qw.orderByDesc(HarnessTrace::getCreatedAt).last("LIMIT " + safeLimit(limit, 200));
        return traceMapper.selectList(qw);
    }

    public List<HarnessFailureCase> recentFailures(String surface, int limit) {
        LambdaQueryWrapper<HarnessFailureCase> qw = failureFilter(surface);
        qw.orderByDesc(HarnessFailureCase::getCreatedAt).last("LIMIT " + safeLimit(limit, 200));
        return failureCaseMapper.selectList(qw);
    }

    public List<HarnessPatch> recentPatches(String surface, int limit) {
        LambdaQueryWrapper<HarnessPatch> qw = patchFilter(surface);
        qw.orderByDesc(HarnessPatch::getCreatedAt).last("LIMIT " + safeLimit(limit, 200));
        return patchMapper.selectList(qw);
    }

    public List<HarnessVersion> versions(String surface, int limit) {
        LambdaQueryWrapper<HarnessVersion> qw = versionFilter(surface);
        qw.orderByDesc(HarnessVersion::getCreatedAt).last("LIMIT " + safeLimit(limit, 200));
        return versionMapper.selectList(qw);
    }

    public List<HarnessRegressionRun> recentRegressionRuns(String surface, int limit) {
        LambdaQueryWrapper<HarnessRegressionRun> qw = regressionRunFilter(surface);
        qw.orderByDesc(HarnessRegressionRun::getCreatedAt).last("LIMIT " + safeLimit(limit, 200));
        return regressionRunMapper.selectList(qw);
    }

    public HarnessRegressionRun getRegressionRun(Long id) {
        HarnessRegressionRun run = regressionRunMapper.selectById(id);
        if (run == null) {
            throw new IllegalArgumentException("Regression run does not exist");
        }
        return run;
    }

    public Result.PageResult<HarnessTrace> pageTraces(String surface, int page, int size) {
        int p = safePage(page);
        int s = safeSize(size);
        LambdaQueryWrapper<HarnessTrace> countQw = traceFilter(surface);
        long total = traceMapper.selectCount(countQw);
        LambdaQueryWrapper<HarnessTrace> listQw = traceFilter(surface);
        listQw.orderByDesc(HarnessTrace::getCreatedAt).last("LIMIT " + ((p - 1) * s) + "," + s);
        return new Result.PageResult<>(traceMapper.selectList(listQw), total, p, s);
    }

    public Result.PageResult<HarnessFailureCase> pageFailures(String surface, int page, int size) {
        int p = safePage(page);
        int s = safeSize(size);
        LambdaQueryWrapper<HarnessFailureCase> countQw = failureFilter(surface);
        long total = failureCaseMapper.selectCount(countQw);
        LambdaQueryWrapper<HarnessFailureCase> listQw = failureFilter(surface);
        listQw.orderByDesc(HarnessFailureCase::getCreatedAt).last("LIMIT " + ((p - 1) * s) + "," + s);
        return new Result.PageResult<>(failureCaseMapper.selectList(listQw), total, p, s);
    }

    public Result.PageResult<HarnessPatch> pagePatches(String surface, int page, int size) {
        int p = safePage(page);
        int s = safeSize(size);
        LambdaQueryWrapper<HarnessPatch> countQw = patchFilter(surface);
        long total = patchMapper.selectCount(countQw);
        LambdaQueryWrapper<HarnessPatch> listQw = patchFilter(surface);
        listQw.orderByDesc(HarnessPatch::getCreatedAt).last("LIMIT " + ((p - 1) * s) + "," + s);
        return new Result.PageResult<>(patchMapper.selectList(listQw), total, p, s);
    }

    public HarnessTrace getTrace(Long id) {
        HarnessTrace trace = traceMapper.selectById(id);
        if (trace == null) {
            throw new IllegalArgumentException("Trace does not exist");
        }
        return trace;
    }

    public List<HarnessTraceEvent> traceEvents(Long traceId) {
        HarnessTrace trace = getTrace(traceId);
        return traceEventMapper.selectList(new LambdaQueryWrapper<HarnessTraceEvent>()
                .eq(HarnessTraceEvent::getTraceId, trace.getId())
                .orderByAsc(HarnessTraceEvent::getSeq)
                .orderByAsc(HarnessTraceEvent::getCreatedAt));
    }

    public HarnessFailureCase getFailure(Long id) {
        HarnessFailureCase failure = failureCaseMapper.selectById(id);
        if (failure == null) {
            throw new IllegalArgumentException("Failure case does not exist");
        }
        return failure;
    }

    public HarnessFailureCase updateFailureStatus(Long id, String status) {
        HarnessFailureCase failure = getFailure(id);
        String next = normalizeStatus(status);
        if (!List.of("open", "resolved", "ignored", "regression").contains(next)) {
            throw new IllegalArgumentException("Unsupported failure status: " + status);
        }
        failure.setStatus(next);
        failure.setResolvedAt(("resolved".equals(next) || "ignored".equals(next)) ? LocalDateTime.now() : null);
        failureCaseMapper.updateById(failure);
        return failure;
    }

    public List<Map<String, Object>> regressionCases(String surface, int limit) {
        LambdaQueryWrapper<HarnessFailureCase> qw = failureFilter(surface);
        qw.eq(HarnessFailureCase::getStatus, "regression")
                .orderByDesc(HarnessFailureCase::getCreatedAt)
                .last("LIMIT " + safeLimit(limit, 200));
        List<HarnessFailureCase> failures = failureCaseMapper.selectList(qw);
        List<Map<String, Object>> cases = new ArrayList<>();
        for (HarnessFailureCase failure : failures) {
            HarnessTrace trace = failure.getTraceId() != null ? traceMapper.selectById(failure.getTraceId()) : null;
            Map<String, Object> evidence = mutableJsonMap(failure.getEvidenceJson());
            Map<String, Object> replayCase = mutableMap(evidence.get("replayCase"));
            if (replayCase.isEmpty() && trace != null) {
                replayCase = buildReplayCase(trace, failure.getFailureType(), failure.getSummary());
            }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", failure.getId());
            item.put("traceId", failure.getTraceId());
            item.put("surface", failure.getSurface());
            item.put("failureType", failure.getFailureType());
            item.put("severity", blankTo(failure.getSeverity(), "medium"));
            item.put("input", trace != null ? blankTo(trace.getInputSummary(), "") : "");
            item.put("expected", "The same failure must not recur; output should be executable, observable, and within boundaries.");
            item.put("avoid", failure.getSummary());
            item.put("model", trace != null ? trace.getModel() : null);
            item.put("taskId", trace != null ? trace.getTaskId() : null);
            item.put("conversationUuid", trace != null ? trace.getConversationUuid() : null);
            item.put("events", summarizeEvents(trace != null ? trace.getEventsJson() : null));
            item.put("replayCase", replayCase);
            item.put("evidence", evidence);
            item.put("createdAt", failure.getCreatedAt());
            cases.add(item);
        }
        return cases;
    }

    public Map<String, Object> regressionPreview(String surface, Long versionId, int limit) {
        HarnessVersion version = versionId != null ? versionMapper.selectById(versionId) : null;
        String targetSurface = version != null ? version.getSurface() : surface;
        List<Map<String, Object>> cases = regressionCases(targetSurface, limit);
        Map<String, Long> byType = cases.stream()
                .collect(Collectors.groupingBy(c -> String.valueOf(c.get("failureType")), LinkedHashMap::new, Collectors.counting()));
        Map<String, Long> bySeverity = cases.stream()
                .collect(Collectors.groupingBy(c -> String.valueOf(c.get("severity")), LinkedHashMap::new, Collectors.counting()));

        List<Map<String, Object>> checklist = cases.stream().limit(20).map(item -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("caseId", item.get("id"));
            row.put("surface", item.get("surface"));
            row.put("failureType", item.get("failureType"));
            row.put("severity", item.get("severity"));
            row.put("input", item.get("input"));
            row.put("expected", item.get("expected"));
            row.put("avoid", item.get("avoid"));
            row.put("model", item.get("model"));
            row.put("conversationUuid", item.get("conversationUuid"));
            row.put("traceId", item.get("traceId"));
            row.put("replayCase", item.get("replayCase"));
            row.put("status", "pending_manual_or_ci_run");
            return row;
        }).toList();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("version", version);
        result.put("surface", blankTo(targetSurface, "all"));
        result.put("caseCount", cases.size());
        result.put("byFailureType", byType);
        result.put("bySeverity", bySeverity);
        result.put("checklist", checklist);
        return result;
    }

    @Transactional
    public HarnessRegressionRun createRegressionRun(String surface, Long versionId, Long createdBy) {
        HarnessVersion version = versionId != null ? versionMapper.selectById(versionId) : null;
        if (versionId != null && version == null) {
            throw new IllegalArgumentException("Harness version does not exist");
        }
        String targetSurface = version != null ? version.getSurface() : normalizeSurface(surface, "all");
        Map<String, Object> preview = regressionPreview(targetSurface, versionId, 200);
        int caseCount = (int) preview.getOrDefault("caseCount", 0);

        HarnessRegressionRun run = new HarnessRegressionRun();
        run.setRunUuid(UUID.randomUUID().toString());
        run.setSurface(targetSurface);
        run.setVersionId(version != null ? version.getId() : null);
        run.setVersion(version != null ? version.getVersion() : null);
        run.setStatus("pending");
        run.setTotalCases(caseCount);
        run.setPassedCases(0);
        run.setFailedCases(0);
        run.setBlockedCases(0);
        run.setSummary("Regression run created from current regression cases. Awaiting manual or CI execution.");
        run.setResultJson(toJson(preview));
        run.setCreatedBy(createdBy);
        regressionRunMapper.insert(run);
        return run;
    }

    @Transactional
    public HarnessRegressionRun startRegressionRun(Long id) {
        HarnessRegressionRun run = getRegressionRun(id);
        String current = normalizeStatus(run.getStatus());
        if (!"pending".equals(current)) {
            throw new IllegalStateException("Only pending regression runs can be started");
        }
        Map<String, Object> result = mutableJsonMap(run.getResultJson());
        result.put("runMode", "external_or_ci");
        result.put("startedAt", LocalDateTime.now().toString());
        result.put("status", "running");
        run.setStatus("running");
        run.setSummary("Regression run is running. Complete it with structured case results from manual or CI execution.");
        run.setResultJson(toJson(result));
        regressionRunMapper.updateById(run);
        return run;
    }

    @Transactional
    public HarnessRegressionRun runRegressionPreflight(Long id) {
        HarnessRegressionRun run = getRegressionRun(id);
        String current = normalizeStatus(run.getStatus());
        if (!List.of("pending", "running").contains(current)) {
            throw new IllegalStateException("Only pending or running regression runs can execute preflight checks");
        }

        Map<String, Object> bundle = regressionRunBundle(id);
        List<Map<String, Object>> checklist = listOfMaps(bundle.get("checklist"));
        HarnessVersion version = run.getVersionId() != null ? versionMapper.selectById(run.getVersionId()) : null;
        Map<String, Object> config = version != null ? readJsonMap(version.getConfigJson()) : Map.of();
        List<String> recommendations = stringList(config.get("recommendations"));

        List<Map<String, Object>> caseResults = new ArrayList<>();
        for (Map<String, Object> item : checklist) {
            String failureType = String.valueOf(item.getOrDefault("failureType", ""));
            boolean hasGuidance = recommendations.stream().anyMatch(rec ->
                    containsToken(rec, failureType)
                            || containsToken(rec, run.getSurface())
                            || containsToken(rec, "review")
                            || containsToken(rec, "security")
                            || containsToken(rec, "model")
                            || containsToken(rec, "quota")
            );
            Map<String, Object> caseResult = new LinkedHashMap<>();
            caseResult.put("caseId", item.get("caseId"));
            caseResult.put("surface", item.get("surface"));
            caseResult.put("failureType", failureType);
            caseResult.put("status", hasGuidance ? "passed" : "failed");
            caseResult.put("summary", hasGuidance
                    ? "Candidate contains explicit harness guidance related to this case."
                    : "Candidate has no explicit guidance that covers this failure pattern.");
            caseResult.put("evidence", Map.of(
                    "runMode", "structural_preflight",
                    "recommendationCount", recommendations.size()
            ));
            caseResults.add(caseResult);
        }

        int total = caseResults.size();
        int failed = (int) caseResults.stream().filter(r -> "failed".equals(String.valueOf(r.get("status")))).count();
        int passed = total - failed;
        Map<String, Object> result = mutableJsonMap(run.getResultJson());
        result.put("runMode", "structural_preflight");
        result.put("caseResults", caseResults);
        result.put("completedAt", LocalDateTime.now().toString());
        result.put("activationEligible", false);
        result.put("note", "Structural preflight is useful for catching empty harness changes, but it does not replace manual or CI execution.");

        run.setStatus(failed > 0 ? "failed" : "blocked");
        run.setTotalCases(total);
        run.setPassedCases(passed);
        run.setFailedCases(failed);
        run.setBlockedCases(0);
        run.setSummary(failed > 0
                ? "Structural preflight failed. Candidate guidance does not cover every regression case."
                : "Structural preflight passed, but external/manual execution is still required before activation.");
        run.setResultJson(toJson(result));
        run.setCompletedAt(LocalDateTime.now());
        regressionRunMapper.updateById(run);
        createFailuresFromRegressionResults(run, caseResults);
        return run;
    }

    @Transactional
    public HarnessRegressionRun executeRegressionRun(Long id) {
        HarnessRegressionRun run = getRegressionRun(id);
        String current = normalizeStatus(run.getStatus());
        if (!List.of("pending", "running", "blocked", "failed").contains(current)) {
            throw new IllegalStateException("Only pending, running, blocked, or failed regression runs can be executed");
        }

        Map<String, Object> bundle = regressionRunBundle(id);
        List<Map<String, Object>> checklist = listOfMaps(bundle.get("checklist"));
        HarnessVersion version = run.getVersionId() != null ? versionMapper.selectById(run.getVersionId()) : null;
        if (version == null) {
            throw new IllegalStateException("Regression execute requires a candidate harness version");
        }

        Map<String, Object> config = normalizePolicyConfig(readJsonMap(version.getConfigJson()));
        Map<String, Object> policy = policyFromConfig(config);
        List<Map<String, Object>> caseResults = new ArrayList<>();
        for (Map<String, Object> item : checklist) {
            caseResults.add(evaluateSafeReplayCase(run, item, policy));
        }

        int total = caseResults.size();
        int failed = countCaseStatus(caseResults, "failed");
        int blocked = countCaseStatus(caseResults, "blocked");
        int passed = total - failed - blocked;
        Map<String, Object> result = mutableJsonMap(run.getResultJson());
        result.put("runMode", "safe_replay_v2");
        result.put("caseResults", caseResults);
        result.put("completedAt", LocalDateTime.now().toString());
        result.put("activationEligible", total > 0 && failed == 0 && blocked == 0);
        result.put("safety", Map.of(
                "noBilling", true,
                "noChatWrites", true,
                "noWalletUpdates", true,
                "noDangerousSideEffects", true
        ));
        result.put("nextStep", failed == 0 && blocked == 0
                ? "Candidate may enter canary or active after admin review."
                : "Fix policy coverage or missing replay evidence and execute replay again.");

        run.setStatus(total > 0 && failed == 0 && blocked == 0 ? "passed" : (blocked > 0 ? "blocked" : "failed"));
        run.setTotalCases(total);
        run.setPassedCases(passed);
        run.setFailedCases(failed);
        run.setBlockedCases(blocked);
        run.setSummary(total > 0 && failed == 0 && blocked == 0
                ? "Safe replay passed all regression cases."
                : "Safe replay found failed or blocked regression cases.");
        run.setResultJson(toJson(result));
        run.setCompletedAt(LocalDateTime.now());
        regressionRunMapper.updateById(run);
        createFailuresFromRegressionResults(run, caseResults);
        return run;
    }

    public Map<String, Object> regressionRunBundle(Long id) {
        HarnessRegressionRun run = getRegressionRun(id);
        HarnessVersion version = run.getVersionId() != null ? versionMapper.selectById(run.getVersionId()) : null;
        Map<String, Object> frozenPreview = readJsonMap(run.getResultJson());
        if (frozenPreview.isEmpty() || !frozenPreview.containsKey("checklist")) {
            frozenPreview = regressionPreview(run.getSurface(), run.getVersionId(), 200);
        }

        Map<String, Object> completionContract = new LinkedHashMap<>();
        completionContract.put("start", Map.of(
                "method", "PUT",
                "path", "/api/admin/harness/regression-runs/" + run.getId() + "/start"
        ));
        completionContract.put("structuralPreflight", Map.of(
                "method", "POST",
                "path", "/api/admin/harness/regression-runs/" + run.getId() + "/preflight",
                "note", "Preflight checks candidate coverage only; it is not activation-eligible."
        ));
        completionContract.put("method", "PUT");
        completionContract.put("path", "/api/admin/harness/regression-runs/" + run.getId() + "/complete");
        completionContract.put("body", Map.of(
                "status", "passed | failed | blocked | cancelled",
                "totalCases", run.getTotalCases() != null ? run.getTotalCases() : 0,
                "passedCases", 0,
                "failedCases", 0,
                "blockedCases", 0,
                "summary", "Short execution summary",
                "runMode", "manual | ci",
                "result", Map.of("caseResults", List.of(Map.of(
                        "caseId", "case id from checklist",
                        "status", "passed | failed | blocked",
                        "summary", "case-level result",
                        "evidence", Map.of("logUrl", "optional", "artifact", "optional")
                )))
        ));

        Map<String, Object> bundle = new LinkedHashMap<>();
        bundle.put("schema", "muhuo.harness.regression.bundle.v1");
        bundle.put("run", run);
        bundle.put("version", version);
        bundle.put("surface", run.getSurface());
        bundle.put("checklist", frozenPreview.getOrDefault("checklist", List.of()));
        bundle.put("caseCount", frozenPreview.getOrDefault("caseCount", run.getTotalCases()));
        bundle.put("byFailureType", frozenPreview.getOrDefault("byFailureType", Map.of()));
        bundle.put("bySeverity", frozenPreview.getOrDefault("bySeverity", Map.of()));
        bundle.put("completionContract", completionContract);
        return bundle;
    }

    @Transactional
    public HarnessRegressionRun completeRegressionRun(Long id, Map<String, Object> body) {
        HarnessRegressionRun run = regressionRunMapper.selectById(id);
        if (run == null) {
            throw new IllegalArgumentException("Regression run does not exist");
        }
        if (!List.of("pending", "running").contains(normalizeStatus(run.getStatus()))) {
            throw new IllegalStateException("Only pending or running regression runs can be completed");
        }
        String status = normalizeStatus(String.valueOf(body.getOrDefault("status", "")));
        if (!List.of("passed", "failed", "blocked", "cancelled").contains(status)) {
            throw new IllegalArgumentException("Unsupported regression run status: " + status);
        }
        List<Map<String, Object>> caseResults = extractCaseResults(body);
        int inferredTotal = !caseResults.isEmpty() ? caseResults.size() : (run.getTotalCases() != null ? run.getTotalCases() : 0);
        int total = valueAsInt(body.get("totalCases"), inferredTotal);
        int inferredPassed = countCaseStatus(caseResults, "passed");
        int inferredFailed = countCaseStatus(caseResults, "failed");
        int inferredBlocked = countCaseStatus(caseResults, "blocked");
        int passed = valueAsInt(body.get("passedCases"), !caseResults.isEmpty() ? inferredPassed : ("passed".equals(status) ? total : 0));
        int failed = valueAsInt(body.get("failedCases"), !caseResults.isEmpty() ? inferredFailed : ("failed".equals(status) ? Math.max(1, total - passed) : 0));
        int blocked = valueAsInt(body.get("blockedCases"), !caseResults.isEmpty() ? inferredBlocked : ("blocked".equals(status) ? Math.max(1, total - passed - failed) : 0));
        if (passed + failed + blocked > total) {
            throw new IllegalArgumentException("Regression case counts exceed total cases");
        }
        if ("passed".equals(status) && (total <= 0 || passed != total || failed != 0 || blocked != 0)) {
            throw new IllegalArgumentException("A passed regression run must pass all cases and have no failures or blockers");
        }

        run.setStatus(status);
        run.setTotalCases(total);
        run.setPassedCases(passed);
        run.setFailedCases(failed);
        run.setBlockedCases(blocked);
        run.setSummary(truncate(String.valueOf(body.getOrDefault("summary", defaultRegressionSummary(status, total, passed, failed, blocked))), 1000));
        Map<String, Object> result = mutableJsonMap(run.getResultJson());
        Object providedResult = body.get("result");
        if (providedResult instanceof Map<?, ?> providedMap) {
            providedMap.forEach((key, value) -> {
                if (key != null) result.put(String.valueOf(key), value);
            });
        } else if (providedResult != null) {
            result.put("rawResult", providedResult);
        }
        if (!caseResults.isEmpty()) {
            result.put("caseResults", caseResults);
        }
        result.put("runMode", blankTo(String.valueOf(body.getOrDefault("runMode", result.getOrDefault("runMode", "manual"))), "manual"));
        result.put("completedAt", LocalDateTime.now().toString());
        result.put("activationEligible", "passed".equals(status));
        run.setResultJson(toJson(result));
        run.setCompletedAt(LocalDateTime.now());
        regressionRunMapper.updateById(run);
        createFailuresFromRegressionResults(run, caseResults);
        return run;
    }

    public Map<String, Object> overview(String surface, int limit) {
        int safeLimit = Math.max(20, Math.min(limit, 500));
        List<HarnessTrace> traces = recentTraces(surface, safeLimit);
        List<HarnessFailureCase> failures = recentFailures(surface, safeLimit);
        List<HarnessPatch> patches = recentPatches(surface, safeLimit);
        List<HarnessVersion> versionList = versions(surface, 50);
        List<HarnessRegressionRun> regressionRuns = recentRegressionRuns(surface, 20);

        long successCount = traces.stream().filter(t -> "success".equalsIgnoreCase(t.getStatus())).count();
        long failedCount = traces.stream().filter(t -> "failed".equalsIgnoreCase(t.getStatus())).count();
        long runningCount = traces.stream().filter(t -> "running".equalsIgnoreCase(t.getStatus())).count();
        double avgLatency = traces.stream()
                .filter(t -> t.getLatencyMs() != null && t.getLatencyMs() > 0)
                .mapToInt(HarnessTrace::getLatencyMs)
                .average()
                .orElse(0);

        Map<String, Long> bySurface = traces.stream()
                .collect(Collectors.groupingBy(t -> blankTo(t.getSurface(), "unknown"), LinkedHashMap::new, Collectors.counting()));
        Map<String, Long> byFailureType = failures.stream()
                .collect(Collectors.groupingBy(f -> blankTo(f.getFailureType(), "unknown"), LinkedHashMap::new, Collectors.counting()));
        Map<String, Long> byPatchStatus = patches.stream()
                .collect(Collectors.groupingBy(p -> blankTo(p.getStatus(), "draft"), LinkedHashMap::new, Collectors.counting()));

        List<Map<String, Object>> topFailures = byFailureType.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue(Comparator.reverseOrder()))
                .limit(8)
                .map(e -> Map.<String, Object>of("type", e.getKey(), "count", e.getValue()))
                .toList();

        return Map.of(
                "summary", Map.of(
                        "totalTraces", traces.size(),
                        "successCount", successCount,
                        "failedCount", failedCount,
                        "runningCount", runningCount,
                        "avgLatencyMs", Math.round(avgLatency),
                        "openFailures", failures.stream().filter(f -> "open".equalsIgnoreCase(f.getStatus())).count(),
                        "draftPatches", patches.stream().filter(p -> "draft".equalsIgnoreCase(p.getStatus())).count(),
                        "versions", versionList.size(),
                        "activeVersions", versionList.stream().filter(v -> "active".equalsIgnoreCase(v.getStatus())).count(),
                        "regressionRuns", regressionRuns.size()
                ),
                "bySurface", bySurface,
                "byFailureType", byFailureType,
                "byPatchStatus", byPatchStatus,
                "topFailures", topFailures,
                "versions", versionList,
                "regressionRuns", regressionRuns,
                "traces", traces.stream().limit(Math.min(limit, 100)).toList(),
                "failures", failures.stream().limit(Math.min(limit, 100)).toList(),
                "patches", patches.stream().limit(Math.min(limit, 100)).toList()
        );
    }

    /**
     * Per-version metrics for the active/canary comparison dashboard, grouped by surface + harness
     * version over the last {@code days} days. Active and canary versions are highlighted and the
     * first canary is diffed against the active version.
     */
    public Map<String, Object> versionMetrics(String surface, int days) {
        int windowDays = Math.max(1, Math.min(days, 90));
        LocalDateTime since = LocalDateTime.now().minusDays(windowDays);
        String surfaceFilter = (surface == null || surface.isBlank() || "all".equalsIgnoreCase(surface)) ? null : surface;

        Map<String, Map<String, Object>> byVersion = new LinkedHashMap<>();
        for (Map<String, Object> row : traceMapper.aggregateByVersion(surfaceFilter, since)) {
            String version = valueAsString(row.get("version"));
            if (version == null || version.isBlank()) continue;
            long total = valueAsLong(row.get("total"), 0);
            long success = valueAsLong(row.get("successCount"), 0);
            long failed = valueAsLong(row.get("failedCount"), 0);
            long running = valueAsLong(row.get("runningCount"), 0);
            long inputTokens = valueAsLong(row.get("inputTokens"), 0);
            long outputTokens = valueAsLong(row.get("outputTokens"), 0);
            double avgLatency = valueAsDouble(row.get("avgLatencyMs"), 0);

            Map<String, Object> metric = new LinkedHashMap<>();
            metric.put("version", version);
            metric.put("total", total);
            metric.put("successCount", success);
            metric.put("failedCount", failed);
            metric.put("runningCount", running);
            metric.put("successRate", ratePercent(success, total));
            metric.put("failureRate", ratePercent(failed, total));
            metric.put("avgLatencyMs", Math.round(avgLatency));
            metric.put("inputTokens", inputTokens);
            metric.put("outputTokens", outputTokens);
            byVersion.put(version, metric);
        }

        for (Map<String, Object> row : traceEventMapper.aggregateToolOutcomesByVersion(surfaceFilter, since)) {
            String version = valueAsString(row.get("version"));
            Map<String, Object> metric = version != null ? byVersion.get(version) : null;
            if (metric == null) continue;
            long toolResults = valueAsLong(row.get("toolResults"), 0);
            long toolErrors = valueAsLong(row.get("toolErrors"), 0);
            metric.put("toolResults", toolResults);
            metric.put("toolErrors", toolErrors);
            metric.put("toolSuccessRate", toolResults > 0 ? ratePercent(toolResults - toolErrors, toolResults) : null);
        }

        applyEmptyResponseRates(surfaceFilter, since, byVersion);

        Map<String, HarnessVersion> versionRegistry = new LinkedHashMap<>();
        for (HarnessVersion version : versions(surface, 200)) {
            if (version.getVersion() != null) {
                versionRegistry.putIfAbsent(version.getVersion(), version);
            }
        }
        for (Map.Entry<String, Map<String, Object>> entry : byVersion.entrySet()) {
            HarnessVersion registered = versionRegistry.get(entry.getKey());
            Map<String, Object> metric = entry.getValue();
            if (registered != null) {
                metric.put("status", blankTo(registered.getStatus(), "unknown"));
                metric.put("name", registered.getName());
                metric.put("versionId", registered.getId());
                metric.put("surface", registered.getSurface());
                Map<String, Object> rollout = mutableMap(policyFromConfig(readJsonMap(registered.getConfigJson())).get("rollout"));
                metric.put("percentage", valueAsInt(rollout.get("percentage"), 0));
            } else {
                metric.put("status", "unknown");
                metric.put("percentage", 0);
            }
        }

        Map<String, Object> active = byVersion.values().stream()
                .filter(m -> "active".equalsIgnoreCase(valueAsString(m.get("status"))))
                .findFirst().orElse(null);
        List<Map<String, Object>> canaries = byVersion.values().stream()
                .filter(m -> "canary".equalsIgnoreCase(valueAsString(m.get("status"))))
                .toList();
        List<Map<String, Object>> others = byVersion.values().stream()
                .filter(m -> !"active".equalsIgnoreCase(valueAsString(m.get("status")))
                        && !"canary".equalsIgnoreCase(valueAsString(m.get("status"))))
                .toList();

        Map<String, Object> comparison = null;
        if (active != null && !canaries.isEmpty()) {
            comparison = compareMetrics(active, canaries.get(0));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("surface", blankTo(surface, "all"));
        result.put("windowDays", windowDays);
        result.put("since", since.toString());
        result.put("active", active);
        result.put("canaries", canaries);
        result.put("others", others);
        result.put("comparison", comparison);
        return result;
    }

    private void applyEmptyResponseRates(String surfaceFilter, LocalDateTime since,
                                         Map<String, Map<String, Object>> byVersion) {
        if (byVersion.isEmpty()) return;
        try {
            LambdaQueryWrapper<HarnessTrace> qw = new LambdaQueryWrapper<>();
            if (surfaceFilter != null) {
                qw.eq(HarnessTrace::getSurface, surfaceFilter);
            }
            qw.ge(HarnessTrace::getCreatedAt, since)
                    .isNotNull(HarnessTrace::getHarnessVersion)
                    .orderByDesc(HarnessTrace::getCreatedAt)
                    .last("LIMIT 500");
            Map<String, long[]> counters = new LinkedHashMap<>();
            for (HarnessTrace trace : traceMapper.selectList(qw)) {
                String version = trace.getHarnessVersion();
                if (version == null || version.isBlank() || !byVersion.containsKey(version)) continue;
                Map<String, Object> quality = readJsonMap(trace.getQualityJson());
                boolean hasOutput = !quality.containsKey("hasOutput") || Boolean.TRUE.equals(quality.get("hasOutput"));
                long[] counter = counters.computeIfAbsent(version, k -> new long[2]);
                counter[0]++;
                if (!hasOutput) counter[1]++;
            }
            counters.forEach((version, counter) -> {
                Map<String, Object> metric = byVersion.get(version);
                if (metric != null && counter[0] > 0) {
                    metric.put("emptyResponseRate", ratePercent(counter[1], counter[0]));
                    metric.put("emptyResponseSampleSize", counter[0]);
                }
            });
        } catch (Exception e) {
            log.debug("[Harness] applyEmptyResponseRates failed: {}", e.getMessage());
        }
    }

    private Map<String, Object> compareMetrics(Map<String, Object> active, Map<String, Object> canary) {
        Map<String, Object> comparison = new LinkedHashMap<>();
        comparison.put("activeVersion", active.get("version"));
        comparison.put("canaryVersion", canary.get("version"));
        comparison.put("successRateDelta", rateDelta(canary.get("successRate"), active.get("successRate")));
        comparison.put("failureRateDelta", rateDelta(canary.get("failureRate"), active.get("failureRate")));
        comparison.put("avgLatencyDelta", numberDelta(canary.get("avgLatencyMs"), active.get("avgLatencyMs")));
        comparison.put("toolSuccessRateDelta", rateDelta(canary.get("toolSuccessRate"), active.get("toolSuccessRate")));
        comparison.put("emptyResponseRateDelta", rateDelta(canary.get("emptyResponseRate"), active.get("emptyResponseRate")));
        return comparison;
    }

    private Double rateDelta(Object canaryValue, Object activeValue) {
        if (canaryValue == null || activeValue == null) return null;
        return round1(valueAsDouble(canaryValue, 0) - valueAsDouble(activeValue, 0));
    }

    private Long numberDelta(Object canaryValue, Object activeValue) {
        if (canaryValue == null || activeValue == null) return null;
        return valueAsLong(canaryValue, 0) - valueAsLong(activeValue, 0);
    }

    private double ratePercent(long part, long total) {
        if (total <= 0) return 0;
        return round1(part * 100.0 / total);
    }

    private double round1(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    public List<Map<String, Object>> recurringFailureGroups(String surface, int minCount, int limit) {
        int threshold = Math.max(2, minCount);
        int safeLimit = safeLimit(limit, 50);
        LambdaQueryWrapper<HarnessFailureCase> qw = failureFilter(surface);
        qw.in(HarnessFailureCase::getStatus, List.of("open", "regression"))
                .orderByDesc(HarnessFailureCase::getCreatedAt)
                .last("LIMIT 500");
        List<HarnessFailureCase> failures = failureCaseMapper.selectList(qw);
        Map<String, List<HarnessFailureCase>> grouped = failures.stream()
                .collect(Collectors.groupingBy(
                        f -> blankTo(f.getSurface(), "unknown") + "||" + blankTo(f.getFailureType(), "unknown"),
                        LinkedHashMap::new,
                        Collectors.toList()
                ));

        return grouped.entrySet().stream()
                .map(entry -> recurringGroup(entry.getKey(), entry.getValue()))
                .filter(group -> ((Number) group.getOrDefault("count", 0)).intValue() >= threshold)
                .sorted((a, b) -> Integer.compare(
                        ((Number) b.getOrDefault("score", 0)).intValue(),
                        ((Number) a.getOrDefault("score", 0)).intValue()
                ))
                .limit(safeLimit)
                .toList();
    }

    @Transactional
    public List<HarnessPatch> promoteRecurringFailures(String surface, int minCount, Long reviewerId) {
        return autoGeneratePatches(surface, minCount, 20, reviewerId);
    }

    @Transactional
    public List<HarnessPatch> autoGeneratePatches(String surface, int minCount, int limit, Long reviewerId) {
        List<Map<String, Object>> groups = recurringFailureGroups(surface, minCount, limit);
        List<HarnessPatch> created = new ArrayList<>();
        for (Map<String, Object> group : groups) {
            String groupSurface = String.valueOf(group.get("surface"));
            String failureType = String.valueOf(group.get("failureType"));
            if (hasActivePatch(groupSurface, failureType)) {
                continue;
            }
            HarnessPatch patch = generatePatch(groupSurface, failureType, reviewerId);
            created.add(patch);
            markFailuresAsRegression(groupSurface, failureType);
        }
        if (created.size() < safeLimit(limit, 50)) {
            for (HarnessFailureCase failure : highPriorityFailuresWithoutPatch(surface, safeLimit(limit, 50) - created.size())) {
                if (hasActivePatch(failure.getSurface(), failure.getFailureType())) {
                    continue;
                }
                HarnessPatch patch = generatePatch(failure.getSurface(), failure.getFailureType(), reviewerId);
                created.add(patch);
                markFailuresAsRegression(failure.getSurface(), failure.getFailureType());
                if (created.size() >= safeLimit(limit, 50)) {
                    break;
                }
            }
        }
        return created;
    }

    public HarnessPatch generatePatch(String surface, String failureType, Long reviewerId) {
        LambdaQueryWrapper<HarnessFailureCase> qw = failureFilter(surface);
        if (failureType != null && !failureType.isBlank()) {
            qw.eq(HarnessFailureCase::getFailureType, failureType);
        }
        qw.eq(HarnessFailureCase::getStatus, "open")
                .orderByDesc(HarnessFailureCase::getCreatedAt)
                .last("LIMIT 20");
        List<HarnessFailureCase> failures = failureCaseMapper.selectList(qw);
        String targetSurface = surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)
                ? surface
                : failures.stream().findFirst().map(HarnessFailureCase::getSurface).orElse("chat");
        String targetFailure = failureType != null && !failureType.isBlank()
                ? failureType
                : failures.stream().findFirst().map(HarnessFailureCase::getFailureType).orElse("unknown");

        HarnessPatch patch = new HarnessPatch();
        patch.setPatchUuid(UUID.randomUUID().toString());
        patch.setSurface(targetSurface);
        patch.setTargetType(suggestTargetType(targetSurface, targetFailure));
        patch.setTargetId(targetFailure);
        patch.setTitle("Improve " + targetSurface + " / " + targetFailure + " handling");
        patch.setRationale(buildPatchRationale(targetSurface, targetFailure, failures));
        patch.setPatchJson(toJson(buildPatchPayload(targetSurface, targetFailure, failures)));
        patch.setStatus("draft");
        patch.setCreatedByTraceId(failures.stream().findFirst().map(HarnessFailureCase::getTraceId).orElse(null));
        patch.setReviewedBy(reviewerId);
        patchMapper.insert(patch);
        return patch;
    }

    @Transactional
    public HarnessPatch updatePatchStatus(Long id, String status, Long reviewerId) {
        HarnessPatch patch = patchMapper.selectById(id);
        if (patch == null) {
            throw new IllegalArgumentException("Harness patch does not exist");
        }
        String next = normalizeStatus(status);
        if (!List.of("draft", "approved", "rejected", "applied").contains(next)) {
            throw new IllegalArgumentException("Unsupported patch status: " + status);
        }
        patch.setStatus(next);
        patch.setReviewedBy(reviewerId);
        patch.setReviewedAt(LocalDateTime.now());
        patchMapper.updateById(patch);
        if ("applied".equals(next)) {
            markRelatedFailuresResolved(patch);
        }
        return patch;
    }

    @Transactional
    public HarnessVersion createVersionFromPatch(Long patchId, Long reviewerId) {
        HarnessPatch patch = patchMapper.selectById(patchId);
        if (patch == null) {
            throw new IllegalArgumentException("Harness patch does not exist");
        }
        if (!List.of("approved", "applied").contains(blankTo(patch.getStatus(), "").toLowerCase())) {
            throw new IllegalArgumentException("Only approved or applied patches can create a harness version");
        }

        String surface = normalizeSurface(patch.getSurface(), "chat");
        HarnessVersion version = new HarnessVersion();
        version.setSurface(surface);
        version.setVersion(surface + "-harness-" + VERSION_TIME_FORMAT.format(LocalDateTime.now()));
        version.setName(patch.getTitle());
        version.setConfigJson(toJson(normalizePolicyConfig(readJsonMap(patch.getPatchJson()))));
        version.setStatus("candidate");
        version.setDescription("Created from patch #" + patch.getId() + ": " + blankTo(patch.getRationale(), ""));
        versionMapper.insert(version);

        patch.setReviewedBy(reviewerId);
        patch.setReviewedAt(LocalDateTime.now());
        patchMapper.updateById(patch);
        return version;
    }

    @Transactional
    public HarnessVersion canaryVersion(Long id, Long userId, Map<String, Object> body) {
        HarnessVersion target = versionMapper.selectById(id);
        if (target == null) {
            throw new IllegalArgumentException("Harness version does not exist");
        }
        String current = normalizeStatus(target.getStatus());
        if (!List.of("candidate", "canary").contains(current)) {
            throw new IllegalStateException("Only candidate or canary harness versions can enter canary");
        }
        String surface = normalizeSurface(target.getSurface(), "chat");
        enforceRegressionGate(target, surface);

        int percentage = Math.max(1, Math.min(valueAsInt(body != null ? body.get("percentage") : null, 5), 50));
        Map<String, Object> config = normalizePolicyConfig(readJsonMap(target.getConfigJson()));
        Map<String, Object> policy = policyFromConfig(config);
        Map<String, Object> rollout = mutableMap(policy.get("rollout"));
        rollout.put("lifecycle", "canary");
        rollout.put("mode", "canary");
        rollout.put("percentage", percentage);
        rollout.put("startedAt", LocalDateTime.now().toString());
        rollout.put("startedBy", userId);
        policy.put("rollout", rollout);
        config.put("policy", policy);
        config.put("rollout", rollout);
        target.setConfigJson(toJson(config));
        target.setStatus("canary");
        target.setUpdatedAt(LocalDateTime.now());
        versionMapper.updateById(target);
        return target;
    }

    @Transactional
    public HarnessVersion activateVersion(Long id) {
        HarnessVersion target = versionMapper.selectById(id);
        if (target == null) {
            throw new IllegalArgumentException("Harness version does not exist");
        }
        String surface = normalizeSurface(target.getSurface(), "chat");
        enforceRegressionGate(target, surface);
        List<HarnessVersion> activeVersions = versionMapper.selectList(new LambdaQueryWrapper<HarnessVersion>()
                .eq(HarnessVersion::getSurface, surface)
                .eq(HarnessVersion::getStatus, "active"));
        for (HarnessVersion version : activeVersions) {
            if (!version.getId().equals(id)) {
                version.setStatus("retired");
                version.setUpdatedAt(LocalDateTime.now());
                versionMapper.updateById(version);
            }
        }
        target.setStatus("active");
        target.setUpdatedAt(LocalDateTime.now());
        versionMapper.updateById(target);
        return target;
    }

    @Transactional
    public HarnessVersion rollbackVersion(Long id, Long userId) {
        HarnessVersion current = versionMapper.selectById(id);
        if (current == null) {
            throw new IllegalArgumentException("Harness version does not exist");
        }
        String surface = normalizeSurface(current.getSurface(), "chat");
        HarnessVersion restore = versionMapper.selectOne(new LambdaQueryWrapper<HarnessVersion>()
                .eq(HarnessVersion::getSurface, surface)
                .ne(HarnessVersion::getId, id)
                .in(HarnessVersion::getStatus, List.of("retired", "active"))
                .orderByDesc(HarnessVersion::getUpdatedAt)
                .orderByDesc(HarnessVersion::getCreatedAt)
                .last("LIMIT 1"));
        if (restore == null) {
            throw new IllegalStateException("No previous stable harness version is available for rollback");
        }

        List<HarnessVersion> activeOrCanary = versionMapper.selectList(new LambdaQueryWrapper<HarnessVersion>()
                .eq(HarnessVersion::getSurface, surface)
                .in(HarnessVersion::getStatus, List.of("active", "canary")));
        for (HarnessVersion version : activeOrCanary) {
            if (version.getId().equals(restore.getId())) continue;
            String status = normalizeStatus(version.getStatus());
            version.setStatus("canary".equals(status) ? "rejected" : "retired");
            version.setUpdatedAt(LocalDateTime.now());
            versionMapper.updateById(version);
        }

        Map<String, Object> config = normalizePolicyConfig(readJsonMap(restore.getConfigJson()));
        Map<String, Object> policy = policyFromConfig(config);
        Map<String, Object> rollout = mutableMap(policy.get("rollout"));
        rollout.put("lifecycle", "active");
        rollout.put("mode", "active");
        rollout.put("percentage", 100);
        rollout.put("rollbackAt", LocalDateTime.now().toString());
        rollout.put("rollbackBy", userId);
        rollout.put("rolledBackFromVersionId", id);
        policy.put("rollout", rollout);
        config.put("policy", policy);
        config.put("rollout", rollout);
        restore.setConfigJson(toJson(config));
        restore.setStatus("active");
        restore.setUpdatedAt(LocalDateTime.now());
        versionMapper.updateById(restore);
        return restore;
    }

    private void enforceRegressionGate(HarnessVersion target, String surface) {
        if (!"candidate".equalsIgnoreCase(blankTo(target.getStatus(), ""))) {
            return;
        }
        long regressionCaseCount = failureCaseMapper.selectCount(new LambdaQueryWrapper<HarnessFailureCase>()
                .eq(HarnessFailureCase::getSurface, surface)
                .eq(HarnessFailureCase::getStatus, "regression"));
        if (regressionCaseCount <= 0) {
            return;
        }
        List<HarnessRegressionRun> passedRuns = regressionRunMapper.selectList(new LambdaQueryWrapper<HarnessRegressionRun>()
                .eq(HarnessRegressionRun::getVersionId, target.getId())
                .eq(HarnessRegressionRun::getStatus, "passed")
                .gt(HarnessRegressionRun::getTotalCases, 0)
                .eq(HarnessRegressionRun::getFailedCases, 0)
                .eq(HarnessRegressionRun::getBlockedCases, 0));
        boolean hasEligibleRun = passedRuns.stream().anyMatch(run -> {
            Map<String, Object> result = readJsonMap(run.getResultJson());
            String runMode = String.valueOf(result.getOrDefault("runMode", "manual"));
            Object eligible = result.get("activationEligible");
            return !"structural_preflight".equalsIgnoreCase(runMode)
                    && (eligible == null || Boolean.TRUE.equals(eligible) || "true".equalsIgnoreCase(String.valueOf(eligible)));
        });
        if (!hasEligibleRun) {
            throw new IllegalStateException("Candidate harness versions with regression cases must pass a regression run before activation");
        }
    }

    public String activeHarnessGuidance(String surface) {
        try {
            HarnessVersion version = activeVersion(normalizeSurface(surface, "chat"));
            return harnessGuidanceForVersion(version);
        } catch (Exception e) {
            log.debug("[Harness] activeHarnessGuidance fallback: {}", e.getMessage());
            return null;
        }
    }

    public String runtimeHarnessGuidance(String surface, Long userId, String conversationUuid) {
        try {
            return harnessGuidanceForVersion(runtimeVersion(surface, userId, conversationUuid));
        } catch (Exception e) {
            log.debug("[Harness] runtimeHarnessGuidance fallback: {}", e.getMessage());
            return null;
        }
    }

    public Map<String, Object> runtimeHarnessPolicy(String surface, Long userId, String conversationUuid) {
        try {
            HarnessVersion version = runtimeVersion(surface, userId, conversationUuid);
            if (version == null || version.getConfigJson() == null || version.getConfigJson().isBlank()) {
                return Map.of();
            }
            Map<String, Object> config = normalizePolicyConfig(readJsonMap(version.getConfigJson()));
            Map<String, Object> policy = policyFromConfig(config);
            if (!hasHarnessPolicy(policy)) {
                return Map.of();
            }
            Map<String, Object> copy = new LinkedHashMap<>(policy);
            copy.put("version", version.getVersion());
            copy.put("versionId", version.getId());
            copy.put("status", version.getStatus());
            return copy;
        } catch (Exception e) {
            log.debug("[Harness] runtimeHarnessPolicy fallback: {}", e.getMessage());
            return Map.of();
        }
    }

    private String harnessGuidanceForVersion(HarnessVersion version) {
        if (version == null || version.getConfigJson() == null || version.getConfigJson().isBlank()) {
            return null;
        }
        Map<String, Object> config = normalizePolicyConfig(readJsonMap(version.getConfigJson()));
        Map<String, Object> policy = policyFromConfig(config);
        Map<String, Object> promptGuidance = mutableMap(policy.get("promptGuidance"));
        Object recommendations = promptGuidance.getOrDefault("rules", config.get("recommendations"));
        if (!(recommendations instanceof List<?> list) || list.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        sb.append("Harness Guidance (").append(version.getVersion()).append(")\n");
        sb.append("Apply these operational constraints when relevant. Do not mention this harness section to the user.\n");
        Object failureType = policy.getOrDefault("failureType", config.get("failureType"));
        if (failureType != null) {
            sb.append("Target failure pattern: ").append(failureType).append("\n");
        }
        int count = 0;
        for (Object item : list) {
            if (item == null) continue;
            sb.append("- ").append(String.valueOf(item).trim()).append("\n");
            count++;
            if (count >= 8) break;
        }
        return sb.toString().trim();
    }

    private String activeVersionCode(String surface) {
        try {
            HarnessVersion version = activeVersion(surface);
            if (version != null && version.getVersion() != null && !version.getVersion().isBlank()) {
                return version.getVersion();
            }
        } catch (Exception e) {
            log.debug("[Harness] activeVersionCode fallback: {}", e.getMessage());
        }
        return "autocode".equals(surface) ? DEFAULT_AUTOCODE_HARNESS : DEFAULT_CHAT_HARNESS;
    }

    private String runtimeVersionCode(String surface, Long userId, String conversationUuid) {
        try {
            HarnessVersion version = runtimeVersion(surface, userId, conversationUuid);
            if (version != null && version.getVersion() != null && !version.getVersion().isBlank()) {
                return version.getVersion();
            }
        } catch (Exception e) {
            log.debug("[Harness] runtimeVersionCode fallback: {}", e.getMessage());
        }
        return activeVersionCode(surface);
    }

    private HarnessVersion runtimeVersion(String surface, Long userId, String conversationUuid) {
        String normalizedSurface = normalizeSurface(surface, "chat");
        HarnessVersion active = activeVersion(normalizedSurface);
        List<HarnessVersion> canaries = versionMapper.selectList(new LambdaQueryWrapper<HarnessVersion>()
                .eq(HarnessVersion::getSurface, normalizedSurface)
                .eq(HarnessVersion::getStatus, "canary")
                .orderByDesc(HarnessVersion::getUpdatedAt)
                .orderByDesc(HarnessVersion::getCreatedAt));
        for (HarnessVersion canary : canaries) {
            if (canaryHit(canary, userId, conversationUuid)) {
                return canary;
            }
        }
        return active;
    }

    private boolean canaryHit(HarnessVersion version, Long userId, String conversationUuid) {
        if (version == null || (userId == null && (conversationUuid == null || conversationUuid.isBlank()))) {
            return false;
        }
        Map<String, Object> config = normalizePolicyConfig(readJsonMap(version.getConfigJson()));
        Map<String, Object> rollout = mutableMap(policyFromConfig(config).get("rollout"));
        int percentage = Math.max(0, Math.min(valueAsInt(rollout.get("percentage"), 5), 100));
        if (percentage <= 0) return false;
        String key = String.join("|",
                blankTo(version.getSurface(), "chat"),
                blankTo(version.getVersion(), ""),
                userId != null ? String.valueOf(userId) : "",
                blankTo(conversationUuid, ""));
        int bucket = Math.floorMod(Objects.hash(key), 100);
        return bucket < percentage;
    }

    private HarnessVersion activeVersion(String surface) {
        return versionMapper.selectOne(new LambdaQueryWrapper<HarnessVersion>()
                .eq(HarnessVersion::getSurface, normalizeSurface(surface, "chat"))
                .eq(HarnessVersion::getStatus, "active")
                .orderByDesc(HarnessVersion::getCreatedAt)
                .last("LIMIT 1"));
    }

    private void markRelatedFailuresResolved(HarnessPatch patch) {
        try {
            LambdaQueryWrapper<HarnessFailureCase> qw = new LambdaQueryWrapper<>();
            qw.eq(HarnessFailureCase::getStatus, "open")
                    .eq(HarnessFailureCase::getSurface, patch.getSurface());
            if (patch.getTargetId() != null && !patch.getTargetId().isBlank()) {
                qw.eq(HarnessFailureCase::getFailureType, patch.getTargetId());
            }
            List<HarnessFailureCase> failures = failureCaseMapper.selectList(qw);
            for (HarnessFailureCase failure : failures) {
                failure.setStatus("resolved");
                failure.setResolvedAt(LocalDateTime.now());
                failureCaseMapper.updateById(failure);
            }
        } catch (Exception e) {
            log.warn("[Harness] markRelatedFailuresResolved failed: {}", e.getMessage());
        }
    }

    private String suggestTargetType(String surface, String failureType) {
        String type = failureType != null ? failureType : "";
        if (type.contains("quota") || type.contains("model_limit")) return "policy";
        if (type.contains("review") || type.contains("subtask") || "autocode".equals(surface)) return "autocode_harness";
        if (type.contains("tool") || type.contains("security")) return "tool_contract";
        return "prompt_harness";
    }

    private String buildPatchRationale(String surface, String failureType, List<HarnessFailureCase> failures) {
        String sample = failures.stream()
                .map(HarnessFailureCase::getSummary)
                .filter(s -> s != null && !s.isBlank())
                .findFirst()
                .orElse("No failure summary is available yet.");
        return "Generated from " + failures.size() + " " + surface + " / " + failureType
                + " failure sample(s). Representative sample: " + truncate(sample, 300);
    }

    private List<String> suggestRecommendations(String surface, String failureType) {
        String type = failureType != null ? failureType : "";
        if (type.contains("skill") || type.contains("tool_match")) {
            return List.of(
                    "Require a two-stage skill decision: lexical candidate retrieval followed by semantic relevance verification.",
                    "Log rejected skill candidates with rejection reasons so future runs can avoid the same mismatch.",
                    "Prefer conversation-local WORK.md skill memory before searching the full skill store."
            );
        }
        if (type.contains("memory")) {
            return List.of(
                    "Separate conversation-local memory from long-term user profile updates.",
                    "Require confidence and evidence before writing stable persona facts.",
                    "Expose memory update summaries for user review and correction."
            );
        }
        if (type.contains("workflow")) {
            return List.of(
                    "Record every workflow tool call with input artifact references and output artifact UUIDs.",
                    "Use checkpoint outputs before replaying workflow steps.",
                    "Surface long-running workflow progress through SSE events."
            );
        }
        if (type.contains("stream") || type.contains("render")) {
            return List.of(
                    "Preserve incremental assistant rendering during long reasoning or tool phases.",
                    "Emit explicit intermediate states such as searching, thinking, tool_running, and composing.",
                    "Avoid duplicate loading indicators for the same assistant turn."
            );
        }
        if (type.contains("quota")) {
            return List.of(
                    "Return clear quota and balance information before invoking the model.",
                    "Provide next actions such as purchase, downgrade, or switch model.",
                    "Record estimated cost and actual cost differences."
            );
        }
        if (type.contains("model_limit")) {
            return List.of(
                    "Only show models available to the current subscription.",
                    "Return available alternatives when backend rejects a model.",
                    "Enforce subscription limits in model routing."
            );
        }
        if (type.contains("review")) {
            return List.of(
                    "Code review must verify real file changes.",
                    "Empty or no-code workspaces cannot pass review.",
                    "Sync phase review evidence into task reports."
            );
        }
        if (type.contains("subtask")) {
            return List.of(
                    "Subtasks must produce explicit artifacts or file changes.",
                    "Retry once with adjusted instructions when the agent returns empty output.",
                    "Record no-output subtasks as failure samples."
            );
        }
        if (type.contains("security")) {
            return List.of(
                    "Strengthen workspace boundary rules in the system prompt.",
                    "Declare path restrictions in tool schemas.",
                    "Block or require confirmation for high-risk commands."
            );
        }
        if ("autocode".equals(surface)) {
            return List.of(
                    "Add explicit task completion gates.",
                    "Record inputs, outputs, and artifacts for every phase.",
                    "Feed failed phase evidence back into the next run harness."
            );
        }
        return List.of(
                "Add boundary conditions to the system prompt.",
                "Add a preflight check for this failure type.",
                "Promote recurring failures into regression cases."
        );
    }

    private Map<String, Object> buildPatchPayload(String surface, String failureType, List<HarnessFailureCase> failures) {
        List<String> recommendations = suggestRecommendations(surface, failureType);
        Map<String, Object> policy = buildExecutablePolicy(surface, failureType, recommendations);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schemaVersion", "harness.policy.v1");
        payload.put("kind", "harness.policy.v1");
        payload.put("mode", "candidate_policy");
        payload.put("surface", surface);
        payload.put("failureType", failureType);
        payload.put("sampleCount", failures.size());
        payload.put("policy", policy);
        payload.put("recommendations", recommendations);
        payload.put("promptGuidance", policy.get("promptGuidance"));
        payload.put("agentRuntimePolicy", policy.get("agentRuntimePolicy"));
        payload.put("toolPolicyOverrides", policy.get("toolPolicyOverrides"));
        payload.put("modelRoutingRules", policy.get("modelRoutingRules"));
        payload.put("failureClassifiers", policy.get("failureClassifiers"));
        payload.put("rollout", policy.get("rollout"));
        payload.put("implementationPlan", suggestImplementationPlan(surface, failureType));
        payload.put("regressionChecklist", suggestRegressionChecklist(surface, failureType));
        payload.put("affectedSurfaces", suggestAffectedSurfaces(surface, failureType));
        payload.put("failureSamples", failures.stream().limit(8).map(this::failureSample).toList());
        payload.put("activationGate", Map.of(
                "requiresHumanReview", true,
                "requiresRegressionRun", true,
                "autoApply", false
        ));
        return payload;
    }

    private Map<String, Object> buildExecutablePolicy(String surface, String failureType, List<String> recommendations) {
        String type = blankTo(failureType, "unknown");
        Map<String, Object> policy = new LinkedHashMap<>();
        policy.put("schemaVersion", "harness.policy.v1");
        policy.put("surface", surface);
        policy.put("failureType", type);
        policy.put("promptGuidance", Map.of(
                "rules", recommendations,
                "injectIntoSystemPrompt", true,
                "hiddenFromUser", true
        ));
        policy.put("agentRuntimePolicy", Map.of(
                "maxTurns", "chat_agent".equals(surface) ? 8 : 4,
                "timeoutMs", "chat_agent".equals(surface) ? 1_800_000 : 180_000,
                "waitMessageHandling", "emit_agent_status",
                "pseudoToolFallback", true,
                "emptyResponseIsFailure", true
        ));
        policy.put("toolPolicyOverrides", Map.of(
                "defaultTimeoutMs", 120_000,
                "retry", Map.of("maxAttempts", 1, "retryOn", List.of("timeout", "rate_limit", "transient_provider_error")),
                "resultMaxChars", Map.of("default", 5_000, "file", 50_000, "search", 20_000),
                "requireStructuredError", true,
                "sideEffectMode", Map.of("replay", "read_only", "production", "declared_by_tool")
        ));
        policy.put("modelRoutingRules", Map.of(
                "requireToolCapabilityForAgent", true,
                "requireVisionCapabilityForImages", true,
                "fallbackOnCapabilityMismatch", true,
                "fallbackFailureType", "model_capability_mismatch"
        ));
        policy.put("failureClassifiers", List.of(
                Map.of("failureType", type, "match", List.of(type), "severity", "medium"),
                Map.of("failureType", "empty_response", "match", List.of("empty", "blank", "no content"), "severity", "high"),
                Map.of("failureType", "tool_error", "match", List.of("tool", "exception", "timeout"), "severity", "medium"),
                Map.of("failureType", "model_capability_mismatch", "match", List.of("vision", "tool", "unsupported"), "severity", "medium")
        ));
        policy.put("rollout", Map.of(
                "lifecycle", "candidate",
                "mode", "candidate",
                "percentage", 0,
                "canaryHashBy", List.of("userId", "conversationUuid"),
                "autoActivate", false,
                "rollbackEnabled", true
        ));
        return policy;
    }

    private List<String> suggestImplementationPlan(String surface, String failureType) {
        String type = failureType != null ? failureType : "";
        if ("autocode".equals(surface) || type.contains("review") || type.contains("subtask")) {
            return List.of(
                    "Add a phase gate that checks file diff/artifact count before marking a subtask complete.",
                    "Treat empty LLM/tool output as retryable failure, then as a failure case if retry also produces no artifact.",
                    "Persist review evidence into the task memory and code review panel."
            );
        }
        if (type.contains("security")) {
            return List.of(
                    "Add explicit path and command boundary rules to the active harness guidance.",
                    "Record blocked operations as regression samples with exact command/path evidence.",
                    "Require approval for operations outside the declared workspace roots."
            );
        }
        if (type.contains("skill") || type.contains("tool_match")) {
            return List.of(
                    "Use cheap lexical retrieval to collect skill candidates.",
                    "Apply thresholded relevance scoring using title, tags, summary, and negative memory.",
                    "Write positive and negative matches to conversation-local WORK.md."
            );
        }
        if (type.contains("model") || type.contains("quota")) {
            return List.of(
                    "Resolve allowed models from backend subscription and pricing state before rendering selectors.",
                    "Block unauthorized usage at the backend even if the frontend selector is stale.",
                    "Log model, provider, channel, price snapshot, and charge result in API logs."
            );
        }
        return List.of(
                "Add harness guidance for the recurring failure pattern.",
                "Create regression cases from representative failures.",
                "Run preflight plus manual/CI regression before activation."
        );
    }

    private List<String> suggestRegressionChecklist(String surface, String failureType) {
        String type = failureType != null ? failureType : "";
        List<String> checklist = new ArrayList<>();
        checklist.add("The same failure input no longer reproduces the original failure.");
        checklist.add("The fix produces observable evidence, not only a success label.");
        if ("autocode".equals(surface) || type.contains("review")) {
            checklist.add("A no-change workspace cannot pass code review.");
            checklist.add("A completed phase includes changed files or an explicit no-code artifact.");
        }
        if (type.contains("security")) {
            checklist.add("Cross-workspace file reads are blocked and logged.");
        }
        if (type.contains("skill")) {
            checklist.add("Irrelevant skill candidates are rejected with a reason.");
        }
        if (type.contains("quota") || type.contains("model")) {
            checklist.add("Unauthorized models are hidden in UI and rejected by backend.");
        }
        return checklist;
    }

    private List<String> suggestAffectedSurfaces(String surface, String failureType) {
        List<String> affected = new ArrayList<>();
        affected.add(surface);
        String type = failureType != null ? failureType : "";
        if (type.contains("model") || type.contains("quota")) {
            affected.add("billing");
            affected.add("model-routing");
        }
        if (type.contains("skill")) {
            affected.add("skill-store");
            affected.add("chat");
        }
        if (type.contains("workflow")) {
            affected.add("workflow");
            affected.add("memory");
        }
        return affected.stream().distinct().toList();
    }

    private Map<String, Object> failureSample(HarnessFailureCase failure) {
        Map<String, Object> sample = new LinkedHashMap<>();
        sample.put("id", failure.getId());
        sample.put("traceId", failure.getTraceId());
        sample.put("severity", blankTo(failure.getSeverity(), "medium"));
        sample.put("summary", blankTo(failure.getSummary(), ""));
        return sample;
    }

    private Map<String, Object> recurringGroup(String key, List<HarnessFailureCase> failures) {
        String[] parts = key.split("\\|\\|", 2);
        String surface = parts.length > 0 ? parts[0] : "unknown";
        String failureType = parts.length > 1 ? parts[1] : "unknown";
        long openCount = failures.stream().filter(f -> "open".equalsIgnoreCase(blankTo(f.getStatus(), ""))).count();
        long regressionCount = failures.stream().filter(f -> "regression".equalsIgnoreCase(blankTo(f.getStatus(), ""))).count();
        long highSeverity = failures.stream().filter(f -> "high".equalsIgnoreCase(blankTo(f.getSeverity(), ""))).count();
        int score = failures.size() * 10 + (int) highSeverity * 6 + (int) openCount * 3 + (int) regressionCount;
        Map<String, Object> group = new LinkedHashMap<>();
        group.put("surface", surface);
        group.put("failureType", failureType);
        group.put("count", failures.size());
        group.put("openCount", openCount);
        group.put("regressionCount", regressionCount);
        group.put("highSeverityCount", highSeverity);
        group.put("score", score);
        group.put("latestAt", failures.stream()
                .map(HarnessFailureCase::getCreatedAt)
                .filter(v -> v != null)
                .max(LocalDateTime::compareTo)
                .orElse(null));
        group.put("samples", failures.stream().limit(5).map(this::failureSample).toList());
        group.put("hasPatch", hasActivePatch(surface, failureType));
        return group;
    }

    private boolean hasActivePatch(String surface, String failureType) {
        Long count = patchMapper.selectCount(new LambdaQueryWrapper<HarnessPatch>()
                .eq(HarnessPatch::getSurface, surface)
                .eq(HarnessPatch::getTargetId, failureType)
                .in(HarnessPatch::getStatus, List.of("draft", "approved", "applied")));
        return count != null && count > 0;
    }

    private List<HarnessFailureCase> highPriorityFailuresWithoutPatch(String surface, int limit) {
        LambdaQueryWrapper<HarnessFailureCase> qw = failureFilter(surface);
        qw.in(HarnessFailureCase::getStatus, List.of("open", "regression"))
                .orderByDesc(HarnessFailureCase::getSeverity)
                .orderByDesc(HarnessFailureCase::getCreatedAt)
                .last("LIMIT " + safeLimit(limit * 3, 150));
        return failureCaseMapper.selectList(qw).stream()
                .filter(failure -> !hasActivePatch(failure.getSurface(), failure.getFailureType()))
                .limit(safeLimit(limit, 50))
                .toList();
    }

    private void markFailuresAsRegression(String surface, String failureType) {
        List<HarnessFailureCase> failures = failureCaseMapper.selectList(new LambdaQueryWrapper<HarnessFailureCase>()
                .eq(HarnessFailureCase::getSurface, surface)
                .eq(HarnessFailureCase::getFailureType, failureType)
                .eq(HarnessFailureCase::getStatus, "open")
                .orderByDesc(HarnessFailureCase::getCreatedAt)
                .last("LIMIT 50"));
        for (HarnessFailureCase failure : failures) {
            failure.setStatus("regression");
            failureCaseMapper.updateById(failure);
        }
    }

    private List<Map<String, Object>> summarizeEvents(String eventsJson) {
        List<Map<String, Object>> events = readEvents(eventsJson);
        if (events.isEmpty()) return List.of();
        return events.stream()
                .skip(Math.max(0, events.size() - 20))
                .map(e -> {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("type", e.get("type"));
                    item.put("name", e.get("name"));
                    item.put("ts", e.get("ts"));
                    return item;
                })
                .toList();
    }

    private int nextTraceEventSeq(Long traceId) {
        try {
            Integer maxSeq = traceEventMapper.selectMaxSeq(traceId);
            return (maxSeq != null ? maxSeq : 0) + 1;
        } catch (Exception e) {
            return 1;
        }
    }

    private Map<String, Object> buildReplayCase(HarnessTrace trace, String failureType, String errorMsg) {
        Map<String, Object> replay = new LinkedHashMap<>();
        replay.put("schema", "harness.replay.case.v1");
        replay.put("traceId", trace.getId());
        replay.put("traceUuid", trace.getTraceUuid());
        replay.put("surface", trace.getSurface());
        replay.put("failureType", failureType);
        replay.put("input", trace.getInputSummary());
        replay.put("userId", trace.getUserId());
        replay.put("conversationId", trace.getConversationId());
        replay.put("agentId", readJsonMap(trace.getRequestJson()).get("agentId"));
        replay.put("model", trace.getModel());
        replay.put("provider", trace.getProvider());
        replay.put("channelId", trace.getChannelId());
        replay.put("conversationUuid", trace.getConversationUuid());
        replay.put("request", readJsonMap(trace.getRequestJson()));
        replay.put("context", readJsonMap(trace.getContextJson()));
        replay.put("fileUrls", readJsonMap(trace.getRequestJson()).getOrDefault("fileUrls", List.of()));
        replay.put("events", readEvents(trace.getEventsJson()));
        replay.put("expectedOutcome", Map.of(
                "originalFailureTypeMustDisappear", failureType,
                "mustProduceStructuredTraceEvent", true,
                "mustNotReturnEmptyAssistantMessage", true,
                "toolFailureMustExposeErrorCodeOrMessage", true,
                "mustNotOnlySayException", true
        ));
        replay.put("safeReplay", Map.of(
                "writeChatMessages", false,
                "chargeWallet", false,
                "updateBilling", false,
                "sideEffectTools", false,
                "readOnlyTools", true
        ));
        replay.put("errorMessage", truncate(errorMsg, 1000));
        return replay;
    }

    private Map<String, Object> evaluateSafeReplayCase(HarnessRegressionRun run, Map<String, Object> item,
                                                       Map<String, Object> policy) {
        String failureType = blankTo(String.valueOf(item.getOrDefault("failureType", "")), "unknown");
        String caseSurface = blankTo(String.valueOf(item.getOrDefault("surface", run.getSurface())), run.getSurface());
        Map<String, Object> replayCase = mutableMap(item.get("replayCase"));
        Map<String, Object> evidenceMap = mutableMap(item.get("evidence"));
        if (replayCase.isEmpty()) {
            replayCase = mutableMap(evidenceMap.get("replayCase"));
        }

        Long traceId = valueAsLong(item.get("traceId"));
        if (traceId == null) {
            traceId = valueAsLong(replayCase.get("traceId"));
        }
        List<Map<String, Object>> persistedEvents = traceId != null ? traceEventsAsMaps(traceId) : List.of();
        List<Map<String, Object>> replayEvents = listOfMaps(replayCase.get("events"));
        List<Map<String, Object>> allEvents = new ArrayList<>();
        allEvents.addAll(replayEvents);
        allEvents.addAll(persistedEvents);

        boolean hasReplayCase = "harness.replay.case.v1".equals(String.valueOf(replayCase.get("schema")));
        boolean hasEventEvidence = !allEvents.isEmpty();
        boolean hasStructuredTraceEvent = !persistedEvents.isEmpty() || allEvents.stream().anyMatch(event ->
                event.get("seq") != null && (event.get("name") != null || event.get("eventName") != null));

        boolean hasPolicy = hasHarnessPolicy(policy);
        boolean coversFailure = policyCoversFailure(policy, failureType, caseSurface);
        boolean hasStructuredTraceRule = hasStructuredTraceRule(policy);
        boolean hasFailureClassifier = hasFailureClassifier(policy, failureType);

        Map<String, Object> runtimePolicy = mutableMap(policy.get("agentRuntimePolicy"));
        Map<String, Object> toolPolicy = mutableMap(policy.get("toolPolicyOverrides"));
        boolean emptyResponseGuard = Boolean.TRUE.equals(runtimePolicy.get("emptyResponseIsFailure"));
        boolean pseudoToolFallback = Boolean.TRUE.equals(runtimePolicy.get("pseudoToolFallback"));
        boolean structuredToolError = Boolean.TRUE.equals(toolPolicy.get("requireStructuredError"));

        boolean hasToolCall = allEvents.stream().anyMatch(event -> "tool_call".equals(eventName(event)));
        boolean hasToolResult = allEvents.stream().anyMatch(event -> "tool_result".equals(eventName(event)));
        boolean hasToolError = allEvents.stream().anyMatch(event ->
                "tool_result".equals(eventName(event)) && "error".equalsIgnoreCase(eventStatus(event)));
        boolean toolFailureHasDetail = !hasToolError || allEvents.stream()
                .filter(event -> "tool_result".equals(eventName(event)) && "error".equalsIgnoreCase(eventStatus(event)))
                .anyMatch(this::hasReadableToolError);
        boolean noSilentToolSkip = !hasToolCall || hasToolResult || pseudoToolFallback;
        HarnessReplayToolSandboxService.ReplayToolReport toolReplay =
                replayToolSandboxService.replayReadOnlyTools(replayCase, allEvents);

        boolean genericExceptionOnly = !notGenericException(String.valueOf(item.getOrDefault("avoid", "")))
                || !notGenericException(String.valueOf(replayCase.getOrDefault("errorMessage", "")));
        boolean notOnlyException = !genericExceptionOnly || hasFailureClassifier(policy, "tool_error")
                || hasFailureClassifier(policy, "unknown");

        Map<String, Object> assertions = new LinkedHashMap<>();
        assertions.put("hasReplayCase", hasReplayCase);
        assertions.put("hasEventEvidence", hasEventEvidence);
        assertions.put("hasStructuredTraceEvent", hasStructuredTraceEvent);
        assertions.put("hasHarnessPolicy", hasPolicy);
        assertions.put("coversOriginalFailureType", coversFailure);
        assertions.put("hasFailureClassifier", hasFailureClassifier);
        assertions.put("requiresStructuredTrace", hasStructuredTraceRule);
        assertions.put("emptyResponseGuard", emptyResponseGuard);
        assertions.put("noSilentToolSkip", noSilentToolSkip);
        assertions.put("toolFailureHasErrorCodeOrMessage", toolFailureHasDetail && structuredToolError);
        assertions.put("readOnlyToolReplay", toolReplay.passed());
        assertions.put("notOnlyGenericException", notOnlyException);

        List<String> missing = assertions.entrySet().stream()
                .filter(entry -> !Boolean.TRUE.equals(entry.getValue()))
                .map(Map.Entry::getKey)
                .toList();
        String status;
        if (!hasReplayCase || !hasEventEvidence || !hasStructuredTraceEvent) {
            status = "blocked";
        } else if ("blocked".equals(toolReplay.status())) {
            status = "blocked";
        } else {
            status = missing.isEmpty() ? "passed" : "failed";
        }

        Map<String, Object> replayEvidence = new LinkedHashMap<>();
        replayEvidence.put("runMode", "safe_replay_v2");
        replayEvidence.put("sideEffects", false);
        replayEvidence.put("traceId", traceId);
        replayEvidence.put("replaySchema", replayCase.get("schema"));
        replayEvidence.put("policySchema", policy.get("schemaVersion"));
        replayEvidence.put("legacyEventCount", replayEvents.size());
        replayEvidence.put("structuredEventCount", persistedEvents.size());
        replayEvidence.put("toolReplay", Map.of(
                "status", toolReplay.status(),
                "passedCount", toolReplay.passedCount(),
                "failedCount", toolReplay.failedCount(),
                "blockedCount", toolReplay.blockedCount(),
                "results", toolReplay.results(),
                "summary", toolReplay.summary()
        ));
        replayEvidence.put("assertions", assertions);
        replayEvidence.put("missing", missing);
        replayEvidence.put("replaySafety", Map.of(
                "writesChatMessages", false,
                "chargesWallet", false,
                "executesSideEffectTools", false,
                "allowsReadOnlyTools", true
        ));

        Map<String, Object> caseResult = new LinkedHashMap<>();
        caseResult.put("caseId", item.get("caseId"));
        caseResult.put("surface", caseSurface);
        caseResult.put("failureType", failureType);
        caseResult.put("status", status);
        caseResult.put("summary", switch (status) {
            case "passed" -> "Safe replay v2 verified replay evidence, candidate policy coverage, structured trace and tool-error gates.";
            case "blocked" -> "Safe replay v2 blocked: historical sample is missing replay evidence or structured trace events.";
            default -> "Safe replay v2 failed: candidate policy does not satisfy replay assertions: " + String.join(", ", missing);
        });
        caseResult.put("evidence", replayEvidence);
        return caseResult;
    }

    private List<Map<String, Object>> traceEventsAsMaps(Long traceId) {
        if (traceId == null) return List.of();
        try {
            return traceEventMapper.selectList(new LambdaQueryWrapper<HarnessTraceEvent>()
                            .eq(HarnessTraceEvent::getTraceId, traceId)
                            .orderByAsc(HarnessTraceEvent::getSeq)
                            .orderByAsc(HarnessTraceEvent::getCreatedAt))
                    .stream()
                    .map(event -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("seq", event.getSeq());
                        row.put("type", event.getEventType());
                        row.put("name", event.getEventName());
                        row.put("status", event.getStatus());
                        row.put("toolName", event.getToolName());
                        row.put("toolCallId", event.getToolCallId());
                        row.put("payload", readJsonMap(event.getPayloadJson()));
                        row.put("createdAt", event.getCreatedAt());
                        return row;
                    })
                    .toList();
        } catch (Exception e) {
            log.debug("[Harness] traceEventsAsMaps failed: {}", e.getMessage());
            return List.of();
        }
    }

    private String eventName(Map<String, Object> event) {
        return blankTo(valueAsString(event.get("name")), valueAsString(event.get("eventName")));
    }

    private String eventStatus(Map<String, Object> event) {
        String status = valueAsString(event.get("status"));
        if (status != null) return status;
        return valueAsString(mutableMap(event.get("payload")).get("status"));
    }

    private boolean hasReadableToolError(Map<String, Object> event) {
        Map<String, Object> payload = mutableMap(event.get("payload"));
        String combined = String.join(" ",
                blankTo(valueAsString(payload.get("errorCode")), ""),
                blankTo(valueAsString(payload.get("message")), ""),
                blankTo(valueAsString(payload.get("detail")), ""),
                blankTo(valueAsString(payload.get("result")), ""),
                blankTo(valueAsString(event.get("summary")), ""));
        return notGenericException(combined);
    }

    private boolean notGenericException(String text) {
        String value = blankTo(text, "").trim();
        if (value.isBlank()) return false;
        String normalized = value.toLowerCase();
        return normalized.length() > 8
                && !List.of("异常", "錯誤", "错误", "error", "exception", "failed", "失败")
                .contains(normalized);
    }

    private Map<String, Object> normalizePolicyConfig(Map<String, Object> config) {
        Map<String, Object> normalized = new LinkedHashMap<>();
        if (config != null) {
            normalized.putAll(config);
        }
        Map<String, Object> policy = policyFromConfig(normalized);
        if (!hasHarnessPolicy(policy)) {
            String surface = blankTo(valueAsString(normalized.get("surface")), "chat");
            String failureType = blankTo(valueAsString(normalized.get("failureType")), "unknown");
            List<String> recommendations = stringList(normalized.get("recommendations"));
            if (recommendations.isEmpty()) {
                recommendations = suggestRecommendations(surface, failureType);
            }
            policy = buildExecutablePolicy(surface, failureType, recommendations);
        }
        normalized.put("schemaVersion", "harness.policy.v1");
        normalized.put("kind", "harness.policy.v1");
        normalized.put("policy", policy);
        normalized.putIfAbsent("surface", policy.get("surface"));
        normalized.putIfAbsent("failureType", policy.get("failureType"));
        normalized.putIfAbsent("recommendations", mutableMap(policy.get("promptGuidance")).getOrDefault("rules", List.of()));
        normalized.put("promptGuidance", policy.get("promptGuidance"));
        normalized.put("agentRuntimePolicy", policy.get("agentRuntimePolicy"));
        normalized.put("toolPolicyOverrides", policy.get("toolPolicyOverrides"));
        normalized.put("modelRoutingRules", policy.get("modelRoutingRules"));
        normalized.put("failureClassifiers", policy.get("failureClassifiers"));
        normalized.put("rollout", policy.get("rollout"));
        return normalized;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> policyFromConfig(Map<String, Object> config) {
        if (config == null || config.isEmpty()) return new LinkedHashMap<>();
        Object policy = config.get("policy");
        if (policy instanceof Map<?, ?> policyMap) {
            Map<String, Object> normalized = new LinkedHashMap<>();
            policyMap.forEach((key, value) -> {
                if (key != null) normalized.put(String.valueOf(key), value);
            });
            return normalized;
        }
        Map<String, Object> policyLike = new LinkedHashMap<>();
        for (String key : List.of("schemaVersion", "surface", "failureType", "promptGuidance",
                "agentRuntimePolicy", "toolPolicyOverrides", "modelRoutingRules", "failureClassifiers", "rollout")) {
            if (config.containsKey(key)) {
                policyLike.put(key, config.get(key));
            }
        }
        return policyLike;
    }

    private boolean hasHarnessPolicy(Map<String, Object> policy) {
        return policy != null
                && "harness.policy.v1".equals(String.valueOf(policy.get("schemaVersion")))
                && policy.get("promptGuidance") instanceof Map<?, ?>
                && policy.get("agentRuntimePolicy") instanceof Map<?, ?>
                && policy.get("toolPolicyOverrides") instanceof Map<?, ?>
                && policy.get("modelRoutingRules") instanceof Map<?, ?>
                && policy.get("failureClassifiers") instanceof List<?>
                && policy.get("rollout") instanceof Map<?, ?>;
    }

    private boolean policyCoversFailure(Map<String, Object> policy, String failureType, String surface) {
        if (!hasHarnessPolicy(policy)) return false;
        String normalizedFailure = blankTo(failureType, "unknown").toLowerCase();
        if (containsToken(String.valueOf(policy.get("failureType")), normalizedFailure)) {
            return true;
        }
        if (containsToken(String.valueOf(policy.get("surface")), surface)) {
            return true;
        }
        for (String rule : stringList(mutableMap(policy.get("promptGuidance")).get("rules"))) {
            if (containsToken(rule, normalizedFailure) || containsToken(rule, surface)) {
                return true;
            }
        }
        for (Map<String, Object> classifier : listOfMaps(policy.get("failureClassifiers"))) {
            String classifierType = String.valueOf(classifier.getOrDefault("failureType", ""));
            if (containsToken(classifierType, normalizedFailure)) {
                return true;
            }
            for (String match : stringList(classifier.get("match"))) {
                if (containsToken(normalizedFailure, match) || containsToken(match, normalizedFailure)) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean hasFailureClassifier(Map<String, Object> policy, String failureType) {
        if (!hasHarnessPolicy(policy)) return false;
        String normalizedFailure = blankTo(failureType, "unknown").toLowerCase();
        for (Map<String, Object> classifier : listOfMaps(policy.get("failureClassifiers"))) {
            String classifierType = String.valueOf(classifier.getOrDefault("failureType", ""));
            if (containsToken(classifierType, normalizedFailure) || containsToken(normalizedFailure, classifierType)) {
                return true;
            }
            for (String match : stringList(classifier.get("match"))) {
                if (containsToken(match, normalizedFailure) || containsToken(normalizedFailure, match)) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean hasStructuredTraceRule(Map<String, Object> policy) {
        if (!hasHarnessPolicy(policy)) return false;
        Map<String, Object> runtime = mutableMap(policy.get("agentRuntimePolicy"));
        Map<String, Object> toolPolicy = mutableMap(policy.get("toolPolicyOverrides"));
        return "emit_agent_status".equals(String.valueOf(runtime.get("waitMessageHandling")))
                && Boolean.TRUE.equals(toolPolicy.get("requireStructuredError"));
    }

    private Map<String, Object> mutableMap(Object value) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (value instanceof Map<?, ?> map) {
            map.forEach((key, val) -> {
                if (key != null) result.put(String.valueOf(key), val);
            });
        }
        return result;
    }

    private LambdaQueryWrapper<HarnessTrace> traceFilter(String surface) {
        LambdaQueryWrapper<HarnessTrace> qw = new LambdaQueryWrapper<>();
        if (surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)) {
            qw.eq(HarnessTrace::getSurface, surface);
        }
        return qw;
    }

    private LambdaQueryWrapper<HarnessFailureCase> failureFilter(String surface) {
        LambdaQueryWrapper<HarnessFailureCase> qw = new LambdaQueryWrapper<>();
        if (surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)) {
            qw.eq(HarnessFailureCase::getSurface, surface);
        }
        return qw;
    }

    private LambdaQueryWrapper<HarnessPatch> patchFilter(String surface) {
        LambdaQueryWrapper<HarnessPatch> qw = new LambdaQueryWrapper<>();
        if (surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)) {
            qw.eq(HarnessPatch::getSurface, surface);
        }
        return qw;
    }

    private LambdaQueryWrapper<HarnessVersion> versionFilter(String surface) {
        LambdaQueryWrapper<HarnessVersion> qw = new LambdaQueryWrapper<>();
        if (surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)) {
            qw.eq(HarnessVersion::getSurface, surface);
        }
        return qw;
    }

    private LambdaQueryWrapper<HarnessRegressionRun> regressionRunFilter(String surface) {
        LambdaQueryWrapper<HarnessRegressionRun> qw = new LambdaQueryWrapper<>();
        if (surface != null && !surface.isBlank() && !"all".equalsIgnoreCase(surface)) {
            qw.eq(HarnessRegressionRun::getSurface, surface);
        }
        return qw;
    }

    private int safeLimit(int limit, int max) {
        return Math.max(1, Math.min(limit, max));
    }

    private int safePage(int page) {
        return Math.max(1, page);
    }

    private int safeSize(int size) {
        return Math.max(1, Math.min(size, 100));
    }

    private String normalizeSurface(String surface, String fallback) {
        return surface == null || surface.isBlank() ? fallback : surface;
    }

    private String normalizeStatus(String status) {
        return status != null ? status.trim().toLowerCase() : "";
    }

    private String toJson(Object value) {
        try {
            return value == null ? null : objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return null;
        }
    }

    private List<Map<String, Object>> readEvents(String json) {
        if (json == null || json.isBlank()) return new ArrayList<>();
        try {
            return objectMapper.readValue(json, EVENT_LIST_TYPE);
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJsonMap(String json) {
        if (json == null || json.isBlank()) return Map.of();
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (Exception e) {
            return Map.of();
        }
    }

    private Map<String, Object> mutableJsonMap(String json) {
        return new LinkedHashMap<>(readJsonMap(json));
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> listOfMaps(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                Map<String, Object> normalized = new LinkedHashMap<>();
                map.forEach((key, val) -> {
                    if (key != null) normalized.put(String.valueOf(key), val);
                });
                result.add(normalized);
            }
        }
        return result;
    }

    private List<String> stringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream()
                .filter(item -> item != null && !String.valueOf(item).isBlank())
                .map(String::valueOf)
                .toList();
    }

    private boolean containsToken(String text, String token) {
        if (text == null || token == null || token.isBlank()) return false;
        String haystack = text.toLowerCase();
        String needle = token.toLowerCase();
        return haystack.contains(needle);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractCaseResults(Map<String, Object> body) {
        Object result = body.get("result");
        if (result instanceof Map<?, ?> resultMap && resultMap.get("caseResults") != null) {
            return listOfMaps(resultMap.get("caseResults"));
        }
        if (body.get("caseResults") != null) {
            return listOfMaps(body.get("caseResults"));
        }
        return List.of();
    }

    private int countCaseStatus(List<Map<String, Object>> caseResults, String status) {
        return (int) caseResults.stream()
                .filter(item -> status.equalsIgnoreCase(String.valueOf(item.get("status"))))
                .count();
    }

    private void createFailuresFromRegressionResults(HarnessRegressionRun run, List<Map<String, Object>> caseResults) {
        if (caseResults == null || caseResults.isEmpty()) return;
        for (Map<String, Object> item : caseResults) {
            String status = normalizeStatus(String.valueOf(item.getOrDefault("status", "")));
            if (!List.of("failed", "blocked").contains(status)) continue;
            try {
                HarnessFailureCase failure = new HarnessFailureCase();
                failure.setSurface(blankTo(String.valueOf(item.getOrDefault("surface", run.getSurface())), run.getSurface()));
                failure.setFailureType(blankTo(String.valueOf(item.getOrDefault("failureType", "regression_" + status)), "regression_" + status));
                failure.setSeverity("failed".equals(status) ? "high" : "medium");
                failure.setSummary(truncate("Regression run #" + run.getId() + " case "
                        + item.getOrDefault("caseId", "-") + " " + status + ": "
                        + item.getOrDefault("summary", run.getSummary()), 1000));
                failure.setEvidenceJson(toJson(Map.of(
                        "regressionRunId", run.getId(),
                        "versionId", run.getVersionId(),
                        "version", blankTo(run.getVersion(), ""),
                        "caseResult", item
                )));
                failure.setStatus("open");
                failureCaseMapper.insert(failure);
            } catch (Exception e) {
                log.warn("[Harness] create regression failure failed: {}", e.getMessage());
            }
        }
    }

    private String truncate(String value, int max) {
        if (value == null) return null;
        return value.length() <= max ? value : value.substring(0, max) + "...";
    }

    private String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private int valueAsInt(Object value, int fallback) {
        if (value == null) return fallback;
        if (value instanceof Number number) return number.intValue();
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (Exception e) {
            return fallback;
        }
    }

    private Integer valueAsInteger(Object value) {
        if (value == null) return null;
        if (value instanceof Number number) return number.intValue();
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (Exception e) {
            return null;
        }
    }

    private Long valueAsLong(Object value) {
        if (value == null) return null;
        if (value instanceof Number number) return number.longValue();
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (Exception e) {
            return null;
        }
    }

    private long valueAsLong(Object value, long fallback) {
        Long parsed = valueAsLong(value);
        return parsed != null ? parsed : fallback;
    }

    private double valueAsDouble(Object value, double fallback) {
        if (value == null) return fallback;
        if (value instanceof Number number) return number.doubleValue();
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (Exception e) {
            return fallback;
        }
    }

    private String valueAsString(Object value) {
        if (value == null) return null;
        String text = String.valueOf(value);
        return text.isBlank() ? null : text;
    }

    private String defaultRegressionSummary(String status, int total, int passed, int failed, int blocked) {
        return "Regression run " + status + ". total=" + total + ", passed=" + passed
                + ", failed=" + failed + ", blocked=" + blocked;
    }
}
