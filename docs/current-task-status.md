# Current Task Status

Updated: 2026-07-08

## Completed

- Workflow Engine V2 P0-P9 main line is implemented and reviewed:
  - P0 audit and boundaries.
  - P1 artifact/step/event models.
  - P2 native workflow tools.
  - P3 executable custom tools.
  - P4 AI-driven execution and AI policy/side-effect controls.
  - P5 SSE progress.
  - P6 resume execution.
  - P7 memory and WORK.md integration plus artifact UI.
  - P8 large upload and artifact preview.
  - P9 resumable upload metadata and document chunk processing.
- Workflow artifact chunk upload no longer stores uploaded file bodies on the application server local filesystem. Chunks are staged as OSS temporary objects and streamed into the final OSS object.
- Expired workflow artifact upload sessions are now cleaned on startup and hourly:
  - pending/uploading/uploaded/failed sessions past `expires_at` are marked `aborted`.
  - staged OSS temp parts are deleted.
  - reserved native multipart sessions are aborted when provider support is added.
- `document_chunk_process` now extracts document text before chunking:
  - TXT/MD/JSON/CSV/TSV/log still use direct text or OSS range reading.
  - DOCX, XLSX and XLS use Apache POI extraction.
  - PDF uses Apache PDFBox extraction.
  - Legacy DOC uses Apache POI scratchpad extraction.
  - extracted text is capped before model chunking to avoid oversized prompts.
- Workflow resume now has a durable checkpoint table:
  - each finished step writes/updates `workflow_execution_checkpoint`.
  - resume reads checkpoint outputs first and falls back to legacy step outputs.
  - migration and init SQL are both synchronized.
- Harness automatic candidate patch generation is expanded:
  - scans recurring failures plus high-priority individual failures.
  - creates auditable candidate plans, not auto-applied code changes.
  - patch payload now includes recommendations, implementation plan, regression checklist, affected surfaces, samples, and activation gates.
- Main app build warning cleanup is complete:
  - page-level route modules are loaded with `React.lazy` and `Suspense`.
  - heavy surfaces such as chat, admin, workflow, AutoCode, model routing, wallet, scenarios, memory timeline, and settings are split out of the initial bundle.
  - Shiki is initialized through the core package with explicit language/theme imports instead of the full bundle.
  - the low-frequency Ruby highlighter is downgraded to plaintext fallback to avoid a 600KB+ language chunk.
  - the initial app chunk dropped from about 1.07MB to about 149KB, and Vite no longer reports large chunk warnings.
- Workflow SSE scaling is implemented:
  - workflow execution events are still persisted to `workflow_execution_event`.
  - after durable insert, events are published to an in-process event bus and Redis pub/sub.
  - SSE subscribers receive push events instead of polling the database every second.
  - reconnect and final snapshots still read the database as the source of truth.
  - Redis fanout can be disabled with `WORKFLOW_REALTIME_REDIS_ENABLED=false` for single-node/local fallback.
- AutoCode hardening is implemented:
  - task runtime state is visible after refresh.
  - workspace memory tab shows `CHAT.md`, `MEMORY.md`, `PLAN.md`, and `SESSION_SUMMARY.md`.
  - chat intervention is persisted to `CHAT.md`.
  - phase review rejects empty/no-change work.
  - workspace path and command escape attempts are blocked and covered by regression tests.

## Remaining Tasks

1. Cloud-provider-native multipart implementation.
   Current APIs and `OssService` contract are reserved, but Aliyun/COS/MinIO native multipart providers still need concrete implementations after the cloud vendor decision.

## Latest Verification

- `backend`: `mvn.cmd -DskipTests compile` passed after document extraction, checkpoint, harness, and workflow SSE scaling changes.
- `app`: `npm.cmd run build` passed with no Vite large chunk warning after page-level splitting and Shiki core loading.
- `agent-platform/frontend`: `npm.cmd run build` passed.
- `agent-platform/backend`: `python -m unittest tests.test_workspace_security` passed.
