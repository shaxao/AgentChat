import unittest
from unittest.mock import patch

from core import config


class ConfigPathTest(unittest.TestCase):
    def test_non_windows_ignores_windows_workspace_base_dir(self):
        with patch.dict("os.environ", {"WORKSPACE_BASE_DIR": "C:/autocode-workspaces"}), patch("sys.platform", "linux"):
            self.assertEqual(config._default_workspace_dir().as_posix(), "/tmp/autocode-workspaces")


if __name__ == "__main__":
    unittest.main()
