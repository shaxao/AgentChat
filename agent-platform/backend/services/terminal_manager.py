# -*- coding: utf-8 -*-
"""WebSocket Terminal Manager — Cross-platform PTY / subprocess support"""
import asyncio
import locale
import os
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from typing import Optional, Literal

from fastapi import WebSocket
from loguru import logger

# PTY only available on Unix
_is_unix = sys.platform != "win32"

if _is_unix:
    import pty
    import select


# ─── 编码辅助（Windows 子进程输出 GBK → 正确解码）──────────
def _local_encoding() -> str:
    """返回本地子进程输出的编码，Windows 使用 GBK"""
    if sys.platform == "win32":
        try:
            return locale.getpreferredencoding() or "gbk"
        except Exception:
            return "gbk"
    return "utf-8"


def _decode_output(data: bytes) -> str:
    """解码子进程输出，自动处理 GBK/UTF-8 编码"""
    enc = _local_encoding()
    try:
        return data.decode(enc)
    except (UnicodeDecodeError, LookupError):
        return data.decode("utf-8", errors="replace")


@dataclass
class TerminalSession:
    workspace_id: str
    process: subprocess.Popen
    cwd: str
    master_fd: Optional[int] = None  # Unix only
    ws: Optional[WebSocket] = None
    read_task: Optional[asyncio.Task] = None


class TerminalManager:
    """
    Cross-platform terminal session manager.

    Unix  : real PTY via pty.openpty() + bash
    Windows: subprocess with cmd.exe, output streamed via pipe reader

    Both modes support WebSocket bidirectional forwarding so the user
    sees live output and can type interactively.
    """

    def __init__(self):
        self.active_sessions: dict[str, TerminalSession] = {}

    async def connect(self, ws: WebSocket, workspace_id: str):
        await ws.accept()
        session = self.active_sessions.get(workspace_id)
        if session:
            session.ws = ws
            # Kick off the Windows pipe reader now that ws is set
            if not _is_unix and session.read_task is None:
                session.read_task = asyncio.create_task(self._read_windows_loop(session))

    async def disconnect(self, workspace_id: str):
        session = self.active_sessions.pop(workspace_id, None)
        if session:
            await self._cleanup_session(session)

    async def cleanup_all(self):
        for ws_id in list(self.active_sessions.keys()):
            await self.disconnect(ws_id)

    # ── Unix PTY ──────────────────────────────────────────────────────────────

    def start_session(self, workspace_id: str, cwd: str) -> TerminalSession:
        if not _is_unix:
            return self._start_windows(workspace_id, cwd)

        master_fd, slave_fd = pty.openpty()

        proc = subprocess.Popen(
            ["bash", "-li"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=cwd,
            start_new_session=True,
        )
        os.close(slave_fd)

        session = TerminalSession(
            workspace_id=workspace_id,
            master_fd=master_fd,
            process=proc,
            cwd=cwd,
        )
        self.active_sessions[workspace_id] = session
        session.read_task = asyncio.create_task(self._read_pty_loop(session))

        logger.info(f"[Terminal] PTY session started: {workspace_id}")
        return session

    async def _read_pty_loop(self, session: TerminalSession):
        """
        PTY 读取循环。

        ⚠️ 关键：select.select() 和 os.read() 都是同步阻塞调用，
        不能直接在 async 函数里跑——会卡死整个 asyncio 事件循环，
        导致 FastAPI 所有 HTTP 请求超时无响应。

        必须用 asyncio.to_thread() 把它们扔到线程池执行，
        每个 to_thread 之间用 await asyncio.sleep(0) 让出控制权。
        """
        loop = asyncio.get_event_loop()
        while True:
            try:
                # 同步阻塞操作放线程池，不卡事件循环
                ready = await asyncio.to_thread(
                    select.select, [session.master_fd], [], [], 0.1
                )
                if session.master_fd in ready[0]:
                    # os.read 也可能阻塞，同样放线程池
                    data = await asyncio.to_thread(os.read, session.master_fd, 4096)
                    if not data:
                        break
                    if session.ws:
                        try:
                            await session.ws.send_text(
                                _decode_output(data)
                            )
                        except Exception:
                            break
                # 让出控制权给事件循环（处理其他 HTTP 请求/任务）
                await asyncio.sleep(0)
                if session.process.poll() is not None:
                    break
            except (OSError, ValueError):
                break
        await self._cleanup_session(session)

    # ── Windows subprocess ────────────────────────────────────────────────────

    def _start_windows(self, workspace_id: str, cwd: str) -> TerminalSession:
        # Use cmd.exe with ENABLE_VIRTUAL_TERMINAL_PROCESSING for ANSI colors
        kwargs = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT,
                  "cwd": cwd, "env": os.environ.copy(), "bufsize": 0}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

        proc = subprocess.Popen(["cmd.exe"], **kwargs)

        session = TerminalSession(
            workspace_id=workspace_id,
            process=proc,
            cwd=cwd,
        )
        self.active_sessions[workspace_id] = session

        # Initial welcome banner
        asyncio.create_task(self._send_welcome(session))

        logger.info(f"[Terminal] Windows session started: {workspace_id}")
        return session

    async def _send_welcome(self, session: TerminalSession):
        banner = (
            "\r\n=== Agent Workspace Terminal (Windows) ===\r\n"
            f"Working directory: {session.cwd}\r\n"
            "Type commands or let the Agent execute them automatically.\r\n\r\n"
        )
        if session.ws:
            try:
                await session.ws.send_text(banner)
            except Exception:
                pass

    async def _read_windows_loop(self, session: TerminalSession):
        """Read subprocess stdout in a loop and forward to WebSocket."""
        loop = asyncio.get_event_loop()
        proc: subprocess.Popen = session.process

        try:
            while True:
                # Read with timeout so we can check if process died
                line = await loop.run_in_executor(None, proc.stdout.readline)
                if not line:
                    break
                if session.ws:
                    try:
                        await session.ws.send_text(_decode_output(line))
                    except Exception:
                        break
                # Check if process exited
                if proc.poll() is not None:
                    if session.ws:
                        try:
                            await session.ws.send_text(
                                f"\r\n[Process exited with code {proc.returncode}]\r\n"
                            )
                        except Exception:
                            pass
                    break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"[Terminal] Windows read error: {e}")
        finally:
            await self._cleanup_session(session)

    async def send_command(self, workspace_id: str, command: str):
        """Send a command to the terminal session."""
        session = self.active_sessions.get(workspace_id)
        if not session:
            raise RuntimeError(f"No terminal session for {workspace_id}")

        if _is_unix:
            if session.master_fd is not None:
                os.write(session.master_fd, (command + "\n").encode())
        else:
            proc: subprocess.Popen = session.process
            if proc.stdin and proc.poll() is None:
                proc.stdin.write((command + "\r\n").encode())
                proc.stdin.flush()

    async def handle_input(self, workspace_id: str, data: str):
        """Forward raw user keyboard input to the terminal."""
        session = self.active_sessions.get(workspace_id)
        if not session:
            return
        if _is_unix:
            if session.master_fd is not None:
                os.write(session.master_fd, data.encode())
        else:
            proc: subprocess.Popen = session.process
            if proc.stdin and proc.poll() is None:
                proc.stdin.write(data.encode())
                proc.stdin.flush()

    # ── Cleanup ─────────────────────────────────────────────────────────────

    async def _cleanup_session(self, session: TerminalSession):
        if session.read_task:
            session.read_task.cancel()
            try:
                await session.read_task
            except asyncio.CancelledError:
                pass

        if _is_unix:
            if session.master_fd is not None:
                try:
                    os.close(session.master_fd)
                except OSError:
                    pass
        else:
            proc: subprocess.Popen = session.process
            if proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=3)
                except Exception:
                    proc.kill()

        logger.info(f"[Terminal] Session cleaned: {session.workspace_id}")


terminal_manager = TerminalManager()
