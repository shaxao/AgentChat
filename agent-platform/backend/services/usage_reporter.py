# -*- coding: utf-8 -*-
"""Usage reporting bridge from AutoCode to the main MuhugoChat billing system."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
from typing import Optional

import httpx
from loguru import logger


MUHUGOCHAT_API_URL = os.getenv("MUHUGOCHAT_API_URL", "http://localhost:8080/api/admin").rstrip("/")
INTERNAL_API_KEY = os.getenv("MUHUGOCHAT_INTERNAL_API_KEY", "") or os.getenv("INTERNAL_API_KEY", "")


@dataclass(frozen=True)
class UsageContext:
    user_id: Optional[str] = None
    task_id: Optional[str] = None
    request_ip: Optional[str] = None
    scene_type: str = "autocode"
    agent_id: Optional[str] = None


_usage_context: ContextVar[UsageContext | None] = ContextVar("autocode_usage_context", default=None)


@contextmanager
def usage_context(
    *,
    user_id: Optional[str] = None,
    task_id: Optional[str] = None,
    request_ip: Optional[str] = None,
    scene_type: str = "autocode",
    agent_id: Optional[str] = None,
):
    previous = _usage_context.get()
    ctx = UsageContext(
        user_id=str(user_id) if user_id is not None and str(user_id).strip() else None,
        task_id=task_id or (previous.task_id if previous else None),
        scene_type=scene_type or (previous.scene_type if previous else "autocode"),
        agent_id=agent_id if agent_id is not None else (previous.agent_id if previous else None),
        request_ip=request_ip if request_ip is not None else (previous.request_ip if previous else None),
    )
    token = _usage_context.set(ctx)
    try:
        yield ctx
    finally:
        _usage_context.reset(token)


@contextmanager
def usage_agent(agent_id: Optional[str], scene_type: Optional[str] = None):
    previous = _usage_context.get()
    if previous is None:
        yield None
        return
    ctx = replace(
        previous,
        agent_id=agent_id if agent_id is not None else previous.agent_id,
        scene_type=scene_type or previous.scene_type,
        request_ip=previous.request_ip,
    )
    token = _usage_context.set(ctx)
    try:
        yield ctx
    finally:
        _usage_context.reset(token)


def current_usage_context() -> UsageContext | None:
    return _usage_context.get()


def _record_usage_report_failure(ctx: UsageContext | None, message: str) -> None:
    if ctx is None or not ctx.task_id:
        return
    try:
        from datetime import datetime
        from core.state import _tasks
        from services.task_repository import save_task

        task = _tasks.get(ctx.task_id)
        if not task:
            return
        task.setdefault("logs", []).append({
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "agent": "billing",
            "level": "warn",
            "message": "AutoCode usage report failed",
            "detail": message[:1000],
        })
        save_task(dict(task))
    except Exception:
        pass


def _record_usage_report_event(ctx: UsageContext | None, payload: dict, outcome: str, detail: str = "") -> None:
    if ctx is None or not ctx.task_id:
        return
    try:
        from datetime import datetime
        from core.state import _tasks
        from services.task_repository import save_task

        task = _tasks.get(ctx.task_id)
        if not task:
            return
        tokens = (
            int(payload.get("inputTokens") or 0)
            + int(payload.get("cachedInputTokens") or 0)
            + int(payload.get("outputTokens") or 0)
        )
        task.setdefault("logs", []).append({
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "agent": "billing",
            "level": "success" if outcome == "reported" else "warn",
            "message": f"AutoCode usage {outcome}: {payload.get('model')} / {tokens} tokens",
            "detail": detail[:1000] if detail else (
                f"agent={payload.get('agentId')}, status={payload.get('status')}, "
                f"input={payload.get('inputTokens')}, cached={payload.get('cachedInputTokens')}, "
                f"output={payload.get('outputTokens')}, latency={payload.get('latencyMs')}ms, "
                f"provider={payload.get('provider') or '-'}, channel={payload.get('channelId') or '-'}, "
                f"ip={payload.get('requestIp') or '-'}, scene={payload.get('sceneType') or '-'}"
            ),
        })
        save_task(dict(task))
    except Exception:
        pass


def extract_token_usage(usage: dict | None) -> tuple[int, int, int]:
    usage = usage or {}
    input_tokens = (
        usage.get("prompt_tokens")
        or usage.get("input_tokens")
        or usage.get("total_input_tokens")
        or 0
    )
    output_tokens = (
        usage.get("completion_tokens")
        or usage.get("output_tokens")
        or usage.get("total_output_tokens")
        or 0
    )
    cached_input_tokens = (
        usage.get("cached_input_tokens")
        or usage.get("prompt_cache_hit_tokens")
        or usage.get("cache_read_input_tokens")
        or 0
    )

    details = usage.get("prompt_tokens_details") or usage.get("input_token_details") or {}
    if isinstance(details, dict):
        cached_input_tokens = cached_input_tokens or details.get("cached_tokens") or details.get("cache_read") or 0

    return int(input_tokens or 0), int(cached_input_tokens or 0), int(output_tokens or 0)


async def report_usage(
    *,
    model: str,
    input_tokens: int = 0,
    cached_input_tokens: int = 0,
    output_tokens: int = 0,
    latency_ms: int = 0,
    status: str = "success",
    error_msg: Optional[str] = None,
    provider: Optional[str] = None,
    channel_id: Optional[str] = None,
    context: UsageContext | None = None,
) -> None:
    ctx = context or current_usage_context()
    if ctx is None or not ctx.user_id:
        return

    payload = {
        "userId": int(ctx.user_id) if str(ctx.user_id).isdigit() else None,
        "userUuid": None if str(ctx.user_id).isdigit() else str(ctx.user_id),
        "model": model or "unknown",
        "inputTokens": max(0, int(input_tokens or 0)),
        "cachedInputTokens": max(0, int(cached_input_tokens or 0)),
        "outputTokens": max(0, int(output_tokens or 0)),
        "latencyMs": max(0, int(latency_ms or 0)),
        "status": status or "success",
        "errorMsg": (error_msg or "")[:1000] if error_msg else None,
        "sceneType": ctx.scene_type or "autocode",
        "agentId": ctx.agent_id,
        "requestIp": ctx.request_ip,
        "provider": provider,
        "channelId": channel_id,
    }
    try:
        from services.cache_ledger_service import CacheLedgerEvent, cache_ledger_service, stable_hash

        status_value = "hit" if int(cached_input_tokens or 0) > 0 else "miss"
        cache_ledger_service.record(CacheLedgerEvent(
            cache_layer="L3",
            cache_key="provider:" + stable_hash({
                "scene": ctx.scene_type if ctx else "autocode",
                "task": ctx.task_id if ctx else "",
                "agent": ctx.agent_id if ctx else "",
                "model": model,
                "provider": provider,
            })[:40],
            status=status_value,
            scene_type=(ctx.scene_type if ctx else "autocode"),
            user_id=str(ctx.user_id or "") if ctx else "",
            task_id=str(ctx.task_id or "") if ctx else "",
            session_id=str(ctx.task_id or "") if ctx else "",
            model=model or "",
            provider=provider or "",
            input_tokens=int(input_tokens or 0),
            cached_input_tokens=int(cached_input_tokens or 0),
            output_tokens=int(output_tokens or 0),
            token_saved_estimate=int(cached_input_tokens or 0),
            hit_reason="provider_cached_input_tokens" if status_value == "hit" else "",
            miss_reason="" if status_value == "hit" else "provider_reported_no_cached_tokens",
            metadata={"channelId": channel_id, "agentId": ctx.agent_id if ctx else None},
        ))
    except Exception:
        pass
    try:
        params = {"apiKey": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
        headers = {"X-Internal-Api-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{MUHUGOCHAT_API_URL}/internal/usage",
                params=params,
                headers=headers,
                json=payload,
            )
        if resp.status_code >= 400:
            logger.warning(f"[UsageReporter] usage report failed: HTTP {resp.status_code} {resp.text[:200]}")
            _record_usage_report_failure(ctx, f"HTTP {resp.status_code}: {resp.text[:500]}")
            _record_usage_report_event(ctx, payload, "failed", f"HTTP {resp.status_code}: {resp.text[:500]}")
        else:
            _record_usage_report_event(ctx, payload, "reported")
    except Exception as exc:
        logger.warning(f"[UsageReporter] usage report failed: {exc}")
        _record_usage_report_failure(ctx, str(exc))
        _record_usage_report_event(ctx, payload, "failed", str(exc))


def monotonic_ms() -> int:
    return int(time.perf_counter() * 1000)
