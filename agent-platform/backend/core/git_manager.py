# -*- coding: utf-8 -*-
"""Git 操作服务 — 基于 GitPython"""
from pathlib import Path
from typing import Optional
from datetime import datetime
import json
import re

from git import Repo, Actor
from loguru import logger

from core.config import get_settings


MAX_DIFF_CHARS = 300_000


def _truncate_diff(diff_text: str) -> str:
    if len(diff_text) <= MAX_DIFF_CHARS:
        return diff_text
    return diff_text[:MAX_DIFF_CHARS] + "\n\n--- diff truncated: output is too large for preview ---\n"


_VOLATILE_AUTOCODE_FILES = {
    ".autocode/MEMORY.md",
    ".autocode/CHAT.md",
    ".autocode/SESSION_SUMMARY.md",
    ".autocode/CONTEXT_SUMMARY.md",
}


def _is_commit_worthy_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lstrip("/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized.startswith(".git/") or normalized == ".git":
        return False
    if normalized in _VOLATILE_AUTOCODE_FILES:
        return False
    return True


def _staged_files(repo: Repo) -> list[str]:
    try:
        return [
            line.strip()
            for line in repo.git.diff("--cached", "--name-only").splitlines()
            if line.strip()
        ]
    except Exception:
        return []


class GitManager:
    """封装 GitPython，提供任务所需的 Git 操作能力"""

    def _configure_identity(self, repo: Repo) -> None:
        settings = get_settings()
        try:
            with repo.config_writer() as writer:
                writer.set_value("user", "name", settings.git_author_name)
                writer.set_value("user", "email", settings.git_author_email)
        except Exception as e:
            logger.debug(f"[Git] configure identity failed: {e}")

    def init(self, path: Path) -> Repo:
        if (path / ".git").exists():
            repo = Repo(path)
            self._configure_identity(repo)
            return repo
        repo = Repo.init(path)
        self._configure_identity(repo)
        logger.info(f"[Git] 仓库初始化: {path}")
        return repo

    def commit(self, path: Path, message: str, author_name: Optional[str] = None) -> str:
        settings = get_settings()
        repo = Repo(path)
        self._configure_identity(repo)
        actor = Actor(
            author_name or settings.git_author_name,
            settings.git_author_email,
        )
        repo.index.commit(
            message,
            author=actor,
            committer=actor,
        )
        commit_hash = repo.head.commit.hexsha[:12]
        logger.info(f"[Git] 提交 {commit_hash}: {message}")
        return commit_hash

    def log(self, path: Path, max_count: int = 20) -> list[dict]:
        try:
            repo = Repo(path)
        except Exception:
            return []
        commits = list(repo.iter_commits(max_count=max_count))
        result = []
        for c in commits:
            # files_changed 对于初始提交可能包含数千个 .git/objects/* 文件
            # 过滤掉 .git/ 目录下的文件，只保留工作空间内的文件，上限 100
            try:
                raw_files = [
                    line.strip()
                    for line in repo.git.show(
                        "--name-only",
                        "--pretty=format:",
                        "--no-renames",
                        c.hexsha,
                    ).splitlines()
                    if line.strip()
                ]
            except Exception:
                raw_files = []
            filtered = [f for f in raw_files if _is_commit_worthy_path(f)]
            message = c.message.strip()
            metadata = None
            match = re.search(r"Autocode-Metadata:\s*(\{.*\})", message, re.S)
            if match:
                try:
                    metadata = json.loads(match.group(1))
                except Exception:
                    metadata = None
            result.append({
                "hash": c.hexsha[:12],
                "message": message.split("\n\nAutocode-Metadata:", 1)[0].strip(),
                "author": c.author.name,
                "date": datetime.fromtimestamp(c.committed_date).isoformat(),
                "files_changed": filtered[:100],
                "metadata": metadata,
            })
        return result

    def diff(self, path: Path, commit_hash: str = "HEAD") -> str:
        repo = Repo(path)
        commit = repo.commit(commit_hash)
        parent = commit.parents[0] if commit.parents else None
        if parent:
            return _truncate_diff(repo.git.diff(parent.hexsha, commit.hexsha))
        return _truncate_diff(repo.git.show("--format=", "--patch", "--no-ext-diff", commit.hexsha))

    def status(self, path: Path) -> dict:
        """Return a UI-friendly working tree status for the workspace."""
        try:
            repo = Repo(path)
        except Exception as e:
            return {
                "available": False,
                "error": str(e),
                "branch": "",
                "head": "",
                "dirty": False,
                "changes": [],
            }

        branch = "detached"
        try:
            branch = repo.active_branch.name
        except Exception:
            pass

        head = ""
        try:
            head = repo.head.commit.hexsha[:12]
        except Exception:
            pass

        changes: list[dict] = []
        try:
            porcelain = repo.git.status("--porcelain=v1").splitlines()
            for line in porcelain:
                if not line:
                    continue
                status_code = line[:2]
                raw_path = line[3:].strip()
                old_path = None
                new_path = raw_path
                if " -> " in raw_path:
                    old_path, new_path = raw_path.split(" -> ", 1)
                if not _is_commit_worthy_path(new_path):
                    continue
                changes.append({
                    "status": status_code.strip() or status_code,
                    "path": new_path,
                    "old_path": old_path,
                    "staged": status_code[0] != " ",
                    "working_tree": status_code[1] != " ",
                })
        except Exception as e:
            logger.warning(f"[Git] status failed: {e}")

        return {
            "available": True,
            "branch": branch,
            "head": head,
            "dirty": bool(changes),
            "changes": changes,
        }

    def working_diff(self, path: Path, staged: bool = False) -> str:
        """Return current working-tree diff. Includes untracked file previews."""
        repo = Repo(path)
        args = ["--cached"] if staged else []
        pathspec = [".", *[f":(exclude){p}" for p in sorted(_VOLATILE_AUTOCODE_FILES)]]
        diff_text = repo.git.diff(*args, "--", *pathspec)
        if staged:
            return _truncate_diff(diff_text)

        untracked = [f for f in repo.untracked_files if _is_commit_worthy_path(f)]
        previews: list[str] = []
        for rel in untracked[:50]:
            file_path = path / rel
            if not file_path.is_file() or file_path.stat().st_size > 200_000:
                previews.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n@@ file omitted: too large or not regular @@\n")
                continue
            try:
                content = file_path.read_text(encoding="utf-8", errors="replace")
                added = "\n".join(f"+{line}" for line in content.splitlines())
                previews.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n@@ untracked file @@\n{added}\n")
            except Exception:
                previews.append(f"diff --git a/{rel} b/{rel}\nnew file mode 100644\n--- /dev/null\n+++ b/{rel}\n@@ file omitted: unreadable @@\n")
        return _truncate_diff("\n".join([diff_text, *previews]).strip())

    def checkout(self, path: Path, commit_hash: str):
        repo = Repo(path)
        repo.git.checkout(commit_hash)
        logger.info(f"[Git] 切换到 {commit_hash[:12]}")

    def reset_to_commit(self, path: Path, commit_hash: str) -> str:
        """Reset the current branch to a commit without leaving detached HEAD."""
        repo = Repo(path)
        self._configure_identity(repo)
        try:
            branch = repo.active_branch.name
        except Exception:
            branch = "master" if "master" in [head.name for head in repo.heads] else ""
            if branch:
                repo.heads[branch].checkout()
        repo.git.reset("--hard", commit_hash)
        logger.info(f"[Git] 回退当前分支到 {commit_hash[:12]}")
        return repo.head.commit.hexsha[:12]

    def current_hash(self, path: Path) -> Optional[str]:
        try:
            repo = Repo(path)
            return repo.head.commit.hexsha[:12]
        except Exception:
            return None

    def list_files(self, path: Path, commit_hash: Optional[str] = None) -> list[str]:
        try:
            repo = Repo(path)
            if commit_hash:
                commit = repo.commit(commit_hash)
                return [item.path for item in commit.tree.traverse()]
            return [str(p.relative_to(path)) for p in path.rglob("*") if p.is_file()]
        except Exception:
            return []

    def branch(self, path: Path, name: str) -> str:
        repo = Repo(path)
        branch = repo.create_head(name)
        repo.heads[name].checkout()
        return name

    def auto_commit(self, path: Path, files: list[str], message: str) -> Optional[str]:
        """自动暂存指定文件并提交"""
        try:
            repo = Repo(path)
            self._configure_identity(repo)
            add_targets = [str(f) for f in (files or ["."])]
            repo.git.add("-A", "--", *add_targets)
            staged_files = _staged_files(repo)
            excluded_files = [p for p in staged_files if not _is_commit_worthy_path(p)]
            if excluded_files:
                try:
                    repo.git.reset("--", *excluded_files)
                except Exception:
                    pass
                staged_files = _staged_files(repo)
            if staged_files and not any(_is_commit_worthy_path(p) for p in staged_files):
                try:
                    repo.git.reset("--", *staged_files)
                except Exception:
                    pass
                logger.info(f"[Git] 跳过仅包含运行记忆文件的自动提交: {message}")
                return None
            if not staged_files:
                logger.info(f"[Git] 跳过空自动提交: {message}")
                return None
            return self.commit(path, message)
        except Exception as e:
            logger.warning(f"[Git] 自动提交失败: {e}")
            return None


git_manager = GitManager()
