from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from runtime.tool_registry import ToolSpec, tool_registry


Decision = Literal["allow", "ask", "deny"]


@dataclass
class PermissionDecision:
    decision: Decision
    reason: str = ""
    tool: str = ""
    risk_level: int = 0
    approval_payload: dict = field(default_factory=dict)

    @property
    def allowed(self) -> bool:
        return self.decision == "allow"

    @property
    def needs_approval(self) -> bool:
        return self.decision == "ask"


def is_destructive_command(command: str) -> bool:
    compact = re.sub(r"\s+", " ", command or "").strip().lower()
    if not compact:
        return False
    return bool(re.search(r"(^|[;&|]\s*|\s)(rm|del|rmdir|remove-item|git\s+clean|git\s+reset)\b", compact))


def is_forbidden_destructive_command(command: str) -> bool:
    compact = re.sub(r"\s+", " ", command or "").strip().lower()
    if not compact:
        return False
    dangerous_roots = (
        r"rm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(/|\\|~|\$home|\$env:userprofile|c:\\)",
        r"del\s+(/s|/q).*(c:\\|\\|\*)",
        r"rmdir\s+(/s|/q).*(c:\\|\\|\*)",
        r"remove-item\b.*(-recurse|-r)\b.*(-force|-f)\b",
        r"git\s+reset\s+--hard\b",
        r"git\s+clean\b.*(-f|-force)",
    )
    return any(re.search(pattern, compact) for pattern in dangerous_roots)


def _default_tool_policy() -> dict[str, str]:
    return {spec.name: spec.permission_default for spec in tool_registry.list()}


DEFAULT_POLICY = _default_tool_policy()

DEFAULT_BASH_POLICY = {
    "pwd": "allow",
    "ls*": "allow",
    "find*": "allow",
    "grep*": "allow",
    "cat*": "allow",
    "sed*": "allow",
    "python --version*": "allow",
    "node --version*": "allow",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "mkdir -p /workspace*": "allow",
    "mkdir -p [A-Za-z0-9._/-]*": "allow",
    "mkdir [A-Za-z0-9._/-]*": "allow",
    "npm install*": "allow",
    "npm test*": "allow",
    "npm run test*": "allow",
    "npm run build*": "allow",
    "pnpm install*": "allow",
    "pnpm test*": "allow",
    "pnpm build*": "allow",
    "yarn install*": "allow",
    "yarn test*": "allow",
    "yarn build*": "allow",
    "pip install -r requirements.txt*": "allow",
    "pytest*": "allow",
    "python -m py_compile*": "allow",
    "python -m compileall*": "allow",
    "mvn test*": "allow",
    "mvn -DskipTests package*": "allow",
    "go test*": "allow",
    "git push*": "ask",
    "curl*": "deny",
    "wget*": "deny",
    "scp*": "deny",
    "ssh*": "deny",
    "sudo*": "deny",
    "rm -rf*": "ask",
    "rm -fr*": "ask",
    "rm *": "ask",
    "del *": "ask",
    "rmdir *": "ask",
    "remove-item*": "ask",
    "git reset --hard*": "ask",
    "git clean*": "ask",
}


class PermissionEngine:
    def __init__(self, policy: dict | None = None) -> None:
        policy = policy or {}
        self.tool_policy = {**DEFAULT_POLICY, **(policy.get("tools") or {})}
        self.bash_policy = {**DEFAULT_BASH_POLICY, **(policy.get("bash") or {})}
        self.role_policy = policy.get("roles") or {}

    def check(
        self,
        tool_name: str,
        args: dict | None = None,
        *,
        role: str = "agent",
        workspace_root: Path | None = None,
    ) -> PermissionDecision:
        args = args or {}
        spec = tool_registry.get(tool_name) or ToolSpec(
            name=tool_name,
            description="Unregistered tool",
            permission_default="ask",
            risk_level=3,
        )

        role_decision = self._check_role(spec, role)
        if role_decision:
            return role_decision

        path_decision = self._check_workspace_path(spec, args, workspace_root)
        if path_decision:
            return path_decision

        if tool_name in ("bash", "run_command"):
            command = str(args.get("command") or "")
            if is_forbidden_destructive_command(command):
                return PermissionDecision(
                    "deny",
                    reason=f"forbidden destructive command: {command}",
                    tool=tool_name,
                    risk_level=max(spec.risk_level, 4),
                    approval_payload={"command": command, "high_risk": True, "destructive": True},
                )
            bash_decision = self._check_bash(str(args.get("command") or ""))
            if bash_decision:
                return PermissionDecision(
                    bash_decision,
                    reason=f"bash policy matched command: {args.get('command')}",
                    tool=tool_name,
                    risk_level=max(spec.risk_level, 4) if is_destructive_command(command) else spec.risk_level,
                    approval_payload={
                        "command": args.get("command"),
                        "high_risk": is_destructive_command(command),
                        "destructive": is_destructive_command(command),
                    },
                )

        configured = self.tool_policy.get(tool_name, spec.permission_default)
        if configured not in ("allow", "ask", "deny"):
            configured = spec.permission_default
        return PermissionDecision(
            configured,
            reason=f"tool policy: {configured}",
            tool=tool_name,
            risk_level=spec.risk_level,
            approval_payload={"tool": tool_name, "args": args},
        )

    def _check_role(self, spec: ToolSpec, role: str) -> PermissionDecision | None:
        if "all" in spec.allowed_roles or role in spec.allowed_roles:
            return None
        return PermissionDecision("deny", f"role {role} cannot use {spec.name}", spec.name, spec.risk_level)

    def _check_workspace_path(
        self,
        spec: ToolSpec,
        args: dict,
        workspace_root: Path | None,
    ) -> PermissionDecision | None:
        if spec.side_effect not in ("read", "write"):
            return None
        raw_path = str(args.get("path") or args.get("target") or "").strip()
        if not raw_path or workspace_root is None:
            return None
        if re.search(r"(^|[\\/])\\.\\.($|[\\/])", raw_path.replace("\\", "/")):
            return PermissionDecision("deny", "parent directory traversal is not allowed", spec.name, spec.risk_level)
        try:
            root = workspace_root.resolve()
            candidate = (root / raw_path.lstrip("/\\")).resolve(strict=False)
            if root not in (candidate, *candidate.parents):
                return PermissionDecision("deny", "path escapes current workspace", spec.name, spec.risk_level)
        except Exception as exc:
            return PermissionDecision("deny", f"path validation failed: {exc}", spec.name, spec.risk_level)
        return None

    def _check_bash(self, command: str) -> Decision | None:
        compact = re.sub(r"\s+", " ", command or "").strip().lower()
        if not compact:
            return "deny"
        if re.search(r"(^|[\s/\\])\.\.($|[\s/\\])", compact.replace("\\", "/")):
            return "deny"
        for pattern, decision in self.bash_policy.items():
            if fnmatch.fnmatch(compact, pattern):
                return decision if decision in ("allow", "ask", "deny") else "ask"
        return None


permission_engine = PermissionEngine()
