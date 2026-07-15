# -*- coding: utf-8 -*-
"""Agent 信息与能力查询 API"""
from fastapi import APIRouter

from schemas.task import AgentInfo

router = APIRouter()  # prefix 由 main.py 统一添加

AGENT_REGISTRY = {
    "frontend": AgentInfo(
        name="Frontend Agent",
        description="前端开发专家，擅长 React/Next.js/Vue/CSS/UI 组件开发",
        skills=["file-write", "read", "glob", "grep", "bash", "preview", "css-design"],
    ),
    "backend": AgentInfo(
        name="Backend Agent",
        description="后端开发专家，擅长 API 设计、数据库、业务逻辑实现",
        skills=["file-write", "read", "glob", "grep", "bash", "docker", "sql-design"],
    ),
    "devops": AgentInfo(
        name="DevOps Agent",
        description="DevOps 专家，擅长 CI/CD、容器化、自动化部署",
        skills=["docker", "bash", "deploy", "rollback", "ci-cd", "nginx"],
    ),
    "researcher": AgentInfo(
        name="Researcher Agent",
        description="技术调研专家，擅长技术选型、性能分析、最佳实践研究",
        skills=["web-search", "read", "analyze", "compare", "benchmark"],
    ),
}


@router.get("")
async def list_agents():
    return list(AGENT_REGISTRY.values())


@router.get("/{agent_name}")
async def get_agent(agent_name: str):
    if agent_name not in AGENT_REGISTRY:
        return {"error": f"Unknown agent: {agent_name}"}
    return AGENT_REGISTRY[agent_name]
