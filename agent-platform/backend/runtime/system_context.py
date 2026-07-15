from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


SYSTEM_CONTEXT_PATH = ".autocode/SYSTEM_CONTEXT.json"

DEFAULT_SYSTEM_CONTEXT_SOURCES: tuple[str, ...] = (
    ".autocode/PROJECT_PROFILE.md",
    ".autocode/PROJECT_MAP.md",
    ".autocode/COMMANDS.md",
    ".autocode/PLAN.md",
    ".autocode/MEMORY.md",
    ".autocode/SESSION_SUMMARY.md",
    ".autocode/CONTEXT_SUMMARY.md",
    ".autocode/CI_REPORT.md",
    ".autocode/REVIEW.md",
    ".autocode/RETRIEVAL_PLAN.md",
    ".autocode/UI_SPEC.md",
    ".autocode/prototypes/manifest.json",
    "SCRIPT_CONTRACT.md",
    "SPEC.md",
    "README.md",
)

SOURCE_PRIORITIES: dict[str, int] = {
    ".autocode/PROJECT_PROFILE.md": 10,
    ".autocode/PROJECT_MAP.md": 20,
    ".autocode/COMMANDS.md": 30,
    ".autocode/MEMORY.md": 40,
    ".autocode/SESSION_SUMMARY.md": 50,
    ".autocode/CONTEXT_SUMMARY.md": 55,
    ".autocode/CI_REPORT.md": 60,
    ".autocode/REVIEW.md": 65,
    ".autocode/RETRIEVAL_PLAN.md": 70,
    ".autocode/PLAN.md": 80,
    ".autocode/UI_SPEC.md": 82,
    ".autocode/prototypes/manifest.json": 84,
    "SCRIPT_CONTRACT.md": 90,
    "SPEC.md": 95,
    "README.md": 100,
}


@dataclass
class SystemContextDiff:
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)

    @property
    def changed_paths(self) -> list[str]:
        return [*self.added, *self.modified, *self.removed]

    def to_dict(self) -> dict[str, Any]:
        return {
            "added": self.added,
            "modified": self.modified,
            "removed": self.removed,
            "unchanged": self.unchanged,
            "changed_paths": self.changed_paths,
            "changed_count": len(self.changed_paths),
        }


def _utc_now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _source_kind(path: str) -> str:
    name = Path(path).name.lower()
    if name in {"ci_report.md", "review.md"}:
        return "verification"
    if name in {"memory.md", "session_summary.md", "context_summary.md"}:
        return "memory"
    if name in {"project_profile.md", "project_map.md", "commands.md", "retrieval_plan.md"}:
        return "index"
    if name in {"ui_spec.md", "manifest.json"} and ".autocode" in path:
        return "ui"
    if name in {"plan.md", "script_contract.md", "spec.md"}:
        return "plan"
    if name == "readme.md":
        return "docs"
    return "context"


def _summarize_text(text: str, *, max_chars: int = 600) -> str:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#") or line.startswith("-") or ":" in line:
            lines.append(line)
        if len("\n".join(lines)) >= max_chars:
            break
    if not lines:
        compact = " ".join(text.split())
        return compact[:max_chars]
    return "\n".join(lines)[:max_chars]


def _read_previous_manifest(workspace_root: Path) -> dict[str, Any]:
    path = workspace_root / SYSTEM_CONTEXT_PATH
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _source_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in manifest.get("sources") or []:
        if isinstance(item, dict) and item.get("path"):
            result[str(item["path"])] = item
    return result


def diff_manifest(previous: dict[str, Any] | None, current: dict[str, Any]) -> SystemContextDiff:
    previous_sources = _source_map(previous or {})
    current_sources = _source_map(current)
    diff = SystemContextDiff()
    for path, source in current_sources.items():
        old = previous_sources.get(path)
        if not old:
            diff.added.append(path)
        elif old.get("sha256") != source.get("sha256") or old.get("size") != source.get("size"):
            diff.modified.append(path)
        else:
            diff.unchanged.append(path)
    for path in previous_sources:
        if path not in current_sources:
            diff.removed.append(path)
    diff.added.sort()
    diff.modified.sort()
    diff.removed.sort()
    diff.unchanged.sort()
    return diff


def build_manifest(
    workspace_root: Path,
    *,
    workspace_id: str | None = None,
    task_id: str | None = None,
    sources: tuple[str, ...] | list[str] = DEFAULT_SYSTEM_CONTEXT_SOURCES,
    write: bool = True,
) -> dict[str, Any]:
    root = Path(workspace_root)
    previous = _read_previous_manifest(root)
    source_items: list[dict[str, Any]] = []

    for rel in sources:
        path = root / rel
        if not path.exists() or not path.is_file():
            continue
        try:
            raw = path.read_bytes()
            text = raw.decode("utf-8", errors="replace")
            stat = path.stat()
        except Exception:
            continue
        source_items.append({
            "path": rel.replace("\\", "/"),
            "kind": _source_kind(rel),
            "sha256": _sha256_bytes(raw),
            "mtime_ns": int(stat.st_mtime_ns),
            "size": int(stat.st_size),
            "priority": int(SOURCE_PRIORITIES.get(rel, 500)),
            "summary": _summarize_text(text),
        })

    source_items.sort(key=lambda item: (item["priority"], item["path"]))
    draft = {
        "version": 1,
        "epoch": int(previous.get("epoch") or 0),
        "generated_at": _utc_now(),
        "workspace_id": workspace_id,
        "task_id": task_id,
        "manifest_path": SYSTEM_CONTEXT_PATH,
        "sources": source_items,
        "last_diff": {},
    }
    diff = diff_manifest(previous, draft)
    if diff.changed_paths or not previous:
        draft["epoch"] = int(previous.get("epoch") or 0) + 1
    draft["last_diff"] = diff.to_dict()

    if write:
        manifest_path = root / SYSTEM_CONTEXT_PATH
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
    return draft


def reconcile_context(
    workspace_root: Path,
    *,
    workspace_id: str | None = None,
    task_id: str | None = None,
    write: bool = True,
) -> dict[str, Any]:
    return build_manifest(
        workspace_root,
        workspace_id=workspace_id,
        task_id=task_id,
        write=write,
    )
