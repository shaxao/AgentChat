# -*- coding: utf-8 -*-
"""AutoCode local runner API."""
from __future__ import annotations

import os
import uuid
import asyncio
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlparse
import re

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from core.state import _tasks
from core.docker_manager import docker_manager
from core.config import get_settings
from core.workspace_index import build_workspace_index
from runtime.system_context import reconcile_context
from runtime.session_events import append_event
from services.local_runner_manager import local_runner_manager
from services.local_project_grants import local_project_grants
from services.task_repository import save_task


router = APIRouter()
_device_channels: dict[tuple[str, str], WebSocket] = {}

CONNECTOR_PROTOCOL = "muhuo-autocode"
CONNECTOR_MIN_VERSION = os.getenv("AUTOCODE_LOCAL_CONNECTOR_MIN_VERSION", "0.4.12")
CONNECTOR_FILENAME = os.getenv("AUTOCODE_LOCAL_CONNECTOR_WINDOWS_FILENAME", "AutoCodeLocalConnectorSetup.exe")


class LocalRunnerModeRequest(BaseModel):
    enabled: bool = True
    project_path: str = ""
    public_api_base: str = ""
    grant_id: str = ""
    device_id: str = ""


class LocalRunnerSessionRequest(BaseModel):
    project_path: str = ""
    public_api_base: str = ""
    grant_id: str = ""


class LocalImportTaskRequest(BaseModel):
    title: str = "本地项目"
    project_path: str = ""
    enable_smart_planning: bool = False
    sync_to_cloud: bool = False
    model: str | None = None


class LocalConnectorAutoImportRequest(BaseModel):
    grant_id: str = ""
    project_path: str = ""
    project_name: str = ""
    device_id: str = ""
    device_name: str = ""
    device_os: str = ""
    public_api_base: str = ""
    enable_smart_planning: bool = False
    sync_to_cloud: bool = False
    model: str | None = None


class LocalProjectGrantRevokeRequest(BaseModel):
    grant_id: str


def _request_user_id(request: Request) -> str:
    return (request.headers.get("X-User-Id") or request.query_params.get("userId") or request.query_params.get("user_id") or "").strip()


def _runner_script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "local_runner" / "autocode_local_runner.py"


def _connector_windows_path() -> Path:
    return Path(__file__).resolve().parents[1] / "static" / "local-connector" / CONNECTOR_FILENAME


def _version_tuple(value: str) -> tuple[int, ...]:
    parts = []
    for part in re.split(r"[^0-9]+", value or ""):
        if part:
            try:
                parts.append(int(part))
            except ValueError:
                parts.append(0)
    return tuple(parts or [0])


def _version_lt(current: str, minimum: str) -> bool:
    cur = list(_version_tuple(current))
    min_ = list(_version_tuple(minimum))
    width = max(len(cur), len(min_))
    cur.extend([0] * (width - len(cur)))
    min_.extend([0] * (width - len(min_)))
    return tuple(cur) < tuple(min_)


def _public_api_base_url(request: Request) -> str:
    """Return the browser-facing AutoCode API base URL."""
    browser_origin = (request.headers.get("origin") or "").strip().rstrip("/")
    if not browser_origin:
        referer = (request.headers.get("referer") or "").strip()
        if referer:
            parsed_referer = urlparse(referer)
            if parsed_referer.scheme and parsed_referer.netloc:
                browser_origin = f"{parsed_referer.scheme}://{parsed_referer.netloc}".rstrip("/")
    if browser_origin:
        prefix = (request.headers.get("x-forwarded-prefix") or "").strip().rstrip("/") or "/autocode-api"
        if prefix and not browser_origin.endswith(prefix):
            return f"{browser_origin}{prefix}"
        return browser_origin

    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip()
    forwarded_host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",", 1)[0].strip()
    if not forwarded_proto and forwarded_host:
        host_only = forwarded_host.split(":", 1)[0].strip().lower()
        if host_only not in {"localhost", "127.0.0.1"} and not re.match(r"^\d{1,3}(?:\.\d{1,3}){3}$", host_only):
            forwarded_proto = "https"
    if forwarded_proto and forwarded_host:
        base_url = f"{forwarded_proto}://{forwarded_host}".rstrip("/")
    else:
        base_url = str(request.base_url).rstrip("/")
    prefix = (request.headers.get("x-forwarded-prefix") or "").strip().rstrip("/")
    if prefix and not base_url.endswith(prefix):
        return f"{base_url}{prefix}"
    return base_url


@router.get("/download")
async def download_local_runner():
    path = _runner_script_path()
    if not path.exists():
        raise HTTPException(status_code=404, detail="local runner script not found")
    return FileResponse(
        str(path),
        media_type="text/x-python",
        filename="autocode-local-runner.py",
    )


@router.get("/connector/windows/latest")
async def download_windows_connector():
    path = _connector_windows_path()
    if not path.exists():
        raise HTTPException(status_code=404, detail="AutoCode Local Connector installer is not available yet")
    return FileResponse(
        str(path),
        media_type="application/vnd.microsoft.portable-executable",
        filename=CONNECTOR_FILENAME,
    )


@router.get("/connector/metadata")
async def connector_metadata(request: Request):
    base_url = _public_api_base_url(request)
    installer = _connector_windows_path()
    installer_exists = installer.exists()
    installer_stat = installer.stat() if installer_exists else None
    return {
        "protocol": CONNECTOR_PROTOCOL,
        "connector_min_version": CONNECTOR_MIN_VERSION,
        "windows": {
            "min_version": CONNECTOR_MIN_VERSION,
            "install_url": f"{base_url}/api/local-runner/connector/windows/latest",
            "available": installer_exists,
            "filename": CONNECTOR_FILENAME,
            "size_bytes": installer_stat.st_size if installer_stat else 0,
            "updated_at": datetime.fromtimestamp(installer_stat.st_mtime).isoformat(timespec="seconds") if installer_stat else "",
        },
        "script_download_url": f"{base_url}/api/local-runner/download",
    }


@router.get("/grants")
async def list_local_project_grants(request: Request):
    user_id = _request_user_id(request)
    if not user_id:
        return {"items": []}
    items = []
    for grant in local_project_grants.list_for_user(user_id):
        device_id = str(grant.get("device_id") or "")
        online = bool(device_id and (user_id, device_id) in _device_channels)
        grant["device_status"] = "online" if online else "offline"
        grant["device_online"] = online
        items.append(grant)
    return {"items": items}


@router.post("/grants/revoke")
async def revoke_local_project_grant(payload: LocalProjectGrantRevokeRequest, request: Request):
    user_id = _request_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="missing user id")
    ok = local_project_grants.revoke(payload.grant_id, user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="local project grant not found")
    return {"ok": True}


@router.websocket("/device/ws/{device_id}")
async def local_runner_device_ws(websocket: WebSocket, device_id: str):
    grant_id = websocket.query_params.get("grant_id") or ""
    await websocket.accept()
    grant = local_project_grants.get(grant_id) if grant_id else None
    if not grant:
        await websocket.close(code=1008, reason="invalid local project grant")
        return
    user_id = str(grant.get("user_id") or "")
    if not user_id:
        await websocket.close(code=1008, reason="invalid local project user")
        return
    key = (user_id, device_id)
    old_ws = _device_channels.get(key)
    if old_ws and old_ws is not websocket:
        try:
            await old_ws.close(code=1012, reason="device reconnected")
        except Exception:
            pass
    _device_channels[key] = websocket
    try:
        await websocket.send_json({
            "type": "device_registered",
            "device_id": device_id,
            "server_time": datetime.utcnow().isoformat(),
        })
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            if message.get("type") == "device_heartbeat":
                local_project_grants.mark_device_seen(
                    grant_id=grant_id,
                    device_id=device_id,
                    device_name=str(message.get("device_name") or ""),
                    device_os=str(message.get("device_os") or ""),
                    runner_version=str(message.get("version") or ""),
                )
                await websocket.send_json({
                    "type": "device_heartbeat_ack",
                    "server_time": datetime.utcnow().isoformat(),
                })
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if _device_channels.get(key) is websocket:
            _device_channels.pop(key, None)


def _connector_launch_url(*, base_url: str, session_id: str, token: str, project_path: str, grant_id: str = "") -> str:
    query = "&".join([
        f"server={quote(base_url, safe='')}",
        f"session={quote(session_id, safe='')}",
        f"token={quote(token, safe='')}",
        f"project={quote(project_path or '', safe='')}",
        f"min_version={quote(CONNECTOR_MIN_VERSION, safe='')}",
        f"grant_id={quote(grant_id or '', safe='')}",
    ])
    return f"{CONNECTOR_PROTOCOL}://connect?{query}"


def _status_payload_with_command(
    session,
    request: Request | None = None,
    *,
    project_path: str = "",
    public_api_base: str = "",
) -> dict:
    payload = session.public_status(stale_after_seconds=local_runner_manager.stale_after_seconds)
    if request is not None:
        base_url = (public_api_base or session.public_api_base or "").strip().rstrip("/") or _public_api_base_url(request)
        ws_scheme = "wss" if base_url.startswith("https://") else "ws"
        parsed_base = base_url.replace("https://", "", 1).replace("http://", "", 1)
        project_arg = (project_path or session.command_project_path or "").strip()
        script_project_arg = project_arg or "<你的项目目录>"
        payload["download_url"] = f"{base_url}/api/local-runner/download"
        payload["script_download_url"] = payload["download_url"]
        payload["install_url"] = f"{base_url}/api/local-runner/connector/windows/latest"
        payload["connector_min_version"] = CONNECTOR_MIN_VERSION
        payload["connector_protocol"] = CONNECTOR_PROTOCOL
        payload["connector_available"] = _connector_windows_path().exists()
        runner_version = str(payload.get("runner_version") or "")
        payload["connector_update_required"] = bool(runner_version and _version_lt(runner_version, CONNECTOR_MIN_VERSION))
        payload["local_project_grant_id"] = getattr(session, "local_project_grant_id", "")
        payload["launch_url"] = _connector_launch_url(
            base_url=base_url,
            session_id=session.session_id,
            token=session.token,
            project_path=project_arg,
            grant_id=str(getattr(session, "local_project_grant_id", "") or ""),
        )
        payload["ws_url"] = f"{ws_scheme}://{parsed_base}/api/local-runner/ws/{session.session_id}?token={session.token}"
        payload["command"] = (
            f"python autocode-local-runner.py --server \"{base_url}\" "
            f"--session {session.session_id} --token {session.token} --project \"{script_project_arg}\""
        )
    return payload


async def _sync_local_snapshot_to_workspace(task_id: str, workspace_id: str) -> dict:
    snapshot = await local_runner_manager.execute_tool(
        task_id,
        "snapshot_files",
        {"max_files": 800, "max_total_bytes": 8 * 1024 * 1024, "max_file_bytes": 512 * 1024},
        timeout=180,
    )
    files = snapshot.get("files") if isinstance(snapshot, dict) else None
    if not isinstance(files, list):
        raise RuntimeError("local runner did not return a file snapshot")
    workspace = await docker_manager.create_workspace(workspace_id, "imported")
    ws_path = Path(workspace["path"]).resolve()
    for item in files:
        rel = str((item or {}).get("path") or "").strip().replace("\\", "/").lstrip("/")
        if not rel or ".." in Path(rel).parts:
            continue
        target = (ws_path / rel).resolve()
        try:
            target.relative_to(ws_path)
        except ValueError:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str((item or {}).get("content") or ""), encoding="utf-8")
    return {
        "file_count": len(files),
        "skipped_count": int(snapshot.get("skipped_count") or 0),
        "total_bytes": int(snapshot.get("total_bytes") or 0),
    }


def _initialize_imported_project_context(task: dict, *, project_root: str, cloud_snapshot_synced: bool) -> None:
    workspace_id = str(task.get("workspace_id") or "")
    context_payload = {
        "project_root": project_root,
        "workspace_id": workspace_id,
        "cloud_snapshot_synced": cloud_snapshot_synced,
        "index_docs": [],
        "message": (
            "本地导入项目已建立上下文索引；后续自然语言需求仍走 AI 路由，"
            "续跑默认复用该索引与上次检索计划。"
        ),
    }
    if cloud_snapshot_synced and workspace_id:
        try:
            ws_path = (get_settings().workspace_base_dir / workspace_id).resolve()
            autocode_dir = ws_path / ".autocode"
            autocode_dir.mkdir(parents=True, exist_ok=True)
            index = build_workspace_index(ws_path)
            source_files = [
                str(item.get("path") or "")
                for item in (index.get("files") or [])
                if item.get("is_source")
            ][:80]
            top_dirs = [str(item) for item in (index.get("top_level_dirs") or [])[:40]]
            (autocode_dir / "PROJECT_PROFILE.md").write_text(
                "\n".join([
                    "# Imported Project Profile",
                    "",
                    f"- project_root: `{project_root}`",
                    f"- workspace_id: `{workspace_id}`",
                    f"- total_files: {index.get('total_file_count', 0)}",
                    f"- source_files: {index.get('source_file_count', 0)}",
                    f"- top_dirs: {', '.join(top_dirs) if top_dirs else '(none)'}",
                    "",
                    "This project was imported through Local Connector. Reuse this profile before scanning.",
                ]),
                encoding="utf-8",
            )
            (autocode_dir / "PROJECT_MAP.md").write_text(
                "# Imported Project Map\n\n"
                + "\n".join(f"- `{path}`" for path in source_files)
                + ("\n" if source_files else "- No source files indexed.\n"),
                encoding="utf-8",
            )
            (autocode_dir / "COMMANDS.md").write_text(
                "# Imported Project Commands\n\n"
                "- Prefer Local Connector structured tools for local reads/writes.\n"
                "- Run project-specific validation only after inspecting existing scripts/configs.\n",
                encoding="utf-8",
            )
            manifest = reconcile_context(ws_path, workspace_id=workspace_id, task_id=str(task.get("id") or ""), write=True)
            context_payload.update({
                "index_docs": [
                    ".autocode/PROJECT_PROFILE.md",
                    ".autocode/PROJECT_MAP.md",
                    ".autocode/COMMANDS.md",
                ],
                "source_file_count": index.get("source_file_count", 0),
                "total_file_count": index.get("total_file_count", 0),
                "system_context_epoch": manifest.get("epoch"),
            })
            task["system_context_epoch"] = manifest.get("epoch")
        except Exception as exc:
            context_payload["index_error"] = str(exc)
    else:
        context_payload["message"] = (
            "本地项目已绑定但未同步云端快照；后续应通过 Local Connector 结构化工具按需读取，"
            "不要用 shell 反复探测 Windows 绝对路径。"
        )
    task["imported_project_context"] = context_payload
    append_event(task, "imported_project_context_initialized", context_payload, source="local_runner")


@router.post("/session")
async def create_local_runner_session(payload: LocalRunnerSessionRequest, request: Request):
    task_id = f"local-import-{os.urandom(8).hex()}"
    try:
        session = await local_runner_manager.enable(task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    user_id = _request_user_id(request)
    session.user_id = user_id
    session.public_api_base = (payload.public_api_base or _public_api_base_url(request)).strip().rstrip("/")
    grant = local_project_grants.get(payload.grant_id) if payload.grant_id else None
    if grant and str(grant.get("user_id") or "") == user_id:
        session.command_project_path = str(grant.get("project_root") or "")
        session.local_project_grant_id = str(grant.get("grant_id") or "")
    else:
        session.command_project_path = (payload.project_path or "").strip()
    return {
        **_status_payload_with_command(
            session,
            request,
            project_path=payload.project_path,
            public_api_base=session.public_api_base,
        ),
        "token": session.token,
    }


@router.get("/session/{session_id}/status")
async def local_runner_session_status(session_id: str, request: Request):
    session = local_runner_manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="local runner session not found")
    return _status_payload_with_command(session, request)


async def _register_local_import_task_from_session(
    *,
    session_id: str,
    payload: LocalImportTaskRequest,
    request: Request,
) -> dict:
    session = local_runner_manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="local runner session not found")
    if not session.connected:
        raise HTTPException(status_code=409, detail="本地连接器尚未连接")

    user_id = _request_user_id(request) or None
    if user_id:
        session.user_id = user_id
    task_id = f"task-local-{uuid.uuid4().hex[:12]}"
    workspace_id = f"local-{task_id}"
    project_root = (payload.project_path or session.project_root or session.command_project_path or "本地项目").strip()
    title = (payload.title or Path(project_root).name or "本地项目").strip()
    description = f"本地导入项目：{project_root}。后续请优先通过 Local Connector 在用户本机读取、修改和验证。"
    requested_model = (payload.model or "").strip() or None
    if requested_model and requested_model.lower() == "auto":
        requested_model = None

    await local_runner_manager.bind_session_to_task(session_id, task_id)
    session.command_project_path = project_root
    if not session.project_root:
        session.project_root = project_root
    grant = local_project_grants.upsert(
        user_id=str(user_id or session.user_id or "anonymous"),
        server_base=session.public_api_base or _public_api_base_url(request),
        project_root=project_root,
        task_id=task_id,
        workspace_id=workspace_id,
        runner_version=session.runner_version,
        device_id=str(getattr(session, "device_id", "") or ""),
        device_name=str(getattr(session, "device_name", "") or ""),
        device_os=str(getattr(session, "device_os", "") or ""),
    )
    session.local_project_grant_id = str(grant.get("grant_id") or "")

    now = datetime.utcnow().isoformat()
    task = {
        "id": task_id,
        "title": title,
        "description": description,
        "project_type": "imported",
        "status": "completed",
        "progress": 100,
        "current_step": "本地项目已连接，可在 AI 助手中输入需求继续开发。",
        "created_at": now,
        "workspace_id": workspace_id,
        "user_id": str(user_id) if user_id else None,
        "model": requested_model,
        "agents": ["frontend", "backend"],
        "logs": [
            {
                "timestamp": now,
                "agent": "local_runner",
                "level": "chat_assistant",
                "message": (
                    f"本地项目已连接：{project_root}\n\n"
                    "你可以继续在 AI 助手里描述修改需求。AutoCode 会优先通过本地连接器"
                    "读取、修改并验证你电脑上的项目文件。"
                ),
            }
        ],
        "commit_history": [],
        "preview_url": None,
        "plan": None,
        "project_recon": {
            "project_kind": "imported",
            "complexity": "S1",
            "recommended_flow": "agentic",
            "should_generate_prototype": False,
            "likely_stack": [],
            "entrypoints": [],
            "commands": {},
            "plan_guidance": ["本地项目已连接，后续应优先通过 Local Connector 读取、修改和验证。"],
        },
        "complexity": "S1",
        "recommended_flow": "agentic",
        "prototype_required": False,
        "current_subtask_id": None,
        "review": None,
        "phase_reviews": [],
        "prototype": None,
        "plan_confirmed": True,
        "prototype_confirmed": True,
        "review_confirmed": None,
        "enable_smart_planning": bool(payload.enable_smart_planning),
        "execution_mode": "agentic",
        "execution_target": "local_ide",
        "local_execution_enabled": True,
        "local_runner_session_id": session_id,
        "local_project_grant_id": str(grant.get("grant_id") or ""),
        "local_import_mode": True,
        "cloud_snapshot_enabled": bool(payload.sync_to_cloud),
        "cloud_snapshot_status": "pending" if payload.sync_to_cloud else "not_synced",
        "events": [],
    }
    _tasks[task_id] = task
    if requested_model:
        append_event(
            task,
            "task_model_selected",
            {"model": requested_model, "source": "local_project_import"},
            source="local_runner",
        )
    if payload.sync_to_cloud:
        try:
            snapshot_meta = await _sync_local_snapshot_to_workspace(task_id, workspace_id)
            task["cloud_snapshot_status"] = "synced"
            task["cloud_snapshot"] = snapshot_meta
            append_event(task, "local_snapshot_synced", snapshot_meta, source="local_runner")
        except Exception as exc:
            task["cloud_snapshot_status"] = "failed"
            task["cloud_snapshot_error"] = str(exc)
            append_event(task, "local_snapshot_sync_failed", {"error": str(exc)}, source="local_runner")
    _initialize_imported_project_context(
        task,
        project_root=project_root,
        cloud_snapshot_synced=task.get("cloud_snapshot_status") == "synced",
    )
    append_event(
        task,
        "local_runner_enabled",
        {
            "enabled": True,
            "session_id": session_id,
            "project_root": project_root,
            "local_project_grant_id": session.local_project_grant_id,
            "message": "本地执行已启用，后续工具调用将优先走 Local Connector。",
        },
        source="local_runner",
    )
    append_event(task, "local_runner_connected", {"session_id": session_id, "project_root": project_root}, source="local_runner")
    save_task(dict(task))
    return {**task, "local_runner": _status_payload_with_command(session, request, project_path=project_root)}


@router.post("/session/{session_id}/register-task")
async def register_local_import_task(session_id: str, payload: LocalImportTaskRequest, request: Request):
    return await _register_local_import_task_from_session(session_id=session_id, payload=payload, request=request)


@router.post("/connector/auto-import")
async def connector_auto_import_local_project(payload: LocalConnectorAutoImportRequest, request: Request):
    """Import a local project selected inside the desktop connector.

    This endpoint avoids relying on the browser to successfully dispatch a second
    muhuo-autocode:// deep link. The already-running connector advertises a device
    channel for the local grant; once the web app registers that grant here, the
    backend can push a connect_request through the device channel and create the
    task after the runner attaches.
    """
    user_id = _request_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="missing user id")
    project_path = (payload.project_path or "").strip()
    if not project_path:
        raise HTTPException(status_code=400, detail="project_path is required")

    public_api_base = (payload.public_api_base or _public_api_base_url(request)).strip().rstrip("/")
    grant = local_project_grants.upsert(
        user_id=user_id,
        server_base=public_api_base,
        project_root=project_path,
        grant_id=(payload.grant_id or "").strip(),
        task_id="",
        workspace_id="",
        device_id=(payload.device_id or "").strip(),
        device_name=(payload.device_name or "").strip(),
        device_os=(payload.device_os or "").strip(),
    )
    grant_id = str(grant.get("grant_id") or "")
    device_id = str(grant.get("device_id") or payload.device_id or "").strip()
    if not device_id:
        raise HTTPException(status_code=409, detail="连接器设备信息缺失，请升级并重新打开 AutoCode Local Connector")

    task_id = f"local-import-{os.urandom(8).hex()}"
    try:
        session = await local_runner_manager.enable(task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    session.user_id = user_id
    session.public_api_base = public_api_base
    session.command_project_path = project_path
    session.local_project_grant_id = grant_id

    device_ws = _device_channels.get((user_id, device_id))
    if not device_ws:
        raise HTTPException(status_code=409, detail="连接器设备通道未在线，请保持 AutoCode Local Connector 打开后重试")
    try:
        await device_ws.send_json({
            "type": "connect_request",
            "server": session.public_api_base or _public_api_base_url(request),
            "session": session.session_id,
            "token": session.token,
            "project": project_path,
            "min_version": CONNECTOR_MIN_VERSION,
            "grant_id": grant_id,
            "task_id": task_id,
        })
    except Exception as exc:
        raise HTTPException(status_code=409, detail=f"向连接器发送连接请求失败：{exc}") from exc

    deadline = datetime.utcnow().timestamp() + 20
    while datetime.utcnow().timestamp() < deadline:
        if session.connected:
            break
        await asyncio.sleep(0.5)
    if not session.connected:
        raise HTTPException(status_code=409, detail="已向连接器发送请求，但本地 Runner 未在 20 秒内连接")

    title = (payload.project_name or Path(project_path).name or "本地项目").strip()
    return await _register_local_import_task_from_session(
        session_id=session.session_id,
        payload=LocalImportTaskRequest(
            title=title,
            project_path=project_path,
            enable_smart_planning=payload.enable_smart_planning,
            sync_to_cloud=payload.sync_to_cloud,
            model=payload.model,
        ),
        request=request,
    )


@router.get("/{task_id}/status")
async def local_runner_status(task_id: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="task not found")
    task = _tasks.get(task_id) or {}
    session = await local_runner_manager.ensure_task_binding(task_id, str(task.get("local_runner_session_id") or ""))
    if not session:
        return {"enabled": False, "connected": False, "connection_state": "disabled"}
    user_id = _request_user_id(request) or str(task.get("user_id") or "")
    if not session.local_project_grant_id:
        grant = local_project_grants.get(str(task.get("local_project_grant_id") or "")) if task.get("local_project_grant_id") else None
        if not grant:
            grant = local_project_grants.find_for_task(user_id=user_id, task_id=task_id)
        if grant:
            session.local_project_grant_id = str(grant.get("grant_id") or "")
            session.command_project_path = str(grant.get("project_root") or session.command_project_path or "")
            task["local_project_grant_id"] = session.local_project_grant_id
            save_task(dict(task))
    return _status_payload_with_command(session, request)


@router.post("/{task_id}/sync-snapshot")
async def sync_local_runner_snapshot(task_id: str, request: Request):
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    if not task.get("local_import_mode"):
        raise HTTPException(status_code=400, detail="只有本地 IDE 互联任务需要同步云端副本")
    request_user_id = _request_user_id(request)
    task_user_id = str(task.get("user_id") or "")
    if task_user_id and request_user_id and task_user_id != request_user_id:
        raise HTTPException(status_code=403, detail="无权操作该任务")
    session = await local_runner_manager.ensure_task_binding(task_id, str(task.get("local_runner_session_id") or ""))
    if not session or not session.enabled or not session.connected:
        raise HTTPException(status_code=409, detail="请先连接本地连接器，再同步云端副本")

    workspace_id = str(task.get("workspace_id") or f"local-{task_id}")
    task["cloud_snapshot_enabled"] = True
    task["cloud_snapshot_status"] = "pending"
    task["cloud_snapshot_error"] = ""
    append_event(task, "local_snapshot_sync_started", {"workspace_id": workspace_id}, source="local_runner")
    save_task(dict(task))
    try:
        snapshot_meta = await _sync_local_snapshot_to_workspace(task_id, workspace_id)
        task["cloud_snapshot_status"] = "synced"
        task["cloud_snapshot"] = snapshot_meta
        task["cloud_snapshot_error"] = ""
        append_event(task, "local_snapshot_synced", snapshot_meta, source="local_runner")
    except Exception as exc:
        task["cloud_snapshot_status"] = "failed"
        task["cloud_snapshot_error"] = str(exc)
        append_event(task, "local_snapshot_sync_failed", {"error": str(exc)}, source="local_runner")
        save_task(dict(task))
        raise HTTPException(status_code=500, detail=f"同步云端副本失败：{exc}") from exc
    save_task(dict(task))
    return {**task, "local_runner": _status_payload_with_command(session, request, project_path=session.project_root)}


@router.post("/{task_id}/mode")
async def set_local_runner_mode(task_id: str, payload: LocalRunnerModeRequest, request: Request):
    task = _tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")

    if not payload.enabled:
        if task.get("local_import_mode") and task.get("cloud_snapshot_status") != "synced":
            raise HTTPException(
                status_code=409,
                detail="该任务是未同步云端的本地 IDE 互联任务。切回云端工作区后云端没有可操作的项目文件，请先同步云端副本或继续使用本地 IDE 互联。",
            )
        await local_runner_manager.disable(task_id)
        task["local_execution_enabled"] = False
        task["execution_target"] = "cloud_workspace"
        append_event(task, "local_runner_disabled", {"enabled": False}, source="local_runner")
        save_task(dict(task))
        return {"enabled": False, "connected": False, "connection_state": "disabled"}

    try:
        session = await local_runner_manager.enable(task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    if payload.public_api_base:
        session.public_api_base = payload.public_api_base.strip().rstrip("/")
    elif not session.public_api_base:
        session.public_api_base = _public_api_base_url(request).strip().rstrip("/")
    user_id = _request_user_id(request)
    if user_id:
        session.user_id = user_id
    preferred_grant_id = payload.grant_id or str(task.get("local_project_grant_id") or "")
    grant = local_project_grants.get(preferred_grant_id) if preferred_grant_id else None
    if not grant:
        grant = local_project_grants.find_for_task(user_id=user_id, task_id=task_id)
    if grant and str(grant.get("user_id") or "") == user_id:
        session.command_project_path = str(grant.get("project_root") or "")
        session.local_project_grant_id = str(grant.get("grant_id") or "")
        task["local_project_grant_id"] = session.local_project_grant_id
    elif payload.project_path:
        session.command_project_path = payload.project_path.strip()

    target_device_id = (payload.device_id or str((grant or {}).get("device_id") or "")).strip()
    if payload.device_id:
        device_ws = _device_channels.get((user_id, target_device_id))
        if not device_ws:
            raise HTTPException(status_code=409, detail="目标设备不在线，请在该电脑打开 AutoCode Local Connector")
        try:
            await device_ws.send_json({
                "type": "connect_request",
                "server": session.public_api_base or _public_api_base_url(request),
                "session": session.session_id,
                "token": session.token,
                "project": session.command_project_path or "",
                "min_version": CONNECTOR_MIN_VERSION,
                "grant_id": session.local_project_grant_id,
                "task_id": task_id,
            })
        except Exception as exc:
            raise HTTPException(status_code=409, detail=f"目标设备连接请求发送失败：{exc}") from exc

    task["local_execution_enabled"] = True
    task["execution_target"] = "local_ide"
    task["local_runner_session_id"] = session.session_id
    append_event(
        task,
        "local_runner_enabled",
        {
            "enabled": True,
            "session_id": session.session_id,
            "install_url": "/api/local-runner/connector/windows/latest",
            "download_url": "/api/local-runner/download",
            "message": "本地执行已启用，请一键唤起 AutoCode Local Connector。",
        },
        source="local_runner",
    )
    save_task(dict(task))
    return {
        **_status_payload_with_command(
            session,
            request,
            project_path=session.command_project_path or "",
            public_api_base=session.public_api_base,
        ),
        "token": session.token,
    }


@router.websocket("/ws/{session_id}")
async def local_runner_ws(websocket: WebSocket, session_id: str):
    token = websocket.query_params.get("token") or ""
    await websocket.accept()
    try:
        session = await local_runner_manager.attach(session_id, token, websocket)
    except PermissionError:
        return

    task = _tasks.get(session.task_id)
    if task:
        append_event(task, "local_runner_connected", {"session_id": session_id}, source="local_runner")
        save_task(dict(task))
    try:
        while True:
            message = await websocket.receive_json()
            await local_runner_manager.receive_message(session_id, message)
            if isinstance(message, dict) and message.get("type") == "heartbeat":
                await websocket.send_json({
                    "type": "heartbeat_ack",
                    "session_id": session_id,
                    "server_time": datetime.utcnow().isoformat(),
                })
                continue
            if isinstance(message, dict) and message.get("type") == "hello":
                task = _tasks.get(session.task_id)
                project_root = str(message.get("project_root") or session.project_root or session.command_project_path or "")
                grant = None
                if project_root:
                    grant = local_project_grants.upsert(
                        user_id=str(session.user_id or (task or {}).get("user_id") or "anonymous"),
                        server_base=session.public_api_base or "",
                        project_root=project_root,
                        task_id=str((task or {}).get("id") or session.task_id or ""),
                        workspace_id=str((task or {}).get("workspace_id") or ""),
                        runner_version=str(message.get("version") or session.runner_version or ""),
                        device_id=str(message.get("device_id") or session.device_id or ""),
                        device_name=str(message.get("device_name") or session.device_name or ""),
                        device_os=str(message.get("device_os") or session.device_os or ""),
                    )
                    session.local_project_grant_id = str(grant.get("grant_id") or "")
                    await websocket.send_json({"type": "local_project_grant", **grant})
                if task:
                    append_event(
                        task,
                        "local_runner_hello",
                        {
                            "session_id": session_id,
                            "project_root": message.get("project_root"),
                            "version": message.get("version"),
                            "local_project_grant_id": session.local_project_grant_id,
                        },
                        source="local_runner",
                    )
                    save_task(dict(task))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await local_runner_manager.detach(session_id, websocket, reason="websocket closed")
        task = _tasks.get(session.task_id)
        if task:
            append_event(task, "local_runner_disconnected", {"session_id": session_id}, source="local_runner")
            save_task(dict(task))

