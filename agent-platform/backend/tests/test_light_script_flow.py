import unittest

from core.agent_orchestrator import _agent_changed_files, _has_source_file, _subtask_expects_source
from core.task_planner import _recon_lightweight_plan
from schemas.task import SubTask, SubTaskStatus


class LightScriptPlanningTest(unittest.TestCase):
    def test_new_s0_script_plan_has_real_source_targets(self):
        plan = _recon_lightweight_plan(
            "Excel 数据处理脚本，读取 xlsx 后输出 csv",
            "tool",
            ["backend"],
            {
                "recommended_flow": "light_script",
                "complexity": "S0",
                "entrypoints": [],
                "likely_stack": ["Python 3"],
                "commands": {},
            },
        )

        implementation = plan.subtasks[1]

        self.assertEqual(implementation.title, "实现脚本核心行为")
        self.assertIn("src/main.py", implementation.estimated_files)
        self.assertIn("src/processor.py", implementation.estimated_files)
        self.assertIn("README.md", implementation.estimated_files)

    def test_import_project_plan_mentions_autocode_project_map(self):
        plan = _recon_lightweight_plan(
            "继续优化现有项目",
            "tool",
            ["backend"],
            {
                "recommended_flow": "light_tool",
                "complexity": "S0",
                "entrypoints": ["src/main.py"],
                "likely_stack": ["Python 3"],
                "commands": {},
            },
        )

        self.assertIn(".autocode/PROJECT_MAP.md", plan.subtasks[0].description)


class ImplementationArtifactGateTest(unittest.TestCase):
    def test_agent_bool_result_is_not_treated_as_file_list(self):
        self.assertEqual(_agent_changed_files(True), [])
        self.assertEqual(_agent_changed_files(False), [])
        self.assertEqual(_agent_changed_files(["src/main.py"]), ["src/main.py"])

    def test_implementation_subtask_requires_source_file_changes(self):
        subtask = SubTask(
            id="st-1",
            title="实现脚本核心行为",
            description="必须创建真实源码文件",
            agent_type="backend",
            estimated_files=["src/main.py", "README.md"],
            status=SubTaskStatus.pending,
        )

        self.assertTrue(_subtask_expects_source(subtask, "tool"))
        self.assertFalse(_has_source_file(["SCRIPT_CONTRACT.md", ".autocode/WORK_NOTE.md"]))
        self.assertTrue(_has_source_file(["src/main.py", "README.md"]))

    def test_contract_subtask_does_not_require_source_file_changes(self):
        subtask = SubTask(
            id="st-0",
            title="明确脚本契约",
            description="本阶段只定义契约，不实现代码。",
            agent_type="backend",
            estimated_files=["SCRIPT_CONTRACT.md"],
            status=SubTaskStatus.pending,
        )

        self.assertFalse(_subtask_expects_source(subtask, "tool"))


if __name__ == "__main__":
    unittest.main()
