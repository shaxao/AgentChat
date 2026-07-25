package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ChatAgentRuntimeServiceTest {

    @Test
    void classifiesEmptyToolResult() throws Exception {
        Object service = newRuntimeService();
        Object failure = classify(service, "read_uploaded_file", "call-1", " ");

        assertThat(call(failure, "failed")).isEqualTo(true);
        assertThat(call(failure, "failureType")).isEqualTo("tool_empty_result");
        assertThat(call(failure, "errorCode")).isEqualTo("TOOL_EMPTY_RESULT");
    }

    @Test
    void classifiesStructuredJsonToolError() throws Exception {
        Object service = newRuntimeService();
        Object failure = classify(service, "read_uploaded_file", "call-1",
                "{\"errorCode\":\"file_not_found\",\"message\":\"file is missing\"}");

        assertThat(call(failure, "failed")).isEqualTo(true);
        assertThat(call(failure, "failureType")).isEqualTo("tool_error");
        assertThat(call(failure, "errorCode")).isEqualTo("FILE_NOT_FOUND");
        assertThat(call(failure, "message")).isEqualTo("file is missing");
    }

    @Test
    void acceptsNormalToolResult() throws Exception {
        Object service = newRuntimeService();
        Object failure = classify(service, "read_uploaded_file", "call-1", "Parsed file content");

        assertThat(call(failure, "failed")).isEqualTo(false);
        assertThat(call(failure, "failureType")).isEqualTo("");
    }

    private Object newRuntimeService() throws Exception {
        Class<?> serviceClass = Class.forName("com.aiplatform.backend.service.ChatAgentRuntimeService");
        Class<?> harnessClass = Class.forName("com.aiplatform.backend.service.HarnessEvolutionService");
        return serviceClass
                .getConstructor(harnessClass, ObjectMapper.class)
                .newInstance(mock(harnessClass), new ObjectMapper());
    }

    private Object classify(Object service, String toolName, String toolCallId, String result) throws Exception {
        Method method = service.getClass().getMethod("classifyToolResult", String.class, String.class, String.class);
        return method.invoke(service, toolName, toolCallId, result);
    }

    private Object call(Object target, String methodName) throws Exception {
        return target.getClass().getMethod(methodName).invoke(target);
    }
}
