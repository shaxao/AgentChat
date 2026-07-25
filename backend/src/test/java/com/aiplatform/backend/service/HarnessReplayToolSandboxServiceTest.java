package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HarnessReplayToolSandboxServiceTest {

    @Test
    void blocksSideEffectToolWithoutRecordedOutcome() throws Exception {
        Object service = newSandboxService(null);

        // Only a tool_call, no matching tool_result recorded: cannot judge a side-effect tool safely.
        Object report = replay(service, Map.of(),
                List.of(toolCall("memory_save_document", "{\"title\":\"WORK.md\",\"content\":\"x\"}")));

        assertThat(call(report, "status")).isEqualTo("blocked");
        assertThat(call(report, "blockedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "SIDE_EFFECT_OUTCOME_MISSING");
        assertThat(firstResult(report)).containsEntry("executed", false);
        assertThat(firstResult(report)).containsEntry("mode", "simulated_recorded_outcome");
    }

    @Test
    void passesSideEffectToolWithRecordedSuccess() throws Exception {
        Object service = newSandboxService(null);

        Object report = replay(service, Map.of(), List.of(
                toolCall("memory_save_document", "{\"title\":\"WORK.md\",\"content\":\"x\"}"),
                toolResult("memory_save_document", "call-1", "completed", null)));

        assertThat(call(report, "status")).isEqualTo("passed");
        assertThat(call(report, "passedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "SIDE_EFFECT_OUTCOME_RECORDED");
        assertThat(firstResult(report)).containsEntry("executed", false);
        assertThat(firstResult(report)).containsEntry("mode", "simulated_recorded_outcome");
        @SuppressWarnings("unchecked")
        Map<String, Object> simulation = (Map<String, Object>) firstResult(report).get("simulation");
        assertThat(simulation)
                .containsEntry("operation", "write")
                .containsEntry("target", "title:WORK.md")
                .containsEntry("executed", false);
    }

    @Test
    void failsSideEffectSimulationWhenArgumentsAreInvalid() throws Exception {
        Object service = newSandboxService(null);

        Object report = replay(service, Map.of(), List.of(
                toolCall("memory_save_document", "{\"title\":\"WORK.md\"}"),
                toolResult("memory_save_document", "call-1", "completed", null)));

        assertThat(call(report, "status")).isEqualTo("failed");
        assertThat(call(report, "failedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "SIDE_EFFECT_ARGUMENTS_INVALID");
        assertThat(firstResult(report)).containsEntry("executed", false);
    }

    @Test
    void passesSideEffectToolWhenFailureWasStructured() throws Exception {
        Object service = newSandboxService(null);

        Map<String, Object> failure = new LinkedHashMap<>();
        failure.put("failureType", "memory_quota_exceeded");
        failure.put("message", "Memory store rejected the write: quota exceeded for this conversation.");

        Object report = replay(service, Map.of(), List.of(
                toolCall("memory_save_document", "{\"title\":\"WORK.md\",\"content\":\"x\"}"),
                toolResult("memory_save_document", "call-1", "error", failure)));

        assertThat(call(report, "status")).isEqualTo("passed");
        assertThat(call(report, "passedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "SIDE_EFFECT_OUTCOME_STRUCTURED_ERROR");
    }

    @Test
    void failsSideEffectToolWhenFailureIsGenericException() throws Exception {
        Object service = newSandboxService(null);

        Map<String, Object> failure = new LinkedHashMap<>();
        failure.put("message", "error");

        Object report = replay(service, Map.of(), List.of(
                toolCall("memory_save_document", "{\"title\":\"WORK.md\",\"content\":\"x\"}"),
                toolResult("memory_save_document", "call-1", "error", failure)));

        assertThat(call(report, "status")).isEqualTo("failed");
        assertThat(call(report, "failedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "SIDE_EFFECT_OUTCOME_UNSTRUCTURED");
    }

    @Test
    void blocksMissingToolArguments() throws Exception {
        Object service = newSandboxService(null);

        Object report = replay(service, Map.of(), List.of(toolCallWithoutArguments("read_uploaded_file")));

        assertThat(call(report, "status")).isEqualTo("blocked");
        assertThat(call(report, "blockedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "TOOL_ARGUMENTS_MISSING");
    }

    @Test
    void replaysUploadedFileThroughSharedReader() throws Exception {
        Class<?> uploadedClass = Class.forName("com.aiplatform.backend.service.UploadedFileReadService");
        Object uploadedMock = mock(uploadedClass);
        Method readByName = uploadedClass.getMethod(
                "readByName", Long.class, String.class, Long.class, String.class, List.class);
        when(readByName.invoke(uploadedMock, 7L, null, 11L, "a.xlsx", List.of("https://oss.example/a.xlsx")))
                .thenReturn(readResult(true, "OK", "Parsed file a.xlsx"));

        Object service = newSandboxService(uploadedMock);
        Map<String, Object> replayCase = new LinkedHashMap<>();
        replayCase.put("userId", 7L);
        replayCase.put("conversationId", 11L);
        replayCase.put("fileUrls", List.of("https://oss.example/a.xlsx"));

        Object report = replay(service, replayCase,
                List.of(toolCall("read_uploaded_file", "{\"fileName\":\"a.xlsx\"}")));

        assertThat(call(report, "status")).isEqualTo("passed");
        assertThat(call(report, "passedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "OK");
        assertThat(firstResult(report).get("outputPreview")).isEqualTo("Parsed file a.xlsx");
    }

    @Test
    void failedUploadedFileReadIsReportedAsReplayFailure() throws Exception {
        Class<?> uploadedClass = Class.forName("com.aiplatform.backend.service.UploadedFileReadService");
        Object uploadedMock = mock(uploadedClass);
        Method readByName = uploadedClass.getMethod(
                "readByName", Long.class, String.class, Long.class, String.class, List.class);
        when(readByName.invoke(uploadedMock, 7L, "conv-1", null, "missing.xlsx", List.of()))
                .thenReturn(readResult(false, "FILE_NOT_FOUND", "File missing.xlsx was not found."));

        Object service = newSandboxService(uploadedMock);
        Map<String, Object> replayCase = new LinkedHashMap<>();
        replayCase.put("userId", 7L);
        replayCase.put("conversationUuid", "conv-1");

        Object report = replay(service, replayCase,
                List.of(toolCall("read_uploaded_file", "{\"fileName\":\"missing.xlsx\"}")));

        assertThat(call(report, "status")).isEqualTo("failed");
        assertThat(call(report, "failedCount")).isEqualTo(1);
        assertThat(firstResult(report)).containsEntry("code", "TOOL_REPLAY_FAILED");
        assertThat(String.valueOf(firstResult(report).get("message"))).contains("FILE_NOT_FOUND");
    }

    private Object newSandboxService(Object uploadedFileReadService) throws Exception {
        Class<?> toolResultStorageClass = Class.forName("com.aiplatform.backend.service.ToolResultStorageService");
        Class<?> memoryServiceClass = Class.forName("com.aiplatform.backend.service.MemoryService");
        Class<?> uploadedClass = Class.forName("com.aiplatform.backend.service.UploadedFileReadService");
        Class<?> conversationMapperClass = Class.forName("com.aiplatform.backend.mapper.ChatConversationMapper");
        Class<?> serviceClass = Class.forName("com.aiplatform.backend.service.HarnessReplayToolSandboxService");
        Object uploaded = uploadedFileReadService != null ? uploadedFileReadService : mock(uploadedClass);
        return serviceClass
                .getConstructor(toolResultStorageClass, memoryServiceClass, uploadedClass,
                        conversationMapperClass, ObjectMapper.class)
                .newInstance(mock(toolResultStorageClass), mock(memoryServiceClass),
                        uploaded, mock(conversationMapperClass), new ObjectMapper());
    }

    private Object replay(Object service, Map<String, Object> replayCase, List<Map<String, Object>> events) throws Exception {
        Method method = service.getClass().getMethod("replayReadOnlyTools", Map.class, List.class);
        return method.invoke(service, replayCase, events);
    }

    private Object readResult(boolean success, String code, String output) throws Exception {
        Class<?> resultClass = Class.forName("com.aiplatform.backend.service.UploadedFileReadService$ReadResult");
        return resultClass
                .getConstructor(boolean.class, String.class, String.class, String.class, String.class, int.class)
                .newInstance(success, code, output, null, null, output.length());
    }

    private Map<String, Object> toolCall(String toolName, String argumentsJson) {
        Map<String, Object> event = toolCallWithoutArguments(toolName);
        event.put("argumentsJson", argumentsJson);
        return event;
    }

    private Map<String, Object> toolCallWithoutArguments(String toolName) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("eventName", "tool_call");
        event.put("toolName", toolName);
        event.put("toolCallId", "call-1");
        return event;
    }

    private Map<String, Object> toolResult(String toolName, String toolCallId, String status,
                                           Map<String, Object> failureFields) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("eventName", "tool_result");
        event.put("toolName", toolName);
        event.put("toolCallId", toolCallId);
        event.put("status", status);
        if (failureFields != null) {
            event.putAll(failureFields);
        }
        return event;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> firstResult(Object report) throws Exception {
        return ((List<Map<String, Object>>) call(report, "results")).get(0);
    }

    private Object call(Object target, String methodName) throws Exception {
        return target.getClass().getMethod(methodName).invoke(target);
    }
}
