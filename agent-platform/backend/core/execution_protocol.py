import mimetypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PROTOCOL_VERSION = 1

# These are execution shapes, not project/language/file-format types. Unknown
# task families and artifact formats remain valid and use generic contracts.
EXECUTION_INTENTS = {
    "answer_only",
    "workspace_action",
    "ide_action",
    "artifact_creation",
    "light_local_file_task",
    "code_development",
    "run_command",
    "pipeline",
    "review_only",
}

_INTENT_ALIASES = {
    "answer": "answer_only",
    "artifact": "artifact_creation",
    "create_artifact": "artifact_creation",
    "document_creation": "artifact_creation",
    "spreadsheet": "artifact_creation",
    "presentation": "artifact_creation",
    "image_generation": "artifact_creation",
    "development": "code_development",
    "command": "run_command",
    "review": "review_only",
}

_AUXILIARY_ARTIFACT_NAMES = {
    "spec.md",
    "memory.md",
    "project_profile.md",
    "project_map.md",
    "commands.md",
    "retrieval_plan.md",
    "context_summary.md",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _unique_strings(values: Iterable[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _guess_media_type(path: str, explicit: str = "") -> str:
    if explicit:
        return explicit.strip().lower()
    suffix = Path(path or "").suffix.lower()
    stable_types = {
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    if suffix in stable_types:
        return stable_types[suffix]
    guessed, _ = mimetypes.guess_type(path or "")
    return guessed or "application/octet-stream"


def _artifact_kind(path: str, media_type: str, intent: str) -> str:
    media = media_type.lower()
    if intent == "code_development":
        return "code"
    if media.startswith("image/"):
        return "image"
    if media.startswith("audio/"):
        return "audio"
    if media.startswith("video/"):
        return "video"
    if "spreadsheet" in media or "excel" in media:
        return "spreadsheet"
    if "presentation" in media or "powerpoint" in media:
        return "presentation"
    if media == "application/pdf":
        return "pdf"
    if "wordprocessing" in media or "msword" in media:
        return "document"
    if media.startswith("text/") or media in {"application/json", "application/xml"}:
        return "text"
    return "unknown"


def normalize_artifact_contracts(value: Any, *, intent: str = "") -> list[dict[str, Any]]:
    contracts: list[dict[str, Any]] = []
    for index, raw in enumerate(_as_list(value)):
        if isinstance(raw, str):
            item: dict[str, Any] = {"path": raw}
        elif isinstance(raw, dict):
            item = dict(raw)
        else:
            continue
        path = str(item.get("path") or item.get("target") or "").strip()
        media_type = _guess_media_type(path, str(item.get("media_type") or item.get("mime_type") or ""))
        contract = {
            "id": str(item.get("id") or f"artifact-{index + 1}"),
            "path": path,
            "format": str(item.get("format") or (Path(path).suffix.lstrip(".") if path else "unknown") or "unknown"),
            "media_type": media_type,
            "kind": str(item.get("kind") or _artifact_kind(path, media_type, intent)),
            "purpose": str(item.get("purpose") or item.get("description") or item.get("title") or item.get("name") or "requested output"),
            "success_criteria": _unique_strings(
                _as_list(item.get("success_criteria") or item.get("completion_checks"))
            ),
            "required": bool(item.get("required", True)),
        }
        for key in ("content", "encoding", "minimum_size", "source"):
            if key in item:
                contract[key] = item[key]
        contracts.append(contract)
    return contracts


def normalize_validation_plan(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict) and isinstance(value.get("steps"), list):
        raw_steps = value.get("steps") or []
    else:
        raw_steps = _as_list(value)
    steps: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_steps):
        if isinstance(raw, str):
            item: dict[str, Any] = {"description": raw}
        elif isinstance(raw, dict):
            item = dict(raw)
        else:
            continue
        command = str(item.get("command") or "").strip()
        steps.append({
            "id": str(item.get("id") or f"validation-{index + 1}"),
            "kind": str(item.get("kind") or ("command" if command else "artifact_check")),
            "tool": str(item.get("tool") or ("bash" if command else "artifact_validator")),
            "command": command,
            "target": str(item.get("target") or item.get("path") or ""),
            "description": str(item.get("description") or item.get("name") or "validate requested output"),
            "success_criteria": _unique_strings(_as_list(item.get("success_criteria"))),
            "required": bool(item.get("required", True)),
        })
    return steps


def normalize_execution_plan(
    decision: dict[str, Any] | None,
    *,
    message: str = "",
    source: str = "",
) -> dict[str, Any]:
    raw = dict(decision or {})
    raw_intent = str(raw.get("intent") or "").strip().lower()
    intent = _INTENT_ALIASES.get(raw_intent, raw_intent)
    if intent not in EXECUTION_INTENTS:
        action = str(raw.get("action") or "").strip().lower()
        if action in {"answer", "answer_usage"}:
            intent = "answer_only"
        elif action == "run_command":
            intent = "run_command"
        elif action == "run_pipeline":
            intent = "pipeline"
        elif action in {"open_file", "show_git", "rollback", "rollback_confirm"}:
            intent = "ide_action"
        else:
            intent = "code_development"

    artifacts = normalize_artifact_contracts(
        raw.get("artifact_contracts") or raw.get("expected_artifacts"),
        intent=intent,
    )
    completion_checks = _unique_strings(_as_list(raw.get("completion_checks")))
    for artifact in artifacts:
        artifact["success_criteria"] = _unique_strings(
            [*artifact.get("success_criteria", []), *completion_checks]
        )

    required_capabilities = _unique_strings(_as_list(raw.get("required_capabilities")))
    if not required_capabilities:
        inferred = {
            "answer_only": ["respond"],
            "ide_action": ["workspace_read"],
            "workspace_action": ["workspace_read", "workspace_write"],
            "light_local_file_task": ["local_file_write", "local_file_read"],
            "artifact_creation": ["workspace_write", "artifact_validation"],
            "code_development": ["workspace_read", "workspace_write", "command_execution"],
            "run_command": ["command_execution"],
            "pipeline": ["command_execution", "artifact_validation"],
            "review_only": ["workspace_read", "artifact_validation"],
        }
        required_capabilities = inferred.get(intent, [])

    try:
        confidence = float(raw.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "protocol_version": PROTOCOL_VERSION,
        "intent": intent,
        "action": str(raw.get("action") or ""),
        "task_family": str(raw.get("task_family") or raw.get("family") or intent),
        "confidence": confidence,
        "target": str(raw.get("target") or raw.get("path") or raw.get("command") or ""),
        "required_capabilities": required_capabilities,
        "artifact_contracts": artifacts,
        "validation_plan": normalize_validation_plan(raw.get("validation_plan")),
        "completion_checks": completion_checks,
        "risk_level": str(raw.get("risk_level") or "unknown"),
        "retrieval_plan": raw.get("retrieval_plan") or raw.get("retrieval_seed") or "",
        "reason": str(raw.get("reason") or ""),
        "source": source,
        "source_message": message[:2000],
        "updated_at": _now_iso(),
    }


def is_auxiliary_artifact(path: str) -> bool:
    normalized = str(path or "").replace("\\", "/").strip("/").lower()
    if not normalized:
        return False
    name = normalized.rsplit("/", 1)[-1]
    return normalized.startswith(".autocode/") or name in _AUXILIARY_ARTIFACT_NAMES


def _workspace_evidence(ws_path: Path | None) -> dict[str, Any]:
    if not ws_path or not ws_path.exists():
        return {"exists": False, "manifests": [], "extensions": [], "file_count_sampled": 0}
    manifests: list[str] = []
    extensions: set[str] = set()
    sampled = 0
    skip = {".git", ".autocode", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv"}
    try:
        for path in ws_path.rglob("*"):
            if sampled >= 1200:
                break
            rel = path.relative_to(ws_path)
            if any(part in skip for part in rel.parts) or not path.is_file():
                continue
            sampled += 1
            if path.suffix:
                extensions.add(path.suffix.lower())
            lower_name = path.name.lower()
            if (
                lower_name.endswith((".toml", ".gradle", ".sln", ".csproj", ".fsproj"))
                or lower_name in {
                    "package.json", "requirements.txt", "setup.py", "pom.xml", "go.mod",
                    "cargo.toml", "composer.json", "gemfile", "makefile", "cmakelists.txt",
                    "dockerfile", "deno.json", "bun.lockb", "mix.exs", "pubspec.yaml",
                }
            ):
                manifests.append(rel.as_posix())
    except OSError:
        pass
    return {
        "exists": True,
        "manifests": manifests[:80],
        "extensions": sorted(extensions)[:120],
        "file_count_sampled": sampled,
    }


def build_task_capability_profile(
    task: dict[str, Any],
    ws_path: Path | None,
    execution_plan: dict[str, Any] | None = None,
    *,
    available_tools: Iterable[str] = (),
) -> dict[str, Any]:
    plan = execution_plan or task.get("active_execution_plan") or {}
    evidence = _workspace_evidence(ws_path)
    tools = _unique_strings(available_tools)
    required = _unique_strings(plan.get("required_capabilities") or [])
    intent = str(plan.get("intent") or "")
    contracts = plan.get("artifact_contracts") or []
    validation_steps = plan.get("validation_plan") or []

    local_unsynced = bool(
        task.get("local_import_mode")
        and str(task.get("cloud_snapshot_status") or "not_synced").lower() != "synced"
    )
    requires_review = intent in {"artifact_creation", "code_development", "pipeline", "review_only"}
    requires_validation = bool(validation_steps or contracts or intent in {"code_development", "pipeline", "review_only"})
    requires_preview = any(
        str(step.get("kind") or "").lower() in {"preview", "render", "visual"}
        for step in validation_steps if isinstance(step, dict)
    ) or any(
        str(contract.get("kind") or "").lower() in {"presentation", "image", "pdf"}
        and "visual" in " ".join(contract.get("success_criteria") or []).lower()
        for contract in contracts if isinstance(contract, dict)
    )
    requires_preview = requires_preview or any(
        str(contract.get("media_type") or "").lower() == "text/html"
        for contract in contracts if isinstance(contract, dict)
    )

    return {
        "protocol_version": PROTOCOL_VERSION,
        "task_family": str(plan.get("task_family") or "unknown"),
        "declared_project_type": str(task.get("project_type") or "unknown"),
        "required_capabilities": required,
        "available_tools": tools,
        "workspace": evidence,
        "workspace_sync_status": str(task.get("cloud_snapshot_status") or ("local" if task.get("local_import_mode") else "workspace")),
        "artifact_source": "local_connector" if local_unsynced else "workspace",
        "stage_policy": {
            "requires_validation": requires_validation,
            "requires_review": requires_review,
            "requires_preview": requires_preview,
            "requires_dependency_install": False,
        },
        "resolved_at": _now_iso(),
    }
