# -*- coding: utf-8 -*-
"""AutoCode local runner session manager.

The local runner is opt-in per task. It connects outbound to the backend via
WebSocket, so the user's machine does not need a public IP or open port.
"""
from __future__ import annotations

import asyncio
import os
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from fastapi import WebSocket
from loguru import logger


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.rstrip("Z"))
    except ValueError:
        return None


@dataclass
class LocalRunnerSession:
    task_id: str
    session_id: str
    token: str
    enabled: bool = True
    connected: bool = False
    project_root: str = ""
    runner_version: str = ""
    public_api_base: str = ""
    command_project_path: str = ""
    user_id: str = ""
    local_project_grant_id: str = ""
    device_id: str = ""
    device_name: str = ""
    device_os: str = ""
    created_at: str = field(default_factory=utc_now)
    connected_at: str | None = None
    disconnected_at: str | None = None
    last_seen_at: str | None = None
    disconnect_reason: str = ""
    reconnect_count: int = 0
    active_tool_id: str = ""
    active_tool_name: str = ""
    websocket: WebSocket | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    tool_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def is_stale(self, stale_after_seconds: int) -> bool:
        if not self.connected:
            return False
        if self.active_tool_id or self.pending:
            return False
        last_seen = _parse_utc(self.last_seen_at)
        if not last_seen:
            return True
        return datetime.utcnow() - last_seen > timedelta(seconds=stale_after_seconds)

    def public_status(self, *, stale_after_seconds: int = 45) -> dict[str, Any]:
        stale = self.is_stale(stale_after_seconds)
        state = "connected"
        if not self.enabled:
            state = "disabled"
        elif stale:
            state = "stale"
        elif not self.connected:
            state = "disconnected"

        return {
            "task_id": self.task_id,
            "session_id": self.session_id,
            "enabled": self.enabled,
            "connected": self.connected and not stale,
            "connection_state": state,
            "project_root": self.project_root,
            "runner_version": self.runner_version,
            "created_at": self.created_at,
            "connected_at": self.connected_at,
            "disconnected_at": self.disconnected_at,
            "last_seen_at": self.last_seen_at,
            "disconnect_reason": self.disconnect_reason,
            "reconnect_count": self.reconnect_count,
            "pending_count": len(self.pending),
            "active_tool": self.active_tool_name,
            "local_project_grant_id": self.local_project_grant_id,
            "device_id": self.device_id,
            "device_name": self.device_name,
            "device_os": self.device_os,
        }


class LocalRunnerManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LocalRunnerSession] = {}
        self._task_sessions: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self.max_sessions = int(os.getenv("AUTOCODE_LOCAL_RUNNER_MAX_SESSIONS", "500") or "500")
        self.max_pending_per_session = int(os.getenv("AUTOCODE_LOCAL_RUNNER_MAX_PENDING", "4") or "4")
        self.stale_after_seconds = int(os.getenv("AUTOCODE_LOCAL_RUNNER_STALE_SECONDS", "120") or "120")

    async def enable(self, task_id: str) -> LocalRunnerSession:
        async with self._lock:
            existing_id = self._task_sessions.get(task_id)
            if existing_id and existing_id in self._sessions:
                session = self._sessions[existing_id]
                session.enabled = True
                if not session.token:
                    session.token = secrets.token_urlsafe(32)
                return session

            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError("local runner session capacity reached")

            session = LocalRunnerSession(
                task_id=task_id,
                session_id=f"lr-{secrets.token_hex(8)}",
                token=secrets.token_urlsafe(32),
            )
            self._sessions[session.session_id] = session
            self._task_sessions[task_id] = session.session_id
            return session

    async def disable(self, task_id: str) -> None:
        async with self._lock:
            session = self.get_by_task(task_id)
            if not session:
                return
            session.enabled = False
            session.disconnect_reason = "disabled"
            ws = session.websocket
            self._mark_disconnected(session, reason="disabled")
        if ws:
            try:
                await ws.send_json({
                    "type": "session_disabled",
                    "reason": "local runner disabled",
                    "task_id": task_id,
                })
            except Exception:
                pass
            try:
                await ws.close(code=1000, reason="local runner disabled")
            except Exception:
                pass

    def get(self, session_id: str) -> LocalRunnerSession | None:
        return self._sessions.get(session_id)

    def get_by_task(self, task_id: str) -> LocalRunnerSession | None:
        session_id = self._task_sessions.get(task_id)
        session = self._sessions.get(session_id or "")
        if session:
            return session
        for candidate in self._sessions.values():
            if candidate.task_id == task_id:
                self._task_sessions[task_id] = candidate.session_id
                return candidate
        return None

    async def ensure_task_binding(self, task_id: str, session_id: str | None) -> LocalRunnerSession | None:
        if not session_id:
            return self.get_by_task(task_id)
        async with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return self.get_by_task(task_id)
            if session.task_id != task_id:
                old_task_id = session.task_id
                if old_task_id:
                    self._task_sessions.pop(old_task_id, None)
                session.task_id = task_id
            self._task_sessions[task_id] = session_id
            session.enabled = True
            return session

    async def bind_session_to_task(self, session_id: str, task_id: str) -> LocalRunnerSession:
        async with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                raise KeyError("local runner session not found")
            old_task_id = session.task_id
            if old_task_id:
                self._task_sessions.pop(old_task_id, None)
            existing_id = self._task_sessions.get(task_id)
            if existing_id and existing_id != session_id:
                old_session = self._sessions.get(existing_id)
                if old_session:
                    old_session.enabled = False
            session.task_id = task_id
            session.enabled = True
            self._task_sessions[task_id] = session_id
            return session

    def status_for_task(self, task_id: str) -> dict[str, Any]:
        session = self.get_by_task(task_id)
        if not session:
            return {"enabled": False, "connected": False, "connection_state": "disabled"}
        return session.public_status(stale_after_seconds=self.stale_after_seconds)

    def status_for_task_or_session(self, task_id: str, session_id: str | None = None) -> dict[str, Any]:
        session = self.get_by_task(task_id)
        if not session and session_id:
            session = self._sessions.get(session_id)
            if session:
                self._task_sessions[task_id] = session.session_id
                session.task_id = task_id
        if not session:
            return {"enabled": False, "connected": False, "connection_state": "disabled"}
        return session.public_status(stale_after_seconds=self.stale_after_seconds)

    async def attach(self, session_id: str, token: str, ws: WebSocket) -> LocalRunnerSession:
        session = self.get(session_id)
        if not session or not session.enabled or not secrets.compare_digest(session.token, token or ""):
            await ws.close(code=1008, reason="invalid local runner token")
            raise PermissionError("invalid local runner token")

        old_ws = session.websocket
        if old_ws and old_ws is not ws:
            try:
                await old_ws.close(code=1012, reason="runner reconnected")
            except Exception:
                pass

        session.websocket = ws
        session.connected = True
        session.connected_at = utc_now()
        session.disconnected_at = None
        session.disconnect_reason = ""
        session.last_seen_at = session.connected_at
        session.reconnect_count += 1
        return session

    async def detach(self, session_id: str, ws: WebSocket | None = None, reason: str = "disconnected") -> None:
        session = self.get(session_id)
        if not session:
            return
        if ws is not None and session.websocket is not ws:
            return
        self._mark_disconnected(session, reason=reason)

    def _mark_disconnected(self, session: LocalRunnerSession, *, reason: str) -> None:
        session.websocket = None
        session.connected = False
        session.disconnected_at = utc_now()
        session.last_seen_at = session.disconnected_at
        session.disconnect_reason = reason
        session.active_tool_id = ""
        session.active_tool_name = ""
        for future in list(session.pending.values()):
            if not future.done():
                future.set_exception(RuntimeError(f"local runner disconnected: {reason}"))
        session.pending.clear()

    async def receive_message(self, session_id: str, message: dict[str, Any]) -> None:
        session = self.get(session_id)
        if not session:
            return
        session.last_seen_at = utc_now()
        msg_type = str(message.get("type") or "")
        if msg_type in {"hello", "heartbeat"}:
            session.project_root = str(message.get("project_root") or session.project_root or "")
            session.runner_version = str(message.get("version") or session.runner_version or "")
            session.device_id = str(message.get("device_id") or session.device_id or "")
            session.device_name = str(message.get("device_name") or session.device_name or "")
            session.device_os = str(message.get("device_os") or session.device_os or "")
            return
        if msg_type != "tool_result":
            return

        request_id = str(message.get("id") or "")
        future = session.pending.pop(request_id, None)
        if future and not future.done():
            future.set_result(message)

    async def execute_tool(
        self,
        task_id: str,
        tool_name: str,
        args: dict[str, Any] | None = None,
        *,
        timeout: int = 120,
    ) -> dict[str, Any]:
        session = self.get_by_task(task_id)
        if not session or not session.enabled:
            raise RuntimeError("local runner is not enabled")
        if not session.connected or not session.websocket:
            raise RuntimeError("local runner is not connected")
        if session.is_stale(self.stale_after_seconds):
            self._mark_disconnected(session, reason="heartbeat timeout")
            raise RuntimeError("local runner heartbeat timed out")

        async with session.tool_lock:
            if len(session.pending) >= self.max_pending_per_session:
                raise RuntimeError("local runner has too many pending requests")
            request_id = f"tool-{secrets.token_hex(8)}"
            loop = asyncio.get_running_loop()
            future: asyncio.Future = loop.create_future()
            session.pending[request_id] = future
            session.active_tool_id = request_id
            session.active_tool_name = tool_name
            payload = {
                "type": "tool_request",
                "id": request_id,
                "tool": tool_name,
                "args": args or {},
                "timeout": max(1, timeout),
                "issued_at": utc_now(),
            }
            try:
                await session.websocket.send_json(payload)
                result = await asyncio.wait_for(future, timeout=max(1, timeout))
                if not isinstance(result, dict):
                    raise RuntimeError("invalid local runner response")
                return result
            except Exception as exc:
                session.pending.pop(request_id, None)
                logger.warning(f"[LocalRunner] tool failed task={task_id} tool={tool_name}: {exc}")
                raise
            finally:
                if session.active_tool_id == request_id:
                    session.active_tool_id = ""
                    session.active_tool_name = ""


local_runner_manager = LocalRunnerManager()
