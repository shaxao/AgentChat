# -*- coding: utf-8 -*-
"""
原型生成器 — 根据自然语言描述生成交互式 HTML/CSS/JS 原型

核心能力：
- 接收自然语言 UI 描述，生成完整、自包含的 HTML 页面
- 支持迭代修改（传入 current_html + modification_request）
- 使用 LLM 生成高质量、响应式、可直接预览的代码
- 生成结果写入 workspace/.autocode/prototype/index.html
"""
import json
import os
import re
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional

from loguru import logger

from core.llm_client import LLMClient, ToolDefinition, create_client_from_channel
from services.channel_service import select_best_tool_model


PROTOTYPE_LIBRARY_DIR = ".autocode/prototypes"
PROTOTYPE_MANIFEST = "manifest.json"


def _utc_now() -> str:
    return datetime.utcnow().isoformat()


def _prototype_library_path(workspace_path: Path) -> Path:
    return workspace_path / PROTOTYPE_LIBRARY_DIR


def _prototype_manifest_path(workspace_path: Path) -> Path:
    return _prototype_library_path(workspace_path) / PROTOTYPE_MANIFEST


def _safe_prototype_id(prototype_id: Optional[str] = None) -> str:
    value = (prototype_id or "").strip()
    if value and re.match(r"^[A-Za-z0-9_.-]+$", value):
        return value
    return f"proto-{uuid.uuid4().hex[:12]}"


def _read_prototype_manifest(workspace_path: Path) -> dict:
    manifest_path = _prototype_manifest_path(workspace_path)
    if not manifest_path.exists():
        return {"version": 1, "items": []}
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"version": 1, "items": []}
        items = data.get("items")
        if not isinstance(items, list):
            data["items"] = []
        data.setdefault("version", 1)
        return data
    except Exception as exc:
        logger.warning(f"[PrototypeLibrary] Failed to read manifest: {exc}")
        return {"version": 1, "items": []}


def _write_prototype_manifest(workspace_path: Path, manifest: dict) -> None:
    prototype_dir = _prototype_library_path(workspace_path)
    prototype_dir.mkdir(parents=True, exist_ok=True)
    _prototype_manifest_path(workspace_path).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _relative_workspace_path(workspace_path: Path, file_path: Path) -> str:
    try:
        return file_path.relative_to(workspace_path).as_posix()
    except ValueError:
        return file_path.as_posix()


def _preview_url(workspace_path: Path, file_path: Path) -> str:
    workspace_id = workspace_path.name
    rel_path = _relative_workspace_path(workspace_path, file_path)
    return f"/workspaces/{workspace_id}/preview/{rel_path}"


def save_prototype_record(
    workspace_path: Path,
    prototype_result: dict,
    prototype_id: Optional[str] = None,
    source: str = "manual",
    kind: Optional[str] = None,
) -> dict:
    """Save a prototype into the workspace prototype library."""
    prototype_dir = _prototype_library_path(workspace_path)
    prototype_dir.mkdir(parents=True, exist_ok=True)

    pid = _safe_prototype_id(prototype_id)
    inferred_kind = kind or ("html" if prototype_result.get("html") is not None else "excalidraw")
    now = _utc_now()

    if inferred_kind == "html":
        file_path = prototype_dir / f"{pid}.html"
        file_path.write_text(prototype_result.get("html", ""), encoding="utf-8")
    else:
        file_path = prototype_dir / f"{pid}.excalidraw.json"
        excalidraw_data = prototype_result.get("excalidraw") or prototype_result
        file_path.write_text(
            json.dumps(excalidraw_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        inferred_kind = "excalidraw"

    manifest = _read_prototype_manifest(workspace_path)
    items = manifest.setdefault("items", [])
    existing = next((item for item in items if item.get("id") == pid), None)

    record = {
        "id": pid,
        "title": prototype_result.get("title") or ("UI Prototype" if inferred_kind == "html" else "UI Wireframe"),
        "description": prototype_result.get("description") or "",
        "kind": inferred_kind,
        "source": source,
        "file": _relative_workspace_path(workspace_path, file_path),
        "preview_url": _preview_url(workspace_path, file_path) if inferred_kind == "html" else "",
        "features": prototype_result.get("features") or [],
        "tech_notes": prototype_result.get("tech_notes") or "",
        "created_at": existing.get("created_at") if existing else now,
        "updated_at": now,
    }

    if existing:
        existing.update(record)
    else:
        items.insert(0, record)

    _write_prototype_manifest(workspace_path, manifest)
    logger.info(f"[PrototypeLibrary] Saved {inferred_kind} prototype {pid}: {file_path}")
    return record


def list_prototype_records(workspace_path: Path) -> list[dict]:
    """List workspace prototype records, including a best-effort legacy import."""
    manifest = _read_prototype_manifest(workspace_path)
    items = manifest.setdefault("items", [])
    active_id = manifest.get("active_id") or ""

    changed = False
    legacy_html = workspace_path / ".autocode" / "prototype" / "index.html"
    if legacy_html.exists() and not any(item.get("file") == ".autocode/prototype/index.html" for item in items):
        mtime = datetime.fromtimestamp(legacy_html.stat().st_mtime).isoformat()
        items.append({
            "id": "legacy-html",
            "title": "UI Prototype",
            "description": "Legacy HTML prototype",
            "kind": "html",
            "source": "legacy",
            "file": ".autocode/prototype/index.html",
            "preview_url": _preview_url(workspace_path, legacy_html),
            "features": [],
            "tech_notes": "",
            "created_at": mtime,
            "updated_at": mtime,
        })
        changed = True

    legacy_wireframe = workspace_path / ".autocode" / "prototype" / "wireframe.excalidraw.json"
    if legacy_wireframe.exists() and not any(item.get("file") == ".autocode/prototype/wireframe.excalidraw.json" for item in items):
        mtime = datetime.fromtimestamp(legacy_wireframe.stat().st_mtime).isoformat()
        items.append({
            "id": "legacy-wireframe",
            "title": "UI Wireframe",
            "description": "Legacy Excalidraw wireframe",
            "kind": "excalidraw",
            "source": "legacy",
            "file": ".autocode/prototype/wireframe.excalidraw.json",
            "preview_url": "",
            "features": [],
            "tech_notes": "",
            "created_at": mtime,
            "updated_at": mtime,
        })
        changed = True

    if changed:
        _write_prototype_manifest(workspace_path, manifest)

    for item in items:
        item["active"] = bool(active_id and item.get("id") == active_id)

    return sorted(items, key=lambda item: item.get("updated_at") or "", reverse=True)


def load_prototype_record(workspace_path: Path, prototype_id: str) -> Optional[dict]:
    """Load a prototype record and its content."""
    record = next((item for item in list_prototype_records(workspace_path) if item.get("id") == prototype_id), None)
    if not record:
        return None

    file_path = workspace_path / record.get("file", "")
    if not file_path.exists():
        return None

    result = dict(record)
    if record.get("kind") == "html":
        html = file_path.read_text(encoding="utf-8")
        result["html"] = html
        result["html_preview"] = html[:2000]
        result["preview_url"] = record.get("preview_url") or _preview_url(workspace_path, file_path)
    else:
        result["excalidraw"] = json.loads(file_path.read_text(encoding="utf-8"))
    return result


def set_active_prototype_record(workspace_path: Path, prototype_id: str) -> Optional[dict]:
    """Mark one saved prototype as the design reference for later Agent work."""
    manifest = _read_prototype_manifest(workspace_path)
    items = manifest.setdefault("items", [])
    if not any(item.get("id") == prototype_id for item in items):
        return None
    manifest["active_id"] = prototype_id
    manifest["active_updated_at"] = _utc_now()
    _write_prototype_manifest(workspace_path, manifest)
    return load_prototype_record(workspace_path, prototype_id)


PROTOTYPE_SYSTEM_PROMPT = """你是一个专业的 UI/UX 设计师和前端开发专家。

你的任务是：根据用户的 UI 需求描述，生成一个**完整的、独立的、可直接在浏览器中打开的 HTML 文件**。

## 核心要求

1. **自包含**：所有 CSS 和 JS 必须内联在 HTML 文件中（不能引用外部文件）
2. **美观现代**：使用现代化的设计风格，良好的视觉层次，合适的配色方案
3. **响应式**：适配桌面端和移动端（使用 CSS media queries 或 flexbox/grid）
4. **可交互**：包含适当的交互效果（hover、click、过渡动画等）
5. **无需构建**：不需要 npm/webpack/vite，纯 HTML 即可运行
6. **完整页面**：包含完整的 HTML 结构（DOCTYPE、head、body）

## 设计指南

### 颜色
- 使用柔和的现代配色（避免过于刺眼的纯色）
- 主色调建议使用蓝/紫/绿色系
- 暗色模式可选但非必需

### 字体
- 使用系统字体栈：`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- 或使用 Google Fonts CDN（CDN 引用允许）

### 图标
- 优先使用 emoji 或 CSS 绘制简单图标
- 如需引入 CDN，可使用 Lucide Icons CDN 或 Font Awesome CDN

### 布局
- 最大宽度建议 1200px，居中显示
- 使用 CSS Grid 或 Flexbox
- 适当的间距（padding/margin）

### 交互
- 按钮/链接 hover 效果
- 表单输入 focus 效果
- 平滑过渡动画（transition）
- 卡片/面板的适当阴影

## 输出格式

**必须**返回以下 JSON 格式：

```json
{
  "title": "页面标题（用于 <title> 标签）",
  "description": "对这个原型的功能简述",
  "html": "完整的 HTML 代码（包含 <!DOCTYPE html> 到 </html>）",
  "features": ["特性1", "特性2", "特性3"],
  "tech_notes": "使用的技术说明（如：纯CSS实现响应式布局、使用了CSS Grid等）"
}
```

## 代码质量要求

- HTML 代码必须完整有效，能直接在浏览器打开
- CSS 不要省略（不要写 "... 其他样式"）
- 所有交互功能必须完整实现，不能写 "TODO" 或 "此处省略"
- JavaScript 必须完整实现所有交互逻辑
- 代码要整洁、缩进正确

## 特别注意

- **不要**使用任何需要构建工具的前端框架（React/Vue/Angular）
- **不要**引用本地文件（如 ./style.css）
- **可以**使用 CDN 引用的第三方库（如 Chart.js、Alpine.js）
- 返回的 JSON 中，html 字段必须包含完整的 HTML 源码
- 所有字符串都要正确转义 JSON 特殊字符"""


EXCALIDRAW_SYSTEM_PROMPT = """你是一个专业的 UI/UX 设计师，擅长用 Excalidraw 格式绘制线框图和 UI 设计稿。

你的任务是：根据用户的 UI 需求描述，生成一个**完整的 Excalidraw JSON 格式的线框图**。

## Excalidraw JSON 结构

返回的 JSON 必须符合 Excalidraw v2 格式：

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "MuhugoAI AutoCode",
  "elements": [
    {
      "id": "唯一ID（使用 UUID 或递增数字）",
      "type": "rectangle | text | arrow | ellipse | line | diamond",
      "x": 数字（X坐标）,
      "y": 数字（Y坐标）,
      "width": 数字（宽度）,
      "height": 数字（高度）,
      "angle": 0,
      "fillStyle": "solid",
      "strokeColor": "#1e293b",
      "backgroundColor": "#ffffff",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 0,
      "groupIds": [],
      "roundness": null,
      "boundElements": [],
      "link": null,
      "locked": false,
      "text": "文本内容（仅 text 类型需要）",
      "fontSize": 14,
      "fontFamily": "Calcut"
    }
  ],
  "appState": {
    "gridSize": null,
    "viewBackgroundColor": "#f8fafc",
    "zenModeEnabled": false,
    "theme": "light"
  }
}
```

## 组件类型映射

- **页面容器**：rectangle, fillStyle=solid, backgroundColor=#f1f5f9, strokeColor=#94a3b8
- **按钮**：rectangle, width=100-120, height=36-40, backgroundColor=#3b82f6, strokeColor=#2563eb
- **输入框**：rectangle, backgroundColor=#ffffff, strokeColor=#cbd5e1, strokeWidth=1
- **文本标签**：text, fontSize=14-16
- **标题**：text, fontSize=20-24, fontWeight="bold"
- **图片占位**：rectangle, backgroundColor=#e2e8f0, strokeColor=#cbd5e1, strokeStyle=dashed
- **箭头连接**：arrow, strokeColor=#64748b
- **卡片/面板**：rectangle, backgroundColor=#ffffff, strokeColor=#e2e8f0, strokeWidth=1

## 设计原则

1. **线框图风格**：保持简洁，使用灰色系为主色调
2. **清晰的层次**：标题、导航、内容区域分明
3. **合理的间距**：元素之间保持 16-24px 的间距
4. **移动端适配**：画布宽度建议 375px（移动端）或 1440px（桌面端）
5. **组件标注**：在组件旁边用小号文字标注组件名称

## 常用组件示例坐标（基于 1440px 宽度画布）

### 顶部导航栏
- y: 0, height: 60, backgroundColor=#ffffff, strokeColor=#e2e8f0

### 侧边栏
- x: 0, width: 240, height: 全屏, backgroundColor=#f8fafc, strokeColor=#e2e8f0

### 主内容区
- x: 240, width: 1200, padding: 24px

### 卡片网格
- 卡片 width: 360, height: 280, gap: 24

### 底部 Tab Bar（移动端）
- y: 底部, height: 64, backgroundColor=#ffffff, strokeColor=#e2e8f0

## 输出格式

**必须**返回以下 JSON 格式：

```json
{
  "title": "页面标题",
  "description": "对这个原型的功能简述",
  "excalidraw": {
    "type": "excalidraw",
    "version": 2,
    "source": "MuhugoAI AutoCode",
    "elements": [...],
    "appState": {...}
  },
  "features": ["特性1", "特性2", "特性3"]
}
```

## 注意事项

- elements 数组中每个元素必须有唯一的 id
- 坐标从 0 开始，支持负数
- 所有数字类型不要加引号
- text 类型元素不需要 width/height，让 Excalidraw 自动计算
- 可以使用 arrow 元素连接相关组件表示页面跳转"""


PROTOTYPE_REFINE_PROMPT = """你是一个专业的 UI/UX 设计师。用户有一个现有的 HTML 原型，需要根据新的需求进行修改。

## 修改要求

请阅读当前的 HTML 代码，然后根据用户的修改需求进行精确修改。

## 输出格式

返回以下 JSON：

```json
{
  "title": "修改后的页面标题",
  "description": "修改说明",
  "html": "完整的修改后 HTML 代码",
  "changes": ["变更1", "变更2"],
  "tech_notes": "技术说明"
}
```

## 规则

- 保持现有代码中不需要修改的部分不变
- 只修改用户要求的部分
- 确保修改后代码仍然完整可用
- 不要引入新的框架或构建工具依赖"""


async def generate_prototype_excalidraw(
    description: str,
    plan_context: Optional[dict] = None,
    llm_client: Optional[LLMClient] = None,
    channel_config: Optional[dict] = None,
) -> dict:
    """
    根据自然语言描述生成 Excalidraw JSON 格式的 UI 线框图原型。

    Args:
        description: 用户对 UI 的描述
        plan_context: 计划上下文（包含 subtasks 等信息）
        llm_client: 可选的已有 LLM 客户端
        channel_config: 渠道配置

    Returns:
        {
            "title": str,
            "description": str,
            "excalidraw": {
                "type": "excalidraw",
                "version": 2,
                "elements": [...],
                "appState": {...}
            },
            "features": list[str],
        }
    """
    if llm_client is None:
        if channel_config is None:
            result = select_best_tool_model()
            if result:
                channel, model_name = result
                channel_config = {
                    "api_key": channel.api_key,
                    "base_url": channel.base_url,
                    "provider": channel.provider,
                    "model": model_name,
                }
            else:
                env_model = os.getenv("AUTOCODE_MODEL", "").strip()
                env_api_key = os.getenv("AUTOCODE_API_KEY", "").strip()
                env_base_url = os.getenv("AUTOCODE_BASE_URL", "").strip()
                env_provider = os.getenv("AUTOCODE_PROVIDER", "openai").strip()

                if env_model and env_api_key:
                    channel_config = {
                        "api_key": env_api_key,
                        "base_url": env_base_url or None,
                        "provider": env_provider,
                        "model": env_model,
                    }
                else:
                    raise RuntimeError("未找到可用的 LLM 配置")

        from core.agent_orchestrator import agent_orchestrator
        llm_client = await agent_orchestrator._ensure_client()

    system_prompt = EXCALIDRAW_SYSTEM_PROMPT.strip()

    # 构建上下文信息
    context_parts = [f"## UI 需求描述\n{description}"]

    if plan_context:
        # 添加计划子任务信息
        subtasks = plan_context.get("subtasks", [])
        if subtasks:
            subtask_list = "\n".join([f"- {s.get('title', s.get('id', 'unknown'))}: {s.get('description', '')}"
                                      for s in subtasks[:10]])
            context_parts.append(f"\n## 计划子任务（参考）\n{subtask_list}")

        # 添加技术栈信息
        tech_stack = plan_context.get("tech_stack", {})
        if tech_stack:
            tech_str = ", ".join([f"{k}: {v}" for k, v in tech_stack.items()])
            context_parts.append(f"\n## 技术栈\n{tech_str}")

    user_prompt = "\n\n".join(context_parts)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    logger.info(f"[PrototypeGen] 正在生成 Excalidraw 原型: {description[:80]}...")

    response = await llm_client.chat(messages=messages, temperature=0.7, max_tokens=32768)

    content = response.content if hasattr(response, 'content') else str(response)

    result = _parse_json_response(content)

    if not result or "excalidraw" not in result:
        logger.error(f"[PrototypeGen] LLM 返回格式异常（非 Excalidraw JSON）: {content[:300]}")
        raise ValueError("LLM 未返回有效的 Excalidraw JSON 格式")

    # 验证 excalidraw 结构
    excalidraw_data = result["excalidraw"]
    if not isinstance(excalidraw_data, dict) or "elements" not in excalidraw_data:
        logger.error(f"[PrototypeGen] Excalidraw 数据结构异常")
        raise ValueError("Excalidraw JSON 格式不正确，缺少 elements 字段")

    logger.info(f"[PrototypeGen] Excalidraw 原型生成成功: title={result.get('title', '')}, "
                f"elements={len(excalidraw_data.get('elements', []))}")

    return result


def save_prototype_excalidraw(workspace_path: Path, excalidraw_data: dict) -> Path:
    """
    将 Excalidraw JSON 保存到 workspace 中。

    Args:
        workspace_path: 工作空间根路径
        excalidraw_data: Excalidraw JSON 数据

    Returns:
        保存的文件路径
    """
    prototype_dir = workspace_path / ".autocode" / "prototype"
    prototype_dir.mkdir(parents=True, exist_ok=True)

    excalidraw_path = prototype_dir / "wireframe.excalidraw.json"
    excalidraw_path.write_text(json.dumps(excalidraw_data, ensure_ascii=False, indent=2), encoding="utf-8")

    logger.info(f"[PrototypeGen] Excalidraw 原型已保存到: {excalidraw_path}")

    return excalidraw_path


def load_prototype_excalidraw(workspace_path: Path) -> Optional[dict]:
    """
    加载工作空间中已有的 Excalidraw 原型。

    Returns:
        {"excalidraw": {...}, "title": str, "generated_at": str} 或 None
    """
    excalidraw_path = workspace_path / ".autocode" / "prototype" / "wireframe.excalidraw.json"

    if not excalidraw_path.exists():
        return None

    with open(excalidraw_path, "r", encoding="utf-8") as f:
        excalidraw_data = json.load(f)

    # 获取文件修改时间
    mtime = excalidraw_path.stat().st_mtime
    generated_at = datetime.fromtimestamp(mtime).isoformat()

    return {
        "excalidraw": excalidraw_data,
        "title": "UI 线框图",
        "generated_at": generated_at,
    }


async def refine_prototype_excalidraw(
    current_excalidraw: dict,
    modification_request: str,
    llm_client: Optional[LLMClient] = None,
) -> dict:
    """
    迭代修改已有的 Excalidraw 原型。

    Args:
        current_excalidraw: 当前的 Excalidraw JSON 数据
        modification_request: 修改需求描述
        llm_client: 可选的已有 LLM 客户端

    Returns:
        同 generate_prototype_excalidraw 的返回格式
    """
    if llm_client is None:
        from core.agent_orchestrator import agent_orchestrator
        llm_client = await agent_orchestrator._ensure_client()

    system_prompt = """你是一个专业的 UI/UX 设计师。用户有一个现有的 Excalidraw 线框图，需要根据新的需求进行修改。

## 修改规则

1. 仔细阅读当前的 Excalidraw JSON 结构和元素
2. 根据用户的修改需求，只修改需要变更的部分
3. 保持其他元素不变
4. 确保修改后的 JSON 格式正确

## 输出格式

返回以下 JSON：
```json
{
  "title": "修改后的页面标题",
  "description": "修改说明",
  "excalidraw": {...完整的 Excalidraw JSON...},
  "changes": ["变更1", "变更2"]
}
```"""

    user_prompt = f"""## 当前 Excalidraw JSON

```json
{json.dumps(current_excalidraw, ensure_ascii=False, indent=2)[:20000]}
```

## 修改需求

{modification_request}

请根据修改需求更新 Excalidraw JSON，返回完整的修改后数据。"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    logger.info(f"[PrototypeRefine] 正在修改 Excalidraw 原型: {modification_request[:80]}...")

    response = await llm_client.chat(messages=messages, temperature=0.5, max_tokens=32768)

    content = response.content if hasattr(response, 'content') else str(response)

    result = _parse_json_response(content)

    if not result or "excalidraw" not in result:
        logger.error(f"[PrototypeRefine] LLM 返回格式异常: {content[:300]}")
        raise ValueError("LLM 未返回有效的 Excalidraw 修改结果")

    logger.info(f"[PrototypeRefine] 修改成功: changes={result.get('changes', [])}")

    return result


async def generate_prototype(
    description: str,
    llm_client: Optional[LLMClient] = None,
    channel_config: Optional[dict] = None,
) -> dict:
    """
    根据自然语言描述生成 UI 原型。

    Args:
        description: 用户对 UI 的描述
        llm_client: 可选的已有 LLM 客户端
        channel_config: 渠道配置（如果需要创建新客户端）

    Returns:
        {
            "title": str,
            "description": str,
            "html": str,
            "features": list[str],
            "tech_notes": str,
        }
    """
    if llm_client is None:
        if channel_config is None:
            # 从数据库选择最佳模型
            result = select_best_tool_model()
            if result:
                channel, model_name = result
                channel_config = {
                    "api_key": channel.api_key,
                    "base_url": channel.base_url,
                    "provider": channel.provider,
                    "model": model_name,
                }
            else:
                # 尝试环境变量
                env_model = os.getenv("AUTOCODE_MODEL", "").strip()
                env_api_key = os.getenv("AUTOCODE_API_KEY", "").strip()
                env_base_url = os.getenv("AUTOCODE_BASE_URL", "").strip()
                env_provider = os.getenv("AUTOCODE_PROVIDER", "openai").strip()

                if env_model and env_api_key:
                    channel_config = {
                        "api_key": env_api_key,
                        "base_url": env_base_url or None,
                        "provider": env_provider,
                        "model": env_model,
                    }
                else:
                    raise RuntimeError("未找到可用的 LLM 配置")

        from core.agent_orchestrator import agent_orchestrator
        llm_client = await agent_orchestrator._ensure_client()

    system_prompt = PROTOTYPE_SYSTEM_PROMPT.strip()

    user_prompt = f"""请根据以下需求描述生成一个 UI 原型页面：

{description}

请返回完整的 HTML 代码，确保：
1. 所有 CSS/JS 内联
2. 可以直接在浏览器打开
3. 美观现代的设计
4. 完整的交互功能"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    logger.info(f"[PrototypeGen] 正在生成原型: {description[:80]}...")

    response = await llm_client.chat(messages=messages, temperature=0.7, max_tokens=32768)

    content = response.content if hasattr(response, 'content') else str(response)

    result = _parse_json_response(content)

    if not result or "html" not in result:
        logger.error(f"[PrototypeGen] LLM 返回格式异常: {content[:300]}")
        raise ValueError("LLM 未返回有效的 HTML 代码")

    logger.info(f"[PrototypeGen] 生成成功: title={result.get('title', '')}")

    return result


async def refine_prototype(
    current_html: str,
    modification_request: str,
    llm_client: Optional[LLMClient] = None,
) -> dict:
    """
    迭代修改已有的原型。

    Args:
        current_html: 当前的 HTML 代码
        modification_request: 修改需求描述
        llm_client: 可选的已有 LLM 客户端

    Returns:
        同 generate_prototype 的返回格式
    """
    if llm_client is None:
        from core.agent_orchestrator import agent_orchestrator
        llm_client = await agent_orchestrator._ensure_client()

    system_prompt = PROTOTYPE_REFINE_PROMPT.strip()

    # 如果 HTML 太长，截取关键部分发给 LLM
    if len(current_html) > 15000:
        current_html = current_html[:15000] + "\n... (HTML 过长，已截断)"

    user_prompt = f"""## 当前 HTML 代码

```html
{current_html}
```

## 修改需求

{modification_request}

请根据修改需求更新 HTML 代码，返回完整的修改后代码。"""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    logger.info(f"[PrototypeRefine] 正在修改原型: {modification_request[:80]}...")

    response = await llm_client.chat(messages=messages, temperature=0.5, max_tokens=32768)

    content = response.content if hasattr(response, 'content') else str(response)

    result = _parse_json_response(content)

    if not result or "html" not in result:
        logger.error(f"[PrototypeRefine] LLM 返回格式异常: {content[:300]}")
        raise ValueError("LLM 未返回有效的修改后 HTML 代码")

    logger.info(f"[PrototypeRefine] 修改成功: changes={result.get('changes', [])}")

    return result


def save_prototype(workspace_path: Path, html: str) -> Path:
    """
    将原型 HTML 保存到 workspace 中。

    Args:
        workspace_path: 工作空间根路径
        html: HTML 代码

    Returns:
        保存的文件路径
    """
    prototype_dir = workspace_path / ".autocode" / "prototype"
    prototype_dir.mkdir(parents=True, exist_ok=True)

    index_path = prototype_dir / "index.html"
    index_path.write_text(html, encoding="utf-8")

    logger.info(f"[PrototypeGen] 原型已保存到: {index_path}")

    return index_path


def load_prototype(workspace_path: Path) -> Optional[dict]:
    """
    加载工作空间中已有的原型。

    Returns:
        {"html": str, "title": str, "generated_at": str} 或 None
    """
    index_path = workspace_path / ".autocode" / "prototype" / "index.html"

    if not index_path.exists():
        return None

    html = index_path.read_text(encoding="utf-8")

    # 尝试从 HTML 的 <title> 标签提取标题
    title = "UI 原型"
    title_match = re.search(r"<title>([^<]*)</title>", html, re.IGNORECASE)
    if title_match:
        title = title_match.group(1).strip()

    # 获取文件修改时间
    mtime = index_path.stat().st_mtime
    generated_at = datetime.fromtimestamp(mtime).isoformat()

    return {
        "html": html,
        "title": title,
        "generated_at": generated_at,
    }


def _parse_json_response(content: str) -> Optional[dict]:
    """从 LLM 响应中解析 JSON，支持多种格式和截断恢复"""

    # 1. 直接 JSON 解析
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # 2. ```json ... ``` 代码块
    json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", content, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

    # 3. 字符串感知的花括号匹配
    brace_start = content.find("{")
    if brace_start < 0:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i in range(brace_start, len(content)):
        ch = content[i]

        if escape_next:
            escape_next = False
            continue

        if ch == "\\" and in_string:
            escape_next = True
            continue

        if ch == '"' and not escape_next:
            in_string = not in_string
            continue

        if in_string:
            continue  # 字符串内的 {} 不计数

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(content[brace_start:i + 1])
                except json.JSONDecodeError:
                    # JSON 有效花括号但内容解析失败（如未转义字符）
                    break

    # 4. 截断恢复：LLM 返回被 finish=length 截断时，尝试补全
    # 走到这里说明 depth > 0（花括号未闭合）
    if depth > 0:
        truncated = content[brace_start:]
        # 如果在字符串内被截断，先闭合字符串
        if in_string:
            truncated += '"'
        # 补全缺失的 }
        truncated += "}" * depth

        try:
            return json.loads(truncated)
        except json.JSONDecodeError:
            pass

        # 如果补全后仍有未转义字符问题，尝试提取 html 字段
        # 用正则提取 "html": 字段的值（到下一个顶层键或结尾）
        html_match = re.search(r'"html"\s*:\s*"', truncated)
        if html_match:
            # 找到 html 值起始位置
            html_val_start = html_match.end()
            # 从起始位置扫描，找未转义的双引号作为 html 值结束
            # 但要处理 JSON 字符串内的转义
            pos = html_val_start
            str_escape = False
            while pos < len(truncated) - 1:
                c = truncated[pos]
                if str_escape:
                    str_escape = False
                    pos += 1
                    continue
                if c == "\\":
                    str_escape = True
                    pos += 1
                    continue
                if c == '"':
                    # 可能是 html 字段结束，检查后面是否是 , 或 }
                    after = truncated[pos + 1:].lstrip()
                    if after and after[0] in (",", "}"):
                        html_end = pos
                        # 重建 JSON：html 之前的部分 + 截断的 html + 补全
                        before_html = truncated[:html_val_start]
                        html_content = truncated[html_val_start:html_end]
                        after_html = truncated[html_end:]
                        # 简单闭合
                        rebuilt = before_html + html_content + after_html
                        try:
                            return json.loads(rebuilt)
                        except json.JSONDecodeError:
                            break
                pos += 1

    return None
