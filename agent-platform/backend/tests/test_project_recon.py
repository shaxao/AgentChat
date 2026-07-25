import tempfile
import unittest
from pathlib import Path

from core.project_recon import run_project_recon


class ProjectReconTests(unittest.TestCase):
    def test_enterprise_nextjs_website_is_frontend_not_light_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            recon = run_project_recon(
                ws,
                declared_type="nextjs",
                description="企业官网，包含首页、产品介绍、关于我们、联系我们页面 NEXT.JS+Ts",
            )

        self.assertEqual(recon["project_kind"], "frontend")
        self.assertEqual(recon["complexity"], "S2")
        self.assertEqual(recon["recommended_flow"], "standard")
        self.assertTrue(recon["should_generate_prototype"])

    def test_small_script_request_stays_light_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            recon = run_project_recon(
                ws,
                declared_type="tool",
                description="Excel 数据处理脚本，读取、清洗并导出 CSV",
            )

        self.assertEqual(recon["project_kind"], "script")
        self.assertEqual(recon["recommended_flow"], "light_script")

    def test_surface_map_detects_runtime_and_docs_surfaces(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp)
            for rel in [
                "docs/index.html",
                "ui/templates/index.html",
                "ui/web_app.py",
                "ui/config_store.py",
                "api/server.py",
                "wx4Auto/wx4py/_internal/ui/web_app.py",
            ]:
                path = ws / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("print('ok')\n", encoding="utf-8")

            recon = run_project_recon(
                ws,
                declared_type="python",
                description="软件页面没有看到添加的功能，需要检查 pywebview/flask GUI",
            )

            surface_map = recon["surface_map"]
            self.assertIn("docs/index.html", surface_map["docs_site"])
            self.assertIn("ui/templates/index.html", surface_map["app_gui"])
            self.assertIn("ui/web_app.py", surface_map["app_gui"])
            self.assertIn("api/server.py", surface_map["backend_api"])
            self.assertIn("ui/config_store.py", surface_map["config_store"])
            self.assertIn("wx4Auto/wx4py/_internal/ui/web_app.py", surface_map["package_source"])
            self.assertTrue((ws / ".autocode" / "SURFACE_MAP.md").exists())
            self.assertIn("app_gui", (ws / ".autocode" / "SURFACE_MAP.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
