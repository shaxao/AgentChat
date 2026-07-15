# Workflow Engine V2 P11 Review: Durable Execution Checkpoints

Date: 2026-07-08

## Scope

- Added a dedicated `workflow_execution_checkpoint` table for workflow resume.
- Completed/skipped/failed/cancelled step records now write a checkpoint snapshot.
- Resume restores completed outputs from checkpoints before falling back to legacy step output rows.

## Implemented

- Added `WorkflowExecutionCheckpoint` entity.
- Added `WorkflowExecutionCheckpointMapper`.
- `WorkflowService.finishExecutionStep(...)` now upserts checkpoint rows after updating the step record.
- `WorkflowService.collectCompletedStepOutputsBefore(...)` now uses checkpoints first.
- Added `deploy/workflow_checkpoint_migration.sql`.
- Synchronized `deploy/workflow_v2_migration.sql`.
- Synchronized `init-mysql.sql`.

## Review Findings

- Passed: checkpoint write failures are logged but do not break existing workflow execution.
- Passed: resume remains backward compatible with older executions because it falls back to `workflow_execution_step.output_json`.
- Passed: migration and initialization scripts now include the new table.
- Residual risk: production must run `deploy/workflow_checkpoint_migration.sql` before checkpoint persistence becomes active on the server.
- Residual risk: checkpoint rows currently store JSON output in MySQL `MEDIUMTEXT`; very large step outputs should still be stored as workflow artifacts and referenced by UUID.

## Verification

- `mvn.cmd -DskipTests compile` in `backend` passed.
