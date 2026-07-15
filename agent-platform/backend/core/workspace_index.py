from __future__ import annotations

import fnmatch
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SKIP_DIRS = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
}

SOURCE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte",
    ".java", ".kt", ".go", ".rs", ".php", ".rb", ".cs",
    ".css", ".scss", ".html", ".md", ".json", ".yaml", ".yml",
    ".toml", ".xml", ".sql", ".sh", ".ps1",
}

INDEX_DOCS = [
    ".autocode/PROJECT_PROFILE.md",
    ".autocode/PROJECT_MAP.md",
    ".autocode/MEMORY.md",
    ".autocode/SESSION_SUMMARY.md",
    ".autocode/CI_REPORT.md",
    ".autocode/REVIEW.md",
    ".autocode/COMMANDS.md",
]

INDEX_CACHE_VERSION = 1
INDEX_CACHE_PATH = ".autocode/WORKSPACE_INDEX.json"
INDEX_CACHE_TTL_SECONDS = 20
MAX_INDEX_FILES = 10_000
MAX_SEARCH_FILE_BYTES = 800_000


def _rel(path: Path, ws_path: Path) -> str:
    return str(path.relative_to(ws_path)).replace("\\", "/")


def _should_skip(rel_parts: tuple[str, ...]) -> bool:
    if any(part in SKIP_DIRS for part in rel_parts):
        return True
    if len(rel_parts) >= 2 and rel_parts[0] == ".autocode" and rel_parts[1] in {"tool-output", "prototype", "prototypes"}:
        return True
    if rel_parts == (".autocode", "WORKSPACE_INDEX.json"):
        return True
    return False


def invalidate_workspace_index(ws_path: Path) -> None:
    try:
        (ws_path / INDEX_CACHE_PATH).unlink(missing_ok=True)
    except OSError:
        pass


def build_workspace_index(ws_path: Path) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    top_dirs: list[str] = []
    if not ws_path.exists():
        return {
            "version": INDEX_CACHE_VERSION,
            "generated_at": time.time(),
            "files": files,
            "top_level_dirs": top_dirs,
            "total_file_count": 0,
            "source_file_count": 0,
        }

    for item in sorted(ws_path.iterdir(), key=lambda p: p.name.lower()):
        if item.is_dir() and item.name not in SKIP_DIRS:
            top_dirs.append(item.name)

    for path in ws_path.rglob("*"):
        if len(files) >= MAX_INDEX_FILES:
            break
        try:
            rel_parts = path.relative_to(ws_path).parts
        except ValueError:
            continue
        if _should_skip(rel_parts) or not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        suffix = path.suffix.lower()
        files.append({
            "path": _rel(path, ws_path),
            "name": path.name,
            "suffix": suffix,
            "size": int(stat.st_size),
            "mtime_ns": int(stat.st_mtime_ns),
            "is_source": suffix in SOURCE_EXTENSIONS,
            "is_index_doc": _rel(path, ws_path) in INDEX_DOCS,
        })

    index = {
        "version": INDEX_CACHE_VERSION,
        "generated_at": time.time(),
        "files": files,
        "top_level_dirs": top_dirs[:120],
        "total_file_count": len(files),
        "source_file_count": sum(1 for item in files if item.get("is_source")),
        "truncated": len(files) >= MAX_INDEX_FILES,
    }
    try:
        cache_path = ws_path / INDEX_CACHE_PATH
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return index


def load_workspace_index(ws_path: Path, *, force: bool = False, max_age_seconds: int = INDEX_CACHE_TTL_SECONDS) -> dict[str, Any]:
    cache_path = ws_path / INDEX_CACHE_PATH
    if not force and cache_path.exists():
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8", errors="replace"))
            age = time.time() - float(data.get("generated_at") or 0)
            if data.get("version") == INDEX_CACHE_VERSION and age <= max_age_seconds and isinstance(data.get("files"), list):
                return data
        except Exception:
            pass
    return build_workspace_index(ws_path)


def indexed_files(ws_path: Path, *, force: bool = False) -> list[dict[str, Any]]:
    return list(load_workspace_index(ws_path, force=force).get("files") or [])


def glob_workspace_files(ws_path: Path, pattern: str, *, limit: int = 100) -> list[str]:
    normalized = (pattern or "**/*").replace("\\", "/")
    matches: list[str] = []
    for item in indexed_files(ws_path):
        rel = str(item.get("path") or "")
        if fnmatch.fnmatch(rel, normalized):
            matches.append(rel)
            if len(matches) >= limit:
                break
    return matches


def search_workspace_code(ws_path: Path, pattern: str, *, glob_filter: str = "", limit: int = 50) -> list[str]:
    if not pattern:
        return []
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        regex = re.compile(re.escape(pattern), re.IGNORECASE)
    results: list[str] = []
    normalized_filter = (glob_filter or "").replace("\\", "/")
    for item in indexed_files(ws_path):
        rel = str(item.get("path") or "")
        if not rel or rel.startswith(".autocode/"):
            continue
        if normalized_filter and not fnmatch.fnmatch(rel, normalized_filter):
            continue
        if not item.get("is_source") and str(item.get("suffix") or "") not in {".txt", ".md"}:
            continue
        if int(item.get("size") or 0) > MAX_SEARCH_FILE_BYTES:
            continue
        fpath = ws_path / rel
        try:
            with fpath.open("r", encoding="utf-8", errors="ignore") as fh:
                for line_no, line in enumerate(fh, 1):
                    if regex.search(line):
                        results.append(f"{rel}:{line_no}: {line.rstrip()[:200]}")
                        if len(results) >= limit:
                            return results
        except OSError:
            continue
    return results


@dataclass
class RetrievalPlan:
    intent: str
    search_terms: list[str] = field(default_factory=list)
    candidate_files: list[str] = field(default_factory=list)
    index_docs: list[str] = field(default_factory=list)
    read_budget: int = 3
    rationale: list[str] = field(default_factory=list)
    total_files: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "intent": self.intent,
            "search_terms": self.search_terms,
            "candidate_files": self.candidate_files,
            "index_docs": self.index_docs,
            "read_budget": self.read_budget,
            "rationale": self.rationale,
            "total_files": self.total_files,
        }


def _iter_workspace_files(ws_path: Path) -> list[Path]:
    return [ws_path / str(item.get("path")) for item in indexed_files(ws_path) if item.get("path")]


def _tokenize(text: str) -> list[str]:
    raw = re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2,}", text or "")
    stop = {
        "当前", "项目", "继续", "修改", "这个", "那个", "还是", "这样",
        "功能", "问题", "一下", "需要", "用户", "文件", "代码",
        "the", "and", "for", "with", "this", "that", "you", "need",
    }
    terms: list[str] = []
    for item in raw:
        token = item.strip().lower()
        if token and token not in stop and token not in terms:
            terms.append(token)
    return terms[:12]


def is_actionable_development_request(message: str) -> bool:
    """Return True when a chat message contains concrete code-change instructions."""
    text = message or ""
    if not text.strip():
        return False
    action_words = (
        "修复", "处理", "添加", "增加", "实现", "统一", "改为", "改成",
        "检查", "补全", "支持", "删除", "重命名", "优化", "调整",
        "fix", "add", "implement", "support", "rename", "remove", "update",
    )
    code_markers = (
        "__main__", "parse_args", "validate", "filter_rows", "header_row",
        "args.", "def ", "class ", ".py", ".ts", ".tsx", ".js", ".java",
    )
    has_action = any(word.lower() in text.lower() for word in action_words)
    has_code_marker = any(marker.lower() in text.lower() for marker in code_markers)
    has_identifier = re.search(r"\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b", text) is not None
    has_many_lines = len([line for line in text.splitlines() if line.strip()]) >= 3
    return bool(has_action and (has_code_marker or has_identifier or has_many_lines))


def _changed_files_from_task(task: dict) -> list[str]:
    changed: list[str] = []
    for review in (task.get("phase_reviews") or []) + ([task.get("review")] if task.get("review") else []):
        if not isinstance(review, dict):
            continue
        artifacts = ((review.get("dimensions") or {}).get("phase_artifacts") or {})
        for file in artifacts.get("changed_files") or []:
            rel = str(file).replace("\\", "/").lstrip("/")
            if rel and rel not in changed:
                changed.append(rel)
    for entry in reversed(task.get("logs") or []):
        detail = str(entry.get("detail") or "")
        for match in re.findall(r"([A-Za-z0-9_./-]+\.(?:py|js|ts|tsx|md|json|yaml|yml|java|go|rs|css|html))", detail):
            rel = match.replace("\\", "/").lstrip("/")
            if rel and rel not in changed:
                changed.append(rel)
        if len(changed) >= 20:
            break
    return changed[:20]


def _score_file(path: Path, rel: str, terms: list[str], changed_files: list[str]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    lower_rel = rel.lower()
    basename = path.name.lower()

    if rel in changed_files:
        score += 12
        reasons.append("recently_changed")
    if rel.startswith(".autocode/"):
        score -= 100
    for term in terms:
        if term in lower_rel:
            score += 8
            reasons.append(f"path:{term}")
        elif term in basename:
            score += 5
            reasons.append(f"name:{term}")
    if path.suffix.lower() in {".py", ".ts", ".tsx", ".js", ".jsx"}:
        score += 2
    if basename in {"readme.md", "spec.md"}:
        score += 1

    if terms and path.suffix.lower() in SOURCE_EXTENSIONS:
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")[:200_000].lower()
        except Exception:
            content = ""
        if content:
            for term in terms:
                if term in content:
                    score += 7
                    reasons.append(f"content:{term}")
            for term in terms:
                if re.search(rf"\b(def|class)\s+{re.escape(term)}\b", content):
                    score += 10
                    reasons.append(f"symbol:{term}")

    return score, reasons


def plan_retrieval(ws_path: Path, message: str, task: dict, *, max_files: int = 3) -> RetrievalPlan:
    index = load_workspace_index(ws_path)
    files = [ws_path / str(item.get("path")) for item in index.get("files") or [] if item.get("path")]
    terms = _tokenize(message)
    actionable = is_actionable_development_request(message)
    if actionable:
        max_files = max(max_files, 6)
    changed_files = _changed_files_from_task(task)

    if not terms and changed_files:
        terms = _tokenize(" ".join(changed_files[:5]))

    scored: list[tuple[int, str, list[str]]] = []
    for path in files:
        rel = str(path.relative_to(ws_path)).replace("\\", "/")
        if path.suffix.lower() not in SOURCE_EXTENSIONS:
            continue
        score, reasons = _score_file(path, rel, terms, changed_files)
        if score > 0:
            scored.append((score, rel, reasons))

    scored.sort(key=lambda item: (-item[0], item[1]))
    candidate_files = [rel for _, rel, _ in scored[:max_files]]
    rationale = [f"{rel}: {', '.join(reasons[:4])}" for _, rel, reasons in scored[:max_files]]

    if not candidate_files:
        for rel in changed_files:
            if (ws_path / rel).exists() and (ws_path / rel).is_file():
                candidate_files.append(rel)
            if len(candidate_files) >= max_files:
                break

    existing_docs = [doc for doc in INDEX_DOCS if (ws_path / doc).exists()]
    intent = "continue_development"
    if re.search(r"(怎么用|如何使用|用法|usage|how to use)", message, re.I):
        intent = "usage_or_docs"
    elif re.search(r"(报错|失败|异常|error|failed|bug|fix)", message, re.I):
        intent = "fix_or_debug"
    elif re.search(r"(新增|增加|添加|支持|实现|add|implement|support)", message, re.I):
        intent = "feature_change"

    return RetrievalPlan(
        intent=intent,
        search_terms=terms,
        candidate_files=candidate_files[:max_files],
        index_docs=existing_docs,
        read_budget=max(max_files, len(candidate_files[:max_files])),
        rationale=rationale,
        total_files=len(files),
    )


def render_retrieval_plan(plan: RetrievalPlan) -> str:
    lines = [
        "# AutoCode Retrieval Plan",
        "",
        f"- intent: `{plan.intent}`",
        f"- total workspace files: {plan.total_files}",
        f"- source read budget: {plan.read_budget}",
        f"- search terms: {', '.join(plan.search_terms) if plan.search_terms else '(none)'}",
        "",
        "## Index Docs",
    ]
    lines.extend(f"- `{doc}`" for doc in plan.index_docs)
    lines.extend(["", "## Candidate Files"])
    if plan.candidate_files:
        lines.extend(f"- `{file}`" for file in plan.candidate_files)
    else:
        lines.append("- 未能从当前消息和历史变更中定位候选源码文件")
    if plan.rationale:
        lines.extend(["", "## Rationale"])
        lines.extend(f"- {item}" for item in plan.rationale)
    return "\n".join(lines) + "\n"
