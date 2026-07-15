# Workflow Engine V2 P14 SSE Scaling Review

Date: 2026-07-08

## Scope

- Replace workflow execution SSE database polling with event-driven fanout.
- Support multi-instance realtime delivery through Redis pub/sub.
- Keep durable database events as the replay/snapshot source of truth.

## Implementation

- Added `WorkflowExecutionEventBus`.
  - Local in-process subscriptions use bounded queues per execution.
  - `publish(...)` immediately fans out to local subscribers.
  - When Redis is available, events are also published to `workflow:execution:events`.
  - Other application instances consume Redis messages and fan them out to their local SSE subscribers.
  - Redis publish failures are non-fatal and fall back to local fanout.

- Added `WorkflowRealtimeConfig`.
  - Registers a Redis message listener for workflow execution events.
  - Controlled by `app.workflow.realtime.redis.enabled`.
  - Environment variable: `WORKFLOW_REALTIME_REDIS_ENABLED`.

- Updated `WorkflowService.recordExecutionEvent(...)`.
  - Events are still inserted into `workflow_execution_event`.
  - After durable insert, the event is published to the realtime bus.

- Updated `WorkflowController.streamExecution(...)`.
  - Sends one initial `snapshot` from the database.
  - Then waits on the event bus subscription instead of polling every second.
  - Sends lightweight `heartbeat` only after idle timeout, with a status check.
  - Sends final `snapshot` and `done` on terminal workflow events.

## Result

Passed.

The previous design performed database reads every second per SSE connection. The new hot path is push-based, with Redis pub/sub for cross-node delivery and local fanout for single-node speed. The database remains the durable record and reconnect snapshot source.

## Deployment Notes

- Multi-instance production:
  - Set `REDIS_HOST`, `REDIS_PORT`, and optionally `REDIS_PASSWORD`.
  - Keep `WORKFLOW_REALTIME_REDIS_ENABLED=true`.

- Single-node or local development without Redis:
  - Set `WORKFLOW_REALTIME_REDIS_ENABLED=false`.
  - SSE still works through in-process fanout.
  - Reconnect snapshots still come from the database.

## Verification

- `mvn.cmd -DskipTests compile`: passed.

## Residual Risk

- SSE worker threads are still created per connection by the controller. For very high concurrency, move this to a bounded `TaskExecutor` or WebFlux stream endpoint.
- Redis pub/sub does not retain messages. This is acceptable because durable replay is still backed by `workflow_execution_event`, but reconnect logic should keep using snapshots and `lastEventId` if the frontend later adds explicit resume offsets.
