# -*- coding: utf-8 -*-
"""Format LSP diagnostics into a compact block for the agent.

Ported from opencode's ``diagnostic.ts``. Only errors (severity=1) are reported
by default so the model focuses on things that actually break the build; the
output is a single ``<diagnostics>`` block the model can read inline right after
an edit.
"""
from __future__ import annotations

from .lsp_client import LSPDiagnostic, SEVERITY_ERROR, SEVERITY_WARNING

_SEVERITY_LABEL = {
    1: "ERROR",
    2: "WARN",
    3: "INFO",
    4: "HINT",
}

# Per-file cap so a single broken file cannot flood the context window.
MAX_PER_FILE = 20


def pretty_diagnostic(diag: LSPDiagnostic) -> str:
    """One diagnostic as ``ERROR [line:col] message`` (1-based line/col)."""
    severity = _SEVERITY_LABEL.get(diag.severity, "ERROR")
    line = diag.line + 1
    col = diag.character + 1
    return f"{severity} [{line}:{col}] {diag.message}"


def format_diagnostics(
    file_rel: str,
    diagnostics: list[LSPDiagnostic],
    *,
    include_warnings: bool = False,
) -> str:
    """Format a file's diagnostics into a ``<diagnostics>`` block.

    Returns an empty string when there is nothing worth reporting, so callers
    can simply append the result to a tool output without extra guarding.
    """
    if not diagnostics:
        return ""
    max_severity = SEVERITY_WARNING if include_warnings else SEVERITY_ERROR
    relevant = [d for d in diagnostics if d.severity <= max_severity]
    if not relevant:
        return ""
    # Errors first, then by line.
    relevant.sort(key=lambda d: (d.severity, d.line, d.character))
    limited = relevant[:MAX_PER_FILE]
    more = len(relevant) - len(limited)
    lines = [pretty_diagnostic(d) for d in limited]
    if more > 0:
        lines.append(f"... and {more} more")
    body = "\n".join(lines)
    return f'<diagnostics file="{file_rel}">\n{body}\n</diagnostics>'
