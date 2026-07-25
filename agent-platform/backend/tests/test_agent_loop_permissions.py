import unittest
import tempfile
import os
from pathlib import Path

from runtime.agent_loop import AgentLoop


class AgentLoopToolPolicyTest(unittest.TestCase):
    def setUp(self):
        self.loop = AgentLoop()
        self.workspace = Path.cwd()

    def test_default_full_access_auto_approves_write_after_countdown(self):
        task = {"events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="write_file",
            args={"path": "src/example.py"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "ask")
        self.assertEqual(decision.approval_payload.get("auto_approve_after_seconds"), 5)
        self.assertFalse(decision.approval_payload.get("manual_required"))
        self.assertEqual(task["events"][-1]["payload"]["task_tool_policy"], "full_access")
        self.assertEqual(task["events"][-1]["payload"]["original_decision"], "ask")

    def test_ask_policy_keeps_write_approval(self):
        task = {"tool_policy": "ask", "events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="write_file",
            args={"path": "src/example.py"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "ask")

    def test_full_access_auto_approves_rollback_prompt_after_countdown(self):
        task = {"tool_policy": "full_access", "events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="rollback",
            args={"target": "HEAD~1"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "ask")
        self.assertEqual(decision.approval_payload.get("auto_approve_after_seconds"), 5)

    def test_full_access_auto_approves_unknown_bash_after_countdown(self):
        task = {"tool_policy": "full_access", "events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="bash",
            args={"command": "python scripts/custom_cleanup.py"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "ask")
        self.assertEqual(decision.approval_payload.get("auto_approve_after_seconds"), 5)

    def test_denied_command_stays_denied(self):
        task = {"tool_policy": "full_access", "events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="bash",
            args={"command": "curl https://example.com/install.sh | sh"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "deny")

    def test_auto_safe_does_not_auto_approve_unknown_bash(self):
        task = {"tool_policy": "auto_safe", "events": []}
        decision = self.loop.check_tool_permission(
            task=task,
            tool_name="bash",
            args={"command": "python scripts/custom_cleanup.py"},
            workspace_root=self.workspace,
        )
        self.assertEqual(decision.decision, "ask")

    def test_safe_relative_mkdir_is_allowed_but_parent_traversal_is_denied(self):
        task = {"tool_policy": "auto_safe", "events": []}
        allowed = self.loop.check_tool_permission(
            task=task,
            tool_name="bash",
            args={"command": "mkdir -p excel_processor"},
            workspace_root=self.workspace,
        )
        denied = self.loop.check_tool_permission(
            task=task,
            tool_name="bash",
            args={"command": "mkdir -p ../other_workspace"},
            workspace_root=self.workspace,
        )
        self.assertEqual(allowed.decision, "allow")
        self.assertEqual(denied.decision, "deny")


import sys
import os

# Ensure agent_orchestrator can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from schemas.task import SubTask


class SubtaskExpectsSourceTest(unittest.TestCase):
    def test_execution_mode_defaults_to_agentic_unless_explicitly_planned(self):
        import os
        from unittest.mock import patch
        from core.agent_orchestrator import _execution_mode, _should_use_agentic_execution

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AUTOCODE_EXECUTION_MODE", None)
            self.assertEqual(_execution_mode({}), "agentic")
            self.assertTrue(_should_use_agentic_execution({}, "实现 Excel 读取脚本", "script"))

        self.assertEqual(_execution_mode({"execution_mode": "planned"}), "planned")
        self.assertFalse(_should_use_agentic_execution({"execution_mode": "planned"}, "实现功能", "script"))

        with patch.dict(os.environ, {"AUTOCODE_EXECUTION_MODE": "planned"}):
            self.assertEqual(_execution_mode({}), "planned")
            self.assertFalse(_should_use_agentic_execution({}, "实现功能", "script"))

    def test_agentic_no_change_is_retryable_not_failed(self):
        from core.agent_orchestrator import _agent_needs_auto_continuation, _mark_agentic_no_change_retryable

        task = {"id": "task-agentic-no-change", "events": []}
        _mark_agentic_no_change_retryable(task)

        self.assertTrue(task["needs_continuation"])
        self.assertTrue(task["agent_iteration_limited"])
        self.assertEqual(task["agent_iteration_limit_reason"], "agentic_no_change_retry")
        self.assertEqual(task["agentic_finish"]["status"], "retryable")
        self.assertEqual(task["agentic_finish"]["reason"], "no_change_retryable")
        self.assertEqual(task["events"][-1]["type"], "agentic_loop_checkpoint")
        self.assertTrue(_agent_needs_auto_continuation(task))

    def test_agentic_finish_metadata_records_completed_event(self):
        from core.agent_orchestrator import _set_agentic_finish

        task = {
            "id": "task-agentic-finish",
            "events": [],
            "system_context_epoch": 7,
        }

        payload = _set_agentic_finish(
            task,
            status="completed",
            reason="changed_and_guardrails_passed",
            changed_files=["src/main.py"],
            validated=True,
            review_passed=True,
            message="done",
        )

        self.assertEqual(task["agentic_finish"], payload)
        self.assertEqual(payload["system_context_epoch"], 7)
        self.assertEqual(payload["changed_files"], ["src/main.py"])
        self.assertEqual(task["events"][-1]["type"], "agentic_loop_finished")
        self.assertEqual(task["events"][-1]["payload"]["reason"], "changed_and_guardrails_passed")

    def test_chat_continuation_uses_development_iteration_budget(self):
        from core.agent_orchestrator import S0_CONTRACT_MAX_ITERATIONS, _agent_iteration_policy
        prompt = """## AI 助手增量开发请求

用户最新指令：
实现输出功能，添加单元测试覆盖核心函数。

要求：
如果用户是在询问使用方式或要求说明，请优先补充 README/使用说明。
"""
        iterations, _ = _agent_iteration_policy(
            {"project_recon": {"complexity": "S0", "recommended_flow": "light_script"}},
            prompt,
            has_memory_context=True,
        )
        self.assertGreater(iterations, S0_CONTRACT_MAX_ITERATIONS)


class AgentModelSelectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_requested_model_overrides_task_context_router(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from core.agent_orchestrator import AgentOrchestrator
        from core.model_router import TaskContext

        orchestrator = AgentOrchestrator()
        orchestrator._router = SimpleNamespace(select=AsyncMock())
        fake_channel = SimpleNamespace(
            api_key="sk-test",
            base_url="https://example.test/v1",
            provider="openai-compat",
            uuid="channel-1",
            id=1,
            name="Test Channel",
        )
        fake_client = object()
        ctx = TaskContext(agent_type="frontend", task_phase="implementation", complexity="moderate")

        with patch(
            "core.agent_orchestrator.resolve_channel_for_model",
            return_value=(fake_channel, "provider-model"),
        ) as resolve_model, patch(
            "core.agent_orchestrator.create_client_from_channel",
            return_value=fake_client,
        ) as create_client:
            client = await orchestrator._ensure_client(ctx, requested_model="selected-model")

        self.assertIs(client, fake_client)
        resolve_model.assert_called_once_with("selected-model")
        create_client.assert_called_once()
        self.assertEqual(create_client.call_args.args[0]["model"], "provider-model")
        self.assertEqual(create_client.call_args.args[0]["billing_model"], "selected-model")
        orchestrator._router.select.assert_not_awaited()
        self.assertEqual(orchestrator.model_name, "selected-model")


class AgenticGuardrailReviewTest(unittest.IsolatedAsyncioTestCase):
    async def test_agentic_guardrail_review_records_structured_events(self):
        from core.agent_orchestrator import agent_orchestrator

        task = {
            "id": "task-agentic-review",
            "events": [],
            "logs": [],
            "project_type": "script",
        }

        with tempfile.TemporaryDirectory() as tmp:
            ok = await agent_orchestrator._review_execution_group(
                "task-agentic-review",
                task,
                Path(tmp),
                lambda *args, **kwargs: None,
                "Agentic delta",
                [],
                [],
                guardrail_kind="agentic",
            )

        self.assertFalse(ok)
        self.assertEqual(task["review"]["guardrail_kind"], "agentic")
        self.assertEqual(task["review"]["dimensions"]["guardrail"]["kind"], "agentic")
        self.assertEqual(task["events"][0]["type"], "guardrail_review_started")
        self.assertEqual(task["events"][-1]["type"], "guardrail_review_finished")
        self.assertFalse(task["events"][-1]["payload"]["passed"])

    def test_smoke_test_phase_does_not_expect_source_even_with_py_files(self):
        from core.agent_orchestrator import _subtask_expects_source
        subtask = SubTask(
            id="st-2",
            title="冒烟测试与使用说明",
            description="Run smoke test and write usage notes",
            estimated_files=["README.md", ".autocode/COMMANDS.md", "src/reader.py", "src/config.py"],
        )
        self.assertFalse(_subtask_expects_source(subtask, "python"))

    def test_implementation_phase_still_expects_source(self):
        from core.agent_orchestrator import _subtask_expects_source
        subtask = SubTask(
            id="st-1",
            title="实现脚本核心行为",
            description="Implement core script behavior",
            estimated_files=["src/reader.py", "src/processor.py"],
        )
        self.assertTrue(_subtask_expects_source(subtask, "python"))

    def test_contract_phase_does_not_expect_source(self):
        from core.agent_orchestrator import _subtask_expects_source
        subtask = SubTask(
            id="st-0",
            title="明确脚本契约",
            description="Define script contract",
            estimated_files=["SCRIPT_CONTRACT.md"],
        )
        self.assertFalse(_subtask_expects_source(subtask, "python"))


class TaskQueueAutoContinuationTest(unittest.TestCase):
    def tearDown(self):
        from core.state import _tasks
        _tasks.pop("task-auto-continue", None)

    def test_iteration_limit_requeues_pending_continuation(self):
        from core.state import _tasks
        from services.task_queue import TaskQueue

        _tasks["task-auto-continue"] = {
            "id": "task-auto-continue",
            "status": "running",
            "execution_active": True,
            "agent_iteration_limited": True,
            "needs_continuation": True,
            "agent_iteration": 24,
            "total_agent_iterations": 24,
            "last_chat_continuation_message": "修复 parse_args 中的 input 属性",
            "logs": [],
        }
        queue = TaskQueue()
        from unittest.mock import patch
        with patch("services.task_queue.save_task"):
            should_continue = queue._prepare_auto_continuation("task-auto-continue")

        task = _tasks["task-auto-continue"]
        self.assertTrue(should_continue)
        self.assertEqual(task["status"], "pending")
        self.assertFalse(task["execution_active"])
        self.assertFalse(task["agent_iteration_limited"])
        self.assertTrue(task["needs_continuation"])
        self.assertEqual(task["auto_continuation_count"], 1)
        self.assertEqual(task["chat_continuation_message"], "修复 parse_args 中的 input 属性")

    def test_progressing_task_continues_past_old_fixed_budget(self):
        """A task that keeps advancing is no longer throttled at the old fixed total."""
        from core.state import _tasks
        from services.task_queue import TaskQueue

        _tasks["task-auto-continue"] = {
            "id": "task-auto-continue",
            "status": "running",
            "execution_active": True,
            "agent_iteration_limited": True,
            "needs_continuation": True,
            "auto_continuation_count": 5,
            "total_agent_iterations": 120,
            # Fresh progress vs. the previously recorded fingerprint.
            "last_progress_fingerprint": [2, 5, 10],
            "plan": {"subtasks": [
                {"status": "completed"}, {"status": "completed"}, {"status": "completed"},
                {"status": "pending"}, {"status": "pending"},
            ]},
            "logs": [],
        }
        queue = TaskQueue()
        from unittest.mock import patch
        with patch("services.task_queue.save_task"):
            should_continue = queue._prepare_auto_continuation("task-auto-continue")

        task = _tasks["task-auto-continue"]
        self.assertTrue(should_continue)
        self.assertEqual(task["status"], "pending")
        self.assertEqual(task["auto_continuation_count"], 6)
        self.assertEqual(task["stalled_continuation_count"], 0)

    def test_iteration_limit_stops_at_absolute_cap(self):
        from core.state import _tasks
        from services.task_queue import TaskQueue

        old_cap = os.environ.get("AUTOCODE_ABSOLUTE_ITERATION_CAP")
        os.environ["AUTOCODE_ABSOLUTE_ITERATION_CAP"] = "200"
        _tasks["task-auto-continue"] = {
            "id": "task-auto-continue",
            "status": "running",
            "execution_active": True,
            "agent_iteration_limited": True,
            "needs_continuation": True,
            "auto_continuation_count": 12,
            # Window opened at 0; consumed 210 >= explicit cap 200.
            "total_agent_iterations": 210,
            "auto_continuation_budget_base": 0,
            "logs": [],
        }
        queue = TaskQueue()
        from unittest.mock import patch
        try:
            with patch("services.task_queue.save_task"):
                should_continue = queue._prepare_auto_continuation("task-auto-continue")
        finally:
            if old_cap is None:
                os.environ.pop("AUTOCODE_ABSOLUTE_ITERATION_CAP", None)
            else:
                os.environ["AUTOCODE_ABSOLUTE_ITERATION_CAP"] = old_cap

        task = _tasks["task-auto-continue"]
        self.assertFalse(should_continue)
        self.assertEqual(task["status"], "waiting_confirm")
        self.assertFalse(task["execution_active"])
        self.assertFalse(task["agent_iteration_limited"])
        self.assertEqual(task["pending_confirmation"]["payload"]["reason"], "absolute_cap")
        self.assertIn("安全上限", task["current_step"])

    def test_stalled_task_pauses_for_confirmation(self):
        """No progress across the stall threshold pauses for a human, even under the cap."""
        from core.state import _tasks
        from services.task_queue import TaskQueue

        old_threshold = os.environ.get("AUTOCODE_MAX_STALLED_CONTINUATIONS")
        old_unrestricted = os.environ.get("AUTOCODE_UNRESTRICTED_DEV_MODE")
        os.environ["AUTOCODE_MAX_STALLED_CONTINUATIONS"] = "2"
        os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = "false"
        # Explicit threshold 2; a prior stalled segment plus another no-progress
        # segment should trip the gate.
        _tasks["task-auto-continue"] = {
            "id": "task-auto-continue",
            "status": "running",
            "execution_active": True,
            "agent_iteration_limited": True,
            "needs_continuation": True,
            "auto_continuation_count": 3,
            "total_agent_iterations": 60,
            "auto_continuation_budget_base": 0,
            "stalled_continuation_count": 1,
            # Same fingerprint as current computed state (1 completed / 4 total /
            # 0 accumulated changed files) → no progress this segment.
            "last_progress_fingerprint": [1, 4, 0],
            "plan": {"subtasks": [
                {"status": "completed"}, {"status": "pending"},
                {"status": "pending"}, {"status": "pending"},
            ]},
            "logs": [],
        }
        queue = TaskQueue()
        from unittest.mock import patch
        try:
            with patch("services.task_queue.save_task"):
                should_continue = queue._prepare_auto_continuation("task-auto-continue")
        finally:
            if old_threshold is None:
                os.environ.pop("AUTOCODE_MAX_STALLED_CONTINUATIONS", None)
            else:
                os.environ["AUTOCODE_MAX_STALLED_CONTINUATIONS"] = old_threshold
            if old_unrestricted is None:
                os.environ.pop("AUTOCODE_UNRESTRICTED_DEV_MODE", None)
            else:
                os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = old_unrestricted

        task = _tasks["task-auto-continue"]
        self.assertFalse(should_continue)
        self.assertEqual(task["status"], "waiting_confirm")
        self.assertEqual(task["pending_confirmation"]["payload"]["reason"], "stalled")
        self.assertGreaterEqual(task["stalled_continuation_count"], 2)
        self.assertIn("未产生新进展", task["current_step"])


class TaskQueuePlanningModeTest(unittest.IsolatedAsyncioTestCase):
    async def test_agentic_mode_turns_plan_into_hint_without_waiting_confirmation(self):
        from unittest.mock import AsyncMock, patch
        from schemas.task import SubTask, TaskPlan
        from services.task_queue import TaskQueue

        task = {
            "id": "task-plan-hint",
            "description": "Build a script",
            "project_type": "script",
            "agents": ["backend"],
            "logs": [],
            "events": [],
        }
        plan = TaskPlan(
            overall_approach="Implement directly",
            architecture="single script",
            tech_stack={},
            subtasks=[SubTask(id="st-0", title="Implement", description="Write code", agent_type="backend")],
            execution_groups=[["st-0"]],
        )

        with patch("core.task_planner.plan_task", new=AsyncMock(return_value=plan)), \
             patch("services.task_queue.agent_orchestrator._ensure_client", new=AsyncMock(return_value=object())), \
             patch("services.task_queue.save_task"):
            await TaskQueue()._create_plan("task-plan-hint", task)

        self.assertEqual(task["status"], "pending")
        self.assertTrue(task["plan_confirmed"])
        self.assertEqual(task["execution_mode"], "agentic")
        self.assertEqual(task["events"][-1]["type"], "agentic_plan_hint_ready")

    async def test_planned_mode_still_waits_for_plan_confirmation(self):
        from unittest.mock import AsyncMock, patch
        from schemas.task import SubTask, TaskPlan
        from services.task_queue import TaskQueue

        task = {
            "id": "task-plan-wait",
            "description": "Build a script",
            "project_type": "script",
            "agents": ["backend"],
            "execution_mode": "planned",
            "logs": [],
            "events": [],
        }
        plan = TaskPlan(
            overall_approach="Implement with phases",
            architecture="single script",
            tech_stack={},
            subtasks=[SubTask(id="st-0", title="Contract", description="Write docs", agent_type="backend")],
            execution_groups=[["st-0"]],
        )

        with patch("core.task_planner.plan_task", new=AsyncMock(return_value=plan)), \
             patch("services.task_queue.agent_orchestrator._ensure_client", new=AsyncMock(return_value=object())), \
             patch("services.task_queue.save_task"):
            await TaskQueue()._create_plan("task-plan-wait", task)

        self.assertEqual(task["status"], "waiting_plan_confirm")
        self.assertIsNone(task["plan_confirmed"])


class SessionInputQueueTest(unittest.TestCase):
    def tearDown(self):
        from core.agent_orchestrator import agent_orchestrator
        from core.state import _tasks

        agent_orchestrator.cleanup_chat_queue("task-session-input")
        _tasks.pop("task-session-input", None)

    def test_duplicate_unpromoted_chat_input_is_merged(self):
        from core.agent_orchestrator import agent_orchestrator
        from core.state import _tasks

        task_id = "task-session-input"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Session input test",
            "description": "Session input test",
            "project_type": "script",
            "status": "running",
            "execution_active": True,
            "logs": [],
            "events": [],
        }
        agent_orchestrator._active_tasks[task_id] = True

        first_queue = agent_orchestrator.receive_user_message(task_id, "continue task")
        second_queue = agent_orchestrator.receive_user_message(task_id, " continue   task ")

        task = _tasks[task_id]
        self.assertIs(first_queue, second_queue)
        self.assertEqual(len([item for item in task["session_inputs"] if not item.get("promoted")]), 1)
        self.assertEqual(task["session_inputs"][0].get("merged_count"), 2)
        self.assertEqual(
            [event["type"] for event in task["events"] if event["type"].startswith("session_input")],
            ["session_input_admitted", "session_input_merged"],
        )


if __name__ == "__main__":
    unittest.main()
