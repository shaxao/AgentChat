# -*- coding: utf-8 -*-
"""
AutoCode review agent.

The reviewer is a hard quality gate. It must not approve an empty workspace or
an execution phase with no meaningful artifacts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)


SOURCE_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".java", ".vue",
    ".html", ".css", ".scss", ".sass", ".md", ".json", ".yaml", ".yml",
}
CODE_EXTENSIONS = {
    ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".java", ".vue",
    ".html", ".css", ".scss", ".sass",
}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "__pycache__", ".autocode", "venv", ".venv"}


class ReviewResult:
    """Aggregated code review result."""

    def __init__(self):
        self.passed: bool = True
        self.score: int = 100
        self.issues: list[dict] = []
        self.summary: str = ""
        self.dimensions: dict[str, Any] = {}

    def add_issue(self, level: str, rule: str, file: str, message: str):
        self.issues.append({"level": level, "rule": rule, "file": file, "message": message})
        if level == "error":
            self.passed = False
            self.score = max(0, self.score - 20)
        elif level == "warn":
            self.score = max(0, self.score - 6)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "score": self.score,
            "summary": self.summary,
            "issues": self.issues,
            "dimensions": self.dimensions,
        }


class ReviewAgent:
    """Code review agent called by AgentOrchestrator after phases/final build."""

    SENSITIVE_PATTERNS = [
        (r'(?i)(api[_\-]?key|secret|password|token|credential)\s*[=:]\s*["\'][\w\-/+]{8,}', "疑似硬编码敏感信息"),
        (r'(?i)sk-[a-zA-Z0-9]{20,}', "疑似 OpenAI API Key 泄露"),
        (r'(?i)AKIA[0-9A-Z]{16}', "疑似 AWS Access Key 泄露"),
        (r'(?i)-----BEGIN (RSA |EC )?PRIVATE KEY', "疑似私钥泄露"),
    ]

    SECURITY_PATTERNS = [
        (r'eval\s*\(', "warn", "使用 eval()，存在代码注入风险"),
        (r'innerHTML\s*=\s*[^"\'`]', "warn", "动态写入 innerHTML，需确认已做转义"),
        (r'dangerouslySetInnerHTML', "info", "使用 dangerouslySetInnerHTML，请确认输入可信或已净化"),
        (r'subprocess\.call|os\.system', "warn", "直接执行系统命令，需确认输入不可被注入"),
        (r'pickle\.loads', "error", "pickle.loads 存在反序列化安全风险"),
    ]

    PERFORMANCE_PATTERNS = [
        (r'console\.log\(', "info", "生产代码中包含 console.log"),
        (r'TODO|FIXME|HACK', "info", "包含待办标记，需确认不影响交付"),
        (r'\.forEach\(.*\.forEach\(', "warn", "嵌套遍历可能造成性能问题"),
    ]

    def __init__(self, llm_client=None):
        self._llm = llm_client

    async def run(
        self,
        ws_path: Path,
        task_id: str,
        task_title: str,
        project_type: str,
        log: Callable,
    ) -> ReviewResult:
        result = ReviewResult()
        log("info", "代码审查 Agent 启动", "reviewer")

        await self._artifact_gate(ws_path, project_type, result, log)
        await self._static_scan(ws_path, result, log)
        await self._file_quality_check(ws_path, result, log)
        await self._toolchain_check(ws_path, project_type, result, log)
        await self._ai_review(ws_path, task_title, project_type, result, log)

        self._generate_summary(result)
        await self._write_review_file(ws_path, task_id, task_title, result)

        if result.passed:
            log("success", f"代码审查通过，综合评分：{result.score}/100", "reviewer")
        else:
            errors = [i for i in result.issues if i["level"] == "error"]
            log("warn", f"代码审查未通过：{len(errors)} 个错误，评分 {result.score}/100", "reviewer")

        return result

    async def _artifact_gate(self, ws_path: Path, project_type: str, result: ReviewResult, log: Callable):
        files = self._iter_review_files(ws_path, SOURCE_EXTENSIONS)
        code_files = [f for f in files if f.suffix in CODE_EXTENSIONS]
        result.dimensions["artifacts"] = {
            "source_files": len(files),
            "code_files": len(code_files),
            "sample_files": [str(f.relative_to(ws_path)) for f in files[:30]],
        }
        if not files:
            result.add_issue(
                "error",
                "review/no-artifacts",
                ".",
                "工作区没有可审查文件，不能通过代码审查。",
            )
            result.score = min(result.score, 10)
        elif not code_files and self._expects_code(project_type):
            result.add_issue(
                "error",
                "review/no-code-files",
                ".",
                "当前任务类型需要代码产物，但工作区没有发现源码文件。",
            )
            result.score = min(result.score, 25)
        log("info", f"产物检查: {len(files)} 个可审查文件，{len(code_files)} 个源码文件", "reviewer")

    async def _static_scan(self, ws_path: Path, result: ReviewResult, log: Callable):
        scanned = 0
        security_issues = 0
        performance_issues = 0

        for file in self._iter_review_files(ws_path, CODE_EXTENSIONS):
            try:
                content = file.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue

            scanned += 1
            rel = str(file.relative_to(ws_path))

            for pattern, label in self.SENSITIVE_PATTERNS:
                if re.search(pattern, content):
                    result.add_issue("error", "security/sensitive-data", rel, label)
                    security_issues += 1

            for pattern, level, message in self.SECURITY_PATTERNS:
                if re.search(pattern, content):
                    result.add_issue(level, "security/pattern", rel, message)
                    if level in ("error", "warn"):
                        security_issues += 1

            for pattern, level, message in self.PERFORMANCE_PATTERNS:
                if re.search(pattern, content):
                    result.add_issue(level, "quality/pattern", rel, message)
                    if level == "warn":
                        performance_issues += 1

        result.dimensions["static_scan"] = {
            "files_scanned": scanned,
            "security_issues": security_issues,
            "performance_issues": performance_issues,
        }
        log("info", f"静态扫描: {scanned} 文件，安全:{security_issues}，性能:{performance_issues}", "reviewer")

    async def _file_quality_check(self, ws_path: Path, result: ReviewResult, log: Callable):
        large_files = []
        very_large_files = []

        for file in self._iter_review_files(ws_path, SOURCE_EXTENSIONS):
            try:
                size_kb = file.stat().st_size / 1024
            except OSError:
                continue
            if size_kb <= 500:
                continue
            rel = str(file.relative_to(ws_path))
            large_files.append(rel)
            if size_kb > 2048:
                very_large_files.append(rel)
                result.add_issue("error", "quality/very-large-file", rel, f"文件过大 ({size_kb:.0f}KB)，需要拆分或移出源码产物")
            else:
                result.add_issue("warn", "quality/large-file", rel, f"文件较大 ({size_kb:.0f}KB)，可能影响维护和加载")

        result.dimensions["file_quality"] = {
            "large_files": large_files,
            "very_large_files": very_large_files,
        }
        log("info", f"文件检查: {len(large_files)} 个大文件", "reviewer")

    async def _toolchain_check(self, ws_path: Path, project_type: str, result: ReviewResult, log: Callable):
        tool_results: dict[str, Any] = {}

        if project_type in ("nextjs", "react", "vue") and (ws_path / "package.json").exists():
            package_text = (ws_path / "package.json").read_text(encoding="utf-8", errors="ignore")
            has_tsconfig = (ws_path / "tsconfig.json").exists()
            if has_tsconfig:
                tool_results["typescript"] = await self._run_command(
                    ["npx", "tsc", "--noEmit", "--skipLibCheck"],
                    ws_path,
                    result,
                    "typescript/type-check",
                    "TypeScript 类型检查未通过",
                    log,
                    timeout=60,
                )
            if '"build"' not in package_text:
                result.add_issue("info", "toolchain/no-build-script", "package.json", "package.json 未定义 build 脚本，已跳过构建脚本审查")

        if project_type == "python":
            py_files = [str(f) for f in self._iter_review_files(ws_path, {".py"})[:40]]
            if py_files:
                tool_results["python"] = await self._run_command(
                    ["python", "-m", "py_compile", *py_files],
                    ws_path,
                    result,
                    "python/syntax",
                    "Python 语法检查未通过",
                    log,
                    timeout=30,
                )

        result.dimensions["toolchain"] = tool_results

    async def _run_command(
        self,
        command: list[str],
        cwd: Path,
        result: ReviewResult,
        rule: str,
        fail_message: str,
        log: Callable,
        timeout: int,
    ) -> dict[str, Any]:
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                command,
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except Exception as exc:
            log("info", f"工具链检查跳过: {command[0]} ({exc})", "reviewer")
            return {"status": "skip", "reason": str(exc)}

        output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            result.add_issue("warn", rule, ".", f"{fail_message}: {output[:500]}")
            log("warn", f"工具链检查失败: {' '.join(command[:3])}", "reviewer")
            return {"status": "fail", "exit_code": proc.returncode, "output": output[:1200]}

        log("info", f"工具链检查通过: {' '.join(command[:3])}", "reviewer")
        return {"status": "pass"}

    async def _ai_review(
        self,
        ws_path: Path,
        task_title: str,
        project_type: str,
        result: ReviewResult,
        log: Callable,
    ):
        if not self._llm:
            result.dimensions["ai_review"] = {"status": "skip", "reason": "no LLM client"}
            log("info", "AI 综合评审: 跳过（无 LLM 客户端）", "reviewer")
            return

        core_files = []
        for file in self._iter_review_files(ws_path, CODE_EXTENSIONS):
            try:
                lines = file.read_text(encoding="utf-8", errors="ignore").splitlines()
            except Exception:
                continue
            if 5 <= len(lines) <= 600:
                core_files.append((file, lines[:220]))
            if len(core_files) >= 4:
                break

        if not core_files:
            result.dimensions["ai_review"] = {"status": "skip", "reason": "no suitable code files"}
            return

        snippets = []
        for file, lines in core_files:
            rel = file.relative_to(ws_path).as_posix()
            snippets.append(f"### {rel}\n```\n" + "\n".join(lines) + "\n```")

        prompt = f"""你是一名严格的代码审查工程师。请审查以下 AutoCode 产物。

任务: {task_title}
项目类型: {project_type}

{chr(10).join(snippets)}

只返回 JSON:
{{
  "score": 0到100的整数,
  "verdict": "pass|warn|fail",
  "strengths": ["优点"],
  "concerns": ["问题"],
  "suggestions": ["建议"]
}}"""

        try:
            response_text = ""
            if hasattr(self._llm, "stream"):
                async for chunk in self._llm.stream(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=700,
                    temperature=0.2,
                ):
                    response_text += chunk
            else:
                response = await self._llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=700,
                    temperature=0.2,
                )
                response_text = str(getattr(response, "content", response) or "")

            json_match = re.search(r"\{.*\}", response_text, re.DOTALL)
            if not json_match:
                result.dimensions["ai_review"] = {"status": "parse_error", "raw": response_text[:300]}
                log("warn", "AI 综合评审: 响应解析失败", "reviewer")
                return

            ai_data = json.loads(json_match.group())
            ai_score = int(ai_data.get("score", 80))
            verdict = str(ai_data.get("verdict", "pass")).lower()
            result.dimensions["ai_review"] = {
                "status": "done",
                "score": ai_score,
                "verdict": verdict,
                "strengths": ai_data.get("strengths", []),
                "concerns": ai_data.get("concerns", []),
                "suggestions": ai_data.get("suggestions", []),
            }
            result.score = int(result.score * 0.75 + ai_score * 0.25)
            if verdict == "fail":
                for concern in ai_data.get("concerns", [])[:5]:
                    result.add_issue("warn", "ai-review/concern", "core", str(concern))
            log("info", f"AI 综合评审: {ai_score}/100, {verdict}", "reviewer")
        except Exception as exc:
            result.dimensions["ai_review"] = {"status": "error", "reason": str(exc)}
            log("warn", f"AI 综合评审异常: {exc}", "reviewer")

    def _generate_summary(self, result: ReviewResult):
        errors = [i for i in result.issues if i["level"] == "error"]
        warns = [i for i in result.issues if i["level"] == "warn"]
        infos = [i for i in result.issues if i["level"] == "info"]

        parts = [f"综合评分 {result.score}/100"]
        if errors:
            parts.append(f"{len(errors)} 个错误")
        if warns:
            parts.append(f"{len(warns)} 个警告")
        if infos:
            parts.append(f"{len(infos)} 个提示")
        if not errors and not warns:
            parts.append("未发现阻断问题")
        result.summary = " | ".join(parts)

    async def _write_review_file(self, ws_path: Path, task_id: str, task_title: str, result: ReviewResult):
        autocode_dir = ws_path / ".autocode"
        autocode_dir.mkdir(parents=True, exist_ok=True)

        lines = [
            "# 代码审查报告",
            "",
            f"**任务**: {task_title}",
            f"**任务 ID**: {task_id}",
            f"**综合评分**: {result.score}/100",
            f"**审查结论**: {'通过' if result.passed else '未通过'}",
            "",
            "## 问题汇总",
            "",
        ]

        grouped = {
            "错误": [i for i in result.issues if i["level"] == "error"],
            "警告": [i for i in result.issues if i["level"] == "warn"],
            "提示": [i for i in result.issues if i["level"] == "info"],
        }
        for title, issues in grouped.items():
            if not issues:
                continue
            lines.append(f"### {title}")
            for issue in issues:
                lines.append(f"- `{issue['file']}` [{issue['rule']}] {issue['message']}")
            lines.append("")

        if not result.issues:
            lines.extend(["未发现问题。", ""])

        ai = result.dimensions.get("ai_review", {})
        if ai.get("status") == "done":
            lines.extend([
                "## AI 综合评审",
                "",
                f"**评分**: {ai.get('score')}/100",
                f"**结论**: {ai.get('verdict')}",
                "",
            ])
            if ai.get("strengths"):
                lines.append("**优点**:")
                lines.extend(f"- {item}" for item in ai["strengths"])
                lines.append("")
            if ai.get("suggestions"):
                lines.append("**改进建议**:")
                lines.extend(f"- {item}" for item in ai["suggestions"])
                lines.append("")

        artifacts = result.dimensions.get("artifacts", {})
        static = result.dimensions.get("static_scan", {})
        phase_artifacts = result.dimensions.get("phase_artifacts", {})
        lines.extend([
            "## 扫描统计",
            "",
            f"- 可审查文件: {artifacts.get('source_files', 0)}",
            f"- 源码文件: {artifacts.get('code_files', 0)}",
            f"- 静态扫描文件: {static.get('files_scanned', 0)}",
            f"- 安全问题: {static.get('security_issues', 0)}",
            f"- 性能问题: {static.get('performance_issues', 0)}",
        ])
        if phase_artifacts:
            lines.append(f"- 本阶段变更文件: {phase_artifacts.get('changed_count', 0)}")

        ci = result.dimensions.get("ci", {})
        if ci:
            lines.extend([
                "",
                "## CI / Validation",
                "",
                f"- Status: {ci.get('status')}",
                f"- Command: `{ci.get('command') or '(none)'}`",
                f"- Exit code: {ci.get('exit_code')}",
                f"- Report: `.autocode/CI_REPORT.md`",
            ])

        (autocode_dir / "REVIEW.md").write_text("\n".join(lines), encoding="utf-8")

    def _iter_review_files(self, ws_path: Path, extensions: set[str]) -> list[Path]:
        if not ws_path.exists():
            return []
        files = []
        for file in ws_path.rglob("*"):
            if not file.is_file():
                continue
            try:
                rel = file.relative_to(ws_path)
            except ValueError:
                continue
            if any(part in SKIP_DIRS for part in rel.parts):
                continue
            if file.suffix.lower() in extensions:
                files.append(file)
        return sorted(files, key=lambda p: p.as_posix())

    def _expects_code(self, project_type: str) -> bool:
        return project_type not in {"markdown", "docs", "document", "research"}
