import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from api.workspace_security import safe_child_path
from core.agent_orchestrator import _safe_glob_pattern, _safe_workspace_path
from core.docker_manager import _validate_workspace_command


class WorkspaceSecurityTest(unittest.TestCase):
    def test_agent_file_paths_cannot_escape_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "ok.txt").write_text("ok", encoding="utf-8")

            self.assertEqual(_safe_workspace_path(root, "ok.txt", must_exist=True), (root / "ok.txt").resolve())
            self.assertEqual(_safe_workspace_path(root, "/workspace/ok.txt", must_exist=True), (root / "ok.txt").resolve())

            for path in ("../other/secret.txt", "/etc/passwd", "/workspace/../other/secret.txt"):
                with self.subTest(path=path):
                    with self.assertRaises(PermissionError):
                        _safe_workspace_path(root, path)

    def test_glob_patterns_cannot_escape_workspace(self):
        self.assertEqual(_safe_glob_pattern("/workspace/src/**/*.ts"), "src/**/*.ts")
        self.assertEqual(_safe_glob_pattern("src/**/*.ts"), "src/**/*.ts")

        for pattern in ("../**/*", "/etc/*", "/workspace/../*/secret.txt"):
            with self.subTest(pattern=pattern):
                with self.assertRaises(PermissionError):
                    _safe_glob_pattern(pattern)

    def test_workspace_commands_block_cross_workspace_and_host_paths(self):
        allowed, reason = _validate_workspace_command("npm run build", allow_workspace_absolute=False, allow_tmp_absolute=False)
        self.assertTrue(allowed, reason)

        blocked_commands = [
            "cat /workspace/../ws-other/secret.txt",
            "find / -maxdepth 2",
            "ls /root",
            "grep secret /data/autocode-workspaces/ws-other/file.txt",
            "cat ../ws-other/secret.txt",
        ]
        for command in blocked_commands:
            with self.subTest(command=command):
                allowed, _ = _validate_workspace_command(
                    command,
                    allow_workspace_absolute=False,
                    allow_tmp_absolute=False,
                )
                self.assertFalse(allowed)

    def test_preview_paths_cannot_escape_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            self.assertEqual(safe_child_path(root, "index.html"), root / "index.html")

            for rel_path in ("../secret.txt", "/../secret.txt", "sub/../../secret.txt"):
                with self.subTest(rel_path=rel_path):
                    with self.assertRaises(HTTPException):
                        safe_child_path(root, rel_path)


if __name__ == "__main__":
    unittest.main()
