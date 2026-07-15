# 追加模型列表和 SPEC 端点到 api/tasks.py
append_text = r'''
# ── GET /api/models — 获取可用模型列表 ────────────────────
@router.get("/models")
async def list_models(capability: str = "tool"):
    """
    返回具备指定能力的模型列表（供前端创建任务时选择）

    - capability='tool' → 支持 function calling 的模型
    """
    from services.channel_service import fetch_all_channels, fetch_models_with_capability

    channels = fetch_all_channels()
    models = fetch_models_with_capability(capability)

    result = []
    for mi in models:
        # 找对应的渠道信息
        ch_info = None
        for ch in channels:
            if not ch.models:
                continue
            if mi.model_id in ch.models or mi.name in ch.models:
                ch_info = ch
                break

        result.append({
            "model_id": mi.model_id,
            "name": mi.name or mi.model_id,
            "provider": mi.provider or (ch_info.provider if ch_info else "unknown"),
            "capabilities": mi.capabilities,
            "input_price": mi.input_price,
            "output_price": mi.output_price,
            "context_length": mi.context_length,
            "code_quality": mi.code_quality,
        })

    return {"models": result}


# ── GET /api/tasks/{task_id}/spec — 获取开发规范 ──────────
@router.get("/{task_id}/spec")
async def get_task_spec(task_id: str):
    """返回任务的开发规范（SPEC.md 内容）"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")

    from core.config import get_settings
    settings = get_settings()
    ws_id = _tasks[task_id].get("workspace_id", "")
    spec_path = settings.workspace_base_dir / ws_id / ".autocode" / "SPEC.md"

    if not spec_path.exists():
        return {"spec": None, "exists": False}

    return {"spec": spec_path.read_text(encoding="utf-8"), "exists": True}


# ── PUT /api/tasks/{task_id}/spec — 更新开发规范 ──────────
class SpecUpdateRequest(BaseModel):
    spec: str = Field(..., description="新的 SPEC.md 内容")

@router.put("/{task_id}/spec")
async def update_task_spec(task_id: str, payload: SpecUpdateRequest):
    """更新任务的开发规范（写入 SPEC.md）"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")

    from core.config import get_settings
    settings = get_settings()
    ws_id = _tasks[task_id].get("workspace_id", "")
    spec_path = settings.workspace_base_dir / ws_id / ".autocode" / "SPEC.md"
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(payload.spec, encoding="utf-8")

    # 同步更新内存中的 spec 字段
    _tasks[task_id]["spec"] = payload.spec
    try:
        await asyncio.to_thread(save_task, dict(_tasks[task_id]))
    except Exception:
        pass

    return {"ok": True, "spec": payload.spec}
'''

with open("c:/Users/Administrator/WorkBuddy/20260417103053/agent-platform/backend/api/tasks.py", "a", encoding="utf-8") as f:
    f.write(append_text)

print("OK: endpoints appended")
