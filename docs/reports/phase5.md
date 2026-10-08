# Phase 5 report

STATUS: PHASE5_TASK_ENGINE_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- Task state machine in `packages/domain`. `submit` rests in `REVIEW`. `REVISION` returns to `WORKING` through `start`.
- TaskDO, one SQLite object per organization, named `tasks:{org_id}`.
- Commands: `create`, `assign`, `deliver`, `ack`, `start`, `submit`, `request_revision`, `approve`, `complete`, `fail`, `cancel`.
- D1 projection `tasks` and `task_dependencies`.
- Idempotency keys, version compare-and-set, dependency checks, and the handoff loop guard.
- `deliver` enqueues a work packet on AgentDO. Inbox ACK stays separate from task `ack`.
- Room `task.ack`, `task.start`, and `task.submit` call TaskDO when the session scope includes `task.accept`.

Architecture decisions:

- TaskDO is the transition authority. OrganizationDO remains the authorizer. D1 is the query projection.
- A failed D1 projection undoes the SQLite write.
- The first assignment does not count as a handoff. Each later assignee change does. Past 8, the task pauses with `LOOP_GUARD` and the assignee stays put.
- `approve` uses `artifact.final_approve`. The creator and the assignee receive `NO_SELF_APPROVAL`.
- A security block denies the command and does not move the row to `BLOCKED`.
- There is no unauthenticated HTTP task route. Human commands stay on the trusted RPC path.
- Chat text has zero authority. This phase does not publish queue events or store artifact bytes.

Files:

- `packages/domain/src/task-machine.ts`, `packages/domain/src/ids.ts`
- `migrations/0006_phase5_tasks.sql`
- `durable-objects/task/`
- `durable-objects/room/src/room-do.ts`, `durable-objects/room/src/protocol.ts`
- `apps/api/src/index.ts`, `apps/api/wrangler.jsonc`, `apps/api/test/task-engine.test.ts`
- `docs/architecture/tasks.md`, `overview.md`, `realtime.md`, `domain-model.md`, `agent-runtime.md`, `docs/security/threat-model.md`, `README.md`

D1 migrations:

- `migrations/0006_phase5_tasks.sql`
- Local apply succeeded: 9 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: `TaskDO` binding `TASK`, SQLite, local tests only. RoomDO forwards three task frames. No namespace was deployed.
Queues: none
Workflows: none
R2 changes: none

Security controls:

- Every transition calls `authorize()` before it writes.
- Unknown tasks, unknown assignees, and foreign organizations return `TENANT_BOUNDARY`.
- An employee without `task.assign` cannot assign. A suspended employee cannot act or receive a new assignment.
- Duplicate actor and idempotency key does not apply a second transition. Parallel starts produce one `ALLOW` and one `INVALID_TRANSITION`.
- Self-approval is denied for the creator and the assignee.
- An active security block on the task returns `SECURITY_BLOCK`.
- The ninth reassignment pauses the task with `LOOP_GUARD`.

Tests:

- focused: `pnpm test` — 72 passed (domain 9, policy 15, schemas 2, api 46)
- integration: Workers Vitest, including `task-engine.test.ts` and `room-realtime.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.
- End-to-end six-agent POC: NOT RUN

Known limitations:

- Human create, assign, approve, complete, and cancel stay on RPC until a human session exists.
- `RESYNC_REQUIRED` still has no tail API.
- Direct Durable Object RPC can name an actor. That path is trusted.
- `EXPIRED` and `BLOCKED` are reserved. A block denies the command in place.
- Inbox ACK and task ACK are different operations.
- Domain events are not on Queues yet. Artifact bytes are not stored.
- The Worker imports `@ai-company/domain`, which is an API devDependency. Tests and the local bundle resolve it.
- Repository git identity is `vn-tak` / `335007142+vn-tak@users.noreply.github.com`. Global git identity is unset. This phase was not committed.

Deferred items: queues, artifacts, reviews as their own records, workflows, Vectorize, Drizzle.

Production mutations: NONE
Secrets changed: NONE

Next safe step: Phase 6, the event bus. Do not start it until this report is accepted.
