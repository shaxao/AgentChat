# -*- coding: utf-8 -*-
"""项目管理 API — Git Clone、文件导入、项目列表"""
import asyncio
import json
import os
import shutil
import subprocess
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from loguru import logger
from pydantic import BaseModel

from core.config import get_settings
from core.docker_manager import docker_manager
from core.git_manager import git_manager
from core.project_recon import run_project_recon
from core.state import _tasks
from core.task_planner import plan_task
from core.agent_orchestrator import agent_orchestrator
from services.task_repository import save_task

router = APIRouter(prefix="/projects", tags=["Projects"])
settings = get_settings()

# 内存态（生产环境应换 Redis/DB）
_projects: dict[str, dict] = {}
_projects_restored = False


# 支持的上传格式（扩展名）
ALLOWED_EXTENSIONS = {".zip", ".tar", ".tar.gz", ".tgz"}
MAX_UPLOAD_SIZE_MB = 100


class RegisterProjectTaskRequest(BaseModel):
    enable_smart_planning: bool = False


def _project_index_path() -> Path:
    settings.workspace_base_dir.mkdir(parents=True, exist_ok=True)
    return settings.workspace_base_dir / ".autocode_projects.json"


def _serialize_project(pj: dict) -> dict:
    data = dict(pj)
    if isinstance(data.get("path"), Path):
        data["path"] = str(data["path"])
    return data


def _save_projects_index() -> None:
    try:
        payload = {
            pid: _serialize_project(pj)
            for pid, pj in _projects.items()
        }
        _project_index_path().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.debug(f"[Projects] save index failed: {exc}")


def restore_projects() -> int:
    global _projects_restored
    path = _project_index_path()
    if not path.exists():
        _projects_restored = True
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        for pid, pj in (data or {}).items():
            if not isinstance(pj, dict):
                continue
            pj["path"] = Path(pj.get("path") or _project_dir(pid))
            if pj.get("status") in {"cloning", "uploading"}:
                pj["status"] = "failed"
                pj["clone_output"] = (pj.get("clone_output") or "") + "\nInterrupted by backend restart."
            _projects[pid] = pj
        _projects_restored = True
        return len(_projects)
    except Exception as exc:
        logger.warning(f"[Projects] restore index failed: {exc}")
        _projects_restored = True
        return 0


def _ensure_projects_restored() -> None:
    if not _projects_restored:
        restore_projects()


def _project_dir(project_id: str) -> Path:
    return settings.workspace_base_dir / f"pj-{project_id}"


def _safe_archive_target(root: Path, member_name: str) -> Path:
    target = (root.resolve() / member_name).resolve()
    if root.resolve() not in (target, *target.parents):
        raise ValueError(f"archive entry escapes destination: {member_name}")
    return target


def _safe_extract_zip(zf: zipfile.ZipFile, dest_dir: Path):
    for info in zf.infolist():
        target = _safe_archive_target(dest_dir, info.filename)
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info, "r") as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)


def _safe_extract_tar(tf, dest_dir: Path):
    for member in tf.getmembers():
        if member.issym() or member.islnk():
            raise ValueError("tar links are not allowed")
        target = _safe_archive_target(dest_dir, member.name)
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if member.isfile():
            target.parent.mkdir(parents=True, exist_ok=True)
            src = tf.extractfile(member)
            if src is None:
                continue
            with src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def _extract_archive(archive_path: Path, dest_dir: Path) -> tuple[bool, str]:
    """解压归档文件到目标目录，返回 (success, message)"""
    try:
        if archive_path.suffix == ".zip" or str(archive_path).endswith(".zip"):
            with zipfile.ZipFile(archive_path, "r") as zf:
                # 安全检查：防止 zip bomb
                total_size = sum(info.file_size for info in zf.infolist())
                if total_size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
                    return False, f"解压后文件总大小超过 {MAX_UPLOAD_SIZE_MB}MB 限制"
                _safe_extract_zip(zf, dest_dir)
        elif archive_path.suffix in (".tar", ".gz", ".tgz"):
            import tarfile
            with tarfile.open(archive_path, "r:*") as tf:
                # 安全检查
                total_size = sum(m.size for m in tf.getmembers() if m.isfile())
                if total_size > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
                    return False, f"解压后文件总大小超过 {MAX_UPLOAD_SIZE_MB}MB 限制"
                _safe_extract_tar(tf, dest_dir)
        else:
            return False, "不支持的文件格式，仅支持 .zip / .tar / .tar.gz"
        return True, "解压成功"
    except Exception as e:
        return False, f"解压失败: {str(e)}"


def _sanitize_upload_name(name: str) -> str:
    """清理上传文件名，只保留字母数字、中文、下划线和连字符"""
    import re
    name = re.sub(r'[^\w\u4e00-\u9fff\-\.]', '_', name).strip('_')
    if not name:
        name = "uploaded-project"
    return name[:64]

# ─── GET /api/projects — 项目列表 ────────────────────────────────
@router.get("")
async def list_projects():
    """列出所有已导入的项目"""
    _ensure_projects_restored()
    result = []
    for pid, pj in _projects.items():
        result.append({
            "id": pid,
            "name": pj["name"],
            "source": pj["source"],
            "source_url": pj.get("source_url"),
            "path": str(pj["path"]),
            "status": pj["status"],
            "created_at": pj["created_at"],
            "file_count": pj.get("file_count", 0),
        })
    result.sort(key=lambda x: x["created_at"], reverse=True)
    return result


# ─── POST /api/projects/clone — Git 克隆 ────────────────────────
@router.post("/clone")
async def clone_project(body: dict):
    """
    从 Git URL 克隆项目到平台。
    body: { git_url, project_name? }
    返回 project_id，后续创建任务时可传入 project_id 复用 workspace。
    """
    git_url = (body.get("git_url") or "").strip()
    if not git_url:
        raise HTTPException(status_code=400, detail="git_url 不能为空")

    project_id = uuid.uuid4().hex[:12]
    project_name = (body.get("project_name") or "").strip() or git_url.rstrip("/").split("/")[-1].replace(".git", "")
    if not project_name:
        project_name = f"project-{project_id}"

    ws_path = _project_dir(project_id)
    ws_path.mkdir(parents=True, exist_ok=True)

    pj = {
        "id": project_id,
        "name": project_name,
        "source": "git",
        "source_url": git_url,
        "path": ws_path,
        "status": "cloning",
        "created_at": datetime.utcnow().isoformat(),
        "clone_output": "",
        "file_count": 0,
    }
    _projects[project_id] = pj
    _save_projects_index()

    # 后台执行 git clone
    async def _do_clone():
        try:
            # 直接 clone 到 workspace 目录
            cmd = ["git", "clone", "--depth", "1", git_url, str(ws_path)]
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
            clone_output = stdout.decode("utf-8", errors="replace") if stdout else ""

            if proc.returncode == 0:
                # 统计文件数
                file_count = sum(1 for _ in ws_path.rglob("*") if _.is_file())
                _projects[project_id]["status"] = "ready"
                _projects[project_id]["clone_output"] = clone_output[-500:]
                _projects[project_id]["file_count"] = file_count
                _save_projects_index()
                logger.info(f"[Projects] Git clone 完成: {project_name} ({file_count} 文件)")
            else:
                _projects[project_id]["status"] = "failed"
                _projects[project_id]["clone_output"] = clone_output[-1000:]
                _save_projects_index()
                logger.error(f"[Projects] Git clone 失败: {project_name}, 输出: {clone_output[-200:]}")
        except asyncio.TimeoutError:
            _projects[project_id]["status"] = "failed"
            _projects[project_id]["clone_output"] = "克隆超时（5分钟）"
            logger.error(f"[Projects] Git clone 超时: {project_name}")
        except Exception as e:
            _projects[project_id]["status"] = "failed"
            _projects[project_id]["clone_output"] = str(e)
            _save_projects_index()
            logger.error(f"[Projects] Git clone 异常: {project_name}, {e}")

    asyncio.create_task(_do_clone())
    return {"project_id": project_id, "name": project_name, "status": "cloning"}


# ─── POST /api/projects/upload — 上传本地项目 ───────────────────
@router.post("/upload")
async def upload_project(
    file: UploadFile = File(...),
    project_name: str = "",
):
    """
    上传本地 ZIP/TAR 项目压缩包，解压到工作空间。
    也支持直接上传单个文件（如 README.md、单个 .py 文件等）。
    """
    raw_name = (project_name or file.filename or "uploaded").strip()
    project_name = _sanitize_upload_name(raw_name)
    project_id = uuid.uuid4().hex[:12]

    ws_path = _project_dir(project_id)
    ws_path.mkdir(parents=True, exist_ok=True)

    pj = {
        "id": project_id,
        "name": project_name,
        "source": "upload",
        "source_url": None,
        "path": ws_path,
        "status": "uploading",
        "created_at": datetime.utcnow().isoformat(),
        "file_count": 0,
    }
    _projects[project_id] = pj
    _save_projects_index()

    try:
        # 保存上传文件
        upload_path = ws_path / (file.filename or "upload")
        content = await file.read()

        if len(content) > MAX_UPLOAD_SIZE_MB * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"文件大小超过 {MAX_UPLOAD_SIZE_MB}MB 限制")

        with open(upload_path, "wb") as f:
            f.write(content)

        # 判断是否为压缩包
        ext = Path(file.filename or "").suffix.lower()
        is_archive = ext in (".zip", ".tar", ".gz", ".tgz") or str(file.filename).endswith(".tar.gz")

        if is_archive:
            # 解压到临时目录，然后移动文件到 ws_path 根
            extract_tmp = ws_path / "_extract_tmp"
            extract_tmp.mkdir(exist_ok=True)
            success, msg = _extract_archive(upload_path, extract_tmp)
            if not success:
                upload_path.unlink(missing_ok=True)
                shutil.rmtree(extract_tmp, ignore_errors=True)
                raise HTTPException(status_code=400, detail=msg)

            # 处理单层文件夹包裹（如果解压后只有一个目录，则把目录内容移到 ws_path 根）
            items = list(extract_tmp.iterdir())
            if len(items) == 1 and items[0].is_dir():
                src = items[0]
                for child in src.iterdir():
                    shutil.move(str(child), str(ws_path / child.name))
                shutil.rmtree(str(src), ignore_errors=True)
            else:
                for child in items:
                    shutil.move(str(child), str(ws_path / child.name))

            shutil.rmtree(extract_tmp, ignore_errors=True)
            upload_path.unlink(missing_ok=True)
            logger.info(f"[Projects] 解压完成: {project_name} -> {ws_path}")
        else:
            # 单文件直接保留
            logger.info(f"[Projects] 单文件上传: {project_name} -> {upload_path}")

        # 统计文件数
        file_count = sum(1 for _ in ws_path.rglob("*") if _.is_file())
        pj["status"] = "ready"
        pj["file_count"] = file_count
        _save_projects_index()

        return {
            "project_id": project_id,
            "name": project_name,
            "status": "ready",
            "file_count": file_count,
        }

    except HTTPException:
        raise
    except Exception as e:
        pj["status"] = "failed"
        _save_projects_index()
        logger.error(f"[Projects] 上传失败: {project_name}, {e}")
        raise HTTPException(status_code=500, detail=f"上传处理失败: {str(e)}")


# ─── GET /api/projects/{project_id} — 项目详情 ──────────────────
@router.get("/{project_id}")
async def get_project(project_id: str):
    _ensure_projects_restored()
    if project_id not in _projects:
        raise HTTPException(status_code=404, detail="项目不存在")
    pj = _projects[project_id]
    return {
        "id": pj["id"],
        "name": pj["name"],
        "source": pj["source"],
        "source_url": pj.get("source_url"),
        "path": str(pj["path"]),
        "status": pj["status"],
        "created_at": pj["created_at"],
        "clone_output": pj.get("clone_output", ""),
        "file_count": pj.get("file_count", 0),
    }


def _get_user_id(request: Request) -> str | None:
    user_id = request.headers.get("X-User-Id")
    return user_id.strip() if user_id else None


@router.post("/{project_id}/register-task")
async def register_project_task(project_id: str, request: Request, payload: RegisterProjectTaskRequest | None = None):
    """注册导入项目，执行项目侦察，并准备计划确认门禁。"""
    _ensure_projects_restored()
    if project_id not in _projects:
        raise HTTPException(status_code=404, detail="项目不存在")

    pj = _projects[project_id]
    if pj.get("status") != "ready":
        raise HTTPException(status_code=409, detail=f"项目尚未准备完成: {pj.get('status')}")

    user_id = _get_user_id(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="请先登录")

    task_id = f"task-import-{project_id}"
    workspace_id = f"pj-{project_id}"
    ws_path = settings.workspace_base_dir / workspace_id
    description = f"基于已导入项目 {pj['name']} 进行开发，请先理解现有结构，再根据用户后续需求制定计划。"

    enable_smart_planning = bool(payload.enable_smart_planning) if payload else False
    description = f"基于已导入项目 {pj['name']} 继续开发。请先理解现有结构，再根据用户后续需求执行修改、验证和总结。"

    recon = await asyncio.to_thread(
        run_project_recon,
        ws_path,
        declared_type="imported",
        description=description,
    )
    project_type = {
        "frontend": "nextjs",
        "fullstack": "nextjs",
        "backend": "api",
        "script": "tool",
    }.get(str(recon.get("project_kind") or ""), "website")
    agents = ["frontend"]
    if recon.get("project_kind") == "backend":
        agents = ["backend"]
    elif recon.get("project_kind") == "fullstack":
        agents = ["frontend", "backend"]

    task = {
        "id": task_id,
        "title": pj["name"],
        "description": description,
        "project_type": project_type,
        "status": "waiting_plan_confirm" if enable_smart_planning else "completed",
        "progress": 5 if enable_smart_planning else 100,
        "current_step": "项目侦察已完成，等待确认开发计划...",
        "current_step": "项目侦察已完成，等待确认开发计划..." if enable_smart_planning else "项目已导入，可在 AI 助手中输入需求继续开发。",
        "created_at": pj.get("created_at") or datetime.utcnow().isoformat(),
        "workspace_id": workspace_id,
        "user_id": str(user_id),
        "agents": agents,
        "logs": [{
            "timestamp": datetime.utcnow().isoformat(),
            "agent": "recon",
            "level": "success",
            "message": (
                f"项目侦察完成: {recon.get('project_kind')} / "
                f"{recon.get('complexity')} / {recon.get('recommended_flow')}"
            ),
            "detail": json.dumps(recon, ensure_ascii=False),
        }],
        "commit_history": [],
        "preview_url": f"/workspaces/{workspace_id}/preview",
        "plan": None,
        "project_recon": recon,
        "enable_smart_planning": enable_smart_planning,
        "execution_mode": "agentic",
        "complexity": recon.get("complexity"),
        "recommended_flow": recon.get("recommended_flow"),
        "prototype_required": bool(recon.get("should_generate_prototype")),
        "current_subtask_id": None,
        "review": None,
        "phase_reviews": [],
        "prototype": None,
        "plan_confirmed": None if enable_smart_planning else True,
        "prototype_confirmed": None if recon.get("should_generate_prototype") else True,
        "review_confirmed": None,
    }

    _tasks[task_id] = task

    try:
        git_manager.init(ws_path)
        git_manager.auto_commit(ws_path, ["."], f"导入项目: {pj['name']}")
        task["commit_history"] = git_manager.log(ws_path, max_count=20)
    except Exception as exc:
        logger.warning(f"[Projects] Git init for imported task failed: {exc}")

    if not enable_smart_planning:
        save_task(task)
        return task

    try:
        recon_summary = (
            "\n\n项目侦察结果：\n"
            f"- 项目类型: {recon.get('project_kind')}\n"
            f"- 复杂度: {recon.get('complexity')}\n"
            f"- 推荐流程: {recon.get('recommended_flow')}\n"
            f"- 技术栈: {', '.join(recon.get('likely_stack') or [])}\n"
            f"- 入口文件: {', '.join((recon.get('entrypoints') or [])[:10])}\n"
            f"- 可用命令: {json.dumps(recon.get('commands') or {}, ensure_ascii=False)}\n"
            f"- 规划建议: {'; '.join(recon.get('plan_guidance') or [])}\n"
        )
        plan = await plan_task(
            description=description + recon_summary,
            project_type=project_type,
            agent_types=agents,
            llm_client=await agent_orchestrator._ensure_client(requested_model=None),
            model=agent_orchestrator._model or "",
            project_recon=recon,
        )
        task["plan"] = plan.model_dump()
    except Exception as exc:
        logger.warning(f"[Projects] Plan imported project failed: {exc}")

    save_task(task)
    return task


@router.get("/{project_id}/files")
async def list_project_files(project_id: str, subdir: str = ""):
    _ensure_projects_restored()
    if project_id not in _projects:
        raise HTTPException(status_code=404, detail="项目不存在")
    pj = _projects[project_id]
    if pj["status"] != "ready":
        return {"files": [], "total": 0, "status": pj["status"]}

    base = pj["path"]
    if subdir:
        base = base / subdir
        if not str(base).startswith(str(pj["path"])):  # 防路径穿越
            raise HTTPException(status_code=403, detail="非法路径")

    if not base.exists():
        return {"files": [], "total": 0}

    files = []
    for item in sorted(base.iterdir()):
        if item.name.startswith(".") and item.name != ".gitignore":
            continue
        stat = item.stat()
        files.append({
            "name": item.name,
            "is_dir": item.is_dir(),
            "size": stat.st_size if item.is_file() else 0,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return {"files": files, "total": len(files), "path": str(base.relative_to(pj["path"]))}


# ─── DELETE /api/projects/{project_id} — 删除项目 ──────────────
@router.delete("/{project_id}")
async def delete_project(project_id: str):
    _ensure_projects_restored()
    if project_id not in _projects:
        raise HTTPException(status_code=404, detail="项目不存在")
    pj = _projects.pop(project_id)
    _save_projects_index()
    # 异步清理文件
    async def _cleanup():
        import shutil
        if pj["path"].exists():
            shutil.rmtree(str(pj["path"]), ignore_errors=True)
        logger.info(f"[Projects] 已删除: {pj['name']}")
    asyncio.create_task(_cleanup())
    return {"ok": True}
