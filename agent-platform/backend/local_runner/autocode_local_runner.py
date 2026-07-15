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
    raw = (raw_path or "").replace("\\", "/").strip()
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    raw = raw.lstrip("/")
    target = (root / raw).resolve(strict=must_exist)
    try:
        rel = target.relative_to(root)
    except ValueError as exc:
        raise PermissionError("路径超出了授权项目目录") from exc
    rel_text = rel.as_posix()
    if rel_text and is_ignored(rel_text, patterns):
        raise PermissionError(f"路径被 .autocodeignore 忽略：{rel_text}")
    return target


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
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
    "write_file": write_file,
    "apply_patch": apply_patch_tool,
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
