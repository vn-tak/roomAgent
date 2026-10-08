# Phase 6 report

STATUS: PHASE6_EVENT_DELIVERY_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- Domain event envelope `event_version` 1, with `evt_` and `corr_` ids.
- TaskDO outbox written in the same SQLite transaction as the transition.
- Publish after the D1 projection commits. `deliver` publishes only after AgentDO accepts the packet.
- A failed queue send leaves the task committed. The same command republishes the pending outbox row.
- Three local queues: `ai-company-os-domain-events`, `ai-company-os-agent-delivery`, `ai-company-os-dead-letter`.
- Consumers: persistence, audit, and agent delivery. Retry, then dead letter.
- Chaos coverage: duplicate event, consumer crash, temporary D1 failure, agent delivery timeout, and the dead-letter path.

Architecture decisions:

- The canonical task write stays in TaskDO. The queue is at-least-once and is not the authority.
- `domain_events.event_id` and `audit_events.event_id` are the consumer idempotency keys.
- Agent delivery calls `AgentDO.enqueue` with the task command key. The direct `deliver` path uses that same key, so the inbox keeps one row. Inbox ACK stays separate from task `ack` and does not set `current_task_id` by itself.
- The event payload stores ids and states. It does not store the objective. The delivery consumer reads the objective from D1.
- `causation_id` is the command idempotency key. `correlation_id` is a `corr_` id minted with the outbox row.
- `max_retries` is 2 (three attempts), `retry_delay` is 0, `max_batch_timeout` is 0, and `max_concurrency` is 1.
- Test-only faults run only when `TEST_MIGRATIONS` is present. `armPublishFault` does nothing without that binding.
- No artifact queue, no R2, and no Workflows.

Files:

- `packages/domain/src/events.ts`, `packages/domain/src/ids.ts`
- `migrations/0007_phase6_events.sql`
- `durable-objects/task/src/task-do.ts`
- `apps/api/src/events/`, `apps/api/src/index.ts`, `apps/api/wrangler.jsonc`
- `apps/api/test/event-delivery.test.ts`
- `docs/architecture/events.md`, `overview.md`, `tasks.md`, `realtime.md`, `domain-model.md`, `agent-runtime.md`
- `docs/security/threat-model.md`, `README.md`

D1 migrations:

- `migrations/0007_phase6_events.sql`
- Local apply succeeded: 10 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: existing `OrganizationDO`, `RoomDO`, `AgentDO`, and `TaskDO`. TaskDO gained an outbox table. No namespace was deployed.

Queues: producer bindings `DOMAIN_EVENTS`, `AGENT_DELIVERY`, and `DEAD_LETTER` in local Wrangler config only. `wrangler queues create` was not run. No remote queue was written.

Workflows: none
R2 changes: none

Security controls:

- A repeated `event_id` does not insert a second domain row or a second audit row.
- A repeated agent delivery does not insert a second inbox row.
- A consumer crash, a D1 failure, and a delivery timeout call `message.retry()` and do not ack success.
- After the retry budget, the message is stored in `dead_letters` with reason `MAX_RETRIES`.
- Tenant triggers reject an event whose task or room is outside the organization.
- Logs do not record the event payload, the objective, tokens, or join codes.

Tests:

- focused: `pnpm test` — 79 passed (domain 11, policy 15, schemas 2, api 51)
- integration: Workers Vitest, including `event-delivery.test.ts` and `task-engine.test.ts`
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
- `EXPIRED` and `BLOCKED` are reserved.
- Audit rows can still be deleted by a later migration or an operator. Tamper-proof audit is Phase 8.
- Artifact bytes and artifact events are not stored.
- The direct `deliver` path still enqueues before the queue consumer runs.
- The Worker imports `@ai-company/domain`, which is an API devDependency. Tests and the local bundle resolve it.
- Repository git identity is `vn-tak` / `335007142+vn-tak@users.noreply.github.com`. Global git identity is unset. This phase was not committed.

Production mutations: none
Secrets changes: none
Next safe step: Phase 7 immutable artifacts on R2. Do not start it until this phase stays green.
