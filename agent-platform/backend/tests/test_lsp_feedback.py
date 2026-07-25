# -*- coding: utf-8 -*-
"""P3 tests: post-edit diagnostics feedback.

Verifies that ``AgentOrchestrator._diagnostics_feedback`` opens an edited file
in its language server and returns a compact ``<diagnostics>`` block for the
errors it finds — and that it degrades to an empty string when LSP is disabled,
no server matches, or the path is internal bookkeeping.

The manager is backed by the same mock stdio language server used in the P2
tests (no pyright binary required), injected via the module-level
``lsp_registry`` singleton.
"""
import asyncio
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from core.agent_orchestrator import agent_orchestrator
from runtime.lsp.lsp_manager import LSPManager, lsp_registry
from runtime.lsp.lsp_server import LSPServerSpec, SpawnResult


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
                      {"severity": 1, "message": "undefined name foo",
                       "range": {"start": {"line": 2, "character": 4},
                                 "end": {"line": 2, "character": 7}}}]}})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": None})
    '''
)


def _mock_server_spec(root_dir: str) -> LSPServerSpec:
    script = os.path.join(root_dir, "_mock_lsp.py")
    Path(script).write_text(MOCK_SERVER, encoding="utf-8")

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
        root=lambda file_abs, ws: ws,
        spawn=spawn,
    )


class DiagnosticsFeedbackTest(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        await lsp_registry.shutdown_all()
        os.environ.pop("AUTOCODE_LSP_ENABLED", None)

    def _inject_manager(self, workspace_id: str, ws_dir: str) -> None:
        """Pre-seed the registry with a mock-backed manager for this workspace."""
        mgr = LSPManager(ws_dir, servers=[_mock_server_spec(ws_dir)])
        lsp_registry._managers[workspace_id] = mgr

    async def test_feedback_returns_diagnostics_block(self):
        with tempfile.TemporaryDirectory() as d:
            self._inject_manager("ws-fb", d)
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("a = 1\nb = 2\nfoo()\n", encoding="utf-8")
                out = await agent_orchestrator._diagnostics_feedback("ws-fb", Path(d), "mod.py")
                self.assertIn('<diagnostics file="mod.py">', out)
                self.assertIn("ERROR [3:5] undefined name foo", out)
                self.assertTrue(out.startswith("\n\n"))
            finally:
                # Stop the mock subprocess before the temp dir is removed, or
                # Windows refuses to delete the still-open server script.
                await lsp_registry.shutdown_all()

    async def test_feedback_empty_for_autocode_paths(self):
        with tempfile.TemporaryDirectory() as d:
            self._inject_manager("ws-fb", d)
            try:
                out = await agent_orchestrator._diagnostics_feedback(
                    "ws-fb", Path(d), ".autocode/MEMORY.md"
                )
                self.assertEqual(out, "")
            finally:
                await lsp_registry.shutdown_all()

    async def test_feedback_empty_when_no_server_matches(self):
        with tempfile.TemporaryDirectory() as d:
            self._inject_manager("ws-fb", d)
            try:
                target = os.path.join(d, "notes.txt")
                Path(target).write_text("plain text\n", encoding="utf-8")
                out = await agent_orchestrator._diagnostics_feedback("ws-fb", Path(d), "notes.txt")
                self.assertEqual(out, "")
            finally:
                await lsp_registry.shutdown_all()

    async def test_feedback_empty_when_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["AUTOCODE_LSP_ENABLED"] = "0"
            target = os.path.join(d, "mod.py")
            Path(target).write_text("foo()\n", encoding="utf-8")
            out = await agent_orchestrator._diagnostics_feedback("ws-fb", Path(d), "mod.py")
            self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
