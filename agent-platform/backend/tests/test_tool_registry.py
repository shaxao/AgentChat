import tempfile
import unittest
from pathlib import Path

from runtime.permission_engine import DEFAULT_POLICY, permission_engine
from runtime.tool_output_store import bound_tool_output
from runtime.tool_registry import tool_registry


class ToolRegistryTest(unittest.TestCase):
    def test_public_specs_include_display_and_policy_metadata(self):
        specs = {item["name"]: item for item in tool_registry.public_specs()}

        self.assertIn("read_file", specs)
        self.assertIn("bash", specs)
        self.assertEqual(specs["read_file"]["label"], "读取文件")
        self.assertEqual(specs["bash"]["action"], "执行命令")
        self.assertEqual(specs["bash"]["permission_default"], "ask")
        self.assertTrue(specs["bash"]["requires_confirmation"])
        self.assertTrue(specs["apply_patch"]["mutates_workspace"])
        self.assertTrue(specs["glob"]["cacheable"])

    def test_default_permission_policy_is_derived_from_registry(self):
        self.assertEqual(DEFAULT_POLICY["read_file"], tool_registry.require("read_file").permission_default)
        self.assertEqual(DEFAULT_POLICY["bash"], tool_registry.require("bash").permission_default)
        self.assertEqual(DEFAULT_POLICY["rollback"], "ask")

    def test_registry_helpers_drive_cache_and_mutation_detection(self):
        self.assertTrue(tool_registry.is_cacheable("read_file"))
        self.assertTrue(tool_registry.is_cacheable("search_code"))
        self.assertFalse(tool_registry.is_cacheable("write_file"))
        self.assertTrue(tool_registry.mutates_workspace("write_file"))
        self.assertTrue(tool_registry.mutates_workspace("apply_patch"))
        self.assertFalse(tool_registry.mutates_workspace("glob"))

    def test_local_runner_scope_is_declared_by_registry(self):
        local_tools = tool_registry.local_runner_tools()

        for name in ["read_file", "write_file", "apply_patch", "glob", "search_code", "bash", "git_diff"]:
            self.assertIn(name, local_tools)
            self.assertTrue(tool_registry.can_run_locally(name))

        for name in ["rollback", "git_commit", "generate_prototype", "spawn_subagent"]:
            self.assertNotIn(name, local_tools)
            self.assertFalse(tool_registry.can_run_locally(name))

        public_specs = {item["name"]: item for item in tool_registry.public_specs()}
        self.assertTrue(public_specs["bash"]["local_runner_enabled"])
        self.assertFalse(public_specs["rollback"]["local_runner_enabled"])

    def test_agent_tool_definitions_are_generated_from_registry(self):
        tools = {tool.name: tool for tool in tool_registry.agent_tool_definitions()}

        for name in [
            "read_file",
            "write_file",
            "bash",
            "glob",
            "search_code",
            "apply_patch",
            "git_commit",
            "request_confirmation",
            "generate_prototype",
        ]:
            self.assertIn(name, tools)

        self.assertEqual(tools["read_file"].parameters["required"], ["path"])
        self.assertIn("command", tools["bash"].parameters["properties"])
        self.assertEqual(tools["apply_patch"].parameters["required"], ["path", "search", "replace"])
        self.assertIn("应用补丁", tools["apply_patch"].description)

    def test_orchestrator_uses_registry_generated_agent_tools(self):
        from core.agent_orchestrator import AGENT_TOOLS

        registry_tools = {tool.name: tool.parameters for tool in tool_registry.agent_tool_definitions()}
        orchestrator_tools = {tool.name: tool.parameters for tool in AGENT_TOOLS}

        self.assertEqual(orchestrator_tools, registry_tools)

    def test_agent_usage_prompt_guides_tool_selection(self):
        prompt = tool_registry.agent_usage_prompt()

        self.assertIn("Tool Use Contract", prompt)
        self.assertIn("Discovery tools", prompt)
        self.assertIn("read_file", prompt)
        self.assertIn("search_code", prompt)
        self.assertIn("Edit tools", prompt)
        self.assertIn("apply_patch", prompt)
        self.assertIn("External tools", prompt)
        self.assertIn("bash", prompt)
        self.assertIn("Do not repeat the same cacheable", prompt)
        self.assertIn("After writing code or config", prompt)

    def test_tool_invocation_description_comes_from_registry(self):
        bash_desc = tool_registry.describe_invocation("bash", {"command": "python -m py_compile main.py"})
        read_progress = tool_registry.describe_invocation("read_file", {"path": "src/reader.py"}, progress=True)
        unknown_desc = tool_registry.describe_invocation("custom_tool", {"target": "abc"})

        self.assertIn("python -m py_compile main.py", bash_desc)
        self.assertIn("src/reader.py", read_progress)
        self.assertIn("正在", read_progress)
        self.assertIn("custom_tool", unknown_desc)
        self.assertIn("abc", unknown_desc)

    def test_unknown_tool_defaults_to_ask_permission(self):
        decision = permission_engine.check("custom_tool", {})
        self.assertEqual(decision.decision, "ask")
        self.assertEqual(decision.risk_level, 3)

    def test_bound_tool_output_uses_registry_limits(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            output = "x" * 3000
            meta = bound_tool_output(ws, output, tool_name="thinking")

            self.assertTrue(meta["truncated"])
            self.assertLessEqual(len(meta["model_preview"]), 2500)
            self.assertTrue(meta["full_path"].startswith(".autocode/tool-output/tool_"))
            self.assertTrue((ws / meta["full_path"]).exists())


if __name__ == "__main__":
    unittest.main()
