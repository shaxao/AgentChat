from __future__ import annotations

import asyncio
import inspect
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Callable

from loguru import logger


MAX_TASK_EVENTS = 1000


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


@dataclass
class AutoCodeEvent:
    """A single append-only event in an AutoCode session."""

    type: str
    task_id: str
    source: str = "system"
    payload: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: f"evt-{uuid.uuid4().hex[:16]}")
    created_at: str = field(default_factory=utc_now)
    conversation_message_id: str | None = None
    snapshot_hash: str | None = None
    workspace_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def append_event(
    task: dict,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    source: str = "system",
    conversation_message_id: str | None = None,
    snapshot_hash: str | None = None,
    persist: Callable[[dict], None] | None = None,
    publish: Callable[[str, str, dict], None] | None = None,
) -> dict[str, Any]:
    """Append an event to a task and optionally persist/publish it.

    Events are stored on the task for compatibility with the current JSON task
    persistence model.  A future migration can move the same event dictionaries
    into a dedicated append-only table without changing callers.
    """

    event = AutoCodeEvent(
        type=event_type,
        task_id=str(task.get("id") or ""),
        source=source,
        payload=payload or {},
        conversation_message_id=conversation_message_id,
        snapshot_hash=snapshot_hash,
        workspace_id=task.get("workspace_id"),
    ).to_dict()

    events = task.setdefault("events", [])
    events.append(event)
    if len(events) > MAX_TASK_EVENTS:
        task["events"] = events[-MAX_TASK_EVENTS:]

    if publish and task.get("id"):
        try:
            result = publish(str(task["id"]), "event", event)
            if inspect.isawaitable(result):
                try:
                    asyncio.get_running_loop().create_task(result)
                except RuntimeError:
                    asyncio.run(result)
        except Exception as exc:
            logger.debug(f"[RuntimeEvents] publish failed: {exc}")

    if persist:
        try:
            persist(task)
        except Exception as exc:
            logger.debug(f"[RuntimeEvents] persist failed: {exc}")

    return event


def events_since(task: dict, event_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    events = list(task.get("events") or [])
    if event_id:
        for idx, event in enumerate(events):
            if event.get("id") == event_id:
                events = events[idx + 1 :]
                break
    return events[-max(1, min(limit, 1000)) :]
