from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from runtime.context_manager import RuntimeContext, context_manager
from runtime.permission_engine import PermissionDecision, permission_engine
from runtime.session_events import append_event
from runtime.tool_registry import tool_registry


@dataclass
class AgentDecision:
    action: str
    confidence: float = 0.0
    answer: str = ""
    path: str | None = None
    line: int | None = None
    command: str | None = None
    target: str | None = None
    raw: dict | None = None


@dataclass
class ToolExecutionRecord:
    event_id: str
    tool: str
    args: dict
    role: str


def _normalize_tool_policy(value: Any) -> str:
    policy = str(value or "full_access").strip().lower()
    aliases = {
        "ask": "ask",
        "manual": "ask",
        "request_approval": "ask",
        "auto": "auto_safe",
        "auto_safe": "auto_safe",
        "approve_safe": "auto_safe",
        "risk_only": "auto_safe",
        "full": "full_access",
        "full_access": "full_access",
        "yolo": "full_access",
    }
    return aliases.get(policy, "full_access")


def _apply_task_tool_policy(decision: PermissionDecision, policy: str) -> PermissionDecision:
    if policy == "ask":
        return decision
    if decision.approval_payload.get("high_risk") or decision.approval_payload.get("destructive"):
        return PermissionDecision(
            "ask",
            reason=f"high-risk operation requires manual approval: {decision.reason}",
            tool=decision.tool,
            risk_level=max(decision.risk_level, 4),
            approval_payload={
                **decision.approval_payload,
                "manual_required": True,
                "auto_approve_after_seconds": 0,
            },
        )
    if policy == "full_access":
        spec = tool_registry.get(decision.tool)
        if spec and spec.requires_confirmation:
            return PermissionDecision(
                "ask",
                reason=f"task tool policy full_access auto-approves after countdown: {decision.reason}",
                tool=decision.tool,
                risk_level=decision.risk_level,
                approval_payload={
                    **decision.approval_payload,
                    "auto_approve_after_seconds": 5,
                    "manual_required": False,
                },
            )
        return PermissionDecision(
            "allow",
            reason=f"task tool policy full_access auto-approved: {decision.reason}",
            tool=decision.tool,
            risk_level=decision.risk_level,
            approval_payload=decision.approval_payload,
        )
    if policy == "auto_safe":
        return PermissionDecision(
            "allow",
            reason=f"task tool policy auto_safe auto-approved: {decision.reason}",
            tool=decision.tool,
            risk_level=decision.risk_level,
            approval_payload=decision.approval_payload,
        )
    return decision


class AgentLoop:
    """Small runtime facade for conversation-driven AutoCode control.

    The current orchestrator still owns the heavy implementation flow.  This
    class gives both chat and task execution a common path for context loading,
    events, permission checks, and future tool execution.
    """

    def __init__(self, llm_factory: Callable[..., Any] | None = None) -> None:
        self.llm_factory = llm_factory

    def build_context(self, task: dict, workspace_root: Path | None = None) -> RuntimeContext:
        return context_manager.build(task=task, workspace_root=workspace_root)

    async def decide_chat_action(
        self,
        *,
        task: dict,
        message: str,
        llm: Any,
        workspace_root: Path | None = None,
        request_ip: str | None = None,
    ) -> AgentDecision:
        context = self.build_context(task, workspace_root)
        append_event(
            task,
            "user_message",
            {"content": message, "request_ip": request_ip},
            source="user",
        )
        append_event(
            task,
            "agent_observation",
            {
                "status": task.get("status"),
                "current_step": task.get("current_step"),
                "workspace_id": task.get("workspace_id"),
                "context_items": len(context.files) + len((context.manifest or {}).get("sources") or []),
                "system_context_epoch": context.epoch,
                "message_preview": message[:500],
            },
            source="chat_controller",
        )

        system = self._controller_system_prompt()
        prompt = (
            f"{context.to_prompt()}\n\n"
            f"## User Message\n{message}\n\n"
            "Return one JSON object only."
        )
        response = await llm.chat(
            messages=[{"role": "user", "content": prompt}],
            system=system,
            temperature=0,
            max_tokens=1600,
        )
        data = self._parse_json(response.content or "")
        decision = self._decision_from_dict(data)
        append_event(
            task,
            "agent_decision",
            {"decision": decision.raw or data},
            source="chat_controller",
        )
        append_event(
            task,
            "agent_action_selected",
            {
                "action": decision.action,
                "confidence": decision.confidence,
                "path": decision.path,
                "line": decision.line,
                "command": decision.command,
                "target": decision.target,
                "answer_preview": decision.answer[:500] if decision.answer else "",
            },
            source="chat_controller",
        )
        return decision

    def check_tool_permission(
        self,
        *,
        task: dict,
        tool_name: str,
        args: dict | None = None,
        role: str = "agent",
        workspace_root: Path | None = None,
    ) -> PermissionDecision:
        decision = permission_engine.check(tool_name, args or {}, role=role, workspace_root=workspace_root)
        policy = _normalize_tool_policy(task.get("tool_policy"))
        original_decision = decision.decision
        if decision.decision == "ask":
            decision = _apply_task_tool_policy(decision, policy)
        append_event(
            task,
            "permission_checked",
            {
                "tool": tool_name,
                "decision": decision.decision,
                "original_decision": original_decision,
                "task_tool_policy": policy,
                "reason": decision.reason,
                "risk_level": decision.risk_level,
                "approval_payload": decision.approval_payload,
            },
            source="permission_engine",
        )
        return decision

    def begin_tool_call(
        self,
        *,
        task: dict,
        tool_name: str,
        args: dict | None = None,
        role: str = "agent",
    ) -> ToolExecutionRecord:
        event = append_event(
            task,
            "tool_call",
            {"tool": tool_name, "args": args or {}, "agent": role},
            source=role,
        )
        return ToolExecutionRecord(
            event_id=str(event.get("id") or ""),
            tool=tool_name,
            args=args or {},
            role=role,
        )

    def finish_tool_call(
        self,
        *,
        task: dict,
        record: ToolExecutionRecord | None,
        result: Any,
        ok: bool = True,
    ) -> None:
        append_event(
            task,
            "tool_result",
            {
                "tool": record.tool if record else "",
                "args": record.args if record else {},
                "agent": record.role if record else "agent",
                "ok": ok,
                "result": str(result)[:8000],
                "tool_call_event_id": record.event_id if record else None,
            },
            source=record.role if record else "agent",
        )

    def _parse_json(self, raw: str) -> dict:
        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I).strip()
            text = re.sub(r"\s*```$", "", text).strip()
        try:
            data = json.loads(text)
        except Exception:
            data = {"action": "answer", "answer": text[:2000], "confidence": 0.2}
        return data if isinstance(data, dict) else {"action": "answer", "answer": str(data)}

    def _decision_from_dict(self, data: dict) -> AgentDecision:
        raw_action = str(data.get("action") or "answer").strip()
        normalized_action = re.sub(r"[\s-]+", "_", raw_action).strip().lower()
        aliases = {
            "openfile": "open_file",
            "open": "open_file",
            "show_file": "open_file",
            "view_file": "open_file",
            "git": "show_git",
            "git_diff": "show_git",
            "show_diff": "show_git",
            "view_diff": "show_git",
            "run_tests": "run_command",
            "run_test": "run_command",
            "test": "run_command",
            "run_build": "run_command",
            "build": "run_command",
            "pipeline": "run_pipeline",
            "run_ci": "run_pipeline",
            "ci": "run_pipeline",
            "continue": "continue_development",
            "modify": "continue_development",
            "edit": "continue_development",
            "fix": "continue_development",
            "implement": "continue_development",
            "apply_changes": "continue_from_diff",
            "continue_diff": "continue_from_diff",
            "revert": "rollback_confirm",
            "rollback_to": "rollback_confirm",
            "confirm_rollback": "rollback",
            "confirm_revert": "rollback",
            "usage": "answer_usage",
            "how_to_use": "answer_usage",
        }
        action = aliases.get(normalized_action, normalized_action)
        allowed = {
            "answer",
            "answer_usage",
            "open_file",
            "show_git",
            "run_command",
            "run_pipeline",
            "rollback_confirm",
            "rollback",
            "continue_from_diff",
            "continue_development",
            "ask_user",
        }
        if action not in allowed:
            action = "answer"
        line = data.get("line")
        try:
            line = int(line) if line is not None else None
        except Exception:
            line = None
        confidence = data.get("confidence", 0)
        try:
            confidence = float(confidence or 0)
        except Exception:
            confidence = 0.0
        command = str(data.get("command")) if data.get("command") else None
        if action == "run_command" and not command:
            if normalized_action in {"run_tests", "run_test", "test"}:
                command = "test"
            elif normalized_action in {"run_build", "build"}:
                command = "build"

        return AgentDecision(
            action=action,
            confidence=confidence,
            answer=str(data.get("answer") or ""),
            path=str(data.get("path")) if data.get("path") else None,
            line=line,
            command=command,
            target=str(data.get("target")) if data.get("target") else None,
            raw=data,
        )

    def _controller_system_prompt(self) -> str:
        return (
            "You are the AutoCode IDE controller for an agentic coding workspace. "
            "Your job is not to match fixed commands; infer the user's intent from natural language, "
            "the current task state, workspace context, reviews, commands, and changed files. "
            "Choose exactly one next action and use Chinese for every user-facing answer. "
            "\n\n"
            "Default posture: if the user expresses a desired product behavior, new capability, defect, "
            "UI/UX problem, acceptance feedback, performance/security concern, missing file, wrong output, "
            "or any request that should change code, docs, tests, configuration, or project files, choose "
            "continue_development. This includes vague-but-actionable feedback such as '这里不对', "
            "'效果不好', '加一个导出能力', '移动端有问题', or '按这个思路继续'. Do not require the user "
            "to say fixed words like modify/add/implement. "
            "If the user lists concrete functions, files, properties, error messages, review findings, or "
            "code symbols, infer that they want the workspace changed and choose continue_development unless "
            "they explicitly ask only for explanation. "
            "\n\n"
            "Choose answer only when the user is clearly asking for explanation, status, concepts, or discussion "
            "without asking the workspace to change. Choose answer_usage when the user asks how to use/run the "
            "generated project/tool. Choose open_file/show_git/run_command/run_pipeline/rollback_confirm when "
            "the user asks for that concrete IDE control action. For exact shell commands, put the command text "
            "in command; for generic tests/build use command='test' or command='build'. Choose continue_from_diff "
            "when the user asks to continue based on the current diff or review findings. "
            "\n\n"
            "For continue_development, the answer should be a short acknowledgement that you will analyze the "
            "current workspace, make the necessary changes, validate, and snapshot. Do not output a generic menu "
            "of things the user can ask for when the message is actionable. "
            "Return JSON only with fields: action, confidence, answer, path, line, command, target."
        )


agent_loop = AgentLoop()
