# Workflow Engine V2 P9 Review: Resumable Upload and Document Chunk Processing

## Scope

This phase improves the production readiness of large workflow artifact handling and turns the "large document segmented processing" requirement into an executable workflow tool.

## Implemented

- Reserved native cloud multipart upload methods on `OssService`.
  - Default implementations are disabled and throw `UnsupportedOperationException`.
  - Current runtime still uses the stable platform-side chunk upload and local merge path.
  - Future Aliyun/COS/MinIO native multipart wiring can implement these methods without changing workflow APIs.
- Added durable upload session metadata:
  - New table: `workflow_artifact_upload_session`.
  - New entity and mapper: `WorkflowArtifactUploadSession`, `WorkflowArtifactUploadSessionMapper`.
  - Upload sessions now store upload ID, owner, file metadata, uploaded part list, temp directory, status, expiration and reserved native multipart fields.
- Updated migration/init scripts:
  - `backend/src/main/resources/schema.sql`
  - `backend/src/main/resources/migration.sql`
  - `deploy/workflow_v2_migration.sql`
- Enhanced frontend upload UX in `WorkflowCanvas`:
  - Shows uploaded size, total size, current part and total parts.
  - Supports pause by aborting the current request.
  - Supports retry/resume using the existing upload session ID.
- Added executable large document segmented processing:
  - New tool: `document_chunk_process`.
  - Supports text-like artifacts: `txt`, `md`, `json`, `jsonl`, `csv`, `tsv`, `log`, `text/*`, JSON mime types.
  - Reads from `contentText` or OSS `readRange`.
  - Processes chunks with AI, then merges chunk-level outputs into one final result.
  - Writes a derived text artifact with source metadata.
- Added `document_chunk_process` to the workflow tool list and node upload binding UI.

## Verification

- `mvn.cmd -DskipTests compile` passed.
- `npm.cmd run build` passed.

## Operational Notes

- Run the updated migration before using large artifact uploads on an existing database:
  - `.\deploy.ps1 migrate-db workflow_v2_migration.sql` from the `deploy` directory.
- The resumable session is durable in MySQL, but chunk files still live on the application server temp directory until cloud native multipart is implemented.
- Sessions expire after 3 days by metadata. A cleanup job is still recommended for old temp directories and abandoned sessions.

## Residual Risks

- Cloud native multipart is only an interface contract in this phase. Provider-specific implementation remains future work.
- If the server temp directory is wiped before completion, the database session can still exist but missing part files will cause completion to fail.
- `document_chunk_process` currently supports text-like files only. PDF/Word native parsing should be added through a dedicated document extraction layer.
- Large document processing uses multiple model calls; execution time and token cost scale with `maxChunks` and `chunkBytes`.
