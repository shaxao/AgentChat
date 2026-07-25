# -*- coding: utf-8 -*-
"""Minimal JSON-RPC client for a single Language Server, over stdio.

Ported from opencode's ``client.ts`` (TypeScript/vscode-jsonrpc) to asyncio.
Scope for P1: initialize handshake, ``textDocument/didOpen`` + ``didChange``,
listening for ``textDocument/publishDiagnostics``, generic request dispatch
(definition/references/hover/documentSymbol/workspaceSymbol), and a bounded
``wait_for_diagnostics`` after opening a file.

Design notes:
- LSP framing is ``Content-Length: N\\r\\n\\r\\n<json>`` over stdout/stdin.
- Positions are 0-based on the wire (LSP spec); callers pass 0-based here.
- All waits are bounded; a slow/broken server never blocks the agent loop
  beyond the configured timeouts.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urljoin
from urllib.request import pathname2url

from loguru import logger

# --- Timeouts (mirror opencode client.ts constants) --------------------------
INITIALIZE_TIMEOUT_S = float(os.getenv("AUTOCODE_LSP_INIT_TIMEOUT_S", "20"))
DIAGNOSTICS_WAIT_TIMEOUT_S = float(os.getenv("AUTOCODE_LSP_DIAGNOSTICS_TIMEOUT_S", "5"))
DIAGNOSTICS_DEBOUNCE_S = 0.15
REQUEST_TIMEOUT_S = float(os.getenv("AUTOCODE_LSP_REQUEST_TIMEOUT_S", "5"))

# LSP DiagnosticSeverity
SEVERITY_ERROR = 1
SEVERITY_WARNING = 2
SEVERITY_INFO = 3
SEVERITY_HINT = 4

# Minimal languageId map; extend alongside lsp_server.py extensions.
LANGUAGE_IDS = {
    ".py": "python",
    ".pyi": "python",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".go": "go",
}


def path_to_uri(p: str | Path) -> str:
    """Convert a filesystem path to a ``file://`` URI (cross-platform)."""
    abs_path = os.path.abspath(str(p))
    return urljoin("file:", pathname2url(abs_path))


def uri_to_path(uri: str) -> str | None:
    if not uri.startswith("file://"):
        return None
    from urllib.parse import urlparse, unquote

    parsed = urlparse(uri)
    raw = unquote(parsed.path)
    # On Windows a URI path looks like /C:/foo — strip the leading slash.
    if os.name == "nt" and raw.startswith("/") and len(raw) > 2 and raw[2] == ":":
        raw = raw[1:]
    return os.path.normpath(raw)


class InitializeError(RuntimeError):
    """Raised when the initialize handshake fails or times out."""


class LSPDiagnostic(dict):
    """A raw LSP Diagnostic (thin dict wrapper for typing clarity)."""

    @property
    def severity(self) -> int:
        return int(self.get("severity") or SEVERITY_ERROR)

    @property
    def message(self) -> str:
        return str(self.get("message") or "")

    @property
    def line(self) -> int:
        return int(((self.get("range") or {}).get("start") or {}).get("line") or 0)

    @property
    def character(self) -> int:
        return int(((self.get("range") or {}).get("start") or {}).get("character") or 0)


class LSPClient:
    """One JSON-RPC connection to one language server process."""

    def __init__(self, server_id: str, root: str, proc: asyncio.subprocess.Process,
                 initialization: dict | None = None) -> None:
        self.server_id = server_id
        self.root = os.path.abspath(root)
        self._proc = proc
        self._initialization = initialization or {}

        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._push_diagnostics: dict[str, list[LSPDiagnostic]] = {}
        # path -> {"at": monotonic, "version": int|None}
        self._published: dict[str, dict[str, Any]] = {}
        self._diagnostic_events: asyncio.Event = asyncio.Event()
        self._open_files: dict[str, dict[str, Any]] = {}
        self._sync_kind: int | None = None
        self._closed = False
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None

    # -- lifecycle ------------------------------------------------------------
    @classmethod
    async def create(cls, server_id: str, root: str, proc: asyncio.subprocess.Process,
                     initialization: dict | None = None) -> "LSPClient":
        client = cls(server_id, root, proc, initialization)
        client._reader_task = asyncio.create_task(client._read_loop())
        client._stderr_task = asyncio.create_task(client._drain_stderr())
        await client._initialize()
        return client

    async def _initialize(self) -> None:
        root_uri = path_to_uri(self.root)
        params = {
            "processId": os.getpid(),
            "rootUri": root_uri,
            "workspaceFolders": [{"name": "workspace", "uri": root_uri}],
            "initializationOptions": dict(self._initialization),
            "capabilities": {
                "window": {"workDoneProgress": True},
                "workspace": {
                    "configuration": True,
                    "didChangeWatchedFiles": {"dynamicRegistration": True},
                },
                "textDocument": {
                    "synchronization": {"didOpen": True, "didChange": True},
                    "publishDiagnostics": {"versionSupport": False},
                },
            },
        }
        try:
            result = await asyncio.wait_for(
                self._request("initialize", params), timeout=INITIALIZE_TIMEOUT_S
            )
        except Exception as exc:  # noqa: BLE001 — normalize to InitializeError
            raise InitializeError(f"{self.server_id} initialize failed: {exc}") from exc

        caps = (result or {}).get("capabilities") or {}
        sync = caps.get("textDocumentSync")
        if isinstance(sync, dict):
            self._sync_kind = sync.get("change")
        elif isinstance(sync, int):
            self._sync_kind = sync

        await self._notify("initialized", {})
        if self._initialization:
            await self._notify("workspace/didChangeConfiguration",
                               {"settings": self._initialization})

    async def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        for task in (self._reader_task, self._stderr_task):
            if task:
                task.cancel()
        try:
            self._proc.terminate()
        except ProcessLookupError:
            pass
        except Exception:  # noqa: BLE001
            pass
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=3)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("LSP client shut down"))
        self._pending.clear()

    # -- wire protocol --------------------------------------------------------
    async def _read_loop(self) -> None:
        stdout = self._proc.stdout
        assert stdout is not None
        try:
            while not self._closed:
                headers: dict[str, str] = {}
                while True:
                    line = await stdout.readline()
                    if not line:
                        return  # EOF
                    line = line.decode("ascii", errors="replace").strip()
                    if line == "":
                        break
                    if ":" in line:
                        key, _, value = line.partition(":")
                        headers[key.strip().lower()] = value.strip()
                length = int(headers.get("content-length", "0") or "0")
                if length <= 0:
                    continue
                body = await stdout.readexactly(length)
                try:
                    message = json.loads(body.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    continue
                self._handle_message(message)
        except (asyncio.IncompleteReadError, asyncio.CancelledError):
            return
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"[LSP:{self.server_id}] read loop ended: {exc}")

    async def _drain_stderr(self) -> None:
        stderr = self._proc.stderr
        if stderr is None:
            return
        try:
            while not self._closed:
                line = await stderr.readline()
                if not line:
                    return
                # Keep at debug; servers are chatty on stderr.
                logger.debug(f"[LSP:{self.server_id}] {line.decode('utf-8', errors='replace').rstrip()}")
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            return

    def _handle_message(self, message: dict) -> None:
        # Response to one of our requests
        if "id" in message and ("result" in message or "error" in message):
            fut = self._pending.pop(message["id"], None)
            if fut and not fut.done():
                if "error" in message:
                    fut.set_exception(RuntimeError(str(message["error"])))
                else:
                    fut.set_result(message.get("result"))
            return
        method = message.get("method")
        if method is None:
            return
        # Server -> client request (needs a response) or notification
        if "id" in message:
            self._handle_server_request(message)
        else:
            self._handle_notification(method, message.get("params") or {})

    def _handle_server_request(self, message: dict) -> None:
        method = message.get("method")
        req_id = message.get("id")
        params = message.get("params") or {}
        result: Any = None
        if method == "workspace/workspaceFolders":
            result = [{"name": "workspace", "uri": path_to_uri(self.root)}]
        elif method == "workspace/configuration":
            items = params.get("items") or []
            result = [self._config_value(item.get("section")) for item in items]
        elif method in ("client/registerCapability", "client/unregisterCapability",
                        "window/workDoneProgress/create", "workspace/diagnostic/refresh"):
            result = None
        else:
            result = None
        asyncio.create_task(self._respond(req_id, result))

    def _config_value(self, section: str | None) -> Any:
        if not section:
            return self._initialization or None
        node: Any = self._initialization
        for key in section.split("."):
            if not isinstance(node, dict) or key not in node:
                return None
            node = node[key]
        return node

    def _handle_notification(self, method: str, params: dict) -> None:
        if method == "textDocument/publishDiagnostics":
            uri = params.get("uri") or ""
            file_path = uri_to_path(uri)
            if not file_path:
                return
            diags = [LSPDiagnostic(d) for d in (params.get("diagnostics") or [])]
            self._push_diagnostics[file_path] = diags
            version = params.get("version")
            self._published[file_path] = {
                "at": asyncio.get_event_loop().time(),
                "version": version if isinstance(version, int) else None,
            }
            # Wake any waiters
            self._diagnostic_events.set()
            self._diagnostic_events = asyncio.Event()

    async def _send(self, payload: dict) -> None:
        if self._closed or self._proc.stdin is None:
            return
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self._proc.stdin.write(header + body)
        try:
            await self._proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError):
            self._closed = True

    def _request(self, method: str, params: dict) -> Awaitable:
        self._next_id += 1
        req_id = self._next_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        asyncio.create_task(self._send({"jsonrpc": "2.0", "id": req_id,
                                        "method": method, "params": params}))
        return fut

    async def _notify(self, method: str, params: dict) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _respond(self, req_id: Any, result: Any) -> None:
        await self._send({"jsonrpc": "2.0", "id": req_id, "result": result})

    async def request(self, method: str, params: dict, timeout: float = REQUEST_TIMEOUT_S) -> Any:
        """Public generic request with a bounded timeout; returns None on failure."""
        try:
            return await asyncio.wait_for(self._request(method, params), timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"[LSP:{self.server_id}] request {method} failed: {exc}")
            return None

    # -- documents ------------------------------------------------------------
    async def open_file(self, path: str) -> int:
        """didOpen (first time) or didChange (subsequent). Returns doc version."""
        abs_path = os.path.abspath(path)
        try:
            text = Path(abs_path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            logger.debug(f"[LSP:{self.server_id}] cannot read {abs_path}: {exc}")
            return -1
        uri = path_to_uri(abs_path)
        ext = os.path.splitext(abs_path)[1].lower()
        language_id = LANGUAGE_IDS.get(ext, "plaintext")

        existing = self._open_files.get(abs_path)
        if existing is not None:
            version = int(existing["version"]) + 1
            self._open_files[abs_path] = {"version": version, "text": text}
            await self._notify("textDocument/didChange", {
                "textDocument": {"uri": uri, "version": version},
                "contentChanges": [{"text": text}],
            })
            return version

        self._push_diagnostics.pop(abs_path, None)
        await self._notify("textDocument/didOpen", {
            "textDocument": {"uri": uri, "languageId": language_id,
                             "version": 0, "text": text},
        })
        self._open_files[abs_path] = {"version": 0, "text": text}
        return 0

    async def wait_for_diagnostics(self, path: str, after: float | None = None,
                                   timeout: float = DIAGNOSTICS_WAIT_TIMEOUT_S) -> None:
        """Wait (bounded) until the server publishes diagnostics for ``path``."""
        abs_path = os.path.abspath(path)
        loop = asyncio.get_event_loop()
        started = after if after is not None else loop.time()
        deadline = started + timeout
        while loop.time() < deadline:
            hit = self._published.get(abs_path)
            if hit and hit["at"] >= started:
                # small debounce so a burst of pushes settles
                await asyncio.sleep(DIAGNOSTICS_DEBOUNCE_S)
                return
            remaining = deadline - loop.time()
            if remaining <= 0:
                return
            try:
                await asyncio.wait_for(self._diagnostic_events.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return

    def diagnostics_for(self, path: str) -> list[LSPDiagnostic]:
        return list(self._push_diagnostics.get(os.path.abspath(path)) or [])

    @property
    def all_diagnostics(self) -> dict[str, list[LSPDiagnostic]]:
        return dict(self._push_diagnostics)
