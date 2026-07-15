import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from main import app
from api import tasks
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
        enqueue.assert_called_once_with(task_id, "chat continue development")

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


if __name__ == "__main__":
    unittest.main()
