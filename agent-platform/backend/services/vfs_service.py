# -*- coding: utf-8 -*-
"""
VFS Service — 虚拟文件存储抽象层（方案B 落地，轻量实现）

将散落的物理路径统一为虚拟路径，提供元数据驱动的访问接口：
  /workspace/{ws_id}/...   工作空间代码（= workspace_base_dir/{ws_id}）
  /memory/hot/...          L1/L2 热记忆文件（文件系统镜像）
  /archive/...             L4 归档
  /uploads/...             用户上传
  /projects/{id}/...       项目级目录
  /shared/...              共享资源

接口（对齐合并方案 FileStore ABC）：
  read / write / search / watch / get_metadata / update_metadata / list_dir / delete

元数据：每个文件对应一个 .meta.json 侧车文件（source/uploader/tags/related_tasks/
memory_refs/access_count/last_accessed/privacy_level）。L3 语义索引由 memory_service 负责，
这里仅做文件系统级全文检索（轻量，无第三方依赖）。
"""
import json
import logging
import os
import re
import threading
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Optional

from core.config import settings

logger = logging.getLogger("autocode.vfs")


# ─── 虚拟路径 -> 物理路径 映射 ─────────────────────────────────
def _resolve_physical(virtual_path: str) -> Path:
    """
    将虚拟路径解析为物理路径。
    越权防护：解析结果必须位于 workspace_base_dir 之内（防 ../ 穿越逃逸）。
    注意：保留 ".." 段，交由 relative_to 检查——真正的越权会抛 ValueError。
    """
    vp = virtual_path.replace("\\", "/").strip()
    if not vp.startswith("/"):
        vp = "/" + vp
    parts = [p for p in vp.split("/") if p != ""]
    # 不丢弃 "." / ".."：交由下面的 relative_to 做越权判定

    base = settings.workspace_base_dir
    # 顶层虚拟根
    if not parts:
        return base

    root = parts[0]
    rest = parts[1:]

    if root == "workspace" and rest:
        physical = base / rest[0] / Path(*rest[1:])
    elif root == "memory":
        # /memory/{task_id}/... -> base/_memory/{task_id}/...
        physical = base / "_memory" / Path(*rest)
    elif root == "hot":
        # /hot/... -> base/_memory/hot/...
        physical = base / "_memory" / "hot" / Path(*rest)
    elif root == "archive":
        physical = base / "_archive" / Path(*rest)
    elif root == "uploads":
        physical = base / "_uploads" / Path(*rest)
    elif root == "projects" and rest:
        physical = base / "_projects" / rest[0] / Path(*rest[1:])
    elif root == "shared":
        physical = base / "_shared" / Path(*rest)
    else:
        # 兜底：当作 workspace 下相对路径
        physical = base / Path(*parts)

    # 越权防护：must be within base（relative_to 对越权抛出 ValueError）
    resolved = physical.resolve()
    base_resolved = base.resolve()
    try:
        resolved.relative_to(base_resolved)
    except Exception:
        raise ValueError(f"VFS path escapes workspace root: {virtual_path}")
    return physical


def _meta_path(physical: Path) -> Path:
    return physical.with_suffix(physical.suffix + ".meta.json") \
        if physical.suffix else physical.parent / (physical.name + ".meta.json")


# ─── ABC ───────────────────────────────────────────────────────
class FileStore(ABC):
    @abstractmethod
    def read(self, path: str) -> str:
        ...

    @abstractmethod
    def write(self, path: str, content: str, metadata: Optional[dict] = None) -> dict:
        ...

    @abstractmethod
    def search(self, query: str, limit: int = 20) -> list[dict]:
        ...

    @abstractmethod
    def watch(self, path: str, callback: Callable[[str, str], None]) -> any:
        ...

    @abstractmethod
    def get_metadata(self, path: str) -> Optional[dict]:
        ...

    @abstractmethod
    def update_metadata(self, path: str, metadata: dict) -> dict:
        ...

    @abstractmethod
    def list_dir(self, path: str) -> list[dict]:
        ...

    @abstractmethod
    def delete(self, path: str) -> bool:
        ...


# ─── 本地实现 ──────────────────────────────────────────────────
class LocalFileStore(FileStore):
    def read(self, path: str) -> str:
        p = _resolve_physical(path)
        if not p.exists():
            raise FileNotFoundError(f"VFS: not found {path}")
        if p.is_dir():
            raise IsADirectoryError(f"VFS: {path} is a directory")
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except Exception as e:
            logger.warning(f"[VFS] read failed {path}: {e}")
            raise

    def write(self, path: str, content: str, metadata: Optional[dict] = None) -> dict:
        p = _resolve_physical(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        meta = self.update_metadata(path, metadata or {})
        return {"path": path, "physical": str(p), "metadata": meta}

    def get_metadata(self, path: str) -> Optional[dict]:
        p = _resolve_physical(path)
        mp = _meta_path(p)
        if not mp.exists():
            return None
        try:
            return json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            return None

    def update_metadata(self, path: str, metadata: dict) -> dict:
        p = _resolve_physical(path)
        mp = _meta_path(p)
        existing = {}
        if mp.exists():
            try:
                existing = json.loads(mp.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update(metadata)
        if "access_count" not in existing:
            existing["access_count"] = 0
        existing["last_accessed"] = __import__("datetime").datetime.now().isoformat()
        mp.parent.mkdir(parents=True, exist_ok=True)
        mp.write_text(json.dumps(existing, ensure_ascii=False, indent=2),
                      encoding="utf-8")
        return existing

    def list_dir(self, path: str) -> list[dict]:
        p = _resolve_physical(path)
        if not p.exists() or not p.is_dir():
            return []
        out = []
        for child in sorted(p.iterdir()):
            if child.name.endswith(".meta.json"):
                continue
            out.append({
                "name": child.name,
                "path": (path.rstrip("/") + "/" + child.name),
                "is_dir": child.is_dir(),
                "size": child.stat().st_size if child.is_file() else 0,
            })
        return out

    def search(self, query: str, limit: int = 20, root: str = "/") -> list[dict]:
        """
        文件系统级全文检索（轻量，无 ES/Milvus）。
        遍历 root 下文本文件，按内容/文件名/匹配次数打分。
        """
        q = (query or "").strip().lower()
        if not q:
            return []
        base = _resolve_physical(root)
        if not base.exists():
            return []
        hits: list[dict] = []
        try:
            for physical in base.rglob("*"):
                if not physical.is_file():
                    continue
                if physical.name.endswith(".meta.json"):
                    continue
                rel = "/" + str(physical.relative_to(settings.workspace_base_dir)).replace("\\", "/")
                score = 0
                # 文件名匹配
                if q in physical.name.lower():
                    score += 5
                # 内容匹配（仅文本文件）
                if physical.suffix.lower() in (
                    ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx",
                    ".json", ".yml", ".yaml", ".html", ".css", ".java",
                    ".go", ".rs", ".c", ".cpp", ".sh", ".sql",
                ):
                    try:
                        text = physical.read_text(encoding="utf-8", errors="ignore").lower()
                        cnt = text.count(q)
                        if cnt:
                            score += min(cnt, 20)
                    except Exception:
                        pass
                if score:
                    hits.append({"path": rel, "score": score,
                                 "size": physical.stat().st_size})
        except Exception as e:
            logger.warning(f"[VFS] search error: {e}")
        hits.sort(key=lambda x: x["score"], reverse=True)
        return hits[:limit]

    def watch(self, path: str, callback: Callable[[str, str], None]):
        """
        基于 watchdog 监听目录变更（优雅降级：watchdog 不可用时返回 None）。
        callback(event_type, virtual_path)
        """
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except Exception as e:
            logger.warning(f"[VFS] watchdog unavailable, watch disabled: {e}")
            return None

        target = _resolve_physical(path)
        if not target.exists():
            target.mkdir(parents=True, exist_ok=True)

        class _Handler(FileSystemEventHandler):
            def on_any_event(self, event):
                try:
                    vp = "/" + str(Path(event.src_path).resolve().relative_to(
                        settings.workspace_base_dir.resolve())).replace("\\", "/")
                except Exception:
                    vp = event.src_path
                kind = "modified" if event.event_type == "modified" else event.event_type
                try:
                    callback(kind, vp)
                except Exception as e:
                    logger.warning(f"[VFS] watch callback error: {e}")

        observer = Observer()
        observer.schedule(_Handler(), str(target), recursive=True)
        observer.daemon = True
        observer.start()
        logger.info(f"[VFS] watching {path} -> {target}")
        return observer

    def delete(self, path: str) -> bool:
        p = _resolve_physical(path)
        if not p.exists():
            return False
        try:
            if p.is_dir():
                import shutil
                shutil.rmtree(p)
            else:
                p.unlink()
            mp = _meta_path(p)
            if mp.exists():
                mp.unlink()
            return True
        except Exception as e:
            logger.warning(f"[VFS] delete failed {path}: {e}")
            return False


# ─── 模块级单例 ────────────────────────────────────────────────
vfs = LocalFileStore()
