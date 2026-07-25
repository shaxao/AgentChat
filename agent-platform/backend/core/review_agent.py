# -*- coding: utf-8 -*-
"""Artifact-aware quality review for AutoCode tasks."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterable

from core.execution_protocol import is_auxiliary_artifact, normalize_artifact_contracts

logger = logging.getLogger(__name__)

CODE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cxx", ".cs", ".dart", ".ex", ".exs", ".fs", ".fsx",
    ".go", ".groovy", ".h", ".hpp", ".html", ".java", ".js", ".jsx", ".kt",
    ".kts", ".lua", ".m", ".mm", ".php", ".pl", ".pm", ".py", ".r", ".rb",
    ".rs", ".scala", ".sh", ".sol", ".swift", ".ts", ".tsx", ".vue", ".zig",
}
TEXT_EXTENSIONS = CODE_EXTENSIONS | {
    ".css", ".csv", ".ini", ".json", ".md", ".rst", ".scss", ".sql", ".toml",
    ".txt", ".xml", ".yaml", ".yml",
}
SKIP_DIRS = {
    ".autocode", ".git", ".next", ".venv", "__pycache__", "build", "dist",
    "node_modules", "target", "venv",
}
EXTENSIONLESS_ARTIFACT_FILES = {
    "dockerfile", "gemfile", "license", "makefile", "procfile", "rakefile",
    "readme",
}


class ReviewResult:
    """Aggregated artifact review result."""

    def __init__(self):
        self.passed: bool = True
        self.score: int = 100
        self.issues: list[dict[str, Any]] = []
        self.summary: str = ""
        self.dimensions: dict[str, Any] = {}

    def add_issue(self, level: str, rule: str, file: str, message: str):
        self.issues.append({"level": level, "rule": rule, "file": file, "message": message})
        if level == "error":
            self.passed = False
            self.score = max(0, self.score - 20)
        elif level == "warn":
            self.score = max(0, self.score - 6)

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "score": self.score,
            "summary": self.summary,
            "issues": self.issues,
            "dimensions": self.dimensions,
        }


class ReviewAgent:
    """Review code and non-code artifacts against an open execution contract."""

    SENSITIVE_PATTERNS = [
        (r'(?i)(api[_\-]?key|secret|password|token|credential)\s*[=:]\s*["\'][\w\-/+]{8,}', "疑似硬编码敏感信息"),
        (r'(?i)sk-[a-zA-Z0-9]{20,}', "疑似 OpenAI API Key 泄露"),
        (r'(?i)AKIA[0-9A-Z]{16}', "疑似 AWS Access Key 泄露"),
        (r'(?i)-----BEGIN (RSA |EC )?PRIVATE KEY', "疑似私钥泄露"),
    ]
    SECURITY_PATTERNS = [
        (r"eval\s*\(", "warn", "使用 eval()，需确认输入不可被注入"),
        (r"pickle\.loads", "error", "pickle.loads 存在不安全反序列化风险"),
        (r"subprocess\.(call|run|Popen)|os\.system", "info", "执行系统命令，需确认输入边界"),
    ]

    def __init__(self, llm_client=None):
        self._llm = llm_client

    async def run(
        self,
        ws_path: Path,
        task_id: str,
        task_title: str,
        project_type: str = "unknown",
        log: Callable | None = None,
        *,
        execution_plan: dict[str, Any] | None = None,
        capability_profile: dict[str, Any] | None = None,
        changed_files: Iterable[str] | None = None,
        artifact_sources: dict[str, Any] | None = None,
    ) -> ReviewResult:
        log = log or (lambda *_args, **_kwargs: None)
        result = ReviewResult()
        plan = execution_plan or {}
        profile = capability_profile or {}
        contracts = normalize_artifact_contracts(
            plan.get("artifact_contracts") or [], intent=str(plan.get("intent") or "")
        )
        changed = [str(path) for path in (changed_files or []) if str(path).strip()]

        log("info", "产物审查已启动", "reviewer")
        await self._artifact_gate(
            ws_path,
            contracts,
            changed,
            profile,
            artifact_sources or {},
            result,
            log,
            execution_intent=str(plan.get("intent") or ""),
        )

        code_files = self._resolve_code_files(ws_path, contracts, changed)
        if code_files:
            await self._static_scan(ws_path, code_files, result, log)
            await self._ai_review(ws_path, task_title, plan, code_files, result, log)
        else:
            result.dimensions["static_scan"] = {"status": "not_applicable", "files_scanned": 0}
            result.dimensions["ai_review"] = {"status": "not_applicable", "reason": "no code artifact declared"}

        self._generate_summary(result)
        await self._write_review_file(ws_path, task_id, task_title, result)
        log(
            "success" if result.passed else "warn",
            f"产物审查{'通过' if result.passed else '未通过'}，评分 {result.score}/100",
            "reviewer",
        )
        return result

    async def _artifact_gate(
        self,
        ws_path: Path,
        contracts: list[dict[str, Any]],
        changed_files: list[str],
        capability_profile: dict[str, Any],
        artifact_sources: dict[str, Any],
        result: ReviewResult,
        log: Callable,
        execution_intent: str = "",
    ) -> None:
        local_unsynced = (
            str(capability_profile.get("artifact_source") or "") == "local_connector"
            or str(capability_profile.get("workspace_sync_status") or "").lower() not in {"", "synced", "workspace"}
        )
        checks: list[dict[str, Any]] = []
        verified_count = 0

        for contract in contracts:
            raw_path = str(contract.get("path") or "").strip()
            if not raw_path or is_auxiliary_artifact(raw_path):
                if contract.get("required", True):
                    result.add_issue("error", "artifact/invalid-contract", raw_path or ".", "目标产物路径为空或仅指向 AutoCode 辅助文件")
                continue
            path = self._resolve_artifact_path(ws_path, raw_path, artifact_sources)
            if path is None or not path.exists() or not path.is_file():
                if local_unsynced and self._matches_changed_evidence(raw_path, changed_files):
                    checks.append({"path": raw_path, "status": "verified_by_local_change_evidence", "source": "local_connector"})
                    verified_count += 1
                    continue
                semantic_label = self._looks_like_semantic_artifact_label(raw_path)
                if local_unsynced and semantic_label:
                    meaningful = self._meaningful_changed_files(changed_files)
                    if meaningful:
                        checks.append({
                            "path": raw_path,
                            "status": "verified_by_local_change_evidence",
                            "source": "local_connector",
                            "evidence": meaningful[:10],
                        })
                        verified_count += 1
                        continue
                    checks.append({
                        "path": raw_path,
                        "status": "deferred_semantic_contract",
                        "source": "local_connector",
                        "reason": "execution plan contract is a semantic label, not a cloud workspace path",
                    })
                    result.add_issue(
                        "info",
                        "artifact/local-semantic-contract",
                        raw_path,
                        "Execution plan artifact contract is a semantic label; cloud path verification deferred to local connector evidence.",
                    )
                    continue
                if semantic_label:
                    checks.append({
                        "path": raw_path,
                        "status": "semantic_contract_no_path",
                        "reason": "execution plan contract is a semantic label, not a file path",
                    })
                    result.add_issue(
                        "warn" if contract.get("required", True) else "info",
                        "artifact/non-path-contract",
                        raw_path,
                        "Execution plan artifact contract is not a file path; use changed files or explicit artifact paths for strict review.",
                    )
                    continue
                level = "error" if contract.get("required", True) else "warn"
                result.add_issue(level, "artifact/missing", raw_path, "未找到执行计划声明的目标产物")
                checks.append({"path": raw_path, "status": "missing"})
                continue

            check = self._validate_file(path, contract)
            check["path"] = raw_path
            checks.append(check)
            if check["status"] == "pass":
                verified_count += 1
            else:
                result.add_issue("error", check.get("rule", "artifact/invalid"), raw_path, check.get("message", "产物验证失败"))

        if not contracts:
            meaningful = [path for path in changed_files if not is_auxiliary_artifact(path)]
            if meaningful:
                verified_count = len(meaningful)
                checks.extend({"path": path, "status": "changed_file_evidence"} for path in meaningful[:100])
            elif str(execution_intent or "").lower() == "code_development":
                checks.append({
                    "status": "missing_change_evidence",
                    "reason": "code_development requires at least one non-AutoCode changed file",
                })
                result.add_issue(
                    "error",
                    "artifact/no-code-changes",
                    ".",
                    "Code-development review has no artifact contracts and no meaningful changed files.",
                )
            else:
                workspace_files = self._iter_workspace_files(ws_path)
                if workspace_files:
                    verified_count = len(workspace_files)
                    checks.append({"status": "workspace_evidence", "file_count": len(workspace_files)})
                elif local_unsynced:
                    checks.append({"status": "deferred_to_local_connector", "reason": "local project is not mirrored into workspace"})
                    result.add_issue("info", "artifact/local-source", ".", "本地产物未同步到云工作区，未执行云端文件存在性否决")
                else:
                    result.add_issue("error", "artifact/no-artifacts", ".", "未发现执行计划产物、有效变更或可审查文件")

        result.dimensions["artifacts"] = {
            "status": "pass" if not any(i["level"] == "error" and i["rule"].startswith("artifact/") for i in result.issues) else "fail",
            "declared_count": len(contracts),
            "verified_count": verified_count,
            "source": "local_connector" if local_unsynced else "workspace",
            "checks": checks,
        }
        log("info", f"产物合同验证完成：{verified_count}/{len(contracts) or verified_count}", "reviewer")

    def _resolve_artifact_path(self, ws_path: Path, raw_path: str, sources: dict[str, Any]) -> Path | None:
        mapped = sources.get(raw_path)
        if isinstance(mapped, str) and mapped.strip():
            return Path(mapped)
        candidate = Path(raw_path)
        if candidate.is_absolute():
            return candidate
        normalized = raw_path.replace("\\", "/").lstrip("/")
        if normalized.startswith("workspace/"):
            normalized = normalized[len("workspace/"):]
        return ws_path / normalized

    def _validate_file(self, path: Path, contract: dict[str, Any]) -> dict[str, Any]:
        try:
            size = path.stat().st_size
        except OSError as exc:
            return {"status": "fail", "rule": "artifact/unreadable", "message": str(exc)}
        minimum = int(contract.get("minimum_size") or 1)
        if size < minimum:
            return {"status": "fail", "rule": "artifact/empty", "message": f"文件大小 {size} 字节，低于要求 {minimum} 字节"}

        suffix = path.suffix.lower()
        kind = str(contract.get("kind") or "unknown").lower()
        try:
            if suffix in {".pptx", ".xlsx", ".docx"}:
                return self._validate_office_package(path, suffix, size)
            if suffix == ".pdf" or kind == "pdf":
                return self._validate_signature(path, b"%PDF-", size, "artifact/pdf-signature")
            if suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"} or kind == "image":
                return self._validate_image(path, size)
            if suffix == ".json":
                json.loads(path.read_text(encoding="utf-8-sig"))
                return {"status": "pass", "kind": "json", "size": size}
            if suffix in TEXT_EXTENSIONS or kind in {"code", "text", "document"}:
                path.read_text(encoding=str(contract.get("encoding") or "utf-8-sig"))
                return {"status": "pass", "kind": kind or "text", "size": size}
            with path.open("rb") as stream:
                signature = stream.read(32)
            return {"status": "pass", "kind": kind or "unknown", "size": size, "signature_hex": signature.hex()}
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
            return {"status": "fail", "rule": "artifact/unreadable", "message": f"文件无法按声明格式读取：{exc}"}

    def _validate_office_package(self, path: Path, suffix: str, size: int) -> dict[str, Any]:
        expected = {
            ".pptx": "ppt/presentation.xml",
            ".xlsx": "xl/workbook.xml",
            ".docx": "word/document.xml",
        }[suffix]
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or expected not in names:
                return {"status": "fail", "rule": "artifact/office-structure", "message": f"Office 包缺少 {expected} 或内容类型清单"}
        return {"status": "pass", "kind": suffix.lstrip("."), "size": size, "package_entry": expected}

    def _validate_signature(self, path: Path, expected: bytes, size: int, rule: str) -> dict[str, Any]:
        with path.open("rb") as stream:
            actual = stream.read(len(expected))
        if actual != expected:
            return {"status": "fail", "rule": rule, "message": "文件签名与声明格式不匹配"}
        return {"status": "pass", "size": size}

    def _validate_image(self, path: Path, size: int) -> dict[str, Any]:
        with path.open("rb") as stream:
            head = stream.read(16)
        valid = (
            head.startswith(b"\x89PNG\r\n\x1a\n")
            or head.startswith(b"\xff\xd8\xff")
            or head.startswith((b"GIF87a", b"GIF89a"))
            or head.startswith(b"BM")
            or (head.startswith(b"RIFF") and head[8:12] == b"WEBP")
        )
        if not valid:
            return {"status": "fail", "rule": "artifact/image-signature", "message": "无法识别图片文件签名"}
        return {"status": "pass", "kind": "image", "size": size}

    async def _static_scan(self, ws_path: Path, files: list[Path], result: ReviewResult, log: Callable) -> None:
        scanned = 0
        issue_count = 0
        for path in files[:500]:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            scanned += 1
            rel = self._relative_label(ws_path, path)
            for pattern, message in self.SENSITIVE_PATTERNS:
                if re.search(pattern, text):
                    result.add_issue("error", "security/secret", rel, message)
                    issue_count += 1
            for pattern, level, message in self.SECURITY_PATTERNS:
                if re.search(pattern, text):
                    result.add_issue(level, "security/pattern", rel, message)
                    issue_count += 1
        result.dimensions["static_scan"] = {"status": "done", "files_scanned": scanned, "issues": issue_count}
        log("info", f"代码静态扫描完成：{scanned} 个文件", "reviewer")

    async def _ai_review(self, ws_path: Path, task_title: str, plan: dict[str, Any], files: list[Path], result: ReviewResult, log: Callable) -> None:
        if not self._llm:
            result.dimensions["ai_review"] = {"status": "skip", "reason": "no LLM client"}
            return
        snippets: list[str] = []
        for path in files[:4]:
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[:220]
            except OSError:
                continue
            snippets.append(f"FILE: {self._relative_label(ws_path, path)}\n" + "\n".join(lines))
        if not snippets:
            result.dimensions["ai_review"] = {"status": "skip", "reason": "no readable code"}
            return
        prompt = (
            "你是严格的代码审查工程师。根据任务和源码片段返回 JSON，字段为 "
            "score(0-100), verdict(pass|warn|fail), concerns, suggestions。\n"
            f"任务：{task_title}\n任务类型：{plan.get('task_family') or 'unknown'}\n\n"
            + "\n\n".join(snippets)
        )
        try:
            response_text = ""
            if hasattr(self._llm, "stream"):
                async for chunk in self._llm.stream(messages=[{"role": "user", "content": prompt}], max_tokens=700, temperature=0.2):
                    response_text += chunk
            else:
                response = await self._llm.chat(messages=[{"role": "user", "content": prompt}], max_tokens=700, temperature=0.2)
                response_text = str(getattr(response, "content", response) or "")
            match = re.search(r"\{.*\}", response_text, re.DOTALL)
            if not match:
                result.dimensions["ai_review"] = {"status": "parse_error"}
                return
            data = json.loads(match.group())
            score = max(0, min(100, int(data.get("score", 80))))
            verdict = str(data.get("verdict") or "pass").lower()
            result.dimensions["ai_review"] = {"status": "done", **data, "score": score, "verdict": verdict}
            result.score = int(result.score * 0.75 + score * 0.25)
            if verdict == "fail":
                for concern in (data.get("concerns") or [])[:5]:
                    result.add_issue("warn", "ai-review/concern", "code", str(concern))
            log("info", f"AI 代码审查完成：{score}/100", "reviewer")
        except Exception as exc:
            result.dimensions["ai_review"] = {"status": "error", "reason": str(exc)}
            log("warn", f"AI 代码审查失败：{exc}", "reviewer")

    def _resolve_code_files(self, ws_path: Path, contracts: list[dict[str, Any]], changed_files: list[str]) -> list[Path]:
        candidates: list[Path] = []
        declared_code = any(str(item.get("kind") or "").lower() == "code" for item in contracts)
        paths = [str(item.get("path") or "") for item in contracts if str(item.get("kind") or "").lower() == "code"]
        paths.extend(changed_files)
        for raw in paths:
            path = Path(raw)
            if not path.is_absolute():
                path = ws_path / raw.replace("\\", "/").lstrip("/")
            if path.is_file() and (path.suffix.lower() in CODE_EXTENSIONS or declared_code):
                candidates.append(path)
        if declared_code and not candidates:
            candidates.extend(path for path in self._iter_workspace_files(ws_path) if path.suffix.lower() in CODE_EXTENSIONS)
        return list(dict.fromkeys(candidates))

    def _iter_workspace_files(self, ws_path: Path) -> list[Path]:
        if not ws_path.exists():
            return []
        files: list[Path] = []
        try:
            for path in ws_path.rglob("*"):
                if not path.is_file():
                    continue
                rel = path.relative_to(ws_path)
                if any(part in SKIP_DIRS for part in rel.parts) or is_auxiliary_artifact(rel.as_posix()):
                    continue
                files.append(path)
                if len(files) >= 2000:
                    break
        except OSError:
            pass
        return files

    def _matches_changed_evidence(self, raw_path: str, changed_files: list[str]) -> bool:
        expected = raw_path.replace("\\", "/").lower().lstrip("/")
        expected_name = expected.rsplit("/", 1)[-1]
        return any(
            item.replace("\\", "/").lower().lstrip("/") == expected
            or item.replace("\\", "/").lower().rsplit("/", 1)[-1] == expected_name
            for item in changed_files
        )

    def _meaningful_changed_files(self, changed_files: list[str]) -> list[str]:
        return [
            path for path in changed_files
            if str(path).strip() and not is_auxiliary_artifact(str(path))
        ]

    def _looks_like_semantic_artifact_label(self, raw_path: str) -> bool:
        normalized = str(raw_path or "").strip().replace("\\", "/").strip("/")
        if not normalized or "/" in normalized:
            return False
        if Path(normalized).suffix:
            return False
        if normalized.lower() in EXTENSIONLESS_ARTIFACT_FILES:
            return False
        # Slug-like extensionless names may be real files. Natural language or
        # CJK labels from plan subtasks are not usable cloud workspace paths.
        return not bool(re.fullmatch(r"[A-Za-z0-9_.-]+", normalized))

    def _relative_label(self, ws_path: Path, path: Path) -> str:
        try:
            return path.relative_to(ws_path).as_posix()
        except ValueError:
            return str(path)

    def _generate_summary(self, result: ReviewResult) -> None:
        errors = sum(1 for issue in result.issues if issue["level"] == "error")
        warns = sum(1 for issue in result.issues if issue["level"] == "warn")
        result.summary = f"综合评分 {result.score}/100 | {errors} 个错误 | {warns} 个警告"
        if errors == 0:
            result.summary += " | 未发现阻断问题"

    async def _write_review_file(self, ws_path: Path, task_id: str, task_title: str, result: ReviewResult) -> None:
        autocode_dir = ws_path / ".autocode"
        autocode_dir.mkdir(parents=True, exist_ok=True)
        lines = [
            "# 产物审查报告", "", f"任务：{task_title}", f"任务 ID：{task_id}",
            f"综合评分：{result.score}/100", f"审查结论：{'通过' if result.passed else '未通过'}", "", "## 问题", "",
        ]
        if result.issues:
            lines.extend(f"- [{item['level']}] {item['file']} ({item['rule']}) {item['message']}" for item in result.issues)
        else:
            lines.append("未发现问题。")
        lines.extend(["", "## 验证详情", "", json.dumps(result.dimensions, ensure_ascii=False, indent=2)])
        (autocode_dir / "REVIEW.md").write_text("\n".join(lines), encoding="utf-8")

    async def _run_command(self, command: list[str], ws_path: Path, result: ReviewResult, log: Callable, rule: str, fail_message: str) -> dict[str, Any]:
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        try:
            proc = await asyncio.to_thread(
                subprocess.run, command, cwd=str(ws_path), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=120, env=env,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            return {"status": "skip", "reason": str(exc)}
        output = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
        if proc.returncode != 0:
            result.add_issue("warn", rule, ".", f"{fail_message}: {output[:500]}")
            return {"status": "fail", "exit_code": proc.returncode, "output": output[:1200]}
        return {"status": "pass", "exit_code": 0}
