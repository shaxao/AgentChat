# -*- coding: utf-8 -*-
"""SPEC.md management for user-defined project development constraints."""
from pathlib import Path
from typing import Optional

from loguru import logger

SPEC_FILE = "SPEC.md"


DEFAULT_SPEC_TEMPLATE = """# Project Development Spec - {project_name}

This file defines constraints the AI Agent must follow while generating or modifying code.

## Coding Style

- File encoding: UTF-8
- Indentation: {indent}
- Line endings: LF
- Naming: {naming}

## Technical Constraints

- Required frameworks/libraries:
- Forbidden technologies:
- Browser compatibility requirements:

## Design Constraints

- Color palette:
- Font family:
- Responsive breakpoints:
- Accessibility requirements:

## Code Quality

- Public functions should have clear types where the language supports them.
- Components must use TypeScript types or equivalent prop contracts.
- Avoid `any` unless there is a narrow, documented reason.
- Keep each file under {max_lines} lines when practical.

## AutoCode Preview Compatibility

- Frontend build output must work under a nested preview path like `/autocode-api/workspaces/{{workspace_id}}/preview`.
- Do not assume the app is served from domain root `/`; internal links and dynamic chunks must stay inside the preview path.
- Next.js static export should emit concrete files such as `out/index.html`, `out/tags.html`, `out/post-slug.html`, or `out/tags/name.html`.
- If using Tailwind utility classes, include working Tailwind/PostCSS dependencies and config. The final CSS must not contain raw `@tailwind base/components/utilities`.
- If Tailwind is not configured, do not use Tailwind utility class names; use imported plain CSS instead.
- After build, verify that CSS/JS chunks load from the preview URL and that internal link clicks do not navigate to the host application.

## Security

- Do not hard-code secrets.
- Validate and escape user input.
- Use the project's shared HTTP client for API requests when available.

## Testing

- Target unit test coverage: at least {test_coverage}% for core logic.
- Core workflows should have integration or smoke tests.
"""


def get_default_spec(project_name: str = "Untitled Project", language: str = "typescript") -> str:
    """Return a default SPEC.md template with reasonable defaults."""
    return DEFAULT_SPEC_TEMPLATE.format(
        project_name=project_name,
        indent="2 spaces" if language == "typescript" else "4 spaces",
        naming="camelCase for variables/functions, PascalCase for classes/components",
        max_lines="300",
        test_coverage="60",
    )


def read_spec(workspace_path: Path) -> Optional[str]:
    """Read SPEC.md from the workspace, supporting the legacy .autocode path."""
    spec_path = workspace_path / SPEC_FILE
    legacy_spec_path = workspace_path / ".autocode" / SPEC_FILE
    if not spec_path.exists() and legacy_spec_path.exists():
        spec_path = legacy_spec_path
    if not spec_path.exists():
        return None
    try:
        content = spec_path.read_text(encoding="utf-8").strip()
        return content if content else None
    except Exception as e:
        logger.warning(f"[SPEC] failed to read {spec_path}: {e}")
        return None


def write_spec(workspace_path: Path, content: str) -> bool:
    """Write SPEC.md into the workspace."""
    try:
        workspace_path.mkdir(parents=True, exist_ok=True)
        (workspace_path / SPEC_FILE).write_text(content, encoding="utf-8")
        return True
    except Exception as e:
        logger.error(f"[SPEC] failed to write {workspace_path}/SPEC.md: {e}")
        return False


def build_spec_prompt(workspace_path: Path) -> str:
    """Convert SPEC.md content into a prompt fragment, creating a default if needed."""
    spec = read_spec(workspace_path)
    if not spec:
        project_name = workspace_path.name
        write_spec(workspace_path, get_default_spec(project_name))
        spec = read_spec(workspace_path)
        if not spec:
            return ""

    return f"""## Project Development Spec (SPEC.md)

The following constraints are mandatory for this workspace:

{spec}

If the user request conflicts with SPEC.md, follow the user request and explicitly mention the conflict.
"""