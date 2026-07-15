# -*- coding: utf-8 -*-
"""Lightweight project reconnaissance for AutoCode workspaces.

The scanner reads only the workspace index, shallow manifests and task text.
Its job is to provide a compact orientation signal for the Agentic Loop, not to
force the task through a fixed phase pipeline.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from core.workspace_index import load_workspace_index


MANIFEST_FILES = {
    "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json",
    "vite.config.ts", "vite.config.js", "next.config.js", "next.config.ts",
    "pom.xml", "build.gradle", "settings.gradle", "requirements.txt",
    "pyproject.toml", "Pipfile", "go.mod", "Cargo.toml", "Dockerfile",
    "docker-compose.yml", "README.md", "readme.md", ".env.example",
}

SOURCE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".astro",
    ".py", ".java", ".go", ".rs", ".php", ".rb", ".cs", ".kt",
    ".sh", ".ps1", ".sql", ".html", ".css", ".scss",
}

FRONTEND_DECLARED = {"website", "web", "nextjs", "next.js", "react", "vue", "frontend", "miniapp", "ui"}
BACKEND_DECLARED = {"api", "backend", "server", "service", "spring", "fastapi", "express", "nestjs"}
SCRIPT_DECLARED = {"tool", "script", "python", "node", "shell", "powershell", "cli"}

FRONTEND_KEYWORDS = (
    "官网", "企业官网", "网站", "网页", "页面", "首页", "产品介绍", "关于我们", "联系我们",
    "落地页", "landing", "next.js", "nextjs", "react", "vue", "nuxt", "astro",
    "frontend", "ui", "组件", "界面", "小程序",
)
BACKEND_KEYWORDS = ("api", "接口", "后端", "服务端", "数据库", "权限", "认证", "登录", "支付")
SCRIPT_KEYWORDS = ("脚本", "命令行", "cli", "批处理", "自动化脚本", "工具脚本")
RISK_KEYWORDS = ("支付", "权限", "订阅", "多租户", "数据库", "缓存", "部署", "安全")


@dataclass
class ProjectRecon:
    project_kind: str = "unknown"
    complexity: str = "S1"
    recommended_flow: str = "standard"
    should_generate_prototype: bool = False
    likely_stack: list[str] = field(default_factory=list)
    entrypoints: list[str] = field(default_factory=list)
    commands: dict[str, str] = field(default_factory=dict)
    manifests: list[str] = field(default_factory=list)
    top_level_dirs: list[str] = field(default_factory=list)
    source_file_count: int = 0
    total_file_count: int = 0
    risk_flags: list[str] = field(default_factory=list)
    plan_guidance: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def run_project_recon(ws_path: Path, *, declared_type: str = "", description: str = "") -> dict[str, Any]:
    recon = ProjectRecon()
    if not ws_path.exists():
        recon.risk_flags.append("workspace_not_found")
        return recon.to_dict()

    workspace_index = load_workspace_index(ws_path, force=True)
    indexed = list(workspace_index.get("files") or [])
    recon.top_level_dirs = list(workspace_index.get("top_level_dirs") or [])[:80]
    recon.total_file_count = int(workspace_index.get("total_file_count") or len(indexed))
    recon.source_file_count = int(workspace_index.get("source_file_count") or 0)

    for name in sorted(MANIFEST_FILES):
        if (ws_path / name).exists():
            recon.manifests.append(name)

    package_data = _read_package_json(ws_path / "package.json")
    _detect_commands(ws_path, recon, package_data)
    _detect_stack_and_kind(ws_path, recon, package_data, declared_type, description)
    _detect_entrypoints(ws_path, recon)
    _classify_complexity(recon, declared_type, description)
    _write_recon_files(ws_path, recon)
    return recon.to_dict()


def _read_package_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace")[:200_000])
    except Exception:
        return None


def _detect_commands(ws_path: Path, recon: ProjectRecon, package_data: dict[str, Any] | None) -> None:
    if package_data:
        scripts = package_data.get("scripts") or {}
        if "dev" in scripts:
            recon.commands["dev"] = "npm run dev"
        if "build" in scripts:
            recon.commands["build"] = "npm run build"
        if "test" in scripts:
            recon.commands["test"] = "npm test"
        if "lint" in scripts:
            recon.commands["lint"] = "npm run lint"

    if (ws_path / "pom.xml").exists():
        recon.commands.setdefault("test", "mvn test")
        recon.commands.setdefault("build", "mvn package")
    if (ws_path / "requirements.txt").exists() or (ws_path / "pyproject.toml").exists():
        recon.commands.setdefault("test", "pytest")
    if (ws_path / "go.mod").exists():
        recon.commands.setdefault("test", "go test ./...")
        recon.commands.setdefault("build", "go build ./...")


def _detect_stack_and_kind(
    ws_path: Path,
    recon: ProjectRecon,
    package_data: dict[str, Any] | None,
    declared_type: str,
    description: str,
) -> None:
    declared = (declared_type or "").strip().lower()
    text = f"{declared} {description}".lower()
    deps: dict[str, Any] = {}
    if package_data:
        deps.update(package_data.get("dependencies") or {})
        deps.update(package_data.get("devDependencies") or {})

    def has_dep(name: str) -> bool:
        return name in deps

    has_next = has_dep("next") or (ws_path / "next.config.js").exists() or (ws_path / "next.config.ts").exists()
    has_react = has_dep("react")
    has_vue = has_dep("vue")

    if has_next or "next.js" in text or "nextjs" in text:
        _add_stack(recon, "Next.js")
    if has_react or "react" in text:
        _add_stack(recon, "React")
    if has_vue or "vue" in text:
        _add_stack(recon, "Vue")
    if "typescript" in text or "ts" in declared or any(p.endswith((".ts", ".tsx")) for p in recon.entrypoints):
        _add_stack(recon, "TypeScript")

    frontend_requested = declared in FRONTEND_DECLARED or any(word in text for word in FRONTEND_KEYWORDS)
    backend_requested = declared in BACKEND_DECLARED or any(word in text for word in BACKEND_KEYWORDS)
    script_requested = declared in SCRIPT_DECLARED or any(word in text for word in SCRIPT_KEYWORDS)

    if has_next or has_react or has_vue or frontend_requested:
        recon.project_kind = "frontend"
        recon.should_generate_prototype = True
        return

    if has_dep("express") or has_dep("@nestjs/core"):
        _add_stack(recon, "Node API")
        recon.project_kind = "backend"
    if (ws_path / "pom.xml").exists():
        _add_stack(recon, "Java/Spring")
        recon.project_kind = "backend"
    if (ws_path / "requirements.txt").exists() or (ws_path / "pyproject.toml").exists():
        _add_stack(recon, "Python")
        if recon.project_kind == "unknown":
            recon.project_kind = "script" if script_requested or recon.source_file_count <= 5 else "backend"
    if (ws_path / "go.mod").exists():
        _add_stack(recon, "Go")
        recon.project_kind = "backend"

    if any(part in recon.top_level_dirs for part in ("frontend", "app", "web")) and any(
        part in recon.top_level_dirs for part in ("backend", "server", "api")
    ):
        recon.project_kind = "fullstack"
        recon.should_generate_prototype = True
        return

    if recon.project_kind == "unknown":
        if backend_requested:
            recon.project_kind = "backend"
        elif script_requested:
            recon.project_kind = "script"
        elif recon.source_file_count <= 3 and recon.total_file_count <= 8:
            recon.project_kind = "script"
        else:
            recon.project_kind = "backend"


def _add_stack(recon: ProjectRecon, name: str) -> None:
    if name not in recon.likely_stack:
        recon.likely_stack.append(name)


def _detect_entrypoints(ws_path: Path, recon: ProjectRecon) -> None:
    workspace_index = load_workspace_index(ws_path)
    indexed_paths = [str(item.get("path")) for item in workspace_index.get("files") or [] if item.get("path")]
    indexed_set = set(indexed_paths)
    candidates = [
        "app/page.tsx", "pages/index.tsx", "src/App.tsx",
        "src/main.py", "main.py", "app.py", "index.py",
        "src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx",
        "server.js", "src/server.ts", "cmd/main.go",
        "main.go", "src/main/java/Main.java", "script.sh", "script.ps1",
    ]
    for candidate in candidates:
        if candidate in indexed_set or (ws_path / candidate).exists():
            recon.entrypoints.append(candidate)
    if not recon.entrypoints:
        for rel in indexed_paths:
            if Path(rel).suffix.lower() in SOURCE_SUFFIXES:
                recon.entrypoints.append(rel)
                if len(recon.entrypoints) >= 5:
                    break


def _classify_complexity(recon: ProjectRecon, declared_type: str, description: str) -> None:
    text = f"{declared_type} {description}".lower()
    multi_page_frontend = recon.project_kind == "frontend" and sum(1 for word in ("首页", "产品介绍", "关于我们", "联系我们", "页面") if word in text) >= 2

    if recon.project_kind == "script" and recon.source_file_count <= 3 and recon.total_file_count <= 8:
        recon.complexity = "S0"
        recon.recommended_flow = "light_script"
    elif recon.project_kind in {"script", "backend"} and recon.total_file_count <= 25:
        recon.complexity = "S1"
        recon.recommended_flow = "light_tool"
    elif recon.project_kind in {"frontend", "backend", "fullstack"} and recon.total_file_count <= 160:
        recon.complexity = "S2" if multi_page_frontend or recon.project_kind == "frontend" else "S1"
        recon.recommended_flow = "standard"
    else:
        recon.complexity = "S3"
        recon.recommended_flow = "full_software_team"

    if any(word in text for word in RISK_KEYWORDS) and recon.complexity in {"S0", "S1"}:
        recon.complexity = "S2"
        recon.recommended_flow = "standard"

    if not recon.commands:
        recon.risk_flags.append("no_known_build_or_test_command")
    if "README.md" not in recon.manifests and "readme.md" not in recon.manifests:
        recon.risk_flags.append("missing_readme")

    if recon.recommended_flow == "light_script":
        recon.plan_guidance = [
            "采用轻量 Agentic Loop，直接交付可运行入口，不要只写契约文档。",
            "入口文件按语言选择：Python main.py、Node index.js、Shell script.sh、PowerShell script.ps1、Go main.go、Java Main.java。",
            "完成前运行最小可用验证，并写明使用方式。",
        ]
    elif recon.recommended_flow == "light_tool":
        recon.plan_guidance = [
            "保持改动聚焦，优先实现入口、配置、错误处理和验证命令。",
            "计划只作为提示，不应阻塞 Agent 继续修改和验证。",
        ]
    elif recon.recommended_flow == "full_software_team":
        recon.plan_guidance = [
            "先生成必要 PRD、架构、API/DB/UI 规格，再由 Agentic Loop 分批实现。",
            "阶段审查和 CI 作为 guardrail，不作为固定主流程。",
        ]
    else:
        recon.plan_guidance = [
            "根据用户目标和项目地图决定读取、修改和验证顺序。",
            "前端/官网/多页面需求应创建真实页面入口并提供预览验证。",
            "验证失败时继续分析、修改、重跑，不因单轮失败直接结束。",
        ]


def _write_recon_files(ws_path: Path, recon: ProjectRecon) -> None:
    autocode = ws_path / ".autocode"
    autocode.mkdir(parents=True, exist_ok=True)
    data = recon.to_dict()
    (autocode / "PROJECT_PROFILE.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    (autocode / "PROJECT_PROFILE.md").write_text(_render_profile_markdown(data), encoding="utf-8")
    (autocode / "PROJECT_MAP.md").write_text(_render_project_map(data), encoding="utf-8")
    (autocode / "COMMANDS.md").write_text(_render_commands(data), encoding="utf-8")
    (autocode / "RISK_REPORT.md").write_text(_render_risks(data), encoding="utf-8")
    _write_work_files(autocode, data)


def _write_work_files(autocode: Path, data: dict[str, Any]) -> None:
    flow = str(data.get("recommended_flow") or "")
    common = {
        "PRD.md": _render_prd(data),
        "ARCHITECTURE.md": _render_light_architecture(data) if flow in {"light_script", "light_tool"} else _render_architecture(data),
        "API_SPEC.md": _render_api_spec(data),
        "DB_SCHEMA.md": _render_db_schema(data),
        "UI_SPEC.md": _render_ui_spec(data, bool(data.get("should_generate_prototype"))),
        "ROLE_OWNERSHIP.md": _render_role_ownership(data),
        "CI_REPORT.md": "# CI 报告\n\n- 状态：尚未运行\n",
        "PIPELINE.md": _render_pipeline(data),
        "REVIEW.md": "# 代码审查\n\n- 状态：尚未审查\n",
    }
    keep = set(common.keys())
    if flow in {"light_script", "light_tool"}:
        keep = {"PRD.md", "ARCHITECTURE.md", "ROLE_OWNERSHIP.md", "CI_REPORT.md", "PIPELINE.md", "REVIEW.md"}

    for name, content in common.items():
        if name not in keep:
            continue
        path = autocode / name
        if not path.exists() or path.read_text(encoding="utf-8", errors="replace").strip() == "":
            path.write_text(content, encoding="utf-8")


def _render_profile_markdown(data: dict[str, Any]) -> str:
    return f"""# 项目画像

## 摘要

- 项目类型：{data.get('project_kind')}
- 复杂度：{data.get('complexity')}
- 推荐流程：{data.get('recommended_flow')}
- 是否生成原型：{data.get('should_generate_prototype')}
- 源码文件数：{data.get('source_file_count')}
- 文件总数：{data.get('total_file_count')}

## 技术栈

{_md_list(data.get('likely_stack') or ['未知'])}

## 入口文件

{_md_list(data.get('entrypoints') or ['未检测到'])}

## 规划建议

{_md_list(data.get('plan_guidance') or [])}
"""


def _render_project_map(data: dict[str, Any]) -> str:
    return f"""# 项目地图

## 顶层目录

{_md_list(data.get('top_level_dirs') or ['无'])}

## 清单文件

{_md_list(data.get('manifests') or ['无'])}

## 入口文件

{_md_list(data.get('entrypoints') or ['未检测到'])}
"""


def _render_commands(data: dict[str, Any]) -> str:
    commands = data.get("commands") or {}
    body = "\n".join(f"- {name}: `{cmd}`" for name, cmd in commands.items()) if commands else "- 未检测到已知命令。Agent 运行命令前应先检查项目清单文件。"
    return f"# 命令\n\n{body}\n"


def _render_pipeline(data: dict[str, Any]) -> str:
    commands = data.get("commands") or {}
    install = "npm install" if "package.json" in (data.get("manifests") or []) else "不需要"
    test = commands.get("test") or "手动冒烟测试"
    build = commands.get("build") or "未检测到"
    lint = commands.get("lint") or "未检测到"
    preview = "静态预览或 dev server" if data.get("should_generate_prototype") else "不需要"
    return f"""# 流水线

## 阶段

1. 安装：`{install}`
2. 代码检查：`{lint}`
3. 测试：`{test}`
4. 构建：`{build}`
5. 预览：`{preview}`

## 门禁

- 验证/说明类任务允许无源码变更通过，不应因“没有文件变更”失败。
- 写入后必须运行可用验证；验证失败时应继续修复并重跑。
- 阶段计划只作为 guardrail，Agentic Loop 才是主执行路径。
"""


def _render_role_ownership(data: dict[str, Any]) -> str:
    return f"""# Agent 角色文件所有权

## 项目上下文

- 项目类型：{data.get('project_kind') or 'unknown'}
- 流程：{data.get('recommended_flow') or 'unknown'}
- 复杂度：{data.get('complexity') or 'S1'}

## 执行规则

- Agent 修改前应基于工作区索引精准定位文件。
- 跨边界改动需要在 REVIEW.md 说明原因。
- 验证失败要继续修复，不要直接宣布失败。

```ownership
product: .autocode/PRD.md, .autocode/UI_SPEC.md, .autocode/PLAN.md
architect: .autocode/ARCHITECTURE.md, .autocode/API_SPEC.md, .autocode/DB_SCHEMA.md, .autocode/PROJECT_MAP.md, .autocode/ROLE_OWNERSHIP.md
ui: .autocode/UI_SPEC.md, .autocode/prototype/, .autocode/prototypes/, public/, assets/, styles/, *.css, *.scss
frontend: app/, pages/, src/, components/, styles/, public/, package.json, vite.config.*, next.config.*, tailwind.config.*, *.css, *.scss, *.tsx, *.jsx, *.vue
backend: api/, server/, backend/, src/main/, migrations/, schema/, pom.xml, build.gradle, README.md, SCRIPT_CONTRACT.md, *.sql, *.java, *.kt, *.go, *.py, *.md
tester: tests/, __tests__/, test/, spec/, playwright.config.*, pytest.ini, *.test.*, *.spec.*
devops: Dockerfile, docker-compose*, .github/, .gitlab-ci*, deploy/, nginx*, .env.example, start.sh, package.json
```
"""


def _render_risks(data: dict[str, Any]) -> str:
    risks = _translate_risks(data.get("risk_flags") or [])
    return f"# 风险报告\n\n{_md_list(risks or ['未检测到明显风险'])}\n"


def _render_prd(data: dict[str, Any]) -> str:
    return f"""# PRD

## 目标

实现前先理解用户目标，并在 Agentic Loop 中根据证据决定读取、修改、验证顺序。

## 范围

- 项目类型：{data.get('project_kind')}
- 复杂度：{data.get('complexity')}
- 流程：{data.get('recommended_flow')}

## 验收标准

- [ ] 已实现用户请求的可见行为。
- [ ] 已保持现有项目约定。
- [ ] 验证命令通过，或记录了无法验证的具体原因。
"""


def _render_architecture(data: dict[str, Any]) -> str:
    return f"""# 架构

## 检测到的技术栈

{_md_list(data.get('likely_stack') or ['未知'])}

## 入口文件

{_md_list(data.get('entrypoints') or ['未检测到'])}

## 边界

- 优先沿用现有结构和命令。
- 只读取和修改与需求相关的文件。
- 计划、审查、CI 是护栏，不是固定主流程。
"""


def _render_light_architecture(data: dict[str, Any]) -> str:
    return f"""# 轻量架构

项目侦察将该任务识别为 `{data.get('complexity')}` / `{data.get('recommended_flow')}`。

## 契约

- 输入：
- 处理：
- 输出：
- 错误：
- 配置：
- 使用方式：

## 入口文件

{_md_list(data.get('entrypoints') or ['未检测到'])}
"""


def _render_api_spec(data: dict[str, Any]) -> str:
    return f"# API 规格\n\n项目类型：{data.get('project_kind')}\n\n如本任务涉及 API，Agent 应在实现前补充请求、响应、错误码和鉴权约定。\n"


def _render_db_schema(data: dict[str, Any]) -> str:
    return f"# 数据库结构\n\n项目类型：{data.get('project_kind')}\n\n如本任务涉及数据持久化，Agent 应补充表结构、索引、迁移和回滚说明。\n"


def _render_ui_spec(data: dict[str, Any], prototype_required: bool) -> str:
    if not prototype_required:
        return "# UI 规格\n\n当前任务未识别为 UI 主导项目。\n"
    return f"""# UI 规格

## 检测结果

- 项目类型：{data.get('project_kind')}
- 推荐流程：{data.get('recommended_flow')}

## 要求

- 前端项目应优先交付可预览页面，而不是只产出文档。
- 多页面官网应包含清晰导航、页面路由和移动端适配。
"""


def _md_list(items: list[Any]) -> str:
    values = [str(item) for item in items if str(item).strip()]
    return "\n".join(f"- {item}" for item in values) if values else "- 无"


def _translate_risks(risks: list[str]) -> list[str]:
    mapping = {
        "workspace_not_found": "工作区不存在",
        "no_known_build_or_test_command": "未检测到已知构建或测试命令",
        "missing_readme": "缺少 README 文档",
    }
    return [mapping.get(str(item), str(item)) for item in risks]
