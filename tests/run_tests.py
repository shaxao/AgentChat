#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
run_tests.py — 一键运行全量测试并生成报告
用法：
    python run_tests.py              # 运行所有测试
    python run_tests.py --login      # 只运行登录测试
    python run_tests.py --chat       # 只运行聊天测试
    python run_tests.py --admin      # 只运行管理测试
    python run_tests.py --headless   # 无头模式（可选）
"""
import sys
import os
import subprocess
import argparse
import time
from datetime import datetime

# 切换到 tests 目录
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(TESTS_DIR)


def install_deps():
    """安装依赖。"""
    print("📦 安装测试依赖...")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", "requirements.txt", "-q"],
        check=False)


def run_tests(modules: list = None, headless: bool = False, extra_args: list = None):
    """运行测试。"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = f"reports/report_{timestamp}.html"

    cmd = [
        sys.executable, "-m", "pytest",
        "-v",
        "--tb=short",
        f"--html={report_path}",
        "--self-contained-html",
        f"--metadata=RunTime={timestamp}",
        "--metadata=Project=MuhugoChat AI Platform",
    ]

    if modules:
        cmd.extend([f"test_cases/test_{m}.py" for m in modules])
    else:
        cmd.append("test_cases/")

    if extra_args:
        cmd.extend(extra_args)

    # 传递无头模式环境变量
    env = os.environ.copy()
    if headless:
        env["HEADLESS"] = "1"

    print(f"\n🚀 开始运行测试...")
    print(f"📋 命令: {' '.join(cmd)}\n")
    print("=" * 70)

    result = subprocess.run(cmd, env=env, cwd=TESTS_DIR)

    print("\n" + "=" * 70)
    print(f"📊 测试报告: {os.path.abspath(report_path)}")

    if result.returncode == 0:
        print("✅ 所有测试通过！")
    else:
        print("❌ 部分测试失败，请查看报告。")

    return result.returncode


def main():
    parser = argparse.ArgumentParser(description="MuhugoChat 自动化测试运行器")
    parser.add_argument("--login", action="store_true", help="只运行登录测试")
    parser.add_argument("--chat", action="store_true", help="只运行聊天测试")
    parser.add_argument("--admin", action="store_true", help="只运行管理测试")
    parser.add_argument("--subscription", action="store_true", help="只运行订阅测试")
    parser.add_argument("--headless", action="store_true", help="无头模式运行")
    parser.add_argument("--install", action="store_true", help="安装依赖后运行")
    args = parser.parse_args()

    if args.install:
        install_deps()

    modules = []
    if args.login:      modules.append("login")
    if args.chat:       modules.append("chat")
    if args.admin:      modules.append("admin")
    if args.subscription: modules.append("subscription")

    sys.exit(run_tests(modules or None, headless=args.headless))


if __name__ == "__main__":
    main()
