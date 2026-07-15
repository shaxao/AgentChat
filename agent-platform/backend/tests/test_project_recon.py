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


if __name__ == "__main__":
    unittest.main()
