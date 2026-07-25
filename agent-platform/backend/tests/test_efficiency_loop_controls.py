import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from api import tasks as task_routes
from core.agent_orchestrator import (
    AgentOrchestrator,
    AgentWaitingForUserInput,
    _auto_decision_for_soft_blocker,
    _assistant_content_promises_edit_without_tool,
    _assistant_content_requests_blocking_input,
    _open_blocking_input_request,
    _consume_role_write_grant,
    _grant_role_write_once,
    _absolute_iteration_cap,
    _apply_progress_watchdog,
    _generated_artifact_read_block,
    _is_hard_blocking_input,
    _is_read_only_bash,
    _is_soft_entry_blocker,
    _meaningful_changed_file_list,
    _normalize_role_write_path,
    _progress_watchdog_signature,
    _read_lines_result,
    _role_can_write_path,
    _safe_workspace_path,
    _surface_map_candidates_for_task,
    _should_auto_grant_local_role_write,
    _fast_edit_read_block,
    _tool_result_indicates_write_success,
    _unrestricted_dev_mode,
)
from core.review_agent import ReviewAgent
from core.state import _tasks
from core.workspace_index import is_actionable_development_request
from services import task_queue as task_queue_module


class ReadLinesToolTests(unittest.TestCase):
    def test_read_lines_returns_numbered_range_and_caps_span(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            target = ws / "src" / "big.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("\n".join(f"line {idx}" for idx in range(1, 301)), encoding="utf-8")

            path = _safe_workspace_path(ws, "src/big.html", must_exist=True)
            snippet = _read_lines_result(path, "src/big.html", 10, 12)
            capped = _read_lines_result(path, "src/big.html", 1, 500)

        self.assertIn("[OK] src/big.html lines 10-12 of 300", snippet)
        self.assertIn(" 10 | line 10", snippet)
        self.assertNotIn(" 13 | line 13", snippet)
        self.assertIn("[OK] src/big.html lines 1-240 of 300", capped)
        self.assertNotIn("241 | line 241", capped)

    def test_safe_workspace_path_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(PermissionError):
                _safe_workspace_path(Path(tmp), "../outside.txt", must_exist=False)


class RoleWriteGrantTests(unittest.TestCase):
    def test_role_write_grant_is_multi_use_and_path_scoped(self):
        task = {}

        _grant_role_write_once(task, "backend", "./docs/index.html")

        self.assertEqual(_normalize_role_write_path("/workspace/./docs/index.html"), "docs/index.html")
        self.assertTrue(_consume_role_write_grant(task, "backend", "docs/index.html"))
        self.assertTrue(_consume_role_write_grant(task, "backend", "/workspace/docs/index.html"))
        self.assertFalse(_consume_role_write_grant(task, "frontend", "docs/index.html"))

    def test_unrestricted_mode_disables_role_ownership_for_source_files(self):
        old_mode = os.environ.get("AUTOCODE_UNRESTRICTED_DEV_MODE")
        old_disable = os.environ.get("AUTOCODE_DISABLE_ROLE_OWNERSHIP")
        os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = "true"
        os.environ.pop("AUTOCODE_DISABLE_ROLE_OWNERSHIP", None)
        try:
            allowed, reason = _role_can_write_path("frontend", "src/features/groups.py")
        finally:
            if old_mode is None:
                os.environ.pop("AUTOCODE_UNRESTRICTED_DEV_MODE", None)
            else:
                os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = old_mode
            if old_disable is None:
                os.environ.pop("AUTOCODE_DISABLE_ROLE_OWNERSHIP", None)
            else:
                os.environ["AUTOCODE_DISABLE_ROLE_OWNERSHIP"] = old_disable

        self.assertTrue(allowed)
        self.assertEqual(reason, "")


class ConfirmationFallbackTests(unittest.TestCase):
    def test_waiting_confirmation_without_event_creates_fallback_approval_event(self):
        task = {
            "id": "task-fallback-approval",
            "status": "waiting_confirm",
            "events": [],
            "pending_confirmation": {
                "kind": "manual_write_grant",
                "action": "cross_boundary_write",
                "reason": "Approve docs/index.html write",
                "payload": {"path": "docs/index.html"},
            },
        }

        event = task_routes._ensure_waiting_confirm_approval_event(task, "fallback-confirm-task-fallback-approval")

        self.assertIsNotNone(event)
        self.assertEqual(event["type"], "approval_requested")
        self.assertEqual(event["id"], "fallback-confirm-task-fallback-approval")
        self.assertEqual(task["pending_confirmation"]["event_id"], "fallback-confirm-task-fallback-approval")
        self.assertTrue(task["pending_confirmation"]["manual_required"])


class ProgressWatchdogTests(unittest.TestCase):
    def setUp(self):
        self._old_env = {
            "AUTOCODE_ABSOLUTE_ITERATION_CAP": os.environ.get("AUTOCODE_ABSOLUTE_ITERATION_CAP"),
            "AUTOCODE_NO_PROGRESS_ITERATIONS": os.environ.get("AUTOCODE_NO_PROGRESS_ITERATIONS"),
            "AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE": os.environ.get("AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE"),
            "AUTOCODE_DUPLICATE_DISCOVERY_LIMIT": os.environ.get("AUTOCODE_DUPLICATE_DISCOVERY_LIMIT"),
            "AUTOCODE_UNRESTRICTED_DEV_MODE": os.environ.get("AUTOCODE_UNRESTRICTED_DEV_MODE"),
        }
        for key in self._old_env:
            os.environ.pop(key, None)
        os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = "false"

    def tearDown(self):
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_absolute_iteration_cap_defaults_to_long_running_limit(self):
        self.assertEqual(_absolute_iteration_cap(), 10000)

    def test_progress_signature_changes_for_writes_validation_and_messages(self):
        task = {"retrieval_guard": {"candidate_files": ["src/app.py"]}}

        base = _progress_watchdog_signature(task, changed_files=[], written_files=[])
        wrote = _progress_watchdog_signature(task, changed_files=["src/app.py"], written_files=["src/app.py"])
        validated = _progress_watchdog_signature(
            task,
            changed_files=["src/app.py"],
            written_files=["src/app.py"],
            validation_command="python -m pytest",
            validation_exit_code=0,
            validation_output="1 passed",
        )
        message = _progress_watchdog_signature(task, pending_user_messages=1)

        self.assertNotEqual(base, wrote)
        self.assertNotEqual(wrote, validated)
        self.assertNotEqual(base, message)

    def test_watchdog_forces_transition_then_pauses_without_progress(self):
        os.environ["AUTOCODE_NO_PROGRESS_ITERATIONS"] = "2"
        os.environ["AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE"] = "1"
        task = {}
        signature = {"changed_files": [], "written_files": [], "validation": ""}

        first = _apply_progress_watchdog(task, signature, iteration=1, agent_type="backend")
        second = _apply_progress_watchdog(task, signature, iteration=2, agent_type="backend")
        third = _apply_progress_watchdog(task, signature, iteration=3, agent_type="backend")
        fourth = _apply_progress_watchdog(task, signature, iteration=4, agent_type="backend")

        self.assertTrue(first["made_progress"])
        self.assertFalse(first["force_transition"])
        self.assertFalse(second["force_transition"])
        self.assertTrue(third["force_transition"])
        self.assertFalse(third["stop"])
        self.assertTrue(fourth["stop"])
        self.assertEqual(task["progress_watchdog"]["stop_reason"], "blocked_by_no_progress")

    def test_forced_transition_allows_one_new_discovery_before_pause(self):
        os.environ["AUTOCODE_NO_PROGRESS_ITERATIONS"] = "2"
        os.environ["AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE"] = "1"
        task = {}
        signature = {"changed_files": [], "written_files": [], "validation": ""}

        _apply_progress_watchdog(task, signature, iteration=1, agent_type="backend")
        _apply_progress_watchdog(task, signature, iteration=2, agent_type="backend")
        forced = _apply_progress_watchdog(task, signature, iteration=3, agent_type="backend")
        discovery = _apply_progress_watchdog(
            task,
            signature,
            iteration=4,
            agent_type="backend",
            discovery_progress=True,
        )
        stalled = _apply_progress_watchdog(task, signature, iteration=5, agent_type="backend")

        self.assertTrue(forced["force_transition"])
        self.assertTrue(discovery["made_progress"])
        self.assertFalse(discovery["stop"])
        self.assertTrue(stalled["stop"])

    def test_duplicate_discovery_forces_transition_immediately(self):
        task = {}
        signature = {"changed_files": [], "written_files": [], "validation": ""}

        result = _apply_progress_watchdog(
            task,
            signature,
            iteration=1,
            agent_type="backend",
            duplicate_discovery=True,
        )

        self.assertTrue(result["force_transition"])
        self.assertEqual(task["progress_watchdog"]["forced_transition_count"], 1)

    def test_unrestricted_mode_watchdog_does_not_pause(self):
        os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = "true"
        os.environ["AUTOCODE_NO_PROGRESS_ITERATIONS"] = "1"
        os.environ["AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE"] = "1"
        task = {}
        signature = {"changed_files": [], "written_files": [], "validation": ""}

        _apply_progress_watchdog(task, signature, iteration=1, agent_type="backend")
        forced = _apply_progress_watchdog(task, signature, iteration=2, agent_type="backend")
        stalled = _apply_progress_watchdog(task, signature, iteration=3, agent_type="backend")

        self.assertTrue(_unrestricted_dev_mode(task))
        self.assertTrue(forced["force_transition"])
        self.assertFalse(stalled["stop"])

    def test_chinese_feature_request_is_actionable(self):
        message = (
            "\u524d\u540e\u7aef\u65b0\u529f\u80fd "
            "\u7fa4\u7ec4\u8fdd\u7981\u8bcd\u76d1\u6d4b "
            "\u8fdd\u7981\u53d1\u8a00\u7acb\u5373\u8b66\u544a\u5e76\u79fb\u9664\u7fa4\u7ec4"
        )

        self.assertTrue(is_actionable_development_request(message))

    def test_auxiliary_spec_change_is_not_meaningful_development_change(self):
        self.assertEqual(_meaningful_changed_file_list(["SPEC.md", ".autocode/MEMORY.md"]), [])
        self.assertEqual(_meaningful_changed_file_list(["SPEC.md", "src/app.py"]), ["src/app.py"])

    def test_local_ok_write_result_counts_as_success(self):
        self.assertTrue(_tool_result_indicates_write_success("[LOCAL] [OK] file patched: ui/config_store.py"))
        self.assertTrue(_tool_result_indicates_write_success("[OK] 已编辑 ui/config_store.py"))
        self.assertFalse(_tool_result_indicates_write_success("[LOCAL] search text was not found [exit_code=1]"))

    def test_promised_edit_without_tool_is_detected(self):
        self.assertTrue(_assistant_content_promises_edit_without_tool("现在开始修改 ui/config_store.py 和 index.html。"))
        self.assertTrue(_assistant_content_promises_edit_without_tool("I'll update src/app.py next."))
        self.assertFalse(_assistant_content_promises_edit_without_tool("已完成修改。"))

    def test_read_only_bash_probe_with_stderr_redirect_is_safe(self):
        self.assertTrue(_is_read_only_bash('dir /b "\\\\?\\D:\\myResource\\05\\wx4py" 2>nul || echo "empty"'))
        self.assertTrue(_is_read_only_bash("dir /b /s 2>nul | head -100"))

    def test_local_role_write_auto_grant_is_scoped_to_source_paths(self):
        task = {"local_execution_enabled": True}

        self.assertTrue(_should_auto_grant_local_role_write(task, "./ui/config_store.py"))
        self.assertFalse(_should_auto_grant_local_role_write(task, ".autocode/MEMORY.md"))
        self.assertFalse(_should_auto_grant_local_role_write(task, "dist/app.py"))

    def test_generated_artifact_read_is_suppressed_when_source_candidates_exist(self):
        task = {"retrieval_guard": {"candidate_files": ["ui/config_store.py", "ui/gui_app.py"]}}

        result = _generated_artifact_read_block(task, "dist (2)/dist/wx4py/_internal/ui/config_store.py")

        self.assertIn("[GENERATED_ARTIFACT_SUPPRESSED]", result)
        self.assertIn("ui/config_store.py", result)

    def test_fast_edit_mode_suppresses_non_candidate_discovery_after_read_limit(self):
        os.environ["AUTOCODE_UNRESTRICTED_DEV_MODE"] = "true"
        task = {
            "retrieval_guard": {
                "candidate_files": ["ui/web_app.py", "ui/templates/index.html"],
                "read_files": ["a.py", "b.py", "c.py", "d.py", "e.py"],
            }
        }

        result = _fast_edit_read_block(task, "read_file", "src/unrelated.py")

        self.assertIn("[FAST_EDIT_MODE_ENTERED]", result)
        self.assertIn("ui/web_app.py", result)


class StructuredUserInputTests(unittest.TestCase):
    def test_concrete_source_entry_blocker_is_soft_blocker(self):
        message = (
            "当前阻塞：还没有拿到实际前端源码入口，无法继续。"
            "请直接回复目标页面或组件路径，或者允许我新建管理页。"
        )

        self.assertTrue(_assistant_content_requests_blocking_input(message))
        self.assertTrue(_is_soft_entry_blocker(message))
        self.assertFalse(_is_hard_blocking_input(message))
        self.assertFalse(_assistant_content_requests_blocking_input("已经完成修改并通过测试。"))

    def test_credential_blocker_stays_hard_blocker(self):
        message = "当前阻塞：缺少生产账号登录验证码和 API 密钥，不能安全继续。"

        self.assertTrue(_assistant_content_requests_blocking_input(message))
        self.assertTrue(_is_hard_blocking_input(message))
        self.assertFalse(_is_soft_entry_blocker(message))

    def test_soft_blocker_auto_decision_records_event_without_waiting(self):
        task = {"id": "task-auto-decision", "events": [], "autonomy_mode": "strong"}
        content = (
            "具体阻塞点：没有找到实际前端源码入口，无法继续。"
            "请选择群组列表页、群组详情页、审核/风控页、后台管理页，"
            "或者允许我新建管理页。"
        )

        prompt = _auto_decision_for_soft_blocker(
            task,
            task_id=task["id"],
            agent_type="frontend",
            iteration=3,
            content=content,
        )

        self.assertIn("[AGENT_AUTO_DECISION]", prompt)
        self.assertEqual(task["status"] if "status" in task else None, None)
        self.assertNotIn("pending_user_input", task)
        self.assertEqual([event["type"] for event in task["events"]], ["agent_auto_decision"])
        self.assertEqual(task["interventions"][0]["type"], "soft_blocker")
        self.assertTrue(task["interventions"][0]["auto_resolved"])

    def test_open_blocking_input_request_is_structured_and_deduplicated(self):
        task = {"id": "task-user-input", "events": []}
        content = (
            "具体阻塞点：缺少生产账号登录验证码和 API 密钥，不能安全继续。"
            "请提供测试凭证，或明确改用离线 mock。"
        )

        opened = _open_blocking_input_request(
            task,
            task_id=task["id"],
            agent_type="frontend",
            iteration=3,
            content=content,
        )
        duplicate = _open_blocking_input_request(
            task,
            task_id=task["id"],
            agent_type="frontend",
            iteration=4,
            content=content,
        )

        self.assertTrue(opened)
        self.assertFalse(duplicate)
        self.assertEqual(task["status"], "waiting_user_input")
        self.assertFalse(task["execution_active"])
        self.assertFalse(task["needs_continuation"])
        self.assertEqual(
            [event["type"] for event in task["events"]],
            ["intervention_opened", "user_input_requested"],
        )
        self.assertEqual(task["pending_user_input"]["intervention"]["type"], "hard_blocker")
        labels = [option["label"] for option in task["pending_user_input"]["options"]]
        self.assertEqual(labels[0], "继续并自行决定")
        self.assertTrue(task["pending_user_input"]["allow_free_text"])


class WaitingUserInputExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_outer_execute_task_pauses_without_review_or_completion(self):
        task_id = "task-user-input-outer"
        workspace_id = "ws-user-input-outer"
        content = (
            "当前阻塞：缺少外部账号登录验证码和 API 密钥，不能安全继续。"
            "请提供测试凭证，或者明确改用 mock。"
        )
        task = {
            "id": task_id,
            "title": "Forbidden words UI",
            "description": "Add forbidden words monitoring UI",
            "project_type": "imported",
            "status": "pending",
            "progress": 0,
            "workspace_id": workspace_id,
            "logs": [],
            "events": [],
            "execution_active": False,
            "needs_continuation": True,
            "chat_continuation_message": "增加违禁词监测和群组移除界面功能",
        }
        _tasks[task_id] = task
        orchestrator = AgentOrchestrator()

        async def pause_agentic_loop(**_kwargs):
            _open_blocking_input_request(
                task,
                task_id=task_id,
                agent_type="frontend",
                iteration=1,
                content=content,
            )
            raise AgentWaitingForUserInput(content)

        try:
            with tempfile.TemporaryDirectory() as tmp:
                old_workspace_base = orchestrator._settings.workspace_base_dir
                orchestrator._settings.workspace_base_dir = Path(tmp)
                (Path(tmp) / workspace_id).mkdir(parents=True, exist_ok=True)
                try:
                    with patch.object(orchestrator, "_ensure_client", new=AsyncMock(return_value=object())), patch.object(
                        orchestrator, "_run_agentic_loop", new=AsyncMock(side_effect=pause_agentic_loop)
                    ), patch.object(
                        orchestrator, "_review_execution_group", new=AsyncMock(return_value=True)
                    ) as review, patch.object(
                        orchestrator, "_persist_task"
                    ), patch.object(
                        orchestrator, "_init_workspace_memory"
                    ), patch(
                        "core.agent_orchestrator._should_use_agentic_execution", return_value=True
                    ), patch(
                        "core.agent_orchestrator.docker_manager.create_workspace", new=AsyncMock(return_value=None)
                    ), patch(
                        "core.agent_orchestrator.git_manager.init"
                    ), patch(
                        "core.agent_orchestrator.terminal_manager.start_session"
                    ), patch(
                        "core.agent_orchestrator.harness_repository.start_trace", return_value=1
                    ), patch(
                        "core.agent_orchestrator.harness_repository.add_event"
                    ), patch(
                        "core.agent_orchestrator.harness_repository.complete_trace"
                    ), patch(
                        "core.agent_orchestrator.harness_repository.fail_trace"
                    ):
                        await orchestrator.execute_task(
                            task_id,
                            task["description"],
                            task["project_type"],
                            workspace_id,
                            ["frontend"],
                        )
                finally:
                    orchestrator._settings.workspace_base_dir = old_workspace_base
        finally:
            final_task = _tasks.pop(task_id, None)

        self.assertIsNotNone(final_task)
        self.assertEqual(final_task["status"], "waiting_user_input")
        self.assertFalse(final_task["execution_active"])
        self.assertFalse(final_task["needs_continuation"])
        self.assertIn("pending_user_input", final_task)
        self.assertFalse(any(event.get("type") == "task_completed_summary" for event in final_task["events"]))
        review.assert_not_awaited()


class ModelSelectionToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_prototype_uses_task_selected_model(self):
        task_id = "task-prototype-selected-model"
        task = {
            "id": task_id,
            "workspace_id": "workspace-model-test",
            "model": "selected-model",
            "events": [],
        }
        _tasks[task_id] = task
        orchestrator = AgentOrchestrator()
        fake_client = object()
        orchestrator._ensure_client = AsyncMock(return_value=fake_client)

        try:
            with tempfile.TemporaryDirectory() as tmp, patch(
                "core.prototype_generator.generate_prototype",
                new=AsyncMock(return_value={
                    "html": "<html>ok</html>",
                    "title": "Model test",
                    "features": [],
                }),
            ) as generate, patch(
                "core.prototype_generator.save_prototype",
                return_value=Path(tmp) / "prototype.html",
            ):
                result = await orchestrator._execute_tool(
                    "generate_prototype",
                    {"description": "build a settings page"},
                    "workspace-model-test",
                    Path(tmp),
                    task_id,
                    lambda *_args, **_kwargs: None,
                    "frontend",
                )
        finally:
            _tasks.pop(task_id, None)

        self.assertIn("[OK]", result)
        orchestrator._ensure_client.assert_awaited_once_with(requested_model="selected-model")
        generate.assert_awaited_once_with("build a settings page", llm_client=fake_client)


class ArtifactReviewGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_code_development_without_changed_files_fails_artifact_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "src").mkdir(parents=True, exist_ok=True)
            (ws / "src" / "app.py").write_text("print('hello')\n", encoding="utf-8")
            reviewer = ReviewAgent(llm_client=None)

            result = await reviewer.run(
                ws_path=ws,
                task_id="task-review-no-code-changes",
                task_title="implement feature",
                project_type="python",
                log=lambda *_args, **_kwargs: None,
                execution_plan={"intent": "code_development", "artifact_contracts": []},
                capability_profile={"artifact_source": "workspace", "workspace_sync_status": "workspace"},
                changed_files=[],
                artifact_sources={},
            )

        self.assertFalse(result.passed)
        self.assertTrue(any(issue["rule"] == "artifact/no-code-changes" for issue in result.issues))


class SurfaceMapGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_surface_map_hit_suppresses_broad_glob(self):
        task_id = "task-surface-glob-guard"
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            autocode = ws / ".autocode"
            autocode.mkdir(parents=True, exist_ok=True)
            (ws / "ui").mkdir(parents=True, exist_ok=True)
            (ws / "ui" / "web_app.py").write_text("print('gui')\n", encoding="utf-8")
            (autocode / "PROJECT_PROFILE.json").write_text(
                json.dumps({"surface_map": {"app_gui": ["ui/web_app.py"]}}),
                encoding="utf-8",
            )
            task = {
                "id": task_id,
                "title": "GUI page does not show the new feature",
                "events": [],
                "retrieval_guard": {"active": True, "candidate_files": [], "read_files": []},
            }
            _tasks[task_id] = task
            try:
                candidates = _surface_map_candidates_for_task(ws, task)
                result = await AgentOrchestrator()._execute_tool(
                    "glob",
                    {"pattern": "**/*"},
                    "workspace-test",
                    ws,
                    task_id,
                    lambda *_args, **_kwargs: None,
                    "backend",
                )
            finally:
                _tasks.pop(task_id, None)

        self.assertEqual(candidates, ["ui/web_app.py"])
        self.assertIn("[BROAD_GLOB_SUPPRESSED]", result)
        self.assertIn("ui/web_app.py", result)


class AutoContinuationQueueTests(unittest.TestCase):
    def test_no_change_retry_auto_continues_without_manual_stall_gate(self):
        task_id = "task-no-change-auto-continue"
        task = {
            "id": task_id,
            "status": "running",
            "agent_iteration_limited": True,
            "needs_continuation": True,
            "agent_iteration_limit_reason": "agentic_no_change_retry",
            "auto_continuation_count": 7,
            "stalled_continuation_count": 99,
            "total_agent_iterations": 20,
            "last_chat_continuation_message": "implement forbidden words UI",
            "retrieval_guard": {
                "candidate_files": ["ui/templates/index.html", "ui/web_app.py"],
                "read_files": ["ui/templates/index.html"],
            },
        }
        old_save = task_queue_module.save_task
        task_queue_module.save_task = lambda _task: None
        _tasks[task_id] = task
        try:
            queued = task_queue_module.TaskQueue()._prepare_auto_continuation(task_id)
        finally:
            task_queue_module.save_task = old_save
            _tasks.pop(task_id, None)

        self.assertTrue(queued)
        self.assertEqual(task["status"], "pending")
        self.assertNotEqual(task.get("status"), "waiting_confirm")
        self.assertIn("[AUTO_CONTINUATION_NO_CHANGE]", task.get("chat_continuation_message") or "")
        self.assertIn("ui/templates/index.html", task.get("chat_continuation_message") or "")


if __name__ == "__main__":
    unittest.main()
