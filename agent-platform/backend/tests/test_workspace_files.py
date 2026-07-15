import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from api import tasks
from core.state import _tasks


class WorkspaceFilesTest(unittest.IsolatedAsyncioTestCase):
    async def test_list_workspace_files_supports_subdirectories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ws = root / "ws-test"
            (ws / ".autocode").mkdir(parents=True)
            (ws / ".autocode" / "PLAN.md").write_text("# 计划\n", encoding="utf-8")
            (ws / "src").mkdir(parents=True)
            (ws / "src" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            (ws / "tests").mkdir(parents=True)
            (ws / "tests" / "test_main.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
            (ws / "README.md").write_text("# Demo\n", encoding="utf-8")

            _tasks["task-files-test"] = {"id": "task-files-test", "workspace_id": "ws-test"}
            request = SimpleNamespace(headers={}, client=SimpleNamespace(host="127.0.0.1"))
            settings = SimpleNamespace(workspace_base_dir=root)

            try:
                with patch("core.config.get_settings", return_value=settings):
                    root_result = await tasks.list_workspace_files("task-files-test", request, "/")
                    autocode_result = await tasks.list_workspace_files("task-files-test", request, "/.autocode")
                    src_result = await tasks.list_workspace_files("task-files-test", request, "/src")
                    tests_result = await tasks.list_workspace_files("task-files-test", request, "/tests")
            finally:
                _tasks.pop("task-files-test", None)

            self.assertEqual(root_result["path"], "/")
            self.assertIn({"name": "src", "type": "dir"}, [
                {"name": item["name"], "type": item["type"]} for item in root_result["files"]
            ])
            self.assertEqual(src_result["path"], "/src")
            self.assertEqual(src_result["files"][0]["name"], "main.py")
            self.assertEqual(src_result["files"][0]["type"], "file")
            self.assertEqual(src_result["files"][0]["path"], "src/main.py")
            self.assertEqual(autocode_result["path"], "/.autocode")
            self.assertEqual(autocode_result["files"][0]["path"], ".autocode/PLAN.md")
            self.assertEqual(tests_result["path"], "/tests")
            self.assertEqual(tests_result["files"][0]["path"], "tests/test_main.py")


if __name__ == "__main__":
    unittest.main()
