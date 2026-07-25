import tempfile
import unittest
import zipfile
from pathlib import Path

from core.review_agent import ReviewAgent


class ArtifactReviewTest(unittest.IsolatedAsyncioTestCase):
    async def test_non_code_artifact_does_not_emit_no_code_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "report.txt").write_text("通用产物", encoding="utf-8")
            result = await ReviewAgent().run(
                root,
                "task-text",
                "生成文本报告",
                execution_plan={
                    "intent": "artifact_creation",
                    "artifact_contracts": [{"path": "report.txt", "kind": "text"}],
                },
            )

        self.assertTrue(result.passed)
        self.assertEqual(result.dimensions["static_scan"]["status"], "not_applicable")
        self.assertFalse(any(issue["rule"] == "review/no-code-files" for issue in result.issues))

    async def test_local_unsynced_changed_source_is_valid_artifact_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = await ReviewAgent().run(
                Path(tmp),
                "task-local",
                "修改本地源码",
                execution_plan={
                    "intent": "code_development",
                    "artifact_contracts": [{"path": "src/main.py", "kind": "code"}],
                },
                capability_profile={
                    "artifact_source": "local_connector",
                    "workspace_sync_status": "not_synced",
                },
                changed_files=["src/main.py"],
            )

        self.assertTrue(result.passed)
        self.assertEqual(result.dimensions["artifacts"]["source"], "local_connector")
        self.assertEqual(result.dimensions["artifacts"]["verified_count"], 1)

    async def test_local_unsynced_semantic_contract_uses_changed_file_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = await ReviewAgent().run(
                Path(tmp),
                "task-local-label",
                "淇敼鏈湴閰嶇疆",
                execution_plan={
                    "intent": "code_development",
                    "artifact_contracts": [
                        {"path": "违禁词列表配置", "kind": "code"},
                        {"path": "消息监听与过滤逻辑", "kind": "code"},
                    ],
                },
                capability_profile={
                    "artifact_source": "local_connector",
                    "workspace_sync_status": "not_synced",
                },
                changed_files=["src/config/forbiddenWords.ts"],
            )

        self.assertTrue(result.passed, result.to_dict())
        self.assertEqual(result.dimensions["artifacts"]["verified_count"], 2)
        self.assertFalse(any(issue["rule"] == "artifact/missing" for issue in result.issues))

    async def test_local_unsynced_concrete_missing_path_still_fails_without_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = await ReviewAgent().run(
                Path(tmp),
                "task-local-missing",
                "淇敼鏈湴婧愮爜",
                execution_plan={
                    "intent": "code_development",
                    "artifact_contracts": [{"path": "src/main.py", "kind": "code"}],
                },
                capability_profile={
                    "artifact_source": "local_connector",
                    "workspace_sync_status": "not_synced",
                },
                changed_files=[],
            )

        self.assertFalse(result.passed)
        self.assertTrue(any(issue["rule"] == "artifact/missing" for issue in result.issues))

    async def test_contract_title_without_real_path_is_invalid_not_missing_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = await ReviewAgent().run(
                Path(tmp),
                "task-contract-title",
                "Add banned word monitoring",
                execution_plan={
                    "intent": "code_development",
                    "artifact_contracts": [
                        {"name": "forbidden word configuration", "title": "Forbidden Words"},
                    ],
                },
                changed_files=[],
            )

        self.assertFalse(result.passed)
        self.assertTrue(any(issue["rule"] == "artifact/invalid-contract" for issue in result.issues))
        self.assertFalse(any(issue["rule"] == "artifact/missing" for issue in result.issues))

    async def test_invalid_office_zip_structure_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "broken.pptx"
            with zipfile.ZipFile(target, "w") as archive:
                archive.writestr("[Content_Types].xml", "<Types/>")
            result = await ReviewAgent().run(
                root,
                "task-broken-office",
                "生成演示文稿",
                execution_plan={
                    "intent": "artifact_creation",
                    "artifact_contracts": [{"path": "broken.pptx"}],
                },
            )

        self.assertFalse(result.passed)
        self.assertTrue(any(issue["rule"] == "artifact/office-structure" for issue in result.issues))

    async def test_minimal_office_packages_pass_structure_validation(self):
        cases = {
            "deck.pptx": "ppt/presentation.xml",
            "book.xlsx": "xl/workbook.xml",
            "document.docx": "word/document.xml",
        }
        for filename, required_entry in cases.items():
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                target = root / filename
                with zipfile.ZipFile(target, "w") as archive:
                    archive.writestr("[Content_Types].xml", "<Types/>")
                    archive.writestr(required_entry, "<root/>")
                result = await ReviewAgent().run(
                    root,
                    f"task-{target.suffix[1:]}",
                    "生成 Office 产物",
                    execution_plan={
                        "intent": "artifact_creation",
                        "artifact_contracts": [{"path": filename}],
                    },
                )
                self.assertTrue(result.passed, result.to_dict())
                self.assertEqual(result.dimensions["artifacts"]["verified_count"], 1)

    async def test_unknown_nonempty_format_uses_generic_readability_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model.custom").write_bytes(b"CUSTOM\x00payload")
            result = await ReviewAgent().run(
                root,
                "task-custom",
                "生成自定义格式",
                execution_plan={
                    "intent": "artifact_creation",
                    "artifact_contracts": [{"path": "model.custom"}],
                },
            )

        self.assertTrue(result.passed)
        check = result.dimensions["artifacts"]["checks"][0]
        self.assertEqual(check["status"], "pass")
        self.assertTrue(check["signature_hex"])


if __name__ == "__main__":
    unittest.main()
