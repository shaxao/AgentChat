import tempfile
import unittest
from pathlib import Path

from runtime.agent_loop import AgentLoop
from runtime.context_manager import context_manager
from runtime.system_context import SYSTEM_CONTEXT_PATH, build_manifest, reconcile_context


class FakeLLMResponse:
    content = '{"action":"continue_development","confidence":0.91,"answer":"继续修改并验证。"}'


class FakeLLM:
    async def chat(self, **kwargs):
        self.kwargs = kwargs
        return FakeLLMResponse()


class SystemContextTest(unittest.IsolatedAsyncioTestCase):
    def test_manifest_epoch_and_diff_track_changed_context_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            (ws / ".autocode" / "MEMORY.md").write_text("# Memory\nfirst\n", encoding="utf-8")
            (ws / ".autocode" / "PROJECT_MAP.md").write_text("# Map\n", encoding="utf-8")

            first = build_manifest(ws, workspace_id="ws-1", task_id="task-1")
            self.assertEqual(first["epoch"], 1)
            self.assertEqual(set(first["last_diff"]["added"]), {
                ".autocode/MEMORY.md",
                ".autocode/PROJECT_MAP.md",
            })
            self.assertTrue((ws / SYSTEM_CONTEXT_PATH).exists())

            second = reconcile_context(ws, workspace_id="ws-1", task_id="task-1")
            self.assertEqual(second["epoch"], 1)
            self.assertEqual(second["last_diff"]["changed_paths"], [])

            (ws / ".autocode" / "MEMORY.md").write_text("# Memory\nsecond\n", encoding="utf-8")
            third = reconcile_context(ws, workspace_id="ws-1", task_id="task-1")
            self.assertEqual(third["epoch"], 2)
            self.assertEqual(third["last_diff"]["modified"], [".autocode/MEMORY.md"])

    def test_context_prompt_uses_manifest_without_full_autocode_file_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            unique_memory_body = "SECRET_FULL_MEMORY_BODY_SHOULD_NOT_BE_IN_PROMPT"
            (ws / ".autocode" / "MEMORY.md").write_text(
                f"# Memory\n{unique_memory_body}\n",
                encoding="utf-8",
            )
            (ws / "README.md").write_text("# Demo\nusage\n", encoding="utf-8")

            task = {"id": "task-ctx", "workspace_id": "ws-ctx", "events": []}
            runtime_context = context_manager.build(task=task, workspace_root=ws)
            prompt = runtime_context.to_prompt()

            self.assertIn("System Context Manifest", prompt)
            self.assertIn(".autocode/MEMORY.md", prompt)
            self.assertNotIn(unique_memory_body, prompt)
            self.assertEqual(task["system_context_epoch"], 1)
            self.assertIn("system_context_indexed", [event["type"] for event in task["events"]])

    def test_context_events_are_deduped_by_epoch(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            (ws / ".autocode" / "MEMORY.md").write_text("# Memory\nfirst\n", encoding="utf-8")

            task = {"id": "task-events", "workspace_id": "ws-events", "events": []}
            context_manager.build(task=task, workspace_root=ws)
            first_event_count = len(task["events"])
            context_manager.build(task=task, workspace_root=ws)

            self.assertEqual(len(task["events"]), first_event_count)

            (ws / ".autocode" / "MEMORY.md").write_text("# Memory\nsecond\n", encoding="utf-8")
            context_manager.build(task=task, workspace_root=ws)
            event_types = [event["type"] for event in task["events"]]

            self.assertEqual(event_types.count("system_context_indexed"), 2)
            self.assertEqual(event_types.count("system_context_reconciled"), 2)
            self.assertEqual(event_types.count("system_context_changed"), 2)

    async def test_agent_loop_decision_uses_system_context_without_context_items_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            (ws / ".autocode" / "MEMORY.md").write_text("# Memory\n", encoding="utf-8")

            task = {"id": "task-agent-loop", "workspace_id": "ws-agent", "events": []}
            llm = FakeLLM()
            decision = await AgentLoop().decide_chat_action(
                task=task,
                message="修复 parse_args 中的 args.input_file",
                llm=llm,
                workspace_root=ws,
            )

            self.assertEqual(decision.action, "continue_development")
            self.assertEqual(task["events"][-1]["type"], "agent_action_selected")
            self.assertIn("System Context Manifest", llm.kwargs["messages"][0]["content"])


if __name__ == "__main__":
    unittest.main()
