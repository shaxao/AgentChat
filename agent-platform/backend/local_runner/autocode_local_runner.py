#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoCode Local Runner.

Usage:
  pip install websockets
  python autocode-local-runner.py --server https://example.com/autocode-api --session lr_xxx --token xxx --project D:\\your\\project

The runner only reads/writes inside --project. It connects outbound to the
AutoCode backend and executes tool requests after applying .autocodeignore.
"""
from __future__ import annotations

import argparse
import asyncio
import fnmatch
import hashlib
import json
import locale
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    import websockets
except ImportError:
    print("缺少依赖：websockets。请先执行：pip install websockets", file=sys.stderr)
    raise


VERSION = "0.2.1"
DEFAULT_IGNORES = [
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "__pycache__/",
    ".venv/",
    "venv/",
    ".env",
    ".env.*",
    "*.log",
    "*.tmp",
    "*.cache",
    "*.pyc",
]


def to_ws_url(server: str, session: str, token: str) -> str:
    parsed = urlparse(server)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    netloc = parsed.netloc or parsed.path
    prefix = parsed.path.rstrip("/")
    if prefix.endswith("/api/local-runner"):
        base_path = prefix
    elif prefix.endswith("/api"):
        base_path = f"{prefix}/local-runner"
    else:
        base_path = f"{prefix}/api/local-runner"
    return f"{scheme}://{netloc}{base_path}/ws/{session}?token={token}"


def load_ignore_patterns(root: Path) -> list[str]:
    patterns = list(DEFAULT_IGNORES)
    ignore_file = root / ".autocodeignore"
    if ignore_file.exists():
        for raw in ignore_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line.replace("\\", "/"))
    return patterns


def is_ignored(rel: str, patterns: list[str]) -> bool:
    normalized = rel.replace("\\", "/").lstrip("/")
    for pattern in patterns:
        p = pattern.strip().replace("\\", "/").lstrip("/")
        if not p:
            continue
        if p.endswith("/") and (normalized == p[:-1] or normalized.startswith(p)):
            return True
        if fnmatch.fnmatch(normalized, p):
            return True
    return False


def safe_path(root: Path, raw_path: str, patterns: list[str], must_exist: bool = False) -> Path:
    raw_original = (raw_path or "").strip()
    raw_norm = raw_original.replace("\\", "/")
    if raw_norm.startswith("/workspace/"):
        raw = raw_norm[len("/workspace/"):].lstrip("/")
        target = (root / raw).resolve(strict=must_exist)
    else:
        candidate = Path(raw_original)
        if candidate.is_absolute():
            target = candidate.resolve(strict=must_exist)
        else:
            raw = raw_norm.lstrip("/")
            target = (root / raw).resolve(strict=must_exist)
    try:
        rel = target.relative_to(root)
    except ValueError as exc:
        raise PermissionError("路径超出了授权项目目录") from exc
    rel_text = rel.as_posix()
    if rel_text and is_ignored(rel_text, patterns):
        raise PermissionError(f"路径被 .autocodeignore 忽略：{rel_text}")
    return target


def atomic_write_text(path: Path, content: str, *, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass


def read_file(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=True)
    if not path.is_file():
        raise ValueError("目标不是文件")
    limit = int(args.get("limit") or 20000)
    return {"ok": True, "result": path.read_text(encoding="utf-8", errors="replace")[:max(1, limit)]}


def read_lines(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=True)
    if not path.is_file():
        raise ValueError("target is not a file")
    start = max(1, int(args.get("start") or 1))
    end = max(start, int(args.get("end") or start))
    max_lines = 240
    if end - start + 1 > max_lines:
        end = start + max_lines - 1
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    selected = lines[start - 1:min(end, total)]
    width = max(len(str(min(end, total))), len(str(start)), 3)
    body = "\n".join(f"{idx:>{width}} | {line}" for idx, line in enumerate(selected, start=start))
    if not body:
        body = "(no lines in requested range)"
    display_end = min(end, total) if total else 0
    if start > total:
        display_end = total
    rel = path.relative_to(root).as_posix()
    return {
        "ok": True,
        "result": f"[OK] {rel} lines {start}-{display_end} of {total}\n{body}",
        "path": rel,
        "start": start,
        "end": display_end,
        "total_lines": total,
    }


def write_file(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=False)
    content = str(args.get("content") or "")
    atomic_write_text(path, content)
    rel = path.relative_to(root).as_posix()
    return {
        "ok": True,
        "result": f"[OK] 文件已写入：{rel}",
        "path": rel,
        "content": path.read_text(encoding="utf-8", errors="replace"),
    }


def _normalize_text_encoding(value: str) -> str:
    encoding = (value or "utf-8").strip().lower().replace("_", "-")
    allowed = {"utf-8", "utf-8-sig"}
    if encoding not in allowed:
        raise ValueError("local text file tools only support utf-8 or utf-8-sig")
    return encoding


def local_write_text_file(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=False)
    content = str(args.get("content") or "")
    encoding = _normalize_text_encoding(str(args.get("encoding") or "utf-8"))
    atomic_write_text(path, content, encoding=encoding)
    data = path.read_text(encoding=encoding, errors="replace")
    rel = path.relative_to(root).as_posix()
    return {
        "ok": True,
        "result": f"[OK] text file written: {rel}",
        "path": rel,
        "absolute_path": str(path),
        "content": data,
        "encoding": encoding,
        "size": path.stat().st_size,
    }


def local_read_text_file(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=True)
    if not path.is_file():
        raise ValueError("target is not a file")
    encoding = _normalize_text_encoding(str(args.get("encoding") or "utf-8"))
    content = path.read_text(encoding=encoding, errors="replace")
    rel = path.relative_to(root).as_posix()
    return {
        "ok": True,
        "result": content,
        "path": rel,
        "absolute_path": str(path),
        "content": content,
        "encoding": encoding,
        "size": path.stat().st_size,
    }


def apply_patch_tool(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    path = safe_path(root, str(args.get("path") or ""), patterns, must_exist=True)
    search = str(args.get("search") or "")
    replace = str(args.get("replace") or "")
    if not search:
        raise ValueError("apply_patch 需要 search 参数")
    text = path.read_text(encoding="utf-8", errors="replace")
    if search not in text:
        raise ValueError("未找到要替换的文本")
    atomic_write_text(path, text.replace(search, replace, 1))
    rel = path.relative_to(root).as_posix()
    return {
        "ok": True,
        "result": f"[OK] 已修改：{rel}",
        "path": rel,
        "content": path.read_text(encoding="utf-8", errors="replace"),
    }


_CODE_EDITOR_UNDO: dict[str, list[str | None]] = {}
_CODE_EDITOR_UNDO_LIMIT = 20
_CODE_EDITOR_DIFF_LIMIT = 4000


def _code_editor_push_undo(key: str, old_text: str | None) -> None:
    stack = _CODE_EDITOR_UNDO.setdefault(key, [])
    stack.append(old_text)
    if len(stack) > _CODE_EDITOR_UNDO_LIMIT:
        del stack[0]


def _unified_diff_text(old: str, new: str, rel_path: str) -> str:
    import difflib

    diff_lines = list(difflib.unified_diff(
        old.splitlines(), new.splitlines(),
        fromfile=f"a/{rel_path}", tofile=f"b/{rel_path}", lineterm="", n=3,
    ))
    if not diff_lines:
        return "(无内容差异)"
    out = "\n".join(diff_lines)
    if len(out) > _CODE_EDITOR_DIFF_LIMIT:
        out = out[:_CODE_EDITOR_DIFF_LIMIT] + "\n... (diff 已截断)"
    return out


def code_editor(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    command = str(args.get("command") or "").strip()
    raw_path = str(args.get("path") or "")
    undo_key = f"{root}::{raw_path.strip().lstrip('/')}"

    if command == "view":
        path = safe_path(root, raw_path, patterns, must_exist=True)
        if not path.is_file():
            raise ValueError("目标不是文件")
        all_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        start, end = 1, len(all_lines)
        view_range = args.get("view_range")
        if isinstance(view_range, (list, tuple)) and len(view_range) == 2:
            start = max(1, int(view_range[0]))
            end = min(len(all_lines), int(view_range[1]))
        numbered = "\n".join(f"{i:>6}\t{all_lines[i - 1]}" for i in range(start, end + 1))
        rel = path.relative_to(root).as_posix()
        return {"ok": True, "result": f"[OK] {rel} 第 {start}-{end} 行（共 {len(all_lines)} 行）:\n{numbered}", "path": rel}

    if command == "create":
        path = safe_path(root, raw_path, patterns, must_exist=False)
        if path.exists() and path.is_dir():
            raise ValueError("不能覆盖目录")
        old_text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else None
        new_text = str(args.get("file_text") or "")
        atomic_write_text(path, new_text)
        _code_editor_push_undo(undo_key, old_text)
        rel = path.relative_to(root).as_posix()
        diff = _unified_diff_text(old_text or "", new_text, rel)
        return {"ok": True, "result": f"[OK] 文件已写入：{rel}\n{diff}", "path": rel, "diff": diff, "content": new_text}

    if command == "str_replace":
        path = safe_path(root, raw_path, patterns, must_exist=True)
        if not path.is_file():
            raise ValueError("目标不是文件")
        # newline="" 关闭通用换行翻译，保留文件真实的 \r\n，供下方检测换行风格与撤销还原。
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as _fh:
            original = _fh.read()
        old_str = str(args.get("old_str") or "")
        new_str = str(args.get("new_str") or "")
        if not old_str:
            raise ValueError("str_replace 需要 old_str 参数")
        # 换行符容错：文件可能是 CRLF，而 old_str 经传输被规范化为 LF（反之亦然）。
        # 统一到 LF 空间做匹配与替换，写回时保留文件原本的换行风格。
        uses_crlf = "\r\n" in original
        work = original.replace("\r\n", "\n")
        old_norm = old_str.replace("\r\n", "\n")
        new_norm = new_str.replace("\r\n", "\n")
        occurrences = work.count(old_norm)
        if occurrences == 0:
            raise ValueError(f"old_str 未在文件中找到匹配。文件前 500 字符:\n{original[:500]}")
        if occurrences > 1:
            raise ValueError(f"old_str 匹配到 {occurrences} 处，必须唯一匹配，请扩大上下文范围")
        replaced = work.replace(old_norm, new_norm, 1)
        updated = replaced.replace("\n", "\r\n") if uses_crlf else replaced
        atomic_write_text(path, updated)
        _code_editor_push_undo(undo_key, original)
        rel = path.relative_to(root).as_posix()
        diff = _unified_diff_text(original, updated, rel)
        return {"ok": True, "result": f"[OK] 已替换：{rel}\n{diff}", "path": rel, "diff": diff, "content": updated}

    if command == "insert":
        path = safe_path(root, raw_path, patterns, must_exist=True)
        if not path.is_file():
            raise ValueError("目标不是文件")
        # newline="" 关闭通用换行翻译，保留文件真实的 \r\n。
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as _fh:
            original = _fh.read()
        new_str = str(args.get("new_str") or "")
        if not new_str:
            raise ValueError("insert 需要 new_str 参数")
        insert_line = int(args.get("insert_line", -1))
        # 保留文件原本的换行风格：CRLF 文件插入后仍写回 CRLF。
        newline = "\r\n" if "\r\n" in original else "\n"
        work = original.replace("\r\n", "\n")
        new_norm = new_str.replace("\r\n", "\n").replace("\r", "\n")
        lines = work.split("\n")
        trailing_newline = work.endswith("\n")
        if trailing_newline:
            lines.pop()
        if insert_line < 0 or insert_line > len(lines):
            raise ValueError(f"insert_line 超出范围（0-{len(lines)}，0 表示插入到文件开头）")
        lines.insert(insert_line, new_norm)
        updated = newline.join(lines) + (newline if trailing_newline else "")
        atomic_write_text(path, updated)
        _code_editor_push_undo(undo_key, original)
        rel = path.relative_to(root).as_posix()
        diff = _unified_diff_text(original, updated, rel)
        return {"ok": True, "result": f"[OK] 已在第 {insert_line} 行后插入：{rel}\n{diff}", "path": rel, "diff": diff, "content": updated}

    if command == "undo_edit":
        stack = _CODE_EDITOR_UNDO.get(undo_key)
        if not stack:
            raise ValueError(f"没有可撤销的编辑: {raw_path}")
        previous = stack.pop()
        path = safe_path(root, raw_path, patterns, must_exist=False)
        rel = path.relative_to(root).as_posix()
        if previous is None:
            path.unlink(missing_ok=True)
            return {"ok": True, "result": f"[OK] 已撤销创建，文件已删除：{rel}", "path": rel, "deleted": True}
        atomic_write_text(path, previous)
        return {"ok": True, "result": f"[OK] 已恢复上次编辑前的内容：{rel}", "path": rel, "content": previous}

    raise ValueError(f"未知 code_editor 命令: {command}")


def glob_tool(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    pattern = str(args.get("pattern") or "**/*").replace("\\", "/")
    matches: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if is_ignored(rel, patterns):
            continue
        if fnmatch.fnmatch(rel, pattern):
            matches.append(rel)
        if len(matches) >= 200:
            break
    return {"ok": True, "result": "\n".join(matches)}


def search_code(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    pattern = str(args.get("pattern") or "")
    glob_filter = str(args.get("glob") or "*")
    if not pattern:
        raise ValueError("search_code 需要 pattern 参数")
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        regex = re.compile(re.escape(pattern), re.IGNORECASE)
    lines: list[str] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if is_ignored(rel, patterns) or not fnmatch.fnmatch(rel, glob_filter):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                lines.append(f"{rel}:{lineno}: {line[:240]}")
                if len(lines) >= 100:
                    return {"ok": True, "result": "\n".join(lines)}
    return {"ok": True, "result": "\n".join(lines) or "[无匹配]"}


def snapshot_files(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    max_files = int(args.get("max_files") or 800)
    max_total_bytes = int(args.get("max_total_bytes") or 8 * 1024 * 1024)
    max_file_bytes = int(args.get("max_file_bytes") or 512 * 1024)
    files: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    total_bytes = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if is_ignored(rel, patterns):
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        size = len(data)
        if size > max_file_bytes:
            skipped.append({"path": rel, "reason": "file_too_large", "size": size})
            continue
        if len(files) >= max_files or total_bytes + size > max_total_bytes:
            skipped.append({"path": rel, "reason": "snapshot_limit", "size": size})
            continue
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError:
            skipped.append({"path": rel, "reason": "binary_or_non_utf8", "size": size})
            continue
        total_bytes += size
        files.append({
            "path": rel,
            "content": content,
            "size": size,
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    return {
        "ok": True,
        "result": f"[OK] snapshot files={len(files)} skipped={len(skipped)} bytes={total_bytes}",
        "files": files,
        "skipped": skipped[:200],
        "file_count": len(files),
        "skipped_count": len(skipped),
        "total_bytes": total_bytes,
    }


def normalize_command_for_local_shell(command: str, root: Path) -> str:
    normalized = command.strip()
    if not normalized:
        return normalized

    root_text = str(root)
    normalized = normalized.replace("/workspace/", "./")
    normalized = normalized.replace("/workspace", ".")

    if os.name != "nt":
        return normalized

    # The Agent often emits small POSIX shell probes. On Windows the runner uses
    # cmd.exe by default, so translate the most common probes instead of failing
    # before the real work starts.
    lowered = normalized.lower().strip()
    if lowered in {"pwd", "pwd;"}:
        return "cd"
    if lowered in {"ls", "ls -la", "ls -al", f"ls -la {root_text.lower()}", f"ls -al {root_text.lower()}"}:
        return f'dir "{root_text}"'
    normalized = re.sub(r"(?<!\S)python3(\s+)", r"python\1", normalized)
    normalized = re.sub(r"(?<!\S)ls\s+-la\s+([^\s&|;]+)", r'dir "\1"', normalized)
    normalized = re.sub(r"(?<!\S)ls\s+-al\s+([^\s&|;]+)", r'dir "\1"', normalized)
    normalized = re.sub(r"(?<!\S)cat\s+([^\s&|;]+)", r'type "\1"', normalized)
    return normalized


def bash(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    command = normalize_command_for_local_shell(str(args.get("command") or ""), root)
    timeout = int(args.get("timeout") or args.get("command_timeout") or 120)
    max_output = int(args.get("max_output") or 20000)
    if not command.strip():
        raise ValueError("bash 需要 command 参数")
    output_encoding = locale.getpreferredencoding(False) or "utf-8"
    proc = subprocess.run(
        command,
        cwd=str(root),
        shell=True,
        capture_output=True,
        text=True,
        encoding=output_encoding,
        errors="replace",
        timeout=timeout,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "result": output[-max_output:], "exit_code": proc.returncode}


def git_diff(root: Path, patterns: list[str], args: dict[str, Any]) -> dict[str, Any]:
    git = shutil.which("git")
    if not git:
        raise RuntimeError("未找到 git 命令")
    proc = subprocess.run(
        [git, "diff", "--", "."],
        cwd=str(root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"ok": proc.returncode == 0, "result": output[-20000:], "exit_code": proc.returncode}


TOOLS = {
    "read_file": read_file,
    "read_lines": read_lines,
    "write_file": write_file,
    "local_write_text_file": local_write_text_file,
    "local_read_text_file": local_read_text_file,
    "apply_patch": apply_patch_tool,
    "code_editor": code_editor,
    "glob": glob_tool,
    "search_code": search_code,
    "snapshot_files": snapshot_files,
    "bash": bash,
    "git_diff": git_diff,
}


async def send_heartbeat(ws: Any, root: Path, patterns: list[str], interval: int) -> None:
    while True:
        await asyncio.sleep(max(5, interval))
        try:
            await ws.send(json.dumps({
                "type": "heartbeat",
                "version": VERSION,
                "project_root": str(root),
                "ignore_count": len(patterns),
                "sent_at": int(time.time()),
            }, ensure_ascii=False))
        except Exception:
            return


async def run_once(args: argparse.Namespace, root: Path, patterns: list[str], ws_url: str) -> None:
    print(f"连接 AutoCode：{ws_url}")
    print(f"授权项目目录：{root}")
    async with websockets.connect(
        ws_url,
        max_size=25 * 1024 * 1024,
        ping_interval=args.ping_interval,
        ping_timeout=args.ping_timeout,
        open_timeout=args.open_timeout,
    ) as ws:
        await ws.send(json.dumps({
            "type": "hello",
            "version": VERSION,
            "project_root": str(root),
            "ignore_count": len(patterns),
            "pid": os.getpid(),
        }, ensure_ascii=False))
        heartbeat_task = asyncio.create_task(send_heartbeat(ws, root, patterns, args.heartbeat_interval))
        try:
            async for raw in ws:
                message: dict[str, Any] = {}
                request_id = ""
                tool = ""
                try:
                    message = json.loads(raw)
                    if message.get("type") != "tool_request":
                        continue
                    tool = str(message.get("tool") or "")
                    request_id = str(message.get("id") or "")
                    tool_args = message.get("args") if isinstance(message.get("args"), dict) else {}
                    tool_args.setdefault("command_timeout", args.command_timeout)
                    tool_args.setdefault("max_output", args.max_output)
                    if tool not in TOOLS:
                        raise ValueError(f"unsupported tool: {tool}")
                    result = await asyncio.to_thread(TOOLS[tool], root, patterns, tool_args)
                    await ws.send(json.dumps({
                        "type": "tool_result",
                        "id": request_id,
                        "tool": tool,
                        **result,
                    }, ensure_ascii=False))
                except Exception as exc:
                    await ws.send(json.dumps({
                        "type": "tool_result",
                        "id": request_id,
                        "tool": tool,
                        "ok": False,
                        "result": f"[LOCAL_RUNNER_ERROR] {exc}",
                        "error": str(exc),
                    }, ensure_ascii=False))
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass


async def run(args: argparse.Namespace) -> None:
    root = Path(args.project).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise SystemExit(f"项目目录不存在或不是文件夹：{root}")
    patterns = load_ignore_patterns(root)
    ws_url = args.ws_url or to_ws_url(args.server, args.session, args.token)

    attempt = 0
    while True:
        try:
            await run_once(args, root, patterns, ws_url)
            attempt = 0
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            attempt += 1
            if not args.reconnect:
                raise
            delay = min(args.retry_max, args.retry_min * (2 ** min(attempt - 1, 5)))
            delay = delay + random.uniform(0, min(1.5, delay / 3))
            print(f"连接中断：{exc}，{delay:.1f}s 后自动重连（第 {attempt} 次）", file=sys.stderr)
            await asyncio.sleep(delay)


def main() -> None:
    parser = argparse.ArgumentParser(description="AutoCode Local Runner")
    parser.add_argument("--server", default="", help="AutoCode API 地址，例如：https://example.com/autocode-api")
    parser.add_argument("--session", default="", help="本地 Runner session id")
    parser.add_argument("--token", default="", help="本地 Runner token")
    parser.add_argument("--project", required=True, help="授权给 AutoCode 操作的项目目录")
    parser.add_argument("--ws-url", default="", help="完整 WebSocket URL，可选")
    parser.add_argument("--reconnect", action=argparse.BooleanOptionalAction, default=True, help="断线后自动重连")
    parser.add_argument("--retry-min", type=float, default=1.0, help="最小重连等待秒数")
    parser.add_argument("--retry-max", type=float, default=30.0, help="最大重连等待秒数")
    parser.add_argument("--heartbeat-interval", type=int, default=20, help="心跳发送间隔秒数")
    parser.add_argument("--ping-interval", type=int, default=None, help="WebSocket ping 间隔，默认交给库处理")
    parser.add_argument("--ping-timeout", type=int, default=None, help="WebSocket ping 超时，默认交给库处理")
    parser.add_argument("--open-timeout", type=int, default=20, help="连接打开超时秒数")
    parser.add_argument("--command-timeout", type=int, default=120, help="本地命令默认超时秒数")
    parser.add_argument("--max-output", type=int, default=20000, help="单次工具返回最大输出字符数")
    args = parser.parse_args()
    if not args.ws_url and (not args.server or not args.session or not args.token):
        parser.error("请提供 --ws-url，或同时提供 --server/--session/--token")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
