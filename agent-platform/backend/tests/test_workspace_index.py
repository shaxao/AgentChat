import tempfile
import unittest
from pathlib import Path

from core.workspace_index import (
    glob_workspace_files,
    indexed_files,
    invalidate_workspace_index,
    is_actionable_development_request,
    plan_retrieval,
    render_retrieval_plan,
    search_workspace_code,
)


class WorkspaceIndexTest(unittest.TestCase):
    def test_retrieval_guard_accounts_and_blocks_non_candidate_reads(self):
        from core.agent_orchestrator import _check_retrieval_read_guard

        task = {
            "events": [],
            "retrieval_guard": {
                "active": True,
                "candidate_files": ["src/allowed.py"],
                "index_docs": [".autocode/MEMORY.md"],
                "read_budget": 1,
                "read_files": [],
            },
        }

        self.assertIsNone(_check_retrieval_read_guard(task, "src/first.py"))
        blocked = _check_retrieval_read_guard(task, "src/second.py")
        self.assertIsNotNone(blocked)
        self.assertIn("READ_BUDGET_BLOCKED", blocked)
        self.assertIsNone(_check_retrieval_read_guard(task, "src/allowed.py"))
        self.assertIsNone(_check_retrieval_read_guard(task, ".autocode/MEMORY.md"))

        self.assertEqual(task["retrieval_guard"]["read_files"], ["src/first.py", "src/allowed.py"])
        self.assertEqual(
            [event["type"] for event in task["events"]],
            ["retrieval_guard_accounted", "retrieval_guard_blocked", "retrieval_guard_accounted"],
        )

    def test_retrieval_plan_prefers_recent_changed_and_limits_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            (ws / ".autocode" / "PROJECT_MAP.md").write_text("# map\n", encoding="utf-8")
            (ws / ".autocode" / "MEMORY.md").write_text("# memory\n", encoding="utf-8")
            (ws / "src").mkdir()
            (ws / "src" / "reader.py").write_text("def read_excel(): pass\n", encoding="utf-8")
            (ws / "src" / "writer.py").write_text("def write_excel(): pass\n", encoding="utf-8")
            (ws / "src" / "config.py").write_text("MAX_ROWS = 100\n", encoding="utf-8")
            (ws / "README.md").write_text("# demo\n", encoding="utf-8")

            task = {
                "phase_reviews": [{
                    "dimensions": {
                        "phase_artifacts": {
                            "changed_files": ["src/reader.py", "src/writer.py"]
                        }
                    }
                }]
            }

            plan = plan_retrieval(ws, "读取 Excel 还是这样啊，效果不好", task, max_files=2)
            rendered = render_retrieval_plan(plan)

            self.assertLessEqual(len(plan.candidate_files), 2)
            self.assertIn("src/reader.py", plan.candidate_files)
            self.assertIn(".autocode/PROJECT_MAP.md", plan.index_docs)
            self.assertIn("source read budget", rendered)

    def test_actionable_request_uses_content_symbols_for_candidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / ".autocode").mkdir()
            (ws / ".autocode" / "PROJECT_MAP.md").write_text("# map\n", encoding="utf-8")
            (ws / "src").mkdir()
            (ws / "src" / "reader.py").write_text("def read_excel(header_row): pass\n", encoding="utf-8")
            (ws / "src" / "processor.py").write_text("def filter_rows(rows): pass\n", encoding="utf-8")
            (ws / "src" / "config.py").write_text("class Config:\n    def validate(self): pass\n", encoding="utf-8")
            (ws / "main.py").write_text("def parse_args(): pass\n", encoding="utf-8")

            message = "\n".join([
                "修复 parse_args 中的属性名：将 args.input_file 改为 args.input",
                "在 Config.validate 中增加对 header_row 的非负检查",
                "在 filter_rows 中增加索引越界警告或错误提示",
                "添加 if __name__ == '__main__' 入口",
            ])
            plan = plan_retrieval(ws, message, {"phase_reviews": []}, max_files=3)

            self.assertTrue(is_actionable_development_request(message))
            self.assertGreaterEqual(plan.read_budget, 6)
            self.assertIn("main.py", plan.candidate_files)
            self.assertIn("src/config.py", plan.candidate_files)
            self.assertIn("src/processor.py", plan.candidate_files)

    def test_workspace_index_cache_can_be_invalidated(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "src").mkdir()
            (ws / "src" / "a.py").write_text("def alpha(): pass\n", encoding="utf-8")

            first = indexed_files(ws, force=True)
            self.assertEqual([item["path"] for item in first], ["src/a.py"])

            (ws / "src" / "b.py").write_text("def beta(): pass\n", encoding="utf-8")
            cached = indexed_files(ws)
            self.assertNotIn("src/b.py", [item["path"] for item in cached])

            invalidate_workspace_index(ws)
            refreshed = indexed_files(ws)
            self.assertIn("src/b.py", [item["path"] for item in refreshed])

    def test_glob_and_search_use_workspace_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            (ws / "src").mkdir()
            (ws / "node_modules").mkdir()
            (ws / "src" / "reader.py").write_text("def read_excel():\n    return 1\n", encoding="utf-8")
            (ws / "node_modules" / "ignored.py").write_text("def read_excel(): pass\n", encoding="utf-8")

            self.assertEqual(glob_workspace_files(ws, "src/*.py"), ["src/reader.py"])
            results = search_workspace_code(ws, "read_excel")
            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].startswith("src/reader.py:1:"))


if __name__ == "__main__":
    unittest.main()
