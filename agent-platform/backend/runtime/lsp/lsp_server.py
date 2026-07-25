# -*- coding: utf-8 -*-
"""Language server registry: how to detect a project root and spawn a server.

Ported from opencode's ``server.ts``. P1 ships Pyright only; TypeScript and
gopls definitions land in P4. Each server is described by a ``LSPServerSpec``
with an ``id``, matching file ``extensions``, a ``root`` finder, and an async
``spawn`` that returns a running process (or ``None`` when the binary/runtime
is unavailable — the manager then degrades gracefully).
"""
from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from loguru import logger


@dataclass
class SpawnResult:
    process: asyncio.subprocess.Process
    initialization: dict[str, Any] = field(default_factory=dict)


# root finder: (file_abs_path, workspace_dir) -> project_root | None
RootFinder = Callable[[str, str], str | None]
# spawn: (root) -> SpawnResult | None
Spawner = Callable[[str], Awaitable["SpawnResult | None"]]


@dataclass
class LSPServerSpec:
    id: str
    extensions: tuple[str, ...]
    root: RootFinder
    spawn: Spawner


def _nearest_root(include_patterns: list[str]) -> RootFinder:
    """Walk up from the file's dir to workspace_dir; return the dir that holds
    any of ``include_patterns``. Falls back to workspace_dir when none match
    (mirrors opencode ``NearestRoot`` which defaults to ctx.directory)."""

    def finder(file_abs: str, workspace_dir: str) -> str | None:
        workspace_dir = os.path.abspath(workspace_dir)
        current = os.path.dirname(os.path.abspath(file_abs))
        # Guard: only search within the workspace subtree.
        try:
            Path(current).relative_to(workspace_dir)
        except ValueError:
            return workspace_dir
        while True:
            for pattern in include_patterns:
                if (Path(current) / pattern).exists():
                    return current
            if os.path.abspath(current) == workspace_dir:
                break
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        return workspace_dir

    return finder


def _find_venv_python(root: str) -> str | None:
    candidates = []
    venv_env = os.getenv("VIRTUAL_ENV")
    if venv_env:
        candidates.append(venv_env)
    candidates.extend([os.path.join(root, ".venv"), os.path.join(root, "venv")])
    for venv in candidates:
        if os.name == "nt":
            py = os.path.join(venv, "Scripts", "python.exe")
        else:
            py = os.path.join(venv, "bin", "python")
        if os.path.exists(py):
            return py
    return None


async def _spawn_process(cmd: list[str], cwd: str, env: dict | None = None) -> asyncio.subprocess.Process | None:
    try:
        return await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except (FileNotFoundError, OSError) as exc:
        logger.debug(f"[LSP] spawn failed for {cmd[0]}: {exc}")
        return None


# --- Pyright -----------------------------------------------------------------
async def _spawn_pyright(root: str) -> SpawnResult | None:
    binary = shutil.which("pyright-langserver")
    if not binary:
        logger.debug("[LSP] pyright-langserver not found on PATH; Python LSP disabled")
        return None
    initialization: dict[str, Any] = {}
    venv_python = _find_venv_python(root)
    if venv_python:
        initialization["pythonPath"] = venv_python
    proc = await _spawn_process([binary, "--stdio"], cwd=root, env={**os.environ})
    if proc is None:
        return None
    return SpawnResult(process=proc, initialization=initialization)


PYRIGHT = LSPServerSpec(
    id="pyright",
    extensions=(".py", ".pyi"),
    root=_nearest_root(
        ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
         "Pipfile", "pyrightconfig.json"]
    ),
    spawn=_spawn_pyright,
)


def _strict_nearest_root(include_patterns: list[str]) -> RootFinder:
    """Like :func:`_nearest_root` but returns ``None`` when no marker is found.

    TypeScript and gopls need a real project root (package.json / go.mod) to
    behave; falling back to the workspace root makes them index unrelated files
    and emit noise. When there is no marker we simply skip LSP for that file.
    """

    def finder(file_abs: str, workspace_dir: str) -> str | None:
        workspace_dir = os.path.abspath(workspace_dir)
        current = os.path.dirname(os.path.abspath(file_abs))
        try:
            Path(current).relative_to(workspace_dir)
        except ValueError:
            return None
        while True:
            for pattern in include_patterns:
                if (Path(current) / pattern).exists():
                    return current
            if os.path.abspath(current) == workspace_dir:
                break
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        return None

    return finder


# --- TypeScript / JavaScript -------------------------------------------------
async def _spawn_typescript(root: str) -> SpawnResult | None:
    binary = shutil.which("typescript-language-server")
    if not binary:
        logger.debug("[LSP] typescript-language-server not found on PATH; TS/JS LSP disabled")
        return None
    proc = await _spawn_process([binary, "--stdio"], cwd=root, env={**os.environ})
    if proc is None:
        return None
    return SpawnResult(process=proc, initialization={})


TYPESCRIPT = LSPServerSpec(
    id="typescript",
    extensions=(".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"),
    root=_strict_nearest_root(
        ["package.json", "tsconfig.json", "jsconfig.json",
         "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]
    ),
    spawn=_spawn_typescript,
)


# --- Go (gopls) --------------------------------------------------------------
async def _spawn_gopls(root: str) -> SpawnResult | None:
    binary = shutil.which("gopls")
    if not binary:
        logger.debug("[LSP] gopls not found on PATH; Go LSP disabled")
        return None
    proc = await _spawn_process([binary], cwd=root, env={**os.environ})
    if proc is None:
        return None
    return SpawnResult(process=proc, initialization={})


GOPLS = LSPServerSpec(
    id="gopls",
    extensions=(".go",),
    root=_strict_nearest_root(["go.mod", "go.sum"]),
    spawn=_spawn_gopls,
)


def default_servers() -> list[LSPServerSpec]:
    """Servers enabled by default: Python (pyright), TS/JS, and Go (gopls).

    Each degrades gracefully when its binary is missing (spawn returns None →
    the manager marks the (root, server) broken and skips it).
    """
    return [PYRIGHT, TYPESCRIPT, GOPLS]


def servers_for_file(file_path: str, servers: list[LSPServerSpec] | None = None) -> list[LSPServerSpec]:
    """Return every registered server whose extensions match ``file_path``.

    A file may be served by more than one language server (mirrors opencode,
    which iterates all matching servers). Returns an empty list when no server
    handles this file type — the caller then skips LSP for that file.
    """
    ext = os.path.splitext(file_path)[1].lower()
    pool = servers if servers is not None else default_servers()
    return [spec for spec in pool if ext in spec.extensions]


def server_for_file(file_path: str, servers: list[LSPServerSpec] | None = None) -> LSPServerSpec | None:
    """Return the first registered server whose extensions match ``file_path``
    (convenience wrapper over :func:`servers_for_file`)."""
    matches = servers_for_file(file_path, servers)
    return matches[0] if matches else None
