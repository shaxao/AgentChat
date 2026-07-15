# -*- coding: utf-8 -*-
"""
Deploy Service — 一键部署服务

支持两种部署方式：
1. Vercel — 通过 Vercel API 直接推送项目
2. Docker Image — 构建 Docker 镜像并推送到镜像仓库

使用流程：
1. build_package() — 打包项目（npm run build 等）
2. deploy_vercel() / deploy_docker() — 执行部署
3. get_deploy_status() — 查询部署状态
"""
import asyncio
import json
import base64
import zipfile
import io
import os
import httpx
from datetime import datetime
from pathlib import Path
from typing import Optional

from loguru import logger

from core.config import get_settings


class DeployService:
    """
    一键部署服务 — 支持 Vercel 和 Docker 镜像两种方式。
    """

    def __init__(self):
        self._settings = get_settings()
        self._deployments: dict[str, dict] = {}

    # ─── Vercel 部署 ──────────────────────────────────────────────────

    async def deploy_vercel(
        self,
        workspace_id: str,
        ws_path: Path,
        vercel_token: str | None = None,
        project_name: str | None = None,
        team_id: str | None = None,
        log_fn=None,
    ) -> dict:
        """
        通过 Vercel API 部署项目。

        流程：
        1. 创建 zip 包（包含构建产物）
        2. 上传到 Vercel
        3. 返回部署 URL
        """
        token = vercel_token or self._settings.vercel_api_token
        if not token:
            return {"ok": False, "error": "Vercel token 未配置"}

        if log_fn:
            log_fn("info", "📦 打包项目...", "deploy")

        # 1. 打包项目（构建产物 + 配置）
        zip_buffer = await self._build_project_zip(workspace_id, ws_path, log_fn)
        if not zip_buffer:
            return {"ok": False, "error": "打包失败"}

        deploy_id = f"deploy-{workspace_id}-{datetime.utcnow().strftime('%H%m%s')}"
        self._deployments[deploy_id] = {
            "type": "vercel",
            "workspace_id": workspace_id,
            "status": "building",
            "created_at": datetime.utcnow().isoformat(),
        }

        if log_fn:
            log_fn("info", f"🚀 推送到 Vercel (project: {project_name or workspace_id})", "deploy")

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                # 2. 上传 zip 到 Vercel
                files = {"file": ("project.zip", zip_buffer, "application/zip")}
                data = {"package": ".*", "project": project_name or workspace_id}
                if team_id:
                    data["teamId"] = team_id

                # 获取上传 URL
                upload_resp = await client.post(
                    "https://api.vercel.com/v2/deployments",
                    headers={"Authorization": f"Bearer {token}"},
                    data={"forceNew": "true", "projectName": project_name or workspace_id},
                    files=files,
                )

                if upload_resp.status_code in (200, 201):
                    result = upload_resp.json()
                    deploy_url = result.get("url", "")
                    deploy_id_ = result.get("id", deploy_id)

                    self._deployments[deploy_id_] = {
                        "type": "vercel",
                        "workspace_id": workspace_id,
                        "status": "ready",
                        "url": f"https://{deploy_url}",
                        "id": deploy_id_,
                        "created_at": datetime.utcnow().isoformat(),
                    }

                    if log_fn:
                        log_fn("success", f"🌐 部署完成: https://{deploy_url}", "deploy")
                    return {
                        "ok": True,
                        "url": f"https://{deploy_url}",
                        "deploy_id": deploy_id_,
                        "status": "ready",
                    }
                else:
                    error_text = upload_resp.text
                    logger.warning(f"[Deploy] Vercel API 错误: {error_text}")
                    if log_fn:
                        log_fn("error", f"Vercel 部署失败: {error_text[:200]}", "deploy")
                    return {"ok": False, "error": error_text[:200]}

        except Exception as e:
            logger.error(f"[Deploy] Vercel 部署异常: {e}")
            if log_fn:
                log_fn("error", f"部署异常: {e}", "deploy")
            return {"ok": False, "error": str(e)}

    async def _build_project_zip(
        self,
        workspace_id: str,
        ws_path: Path,
        log_fn=None,
    ) -> Optional[io.BytesIO]:
        """构建项目 zip 包（包含 build 产物）"""
        try:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                # 递归添加所有文件（排除 node_modules, .git, .next 等）
                skip_dirs = {".git", "node_modules", ".next", "dist", "__pycache__", ".venv", ".pytest_cache", ".vercel"}
                skip_files = {".DS_Store", "Thumbs.db", "*.pyc", "*.log"}

                for root, dirs, files in os.walk(ws_path):
                    # 过滤掉要跳过的目录
                    dirs[:] = [d for d in dirs if d not in skip_dirs]

                    for file in files:
                        if any(file.endswith(s.replace("*", "")) for s in skip_files):
                            continue
                        full_path = Path(root) / file
                        arcname = str(full_path.relative_to(ws_path))
                        zf.write(full_path, arcname)

            buffer.seek(0)
            if log_fn:
                log_fn("info", f"📦 打包完成: {buffer.getbuffer().nbytes // 1024} KB", "deploy")
            return buffer
        except Exception as e:
            logger.error(f"[Deploy] 打包失败: {e}")
            return None

    # ─── Docker 镜像部署 ─────────────────────────────────────────────

    async def deploy_docker(
        self,
        workspace_id: str,
        ws_path: Path,
        registry_url: str | None = None,
        image_tag: str | None = None,
        log_fn=None,
    ) -> dict:
        """
        构建 Docker 镜像并推送到镜像仓库。

        工作流程：
        1. 生成 Dockerfile（基于 ws_path 内容检测）
        2. docker build -t
        3. docker push
        """
        import docker as docker_sdk

        if log_fn:
            log_fn("info", "🐳 构建 Docker 镜像...", "deploy")

        tag = image_tag or f"{registry_url}/autocode/{workspace_id}:latest"

        try:
            client = docker_sdk.from_env()

            # 检测技术栈，生成对应 Dockerfile
            dockerfile_content = self._generate_dockerfile(ws_path)
            dockerfile_path = ws_path / "Dockerfile.deploy"
            dockerfile_path.write_text(dockerfile_content, encoding="utf-8")

            if log_fn:
                log_fn("info", f"📝 Dockerfile 已生成，tag: {tag}", "deploy")

            # docker build
            image, build_logs = client.images.build(
                path=str(ws_path),
                dockerfile="Dockerfile.deploy",
                tag=tag,
                rm=True,
                forcerm=True,
            )

            build_output = []
            for chunk in build_logs:
                if "stream" in chunk:
                    build_output.append(chunk["stream"])
            if log_fn:
                log_fn("info", "✅ 镜像构建完成", "deploy")

            # docker push
            if log_fn:
                log_fn("info", f"📤 推送镜像到 {registry_url}...", "deploy")

            for line in client.images.push(tag, stream=True, decode=True):
                status = line.get("status", "")
                if "Pushing" in status or "Pushed" in status or "digest" in status:
                    if log_fn:
                        log_fn("info", status[:100], "deploy")

            if log_fn:
                log_fn("success", f"🎉 镜像推送完成: {tag}", "deploy")

            return {
                "ok": True,
                "image": tag,
                "registry": registry_url,
                "status": "pushed",
            }

        except Exception as e:
            logger.error(f"[Deploy] Docker 部署失败: {e}")
            if log_fn:
                log_fn("error", f"Docker 部署失败: {e}", "deploy")
            return {"ok": False, "error": str(e)}

    def _generate_dockerfile(self, ws_path: Path) -> str:
        """根据项目内容生成最佳 Dockerfile"""
        pkg_json = ws_path / "package.json"
        reqs_txt = ws_path / "requirements.txt"
        go_mod = ws_path / "go.mod"
        pom_xml = ws_path / "pom.xml"

        if reqs_txt.exists():
            return f"""FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
"""
        if go_mod.exists():
            return f"""FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o server .
FROM alpine:latest
COPY --from=builder /app/server .
EXPOSE 8080
CMD ["./server"]
"""
        if pom_xml.exists():
            return f"""FROM eclipse-temurin:21-jre
COPY target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
"""
        # 默认：Node.js
        return f"""FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install && npm run build
EXPOSE 3000
CMD ["npm", "start"]
"""

    # ─── 状态查询 ────────────────────────────────────────────────────

    async def get_deploy_status(self, deploy_id: str) -> Optional[dict]:
        """查询部署状态"""
        return self._deployments.get(deploy_id)

    async def list_deployments(self, workspace_id: str) -> list[dict]:
        """列出某 Workspace 的所有部署记录"""
        return [
            d for d in self._deployments.values()
            if d.get("workspace_id") == workspace_id
        ]


deploy_service = DeployService()
