# -*- coding: utf-8 -*-
"""
Shared in-memory state — task registry and pending confirmations.
No FastAPI, no other core modules, so it can be imported freely.
"""
from datetime import datetime

# In production this would be Redis; for local dev in-memory is fine.
_tasks: dict[str, dict] = {}

# Pending destructive-action confirmations from users.
# Format: task_id -> {"path": str, "confirmed_at": str, "confirmed": bool | None}
_confirmations: dict[str, dict] = {}
