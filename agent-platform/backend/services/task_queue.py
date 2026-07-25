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

from core.agent_orchestrator import (
    _absolute_iteration_cap,
    _execution_mode,
    _progress_fingerprint,
    _unrestricted_dev_mode,
    agent_orchestrator,
)
from core.config import get_settings
from core.project_recon import run_project_recon
from core.redis import publish_task_event
from core.state import _tasks
from runtime.session_events import append_event
from services.cache_ledger_service import stable_hash
from services.task_repository import acquire_task_lease, load_all_tasks, release_task_lease, renew_task_lease, save_task
from services.usage_reporter import UsageContext, _usage_context


RUNNABLE_STATUSES = {"pending", "running", "reviewing"}
WAITING_STATUSES = {
    "waiting_confirm",
    "waiting_user_input",
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

    def _stall_threshold(self) -> int:
        """Consecutive no-progress segments tolerated before requesting human confirmation."""
        try:
            threshold = int(os.getenv("AUTOCODE_MAX_STALLED_CONTINUATIONS", "999"))
        except ValueError:
            threshold = 999
        return max(1, threshold)

    def _prepare_auto_continuation(self, task_id: str) -> bool:
        task = _tasks.get(task_id)
        if not task or not task.get("agent_iteration_limited"):
            return False

        cap = _absolute_iteration_cap()
        try:
            used_segments = int(task.get("auto_continuation_count") or 0)
        except (TypeError, ValueError):
            used_segments = 0
        try:
            used_iterations = int(task.get("total_agent_iterations") or task.get("agent_iteration") or 0)
        except (TypeError, ValueError):
            used_iterations = 0
        try:
            window_base = int(task.get("auto_continuation_budget_base") or 0)
        except (TypeError, ValueError):
            window_base = 0
        # Iterations consumed since the current window opened (start / last manual approval).
        consumed_in_window = max(0, used_iterations - window_base)

        # Progress-aware gating: prefer the loop-level watchdog signature. The
        # older coarse fingerprint remains as a fallback for legacy tasks.
        completed, total_subtasks, changed_files = _progress_fingerprint(task)
        watchdog = task.get("progress_watchdog") if isinstance(task.get("progress_watchdog"), dict) else {}
        watchdog_signature = watchdog.get("last_signature") if isinstance(watchdog.get("last_signature"), dict) else None
        if watchdog_signature is not None:
            current_fp = stable_hash(watchdog_signature)
            prev = task.get("last_progress_watchdog_signature")
            made_progress = prev is None or str(prev) != current_fp
            task["last_progress_watchdog_signature"] = current_fp
        else:
            prev = task.get("last_progress_fingerprint")
            prev_tuple = tuple(prev) if isinstance(prev, (list, tuple)) else None
            current_tuple = (completed, total_subtasks, changed_files)
            made_progress = prev_tuple is None or current_tuple != prev_tuple
            task["last_progress_fingerprint"] = [completed, total_subtasks, changed_files]
        if made_progress:
            stalled_segments = 0
        else:
            try:
                stalled_segments = int(task.get("stalled_continuation_count") or 0) + 1
            except (TypeError, ValueError):
                stalled_segments = 1
        task["stalled_continuation_count"] = stalled_segments

        limit_reason = str(task.get("agent_iteration_limit_reason") or "")
        watchdog_stop_reason = str((watchdog or {}).get("stop_reason") or "")
        no_change_retry = limit_reason == "agentic_no_change_retry"
        unrestricted_mode = _unrestricted_dev_mode(task)
        stall_threshold = self._stall_threshold()
        hit_cap = consumed_in_window >= cap
        watchdog_allows_stall_gate = watchdog_signature is None or watchdog_stop_reason in {"blocked_by_no_progress", "duplicate_discovery"}
        stalled_out = (
            stalled_segments >= stall_threshold
            and not unrestricted_mode
            and not no_change_retry
            and watchdog_allows_stall_gate
        )

        if hit_cap or stalled_out:
            approval_id = f"continue-budget-{task_id}"
            if hit_cap:
                confirmation_message = (
                    f"已达到自动续跑安全上限（本轮累计 {consumed_in_window}/{cap} 轮），"
                    f"任务已保存，需要人工确认后继续。"
                )
            else:
                confirmation_message = (
                    f"连续 {stalled_segments} 段自动续跑未产生新进展"
                    f"（子任务 {completed}/{total_subtasks}，累计变更文件 {changed_files}），"
                    f"任务已保存，需要人工确认后继续。"
                )
            gate_payload = {
                "kind": "auto_continuation_budget",
                "reason": "absolute_cap" if hit_cap else "stalled",
                "used_segments": used_segments,
                "used_iterations": used_iterations,
                "consumed_in_window": consumed_in_window,
                "absolute_cap": cap,
                "stalled_segments": stalled_segments,
                "stall_threshold": stall_threshold,
                "completed_subtasks": completed,
                "total_subtasks": total_subtasks,
                "changed_files": changed_files,
            }
            approval_event = append_event(
                task,
                "approval_requested",
                {
                    "approval_id": approval_id,
                    "tool": "continue_task",
                    "action": "continue_task",
                    "reason": confirmation_message,
                    "message": confirmation_message,
                    "payload": gate_payload,
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
                "payload": gate_payload,
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
        remaining_subtasks = max(0, total_subtasks - completed)
        task["current_step"] = (
            f"达到续跑保险丝，已保存上下文，自动续跑第 {used_segments + 1} 段"
            f"（本轮累计 {consumed_in_window}/{cap} 轮，剩余子任务 {remaining_subtasks}）。"
        )
        if task.get("last_chat_continuation_message") and not task.get("chat_continuation_message"):
            task["chat_continuation_message"] = task["last_chat_continuation_message"]
        if no_change_retry:
            guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
            candidate_files = [
                str(path).replace("\\", "/")
                for path in (guard.get("candidate_files") or [])
                if str(path).strip()
            ][:12]
            read_files = [
                str(path).replace("\\", "/")
                for path in (guard.get("read_files") or [])
                if str(path).strip()
            ][:20]
            base_message = str(task.get("chat_continuation_message") or task.get("last_chat_continuation_message") or "")
            task["chat_continuation_message"] = "\n\n".join([
                base_message,
                "[AUTO_CONTINUATION_NO_CHANGE]\n"
                "上一段已经完成观察但没有产生真实文件变更。不要重新扫描项目结构，不要重复读取 read_files。"
                "本段必须基于已有上下文直接编辑、运行验证，或给出一个具体阻塞问题。\n"
                f"Candidate files: {', '.join(candidate_files) or '(none)'}\n"
                f"Already read: {', '.join(read_files) or '(none)'}",
            ]).strip()
        execution_plan = task.get("active_execution_plan") if isinstance(task.get("active_execution_plan"), dict) else {}
        active_route = task.get("active_intent_route") if isinstance(task.get("active_intent_route"), dict) else {}
        if execution_plan:
            append_event(
                task,
                "intent_routed",
                {
                    "entrypoint": "auto_continuation",
                    "final_intent": execution_plan.get("intent"),
                    "action": active_route.get("action") or execution_plan.get("action"),
                    "task_family": execution_plan.get("task_family"),
                    "target": execution_plan.get("target"),
                    "reason": "auto_continuation_without_new_requirement",
                    "reused": True,
                },
                source="queue",
                publish=publish_task_event,
            )
            append_event(
                task,
                "execution_plan_selected",
                {**execution_plan, "reused": True, "reuse_reason": "auto_continuation_without_new_requirement"},
                source="queue",
                publish=publish_task_event,
            )
            append_event(
                task,
                "execution_plan_reused",
                {
                    "entrypoint": "auto_continuation",
                    "intent": execution_plan.get("intent"),
                    "task_family": execution_plan.get("task_family"),
                    "reason": "auto_continuation_without_new_requirement",
                },
                source="queue",
                publish=publish_task_event,
            )
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
                task.get("project_type") or "unknown",
                task["workspace_id"],
                task.get("agents") or ["general"],
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
                    "message": f"后台任务执行失败: {exc}",
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
                        f"项目侦察: {recon.get('project_kind')} / "
                        f"{recon.get('complexity')} / {recon.get('recommended_flow')}"
                    ),
                    "detail": json.dumps(recon, ensure_ascii=False),
                })
                save_task(dict(task))
            except Exception as exc:
                logger.warning(f"[TaskQueue] 项目侦察失败 {task_id}: {exc}")

        await agent_orchestrator._ensure_client(requested_model=task.get("model"))

        if task.get("enable_smart_planning") and task.get("description") and not task.get("plan"):
            await self._create_plan(task_id, task)

    async def _create_plan(self, task_id: str, task: dict) -> None:
        from core.task_planner import plan_task

        task["current_step"] = "分析需求，生成任务计划..."
        task["progress"] = max(int(task.get("progress") or 0), 2)
        save_task(dict(task))

        recon = task.get("project_recon") or {}
        recon_summary = ""
        if recon:
            recon_summary = (
                "\n\n项目侦察结果：\n"
                f"- 项目类型: {recon.get('project_kind')}\n"
                f"- 复杂度: {recon.get('complexity')}\n"
                f"- 推荐流程: {recon.get('recommended_flow')}\n"
                f"- 技术栈: {', '.join(recon.get('likely_stack') or [])}\n"
                f"- 入口文件: {', '.join((recon.get('entrypoints') or [])[:10])}\n"
                f"- 可用命令: {json.dumps(recon.get('commands') or {}, ensure_ascii=False)}\n"
                f"- 规划建议: {'; '.join(recon.get('plan_guidance') or [])}\n"
            )

        plan_result = await plan_task(
            description=str(task.get("description") or "") + recon_summary,
            project_type=task.get("project_type") or "unknown",
            agent_types=task.get("agents") or ["general"],
            llm_client=await agent_orchestrator._ensure_client(requested_model=task.get("model")),
            model=task.get("model") or agent_orchestrator._model or "",
            project_recon=recon,
        )

        task["plan"] = plan_result.model_dump()
        task["progress"] = 5
        if _execution_mode(task) == "planned":
            task["current_step"] = f"规划完成: {len(plan_result.subtasks)} 个子任务，等待确认..."
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
            "message": f"计划已生成: {len(plan_result.subtasks)} 个子任务",
        })
        save_task(dict(task))


task_queue = TaskQueue()
