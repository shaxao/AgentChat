#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Windows protocol launcher for AutoCode Local Connector.

This file is intended to be packaged with PyInstaller into a single exe. Users
do not need Python installed. The launcher accepts a muhuo-autocode://connect
URL, asks for a project folder when needed, then delegates to the mature
autocode_local_runner implementation.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse


def _repo_runner_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "backend" / "local_runner"


def _bundle_runner_dir() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


for candidate in (_bundle_runner_dir(), _repo_runner_dir()):
    if candidate.exists():
        sys.path.insert(0, str(candidate))

try:
    import autocode_local_runner as runner
except Exception as exc:  # pragma: no cover - shown to users in launcher console
    raise SystemExit(f"无法加载 AutoCode Local Runner：{exc}") from exc


def parse_launch_url(raw: str) -> dict[str, str]:
    parsed = urlparse(raw)
    if parsed.scheme != "muhuo-autocode":
        raise SystemExit("这不是 AutoCode 本地连接链接")
    values = {key: items[0] for key, items in parse_qs(parsed.query).items() if items}
    missing = [key for key in ("server", "session", "token") if not values.get(key)]
    if missing:
        raise SystemExit(f"连接链接缺少参数：{', '.join(missing)}")
    return values


def choose_project_dir(initial: str = "") -> str:
    project = (initial or "").strip()
    if project and project != "<你的项目目录>":
        return project
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        selected = filedialog.askdirectory(title="选择授权给 AutoCode 的项目目录")
        root.destroy()
        if selected:
            return selected
    except Exception:
        pass
    raise SystemExit("未选择项目目录，已取消连接")


def namespace_from_values(values: dict[str, str]) -> SimpleNamespace:
    project = choose_project_dir(values.get("project", ""))
    return SimpleNamespace(
        server=values["server"],
        session=values["session"],
        token=values["token"],
        project=project,
        ws_url="",
        reconnect=True,
        retry_min=1.0,
        retry_max=30.0,
        heartbeat_interval=20,
        ping_interval=None,
        ping_timeout=None,
        open_timeout=20,
        command_timeout=120,
        max_output=20000,
    )


def install_self() -> None:
    if os.name != "nt":
        raise SystemExit("当前安装器仅支持 Windows")
    import winreg

    install_dir = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AutoCodeLocalConnector"
    install_dir.mkdir(parents=True, exist_ok=True)
    target = install_dir / "AutoCodeLocalConnector.exe"
    source = Path(sys.executable).resolve()
    if source != target.resolve():
        shutil.copy2(source, target)

    protocol_key = r"Software\Classes\muhuo-autocode"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, protocol_key) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "URL:AutoCode Local Connector")
        winreg.SetValueEx(key, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, protocol_key + r"\DefaultIcon") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f'"{target}",0')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, protocol_key + r"\shell\open\command") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, f'"{target}" "%1"')

    print("AutoCode Local Connector 已安装。")
    print("现在可以回到网页点击“一键连接本地项目”。")
    print(f"安装位置：{target}")
    try:
        input("按回车键关闭窗口...")
    except EOFError:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="AutoCode Local Connector")
    parser.add_argument("launch_url", nargs="?", help="muhuo-autocode://connect?...")
    parser.add_argument("--server", default="")
    parser.add_argument("--session", default="")
    parser.add_argument("--token", default="")
    parser.add_argument("--project", default="")
    args = parser.parse_args()

    if args.launch_url:
        runner_args = namespace_from_values(parse_launch_url(args.launch_url))
    elif args.server and args.session and args.token:
        runner_args = namespace_from_values({
            "server": args.server,
            "session": args.session,
            "token": args.token,
            "project": args.project,
        })
    else:
        install_self()
        return

    asyncio.run(runner.run(runner_args))


if __name__ == "__main__":
    main()
