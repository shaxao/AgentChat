# -*- coding: utf-8 -*-
"""Deploy API — 一键部署 Vercel / Docker"""
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from services.deploy_service import deploy_service
from api.workspace_security import verify_workspace_access

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["Deploy"])


class VercelDeployRequest(BaseModel):
    vercel_token: str | None = None
    project_name: str | None = None
    team_id: str | None = None


class DockerDeployRequest(BaseModel):
    registry_url: str = "registry.vercel.com"
    image_tag: str | None = None


class DeployResponse(BaseModel):
    ok: bool
    url: str | None = None
    image: str | None = None
    deploy_id: str | None = None
    status: str | None = None
    error: str | None = None


@router.post("/deploy/vercel", response_model=DeployResponse)
async def deploy_to_vercel(workspace_id: str, body: VercelDeployRequest, request: Request):
    """部署到 Vercel"""
    ws_path, _ = verify_workspace_access(workspace_id, request)

    result = await deploy_service.deploy_vercel(
        workspace_id=workspace_id,
        ws_path=ws_path,
        vercel_token=body.vercel_token,
        project_name=body.project_name,
        team_id=body.team_id,
    )
    return DeployResponse(**result)


@router.post("/deploy/docker", response_model=DeployResponse)
async def deploy_docker_image(workspace_id: str, body: DockerDeployRequest, request: Request):
    """构建并推送 Docker 镜像"""
    ws_path, _ = verify_workspace_access(workspace_id, request)

    result = await deploy_service.deploy_docker(
        workspace_id=workspace_id,
        ws_path=ws_path,
        registry_url=body.registry_url,
        image_tag=body.image_tag,
    )
    return DeployResponse(**result)


@router.get("/deployments")
async def list_deployments(workspace_id: str, request: Request):
    """列出该 Workspace 的部署历史"""
    verify_workspace_access(workspace_id, request)
    return await deploy_service.list_deployments(workspace_id)


@router.get("/deployments/{deploy_id}")
async def get_deployment_status(workspace_id: str, deploy_id: str, request: Request):
    """查询单个部署状态"""
    verify_workspace_access(workspace_id, request)
    status = await deploy_service.get_deploy_status(deploy_id)
    if not status:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return status
