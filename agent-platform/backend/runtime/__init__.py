"""AutoCode agent runtime primitives.

The runtime package is intentionally small and dependency-light.  It provides
the shared kernel pieces that API routes, orchestrators, and future workers can
reuse: events, tool metadata, permissions, context assembly, checkpoints, and
the agent loop facade.
"""

