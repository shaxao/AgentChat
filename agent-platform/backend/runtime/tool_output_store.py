# -*- coding: utf-8 -*-
"""Bound large tool outputs and spill full content to workspace files.

The database and model context should carry concise previews, not unlimited
terminal output. Full output remains available through a workspace-relative path.
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Any


MAX_PREVIEW_CHARS = 12_000
MAX_MODEL_CHARS = 2_000
MAX_LINES = 400
RETENTION_SECONDS = 7 * 24 * 60 * 60
MANAGED_DIR = ".autocode/tool-output"


def _line_count(text: str) -> int:
    return text.count("\n") + (1 if text else 0)


def _bounded_preview(text: str, *, max_chars: int, max_lines: int) -> str:
    if not text:
        return ""
    lines = text.splitlines()
    if len(lines) > max_lines:
        head_count = max_lines // 2
        tail_count = max_lines - head_count
        text = "\n".join([
            *lines[:head_count],
            f"... output truncated: {len(lines) - max_lines} middle lines omitted ...",
            *lines[-tail_count:],
        ])
    if len(text) <= max_chars:
        return text
    head = max_chars // 2
    tail = max_chars - head
    omitted = len(text) - max_chars
    return text[:head] + f"\n... output truncated: {omitted} middle chars omitted ...\n" + text[-tail:]


def cleanup_tool_outputs(workspace_root: Path) -> None:
    directory = workspace_root / MANAGED_DIR
    if not directory.exists():
        return
    cutoff = time.time() - RETENTION_SECONDS
    for path in directory.glob("tool_*.txt"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue


def _registered_output_limits(
    tool_name: str,
    max_preview_chars: int | None,
    max_model_chars: int | None,
) -> tuple[int, int]:
    if max_preview_chars is not None and max_model_chars is not None:
        return max_preview_chars, max_model_chars
    try:
        from runtime.tool_registry import tool_registry

        spec = tool_registry.get(tool_name)
    except Exception:
        spec = None
    if max_preview_chars is None:
        max_preview_chars = spec.max_preview_chars if spec else MAX_PREVIEW_CHARS
    if max_model_chars is None:
        max_model_chars = spec.max_model_chars if spec else MAX_MODEL_CHARS
    return max_preview_chars, max_model_chars


def bound_tool_output(
    workspace_root: Path,
    output: Any,
    *,
    tool_name: str = "tool",
    max_preview_chars: int | None = None,
    max_model_chars: int | None = None,
    max_lines: int = MAX_LINES,
) -> dict[str, Any]:
    max_preview_chars, max_model_chars = _registered_output_limits(
        tool_name,
        max_preview_chars,
        max_model_chars,
    )
    text = "" if output is None else str(output)
    total_chars = len(text)
    total_lines = _line_count(text)
    total_bytes = len(text.encode("utf-8", errors="replace"))
    truncated = total_chars > max_preview_chars or total_lines > max_lines
    full_rel_path = ""
    sha = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest() if text else ""

    if truncated:
        directory = workspace_root / MANAGED_DIR
        directory.mkdir(parents=True, exist_ok=True)
        safe_tool = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in tool_name)[:40] or "tool"
        filename = f"tool_{int(time.time() * 1000)}_{safe_tool}_{sha[:12]}.txt"
        output_path = directory / filename
        output_path.write_text(text, encoding="utf-8", errors="replace")
        full_rel_path = f"{MANAGED_DIR}/{filename}"
        cleanup_tool_outputs(workspace_root)

    preview = _bounded_preview(text, max_chars=max_preview_chars, max_lines=max_lines)
    model_preview = _bounded_preview(text, max_chars=max_model_chars, max_lines=min(max_lines, 120))
    marker = ""
    if truncated:
        marker = f"\n\n[Full output saved to /workspace/{full_rel_path}; chars={total_chars}, lines={total_lines}, sha256={sha[:12]}]"
        preview = preview + marker
        model_preview = model_preview + marker

    return {
        "preview": preview,
        "model_preview": model_preview,
        "truncated": truncated,
        "full_path": full_rel_path,
        "sha256": sha,
        "chars": total_chars,
        "bytes": total_bytes,
        "lines": total_lines,
    }
