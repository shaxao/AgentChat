# Workflow Engine V2 P8 Review: Large File Upload and Artifact Preview

## Scope

This phase closes the large-file boundary for workflow artifacts and improves artifact visibility in workflow execution details.

## Implemented

- Raised workflow artifact upload limit to 1GB.
- Added platform-side chunked upload APIs:
  - `POST /api/workflow-artifacts/chunk/init`
  - `POST /api/workflow-artifacts/chunk/{uploadId}/part`
  - `GET /api/workflow-artifacts/chunk/{uploadId}`
  - `POST /api/workflow-artifacts/chunk/{uploadId}/complete`
- Chunked upload stores temporary parts under the JVM temp directory, validates owner/session/part count, merges parts, then streams the merged file to the active OSS provider.
- Frontend `workflowArtifactApi.upload(...)` automatically uses 32MB chunks for files over 100MB. Existing callers continue using the same API.
- Spring multipart limits are aligned to 1GB in default and production config.
- Nginx config/deploy template adds `client_max_body_size 1024m`, longer upload timeouts, and disables request buffering for workflow artifact uploads.
- Workflow execution detail now previews image/audio/video artifacts inline and keeps text/metadata inspection.

## Files

- `backend/src/main/java/com/aiplatform/backend/service/WorkflowArtifactService.java`
- `backend/src/main/java/com/aiplatform/backend/controller/WorkflowArtifactController.java`
- `backend/src/main/java/com/aiplatform/backend/dto/WorkflowArtifactDTO.java`
- `backend/src/main/resources/application.yml`
- `backend/src/main/resources/application-prod.yml`
- `deploy/application-prod.yml.template`
- `deploy/nginx-muhugochat.conf`
- `deploy/deploy.sh`
- `app/src/lib/api.ts`
- `app/src/pages/WorkflowPage.tsx`

## Verification

- `mvn.cmd -DskipTests compile` passed.
- `npm.cmd run build` passed.

## Residual Risks

- Chunked upload is resumable while the server temp directory remains available. It is not yet durable across server cleanup/redeployment.
- Completion currently merges chunks into a temporary file before streaming to OSS, so the server needs enough temporary disk space for chunk parts plus the merged file during completion.
- OSS-provider-native multipart upload is not exposed by the current `OssService` abstraction. A later phase can add native multipart support for lower disk usage.
- Vite still reports existing chunk-size and mixed static/dynamic import warnings unrelated to this phase.
