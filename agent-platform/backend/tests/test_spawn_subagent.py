# -*- coding: utf-8 -*-
"""Tests for the spawn_subagent tool: read-only research/review subagents.

Verifies white-list enforcement, prompt requirement, isolation (the temporary
subagent task must never linger in ``_tasks`` or pollute the parent), the
``<subagent>`` result envelope, and recursion prevention (the read-only tool
subset excludes spawn_subagent itself).
"""
import asyncio
import unittest
from pathlib import Path
from unittest.mock import patch

from core.agent_orchestrator import (
    agent_orchestrator,
    _effective_agent_tools,
    AGENT_TOOLS,
)
from core.state import _tasks
from runtime.tool_registry import tool_registry


def _noop_log(*args, **kwargs):
    pass


class SpawnSubagentValidationTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_non_whitelisted_type(self):
        out = await agent_orchestrator._execute_spawn_subagent(
            {"subagent_type": "backend", "prompt": "do stuff"},
            "ws-x", Path("."), "parent-1", "script", _noop_log,
        )
        self.assertIn("不支持的 subagent_type", out)
        # No leftover subagent task.
        self.assertEqual([k for k in _tasks if k.startswith("parent-1::sub-")], [])

    async def test_requires_prompt(self):
        out = await agent_orchestrator._execute_spawn_subagent(
            {"subagent_type": "researcher", "prompt": "  "},
            "ws-x", Path("."), "parent-1", "script", _noop_log,
        )
        self.assertIn("需要 prompt", out)


class SpawnSubagentIsolationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        for k in [k for k in _tasks if k.startswith("parent-iso")]:
            _tasks.pop(k, None)
        for prefix in ("parent-bg", "parent-limit", "parent-bg-err"):
            await agent_orchestrator._cancel_background_subagents(prefix)
            agent_orchestrator._user_message_queues.pop(prefix, None)
            for k in [k for k in _tasks if k.startswith(prefix)]:
                _tasks.pop(k, None)

    async def test_runs_isolated_and_returns_envelope(self):
        _tasks["parent-iso"] = {
            "id": "parent-iso",
            "workspace_id": "ws-iso",
            "model": "test-model",
            "agent_iteration": 7,
            "total_agent_iterations": 7,
            "needs_continuation": False,
        }
        captured = {}

        async def fake_run(task_id, prompt, project_type, workspace_id,
                           agent_type, ws_path, log, research_report):
            # Assert we got an isolated task id and a live task dict.
            captured["task_id"] = task_id
            captured["agent_type"] = agent_type
            captured["allowed_tools"] = list((_tasks.get(task_id) or {}).get("allowed_tools") or [])
            return {"success": True, "summary": "发现 3 处空指针风险", "iterations": 4}

        with patch.object(agent_orchestrator, "_run_single_agent_with_usage", side_effect=fake_run):
            out = await agent_orchestrator._execute_spawn_subagent(
                {"subagent_type": "reviewer", "prompt": "审查 auth 模块", "description": "review auth"},
                "ws-iso", Path("."), "parent-iso", "script", _noop_log,
            )

        # Envelope + content.
        self.assertIn('<subagent type="reviewer" state="completed">', out)
        self.assertIn("发现 3 处空指针风险", out)
        self.assertTrue(out.endswith("</subagent>"))

        # Ran under an isolated child id, not the parent.
        self.assertTrue(captured["task_id"].startswith("parent-iso::sub-"))
        self.assertNotEqual(captured["task_id"], "parent-iso")
        self.assertEqual(captured["agent_type"], "reviewer")

        # Child was given a read-only tool subset that excludes spawn_subagent.
        self.assertIn("read_file", captured["allowed_tools"])
        self.assertNotIn("write_file", captured["allowed_tools"])
        self.assertNotIn("spawn_subagent", captured["allowed_tools"])

        # Parent state untouched; no leftover child task.
        self.assertEqual(_tasks["parent-iso"]["agent_iteration"], 7)
        self.assertEqual(_tasks["parent-iso"]["total_agent_iterations"], 7)
        self.assertFalse(_tasks["parent-iso"]["needs_continuation"])
        self.assertEqual([k for k in _tasks if k.startswith("parent-iso::sub-")], [])

    async def test_child_cleaned_up_on_exception(self):
        _tasks["parent-iso-err"] = {"id": "parent-iso-err", "workspace_id": "ws", "model": None}

        async def boom(*a, **k):
            raise RuntimeError("subagent crashed")

        with patch.object(agent_orchestrator, "_run_single_agent_with_usage", side_effect=boom):
            out = await agent_orchestrator._execute_spawn_subagent(
                {"subagent_type": "researcher", "prompt": "investigate"},
                "ws", Path("."), "parent-iso-err", "script", _noop_log,
            )
        self.assertIn('state="error"', out)
        self.assertIn("subagent crashed", out)
        # No leftover child task even after the crash.
        self.assertEqual([k for k in _tasks if k.startswith("parent-iso-err::sub-")], [])
        _tasks.pop("parent-iso-err", None)

    async def test_background_returns_running_and_injects_result(self):
        _tasks["parent-bg"] = {"id": "parent-bg", "workspace_id": "ws-bg", "model": "test-model"}
        started = asyncio.Event()

        async def fake_run(task_id, prompt, project_type, workspace_id,
                           agent_type, ws_path, log, research_report):
            started.set()
            await asyncio.sleep(0.01)
            return {"success": True, "summary": "background investigation done"}

        with patch.object(agent_orchestrator, "_run_single_agent_with_usage", side_effect=fake_run):
            out = await agent_orchestrator._execute_spawn_subagent(
                {
                    "subagent_type": "researcher",
                    "prompt": "investigate config",
                    "description": "research config",
                    "background": True,
                },
                "ws-bg", Path("."), "parent-bg", "script", _noop_log,
            )
            self.assertIn('state="running"', out)
            self.assertIn("不要轮询", out)
            await asyncio.wait_for(started.wait(), timeout=1)
            for _ in range(30):
                if agent_orchestrator._user_message_queues.get("parent-bg"):
                    break
                await asyncio.sleep(0.01)

        queued = agent_orchestrator._user_message_queues.get("parent-bg") or []
        self.assertEqual(len(queued), 1)
        self.assertIn('<subagent type="researcher" state="completed">', queued[0]["content"])
        self.assertIn("background investigation done", queued[0]["content"])
        self.assertEqual([k for k in _tasks if k.startswith("parent-bg::sub-")], [])

    async def test_background_concurrency_limit_rejects_fourth(self):
        _tasks["parent-limit"] = {"id": "parent-limit", "workspace_id": "ws", "model": "test-model"}
        release = asyncio.Event()

        async def fake_run(*args, **kwargs):
            await release.wait()
            return {"success": True, "summary": "done"}

        with patch.object(agent_orchestrator, "_run_single_agent_with_usage", side_effect=fake_run):
            outs = []
            for idx in range(4):
                outs.append(await agent_orchestrator._execute_spawn_subagent(
                    {
                        "subagent_type": "researcher",
                        "prompt": f"task {idx}",
                        "background": True,
                    },
                    "ws", Path("."), "parent-limit", "script", _noop_log,
                ))
            self.assertEqual(sum('state="running"' in out for out in outs), 3)
            self.assertIn("并发上限", outs[3])
            release.set()

        await agent_orchestrator._cancel_background_subagents("parent-limit")

    async def test_background_failure_injects_error_block(self):
        _tasks["parent-bg-err"] = {"id": "parent-bg-err", "workspace_id": "ws", "model": "test-model"}

        async def boom(*args, **kwargs):
            await asyncio.sleep(0.01)
            raise RuntimeError("background crashed")

        with patch.object(agent_orchestrator, "_run_single_agent_with_usage", side_effect=boom):
            out = await agent_orchestrator._execute_spawn_subagent(
                {"subagent_type": "reviewer", "prompt": "review", "background": True},
                "ws", Path("."), "parent-bg-err", "script", _noop_log,
            )
            self.assertIn('state="running"', out)
            for _ in range(30):
                if agent_orchestrator._user_message_queues.get("parent-bg-err"):
                    break
                await asyncio.sleep(0.01)

        queued = agent_orchestrator._user_message_queues.get("parent-bg-err") or []
        self.assertEqual(len(queued), 1)
        self.assertIn('state="error"', queued[0]["content"])
        self.assertIn("background crashed", queued[0]["content"])
        self.assertEqual([k for k in _tasks if k.startswith("parent-bg-err::sub-")], [])


class EffectiveToolsTest(unittest.TestCase):
    def test_no_allowlist_returns_full_set(self):
        self.assertEqual(_effective_agent_tools({}), AGENT_TOOLS)
        self.assertEqual(_effective_agent_tools(None), AGENT_TOOLS)

    def test_allowlist_narrows_tools(self):
        filtered = _effective_agent_tools({"allowed_tools": ["read_file", "glob"]})
        names = {getattr(t, "name", None) for t in filtered}
        self.assertEqual(names, {"read_file", "glob"})
        self.assertNotIn("write_file", names)

    def test_empty_allowlist_is_unrestricted(self):
        # An empty list means "no restriction", not "no tools".
        self.assertEqual(_effective_agent_tools({"allowed_tools": []}), AGENT_TOOLS)

    def test_spawn_subagent_schema_exposes_background(self):
        spec = tool_registry.require("spawn_subagent")
        properties = ((spec.parameters or {}).get("properties") or {})
        self.assertIn("background", properties)
        self.assertEqual(properties["background"].get("type"), "boolean")
        definitions = {tool.name: tool for tool in tool_registry.agent_tool_definitions()}
        self.assertIn("background=true", definitions["spawn_subagent"].description)


if __name__ == "__main__":
    unittest.main()
