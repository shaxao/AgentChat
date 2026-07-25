# -*- coding: utf-8 -*-
"""LSP (Language Server Protocol) code-intelligence subsystem.

Ported from opencode's LSP module. Provides on-demand language servers so the
agent can query definitions/references/hover/symbols and — crucially — receive
compile/type diagnostics right after editing a file.

Layout:
- ``lsp_client.py``  — asyncio subprocess + JSON-RPC over stdio, one per (root, server).
- ``lsp_server.py``  — registry of language servers (id / extensions / root / spawn).
- ``lsp_manager.py`` — per-workspace client pool, lifecycle, broken-server fallback.
- ``diagnostic.py``  — format diagnostics into a compact ``<diagnostics>`` block.

Everything degrades gracefully: if a server binary is missing the feature is
skipped, never raised into the main agent loop.
"""

from .lsp_client import LSPClient, LSPDiagnostic, InitializeError, path_to_uri, uri_to_path
from .lsp_server import (
    LSPServerSpec,
    default_servers,
    server_for_file,
    servers_for_file,
)
from .lsp_manager import LSPManager, LSPManagerRegistry, lsp_registry
from .diagnostic import format_diagnostics, pretty_diagnostic

__all__ = [
    "LSPClient",
    "LSPDiagnostic",
    "InitializeError",
    "path_to_uri",
    "uri_to_path",
    "LSPServerSpec",
    "default_servers",
    "server_for_file",
    "servers_for_file",
    "LSPManager",
    "LSPManagerRegistry",
    "lsp_registry",
    "format_diagnostics",
    "pretty_diagnostic",
]
