# -*- coding: utf-8 -*-
"""Pydantic models for AutoCode task APIs."""
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    pending = "pending"
    running = "running"
    waiting_confirm = "waiting_confirm"
    waiting_plan_confirm = "waiting_plan_confirm"
    waiting_prototype_confirm = "waiting_prototype_confirm"
    reviewing = "reviewing"
    waiting_review_confirm = "waiting_review_confirm"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class SubTaskStatus(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    skipped = "skipped"


class ToolPolicy(str, Enum):
    ask = "ask"
    auto_safe = "auto_safe"
    full_access = "full_access"


class SubTask(BaseModel):
    """智能任务计划中的子任务。"""

    id: str = Field(..., description="子任务 ID，例如 st-0")
    title: str = Field(..., description="子任务标题")
    description: str = Field(..., description="子任务说明")
    agent_type: str = Field(default="frontend", description="执行该子任务的 Agent 类型")
    estimated_files: list[str] = Field(default_factory=list, description="预计产出的文件")
    dependencies: list[str] = Field(default_factory=list, description="依赖的子任务 ID")
    status: SubTaskStatus = Field(default=SubTaskStatus.pending)
    progress: int = Field(default=0, ge=0, le=100)


class TaskPlan(BaseModel):
    """智能任务计划结果。"""

    overall_approach: str = Field(default="", description="总体方案")
    architecture: str = Field(default="", description="架构设计")
    tech_stack: dict = Field(default_factory=dict, description="推荐技术栈")
    subtasks: list[SubTask] = Field(default_factory=list, description="子任务列表")
    execution_groups: list[list[str]] = Field(default_factory=list, description="执行分组")


class AgentLogEntry(BaseModel):
    timestamp: str
    agent: str
    level: str
    message: str
    detail: Optional[str] = None


class TaskCreate(BaseModel):
    title: str = Field(..., max_length=200, description="任务标题")
    description: str = Field(..., description="用户自然语言需求")
    project_type: str = Field(default="nextjs", description="项目类型")
    agent_types: list[str] = Field(default=["frontend"], description="启用的 Agent 类型")
    enable_smart_planning: bool = Field(default=False, description="是否启用智能规划")
    model: Optional[str] = Field(default=None, description="指定使用的模型")
    spec: Optional[str] = Field(default=None, description="开发规范，写入工作区 SPEC.md")
    user_id: Optional[str] = Field(default=None, description="用户 ID")
    tool_policy: ToolPolicy = Field(default=ToolPolicy.full_access, description="工具权限策略")
    pending_confirmation: Optional[dict] = Field(default=None, description="当前待确认操作")


class TaskResponse(BaseModel):
    id: str
    title: str
    description: str
    project_type: str
    status: TaskStatus
    created_at: str
    workspace_id: str
    agents: list[str]
    logs: list[AgentLogEntry]
    commit_history: list[dict]
    preview_url: Optional[str]
    model: Optional[str] = Field(default=None, description="任务使用的模型")
    tool_policy: ToolPolicy = Field(default=ToolPolicy.full_access, description="工具权限策略")
    plan: Optional[TaskPlan] = Field(default=None, description="智能任务计划")
    current_subtask_id: Optional[str] = Field(default=None, description="当前子任务 ID")
    review: Optional[dict] = Field(default=None, description="代码审查结果")
    phase_reviews: list[dict] = Field(default_factory=list, description="阶段代码审查结果")
    prototype: Optional[dict] = Field(default=None, description="原型数据")
    plan_confirmed: Optional[bool] = Field(default=None, description="是否已确认开发计划")
    prototype_confirmed: Optional[bool] = Field(default=None, description="是否已确认原型")
    review_confirmed: Optional[bool] = Field(default=None, description="是否已确认审查结果")
    user_id: Optional[str] = Field(default=None, description="用户 ID")
    execution_active: bool = Field(default=False, description="后端是否仍在执行该任务")
    runtime_state: str = Field(default="idle", description="运行态：active / waiting / terminal / idle")
    runtime_note: str = Field(default="", description="运行态说明")
    queued_at: Optional[str] = Field(default=None, description="后台队列入队时间")
    command_history: list[dict] = Field(default_factory=list, description="命令执行记录")
    pipeline_runs: list[dict] = Field(default_factory=list, description="流水线执行记录")
    events: list[dict] = Field(default_factory=list, description="运行事件")
    project_recon: Optional[dict] = Field(default=None, description="项目侦察结果")
    complexity: Optional[str] = Field(default=None, description="S0/S1/S2/S3 复杂度")
    recommended_flow: Optional[str] = Field(default=None, description="推荐执行流")
    prototype_required: Optional[bool] = Field(default=None, description="是否需要 UI 原型")
    pipeline_status: Optional[str] = Field(default=None, description="最近流水线状态")
    preview_status: Optional[str] = Field(default=None, description="预览状态")
    preview_error: Optional[str] = Field(default=None, description="预览错误")


    local_execution_enabled: bool = Field(default=False, description="本地执行是否开启")
    local_runner_session_id: Optional[str] = Field(default=None, description="本地连接器会话 ID")
    local_import_mode: bool = Field(default=False, description="是否为本地导入任务")
    cloud_snapshot_enabled: bool = Field(default=False, description="是否启用云端副本")
    cloud_snapshot_status: Optional[str] = Field(default=None, description="云端副本同步状态")
    cloud_snapshot_error: Optional[str] = Field(default=None, description="云端副本同步错误")
    local_runner: Optional[dict] = Field(default=None, description="本地连接器实时状态")


class TaskStatusResponse(BaseModel):
    status: TaskStatus
    progress: int = Field(ge=0, le=100, default=0)
    current_step: str = ""
    preview_url: Optional[str] = None
    workspace_id: Optional[str] = None
    model: Optional[str] = None
    tool_policy: ToolPolicy = ToolPolicy.full_access
    pending_confirmation: Optional[dict] = None
    plan: Optional[TaskPlan] = None
    review: Optional[dict] = None
    phase_reviews: list[dict] = Field(default_factory=list)
    prototype: Optional[dict] = None
    plan_confirmed: Optional[bool] = None
    prototype_confirmed: Optional[bool] = None
    review_confirmed: Optional[bool] = None
    execution_active: bool = False
    runtime_state: str = "idle"
    runtime_note: str = ""
    queued_at: Optional[str] = None
    command_history: list[dict] = Field(default_factory=list)
    pipeline_runs: list[dict] = Field(default_factory=list)
    project_recon: Optional[dict] = None
    complexity: Optional[str] = None
    recommended_flow: Optional[str] = None
    prototype_required: Optional[bool] = None
    pipeline_status: Optional[str] = None
    preview_status: Optional[str] = None
    preview_error: Optional[str] = None


class WorkspaceCreate(BaseModel):
    project_type: str = "default"
    name: Optional[str] = None


class WorkspaceResponse(BaseModel):
    workspace_id: str
    path: str
    container_id: Optional[str]
    mode: str
    created_at: str
    status: str = "active"


class GitCommit(BaseModel):
    hash: str
    message: str
    author: str
    date: str
    files_changed: list[str]
    metadata: Optional[dict] = None


class AgentInfo(BaseModel):
    name: str
    description: str
    skills: list[str]
    status: str = "idle"
