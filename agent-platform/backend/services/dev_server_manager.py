# -*- coding: utf-8 -*-
"""
Dev Server Manager — Workspace 内置开发服务器生命周期管理

功能：
- 在 Docker 容器内启动 dev server（npm run dev / python manage.py runserver）
- 分配可预测端口（避免冲突）
- 实时转发 dev server URL 给前端 iframe 预览
- 优雅停止 dev server 进程
"""
import asyncio
import locale
import os
import re
import uuid
import sys
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from core.config import get_settings
from core.docker_manager import docker_manager


# ═══ 辅助：将 localhost 转换为公网地址 ═══════════════════════════════

def _public_url(local_url: str) -> str:
    """将 localhost URL 转换为公网可访问地址"""
    settings = get_settings()
    host = settings.public_host
    if not host:
        return local_url
    # 替换 localhost 或 127.0.0.1 为公网 host
    return re.sub(r"https?://(localhost|127\.0\.0\.1)(:\d+)?", f"http://{host}\\2", local_url, count=1)


# 常用框架的启动命令和端口检测正则
DEV_SERVER_CONFIGS = {
    "nextjs":  {"port": 3000,  "cmd": "npm run dev", "url_pattern": r"ready on.*?https?://([\w.:-]+)/"},
    "react":    {"port": 5173,  "cmd": "npm run dev", "url_pattern": r"Local:.*?(https?://[\w.:-]+)/"},
    "vue":      {"port": 5173,  "cmd": "npm run dev", "url_pattern": r"Local:.*?(https?://[\w.:-]+)/"},
    "nuxt":     {"port": 3000,  "cmd": "npm run dev", "url_pattern": r"Nitro running at.*?(https?://[\w.:-]+)/"},
    "python":   {"port": 8000,  "cmd": "python manage.py runserver 0.0.0.0:8000", "url_pattern": r"Running on.*?(https?://[\w.:-]+)"},
    "fastapi":  {"port": 8000,  "cmd": "uvicorn main:app --reload --host 0.0.0.0 --port 8000", "url_pattern": r"Uvicorn running on.*?(https?://[\w.:-]+)"},
    "go":       {"port": 8080,  "cmd": "go run .", "url_pattern": r"Listening on.*?(https?://[\w.:-]+)"},
    "java":     {"port": 8080,  "cmd": "mvn spring-boot:run", "url_pattern": r"Tomcat started on port.*?(\d+)"},
    "default":  {"port": 3000,  "cmd": "npm run dev", "url_pattern": r"(https?://[\w.:-]+)"},
}

# 获取系统本地编码（Windows 下为 GBK/cp936，Linux 下为 UTF-8）
def _local_encoding() -> str:
    """返回本地子进程输出的编码，Windows 使用 GBK"""
    if sys.platform == "win32":
        try:
            return locale.getpreferredencoding() or "gbk"
        except Exception:
            return "gbk"
    return "utf-8"


def _decode_output(data: bytes) -> str:
    """解码子进程输出，自动处理 GBK/UTF-8 编码"""
    enc = _local_encoding()
    try:
        return data.decode(enc)
    except (UnicodeDecodeError, LookupError):
        return data.decode("utf-8", errors="replace")


@dataclass
class DevServerSession:
    workspace_id: str
    port: int
    process_task: Optional[asyncio.Task] = None
    status: str = "stopped"  # stopped | starting | running | error
    url: Optional[str] = None
    output: str = ""
    error_detail: str = ""  # 记录启动失败的详细原因
    created_at: float = 0.0   # 启动时间戳
    last_accessed: float = 0.0  # 最后访问时间戳（心跳/预览请求）


class DevServerManager:
    """
    Workspace 开发服务器管理器。

    工作流程：
    1. start_dev_server() → 在 workspace 容器内启动 dev server
    2. 持续监听输出，提取实际 URL
    3. 返回 { port, url } 给 orchestrator
    4. stop_dev_server() → 优雅关闭
    """

    # URL 文件路径（容器内写，宿主机读）
    _url_file_name = "dev_server.url"

    def __init__(self):
        self._sessions: dict[str, DevServerSession] = {}
        self._settings = get_settings()
        self._port_counter: int = 3100  # 从合理端口开始，避免与常用服务冲突
        self._lock = asyncio.Lock()

    async def _next_port(self) -> int:
        """分配下一个可用端口"""
        async with self._lock:
            self._port_counter += 1
            return self._port_counter

    async def start_dev_server(
        self,
        workspace_id: str,
        ws_path: str | None = None,
        project_type: str | None = None,
    ) -> Optional[dict]:
        """
        在指定 Workspace 内启动 dev server。
        返回 { port, url, status }，失败返回 None。
        """
        if workspace_id in self._sessions:
            session = self._sessions[workspace_id]
            if session.status in ("starting", "running"):
                logger.info(f"[DevServer] {workspace_id} 已在运行: {session.url}")
                return {"port": session.port, "url": session.url, "status": session.status}

        port = await self._next_port()
        now = asyncio.get_event_loop().time()
        session = DevServerSession(
            workspace_id=workspace_id,
            port=port,
            status="starting",
            created_at=now,
            last_accessed=now,
        )
        self._sessions[workspace_id] = session

        # 检测项目类型
        if ws_path:
            project_type = await self._detect_project_type(workspace_id, ws_path, project_type)
        config = DEV_SERVER_CONFIGS.get(project_type or "default", DEV_SERVER_CONFIGS["default"])

        # 适配端口：命令中硬编码的端口直接替换；Node.js 项目通过 PORT 环境变量注入
        cmd = config["cmd"].replace(":3000", f":{port}").replace(":5173", f":{port}").replace(":8000", f":{port}").replace(":8080", f":{port}")
        # 如果命令中没有端口号（如 npm run dev），通过环境变量注入端口
        if ":" + str(config["port"]) not in cmd and ("npm" in cmd or "npx" in cmd):
            cmd = f"PORT={port} {cmd}"

        logger.info(f"[DevServer] 启动 {workspace_id} (port={port}, cmd='{cmd}')")

        session.process_task = asyncio.create_task(
            self._run_dev_server(session, workspace_id, cmd, config["url_pattern"])
        )

        # 等待 server 真正启动（最多 90s，但 _run_dev_server 内部最多 120s）
        for _ in range(90):
            await asyncio.sleep(1)
            if session.status == "running" and session.url:
                logger.info(f"[DevServer] ✅ {workspace_id} 运行于 {session.url}")
                return {"port": session.port, "url": session.url, "status": session.status}
            if session.status == "error":
                logger.warning(f"[DevServer] ❌ {workspace_id} 启动失败: {session.error_detail[:200]}")
                return {"port": session.port, "url": None, "status": "error", "error_detail": session.error_detail}

        # 等待超时但不取消 _run_dev_server（它可能在后台继续检测）
        session.status = "timeout"
        ds = self._sessions.get(workspace_id)
        logger.warning(f"[DevServer] ⏱️ {workspace_id} 等待超时，后台继续检测... (output_len={len(ds.output if ds else '')})")
        return {"port": session.port, "url": None, "status": "timeout", "error_detail": "等待超时，后台仍在尝试启动"}

    async def _run_dev_server(
        self,
        session: DevServerSession,
        workspace_id: str,
        cmd: str,
        url_pattern: str,
    ):
        """在容器内执行 dev server，监听输出提取 URL"""
        try:
            container = docker_manager._containers.get(workspace_id)
            ws_path = str(docker_manager._workspace_path(workspace_id))
            url_file = os.path.join(ws_path, self._url_file_name)

            # 清理旧的 URL 文件
            if os.path.exists(url_file):
                os.remove(url_file)

            if container and container.status == "running":
                # ── Docker 容器内执行 ──
                # 使用 detach=True 异步启动（不用 stream=True，socket 在 Windows 下不稳定）
                exec_id = container.client.api.exec_create(
                    container.id,
                    ["bash", "-c", f"cd /workspace && {cmd} 2>&1 | tee /workspace/dev_server.log"],
                    workdir="/workspace",
                )
                container.client.api.exec_start(exec_id, detach=True)

                # 轮询方式检测 URL
                # 策略 1: 检查容器输出文件
                # 策略 2: 检查 URL 文件
                # 策略 3: 正则匹配日志
                for attempt in range(120):  # 最多等 120 秒
                    await asyncio.sleep(1)

                    # 策略 1: 检查 URL 文件（容器内 agent 可以写这个文件）
                    if os.path.exists(url_file):
                        try:
                            with open(url_file, "r", encoding="utf-8") as f:
                                url = f.read().strip()
                            if url:
                                session.url = url
                                session.status = "running"
                                logger.info(f"[DevServer] 从 URL 文件读取: {url}")
                                return
                        except Exception as e:
                            logger.debug(f"[DevServer] 读取 URL 文件失败: {e}")

                    # 策略 2: 检查日志文件
                    log_file = os.path.join(ws_path, "dev_server.log")
                    if os.path.exists(log_file):
                        try:
                            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                                content = f.read()
                            session.output = content
                            match = re.search(url_pattern, content[-2000:], re.IGNORECASE)
                            if match:
                                    found = match.group(1) if match.lastindex else match.group(0)
                                    found = re.sub(r":\d+", f":{session.port}", found)
                                    if not found.startswith("http"):
                                        found = f"http://localhost:{session.port}"
                                    session.url = _public_url(found)
                                    session.status = "running"
                                    logger.info(f"[DevServer] 从日志检测到 URL: {found} -> {session.url}")
                                    return
                        except Exception as e:
                            logger.debug(f"[DevServer] 读取日志文件失败: {e}")

                    # 策略 3: 如果超时且没有输出，检查进程是否还在
                    if attempt == 10 and not session.output:
                        # 10 秒后检查日志是否有内容
                        log_file = os.path.join(ws_path, "dev_server.log")
                        if os.path.exists(log_file):
                            try:
                                with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                                    session.output = f.read()
                            except Exception:
                                pass
                        if not session.output:
                            session.error_detail = "Dev Server 10 秒内无任何输出，可能命令执行失败"
                            logger.warning(f"[DevServer] {workspace_id} 无输出，可能启动命令失败")

                # 120 秒超时
                if not session.url:
                    session.status = "error"
                    session.error_detail = f"启动超时（120s），最后输出:\n{(session.output or '无')[-500:]}"
                    logger.warning(f"[DevServer] {workspace_id} 启动超时")

            else:
                # ── 本地 subprocess 降级 ──
                # 先检查 package.json 是否存在
                package_json = os.path.join(ws_path, "package.json")
                if not os.path.exists(package_json):
                    session.status = "error"
                    session.error_detail = f"package.json 不存在于 {ws_path}，代码可能未完整生成"
                    logger.warning(f"[DevServer] {workspace_id} 无 package.json，跳过 dev server 启动")
                    return

                node_modules = os.path.join(ws_path, "node_modules")
                if os.path.exists(package_json) and not os.path.exists(node_modules):
                    logger.info(f"[DevServer] 本地模式：检测到缺少 node_modules，先安装依赖")
                    install_proc = await asyncio.create_subprocess_shell(
                        "npm install",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        cwd=ws_path,
                    )
                    try:
                        stdout, _ = await asyncio.wait_for(install_proc.communicate(), timeout=120)
                        install_output = _decode_output(stdout)
                        session.output += f"[npm install]\n{install_output}\n"
                        logger.info(f"[DevServer] npm install 完成: {install_output[-200:]}")
                    except asyncio.TimeoutError:
                        install_proc.kill()
                        session.error_detail = "npm install 超时（120s）"
                        session.status = "error"
                        return

                proc = await asyncio.create_subprocess_shell(
                    cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=ws_path,
                )
                buffer = ""
                while True:
                    try:
                        line = await asyncio.wait_for(proc.stdout.readline(), timeout=2.0)
                    except asyncio.TimeoutError:
                        match = re.search(url_pattern, buffer, re.IGNORECASE)
                        if match and not session.url:
                            found = match.group(1) if match.lastindex else match.group(0)
                            found = re.sub(r":\d+", f":{session.port}", found)
                            if not found.startswith("http"):
                                found = f"http://localhost:{session.port}"
                            session.url = _public_url(found)
                            session.status = "running"
                            logger.info(f"[DevServer] 本地检测到 URL: {found} -> {session.url}")
                        # 检查进程是否退出
                        if proc.returncode is not None:
                            if not session.url:
                                session.status = "error"
                                session.error_detail = f"进程已退出(code={proc.returncode})，输出:\n{buffer[-500:]}"
                            break
                        continue
                    except asyncio.CancelledError:
                        proc.terminate()
                        session.status = "stopped"
                        return
                    if not line:
                        break
                    text = _decode_output(line)
                    buffer += text
                    session.output += text
                    match = re.search(url_pattern, buffer, re.IGNORECASE)
                    if match and not session.url:
                        found = match.group(1) if match.lastindex else match.group(0)
                        found = re.sub(r":\d+", f":{session.port}", found)
                        if not found.startswith("http"):
                            found = f"http://localhost:{session.port}"
                        session.url = _public_url(found)
                        session.status = "running"
                        logger.info(f"[DevServer] 本地检测到 URL: {found} -> {session.url}")
                    if proc.returncode is not None and proc.returncode != 0 and not session.url:
                        session.status = "error"
                        session.error_detail = f"进程退出(code={proc.returncode})，输出:\n{buffer[-500:]}"
                        break

        except asyncio.CancelledError:
            session.status = "stopped"
        except Exception as e:
            logger.warning(f"[DevServer] 执行异常: {e}")
            session.status = "error"
            session.error_detail = str(e)

    async def _detect_project_type(
        self,
        workspace_id: str,
        ws_path: str,
        hint: str | None,
    ) -> str:
        """根据 package.json / requirements.txt 等文件检测项目类型"""
        if hint:
            return hint

        result = await docker_manager.execute_in_workspace(
            workspace_id,
            "ls package.json requirements.txt pyproject.toml go.mod pom.xml 2>/dev/null | head -5",
        )
        stdout = result.get("stdout", "")

        if "package.json" in stdout:
            # 进一步检测
            pkg_result = await docker_manager.execute_in_workspace(
                workspace_id, "cat package.json 2>/dev/null | grep -E '\"next\"|\"nuxt\"|\"vite\"|\"react\"|\"vue\"' | head -3"
            )
            pkg_text = pkg_result.get("stdout", "")
            if "next" in pkg_text.lower():
                return "nextjs"
            if "nuxt" in pkg_text.lower():
                return "nuxt"
            if "vite" in pkg_text.lower() or "vue" in pkg_text.lower():
                return "vue"
            return "react"
        if "requirements.txt" in stdout or "pyproject.toml" in stdout:
            return "fastapi"
        if "go.mod" in stdout:
            return "go"
        if "pom.xml" in stdout:
            return "java"
        return "default"

    async def stop_dev_server(self, workspace_id: str) -> bool:
        """停止指定 Workspace 的 dev server"""
        session = self._sessions.get(workspace_id)
        if not session:
            return False

        if session.process_task:
            session.process_task.cancel()
            try:
                await session.process_task
            except asyncio.CancelledError:
                pass

        session.status = "stopped"
        session.url = None
        logger.info(f"[DevServer] 已停止: {workspace_id}")
        return True

    async def get_session(self, workspace_id: str) -> Optional[DevServerSession]:
        """获取 dev server 状态，同时更新最后访问时间"""
        session = self._sessions.get(workspace_id)
        if session and session.status == "running":
            session.last_accessed = asyncio.get_event_loop().time()
        return session

    def get_preview_url(self, workspace_id: str) -> Optional[str]:
        """快速获取预览 URL（供 orchestrator 直接读取），同时更新最后访问时间"""
        session = self._sessions.get(workspace_id)
        if session and session.status == "running":
            session.last_accessed = asyncio.get_event_loop().time()
            return session.url
        return None

    async def heartbeat(self, workspace_id: str) -> bool:
        """前端心跳：更新最后访问时间，返回预览是否还在运行"""
        session = self._sessions.get(workspace_id)
        if not session:
            return False
        session.last_accessed = asyncio.get_event_loop().time()
        return session.status == "running"

    async def start_cleanup_task(self, timeout_seconds: int = 3600, check_interval: int = 300):
        """
        启动定时清理任务：
        - timeout_seconds: 超过此时间没有访问的预览服务会被停止（默认 3600 秒 = 1 小时）
        - check_interval: 检查间隔（默认 300 秒 = 5 分钟）
        """
        self._cleanup_timeout = timeout_seconds
        logger.info(f"[DevServer] 启动清理任务：超时={timeout_seconds}s，检查间隔={check_interval}s")

        async def _cleanup_loop():
            while True:
                await asyncio.sleep(check_interval)
                await self._cleanup_stale_servers()

        asyncio.create_task(_cleanup_loop())

    async def _cleanup_stale_servers(self):
        """清理超过 timeout 没有访问的 dev server"""
        now = asyncio.get_event_loop().time()
        timeout = getattr(self, "_cleanup_timeout", 3600)
        to_stop = []

        for wid, session in self._sessions.items():
            if session.status not in ("starting", "running"):
                continue
            # 如果 last_accessed 是 0（旧 session 没有这个字段），用 created_at
            last = session.last_accessed if session.last_accessed > 0 else session.created_at
            idle = now - last
            if idle > timeout:
                to_stop.append((wid, session, idle))

        for wid, session, idle in to_stop:
            logger.info(f"[DevServer] 清理闲置预览：{wid} 已闲置 {idle:.0f}s，停止 dev server")
            await self.stop_dev_server(wid)

    async def list_sessions(self) -> list[dict]:
        """列出所有 dev server 会话"""
        return [
            {
                "workspace_id": wid,
                "port": s.port,
                "url": s.url,
                "status": s.status,
            }
            for wid, s in self._sessions.items()
        ]


dev_server_manager = DevServerManager()
