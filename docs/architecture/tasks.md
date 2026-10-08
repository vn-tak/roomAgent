# Tasks

TaskDO is the transition authority for one organization. The object name is `tasks:{org_id}`. Storage is SQLite. D1 `tasks` and `task_dependencies` are the query projection. A failed projection undoes the object write.

There is no HTTP route for task commands. Tests call TaskDO directly. Room sockets may send `task.ack`, `task.start`, and `task.submit` after `session.hello`. Those frames require session scope `task.accept`. `artifact.submit` stays unavailable.

## States

```text
CREATED → QUEUED → DELIVERED → ACKNOWLEDGED → WORKING → REVIEW
                                                          ↓
                                          REVISION → WORKING
                                                          ↓
                                                      APPROVED → COMPLETED
```

`submit` moves `WORKING` to `REVIEW`. `request_revision` moves `REVIEW` to `REVISION`, and `start` moves `REVISION` back to `WORKING`. `CANCELLED` and `FAILED` are terminal. `PAUSED` is the loop guard. `SUBMITTED`, `EXPIRED`, and `BLOCKED` are reserved states. A security block does not move the row into `BLOCKED`. The command returns `SECURITY_BLOCK` and leaves the state as it was.

## Commands

| Command            | Permission         | Rule                                                                |
| ------------------ | ------------------ | ------------------------------------------------------------------- |
| `create`           | `task.create`      | Title, objective, optional room, up to 8 dependencies               |
| `assign`           | `task.assign`      | Active employee in the same organization. Moves the row to `QUEUED` |
| `deliver`          | `task.assign`      | Hands a work packet to AgentDO and moves the row to `DELIVERED`     |
| `ack`              | `task.accept`      | Only the assignee                                                   |
| `start`            | `task.accept`      | Only the assignee. Dependencies must be `COMPLETED`                 |
| `submit`           | `task.accept`      | Only the assignee. Dependencies must be `COMPLETED`                 |
| `request_revision` | `artifact.review`  | From `REVIEW`                                                       |
| `approve`          | `artifact.approve` | Creator and assignee are denied with `NO_SELF_APPROVAL`             |
| `complete`         | `task.assign`      | From `APPROVED`. Dependencies must be `COMPLETED`                   |
| `fail`             | `task.cancel`      | The assignee may fail with `task.accept`                            |
| `cancel`           | `task.cancel`      | Open states, including `PAUSED`                                     |

Every command carries an idempotency key of 8 to 80 URL-safe characters. The same actor and key returns the original result. A second start with a different key is `INVALID_TRANSITION`. The compare-and-set uses the task version inside one SQLite transaction.

`deliver` stores the task as `DELIVERED` when AgentDO accepts the packet, then publishes `task.delivered`. If that send fails, the task stays `DELIVERED` and a duplicate command republishes the outbox row. The inbox item can still be `QUEUED` until a socket is open. The agent-delivery consumer enqueues with the same idempotency key, so a second handoff does not add an inbox row. Inbox ACK does not change the task. Task `ack` does not mark the agent `WORKING` and does not set `current_task_id`.

## Loop guard

The first assignment does not count as a handoff. Each later change of assignee increments `handoff_count`. The maximum is 8. The next reassignment leaves the assignee in place, sets state `PAUSED`, `pause_reason` `LOOP_GUARD`, and `human_review_required`. A later assign while paused returns `LOOP_GUARD`. `cancel` and `fail` can still close the task.

## Dependencies

A task may depend only on tasks that already exist in the same organization. A missing dependency is `TENANT_BOUNDARY`. `start`, `submit`, and `complete` return `DEPENDENCY_NOT_COMPLETED` until every direct dependency is `COMPLETED`.

## Room projection

After a socket `ack`, `start`, or `submit` succeeds, RoomDO appends `task.updated`. Chat text still has no authority. The public `publishTask` RPC still requires `task.create` or `task.assign`.

## Limits

Issue of human commands stays on the trusted RPC path until a human session exists. Direct Durable Object RPC can name an actor. A successful mutation publishes one domain event after the D1 projection commits. Artifact bytes are immutable R2 versions. `@ai-company/domain` remains an API devDependency that the Worker imports.
