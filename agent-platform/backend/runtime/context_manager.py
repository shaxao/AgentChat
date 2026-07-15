from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from runtime.session_events import append_event
from runtime.system_context import SYSTEM_CONTEXT_PATH, reconcile_context


DEFAULT_CONTEXT_FILES = (
    "SCRIPT_CONTRACT.md",
    "README.md",
)


@dataclass
class RuntimeContext:
    task_id: str
    workspace_id: str | None
    summary: str
    files: dict[str, str] = field(default_factory=dict)
    manifest: dict = field(default_factory=dict)
    changed_sources: list[str] = field(default_factory=list)
    epoch: int = 0
    recent_events: list[dict] = field(default_factory=list)
    recent_commands: list[dict] = field(default_factory=list)
    recent_snapshots: list[dict] = field(default_factory=list)

    def to_prompt(self, max_chars: int = 24_000) -> str:
        sections = [
            f"# AutoCode Runtime Context\n- task_id: {self.task_id}\n- workspace_id: {self.workspace_id or ''}",
            "## Summary\n" + (self.summary or "No summary available."),
        ]
        if self.manifest:
            sources = []
            for item in self.manifest.get("sources") or []:
                sources.append({
                    "path": item.get("path"),
                    "kind": item.get("kind"),
                    "sha256": str(item.get("sha256") or "")[:12],
                    "size": item.get("size"),
                    "priority": item.get("priority"),
                    "summary": item.get("summary"),
                })
            sections.append("## System Context Manifest\n" + json.dumps({
                "epoch": self.epoch,
                "manifest_path": self.manifest.get("manifest_path") or SYSTEM_CONTEXT_PATH,
                "changed_sources": self.changed_sources,
                "sources": sources,
            }, ensure_ascii=False, indent=2))
        if self.files:
            file_sections = []
            for path, content in self.files.items():
                file_sections.append(f"### {path}\n{content}")
            sections.append("## Explicit Work Files\n" + "\n\n".join(file_sections))
        if self.recent_commands:
            sections.append("## Recent Commands\n" + json.dumps(self.recent_commands[-10:], ensure_ascii=False, indent=2))
        if self.recent_snapshots:
            sections.append("## Recent Snapshots\n" + json.dumps(self.recent_snapshots[-10:], ensure_ascii=False, indent=2))
        if self.recent_events:
            slim_events = [
                {
                    "type": event.get("type"),
                    "source": event.get("source"),
                    "created_at": event.get("created_at"),
                    "payload": event.get("payload"),
                }
                for event in self.recent_events[-25:]
            ]
            sections.append("## Recent Events\n" + json.dumps(slim_events, ensure_ascii=False, indent=2))
        text = "\n\n".join(sections)
        return text[:max_chars]


class ContextManager:
    def _emit_context_events(self, task: dict, manifest: dict, changed_sources: list[str]) -> None:
        epoch = int(manifest.get("epoch") or 0)
        if epoch <= 0:
            return
        emitted = task.setdefault("_system_context_event_epochs", {})
        indexed_epoch = int(emitted.get("indexed") or 0)
        changed_epoch = int(emitted.get("changed") or 0)
        reconciled_epoch = int(emitted.get("reconciled") or 0)

        if indexed_epoch != epoch:
            append_event(
                task,
                "system_context_indexed",
                {
                    "epoch": epoch,
                    "source_count": len(manifest.get("sources") or []),
                    "manifest_path": manifest.get("manifest_path") or SYSTEM_CONTEXT_PATH,
                },
                source="context",
            )
            emitted["indexed"] = epoch
        if changed_sources and changed_epoch != epoch:
            append_event(
                task,
                "system_context_changed",
                {
                    "epoch": epoch,
                    "changed_count": len(changed_sources),
                    "changed_paths": changed_sources,
                    "manifest_path": manifest.get("manifest_path") or SYSTEM_CONTEXT_PATH,
                },
                source="context",
            )
            emitted["changed"] = epoch
        if reconciled_epoch != epoch:
            append_event(
                task,
                "system_context_reconciled",
                {
                    "epoch": epoch,
                    "changed_count": len(changed_sources),
                    "changed_paths": changed_sources,
                },
                source="context",
            )
            emitted["reconciled"] = epoch

    def build(
        self,
        *,
        task: dict,
        workspace_root: Path | None,
        include_files: Iterable[str] = DEFAULT_CONTEXT_FILES,
        max_file_chars: int = 4000,
    ) -> RuntimeContext:
        files: dict[str, str] = {}
        manifest: dict = {}
        changed_sources: list[str] = []
        if workspace_root:
            try:
                manifest = reconcile_context(
                    workspace_root,
                    workspace_id=task.get("workspace_id"),
                    task_id=str(task.get("id") or ""),
                )
                diff = manifest.get("last_diff") or {}
                changed_sources = list(diff.get("changed_paths") or [])
                task["system_context_epoch"] = manifest.get("epoch")
                self._emit_context_events(task, manifest, changed_sources)
            except Exception:
                manifest = {}
                changed_sources = []
            for rel in include_files:
                path = workspace_root / rel
                if not path.exists() or not path.is_file():
                    continue
                try:
                    files[rel] = path.read_text(encoding="utf-8", errors="replace")[:max_file_chars]
                except Exception:
                    continue

        summary_lines = [
            f"title: {task.get('title') or ''}",
            f"status: {task.get('status') or ''}",
            f"current_step: {task.get('current_step') or ''}",
            f"project_type: {task.get('project_type') or ''}",
            f"complexity: {task.get('complexity') or ''}",
            f"model: {task.get('model') or ''}",
        ]
        plan = task.get("plan")
        if isinstance(plan, dict):
            subtasks = plan.get("subtasks") or []
            summary_lines.append("subtasks: " + ", ".join(
                f"{st.get('id')}:{st.get('title')}:{st.get('status', 'pending')}"
                for st in subtasks[:20]
                if isinstance(st, dict)
            ))

        return RuntimeContext(
            task_id=str(task.get("id") or ""),
            workspace_id=task.get("workspace_id"),
            summary="\n".join(summary_lines),
            files=files,
            manifest=manifest,
            changed_sources=changed_sources,
            epoch=int(manifest.get("epoch") or 0),
            recent_events=list(task.get("events") or [])[-50:],
            recent_commands=list(task.get("command_history") or [])[-20:],
            recent_snapshots=list(task.get("auto_snapshots") or [])[-20:],
        )

    def should_compact(self, messages: list[dict], *, threshold_chars: int = 80_000) -> bool:
        total = 0
        for message in messages:
            total += len(str(message.get("content") or ""))
        return total >= threshold_chars

    def write_compaction_summary(
        self,
        workspace_root: Path,
        *,
        task_id: str,
        agent: str,
        messages: list[dict],
        max_chars: int = 20_000,
    ) -> Path:
        autocode = workspace_root / ".autocode"
        autocode.mkdir(parents=True, exist_ok=True)
        path = autocode / "CONTEXT_SUMMARY.md"
        recent = messages[-12:]
        lines = [
            f"# Context Summary",
            f"- task_id: {task_id}",
            f"- agent: {agent}",
            "",
            "## Recent Conversation",
        ]
        for item in recent:
            role = item.get("role", "unknown")
            content = str(item.get("content") or "")
            lines.append(f"### {role}\n{content[:2000]}")
        path.write_text("\n\n".join(lines)[:max_chars], encoding="utf-8")
        return path


context_manager = ContextManager()
