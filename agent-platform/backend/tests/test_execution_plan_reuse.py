import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from api import tasks
from core import agent_orchestrator
from core.state import _tasks
from services.task_queue import task_queue


class ExecutionPlanReuseTest(unittest.IsolatedAsyncioTestCase):
    async def test_retry_reuses_existing_plan_without_ai_reroute(self):
        task_id = "task-retry-plan-reuse"
        _tasks[task_id] = {
            "id": task_id,
            "title": "创建本地文本文件",
            "description": "创建世界.txt，内容为世界",
            "project_type": "unknown",
            "status": "failed",
            "created_at": "2026-01-01T00:00:00",
            "workspace_id": "ws-retry-plan-reuse",
            "agents": ["general"],
            "logs": [],
            "events": [],
            "commit_history": [],
            "preview_url": None,
            "local_execution_enabled": True,
            "local_runner_session_id": "lr-reuse",
            "active_intent_route": {
                "intent": "light_local_file_task",
                "action": "light_local_file_task",
                "source_message_hash": "abc123",
            },
            "active_execution_plan": {
                "intent": "light_local_file_task",
                "action": "light_local_file_task",
                "task_family": "本地文本文件创建",
                "target": "世界.txt",
                "artifact_contracts": [{
                    "path": "世界.txt",
                    "kind": "text",
                    "content": "世界",
                    "encoding": "utf-8",
                }],
                "completion_checks": ["文件存在", "内容匹配"],
            },
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))

        async def execute_tool(_task_id, tool_name, args, timeout=120):
            if tool_name == "local_write_text_file":
                return {"ok": True, "absolute_path": r"D:\Github\世界.txt", "content": args["content"]}
            if tool_name == "local_read_text_file":
                return {"ok": True, "absolute_path": r"D:\Github\世界.txt", "content": "世界"}
            raise AssertionError(tool_name)

        router = AsyncMock(side_effect=AssertionError("retry must not reroute an existing plan"))
        try:
            with patch("api.tasks._run_chat_controller", new=router), patch(
                "api.tasks.local_runner_manager.status_for_task_or_session",
                return_value={"connected": True, "project_root": r"D:\Github"},
            ), patch(
                "api.tasks.local_runner_manager.execute_tool", new=AsyncMock(side_effect=execute_tool)
            ), patch("api.tasks.task_queue.enqueue") as enqueue, patch("api.tasks.save_task"):
                response = await tasks.retry_task(task_id, request)
        finally:
            task = _tasks.pop(task_id, None)

        router.assert_not_awaited()
        enqueue.assert_not_called()
        self.assertEqual(task["status"], "completed")
        self.assertEqual(response.status.value if hasattr(response.status, "value") else response.status, "completed")
        self.assertTrue(any(event.get("type") == "execution_plan_reused" for event in task["events"]))
        self.assertTrue(any(
            event.get("type") == "intent_routed"
            and event.get("payload", {}).get("entrypoint") == "task_retry"
            and event.get("payload", {}).get("reused") is True
            for event in task["events"]
        ))

    async def test_manual_continue_reuses_existing_plan_without_ai_reroute(self):
        task_id = "task-manual-continue-plan-reuse"
        _tasks[task_id] = {
            "id": task_id,
            "title": "继续开发",
            "description": "实现消息监控",
            "status": "completed",
            "workspace_id": "ws-manual-continue-plan-reuse",
            "logs": [],
            "events": [],
            "active_intent_route": {
                "intent": "code_development",
                "action": "continue_development",
                "source_message_hash": "def456",
            },
            "active_execution_plan": {
                "intent": "code_development",
                "action": "continue_development",
                "task_family": "Python service development",
                "target": "消息监控",
                "artifact_contracts": [{"path": "src/listener.py", "kind": "code"}],
            },
        }
        request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
        payload = tasks.ChatMessageRequest(message="继续")
        router = AsyncMock(side_effect=AssertionError("manual continue must reuse the persisted plan"))

        try:
            with patch("api.tasks._run_chat_controller", new=router), patch(
                "api.tasks.agent_orchestrator.receive_user_message", return_value=None
            ), patch("api.tasks.task_queue.enqueue", return_value=True) as enqueue, patch("api.tasks.save_task"):
                await tasks.chat_with_agent(task_id, payload, request)
        finally:
            task = _tasks.pop(task_id, None)

        router.assert_not_awaited()
        enqueue.assert_called_once_with(task_id, "chat continue development")
        self.assertTrue(any(
            event.get("type") == "execution_plan_reused"
            and event.get("payload", {}).get("entrypoint") == "chat_continue"
            for event in task["events"]
        ))

    def test_auto_continuation_records_plan_reuse(self):
        task_id = "task-auto-continuation-plan-reuse"
        _tasks[task_id] = {
            "id": task_id,
            "status": "running",
            "agent_iteration_limited": True,
            "agent_iteration": 10,
            "total_agent_iterations": 10,
            "events": [],
            "logs": [],
            "active_execution_plan": {
                "intent": "artifact_creation",
                "task_family": "spreadsheet processing",
                "artifact_contracts": [{"path": "result.xlsx"}],
            },
            "active_intent_route": {"action": "continue_development"},
        }
        try:
            with patch("services.task_queue.save_task"):
                prepared = task_queue._prepare_auto_continuation(task_id)
        finally:
            task = _tasks.pop(task_id, None)

        self.assertTrue(prepared)
        self.assertEqual(task["status"], "pending")
        self.assertTrue(any(
            event.get("type") == "execution_plan_reused"
            and event.get("payload", {}).get("entrypoint") == "auto_continuation"
            for event in task["events"]
        ))

    def test_context_compaction_state_preserves_route_plan_and_read_files(self):
        snapshot = {
            "active_intent_route": {"intent": "code_development", "target": "listener"},
            "active_execution_plan": {"intent": "code_development", "target": "src/listener.py"},
            "retrieval_guard": {
                "candidate_files": ["src/listener.py"],
                "read_budget": 4,
                "read_files": ["src/listener.py", "src/processor.py"],
            },
            "last_agent_result": {"changed_files": ["src/listener.py"]},
            "command_history": [{"command": "pytest", "status": "failed"}],
            "current_step": "修复失败测试",
            "system_context_epoch": 7,
        }

        state = agent_orchestrator._build_compact_context_state(snapshot)

        self.assertEqual(state["active_execution_plan"]["target"], "src/listener.py")
        self.assertEqual(state["read_files"], ["src/listener.py", "src/processor.py"])
        self.assertEqual(state["last_failed_command"]["command"], "pytest")
        self.assertEqual(state["system_context_epoch"], 7)

    def test_fallback_open_file_accepts_unknown_extensions(self):
        action = tasks._detect_chat_action("打开 `src/engine.qx` 第 27 行")

        self.assertEqual(action["type"], "open_file")
        self.assertEqual(action["path"], "src/engine.qx")
        self.assertEqual(action["line"], 27)

    def test_fallback_command_controls_accept_utf8_chinese(self):
        self.assertEqual(
            tasks._detect_chat_action("执行命令：python -m pytest"),
            {"type": "run_command", "command": "python -m pytest"},
        )
        self.assertEqual(
            tasks._detect_chat_action("确认回退 上一版"),
            {"type": "rollback_confirm", "target": "previous"},
        )


if __name__ == "__main__":
    unittest.main()
