"""code_editor 换行符容错回归测试。

背景：agent 从文件 view 出来的内容常被规范化为 LF，而磁盘上是 CRLF
（Windows 项目常见）。str_replace 若做字节级精确匹配，LF 的 old_str 永远
匹配不上 CRLF 文件，导致 agent 反复 "search text was not found" 卡死。

本测试锁定修复后的语义：
  - str_replace 以 LF 空间匹配，写回时保留文件原本的 CRLF 风格；
  - insert 同样保留原换行风格，不把 CRLF 文件悄悄转成 LF。
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


def _load_runner():
    path = Path(__file__).resolve().parents[1] / "local_runner" / "autocode_local_runner.py"
    spec = importlib.util.spec_from_file_location("autocode_local_runner_crlf", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = _load_runner()


class CodeEditorCrlfTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _write_crlf(self, rel: str, text: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        # 显式以 CRLF 写入，绕开平台默认换行转换。
        path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
        return path

    def test_str_replace_lf_oldstr_matches_crlf_file(self):
        path = self._write_crlf("a.py", "line1\nline2\nline3\n")
        # old_str 用 LF（模拟 agent view 后规范化的内容）。
        result = runner.code_editor(
            self.root,
            [],
            {"command": "str_replace", "path": "a.py", "old_str": "line2", "new_str": "CHANGED"},
        )
        self.assertTrue(result["ok"])
        raw = path.read_bytes()
        self.assertIn(b"CHANGED", raw)
        # 写回仍是 CRLF，未被降级成 LF。
        self.assertIn(b"\r\n", raw)
        self.assertNotIn(b"line2", raw)

    def test_str_replace_multiline_lf_oldstr_matches_crlf_file(self):
        path = self._write_crlf("b.py", "def f():\n    return 1\n\n\ndef g():\n    return 2\n")
        result = runner.code_editor(
            self.root,
            [],
            {
                "command": "str_replace",
                "path": "b.py",
                "old_str": "def f():\n    return 1",
                "new_str": "def f():\n    return 42",
            },
        )
        self.assertTrue(result["ok"])
        raw = path.read_bytes()
        self.assertIn(b"return 42", raw)
        self.assertIn(b"\r\n", raw)
        # 不允许裸 LF：每个 \n 必须紧跟在 \r 之后（连续空行 \r\n\r\n 合法）
        self.assertNotIn(b"\n", raw.replace(b"\r\n", b""))

    def test_insert_preserves_crlf(self):
        path = self._write_crlf("c.py", "a\nb\nc\n")
        result = runner.code_editor(
            self.root,
            [],
            {"command": "insert", "path": "c.py", "insert_line": 1, "new_str": "INSERTED"},
        )
        self.assertTrue(result["ok"])
        raw = path.read_bytes()
        self.assertIn(b"INSERTED", raw)
        self.assertIn(b"\r\n", raw)
        # 不应残留裸 LF（除 CRLF 中的以外）。
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))

    def test_str_replace_lf_file_stays_lf(self):
        # LF 文件不受影响，写回仍是纯 LF。
        path = self.root / "d.py"
        path.write_bytes(b"x\ny\nz\n")
        result = runner.code_editor(
            self.root,
            [],
            {"command": "str_replace", "path": "d.py", "old_str": "y", "new_str": "Y"},
        )
        self.assertTrue(result["ok"])
        raw = path.read_bytes()
        self.assertIn(b"Y", raw)
        self.assertNotIn(b"\r\n", raw)
