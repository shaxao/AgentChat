# -*- coding: utf-8 -*-
"""P1 tests for the LSP JSON-RPC client.

Uses a self-contained mock language server (a Python script that speaks the
LSP framing over stdio) so the tests need no real pyright/gopls binary. The
mock echoes an initialize result, answers a couple of requests, and pushes
diagnostics on didOpen.
"""
import asyncio
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from runtime.lsp.lsp_client import (
    LSPClient,
    SEVERITY_ERROR,
    path_to_uri,
    uri_to_path,
)


# A mock LSP server: reads Content-Length framed JSON-RPC on stdin, replies on
# stdout. Handles initialize, textDocument/definition, textDocument/hover, and
# emits publishDiagnostics after didOpen.
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
        body = sys.stdin.buffer.read(length)
        return json.loads(body.decode("utf-8"))

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
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "capabilities": {"textDocumentSync": 1}
            }})
        elif method == "initialized":
            pass
        elif method == "textDocument/didOpen":
            uri = msg["params"]["textDocument"]["uri"]
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                  "params": {"uri": uri, "diagnostics": [
                      {"severity": 1, "message": "mock error",
                       "range": {"start": {"line": 2, "character": 4},
                                 "end": {"line": 2, "character": 9}}}
                  ]}})
        elif method == "textDocument/definition":
            send({"jsonrpc": "2.0", "id": mid, "result": [
                {"uri": msg["params"]["textDocument"]["uri"],
                 "range": {"start": {"line": 0, "character": 0},
                           "end": {"line": 0, "character": 3}}}
            ]})
        elif method == "textDocument/hover":
            send({"jsonrpc": "2.0", "id": mid,
                  "result": {"contents": "mock hover"}})
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": mid, "result": None})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": None})
    '''
)


class URIHelpersTest(unittest.TestCase):
    def test_path_uri_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "sample.py")
            Path(p).write_text("x = 1\n", encoding="utf-8")
            uri = path_to_uri(p)
            self.assertTrue(uri.startswith("file://"))
            self.assertEqual(os.path.normpath(uri_to_path(uri)), os.path.normpath(p))

    def test_uri_to_path_rejects_non_file(self):
        self.assertIsNone(uri_to_path("http://example.com/x"))


class LSPClientMockServerTest(unittest.IsolatedAsyncioTestCase):
    async def _spawn_client(self, root: str) -> LSPClient:
        script_path = os.path.join(root, "_mock_server.py")
        Path(script_path).write_text(MOCK_SERVER, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, script_path,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=root,
        )
        return await LSPClient.create("mock", root, proc)

    async def test_initialize_and_definition(self):
        with tempfile.TemporaryDirectory() as d:
            client = await self._spawn_client(d)
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("def foo():\n    return 1\n", encoding="utf-8")
                result = await client.request("textDocument/definition", {
                    "textDocument": {"uri": path_to_uri(target)},
                    "position": {"line": 0, "character": 4},
                })
                self.assertIsInstance(result, list)
                self.assertEqual(len(result), 1)
            finally:
                await client.shutdown()

    async def test_hover_request(self):
        with tempfile.TemporaryDirectory() as d:
            client = await self._spawn_client(d)
            try:
                target = os.path.join(d, "mod.py")
                Path(target).write_text("x = 1\n", encoding="utf-8")
                result = await client.request("textDocument/hover", {
                    "textDocument": {"uri": path_to_uri(target)},
                    "position": {"line": 0, "character": 0},
                })
                self.assertIsInstance(result, dict)
                self.assertIn("contents", result)
            finally:
                await client.shutdown()

    async def test_open_file_pushes_diagnostics(self):
        with tempfile.TemporaryDirectory() as d:
            client = await self._spawn_client(d)
            try:
                target = os.path.join(d, "broken.py")
                Path(target).write_text("def x(:\n    pass\n", encoding="utf-8")
                version = await client.open_file(target)
                self.assertEqual(version, 0)
                await client.wait_for_diagnostics(target, timeout=3)
                diags = client.diagnostics_for(target)
                self.assertEqual(len(diags), 1)
                self.assertEqual(diags[0].severity, SEVERITY_ERROR)
                self.assertEqual(diags[0].message, "mock error")
                self.assertEqual(diags[0].line, 2)
                self.assertEqual(diags[0].character, 4)
            finally:
                await client.shutdown()

    async def test_shutdown_is_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            client = await self._spawn_client(d)
            await client.shutdown()
            await client.shutdown()  # must not raise


if __name__ == "__main__":
    unittest.main()
