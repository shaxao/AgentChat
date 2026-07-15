# -*- coding: utf-8 -*-
"""Durable-ish AutoCode task worker.

This is intentionally lightweight: MySQL remains the durable source of truth,
while this module owns the in-process execution queue. On process startup the
API can requeue tasks that were left in runnable states. It is not a distributed
queue yet, but it removes the fragile request-scoped ``asyncio.create_task``
pattern from the critical path.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Iterable

from loguru import logger

from core.agent_orchestrator import _execution_mode, agent_orchestrator
from core.config import get_settings
from core.project_recon import run_project_recon
from core.redis import publish_task_event
from core.state import _tasks
from runtime.session_events import append_event
from services.task_repository import acquire_task_lease, load_all_tasks, release_task_lease, renew_task_lease, save_task
from services.usage_reporter import UsageContext, _usage_context


RUNNABLE_STATUSES = {"pending", "running", "reviewing"}
WAITING_STATUSES = {
    "waiting_confirm",
    "waiting_plan_confirm",
    "waiting_prototype_confirm",
    "waiting_review_confirm",
}
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class TaskQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._queued: set[str] = set()
        self._workers: list[asyncio.Task] = []
        self._scanner: asyncio.Task | None = None
        self._started = False

    def start(self, worker_count: int = 1, scan_interval_seconds: int = 30) -> None:
        if self._started:
            return
        self._started = True
        for idx in range(max(1, worker_count)):
            self._workers.append(asyncio.create_task(self._worker(idx)))
        self._scanner = asyncio.create_task(self._scan_loop(max(10, scan_interval_seconds)))
        logger.info(f"[TaskQueue] started with {len(self._workers)} worker(s)")

    def ensure_started(self, worker_count: int = 1, scan_interval_seconds: int = 30) -> bool:
        """Start the in-process queue if no worker is alive.

        This is a lightweight self-healing guard for cases where the frontend
        reconnects after a reload and observes queued/runnable tasks but the
        in-process worker list is empty.
        """
        alive_workers = [worker for worker in self._workers if not worker.done()]
        if self._started and alive_workers:
            if len(alive_workers) != len(self._workers):
                self._workers = alive_workers
            return False
        self._workers.clear()
        self._started = False
        self.start(worker_count=worker_count, scan_interval_seconds=scan_interval_seconds)
        return True

    async def stop(self) -> None:
        if self._scanner:
            self._scanner.cancel()
            await asyncio.gather(self._scanner, return_exceptions=True)
            self._scanner = None
        for worker in self._workers:
            worker.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        self._started = False

    def enqueue(self, task_id: str, reason: str = "") -> bool:
        task = _tasks.get(task_id)
        if not task:
            return False
        if task.get("status") in TERMINAL_STATUSES or task.get("status") in WAITING_STATUSES:
            return False
        if task_id in self._queued or agent_orchestrator._active_tasks.get(task_id):
            return False
        task["execution_active"] = False
        task["queued_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        if reason:
            task.setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "agent": "queue",
                "level": "info",
                "message": f"Task queued: {reason}",
            })
        self._queued.add(task_id)
        self._queue.put_nowait(task_id)
        try:
            save_task(dict(task))
        except Exception as exc:
            logger.debug(f"[TaskQueue] save queued state failed: {exc}")
        return True

    def requeue_many(self, tasks: Iterable[dict], reason: str = "鍚姩鎭㈠") -> int:
        count = 0
        for task in tasks:
            task_id = task.get("id")
            if task_id and self.enqueue(task_id, reason):
                count += 1
        return count

    def snapshot(self) -> dict:
        return {
            "started": self._started,
            "workers": len(self._workers),
            "queued_count": len(self._queued),
            "queued_task_ids": sorted(self._queued),
            "queue_size": self._queue.qsize(),
        }

    def _auto_continuation_limits(self) -> tuple[int, int]:
        try:
            max_segments = int(os.getenv("AUTOCODE_MAX_AUTO_CONTINUATIONS", "5"))
        except ValueError:
            max_segments = 5
        try:
            total_iterations = int(os.getenv("AUTOCODE_TOTAL_AGENT_ITERATION_BUDGET", "120"))
        except ValueError:
            total_iterations = 120
        return max(0, max_segments), max(1, total_iterations)

    def _prepare_auto_continuation(self, task_id: str) -> bool:
        task = _tasks.get(task_id)
        if not task or not task.get("agent_iteration_limited"):
            return False

        max_segments, total_budget = self._auto_continuation_limits()
        try:
            used_segments = int(task.get("auto_continuation_count") or 0)
        except (TypeError, ValueError):
            used_segments = 0
        try:
            used_iterations = int(task.get("total_agent_iterations") or task.get("agent_iteration") or 0)
        except (TypeError, ValueError):
            used_iterations = 0

        if used_segments >= max_segments or used_iterations >= total_budget:
            approval_id = f"continue-budget-{task_id}"
            confirmation_message = (
                f"已达到自动续跑总预算（{used_segments}/{max_segments} 次，"
                f"{used_iterations}/{total_budget} 轮），任务已保存，需要人工确认后继续。"
            )
            approval_event = append_event(
                task,
                "approval_requested",
                {
                    "approval_id": approval_id,
                    "tool": "continue_task",
                    "action": "continue_task",
                    "reason": confirmation_message,
                    "message": confirmation_message,
                    "payload": {
                        "kind": "auto_continuation_budget",
                        "used_segments": used_segments,
                        "max_segments": max_segments,
                        "used_iterations": used_iterations,
                        "total_budget": total_budget,
                    },
                    "manual_required": True,
                    "high_risk": False,
                    "auto_approve_after_seconds": 0,
                },
                source="queue",
                publish=publish_task_event,
            )
            task["agent_iteration_limited"] = False
            task["execution_active"] = False
            task["status"] = "waiting_confirm"
            task["current_step"] = confirmation_message
            task["pending_confirmation"] = {
                "kind": "auto_continuation_budget",
                "action": "continue_task",
                "reason": confirmation_message,
                "event_id": approval_event.get("id"),
                "approval_id": approval_id,
                "payload": {
                    "kind": "auto_continuation_budget",
                    "used_segments": used_segments,
                    "max_segments": max_segments,
                    "used_iterations": used_iterations,
                    "total_budget": total_budget,
                },
                "manual_required": True,
                "high_risk": False,
                "auto_approve_after_seconds": 0,
            }
            task.setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "agent": "queue",
                "level": "warn",
                "message": task["current_step"],
            })
            save_task(dict(task))
            return False

        task["auto_continuation_count"] = used_segments + 1
        task["agent_iteration_limited"] = False
        task["needs_continuation"] = True
        task["execution_active"] = False
        task["status"] = "pending"
        task["current_step"] = (
            f"达到单段迭代上限，已压缩上下文，自动续跑 "
            f"{used_segments + 1}/{max_segments}（总迭代 {used_iterations}/{total_budget}）。"
        )
        if task.get("last_chat_continuation_message") and not task.get("chat_continuation_message"):
            task["chat_continuation_message"] = task["last_chat_continuation_message"]
        task.setdefault("logs", []).append({
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "agent": "queue",
            "level": "info",
            "message": task["current_step"],
        })
        save_task(dict(task))
        return True

    async def _scan_loop(self, interval_seconds: int) -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                tasks = await asyncio.to_thread(load_all_tasks)
                recovered = 0
                for task in tasks:
                    task_id = task.get("id")
                    if not task_id or task.get("status") not in RUNNABLE_STATUSES:
                        continue
                    if task_id not in _tasks:
                        _tasks[task_id] = task
                    if self.enqueue(task_id, "数据库扫描恢复"):
                        recovered += 1
                if recovered:
                    logger.warning(f"[TaskQueue] recovered {recovered} runnable task(s) from DB scan")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.debug(f"[TaskQueue] DB scan failed: {exc}")

    async def _worker(self, idx: int) -> None:
        while True:
            task_id = await self._queue.get()
            self._queued.discard(task_id)
            try:
                await self._run_task(task_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(f"[TaskQueue] worker {idx} task {task_id} failed: {exc}")
            finally:
                self._queue.task_done()

    async def _run_task(self, task_id: str) -> None:
        task = _tasks.get(task_id)
        if not task:
            return
        if task.get("status") in TERMINAL_STATUSES or task.get("status") in WAITING_STATUSES:
            return
        if agent_orchestrator._active_tasks.get(task_id):
            return
        if not acquire_task_lease(task_id):
            logger.info(f"[TaskQueue] task {task_id} skipped; lease is held by another worker")
            return

        renewer = asyncio.create_task(self._renew_lease_loop(task_id))
        auto_continue_after_release = False

        usage_token = _usage_context.set(UsageContext(
            user_id=str(task.get("user_id")) if task.get("user_id") else None,
            task_id=task_id,
            scene_type="autocode",
            agent_id="planner",
            request_ip=task.get("request_ip"),
        ))
        try:
            await self._prepare_before_execution(task_id, task)

            if task.get("status") in TERMINAL_STATUSES or task.get("status") in WAITING_STATUSES:
                return

            await agent_orchestrator.execute_task(
                task_id,
                task.get("description", task.get("title", "")),
                task.get("project_type", "nextjs"),
                task["workspace_id"],
                task.get("agents") or ["frontend"],
            )
            if task_id in _tasks:
                if agent_orchestrator.prepare_wake_continuation(task_id):
                    auto_continue_after_release = True
                else:
                    auto_continue_after_release = self._prepare_auto_continuation(task_id)
                if not auto_continue_after_release:
                    save_task(dict(_tasks[task_id]))
        except Exception as exc:
            logger.error(f"[TaskQueue] task {task_id} execution error: {exc}")
            current = _tasks.get(task_id)
            if current:
                current["status"] = "failed"
                current["execution_active"] = False
                current.setdefault("logs", []).append({
                    "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "agent": "queue",
                    "level": "error",
                    "message": f"鍚庡彴浠诲姟鎵ц澶辫触: {exc}",
                    "detail": str(exc),
                })
                save_task(dict(current))
        finally:
            renewer.cancel()
            await asyncio.gather(renewer, return_exceptions=True)
            release_task_lease(task_id)
            _usage_context.reset(usage_token)
            if auto_continue_after_release:
                reason = "session wake: pending chat input" if (_tasks.get(task_id) or {}).pop("session_wake_pending", False) else "自动续跑：单段迭代上限"
                self.enqueue(task_id, reason)

    async def _renew_lease_loop(self, task_id: str) -> None:
        while True:
            await asyncio.sleep(120)
            ok = await asyncio.to_thread(renew_task_lease, task_id)
            if not ok:
                logger.warning(f"[TaskQueue] lost task lease: {task_id}")
                agent_orchestrator.cancel_task(task_id)
                return

    async def _prepare_before_execution(self, task_id: str, task: dict) -> None:
        workspace_path = get_settings().workspace_base_dir / task["workspace_id"]
        workspace_path.mkdir(parents=True, exist_ok=True)

        spec = task.get("spec")
        if spec:
            try:
                (workspace_path / "SPEC.md").write_text(spec, encoding="utf-8")
            except Exception as exc:
                logger.warning(f"[TaskQueue] write SPEC.md failed for {task_id}: {exc}")

        if not task.get("project_recon"):
            try:
                recon = await asyncio.to_thread(
                    run_project_recon,
                    workspace_path,
                    declared_type=task.get("project_type", ""),
                    description=task.get("description", ""),
                )
                task["project_recon"] = recon
                task["complexity"] = recon.get("complexity")
                task["recommended_flow"] = recon.get("recommended_flow")
                task["prototype_required"] = bool(recon.get("should_generate_prototype"))
                task.setdefault("logs", []).append({
                    "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    "agent": "recon",
                    "level": "info",
                    "message": (
                        f"椤圭洰渚﹀療: {recon.get('project_kind')} / "
                        f"{recon.get('complexity')} / {recon.get('recommended_flow')}"
                    ),
                    "detail": json.dumps(recon, ensure_ascii=False),
                })
                save_task(dict(task))
            except Exception as exc:
                logger.warning(f"[TaskQueue] 椤圭洰渚﹀療澶辫触 {task_id}: {exc}")

        await agent_orchestrator._ensure_client(requested_model=task.get("model"))

        if task.get("enable_smart_planning") and task.get("description") and not task.get("plan"):
            await self._create_plan(task_id, task)

    async def _create_plan(self, task_id: str, task: dict) -> None:
        from core.task_planner import plan_task

        task["current_step"] = "鍒嗘瀽闇€姹傦紝鐢熸垚浠诲姟璁″垝..."
        task["progress"] = max(int(task.get("progress") or 0), 2)
        save_task(dict(task))

        recon = task.get("project_recon") or {}
        recon_summary = ""
        if recon:
            recon_summary = (
                "\n\n椤圭洰渚﹀療缁撴灉锛歕n"
                f"- 椤圭洰绫诲瀷: {recon.get('project_kind')}\n"
                f"- 澶嶆潅搴? {recon.get('complexity')}\n"
                f"- 鎺ㄨ崘娴佺▼: {recon.get('recommended_flow')}\n"
                f"- 鎶€鏈爤: {', '.join(recon.get('likely_stack') or [])}\n"
                f"- 鍏ュ彛鏂囦欢: {', '.join((recon.get('entrypoints') or [])[:10])}\n"
                f"- 鍙敤鍛戒护: {json.dumps(recon.get('commands') or {}, ensure_ascii=False)}\n"
                f"- 瑙勫垝寤鸿: {'; '.join(recon.get('plan_guidance') or [])}\n"
            )

        plan_result = await plan_task(
            description=str(task.get("description") or "") + recon_summary,
            project_type=task.get("project_type", "nextjs"),
            agent_types=task.get("agents") or ["frontend"],
            llm_client=await agent_orchestrator._ensure_client(requested_model=task.get("model")),
            model=task.get("model") or agent_orchestrator._model or "",
            project_recon=recon,
        )

        task["plan"] = plan_result.model_dump()
        task["progress"] = 5
        if _execution_mode(task) == "planned":
            task["current_step"] = f"瑙勫垝瀹屾垚: {len(plan_result.subtasks)} 涓瓙浠诲姟锛岀瓑寰呯‘璁?.."
            task["plan_confirmed"] = None
            task["status"] = "waiting_plan_confirm"
        else:
            task["current_step"] = f"Agentic Loop plan hint ready: {len(plan_result.subtasks)} subtasks"
            task["plan_confirmed"] = True
            task["status"] = "pending"
            task["execution_mode"] = "agentic"
            append_event(task, "agentic_plan_hint_ready", {
                "subtask_count": len(plan_result.subtasks),
                "mode": "agentic",
                "message": "计划已作为上下文提示生成，不阻塞 Agentic Loop 执行。",
            }, source="planner")
        task.setdefault("logs", []).append({
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "agent": "planner",
            "level": "success",
            "message": f"璁″垝宸茬敓鎴? {len(plan_result.subtasks)} 涓瓙浠诲姟",
        })
        save_task(dict(task))


task_queue = TaskQueue()
