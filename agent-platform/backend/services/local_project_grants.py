# -*- coding: utf-8 -*-
"""Persistent local project grants for AutoCode Local Connector."""
from __future__ import annotations

import json
import os
import secrets
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


def _utc_now() -> datetime:
    return datetime.utcnow()


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds") + "Z"


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).rstrip("Z"))
    except ValueError:
        return None


class LocalProjectGrantStore:
    """Small JSON-backed store used before a DB migration is worth it."""

    def __init__(self) -> None:
        default_path = Path(os.getenv("AUTOCODE_DATA_DIR", "/var/lib/autocode")) / "local_project_grants.json"
        self.path = Path(os.getenv("AUTOCODE_LOCAL_PROJECT_GRANTS_PATH", str(default_path)))
        self.ttl_days = int(os.getenv("AUTOCODE_LOCAL_PROJECT_GRANT_DAYS", "30") or "30")
        self._lock = threading.Lock()

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {str(k): v for k, v in raw.items() if isinstance(v, dict)}
        except Exception:
            return {}
        return {}

    def _save(self, grants: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(grants, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def _is_active(self, grant: dict[str, Any]) -> bool:
        if grant.get("revoked_at"):
            return False
        expires_at = _parse_iso(str(grant.get("expires_at") or ""))
        return bool(expires_at and expires_at > _utc_now())

    def upsert(
        self,
        *,
        user_id: str,
        server_base: str,
        project_root: str,
        task_id: str = "",
        workspace_id: str = "",
        runner_version: str = "",
        device_id: str = "",
        device_name: str = "",
        device_os: str = "",
    ) -> dict[str, Any]:
        now = _utc_now()
        expires_at = now + timedelta(days=self.ttl_days)
        project_root = (project_root or "").strip()
        server_base = (server_base or "").strip().rstrip("/")
        user_id = (user_id or "anonymous").strip()
        device_id = (device_id or "").strip()
        with self._lock:
            grants = self._load()
            grant = None
            for item in grants.values():
                if (
                    not item.get("revoked_at")
                    and str(item.get("user_id") or "") == user_id
                    and str(item.get("server_base") or "").rstrip("/") == server_base
                    and str(item.get("project_root") or "") == project_root
                    and str(item.get("device_id") or "") == device_id
                ):
                    grant = item
                    break
            if grant is None:
                grant = {
                    "grant_id": f"lpg-{secrets.token_hex(12)}",
                    "created_at": _iso(now),
                }
            grant.update({
                "user_id": user_id,
                "server_base": server_base,
                "project_root": project_root,
                "project_name": Path(project_root).name or "本地项目",
                "task_id": task_id,
                "workspace_id": workspace_id,
                "runner_version": runner_version,
                "device_id": device_id,
                "device_name": device_name or device_id or "本地设备",
                "device_os": device_os,
                "device_last_seen_at": _iso(now),
                "last_used_at": _iso(now),
                "expires_at": _iso(expires_at),
                "ttl_days": self.ttl_days,
                "revoked_at": "",
                "open_url": self.open_url(server_base, grant["grant_id"], task_id),
            })
            grants[str(grant["grant_id"])] = grant
            self._save(grants)
            return dict(grant)

    def mark_device_seen(
        self,
        *,
        grant_id: str,
        device_id: str,
        device_name: str = "",
        device_os: str = "",
        runner_version: str = "",
    ) -> dict[str, Any] | None:
        now = _iso(_utc_now())
        with self._lock:
            grants = self._load()
            grant = grants.get(grant_id)
            if not grant or not self._is_active(grant):
                return None
            grant["device_id"] = device_id or str(grant.get("device_id") or "")
            if device_name:
                grant["device_name"] = device_name
            if device_os:
                grant["device_os"] = device_os
            if runner_version:
                grant["runner_version"] = runner_version
            grant["device_last_seen_at"] = now
            grant["last_used_at"] = now
            grants[grant_id] = grant
            self._save(grants)
            return dict(grant)

    def get(self, grant_id: str) -> dict[str, Any] | None:
        with self._lock:
            grant = self._load().get(grant_id)
            if not grant or not self._is_active(grant):
                return None
            return dict(grant)

    def list_for_user(self, user_id: str) -> list[dict[str, Any]]:
        with self._lock:
            grants = []
            for grant in self._load().values():
                if str(grant.get("user_id") or "") == user_id and self._is_active(grant):
                    grants.append(dict(grant))
            return sorted(grants, key=lambda item: str(item.get("last_used_at") or ""), reverse=True)

    def find_for_task(self, *, user_id: str, task_id: str) -> dict[str, Any] | None:
        if not user_id or not task_id:
            return None
        for grant in self.list_for_user(user_id):
            if str(grant.get("task_id") or "") == task_id:
                return grant
        return None

    def revoke(self, grant_id: str, user_id: str) -> bool:
        with self._lock:
            grants = self._load()
            grant = grants.get(grant_id)
            if not grant or str(grant.get("user_id") or "") != user_id:
                return False
            grant["revoked_at"] = _iso(_utc_now())
            grants[grant_id] = grant
            self._save(grants)
            return True

    @staticmethod
    def open_url(server_base: str, grant_id: str, task_id: str = "") -> str:
        server_base = (server_base or "").rstrip("/")
        if server_base.endswith("/autocode-api"):
            app_base = server_base[: -len("/autocode-api")]
        else:
            app_base = server_base
        query = f"view=autocode&local_grant_id={grant_id}"
        if task_id:
            query = f"{query}&task_id={task_id}"
        return f"{app_base}/?{query}"


local_project_grants = LocalProjectGrantStore()
