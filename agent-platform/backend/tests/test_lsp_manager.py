# -*- coding: utf-8 -*-
"""P2 tests: server registry, diagnostic formatting, and the LSPManager pool.

The manager tests drive a real (mock) language server through the same stdio
protocol used in P1, but wired via a custom LSPServerSpec so no pyright binary
is needed. This exercises root resolution, lazy spawn/reuse, broken-server
fallback, touch_file diagnostics, and shutdown.
"""
import asyncio
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from runtime.lsp.diagnostic import format_diagnostics, pretty_diagnostic
from runtime.lsp.lsp_client import LSPClient, LSPDiagnostic, SEVERITY_ERROR
from runtime.lsp.lsp_manager import LSPManager
from runtime.lsp.lsp_server import (
    LSPServerSpec,
    SpawnResult,
    servers_for_file,
    server_for_file,
    default_servers,
)


MOCK_SERVER = textwrap.dedent(
    '''
    import json, sys

    def read_message():
        headers = {}
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return None
            line = line.decode("ascii").strip()
            if line == "":
                break
            if ":" in line:
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None
        return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))

    def send(payload):
        body = json.dumps(payload).encode("utf-8")
        sys.stdout.buffer.write(f"Content-Length: {len(body)}\\r\\n\\r\\n".encode("ascii"))
        sys.stdout.buffer.write(body)
        sys.stdout.buffer.flush()

    while True:
        msg = read_message()
        if msg is None:
            break
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {"textDocumentSync": 1}}})
        elif method == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                  "params": {"uri": uri, "diagnostics": [
                      {"severity": 1, "message": "boom",
                       "range": {"start": {"line": 0, "character": 0},
                                 "end": {"line": 0, "character": 1}}}]}})
        elif method == "textDocument/definition":
            send({"jsonrpc": "2.0", "id": mid, "result": [
                {"uri": msg["params"]["textDocument"]["uri"],
                 "range": {"start": {"line": 0, "character": 0},
                           "end": {"line": 0, "character": 3}}}]})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": None})
    '''
)


def _write_mock_server(root: str) -> str:
    p = os.path.join(root, "_mock_lsp.py")
    Path(p).write_text(MOCK_SERVER, encoding="utf-8")
    return p


def _mock_server_spec(root_dir: str) -> LSPServerSpec:
    script = _write_mock_server(root_dir)

    async def spawn(root: str):
        proc = await asyncio.create_subprocess_exec(
            sys.executable, script,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=root,
        )
        return SpawnResult(process=proc, initialization={})

    return LSPServerSpec(
        id="mock",
        extensions=(".py",),
        root=lambda file_abs, ws: ws,  # whole workspace is the root
        spawn=spawn,
    )


class ServerRegistryTest(unittest.TestCase):
    def test_default_servers_include_pyright(self):
        ids = {s.id for s in default_servers()}
        self.assertIn("pyright", ids)

    def test_servers_for_file_matches_by_extension(self):
        py = servers_for_file("/x/a.py")
        self.assertTrue(any(s.id == "pyright" for s in py))
        self.assertEqual(servers_for_file("/x/a.rb"), [])

    def test_server_for_file_returns_first_or_none(self):
        self.assertIsNotNone(server_for_file("/x/a.py"))
        self.assertIsNone(server_for_file("/x/a.unknownext"))

    def test_default_servers_include_typescript_and_gopls(self):
        ids = {s.id for s in default_servers()}
        self.assertIn("typescript", ids)
        self.assertIn("gopls", ids)

    def test_typescript_routes_all_js_ts_extensions(self):
        for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"):
            ids = {s.id for s in servers_for_file(f"/x/a{ext}")}
            self.assertIn("typescript", ids, ext)

    def test_go_routes_to_gopls(self):
        ids = {s.id for s in servers_for_file("/x/main.go")}
        self.assertEqual(ids, {"gopls"})

    def test_strict_root_returns_none_without_marker(self):
        # TS/gopls need a real project root; without one they skip (return None)
        # rather than falling back to the workspace like pyright does.
        with tempfile.TemporaryDirectory() as d:
            ts = next(s for s in default_servers() if s.id == "typescript")
            go = next(s for s in default_servers() if s.id == "gopls")
            self.assertIsNone(ts.root(os.path.join(d, "a.ts"), d))
            self.assertIsNone(go.root(os.path.join(d, "main.go"), d))

    def test_strict_root_finds_marker(self):
        with tempfile.TemporaryDirectory() as d:
            Path(os.path.join(d, "package.json")).write_text("{}", encoding="utf-8")
            Path(os.path.join(d, "go.mod")).write_text("module x\n", encoding="utf-8")
            ts = next(s for s in default_servers() if s.id == "typescript")
            go = next(s for s in default_servers() if s.id == "gopls")
            self.assertEqual(os.path.abspath(ts.root(os.path.join(d, "a.ts"), d)), os.path.abspath(d))
            self.assertEqual(os.path.abspath(go.root(os.path.join(d, "main.go"), d)), os.path.abspath(d))

    def test_pyright_falls_back_to_workspace_without_marker(self):
        # Contrast with strict-root: pyright degrades to the workspace root.
        with tempfile.TemporaryDirectory() as d:
            py = next(s for s in default_servers() if s.id == "pyright")
            self.assertEqual(os.path.abspath(py.root(os.path.join(d, "a.py"), d)), os.path.abspath(d))


class DiagnosticFormatTest(unittest.TestCase):
    def _diag(self, severity, message, line=0, char=0):
        return LSPDiagnostic({
            "severity": severity,
            "message": message,
            "range": {"start": {"line": line, "character": char}},
        })

    def test_pretty_is_one_based(self):
        text = pretty_diagnostic(self._diag(SEVERITY_ERROR, "bad", line=4, char=2))
        self.assertEqual(text, "ERROR [5:3] bad")

    def test_format_empty_when_no_errors(self):
        # Only a warning present, warnings excluded by default -> empty.
        out = format_diagnostics("a.py", [self._diag(2, "just a warning")])
        self.assertEqual(out, "")

    def test_format_wraps_errors_in_block(self):
        out = format_diagnostics("a.py", [self._diag(1, "syntax error", line=1)])
        self.assertIn('<diagnostics file="a.py">', out)
        self.assertIn("ERROR [2:1] syntax error", out)
        self.assertTrue(out.endswith("</diagnostics>"))

    def test_format_caps_per_file(self):
        diags = [self._diag(1, f"e{i}", line=i) for i in range(30)]
        out = format_diagnostics("a.py", diags)
        self.assertIn("... and 10 more", out)


class LSPManagerTest(unittest.IsolatedAsyncioTestCase):
    async def test_touch_file_returns_diagnostics_and_reuses_client(self):
        with tempfile.TemporaryDirectory() as d:
            spec = _mock_server_spec(d)
            mgr = LSPManager(d, servers=[spec])
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("x=1\n", encoding="utf-8")
                self.assertTrue(await mgr.has_clients(target))
                diags = await mgr.touch_file(target, wait_diagnostics=True, timeout=3)
                self.assertIn(os.path.abspath(target), diags)
                self.assertEqual(diags[os.path.abspath(target)][0].message, "boom")
                # Second touch must reuse the same client (only one spawned).
                await mgr.touch_file(target, wait_diagnostics=False)
                self.assertEqual(len(mgr._clients), 1)
            finally:
                await mgr.shutdown()

    async def test_definition_query(self):
        with tempfile.TemporaryDirectory() as d:
            spec = _mock_server_spec(d)
            mgr = LSPManager(d, servers=[spec])
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("def f(): pass\n", encoding="utf-8")
                res = await mgr.definition(target, 0, 4)
                self.assertTrue(res)
                self.assertEqual(len(res), 1)
            finally:
                await mgr.shutdown()

    async def test_file_outside_workspace_gets_no_clients(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:
            spec = _mock_server_spec(d)
            mgr = LSPManager(d, servers=[spec])
            try:
                outside = os.path.join(other, "x.py")
                Path(outside).write_text("y=2\n", encoding="utf-8")
                self.assertFalse(await mgr.has_clients(outside))
                self.assertEqual(await mgr.touch_file(outside), {})
            finally:
                await mgr.shutdown()

    async def test_broken_server_is_not_retried(self):
        with tempfile.TemporaryDirectory() as d:
            async def spawn_fail(root):
                return None  # simulate missing binary

            spec = LSPServerSpec(
                id="broken",
                extensions=(".py",),
                root=lambda file_abs, ws: ws,
                spawn=spawn_fail,
            )
            mgr = LSPManager(d, servers=[spec])
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("x=1\n", encoding="utf-8")
                self.assertEqual(await mgr.touch_file(target), {})
                # Key recorded as broken; has_clients now returns False.
                self.assertFalse(await mgr.has_clients(target))
            finally:
                await mgr.shutdown()

    async def test_disabled_via_env(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["AUTOCODE_LSP_ENABLED"] = "0"
            try:
                spec = _mock_server_spec(d)
                mgr = LSPManager(d, servers=[spec])
                target = os.path.join(d, "mod.py")
                Path(target).write_text("x=1\n", encoding="utf-8")
                self.assertFalse(await mgr.has_clients(target))
                self.assertEqual(await mgr.touch_file(target), {})
            finally:
                os.environ.pop("AUTOCODE_LSP_ENABLED", None)


if __name__ == "__main__":
    unittest.main()
