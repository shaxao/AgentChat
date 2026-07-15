package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * 内联代码执行服务（共享）
 * <p>
 * 从 ToolTestController 抽取，供工作流执行引擎和工具测试 API 共同使用。
 * 支持 Python 和 JavaScript 代码在沙箱中执行，通过 stdin 传参，stdout 返回 JSON 结果。
 */
@Slf4j
@Service
public class CodeExecutionService {

    private final ObjectMapper objectMapper;

    public CodeExecutionService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * 执行代码 — Python 通过 python3 进程，JS 通过 node 进程
     *
     * @param code     代码内容
     * @param language "python" 或 "javascript"/"js"
     * @param input    输入参数（将通过 stdin 传递给脚本）
     * @return 执行结果 Map，包含 success、output/error、elapsedMs 等字段
     */
    public Map<String, Object> executeCode(String code, String language,
                                             Map<String, Object> input) throws Exception {
        return executeCode(code, language, input, null, null);
    }

    /**
     * 执行代码，带权限预检和可配置超时。
     *
     * @param permissions null 表示兼容旧工具，不做权限预检；空列表表示不授予额外能力。
     */
    public Map<String, Object> executeCode(String code, String language,
                                             Map<String, Object> input,
                                             Integer timeoutSeconds,
                                             List<String> permissions) throws Exception {
        validateExecutionPolicy(code, language, permissions);
        int timeout = normalizeTimeout(timeoutSeconds);
        Path tmpDir = Files.createTempDirectory("tooltest_");
        try {
            String inputJson = objectMapper.writeValueAsString(input);

            if ("javascript".equalsIgnoreCase(language) || "js".equalsIgnoreCase(language)) {
                return executeJavaScript(tmpDir, code, inputJson, timeout);
            } else {
                return executePython(tmpDir, code, inputJson, timeout);
            }
        } finally {
            // 清理临时文件
            try {
                Files.walk(tmpDir).sorted(java.util.Comparator.reverseOrder())
                        .map(Path::toFile).forEach(File::delete);
            } catch (IOException ignored) {}
        }
    }

    private int normalizeTimeout(Integer timeoutSeconds) {
        if (timeoutSeconds == null || timeoutSeconds <= 0) {
            return 60;
        }
        return Math.max(1, Math.min(timeoutSeconds, 300));
    }

    private void validateExecutionPolicy(String code, String language, List<String> permissions) {
        if (permissions == null) {
            return;
        }
        if (code == null || code.isBlank()) {
            throw new IllegalArgumentException("代码不能为空");
        }
        String lang = language != null ? language.toLowerCase(Locale.ROOT) : "python";
        if (!Set.of("python", "py", "javascript", "js").contains(lang)) {
            throw new IllegalArgumentException("仅支持 python / javascript 自定义工具");
        }

        Set<String> allowed = new HashSet<>();
        for (String permission : permissions) {
            if (permission != null && !permission.isBlank()) {
                allowed.add(permission.toLowerCase(Locale.ROOT));
            }
        }

        String normalized = code.toLowerCase(Locale.ROOT);
        if (!allowed.contains("network") && containsAny(normalized,
                "import requests", "from requests", "urllib.", "import urllib", "http.client",
                "socket.", "import socket", "fetch(", "axios", "require('http", "require(\"http",
                "require('https", "require(\"https", "require('net", "require(\"net")) {
            throw new SecurityException("代码使用了网络访问能力，请在工具权限中启用 network");
        }
        if (!allowed.contains("filesystem_read") && containsAny(normalized,
                "open(", "pathlib.", "import pathlib", "os.listdir", "glob.", "import glob",
                "read_text(", "fs.read", "require('fs", "require(\"fs")) {
            throw new SecurityException("代码使用了文件读取能力，请在工具权限中启用 filesystem_read");
        }
        if (!allowed.contains("filesystem_write") && containsAny(normalized,
                "write_text(", ".write(", "os.remove", "os.unlink", "shutil.rmtree",
                "fs.write", "fs.unlink", "fs.rm", "fs.rmdir")) {
            throw new SecurityException("代码使用了文件写入/删除能力，请在工具权限中启用 filesystem_write");
        }
        if (!allowed.contains("process") && containsAny(normalized,
                "subprocess", "os.system", "popen(", "child_process", "exec(", "spawn(")) {
            throw new SecurityException("代码使用了进程调用能力，请在工具权限中启用 process");
        }
    }

    private boolean containsAny(String text, String... needles) {
        for (String needle : needles) {
            if (text.contains(needle)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 剥离 Python 代码中的 if __name__ == "__main__": 入口块
     * <p>
     * AI 生成的代码末尾通常包含自己的入口块（从 stdin 读取 {tool_name, arguments} 格式数据）。
     * 在测试执行时，后端会拼接自己的包装器入口块（直接读取 stdin 作为 args），
     * 两个入口块会导致 stdin 被先执行的块消费，后续块读到空数据。
     * <p>
     * 此方法移除代码中所有 if __name__ == "__main__": 及其后续所有行，
     * 保留 main() 函数定义和其他业务逻辑。
     */
    private String stripMainEntryBlock(String code) {
        if (code == null || code.trim().isEmpty()) {
            return code;
        }
        String[] lines = code.split("\n");
        StringBuilder result = new StringBuilder();
        boolean skipping = false;
        for (String line : lines) {
            if (!skipping) {
                // 检测 if __name__ == "__main__": 或 if __name__ == '__main__':
                String trimmed = line.trim();
                if (trimmed.matches("if\\s+__name__\\s*==\\s*[\"']__main__[\"']\\s*:.*")) {
                    skipping = true;
                    continue; // 跳过这一行
                }
                result.append(line).append("\n");
            } else {
                // 跳过入口块内的所有行（缩进行和空行）
                // 入口块内的行通常是缩进的，遇到非缩进非空行时停止跳过
                if (!line.trim().isEmpty() && !line.startsWith(" ") && !line.startsWith("\t")) {
                    // 遇到新的顶级语句，停止跳过
                    skipping = false;
                    result.append(line).append("\n");
                }
                // 否则继续跳过
            }
        }
        return result.toString().trim();
    }

    private Map<String, Object> executePython(Path tmpDir, String code, String inputJson, int timeoutSeconds) throws Exception {
        // ★ 剥离 AI 生成代码中可能包含的 if __name__ == "__main__": 入口块
        String cleanCode = stripMainEntryBlock(code);

        // 包装代码：定义 main 函数 + 调用入口（通过 stdin 传参，兼容 skill_runner.py）
        String wrapper = cleanCode + "\n\n"
                + "import sys, json\n"
                + "try:\n"
                + "    stdin_data = sys.stdin.read()\n"
                + "    args = json.loads(stdin_data) if stdin_data.strip() else {}\n"
                + "    result = main(args)\n"
                + "    # 如果 main() 返回了 success: false 则直接透传，不再包一层成功\n"
                + "    if isinstance(result, dict) and result.get('success') is False:\n"
                + "        print(json.dumps(result))\n"
                + "    else:\n"
                + "        print(json.dumps({'success': True, 'output': result}))\n"
                + "except Exception as e:\n"
                + "    print(json.dumps({'success': False, 'error': str(e)}))\n";

        Path scriptFile = tmpDir.resolve("tool_script.py");
        Files.writeString(scriptFile, wrapper, StandardCharsets.UTF_8);

        // 使用 skill_runner.py 包装执行（自动安装缺失的 Python 依赖）
        String runnerPath = resolveRunnerPath();
        ProcessBuilder pb;
        if (runnerPath != null) {
            pb = new ProcessBuilder(resolvePythonCommand(), runnerPath, "--script", scriptFile.toString());
        } else {
            // 降级：直接执行（无自动安装）
            pb = new ProcessBuilder(resolvePythonCommand(), scriptFile.toString());
        }
        pb.directory(tmpDir.toFile());
        pb.redirectErrorStream(false);  // 分离 stdout 和 stderr

        Process process = pb.start();

        // 通过 stdin 传递参数
        try (java.io.OutputStream os = process.getOutputStream();
             java.io.Writer writer = new java.io.OutputStreamWriter(os, StandardCharsets.UTF_8)) {
            writer.write(inputJson);
            writer.flush();
        }

        boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        Map<String, Object> result = new HashMap<>();

        if (!finished) {
            process.destroyForcibly();
            result.put("success", false);
            result.put("error", "代码执行超时（" + timeoutSeconds + "秒）。如果涉及网络请求或大量计算，请考虑优化代码逻辑或拆分任务。");
            return result;
        }

        // 分别读取 stdout（JSON 输出）和 stderr（安装日志/错误信息）
        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = objectMapper.readValue(stdout, Map.class);
            return parsed;
        } catch (Exception e) {
            result.put("success", false);
            String errorDetail = stdout.substring(0, Math.min(500, stdout.length()));
            if (!stderr.isEmpty()) {
                errorDetail += "\nstderr: " + stderr.substring(0, Math.min(500, stderr.length()));
            }
            result.put("error", "无法解析代码输出: " + errorDetail);
            return result;
        }
    }

    /**
     * 解析 skill_runner.py 的路径。
     * 查找顺序：工作目录 → JAR 所在目录的上级（开发环境 backend/ 目录）→ JAR 同级目录
     * 返回绝对路径，以便 ProcessBuilder 可以在任意工作目录下找到该脚本。
     * 返回 null 表示未找到，调用方应降级为直接执行脚本。
     */
    private String resolveRunnerPath() {
        // 1. 当前工作目录
        Path p1 = java.nio.file.Paths.get("skill_runner.py");
        if (java.nio.file.Files.exists(p1)) {
            return p1.toAbsolutePath().toString();
        }

        // 2. JAR 所在目录的上级（开发环境：target/ → backend/）
        try {
            String jarPath = getClass().getProtectionDomain().getCodeSource().getLocation().getPath();
            Path jarFile = java.nio.file.Paths.get(jarPath);
            Path jarDir = jarFile.getParent();
            if (jarDir != null) {
                // 如果是 target/ 目录，尝试上级目录
                if ("target".equals(jarDir.getFileName().toString())) {
                    Path projectRoot = jarDir.getParent();
                    if (projectRoot != null) {
                        Path p2 = projectRoot.resolve("skill_runner.py");
                        if (java.nio.file.Files.exists(p2)) {
                            return p2.toAbsolutePath().toString();
                        }
                    }
                }
                // JAR 同级目录（生产环境：/opt/muhugochat/skill_runner.py）
                Path p3 = jarDir.resolve("skill_runner.py");
                if (java.nio.file.Files.exists(p3)) {
                    return p3.toAbsolutePath().toString();
                }
            }
        } catch (Exception ignored) {
            // 无法获取 JAR 路径，忽略
        }

        // 3. 硬编码的生产环境路径（兜底）
        Path p4 = java.nio.file.Paths.get("/opt/muhugochat/skill_runner.py");
        if (java.nio.file.Files.exists(p4)) {
            return p4.toAbsolutePath().toString();
        }

        return null;
    }

    private String resolvePythonCommand() {
        String configured = System.getProperty("workflow.python.command");
        if (configured != null && !configured.isBlank()) {
            return configured;
        }
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") ? "python" : "python3";
    }

    private Map<String, Object> executeJavaScript(Path tmpDir, String code, String inputJson, int timeoutSeconds) throws Exception {
        String wrapper = code + "\n\n"
                + "try {\n"
                + "  const args = JSON.parse(process.argv[2] || '{}');\n"
                + "  const result = main(args);\n"
                + "  // 如果 main() 返回了 success: false 则直接透传，不再包一层成功\n"
                + "  if (result && typeof result === 'object' && result.success === false) {\n"
                + "    console.log(JSON.stringify(result));\n"
                + "  } else {\n"
                + "    console.log(JSON.stringify({success: true, output: result}));\n"
                + "  }\n"
                + "} catch (e) {\n"
                + "  console.log(JSON.stringify({success: false, error: e.message}));\n"
                + "}\n";

        Path scriptFile = tmpDir.resolve("tool_script.js");
        Files.writeString(scriptFile, wrapper, StandardCharsets.UTF_8);

        ProcessBuilder pb = new ProcessBuilder("node", scriptFile.toString(), inputJson);
        pb.directory(tmpDir.toFile());
        pb.redirectErrorStream(true);

        Process process = pb.start();
        boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        Map<String, Object> result = new HashMap<>();

        if (!finished) {
            process.destroyForcibly();
            result.put("success", false);
            result.put("error", "代码执行超时（" + timeoutSeconds + "秒）。如果涉及网络请求或大量计算，请考虑优化代码逻辑或拆分任务。");
            return result;
        }

        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = objectMapper.readValue(output, Map.class);
            return parsed;
        } catch (Exception e) {
            result.put("success", false);
            result.put("error", "无法解析代码输出: " + output.substring(0, Math.min(500, output.length())));
            return result;
        }
    }
}
