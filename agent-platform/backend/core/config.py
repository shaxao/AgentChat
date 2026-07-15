# -*- coding: utf-8 -*-
"""Global config — reads from environment variables with cross-platform defaults."""
import os
import re
import sys
from pathlib import Path
from functools import lru_cache

# ── 启动时加载 .env 文件（必须在所有 os.getenv 之前执行）──────────
from dotenv import load_dotenv
load_dotenv()

from pydantic_settings import BaseSettings
from pydantic import field_validator

# ── 启动时自动检测 MySQL 主机 ──────────────────────────────────────────
def _detect_mysql_host() -> str:
    """
    自动检测 MySQL 主机地址。
    优先级：环境变量 > localhost（本地开发）> aiplatform-mysql（Docker 环境）
    通过 attempting socket connection 来检测哪个主机可达。
    """
    env_host = os.getenv("MUHUGOCHAT_DB_HOST")
    if env_host:
        return env_host

    # 自动检测：先试 localhost，再试 Docker 服务名
    candidates = ["localhost", "127.0.0.1", "aiplatform-mysql"]
    for host in candidates:
        try:
            import socket
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2)
            result = sock.connect_ex((host, 3306))
            sock.close()
            if result == 0:
                print(f"[Config] Auto-detected MySQL host: {host}:3306")
                return host
        except Exception:
            pass

    # 全部不可达，返回 localhost（让用户自己改 .env）
    print("[Config] Warning: No MySQL host reachable. Using 'localhost' as fallback.")
    return "localhost"


def _default_workspace_dir() -> Path:
    raw = os.getenv("WORKSPACE_BASE_DIR", "")
    if raw and sys.platform != "win32" and re.match(r"^[A-Za-z]:[\\/]", raw):
        print(f"[Config] Ignoring Windows WORKSPACE_BASE_DIR on non-Windows host: {raw}")
        raw = ""
    if sys.platform == "win32":
        return Path(raw or os.path.expanduser("~/autocode-workspaces"))
    return Path(raw or "/tmp/autocode-workspaces")


def _default_docker_host() -> str:
    if sys.platform == "win32":
        return os.getenv("DOCKER_HOST", "npipe:////./pipe/docker_engine")
    return os.getenv("DOCKER_HOST", "unix:///var/run/docker.sock")


class Settings(BaseSettings):
    # Anthropic
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")

    # Workspace
    workspace_base_dir: Path = _default_workspace_dir()

    @field_validator("workspace_base_dir", mode="after")
    @classmethod
    def _validate_workspace_base_dir(cls, v: Path) -> Path:
        """Reject Windows-style paths on non-Windows hosts.

        Pydantic BaseSettings loads WORKSPACE_BASE_DIR directly from .env,
        bypassing _default_workspace_dir(). If a Windows path like
        C:/autocode-workspaces leaks into a Linux deployment, it becomes a
        relative path and gets concatenated under the CWD, producing broken
        paths such as /opt/autocode/C:/autocode-workspaces/ws-xxx.
        """
        import re as _re
        if sys.platform != "win32" and _re.match(r"^[A-Za-z]:[\\/]", str(v)):
            print(f"[Config] Ignoring Windows-style WORKSPACE_BASE_DIR on non-Windows host: {v}")
            return Path("/tmp/autocode-workspaces")
        return v


    # Git
    git_author_name: str = os.getenv("GIT_AUTHOR_NAME", "AutoCode Agent")
    git_author_email: str = os.getenv("GIT_AUTHOR_EMAIL", "agent@autocode.local")

    # Task scheduling
    max_concurrent_tasks: int = int(os.getenv("MAX_CONCURRENT_TASKS", "5"))

    # Docker
    docker_workspace_image: str = os.getenv(
        "DOCKER_WORKSPACE_IMAGE", "agent-workspace:latest"
    )
    docker_host: str = _default_docker_host()
    # 容器资源限制（2C2G 服务器建议设 mem=512m cpu=1）
    docker_mem_limit: str = os.getenv("AUTOCODE_DOCKER_MEM_LIMIT", "2g")
    docker_cpu_limit: float = float(os.getenv("AUTOCODE_DOCKER_CPU_LIMIT", "2.0"))
    # 禁用 Docker 隔离（国内服务器拉取 Docker Hub 镜像超时会导致每次任务卡 15-20s）
    # 设为 "1" / "true" / "yes" 后直接走本地执行模式，跳过 Docker
    docker_disabled: bool = os.getenv("AUTOCODE_DISABLE_DOCKER", "").lower() in ("1", "true", "yes", "on")

    # Workspace 磁盘管理
    workspace_max_size_mb: int = int(os.getenv("AUTOCODE_WORKSPACE_MAX_SIZE_MB", "5120"))
    workspace_auto_cleanup_days: int = int(os.getenv("AUTOCODE_WORKSPACE_CLEANUP_DAYS", "7"))

    # Dev server 空闲超时（秒），超时后自动停止释放资源
    dev_server_idle_timeout: int = int(os.getenv("AUTOCODE_DEV_SERVER_IDLE_TIMEOUT", "1800"))

    # AutoCode 公网访问地址（用于生成预览 URL，如 http://your-server-b-ip:8000）
    public_host: str = os.getenv("AUTOCODE_PUBLIC_HOST", "")

    # Deploy
    vercel_api_token: str = os.getenv("VERCEL_API_TOKEN", "")

    # ── MuhugoChat DB (读取渠道表获取 LLM 凭据) ──
    muhugochat_db_host: str = _detect_mysql_host()
    muhugochat_db_port: int = int(os.getenv("MUHUGOCHAT_DB_PORT", "3306"))
    muhugochat_db_name: str = os.getenv("MUHUGOCHAT_DB_NAME", "MuHuoAi")
    muhugochat_db_user: str = os.getenv("MUHUGOCHAT_DB_USER", "muhuoai")
    muhugochat_db_password: str = os.getenv("MUHUGOCHAT_DB_PASSWORD", "changeme")

    # ── Redis（L1/L2 热数据缓存 + rq 任务队列，轻量替代 ES/Milvus）──
    # 显式 REDIS_URL 优先；否则由 host/port/db/password 拼装。
    # 不可达时所有缓存调用优雅降级，不影响主流程。
    redis_url: str = os.getenv("REDIS_URL", "")
    redis_host: str = os.getenv("REDIS_HOST", "localhost")
    redis_port: int = int(os.getenv("REDIS_PORT", "6379"))
    redis_db: int = int(os.getenv("REDIS_DB", "0"))
    redis_password: str = os.getenv("REDIS_PASSWORD", "")

    @property
    def redis_dsn(self) -> str:
        """返回 Redis 连接 DSN（优先 REDIS_URL）"""
        if self.redis_url:
            return self.redis_url
        auth = f":{self.redis_password}@" if self.redis_password else ""
        return f"redis://{auth}{self.redis_host}:{self.redis_port}/{self.redis_db}"

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


# Global singleton — imported directly as `from core.config import settings`
settings = get_settings()
