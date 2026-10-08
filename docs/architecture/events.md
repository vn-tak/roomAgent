# Events

Phase 6 publishes a domain event after a task mutation commits. The bus is Cloudflare Queues. Delivery is at-least-once. Consumers are idempotent.

The API Worker produces and consumes three local queues:

| Queue                          | Binding          | Role                                                   |
| ------------------------------ | ---------------- | ------------------------------------------------------ |
| `ai-company-os-domain-events`  | `DOMAIN_EVENTS`  | Persist the event and the audit row. Fan out delivery. |
| `ai-company-os-agent-delivery` | `AGENT_DELIVERY` | Hand a `task.delivered` packet to AgentDO.             |
| `ai-company-os-dead-letter`    | `DEAD_LETTER`    | Record a message that used its retry budget.           |

`max_retries` is 2, so a message is attempted 3 times. `retry_delay` and `max_batch_timeout` are 0. `max_concurrency` is 1. The dead-letter consumer does not retry. These queues are not created on the live account.

## Envelope

```json
{
  "event_id": "evt_...",
  "event_version": 1,
  "org_id": "org_...",
  "room_id": null,
  "type": "task.created",
  "actor_type": "human",
  "actor_id": "usr_...",
  "subject_type": "task",
  "subject_id": "task_...",
  "seq": 1,
  "correlation_id": "corr_...",
  "causation_id": "create_task_01",
  "idempotency_key": "create_task_01",
  "occurred_at": "2026-10-09T00:00:00.000Z",
  "payload": {
    "from_state": null,
    "to_state": "CREATED",
    "assignee_id": null,
    "handoff_count": 0,
    "human_review_required": 0,
    "pause_reason": null
  }
}
```

`causation_id` and `idempotency_key` are the task command key. `correlation_id` is a new `corr_` id stored with the outbox row. The payload carries ids and states. It does not carry the objective.

Task types are `task.created`, `task.assigned`, `task.paused`, `task.delivered`, `task.acknowledged`, `task.started`, `task.submitted`, `task.revision_requested`, `task.approved`, `task.completed`, `task.failed`, and `task.cancelled`. A loop-guard pause uses `task.paused`.

The artifact type is `artifact.version.created`. Its subject is `artifact` and its `seq` is the version. The payload is `version`, `sha256`, `media_type`, `size`, and `r2_key`. It does not carry bytes, a filename, or an objective. `artifact.approved` is not an event.

Governance types are `review.recorded`, `approval.granted`, and `approval.denied`. The subject stays `artifact`. The payload is `record_id`, `artifact_version`, `result`, `decision`, `reason`, `kind`, `policy_version`, `before_digest`, and `after_digest`. `result` is `PASS`, `FAIL`, or `REVISION_REQUIRED`. `kind` is `review`, `final`, or `security`. A review record uses `review.recorded`. A granted final or security approval uses `approval.granted`. A creator or implementation-actor denial uses `approval.denied` with reason `NO_SELF_APPROVAL`. The payload has no bytes, filename, objective, or review comment.

## Publish

TaskDO inserts the outbox row in the same SQLite transaction as the transition. It sends the event only after the D1 projection commits. `deliver` sends only after AgentDO accepts the packet. A failed `queue.send` leaves the row `pending` and leaves the task committed. The same command, replayed, sends that row again. A second transition is not applied.

ArtifactDO uses the same `DOMAIN_EVENTS` queue. It sends `artifact.version.created` only after the artifact and version rows commit. It sends a governance event only after the review or approval row commits. There is no separate artifact queue and no separate review queue.

## Consume

The domain consumer inserts `domain_events` and `audit_events` with `ON CONFLICT(event_id) DO NOTHING`, then forwards only `task.delivered` to agent delivery. `artifact.version.created`, `review.recorded`, `approval.granted`, and `approval.denied` are stored and audited. They do not enqueue an agent. A governance audit row copies `authorization_decision`, `policy_version`, `before_digest`, `after_digest`, `correlation_id`, and `causation_id`. A duplicate message does not add a second row, and a duplicate `task.delivered` still attempts the handoff.

The agent-delivery consumer loads the objective from D1 and calls `AgentDO.enqueue` with the command idempotency key. The direct `deliver` path uses that same key, so the inbox gains one row. A timeout or a denial calls `message.retry()`. It does not ack the message as delivered.

A handler exception or `message.retry()` uses the retry budget. The next failure moves the original body to `ai-company-os-dead-letter`. That consumer inserts `dead_letters` with reason `MAX_RETRIES`. Invalid bodies are not persisted as domain events.

Tenant triggers reject an event whose task, artifact, or room belongs to another organization. Logs record the queue name and the error name. They do not record the payload, the artifact bytes, or the work-packet body.
