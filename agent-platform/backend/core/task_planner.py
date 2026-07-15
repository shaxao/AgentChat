# -*- coding: utf-8 -*-
"""
智能任务规划器 — 使用 LLM 分析需求并自动拆分子任务

功能：
1. 分析用户需求 → 生成总体方案、架构设计、技术栈推荐
2. 拆分为可执行的子任务，分配 Agent 类型
3. 分析依赖关系，生成执行分组（同组内可并行）
4. 支持 SSE 实时推送规划进度
"""
import asyncio
import json
import re
from datetime import datetime
from typing import Optional

from loguru import logger

from schemas.task import SubTask, SubTaskStatus, TaskPlan


def _light_script_files(project_recon: dict, project_type: str = "", description: str = "") -> list[str]:
    """Return language-neutral candidate implementation files for small delivery tasks.

    These are hints for the agent, not a fixed template. Existing entrypoints always
    win; otherwise choose a compact layout from recon and user intent.
    """
    entrypoints = [
        str(p).replace("\\", "/").lstrip("/")
        for p in (project_recon.get("entrypoints") or [])
        if str(p).strip()
    ]
    if entrypoints:
        return entrypoints[:5]

    stack_text = " ".join([
        project_type or "",
        description or "",
        *(str(x) for x in (project_recon.get("likely_stack") or [])),
    ]).lower()
    if "typescript" in stack_text or re.search(r"\bts\b", stack_text):
        return ["src/index.ts", "src/processor.ts", "README.md"]
    if "node" in stack_text or "javascript" in stack_text or re.search(r"\bjs\b", stack_text):
        return ["src/index.js", "src/processor.js", "README.md"]
    if "powershell" in stack_text or ".ps1" in stack_text:
        return ["script.ps1", "README.md"]
    if "shell" in stack_text or "bash" in stack_text or ".sh" in stack_text:
        return ["script.sh", "README.md"]
    if "go" in stack_text:
        return ["main.go", "README.md"]
    if "java" in stack_text:
        return ["src/main/java/Main.java", "README.md"]
    if "rust" in stack_text:
        return ["Cargo.toml", "src/main.rs", "README.md"]
    if "php" in stack_text:
        return ["index.php", "README.md"]
    if "ruby" in stack_text:
        return ["main.rb", "README.md"]
    return ["src/main.py", "src/config.py", "src/reader.py", "src/processor.py", "src/writer.py", "README.md"]


# ─── 规划系统提示词 ──────────────────────────────────────────────
PLANNER_SYSTEM_PROMPT = """你是一个资深的软件架构师和项目规划专家 (Task Planner)。

你的职责是分析用户的项目需求，制定详细的开发计划。

## 输出格式

你必须返回一个严格的 JSON 对象，包含以下字段：

```json
{
  "overall_approach": "总体方案概述，1-3 句话描述核心思路",
  "architecture": "架构设计说明，包括组件树/数据流/路由设计",
  "tech_stack": {
    "frontend": "推荐的前端技术（如 React 19 + TypeScript）",
    "styling": "推荐的样式方案（如 Tailwind CSS + shadcn/ui）",
    "state_management": "推荐的状态管理（如 Zustand / Context）",
    "routing": "路由方案（如 Next.js App Router）",
    "key_libraries": ["需要的核心库1", "核心库2"]
  },
  "subtasks": [
    {
      "title": "子任务标题（简短）",
      "description": "子任务具体描述，包括要创建的文件和实现的功能",
      "agent_type": "frontend / backend / fullstack",
      "estimated_files": ["src/app/page.tsx", "src/components/Header.tsx"],
      "dependencies": []  // 依赖的子任务索引（从 0 开始），无依赖则为空数组
    }
  ]
}
```

## 子任务拆分原则

1. 每个子任务应该是独立可验证的（完成后可 git commit）
2. 子任务粒度适中：每个约 3-8 个文件，1-3 个核心功能
3. 按照软件开发的自然顺序排列：基础配置 → 数据/状态 → 组件 → 页面 → 样式 → 测试
4. 有依赖关系的子任务按顺序排列（前序子任务的索引 < 后续子任务的索引）
5. 无依赖关系的子任务放在同一执行组，可以并行执行
6. dependencies 字段填写依赖的子任务在数组中的索引（从 0 开始）

## 子任务粒度示例

好的拆分：
- "搭建 Next.js 项目基础结构，配置 TypeScript 和 Tailwind CSS"
- "实现用户认证系统（登录/注册页面 + JWT token 管理）"
- "创建数据仪表盘页面，包含统计卡片和图表"

坏的拆分（太粗糙）：
- "实现所有前端页面"
- "写后端代码"

坏的拆分（太细碎）：
- "创建 Button 组件"
- "添加 CSS 变量 --primary-color"

## Agent 类型说明

- frontend: 前端页面、组件、样式、交互逻辑
- backend: API 接口、数据库、认证、业务逻辑
- fullstack: 同时涉及前后端的完整功能"""


async def plan_task(
    description: str,
    project_type: str,
    agent_types: list[str],
    llm_client,
    model: str = "",
    log_fn=None,
    project_recon: Optional[dict] = None,
) -> TaskPlan:
    """
    使用 LLM 分析需求并生成任务规划。

    Args:
        description: 用户需求描述
        project_type: 项目类型
        agent_types: 可用的 Agent 类型列表
        llm_client: LLM 客户端实例
        model: 模型名称
        log_fn: 日志回调函数

    Returns:
        TaskPlan: 规划结果
    """
    if log_fn is None:
        def log_fn(level, msg, agent="planner", detail=""):
            logger.info(f"[{agent}] {msg}")

    log_fn("info", "🔍 开始分析需求，生成任务规划...", "planner")

    if project_recon and str(project_recon.get("recommended_flow") or "") in {"light_script", "light_tool"}:
        flow = str(project_recon.get("recommended_flow"))
        log_fn("info", f"项目侦察选择轻量流程: {flow}", "planner")
        return _recon_lightweight_plan(description, project_type, agent_types, project_recon)

    prompt = f"""请为以下项目需求生成详细的开发计划：

## 项目类型
{project_type}

## 可用 Agent
{", ".join(agent_types)}

## 用户需求
{description}

请按照系统提示词中的 JSON 格式返回规划结果。确保：
1. 子任务数量在 3-8 个之间
2. 每个子任务的 agent_type 必须在可用 Agent 列表中选择
3. 子任务按依赖关系排序，dependencies 使用数组索引
4. estimated_files 列出该子任务预计创建/修改的核心文件

## 通用规划底线
- 如果用户目标是开发、修复、增加功能、处理报错或列出了函数/文件/属性/错误点，第一批子任务必须包含真实代码/配置变更和验证，不能只产出 PRD、SPEC、SCRIPT_CONTRACT 或设计文档。
- 文档、契约、使用说明只能作为辅助产物；除非用户明确只要求文档，否则不要把文档阶段放在实现前面阻塞交付。
- 每个阶段都应服务于 Agentic Loop：理解目标 → 最小必要检索 → 精准修改 → 运行验证 → 根据失败继续修复。
- 对现有项目优先复用已有入口、架构、命令和依赖；对空项目按侦察到的语言/技术栈选择候选入口，不要写死某一种语言。"""

    log_fn("info", "⏳ 正在调用 LLM 生成规划...", "planner")

    prompt += "\n\n强制输出语言：所有用户可见的计划标题、描述、总体方案、架构说明、技术栈说明必须使用简体中文。文件名、命令、框架名和 JSON 字段名可以保留英文。"

    try:
        response = await llm_client.chat(
            messages=[{"role": "user", "content": prompt}],
            system=PLANNER_SYSTEM_PROMPT,
            tools=[],
        )
    except Exception as e:
        logger.error(f"[Planner] LLM 调用失败: {e}")
        log_fn("error", f"❌ 规划生成失败: {e}", "planner")
        # 返回降级方案
        return _fallback_plan(description, project_type, agent_types)

    content = response.content or ""

    # 提取 JSON
    plan_data = _extract_json(content)

    if not plan_data:
        logger.warning(f"[Planner] 无法解析 LLM 响应为 JSON，使用降级方案")
        log_fn("warn", "⚠️ LLM 响应无法解析，使用默认规划方案", "planner")
        return _fallback_plan(description, project_type, agent_types)

    # 构建 TaskPlan
    subtasks = []
    for i, st in enumerate(plan_data.get("subtasks", [])):
        deps = st.get("dependencies", [])
        # 将依赖索引转为子任务 ID
        dep_ids = [f"st-{d}" if isinstance(d, int) else str(d) for d in deps]

        subtask = SubTask(
            id=f"st-{i}",
            title=st.get("title", f"子任务 {i+1}"),
            description=st.get("description", ""),
            agent_type=st.get("agent_type", agent_types[0] if agent_types else "frontend"),
            estimated_files=st.get("estimated_files", []),
            dependencies=dep_ids,
            status=SubTaskStatus.pending,
        )
        subtasks.append(subtask)

    # 计算执行分组（同一组内的子任务无相互依赖，可并行）
    execution_groups = _compute_execution_groups(subtasks)

    plan = TaskPlan(
        overall_approach=plan_data.get("overall_approach", ""),
        architecture=plan_data.get("architecture", ""),
        tech_stack=plan_data.get("tech_stack", {}),
        subtasks=subtasks,
        execution_groups=execution_groups,
    )

    log_fn("success", f"✅ 任务规划完成：{len(subtasks)} 个子任务，{len(execution_groups)} 个执行组", "planner")
    log_fn("info", f"📋 总体方案: {plan.overall_approach[:200]}", "planner")

    for i, st in enumerate(subtasks):
        dep_str = f" (依赖: {', '.join(st.dependencies)})" if st.dependencies else ""
        log_fn("info", f"  [{i}] {st.title} [{st.agent_type}]{dep_str}", "planner")

    return plan


def _extract_json(text: str) -> Optional[dict]:
    """从 LLM 响应中提取 JSON 对象"""
    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 尝试提取 ```json ... ``` 代码块
    json_block_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if json_block_match:
        try:
            return json.loads(json_block_match.group(1))
        except json.JSONDecodeError:
            pass

    # 尝试提取 { ... } 最外层
    brace_match = re.search(r'\{.*\}', text, re.DOTALL)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    return None


def _compute_execution_groups(subtasks: list[SubTask]) -> list[list[str]]:
    """根据依赖关系计算执行分组"""
    if not subtasks:
        return []

    # 构建依赖图
    deps = {st.id: set(st.dependencies) for st in subtasks}
    completed = set()
    groups = []
    remaining = set(st.id for st in subtasks)

    while remaining:
        # 找出所有依赖已完成的子任务
        ready = set()
        for tid in remaining:
            if deps[tid].issubset(completed):
                ready.add(tid)

        if not ready:
            # 死锁检测：如果有剩余但无就绪，跳过无法满足依赖的
            logger.warning(f"[Planner] 执行分组存在死锁，剩余: {remaining}")
            groups.append(list(remaining))
            break

        groups.append(sorted(ready, key=lambda x: int(x.split("-")[1]) if x.startswith("st-") else 0))
        completed.update(ready)
        remaining -= ready

    return groups


def _recon_lightweight_plan(
    description: str,
    project_type: str,
    agent_types: list[str],
    project_recon: dict,
) -> TaskPlan:
    """为脚本和小型导入项目生成确定性的中文计划。"""
    agent = agent_types[0] if agent_types else "frontend"
    flow = str(project_recon.get("recommended_flow") or "light_tool")
    entrypoints = project_recon.get("entrypoints") or []
    implementation_files = _light_script_files(project_recon, project_type, description)
    commands = project_recon.get("commands") or {}
    validation = commands.get("test") or commands.get("build") or "执行最小冒烟测试"
    if flow == "light_script":
        first_title = "实现并验证可运行脚本"
        first_desc = (
            f"围绕用户目标直接交付可运行脚本/工具：{description}。"
            "先用项目侦察结果和少量检索定位语言、入口和依赖；"
            "必须创建或修改真实源码/脚本入口，入口候选仅作为参考，不能只写 SCRIPT_CONTRACT.md、SPEC.md 或工作备注。"
            "根据实际语言选择入口，例如 Python main.py/cli.py、Node index.js/cli.js、TypeScript src/index.ts、"
            "Shell script.sh、PowerShell script.ps1、Go main.go、Java src/main/java/Main.java；已有入口优先复用。"
            "完成后运行最小可行验证，失败要分析并修复后重试。"
        )
    else:
        first_title = "定位并完成聚焦改动"
        first_desc = (
            f"围绕用户目标完成最小必要改动：{description}。"
            "先读取项目地图、入口和与需求相关的少量文件，避免全量遍历；"
            "优先复用现有架构和入口，使用精准 patch 修改，避免重写无关文件；"
            "如果用户列出了函数、文件、属性、错误点或测试失败信息，必须进入修改与验证，不能要求用户再次说明。"
        )

    subtasks = [
        SubTask(
            id="st-0",
            title=first_title,
            description=first_desc,
            agent_type=agent,
            estimated_files=implementation_files,
            status=SubTaskStatus.pending,
        ),
        SubTask(
            id="st-1",
            title="验证、修复并补充交付说明",
            description=(
                f"运行可用验证命令（{validation}），按失败输出继续修复直到通过或明确说明环境限制。"
                "只在有助于用户使用时补充 README/命令说明；不要为了通过审查生成无意义兜底文件。"
                "总结实际修改文件、验证命令和结果。"
            ),
            agent_type=agent,
            estimated_files=["README.md", ".autocode/COMMANDS.md", ".autocode/CI_REPORT.md"],
            dependencies=["st-0"],
            status=SubTaskStatus.pending,
        ),
    ]
    return TaskPlan(
        overall_approach=(
            "采用通用 Agentic Loop：先基于侦察结果做最小必要检索，再直接实现真实产物，"
            "随后按项目类型验证并修复。文档和契约只作为辅助产物，不再作为阻塞实现的固定前置阶段。"
        ),
        architecture=(
            "项目侦察将该任务识别为 "
            f"{project_recon.get('complexity')} / {project_recon.get('recommended_flow')}. "
            "除非用户明确要求，否则跳过重型 PRD、契约优先和 UI 原型确认，把预算用于实现、验证和修复。"
        ),
        tech_stack={
            "detected": ", ".join(project_recon.get("likely_stack") or ["unknown"]),
            "commands": commands,
        },
        subtasks=subtasks,
        execution_groups=[[st.id] for st in subtasks],
    )

def _fallback_plan(description: str, project_type: str, agent_types: list[str]) -> TaskPlan:
    """当 LLM 规划失败时的降级方案"""
    agent = agent_types[0] if agent_types else "frontend"

    subtasks = [
        SubTask(
            id="st-0",
            title="定位并实现核心需求",
            description=(
                f"在规划模型不可用时使用通用 Agentic Loop 完成本次需求：{description}。"
                "先做最小必要检索，识别项目语言、入口、依赖和相关文件；"
                "如果是空项目则按用户需求和侦察结果创建最小可运行入口；如果是现有项目则精准修改相关文件。"
                "不能只生成文档或契约。"
            ),
            agent_type=agent,
            estimated_files=[],
            status=SubTaskStatus.pending,
        ),
        SubTask(
            id="st-1",
            title="验证并修复",
            description=(
                "根据项目类型选择最小验证命令并执行；如果验证失败，读取错误、修复并重新验证。"
                "如存在环境限制，明确记录限制和已完成的本地检查。"
            ),
            agent_type=agent,
            estimated_files=[],
            dependencies=["st-0"],
            status=SubTaskStatus.pending,
        ),
    ]

    return TaskPlan(
        overall_approach=f"使用通用目标驱动流程处理 {project_type} 项目：最小检索 → 真实实现 → 验证修复",
        architecture="由 Agent 根据现有项目结构和用户目标在执行时确定，避免固定模板。",
        tech_stack={"detected": project_type or "unknown"},
        subtasks=subtasks,
        execution_groups=[["st-0"], ["st-1"]],
    )
