import tempfile
import unittest
from pathlib import Path

from core.execution_protocol import (
    build_task_capability_profile,
    normalize_execution_plan,
)


class ExecutionProtocolTest(unittest.TestCase):
    def test_open_task_family_and_unknown_artifact_format_are_preserved(self):
        plan = normalize_execution_plan({
            "intent": "artifact_creation",
            "task_family": "scientific mesh conversion",
            "artifact_contracts": [{"path": "output/result.meshx"}],
        })

        self.assertEqual(plan["intent"], "artifact_creation")
        self.assertEqual(plan["task_family"], "scientific mesh conversion")
        self.assertEqual(plan["artifact_contracts"][0]["format"], "meshx")
        self.assertEqual(plan["artifact_contracts"][0]["kind"], "unknown")

    def test_office_artifacts_normalize_without_project_type_whitelist(self):
        plan = normalize_execution_plan({
            "intent": "artifact_creation",
            "task_family": "季度经营材料",
            "artifact_contracts": [
                {"path": "reports/summary.pptx"},
                {"path": "reports/model.xlsx"},
                {"path": "reports/notes.docx"},
            ],
        })

        kinds = {item["format"]: item["kind"] for item in plan["artifact_contracts"]}
        self.assertEqual(kinds["pptx"], "presentation")
        self.assertEqual(kinds["xlsx"], "spreadsheet")
        self.assertEqual(kinds["docx"], "document")

    def test_artifact_contract_name_is_purpose_not_path(self):
        plan = normalize_execution_plan({
            "intent": "code_development",
            "artifact_contracts": [
                {"name": "forbidden word configuration", "title": "Forbidden Words", "purpose": "Store banned terms"},
            ],
        })

        contract = plan["artifact_contracts"][0]
        self.assertEqual(contract["path"], "")
        self.assertEqual(contract["purpose"], "Store banned terms")

    def test_python_workspace_does_not_infer_node_or_npm_stages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "requirements.txt").write_text("pytest\n", encoding="utf-8")
            (root / "main.py").write_text("print('ok')\n", encoding="utf-8")
            plan = normalize_execution_plan({
                "intent": "code_development",
                "task_family": "Python automation",
                "validation_plan": [{"kind": "command", "command": "python -m pytest"}],
            })

            profile = build_task_capability_profile(
                {"project_type": "unknown"}, root, plan, available_tools=["bash", "read_file", "write_file"]
            )

        self.assertIn("requirements.txt", profile["workspace"]["manifests"])
        self.assertNotIn("package.json", profile["workspace"]["manifests"])
        self.assertFalse(profile["stage_policy"]["requires_dependency_install"])
        self.assertFalse(profile["stage_policy"]["requires_preview"])

    def test_unknown_source_language_is_evidence_not_a_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "engine.qx").write_text("entry main {}\n", encoding="utf-8")
            plan = normalize_execution_plan({
                "intent": "code_development",
                "task_family": "QX language development",
                "artifact_contracts": [{"path": "engine.qx", "kind": "code"}],
            })
            profile = build_task_capability_profile({"project_type": "unknown"}, root, plan)

        self.assertIn(".qx", profile["workspace"]["extensions"])
        self.assertEqual(profile["task_family"], "QX language development")
        self.assertTrue(profile["stage_policy"]["requires_review"])

    def test_preview_stage_is_enabled_only_by_declared_preview_need(self):
        spreadsheet = normalize_execution_plan({
            "intent": "artifact_creation",
            "artifact_contracts": [{"path": "output.xlsx"}],
        })
        rendered = normalize_execution_plan({
            "intent": "artifact_creation",
            "artifact_contracts": [{"path": "output.xlsx"}],
            "validation_plan": [{"kind": "render", "target": "output.xlsx"}],
        })

        plain_profile = build_task_capability_profile({}, None, spreadsheet)
        render_profile = build_task_capability_profile({}, None, rendered)

        self.assertFalse(plain_profile["stage_policy"]["requires_preview"])
        self.assertTrue(render_profile["stage_policy"]["requires_preview"])


if __name__ == "__main__":
    unittest.main()
