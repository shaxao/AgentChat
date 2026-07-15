# -*- coding: utf-8 -*-
"""
AutoCode Agent Platform — FastAPI Backend
Task orchestration + Claude SDK Agent + Docker Workspace + Git + WebSocket Terminal
"""
import asyncio
import io
import os
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from urllib.parse import quote

# Windows GBK 编码兼容：强制 stdout/stderr 使用 UTF-8
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
import httpx

from api import tasks, workspaces, git, terminal, agents, dev_servers, deploy, routing, projects, prototype, memory, local_runner, cache
from api.workspace_security import safe_child_path, verify_workspace_access, verify_workspace_user
from core.config import settings
from core.docker_manager import docker_manager
from services.task_queue import task_queue
from services.terminal_manager import terminal_manager


def _preview_access_query(request: Request) -> str:
    for key in ("user_id", "userId"):
        value = request.query_params.get(key)
        if value and value.strip():
            return f"{key}={quote(value.strip())}"
    return ""


def _append_preview_access(url: str, access_query: str) -> str:
    if not access_query or "user_id=" in url or "userId=" in url:
        return url
    if "#" in url:
        url, fragment = url.split("#", 1)
        suffix = f"#{fragment}"
    else:
        suffix = ""
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{access_query}{suffix}"


def _with_forwarded_prefix(path: str, request: Request) -> str:
    prefix = (
        request.headers.get("x-forwarded-prefix")
        or request.headers.get("X-Forwarded-Prefix")
        or request.scope.get("root_path", "")
        or ""
    ).rstrip("/")
    if prefix and path.startswith("/") and not path.startswith(prefix + "/"):
        return f"{prefix}{path}"
    return path


def _rewrite_preview_html(html_content: str, preview_base: str, request: Request) -> str:
    """Keep absolute in-app links inside the workspace preview proxy."""
    access_query = _preview_access_query(request)
    preview_base = _with_forwarded_prefix(preview_base.rstrip("/"), request)

    def rewrite_url(raw: str, *, add_access: bool) -> str:
        if not raw or raw.startswith(("#", "//")):
            return raw
        lowered = raw.lower()
        if lowered.startswith(("http://", "https://", "mailto:", "tel:", "javascript:", "data:", "blob:")):
            return raw
        if raw.startswith("/autocode-api/"):
            return _append_preview_access(raw, access_query) if add_access and "/workspaces/" in raw else raw
        if raw.startswith(preview_base + "/"):
            return _append_preview_access(raw, access_query) if add_access and "/workspaces/" in raw else raw
        if raw.startswith(("/workspaces/", "/api/proxy/")):
            rewritten = _with_forwarded_prefix(raw, request)
            return _append_preview_access(rewritten, access_query) if add_access and "/workspaces/" in rewritten else rewritten
        if raw.startswith("/api/"):
            return raw
        relative = raw
        while relative.startswith("./"):
            relative = relative[2:]
        while relative.startswith("../"):
            relative = relative[3:]
        if relative and relative != raw:
            rewritten = f"{preview_base}/{relative.lstrip('/')}"
            return _append_preview_access(rewritten, access_query) if add_access else rewritten
        if relative.startswith(("_next/", "assets/")):
            rewritten = f"{preview_base}/{relative}"
            return _append_preview_access(rewritten, access_query) if add_access else rewritten
        if add_access and relative and not relative.startswith(("#", "?")):
            rewritten = f"{preview_base}/{relative.lstrip('/')}"
            return _append_preview_access(rewritten, access_query)
        if raw == "/":
            rewritten = preview_base
        elif raw.startswith("/"):
            rewritten = f"{preview_base}{raw}"
        else:
            return raw
        return _append_preview_access(rewritten, access_query) if add_access else rewritten

    def replace_attr(match: re.Match) -> str:
        attr, quote_char, value = match.group(1), match.group(2), match.group(3)
        rewritten = rewrite_url(value, add_access=attr.lower() in {"href", "action"})
        return f'{attr}={quote_char}{rewritten}{quote_char}'

    html_content = re.sub(
        r'\b(href|src|action)=([\'"])([^\'"]*)\2',
        replace_attr,
        html_content,
        flags=re.IGNORECASE,
    )

    def replace_json_url(match: re.Match) -> str:
        prefix, key, value = match.group(1), match.group(2), match.group(3)
        rewritten = rewrite_url(value, add_access=key.lower() in {"href", "action"})
        return f"{prefix}{rewritten}"

    # Next/Vite can embed route and asset paths in JSON/RSC script strings.
    html_content = re.sub(
        r'(\\?"(href|src|action)\\?"\s*:\s*\\?")(/[^"\\]*)',
        replace_json_url,
        html_content,
        flags=re.IGNORECASE,
    )
    html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
    html_content = html_content.replace('"/assets/', f'"{preview_base}/assets/')
    html_content = html_content.replace('\\"/_next/', f'\\"{preview_base}/_next/')
    html_content = html_content.replace('\\"/assets/', f'\\"{preview_base}/assets/')
    return html_content


async def _run_background_startup_init(mysql_ok: bool) -> None:
    """Run DB-backed startup work without blocking uvicorn from listening."""
    if not mysql_ok:
        return

    try:
        from core.migrations import run_migrations
        await asyncio.to_thread(lambda: asyncio.run(run_migrations()))
    except Exception as e:
        print(f"[AutoCode] Migration failed: {e}")

    try:
        from api.tasks import restore_tasks
        count = await asyncio.to_thread(restore_tasks)
        print(f"[AutoCode] Restored {count} historical tasks from MySQL")
    except Exception as e:
        print(f"[AutoCode] Task restore failed: {e}")

    try:
        from services.memory_service import memory_service
        await asyncio.to_thread(memory_service.init)
        print("[AutoCode] Memory tables ready (agent_memory / memory_search)")
    except Exception as e:
        print(f"[AutoCode] Memory init failed: {e}")

    try:
        from services.cache_ledger_service import cache_ledger_service
        await asyncio.to_thread(cache_ledger_service.init)
        print("[AutoCode] Cache ledger tables ready")
    except Exception as e:
        print(f"[AutoCode] Cache ledger init failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Init on startup, cleanup on shutdown."""
    print(f"[AutoCode] {'='*40}")
    print(f"[AutoCode] Starting AutoCode Agent Platform")
    print(f"[AutoCode] WORKSPACE_DIR={settings.workspace_base_dir}")
    print(f"[AutoCode] Python={sys.version.split()[0]}")
    print(f"[AutoCode] {'='*40}")

    # Ensure workspace directory exists
    settings.workspace_base_dir.mkdir(parents=True, exist_ok=True)
    task_queue.start(worker_count=max(1, min(settings.max_concurrent_tasks, 3)))

    # Initialize Docker connection
    docker_ok = False
    if settings.docker_disabled:
        print("[AutoCode] ⏭️  Docker DISABLED via AUTOCODE_DISABLE_DOCKER — using local execution mode")
        print(f"[AutoCode]    → Workspaces will use local filesystem at: {settings.workspace_base_dir}")
    else:
        try:
            docker_manager.ping()
            docker_ok = True
            print("[AutoCode] ✅ Docker connected — container isolation ENABLED")
        except Exception as e:
            print(f"[AutoCode] ⚠️  Docker unavailable: {e}")
            print(f"[AutoCode]    → Running in LOCAL mode (no container isolation)")
            print(f"[AutoCode]    → Workspaces will use local filesystem at: {settings.workspace_base_dir}")

    # Test MySQL connection
    mysql_ok = False
    try:
        from services.task_repository import _test_mysql_connection
        mysql_ok = _test_mysql_connection()
    except Exception as e:
        print(f"[AutoCode] ⚠️  MySQL test failed: {e}")

    if mysql_ok:
        print("[AutoCode] MySQL connected; DB startup init is running in background")
        asyncio.create_task(_run_background_startup_init(mysql_ok))

    if False and mysql_ok:
        print(f"[AutoCode] ✅ MySQL connected — task persistence ENABLED")

        # 自动执行数据库迁移（建表 + 加字段 + 种子数据）
        # 所有操作都是幂等的，部署到新服务器无需手动操作
        try:
            from core.migrations import run_migrations
            await run_migrations()
        except Exception as e:
            print(f"[AutoCode] ⚠️  Migration failed: {e}")

        # Restore historical tasks from MySQL
        try:
            from api.tasks import restore_tasks
            count = restore_tasks()
            print(f"[AutoCode] ✅ Restored {count} historical tasks from MySQL")
        except Exception as e:
            print(f"[AutoCode] ⚠️  Task restore failed: {e}")

        # 初始化五层记忆 L2/L3 数据表（轻量替代 ES/Milvus：MySQL FULLTEXT + Redis）
        try:
            from services.memory_service import memory_service
            memory_service.init()
            print(f"[AutoCode] ✅ Memory tables ready (agent_memory / memory_search)")
        except Exception as e:
            print(f"[AutoCode] ⚠️  Memory init failed: {e}")
    if not mysql_ok:
        print(f"[AutoCode] ⚠️  MySQL unavailable — using IN-MEMORY task storage")
        print(f"[AutoCode]    → Tasks will be lost on service restart")

    print(f"[AutoCode] {'='*40}")
    print(f"[AutoCode] Ready! Visit: http://localhost:8000/docs")

    # 启动 dev server 清理任务（超时自动停止闲置预览）
    try:
        from services.dev_server_manager import dev_server_manager
        timeout = int(os.getenv("AUTOCODE_PREVIEW_TIMEOUT", "3600"))
        # start_cleanup_task 是协程，必须 create_task 调度而非同步调用
        asyncio.create_task(dev_server_manager.start_cleanup_task(timeout_seconds=timeout, check_interval=300))
    except Exception as e:
        print(f"[AutoCode] ⚠️  DevServer cleanup task start failed: {e}")

    yield

    # Cleanup: stop all active sessions
    await task_queue.stop()
    await terminal_manager.cleanup_all()
    # 停止所有 dev server
    try:
        from services.dev_server_manager import dev_server_manager
        sessions = await dev_server_manager.list_sessions()
        for s in sessions:
            await dev_server_manager.stop_dev_server(s["workspace_id"])
        print("[AutoCode] All dev servers stopped")
    except Exception as e:
        print(f"[AutoCode] ⚠️  DevServer cleanup failed: {e}")
    print("[AutoCode] Shutdown complete")


app = FastAPI(
    title="AutoCode Agent Platform",
    description="Autonomous AI coding agent system — cloud Docker isolation",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(tasks.router, prefix="/api/tasks", tags=["Tasks"])
app.include_router(workspaces.router, prefix="/api/workspaces", tags=["Workspaces"])
app.include_router(git.router, prefix="/api/git", tags=["Git"])
app.include_router(terminal.router, prefix="/api/terminal", tags=["Terminal"])
app.include_router(agents.router, prefix="/api/agents", tags=["Agents"])
app.include_router(dev_servers.router, prefix="/api", tags=["DevServer"])
app.include_router(deploy.router, prefix="/api", tags=["Deploy"])
app.include_router(routing.router, prefix="/api/routing", tags=["Routing"])
app.include_router(projects.router, prefix="/api")
app.include_router(prototype.router)
app.include_router(memory.router, prefix="/api/memory", tags=["Memory"])
app.include_router(local_runner.router, prefix="/api/local-runner", tags=["LocalRunner"])
app.include_router(cache.router, prefix="/api/cache", tags=["Cache"])


@app.post("/api/workspaces/{workspace_id}/heartbeat")
async def workspace_heartbeat(workspace_id: str, request: Request):
    """前端心跳：通知后端该 workspace 的预览还在使用（重置闲置计时器）"""
    try:
        verify_workspace_access(workspace_id, request)
        from services.dev_server_manager import dev_server_manager
        alive = await dev_server_manager.heartbeat(workspace_id)
        return {"ok": True, "preview_alive": alive}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "workspace_dir": str(settings.workspace_base_dir),
        "docker": docker_manager.is_connected,
    }


@app.get("/api/system/status")
async def system_status():
    return {
        "active_workspaces": len(terminal_manager.active_sessions),
        "docker_available": docker_manager.is_connected,
        "max_concurrent_tasks": settings.max_concurrent_tasks,
    }


# WebSocket — Terminal
@app.websocket("/ws/terminal/{workspace_id}")
async def terminal_ws(ws: WebSocket, workspace_id: str):
    user_id = ws.query_params.get("user_id") or ws.query_params.get("userId")
    try:
        verify_workspace_user(workspace_id, user_id)
    except HTTPException as exc:
        await ws.close(code=1008, reason=str(exc.detail))
        return
    await terminal_manager.connect(ws, workspace_id)
    try:
        while True:
            data = await ws.receive_text()
            await terminal_manager.handle_input(workspace_id, data)
    except WebSocketDisconnect:
        await terminal_manager.disconnect(workspace_id)


# ── Workspace 预览代理（将 Dev Server 请求转发到容器内）────────────
@app.api_route("/api/proxy/{workspace_id}/", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
@app.api_route("/api/proxy/{workspace_id}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def proxy_workspace(workspace_id: str, request: Request, path: str = ""):
    """
    将前端 iframe 请求代理到 Workspace 内 Dev Server。
    Dev Server 在容器内运行，暴露在 host 端口上。
    """
    from services.dev_server_manager import dev_server_manager
    verify_workspace_access(workspace_id, request)
    session = await dev_server_manager.get_session(workspace_id)

    if not session or not session.url:
        return Response(
            content="<h2>Dev Server 未启动</h2><p>等待 Agent 构建完成...</p>",
            media_type="text/html",
            status_code=503,
        )

    # 转发请求到 dev server
    request_path = request.url.path
    # 去掉 /api/proxy/{workspace_id}/ 前缀
    remainder = request_path.split(f"/api/proxy/{workspace_id}/", 1)[-1] or ""
    target_url = f"{session.url.rstrip('/')}/{remainder}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in ("host", "connection")}
        try:
            req_body = await request.body()
            upstream = await client.request(
                method=request.method,
                url=target_url,
                headers=headers,
                content=req_body if req_body else None,
            )
            content = upstream.content
            headers = dict(upstream.headers)
            content_type = headers.get("content-type", "")
            if "text/html" in content_type.lower():
                html = content.decode(upstream.encoding or "utf-8", errors="replace")
                content = _rewrite_preview_html(html, f"/api/proxy/{workspace_id}", request).encode("utf-8")
                headers.pop("content-length", None)
                headers.pop("content-encoding", None)
            return Response(content=content, status_code=upstream.status_code, headers=headers)
        except Exception as e:
            return Response(content=str(e), status_code=502)


# ── Workspace 静态文件预览（Dev Server 未启动时直接预览文件）────────
@app.get("/workspaces/{workspace_id}/preview")
async def workspace_preview(workspace_id: str, request: Request):
    """
    直接从 workspace 目录提供静态文件预览。
    优先返回 out/index.html（Next.js 静态导出），
    再尝试 dist/index.html（Vite），
    再尝试 index.html（根目录），
    否则列出文件。

    注意：返回 index.html 时注入 <base href> 以修正绝对路径资源引用。
    """
    ws_path, _ = verify_workspace_access(workspace_id, request)

    # 优先 out/index.html（Next.js output: 'export'）
    out_index = ws_path / "out" / "index.html"
    if out_index.exists():
        html_content = out_index.read_text(encoding="utf-8")
        # 修正 Next.js 静态资源的绝对路径，将 /_next/ 替换为工作空间预览路径
        preview_base = f"/workspaces/{workspace_id}/preview"
        html_content = html_content.replace('href="/_next/', f'href="{preview_base}/_next/')
        html_content = html_content.replace("href='/_next/", f"href='{preview_base}/_next/")
        html_content = html_content.replace('src="/_next/', f'src="{preview_base}/_next/')
        html_content = html_content.replace("src='/_next/", f"src='{preview_base}/_next/")
        # 修正 JSON 格式的 href（Next.js 内联 RSC）
        html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
        html_content = _rewrite_preview_html(html_content, preview_base, request)
        # 修正 <link rel="preload"> 中的 as 属性（也有 /_next/）
        return Response(content=html_content, media_type="text/html")

    # 尝试 dist/index.html（Vite build 输出）
    dist_index = ws_path / "dist" / "index.html"
    if dist_index.exists():
        html_content = dist_index.read_text(encoding="utf-8")
        preview_base = f"/workspaces/{workspace_id}/preview"
        html_content = html_content.replace('href="/assets/', f'href="{preview_base}/assets/')
        html_content = html_content.replace('src="/assets/', f'src="{preview_base}/assets/')
        html_content = _rewrite_preview_html(html_content, preview_base, request)
        return Response(content=html_content, media_type="text/html")

    # 尝试 index.html（根目录）
    index = ws_path / "index.html"
    if index.exists():
        html_content = index.read_text(encoding="utf-8")
        preview_base = f"/workspaces/{workspace_id}/preview"
        html_content = _rewrite_preview_html(html_content, preview_base, request)
        return Response(content=html_content, media_type="text/html")

    # 无静态文件且无 Dev Server → 提供有用的诊断信息
    has_src = (ws_path / "src").is_dir()
    has_package = (ws_path / "package.json").exists()
    next_config = (ws_path / "next.config.js").exists() or (ws_path / "next.config.ts").exists() or (ws_path / "next.config.mjs").exists()

    # 尝试检测是否有进程在监听（Dev Server 可能已启动但未被检测到）
    import socket
    detected_url = None
    for probe_port in [3000, 3001, 3101, 3102, 5173, 5174]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.3)
            result = s.connect_ex(("127.0.0.1", probe_port))
            s.close()
            if result == 0:
                detected_url = f"http://127.0.0.1:{probe_port}"
                break
        except Exception:
            pass

    diagnostics = []
    if next_config and not (ws_path / "out" / "index.html").exists():
        diagnostics.append("⚠️ 检测到 Next.js 项目但未配置静态导出（output: 'export'），建议在 next.config 中添加")
    if has_package and not (ws_path / "node_modules").exists():
        diagnostics.append("⚠️ 存在 package.json 但 node_modules 缺失，依赖可能未安装完成")
    if detected_url:
        diagnostics.append(f"✅ 检测到本地服务已在运行：{detected_url} （可尝试直接访问）")

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Workspace {workspace_id}</title>
<style>
  body{{font-family:system-ui;padding:2rem;background:#0f172a;color:#e2e8f0;max-width:800px;margin:0 auto}}
  h1{{font-size:1.25rem;margin-bottom:.5rem;color:#f8fafc}}
  .sub{{color:#94a3b8;font-size:.875rem;margin-bottom:1.5rem}}
  .card{{background:#1e293b;border-radius:.75rem;padding:1.25rem;margin:1rem 0;border:1px solid #334155}}
  .card h2{{margin:0 0 .75rem;font-size:1rem;color:#f1f5f9}}
  ul{{margin:0;padding-left:1.25rem}}
  li{{margin:.4rem 0;line-height:1.6}}
  .file-list{{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}}
  .file-tag{{background:#334155;padding:.35rem .7rem;border-radius:.375rem;font-size:.8rem;color:#93c5fd;cursor:pointer}}
  .file-tag:hover{{background:#475569}}
  .ok{{color:#4ade80}} .warn{{color:#fbbf24}} .err{{color:#f87171}}
  a{{color:#60a5fa;text-decoration:none}}
  a:hover{{text-decoration:underline}}
</style></head>
<body>
<h1>📁 {workspace_id}</h1>
<p class="sub">预览就绪 — {"Dev Server 运行中" if detected_url else "等待 Dev Server 或使用静态文件"}</p>"""

    if detected_url:
        html += f"""
<div class="card">
<h2>🌐 检测到本地服务</h2>
<p style="margin:0"><a href="{detected_url}" target="_blank" style="font-size:1.1rem;font-weight:600">{detected_url}</a>
<span style="color:#4ade80;margin-left:.5rem">● 在线</span></p>
<p style="color:#94a3b8;font-size:.85rem;margin:.5rem 0 0">点击链接在新窗口中打开（如无法访问请刷新重试）</p>
</div>"""

    if diagnostics:
        html += f"""
<div class="card">
<h2>🔍 诊断信息</h2>
<ul>
{"".join(f"<li>{d}</li>" for d in diagnostics)}
</ul>
</div>"""

    # 文件列表
    files = [item.name for item in sorted(ws_path.iterdir()) if not item.name.startswith('.')]
    if files:
        html += f"""
<div class="card">
<h2>📂 工作空间文件 ({len(files)} 个)</h2>
<div class="file-list">
{"".join(f'<span class="file-tag">{"📁" if (ws_path/f).is_dir() else "📄"} <a href="/workspaces/{workspace_id}/preview/{f}">{f}</a></span>' for f in files[:20])}
</div>
</div>"""

    html += "\n</body></html>"
    return Response(content=html, media_type="text/html")


def _find_next_preview_asset(ws_path: Path, path: str) -> Optional[Path]:
    rel = (path or "").replace("\\", "/").lstrip("/")
    candidates = (
        ws_path / "out" / "_next",
        ws_path / ".next",
        ws_path / ".next" / "static",
    )
    for base in candidates:
        candidate = safe_child_path(base, rel)
        if candidate.exists() and candidate.is_file():
            return candidate

    filename = Path(rel).name
    if not filename:
        return None
    for base in candidates:
        if not base.exists():
            continue
        try:
            for candidate in base.rglob(filename):
                if candidate.is_file():
                    return candidate
        except Exception:
            continue
    return None


def _serve_preview_asset(candidate: Path, preview_base: str, request: Request):
    preview_base = _with_forwarded_prefix(preview_base.rstrip("/"), request)
    if candidate.suffix.lower() == ".js":
        content = candidate.read_text(encoding="utf-8", errors="replace")
        next_base = f"{preview_base}/_next/"
        content = content.replace('"/_next/', f'"{next_base}')
        content = content.replace("'/_next/", f"'{next_base}")
        content = content.replace('\\"/_next/', f'\\"{next_base}')
        return Response(
            content=content,
            media_type="application/javascript",
            headers={"Cache-Control": "no-store"},
        )
    if candidate.suffix.lower() == ".css":
        content = candidate.read_text(encoding="utf-8", errors="replace")
        content = content.replace("url(/_next/", f"url({preview_base}/_next/")
        content = content.replace("url('/_next/", f"url('{preview_base}/_next/")
        content = content.replace('url("/_next/', f'url("{preview_base}/_next/')
        content = content.replace("url(/assets/", f"url({preview_base}/assets/")
        content = content.replace("url('/assets/", f"url('{preview_base}/assets/")
        content = content.replace('url("/assets/', f'url("{preview_base}/assets/')
        return Response(
            content=content,
            media_type="text/css",
            headers={"Cache-Control": "no-store"},
        )
    return FileResponse(str(candidate))


@app.get("/workspaces/{workspace_id}/preview/_next/{path:path}")
async def workspace_preview_next_asset(workspace_id: str, path: str, request: Request):
    """Serve Next.js assets under the workspace preview prefix."""
    ws_path, _ = verify_workspace_access(workspace_id, request)
    candidate = _find_next_preview_asset(ws_path, path)
    if candidate:
        return _serve_preview_asset(candidate, f"/workspaces/{workspace_id}/preview", request)
    raise HTTPException(status_code=404, detail="Next.js asset not found")


@app.get("/workspaces/{workspace_id}/preview/{path:path}")
async def workspace_file(workspace_id: str, path: str, request: Request):
    """
    提供 workspace 内的具体文件。
    自动在 out/、dist/、根目录下查找。
    HTML 文件会修正 /_next/ 资源路径。
    """
    ws_path_base, _ = verify_workspace_access(workspace_id, request)
    preview_base = f"/workspaces/{workspace_id}/preview"
    if path.startswith("_next/"):
        candidate = _find_next_preview_asset(ws_path_base, path.removeprefix("_next/"))
        if candidate:
            return _serve_preview_asset(candidate, preview_base, request)

    # 优先从 out/ 目录查找（Next.js 静态导出）
    for subdir in ("out", "dist", ""):
        if subdir:
            candidate = safe_child_path(ws_path_base / subdir, path)
        else:
            candidate = safe_child_path(ws_path_base, path)
        if candidate.exists() and candidate.is_file():
            # HTML 文件需要修正资源路径
            if candidate.suffix.lower() == ".html":
                html_content = candidate.read_text(encoding="utf-8")
                html_content = html_content.replace('href="/_next/', f'href="{preview_base}/_next/')
                html_content = html_content.replace("href='/_next/", f"href='{preview_base}/_next/")
                html_content = html_content.replace('src="/_next/', f'src="{preview_base}/_next/')
                html_content = html_content.replace("src='/_next/", f"src='{preview_base}/_next/")
                html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
                html_content = _rewrite_preview_html(html_content, preview_base, request)
                return Response(content=html_content, media_type="text/html")
            return FileResponse(str(candidate))
        # 尝试 path/index.html（目录路由）
        if subdir:
            index_candidate = safe_child_path(ws_path_base / subdir, f"{path.rstrip('/')}/index.html")
        else:
            index_candidate = safe_child_path(ws_path_base, f"{path.rstrip('/')}/index.html")
        if index_candidate.exists():
            html_content = index_candidate.read_text(encoding="utf-8")
            html_content = html_content.replace('href="/_next/', f'href="{preview_base}/_next/')
            html_content = html_content.replace("href='/_next/", f"href='{preview_base}/_next/")
            html_content = html_content.replace('src="/_next/', f'src="{preview_base}/_next/')
            html_content = html_content.replace("src='/_next/", f"src='{preview_base}/_next/")
            html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
            html_content = _rewrite_preview_html(html_content, preview_base, request)
            return Response(content=html_content, media_type="text/html")
        # Next.js static export may emit /route.html instead of /route/index.html.
        if path and not path.rstrip("/").lower().endswith(".html"):
            if subdir:
                html_candidate = safe_child_path(ws_path_base / subdir, f"{path.rstrip('/')}.html")
            else:
                html_candidate = safe_child_path(ws_path_base, f"{path.rstrip('/')}.html")
            if html_candidate.exists() and html_candidate.is_file():
                html_content = html_candidate.read_text(encoding="utf-8")
                html_content = html_content.replace('href="/_next/', f'href="{preview_base}/_next/')
                html_content = html_content.replace("href='/_next/", f"href='{preview_base}/_next/")
                html_content = html_content.replace('src="/_next/', f'src="{preview_base}/_next/')
                html_content = html_content.replace("src='/_next/", f"src='{preview_base}/_next/")
                html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
                html_content = _rewrite_preview_html(html_content, preview_base, request)
                return Response(content=html_content, media_type="text/html")

    # SPA/Next client-side route fallback: keep extensionless routes inside the
    # workspace preview instead of letting them escape to the host application.
    if path and not Path(path).suffix:
        for subdir in ("out", "dist", ""):
            fallback_index = ws_path_base / subdir / "index.html" if subdir else ws_path_base / "index.html"
            if fallback_index.exists() and fallback_index.is_file():
                html_content = fallback_index.read_text(encoding="utf-8")
                html_content = html_content.replace('href="/_next/', f'href="{preview_base}/_next/')
                html_content = html_content.replace("href='/_next/", f"href='{preview_base}/_next/")
                html_content = html_content.replace('src="/_next/', f'src="{preview_base}/_next/')
                html_content = html_content.replace("src='/_next/", f"src='{preview_base}/_next/")
                html_content = html_content.replace('"/_next/', f'"{preview_base}/_next/')
                html_content = _rewrite_preview_html(html_content, preview_base, request)
                return Response(content=html_content, media_type="text/html")

    raise HTTPException(status_code=404, detail="File not found")


@app.get("/_next/static/{path:path}")
async def workspace_next_static(path: str, request: Request):
    """
    处理 Next.js 静态导出 HTML 内的 /_next/static/ 资源请求。
    从 Referer 头判断来自哪个工作空间，在 out/_next/static/ 里找文件。
    """
    # 从 Referer 中提取工作空间 ID
    referer = request.headers.get("referer", "")
    workspace_id = None

    import re
    m = re.search(r"/workspaces/([^/]+)/preview", referer)
    if m:
        workspace_id = m.group(1)

    # 尝试已知工作空间（按最后修改时间）
    if workspace_id:
        ws_path, _ = verify_workspace_access(workspace_id, request)
        candidate = safe_child_path(ws_path / "out" / "_next" / "static", path)
        if candidate.exists() and candidate.is_file():
            return _serve_preview_asset(candidate, f"/workspaces/{workspace_id}/preview", request)

    # 全局搜索所有工作空间（Referer 缺失时降级）
    raise HTTPException(status_code=404, detail="Static file not found")


def _find_workspace_file_from_referer(request: Request, referer: str, path: str) -> Optional[Path]:
    """
    从 Referer 中推断工作空间，然后在其 out/ 目录中查找文件。
    返回文件 Path 或 None。
    """
    import re
    m = re.search(r"/workspaces/([^/]+)/preview", referer)
    if m:
        workspace_id = m.group(1)
        try:
            ws_path, _ = verify_workspace_access(workspace_id, request)
        except HTTPException:
            return None
        for subdir in ("out", "dist", ""):
            if subdir:
                candidate = safe_child_path(ws_path / subdir, path)
            else:
                candidate = safe_child_path(ws_path, path)
            if candidate.exists() and candidate.is_file():
                return candidate
            # 尝试 path/index.html（目录路由）
            if subdir:
                index_candidate = safe_child_path(ws_path / subdir, f"{path}/index.html")
            else:
                index_candidate = safe_child_path(ws_path, f"{path}/index.html")
            if index_candidate.exists():
                return index_candidate
            if path and not path.rstrip("/").lower().endswith(".html"):
                if subdir:
                    html_candidate = safe_child_path(ws_path / subdir, f"{path.rstrip('/')}.html")
                else:
                    html_candidate = safe_child_path(ws_path, f"{path.rstrip('/')}.html")
                if html_candidate.exists() and html_candidate.is_file():
                    return html_candidate
    return None


@app.get("/blog/{path:path}")
async def workspace_blog_page(path: str, request: Request):
    """代理 iframe 内博客文章路由请求到对应工作空间的静态文件"""
    referer = request.headers.get("referer", "")
    result = _find_workspace_file_from_referer(request, referer, f"blog/{path}")
    if result:
        return FileResponse(str(result))
    raise HTTPException(status_code=404, detail="Page not found")


@app.get("/about")
@app.get("/about/")
async def workspace_about_page(request: Request):
    """代理 iframe 内 about 路由"""
    referer = request.headers.get("referer", "")
    result = _find_workspace_file_from_referer(request, referer, "about")
    if result:
        return FileResponse(str(result))
    raise HTTPException(status_code=404, detail="Page not found")
