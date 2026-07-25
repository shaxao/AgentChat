# -*- coding: utf-8 -*-
"""Per-workspace LSP client pool and lifecycle.

Ported from opencode's ``lsp.ts`` (the ``LSP.Service`` layer) to a plain async
class scoped per workspace. Responsibilities:

- Given a file, pick matching servers by extension, find each server's project
  root, and lazily spawn/reuse one client per ``(root, server_id)``.
- ``broken`` set: a server that fails to spawn/initialize once is not retried
  for that root — the feature degrades to "no LSP for this file".
- ``touch_file``: open (or re-sync) a file and optionally wait for diagnostics.
- Query helpers: definition / references / hover / document_symbol /
  workspace_symbol.
- ``shutdown``: stop every client (called from the task teardown).

Everything is bounded and best-effort: no LSP failure is allowed to propagate
into the agent loop. Callers get ``None``/empty results and carry on.

A module-level ``LSPManagerRegistry`` keeps one manager per ``workspace_id`` so
the same servers are reused across agent iterations within a task, and torn
down together when the task finishes.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from loguru import logger

from .lsp_client import LSPClient, LSPDiagnostic, InitializeError, path_to_uri
from .lsp_server import LSPServerSpec, default_servers, servers_for_file


def _lsp_enabled() -> bool:
    return os.getenv("AUTOCODE_LSP_ENABLED", "1").lower() not in ("0", "false", "no", "off")


class LSPManager:
    """Owns the language-server clients for a single workspace."""

    def __init__(self, workspace_dir: str, servers: list[LSPServerSpec] | None = None) -> None:
        self.workspace_dir = os.path.abspath(workspace_dir)
        self._servers = servers if servers is not None else default_servers()
        # key: f"{root}::{server_id}" -> LSPClient
        self._clients: dict[str, LSPClient] = {}
        # keys that failed to spawn/initialize; do not retry.
        self._broken: set[str] = set()
        # per-key spawn lock to avoid duplicate spawns on concurrent touches.
        self._spawn_locks: dict[str, asyncio.Lock] = {}
        self._closed = False

    # -- client acquisition ---------------------------------------------------
    async def _clients_for(self, file_abs: str) -> list[LSPClient]:
        if self._closed or not _lsp_enabled():
            return []
        # Only serve files inside this workspace.
        try:
            Path(file_abs).resolve().relative_to(Path(self.workspace_dir).resolve())
        except ValueError:
            return []

        result: list[LSPClient] = []
        for server in servers_for_file(file_abs, self._servers):
            root = server.root(file_abs, self.workspace_dir)
            if not root:
                continue
            key = f"{root}::{server.id}"
            if key in self._broken:
                continue
            existing = self._clients.get(key)
            if existing is not None:
                result.append(existing)
                continue
            client = await self._spawn_client(server, root, key)
            if client is not None:
                result.append(client)
        return result

    async def _spawn_client(self, server: LSPServerSpec, root: str, key: str) -> LSPClient | None:
        lock = self._spawn_locks.setdefault(key, asyncio.Lock())
        async with lock:
            # Re-check after acquiring the lock (another coroutine may have won).
            if key in self._broken:
                return None
            existing = self._clients.get(key)
            if existing is not None:
                return existing
            try:
                spawned = await server.spawn(root)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"[LSP] spawn error for {server.id}@{root}: {exc}")
                spawned = None
            if spawned is None:
                self._broken.add(key)
                return None
            try:
                client = await LSPClient.create(
                    server.id, root, spawned.process, spawned.initialization
                )
            except (InitializeError, Exception) as exc:  # noqa: BLE001
                logger.debug(f"[LSP] initialize failed for {server.id}@{root}: {exc}")
                self._broken.add(key)
                try:
                    spawned.process.terminate()
                except Exception:  # noqa: BLE001
                    pass
                return None
            self._clients[key] = client
            logger.info(f"[LSP] {server.id} connected for root {root}")
            return client

    async def has_clients(self, file_path: str) -> bool:
        """True if at least one (non-broken) server matches this file type."""
        if self._closed or not _lsp_enabled():
            return False
        file_abs = os.path.abspath(file_path)
        # Only serve files inside this workspace (mirrors ``_clients_for``).
        try:
            Path(file_abs).resolve().relative_to(Path(self.workspace_dir).resolve())
        except ValueError:
            return False
        for server in servers_for_file(file_abs, self._servers):
            root = server.root(file_abs, self.workspace_dir)
            if not root:
                continue
            if f"{root}::{server.id}" in self._broken:
                continue
            return True
        return False

    # -- documents & diagnostics ---------------------------------------------
    async def touch_file(
        self, file_path: str, wait_diagnostics: bool = True,
        timeout: float | None = None,
    ) -> dict[str, list[LSPDiagnostic]]:
        """Open/sync ``file_path`` in all matching servers; optionally wait for
        diagnostics. Returns ``{abs_path: [diagnostics]}`` for the touched file.
        """
        file_abs = os.path.abspath(file_path)
        clients = await self._clients_for(file_abs)
        if not clients:
            return {}
        loop = asyncio.get_event_loop()
        after = loop.time()
        merged: dict[str, list[LSPDiagnostic]] = {}
        for client in clients:
            try:
                version = await client.open_file(file_abs)
                if version < 0:
                    continue
                if wait_diagnostics:
                    if timeout is not None:
                        await client.wait_for_diagnostics(file_abs, after=after, timeout=timeout)
                    else:
                        await client.wait_for_diagnostics(file_abs, after=after)
                diags = client.diagnostics_for(file_abs)
                if diags:
                    merged.setdefault(file_abs, []).extend(diags)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"[LSP] touch_file failed on {client.server_id}: {exc}")
        return merged

    async def diagnostics_for(self, file_path: str) -> list[LSPDiagnostic]:
        file_abs = os.path.abspath(file_path)
        clients = await self._clients_for(file_abs)
        result: list[LSPDiagnostic] = []
        for client in clients:
            result.extend(client.diagnostics_for(file_abs))
        return result

    # -- code intelligence queries -------------------------------------------
    async def _position_request(self, method: str, file_path: str, line: int, character: int) -> list[Any]:
        """Run a position-based request against all matching clients; flatten
        list results, drop falsy. ``line``/``character`` are 0-based here."""
        file_abs = os.path.abspath(file_path)
        clients = await self._clients_for(file_abs)
        if not clients:
            return []
        # Ensure the server knows about the file before querying.
        await self.touch_file(file_abs, wait_diagnostics=False)
        params = {
            "textDocument": {"uri": path_to_uri(file_abs)},
            "position": {"line": line, "character": character},
        }
        if method == "textDocument/references":
            params["context"] = {"includeDeclaration": True}
        results: list[Any] = []
        for client in clients:
            res = await client.request(method, params)
            if res is None:
                continue
            if isinstance(res, list):
                results.extend([r for r in res if r])
            else:
                results.append(res)
        return results

    async def definition(self, file_path: str, line: int, character: int) -> list[Any]:
        return await self._position_request("textDocument/definition", file_path, line, character)

    async def references(self, file_path: str, line: int, character: int) -> list[Any]:
        return await self._position_request("textDocument/references", file_path, line, character)

    async def hover(self, file_path: str, line: int, character: int) -> list[Any]:
        return await self._position_request("textDocument/hover", file_path, line, character)

    async def implementation(self, file_path: str, line: int, character: int) -> list[Any]:
        return await self._position_request("textDocument/implementation", file_path, line, character)

    async def document_symbol(self, file_path: str) -> list[Any]:
        file_abs = os.path.abspath(file_path)
        clients = await self._clients_for(file_abs)
        if not clients:
            return []
        await self.touch_file(file_abs, wait_diagnostics=False)
        params = {"textDocument": {"uri": path_to_uri(file_abs)}}
        results: list[Any] = []
        for client in clients:
            res = await client.request("textDocument/documentSymbol", params)
            if isinstance(res, list):
                results.extend([r for r in res if r])
        return results

    async def workspace_symbol(self, file_path: str, query: str) -> list[Any]:
        """workspace/symbol — file_path only selects the server, not sent."""
        file_abs = os.path.abspath(file_path)
        clients = await self._clients_for(file_abs)
        if not clients:
            return []
        results: list[Any] = []
        for client in clients:
            res = await client.request("workspace/symbol", {"query": query or ""})
            if isinstance(res, list):
                results.extend([r for r in res if r])
        return results

    # -- lifecycle ------------------------------------------------------------
    async def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        clients = list(self._clients.values())
        self._clients.clear()
        await asyncio.gather(*(c.shutdown() for c in clients), return_exceptions=True)


class LSPManagerRegistry:
    """One LSPManager per workspace_id, created on demand."""

    def __init__(self) -> None:
        self._managers: dict[str, LSPManager] = {}
        self._lock = asyncio.Lock()

    async def get(self, workspace_id: str, workspace_dir: str) -> LSPManager | None:
        if not _lsp_enabled():
            return None
        async with self._lock:
            mgr = self._managers.get(workspace_id)
            if mgr is None or mgr._closed:
                mgr = LSPManager(workspace_dir)
                self._managers[workspace_id] = mgr
            return mgr

    async def shutdown(self, workspace_id: str) -> None:
        async with self._lock:
            mgr = self._managers.pop(workspace_id, None)
        if mgr is not None:
            await mgr.shutdown()

    async def shutdown_all(self) -> None:
        async with self._lock:
            managers = list(self._managers.values())
            self._managers.clear()
        await asyncio.gather(*(m.shutdown() for m in managers), return_exceptions=True)


# Module-level singleton used by the orchestrator.
lsp_registry = LSPManagerRegistry()
