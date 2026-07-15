# -*- coding: utf-8 -*-
"""Docker 容器池管理 — 为每个任务分配隔离执行容器"""
import asyncio
import docker
import locale
import re
import shlex
import sys
import uuid
from pathlib import Path
from typing import Optional
from loguru import logger

from core.config import get_settings


# ─── 编码辅助（Windows 子进程输出 GBK → 正确解码）──────────
FORBIDDEN_COMMAND_PATHS = (
    "/workspace/..",
    "/data/autocode-workspaces",
    "/tmp/autocode-workspaces",
    "/opt/autocode",
    "/root",
    "/home",
    "/etc",
    "/var/www",
)


def _looks_like_parent_traversal(token: str) -> bool:
    normalized = token.replace("\\", "/")
    return (
        normalized == ".."
        or normalized.startswith("../")
        or "/../" in normalized
        or normalized.endswith("/..")
    )


def _validate_workspace_command(
    command: str,
    *,
    allow_workspace_absolute: bool = True,
    allow_tmp_absolute: bool = True,
) -> tuple[bool, str]:
    compact = re.sub(r"\s+", " ", command or "").strip()
    lowered = compact.lower()
    if not compact:
        return False, "empty command"
    if re.search(r"(^|[\s/])\.\.($|[\s/;&|])", compact):
        return False, "parent-directory traversal is not allowed"

    for forbidden in FORBIDDEN_COMMAND_PATHS:
        if forbidden.lower() in lowered:
            return False, f"forbidden path: {forbidden}"

    if re.search(r"(^|[;&|]\s*)(ls|find|du|tree|grep|cat|sed|awk)\s+/(?:\s|$)", lowered):
        return False, "root directory access is not allowed"

    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        tokens = compact.split()

    for token in tokens:
        if _looks_like_parent_traversal(token):
            return False, "parent-directory traversal is not allowed"
        allowed_absolute = (
            (allow_workspace_absolute and (token == "/workspace" or token.startswith("/workspace/")))
            or (allow_tmp_absolute and (token == "/tmp" or token.startswith("/tmp/")))
        )
        if token.startswith("/") and not allowed_absolute:
            return False, f"absolute path outside /workspace is not allowed: {token}"

    return True, ""


def _strip_workspace_cd(command: str) -> str:
    local_command = command
    for prefix in ("cd /workspace && ", "cd /workspace &&", "cd /workspace/ && ", "cd /workspace/ &&"):
        if local_command.startswith(prefix):
            return local_command[len(prefix):]
    return local_command


def _translate_workspace_paths_for_local(command: str) -> str:
    """Map container paths to the local workspace cwd when Docker is unavailable."""
    translated = command
    translated = re.sub(r"(?<![\w./-])/workspace/+", "./", translated)
    translated = re.sub(r"(?<![\w./-])/workspace(?![\w./-])", ".", translated)
    return translated


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


class DockerManager:
    """
    Workspace 容器池：
    - 每次任务启动一个独立容器
    - 容器内运行 Agent 的 bash / git / npm 等命令
    - 容器退出后自动清理（或保留供调试）
    """

    def __init__(self):
        self._client: Optional[docker.DockerClient] = None
        self._containers: dict[str, docker.models.containers.Container] = {}
        self._settings = get_settings()

    def ping(self) -> bool:
        """测试 Docker 连接"""
        if self._settings.docker_disabled:
            return False
        if not self._client:
            self._client = docker.DockerClient(
                base_url=self._settings.docker_host
            )
        self._client.ping()
        return True

    @property
    def is_connected(self) -> bool:
        if self._settings.docker_disabled:
            return False
        try:
            self.ping()
            return True
        except Exception:
            return False

    def _workspace_path(self, workspace_id: str) -> Path:
        """工作空间在宿主机上的目录"""
        return self._settings.workspace_base_dir / workspace_id

    async def create_workspace(
        self,
        workspace_id: str,
        project_type: str = "default",
        **kwargs,
    ) -> dict:
        """
        创建隔离工作空间目录，并可选启动 Docker 容器。
        """
        path = self._workspace_path(workspace_id)
        path.mkdir(parents=True, exist_ok=True)

        container = None
        if self.is_connected:
            try:
                container = self._client.containers.run(
                    self._settings.docker_workspace_image,
                    f"tail -f /dev/null",  # 保持容器运行
                    detach=True,
                    mem_limit=self._settings.docker_mem_limit,
                    nano_cpus=int(self._settings.docker_cpu_limit * 1e9),  # 2.0 → 2,000,000,000 纳秒
                    pids_limit=512,  # Node.js 工具链 spawn 大量子进程（原 128 过低）
                    network_disabled=False,
                    volumes={
                        str(path): {"bind": "/workspace", "mode": "rw"}
                    },
                    working_dir="/workspace",
                    name=f"autocode-{workspace_id[:12]}",
                    labels={"autocode": "workspace"},
                    remove=False,
                )
                self._containers[workspace_id] = container
                logger.info(f"[Docker] 容器 {container.id[:12]} 已启动")
            except Exception as e:
                logger.warning(f"[Docker] 容器启动失败: {e}，降级为本地执行")

        return {
            "workspace_id": workspace_id,
            "path": str(path),
            "container_id": container.id[:12] if container else None,
            "mode": "container" if container else "local",
        }

    async def execute_in_workspace(
        self,
        workspace_id: str,
        command: str,
        timeout: int = 300,
        strict_symlink_scan: bool = True,
    ) -> dict:
        """
        在指定 Workspace 内执行命令。
        返回 stdout / stderr / exit_code。
        """
        ws_root = self._workspace_path(workspace_id).resolve()
        if strict_symlink_scan:
            try:
                for item in ws_root.rglob("*"):
                    if item.is_symlink():
                        target = item.resolve(strict=False)
                        if ws_root not in (target, *target.parents):
                            logger.warning(f"[Docker] Blocked command because unsafe symlink exists: {item} -> {target}")
                            return {
                                "stdout": "",
                                "stderr": "Blocked unsafe workspace command: workspace contains a symlink escaping the current task workspace",
                                "exit_code": 126,
                            }
            except FileNotFoundError:
                pass

        container = self._containers.get(workspace_id)
        if container:
            try:
                container.reload()  # 刷新 Docker SDK 缓存的状态
            except Exception:
                pass
        is_container_running = bool(container and container.status == "running")
        command_to_run = command if is_container_running else _translate_workspace_paths_for_local(_strip_workspace_cd(command))

        ok, reason = _validate_workspace_command(
            command_to_run,
            allow_workspace_absolute=is_container_running,
            allow_tmp_absolute=is_container_running,
        )
        if not ok:
            logger.warning(f"[Docker] Blocked unsafe workspace command: {reason}; command={command[:200]}")
            return {
                "stdout": "",
                "stderr": f"Blocked unsafe workspace command: {reason}",
                "exit_code": 126,
            }

        if is_container_running and container:
            # Docker 容器内执行
            result = container.exec_run(
                ["bash", "-c", command_to_run],
                workdir="/workspace",
                demux=True,
            )
            stdout, stderr = result.output
            return {
                "stdout": (stdout or b"").decode("utf-8", errors="replace"),
                "stderr": (stderr or b"").decode("utf-8", errors="replace"),
                "exit_code": result.exit_code,
            }
        else:
            # 降级：本地 subprocess 执行（仅开发/调试用）
            # 本地模式：命令里常含 "cd /workspace &&"，在宿主机上直接移除（cwd 已是工作空间目录）
            proc = await asyncio.create_subprocess_shell(
                command_to_run,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._workspace_path(workspace_id)),
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
                return {
                    "stdout": _decode_output(stdout),
                    "stderr": _decode_output(stderr),
                    "exit_code": proc.returncode,
                }
            except asyncio.TimeoutError:
                proc.kill()
                return {
                    "stdout": "",
                    "stderr": f"Command timed out after {timeout}s",
                    "exit_code": -1,
                }

    async def destroy_workspace(self, workspace_id: str) -> bool:
        """销毁 Workspace：停止容器 + 清理目录"""
        container = self._containers.pop(workspace_id, None)
        if container:
            try:
                container.stop(timeout=5)
                container.remove()
                logger.info(f"[Docker] 容器 {container.short_id} 已销毁")
            except Exception as e:
                logger.warning(f"[Docker] 容器销毁失败: {e}")

        # 保留目录内容（供 Git 历史查阅），仅清理容器引用
        return True

    async def list_workspaces(self) -> list[dict]:
        """列出当前活跃的 Workspace"""
        return [
            {
                "workspace_id": wid,
                "container_id": c.id[:12],
                "status": c.status,
            }
            for wid, c in self._containers.items()
            if c.status == "running"
        ]


# 全局单例
docker_manager = DockerManager()
