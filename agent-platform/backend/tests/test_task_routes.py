import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from main import app
from api import tasks
from api import local_runner as local_runner_api
from api import projects as projects_api
from core import agent_orchestrator
from core.state import _tasks


class TaskRouteRegistrationTest(unittest.TestCase):
    def test_create_task_route_accepts_post(self):
        matching_routes = [
            route
            for route in app.routes
            if getattr(route, "path", None) == "/api/tasks"
            and "POST" in getattr(route, "methods", set())
        ]
        self.assertTrue(matching_routes, "POST /api/tasks must be registered")


class TaskChatContinuationTest(unittest.IsolatedAsyncioTestCase):
    def test_imported_project_context_init_does_not_route_natural_language(self):
        task = {
            "id": "task-local-context",
            "workspace_id": "ws-local-context",
            "events": [],
        }

        local_runner_api._initialize_imported_project_context(
            task,
            project_root=r"D:\Github\wx4py",
            cloud_snapshot_synced=False,
        )

        event_types = [e.get("type") for e in task.get("events", [])]
        self.assertIn("imported_project_context_initialized", event_types)
        self.assertNotIn("intent_routed", event_types)
        self.assertFalse(task["imported_project_context"]["cloud_snapshot_synced"])

    def test_route_persists_active_intent_route(self):
        task = {"id": "task-route-persist", "events": []}
        decision = {
            "intent": "code_development",
            "action": "continue_development",
            "target": "违禁词监控",
            "expected_artifacts": [{"path": "src/features/messaging/listener.py"}],
            "completion_checks": ["tests_pass"],
            "confidence": 0.91,
        }

        route = tasks._persist_active_intent_route(task, "加个 违禁词监控", decision, source="chat_controller")

        self.assertEqual(task["active_intent_route"], route)
        self.assertEqual(route["intent"], "code_development")
        self.assertEqual(route["target"], "违禁词监控")
        self.assertTrue(route["source_message_hash"])

    def test_reuse_retrieval_plan_preserves_read_files(self):
        task = {
            "id": "task-reuse-retrieval",
            "system_context_epoch": 3,
            "retrieval_plan": {
                "intent": "feature_change",
                "candidate_files": ["src/features/messaging/listener.py"],
                "index_docs": [".autocode/PROJECT_PROFILE.md"],
                "read_budget": 4,
                "system_context_epoch": 3,
            },
            "retrieval_guard": {
                "active": True,
                "candidate_files": ["old.py"],
                "index_docs": [],
                "read_budget": 2,
                "read_files": ["src/features/messaging/processor.py"],
            },
            "events": [],
        }

        reused = agent_orchestrator._reuse_retrieval_plan(task, source="test")

        self.assertIsNotNone(reused)
        self.assertEqual(task["retrieval_guard"]["candidate_files"], ["src/features/messaging/listener.py"])
        self.assertEqual(task["retrieval_guard"]["read_files"], ["src/features/messaging/processor.py"])
        self.assertTrue(any(e.get("type") == "retrieval_plan_reused" for e in task.get("events", [])))

    def test_file_creation_is_development_request_and_not_one_off_command(self):
        message = "请创建一个文件 README_NOTE.md，写入 hello"
        self.assertTrue(tasks._is_development_request(message))
        self.assertTrue(tasks._should_reroute_command_action_to_development(
            message,
            {"action": "run_command", "command": "echo hello > README_NOTE.md"},
        ))
        self.assertFalse(tasks._should_reroute_command_action_to_development(
            "运行命令: echo hello",
            {"action": "run_command", "command": "echo hello"},
        ))

    def test_development_request_detector_supports_chinese_feature_requests(self):
        self.assertTrue(tasks._is_development_request("请增加一个导出 CSV 的新功能"))
        self.assertTrue(tasks._is_development_request("支持按日期筛选并优化输出格式"))
        self.assertTrue(tasks._is_development_request("还是这样啊，效果不好"))
        self.assertFalse(tasks._is_development_request("我该如何使用"))

    def test_vague_continue_message_keeps_recent_user_feedback(self):
        task = {
            "logs": [
                {"level": "chat_user", "message": "还是这样啊，效果不好"},
                {"level": "chat_assistant", "message": "我会继续处理"},
            ]
        }
        message = tasks._build_chat_continuation_message(task, "继续修改当前项目")
        self.assertIn("继续修改当前项目", message)
        self.assertIn("还是这样啊，效果不好", message)
        self.assertIn("不要把这句话当成独立需求", message)

    async def test_completed_task_controller_continue_development(self):
        task_id = "task-chat-dev"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Excel 数据处理脚本",
            "status": "completed",
            "workspace_id": "ws-chat-dev",
            "logs": [],
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="请增加一个导出 CSV 的新功能")

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "continue_development",
                "confidence": 0.92,
                "answer": "我会基于当前工作区继续修改并验证。",
            })), patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                await tasks.chat_with_agent(task_id, payload, request)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "pending")
        self.assertTrue(task["needs_continuation"])
        self.assertIn("导出 CSV", task["chat_continuation_message"])
        self.assertEqual(task.get("active_intent_route", {}).get("source"), "chat_controller")
        self.assertTrue(any(
            e.get("type") == "intent_routed"
            and e.get("payload", {}).get("entrypoint") == "chat_controller"
            for e in task.get("events", [])
        ))
        enqueue.assert_called_once_with(task_id, "chat continue development")

    async def test_chat_continuation_updates_selected_model(self):
        task_id = "task-chat-model"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Imported project",
            "status": "completed",
            "workspace_id": "ws-chat-model",
            "logs": [],
            "events": [],
            "model": "old-model",
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="continue feature work", model="selected-model")

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "continue_development",
                "confidence": 0.92,
                "answer": "continuing",
            })), patch("api.tasks.task_queue.enqueue"), patch("api.tasks.save_task"):
                await tasks.chat_with_agent(task_id, payload, request)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["model"], "selected-model")
        self.assertTrue(any(
            e.get("type") == "task_model_updated"
            and e.get("payload", {}).get("old_model") == "old-model"
            and e.get("payload", {}).get("new_model") == "selected-model"
            for e in task.get("events", [])
        ))

    async def test_cloud_import_task_preserves_selected_model_for_planning(self):
        project_id = "project-model-import"
        task_id = f"task-import-{project_id}"
        old_restored = projects_api._projects_restored
        projects_api._projects_restored = True
        projects_api._projects[project_id] = {
            "id": project_id,
            "name": "Imported app",
            "status": "ready",
            "created_at": "2026-07-19T00:00:00",
        }
        request = SimpleNamespace(headers={"X-User-Id": "user-1"})
        payload = projects_api.RegisterProjectTaskRequest(
            enable_smart_planning=True,
            model="selected-model",
        )
        recon = {
            "project_kind": "fullstack",
            "complexity": "S1",
            "recommended_flow": "agentic",
            "should_generate_prototype": False,
            "likely_stack": ["python", "typescript"],
            "entrypoints": ["ui/index.tsx"],
            "commands": {},
            "plan_guidance": [],
        }
        fake_client = object()
        fake_plan = SimpleNamespace(model_dump=lambda: {"subtasks": []})

        try:
            with patch("api.projects.run_project_recon", return_value=recon), patch(
                "api.projects.git_manager.init"
            ), patch("api.projects.git_manager.auto_commit"), patch(
                "api.projects.git_manager.log", return_value=[]
            ), patch.object(
                projects_api.agent_orchestrator,
                "_ensure_client",
                new=AsyncMock(return_value=fake_client),
            ) as ensure_client, patch(
                "api.projects.plan_task",
                new=AsyncMock(return_value=fake_plan),
            ) as plan_task, patch("api.projects.save_task"):
                task = await projects_api.register_project_task(project_id, request, payload)
        finally:
            projects_api._projects_restored = old_restored
            projects_api._projects.pop(project_id, None)
            stored_task = _tasks.pop(task_id, None)

        self.assertEqual(task["model"], "selected-model")
        self.assertIsNotNone(stored_task)
        ensure_client.assert_awaited_once_with(requested_model="selected-model")
        self.assertEqual(plan_task.await_args.kwargs["llm_client"], fake_client)
        self.assertEqual(plan_task.await_args.kwargs["model"], "selected-model")
        self.assertTrue(any(e.get("type") == "task_model_selected" for e in task["events"]))

    async def test_local_import_task_preserves_selected_model(self):
        session = SimpleNamespace(
            connected=True,
            user_id="user-1",
            project_root=r"C:\repo",
            command_project_path=r"C:\repo",
            public_api_base="https://example.test",
            runner_version="1.0",
            device_id="device-1",
            device_name="desktop",
            device_os="windows",
            local_project_grant_id="",
        )
        request = SimpleNamespace(headers={"X-User-Id": "user-1"}, query_params={})
        payload = local_runner_api.LocalImportTaskRequest(
            title="Local app",
            project_path=r"C:\repo",
            model="selected-model",
        )

        with patch.object(local_runner_api.local_runner_manager, "get", return_value=session), patch.object(
            local_runner_api.local_runner_manager,
            "bind_session_to_task",
            new=AsyncMock(),
        ), patch.object(
            local_runner_api.local_project_grants,
            "upsert",
            return_value={"grant_id": "grant-1"},
        ), patch("api.local_runner._initialize_imported_project_context"), patch(
            "api.local_runner._status_payload_with_command", return_value={"connected": True}
        ), patch("api.local_runner.save_task"):
            task = await local_runner_api.register_local_import_task("session-1", payload, request)

        _tasks.pop(task["id"], None)
        self.assertEqual(task["model"], "selected-model")
        self.assertTrue(any(e.get("type") == "task_model_selected" for e in task["events"]))

    async def test_waiting_review_continue_confirms_review_instead_of_queueing_chat_continuation(self):
        task_id = "task-chat-review-confirm"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Artifact task",
            "status": "waiting_review_confirm",
            "workspace_id": "ws-chat-review-confirm",
            "logs": [],
            "events": [],
            "review": {"score": 72, "issues": [{"level": "warn", "message": "check output"}]},
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="继续")

        try:
            with patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                response = await tasks.chat_with_agent(task_id, payload, request)
                async for _chunk in response.body_iterator:
                    pass
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertTrue(task["review_confirmed"])
        self.assertEqual(task["status"], "running")
        self.assertFalse(task.get("needs_continuation", False))
        self.assertTrue(any(e.get("type") == "review_confirmation_resolved" for e in task.get("events", [])))
        self.assertFalse(any(e.get("type") == "chat_continuation_queued" for e in task.get("events", [])))
        enqueue.assert_called_once_with(task_id, "review confirmed by chat")

    async def test_unusable_controller_answer_falls_back_to_continuation(self):
        task_id = "task-chat-noop"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Excel data processor",
            "status": "completed",
            "workspace_id": "ws-chat-noop",
            "logs": [],
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="the output table feels cramped")

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "answer",
                "answer": "I received it. You can ask me to explain usage, open files, run tests, view Git Diff, or roll back snapshots.",
            })), patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                await tasks.chat_with_agent(task_id, payload, request)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "pending")
        self.assertTrue(task["needs_continuation"])
        self.assertIn("output table", task["chat_continuation_message"])
        enqueue.assert_called_once_with(task_id, "chat continue development")

    async def test_controller_run_command_for_file_creation_reroutes_to_continuation(self):
        task_id = "task-chat-command-reroute"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Local project",
            "status": "completed",
            "workspace_id": "ws-chat-command-reroute",
            "logs": [],
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="请创建一个文件 README_NOTE.md，写入 hello")

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "run_command",
                "confidence": 0.88,
                "command": "echo hello > README_NOTE.md",
                "answer": "",
            })), patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                await tasks.chat_with_agent(task_id, payload, request)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "pending")
        self.assertTrue(task["needs_continuation"])
        self.assertIn("README_NOTE.md", task["chat_continuation_message"])
        enqueue.assert_called_once_with(task_id, "chat continue development")

    def test_txt_file_request_routes_to_light_local_task(self):
        task = {"id": "task-light-route", "local_runner_session_id": "lr-test"}
        with patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
            "connected": True,
            "project_root": r"D:\Github",
        }):
            decision = tasks._coerce_chat_intent(
                "D盘当前目录下创建一个txt文件，内容是你好",
                task,
                {"action": "run_command", "command": "echo hello"},
            )

        self.assertEqual(decision["intent"], "light_local_file_task")
        self.assertEqual(decision["action"], "light_local_file_task")
        self.assertEqual(decision["content"], "你好")
        self.assertTrue(str(decision["path"]).endswith("你好.txt"))

    def test_txt_file_request_preserves_windows_verbatim_root(self):
        task = {"id": "task-light-verbatim", "local_runner_session_id": "lr-test"}
        with patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
            "connected": True,
            "project_root": r"\\?\D:\BaiduNetdiskDownload",
        }):
            decision = tasks._coerce_chat_intent(
                "创建一个 世界 txt文件 内容为世界",
                task,
                {"action": "run_command", "command": "echo 世界"},
            )

        self.assertEqual(decision["intent"], "light_local_file_task")
        self.assertEqual(decision["path"], "世界.txt")
        self.assertNotIn("/", decision["path"])

    async def test_light_local_file_task_completes_without_queueing_agent_loop(self):
        task_id = "task-light-local"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Local project",
            "status": "completed",
            "workspace_id": "ws-light-local",
            "logs": [],
            "local_execution_enabled": True,
            "local_runner_session_id": "lr-test",
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="D盘当前目录下创建一个txt文件，内容是你好")

        async def execute_tool(task_id_arg, tool_name, args, timeout=120):
            if tool_name == "local_write_text_file":
                return {
                    "ok": True,
                    "path": "你好.txt",
                    "absolute_path": r"D:\Github\你好.txt",
                    "content": "你好",
                    "encoding": "utf-8",
                    "size": 6,
                    "result": "[OK]",
                }
            if tool_name == "local_read_text_file":
                return {
                    "ok": True,
                    "path": "你好.txt",
                    "absolute_path": r"D:\Github\你好.txt",
                    "content": "你好",
                    "encoding": "utf-8",
                    "size": 6,
                    "result": "你好",
                }
            raise AssertionError(tool_name)

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "run_command",
                "intent": "run_command",
                "confidence": 0.9,
                "command": "echo 你好 > D:\\Github\\你好.txt",
            })), patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
                "connected": True,
                "project_root": r"D:\Github",
            }), patch("api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=execute_tool)), patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                response = await tasks.chat_with_agent(task_id, payload, request)
                async for _chunk in response.body_iterator:
                    pass
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["progress"], 100)
        self.assertFalse(task.get("needs_continuation"))
        self.assertEqual(task["current_step"], "轻量本地文件任务已完成")
        self.assertTrue(any(e.get("type") == "light_task_completed" for e in task.get("events", [])))
        self.assertFalse(any("/workspace/你好.txt" in str(e) for e in task.get("events", [])))
        enqueue.assert_not_called()

    async def test_light_local_file_task_falls_back_for_old_runner_tools(self):
        task_id = "task-light-local-fallback"
        task = {
            "id": task_id,
            "title": "Local project",
            "status": "completed",
            "workspace_id": "ws-light-local-fallback",
            "logs": [],
            "local_execution_enabled": True,
            "local_runner_session_id": "lr-test",
            "events": [],
        }
        calls = []

        async def execute_tool(task_id_arg, tool_name, args, timeout=120):
            calls.append(tool_name)
            if tool_name == "local_write_text_file":
                return {"ok": False, "result": "[LOCAL_RUNNER_ERROR] unsupported tool: local_write_text_file"}
            if tool_name == "write_file":
                return {"ok": True, "path": "世界.txt", "content": "世界", "result": "[OK]"}
            if tool_name == "read_file":
                return {"ok": True, "path": "世界.txt", "result": "世界"}
            raise AssertionError(tool_name)

        with patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
            "connected": True,
            "project_root": r"D:\Github",
        }), patch("api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=execute_tool)), patch("api.tasks.save_task"):
            async for _chunk in tasks._stream_light_local_file_task(
                task_id,
                task,
                "创建一个 世界 txt文件 内容为世界",
                {"path": r"D:\Github\世界.txt", "content": "世界", "encoding": "utf-8"},
            ):
                pass

        self.assertEqual(task["status"], "completed")
        self.assertEqual(calls, ["local_write_text_file", "write_file", "read_file"])
        self.assertTrue(any(e.get("type") == "local_runner_tool_fallback" for e in task.get("events", [])))

    async def test_light_local_file_failure_preserves_existing_task_status(self):
        task_id = "task-light-local-preserve-status"
        task = {
            "id": task_id,
            "title": "Excel 数据处理脚本",
            "status": "completed",
            "current_step": "任务完成",
            "workspace_id": "ws-light-local-preserve-status",
            "logs": [],
            "local_execution_enabled": True,
            "local_runner_session_id": "lr-test",
            "events": [],
        }

        with patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
            "connected": True,
            "project_root": r"D:\Github",
        }), patch("api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=RuntimeError("disk unavailable"))), patch("api.tasks.save_task"):
            async for _chunk in tasks._stream_light_local_file_task(
                task_id,
                task,
                "创建一个 世界 txt文件 内容为世界",
                {"path": r"D:\Github\世界.txt", "content": "世界", "encoding": "utf-8"},
            ):
                pass

        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["current_step"], "任务完成")
        self.assertFalse(task.get("needs_continuation"))
        self.assertTrue(any(e.get("type") == "light_task_failed" for e in task.get("events", [])))

    async def test_create_light_local_file_task_routes_without_agent_queue(self):
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.TaskCreate(
            title="创建本地文本文件",
            description="创建一个 世界 txt文件 内容为世界",
            project_type="imported",
            agent_types=["frontend"],
        )

        async def execute_tool(task_id_arg, tool_name, args, timeout=120):
            if tool_name == "local_write_text_file":
                return {
                    "ok": True,
                    "path": "世界.txt",
                    "absolute_path": r"D:\Github\世界.txt",
                    "content": "世界",
                    "encoding": "utf-8",
                    "size": 6,
                    "result": "[OK]",
                }
            if tool_name == "local_read_text_file":
                return {
                    "ok": True,
                    "path": "世界.txt",
                    "absolute_path": r"D:\Github\世界.txt",
                    "content": "世界",
                    "encoding": "utf-8",
                    "size": 6,
                    "result": "世界",
                }
            raise AssertionError(tool_name)

        task_id = ""
        try:
            with patch("api.tasks.harness_repository.start_trace", return_value="trace-create-light"), patch(
                "api.tasks._run_chat_controller",
                new=AsyncMock(return_value={
                    "action": "run_command",
                    "intent": "run_command",
                    "confidence": 0.9,
                    "command": "echo 世界 > 世界.txt",
                }),
            ), patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
                "connected": True,
                "project_root": r"D:\Github",
            }), patch("api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=execute_tool)), patch(
                "api.tasks.task_queue.enqueue"
            ) as enqueue, patch("api.tasks.save_task"):
                response = await tasks.create_task(payload, request)
                task_id = response.id
        finally:
            task = _tasks.pop(task_id, None) if task_id else None

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "completed")
        self.assertTrue(any(e.get("type") == "intent_routed" and e.get("payload", {}).get("entrypoint") == "task_create" for e in task.get("events", [])))
        self.assertTrue(any(e.get("type") == "light_task_completed" for e in task.get("events", [])))
        enqueue.assert_not_called()

    async def test_retry_light_local_file_task_routes_without_agent_queue(self):
        task_id = "task-retry-light-local"
        _tasks[task_id] = {
            "id": task_id,
            "title": "创建本地文本文件",
            "description": "创建一个 世界 txt文件 内容为世界",
            "project_type": "imported",
            "status": "failed",
            "created_at": "2026-01-01T00:00:00",
            "workspace_id": "ws-retry-light-local",
            "agents": ["frontend"],
            "logs": [],
            "commit_history": [],
            "preview_url": None,
            "plan": None,
            "current_subtask_id": None,
            "local_execution_enabled": True,
            "local_runner_session_id": "lr-test",
            "events": [],
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))

        async def execute_tool(task_id_arg, tool_name, args, timeout=120):
            if tool_name == "local_write_text_file":
                return {"ok": True, "path": "世界.txt", "absolute_path": r"D:\Github\世界.txt", "content": "世界", "result": "[OK]"}
            if tool_name == "local_read_text_file":
                return {"ok": True, "path": "世界.txt", "absolute_path": r"D:\Github\世界.txt", "content": "世界", "result": "世界"}
            raise AssertionError(tool_name)

        try:
            with patch("api.tasks._run_chat_controller", new=AsyncMock(return_value={
                "action": "continue_development",
                "intent": "code_development",
                "confidence": 0.82,
            })), patch("api.tasks.local_runner_manager.status_for_task_or_session", return_value={
                "connected": True,
                "project_root": r"D:\Github",
            }), patch("api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=execute_tool)), patch(
                "api.tasks.task_queue.enqueue"
            ) as enqueue, patch("api.tasks.save_task"):
                response = await tasks.retry_task(task_id, request)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(response.status.value if hasattr(response.status, "value") else response.status, "completed")
        self.assertTrue(any(e.get("type") == "intent_routed" and e.get("payload", {}).get("entrypoint") == "task_retry" for e in task.get("events", [])))
        self.assertTrue(any(e.get("type") == "light_task_completed" for e in task.get("events", [])))
        enqueue.assert_not_called()


    async def test_waiting_user_input_reply_clears_pending_state_and_requeues(self):
        task_id = "task-waiting-user-input"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Forbidden words UI",
            "description": "Add forbidden words monitoring UI",
            "project_type": "imported",
            "status": "waiting_user_input",
            "workspace_id": "ws-waiting-user-input",
            "logs": [],
            "events": [],
            "pending_user_input": {
                "event_id": "evt-user-input",
                "signature": "sig-user-input",
                "question": "请选择目标页面",
                "options": [{"label": "允许新建管理页", "message": "允许新建管理页"}],
            },
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="允许新建管理页")

        try:
            with patch("api.tasks._route_task_entry_intent", new=AsyncMock(return_value={
                "action": "continue_development",
                "intent": "code_development",
                "answer": "已收到选择，继续开发。",
            })), patch(
                "api.tasks.agent_orchestrator.receive_user_message",
                return_value=None,
            ), patch("api.tasks.task_queue.enqueue", return_value=True) as enqueue, patch("api.tasks.save_task"):
                response = await tasks.chat_with_agent(task_id, payload, request)
                async for _chunk in response.body_iterator:
                    pass
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "pending")
        self.assertTrue(task["needs_continuation"])
        self.assertNotIn("pending_user_input", task)
        resolved = [event for event in task["events"] if event.get("type") == "user_input_resolved"]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["payload"]["event_id"], "evt-user-input")
        self.assertEqual(resolved[0]["payload"]["message"], "允许新建管理页")
        enqueue.assert_called_once_with(task_id, "chat continue development")

    async def test_task_status_stream_includes_pending_user_input(self):
        task_id = "task-waiting-user-input-stream"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Waiting for source entry",
            "status": "waiting_user_input",
            "progress": 25,
            "workspace_id": "ws-waiting-user-input-stream",
            "logs": [],
            "events": [],
            "pending_user_input": {
                "event_id": "evt-user-input-stream",
                "question": "请选择目标页面",
                "options": [{"label": "允许新建管理页", "message": "允许新建管理页"}],
                "allow_free_text": True,
            },
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))

        try:
            with patch("api.tasks.asyncio.sleep", new=AsyncMock(return_value=None)):
                response = await tasks.stream_task_events(task_id, request)
                iterator = response.body_iterator
                chunk = await iterator.__anext__()
                await iterator.aclose()
        finally:
            _tasks.pop(task_id, None)

        text = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        self.assertIn('"status": "waiting_user_input"', text)
        self.assertIn('"pending_user_input": {', text)
        self.assertIn('"event_id": "evt-user-input-stream"', text)

    async def test_waiting_user_input_pause_does_not_requeue(self):
        task_id = "task-waiting-user-input-pause"
        _tasks[task_id] = {
            "id": task_id,
            "title": "Paused blocker",
            "status": "waiting_user_input",
            "workspace_id": "ws-waiting-user-input-pause",
            "logs": [],
            "events": [],
            "pending_user_input": {
                "event_id": "evt-user-input-pause",
                "signature": "sig-user-input-pause",
                "question": "请选择目标页面",
            },
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="先暂停")

        try:
            with patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                response = await tasks.chat_with_agent(task_id, payload, request)
                async for _chunk in response.body_iterator:
                    pass
        finally:
            task = _tasks.pop(task_id, None)

        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "stopped")
        self.assertNotIn("pending_user_input", task)
        self.assertTrue(any(event.get("type") == "user_input_resolved" for event in task["events"]))
        enqueue.assert_not_called()


if __name__ == "__main__":
    unittest.main()
