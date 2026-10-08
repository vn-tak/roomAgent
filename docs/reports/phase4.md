# Phase 4 report

STATUS: PHASE4_AGENT_JOIN_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- OrganizationDO join codes: issue, revoke, and atomic consume, with a per-organization failure throttle.
- D1 projections `join_codes` and `runtime_sessions`. Both store hashes. Neither has a plaintext code or token column.
- AgentDO, one SQLite object per employee, named `agent:{org_id}:{employee_id}`.
- Runtime sessions, `BrowserAgentAdapter`, agent inbox, and ACK as a state distinct from delivery.
- Public redeem `POST /orgs/:orgId/join` and agent socket `GET /orgs/:orgId/agents/:employeeId/socket`.
- Room `session.hello` verifies the session token through AgentDO before room authority.

Architecture decisions:

- The join code is the secret for consume. Issue and revoke stay on OrganizationDO RPC because no human session exists.
- Canonical join state is OrganizationDO SQLite. Canonical session and inbox state is AgentDO SQLite. D1 is the query projection. A failed projection undoes the object write.
- A new redeem revokes that employee's earlier active sessions. The browser binding is `BROWSER` / `browser` with `external_ref` NULL, and an existing active binding is reused.
- Delivery, ACK, and working are separate. ACK of a `task` packet stores `current_task_id` and sets availability `BUSY`. It does not start a task machine. `sweep` sets availability `DEGRADED`.
- Reachability is `BROWSER_CONNECTED` only while the agent socket is open. `wake_mode = BROWSER` names the adapter.
- The room WebSocket is the untrusted edge. Room RPC remains a trusted path.
- Chat text has zero authority.

Files:

- `packages/domain/src/ids.ts`, `packages/domain/src/secret.ts`
- `migrations/0005_phase4_agent_join.sql`
- `durable-objects/organization/src/organization-do.ts`
- `durable-objects/agent/` (`AgentDO`, `BrowserAgentAdapter`, protocol)
- `durable-objects/room/src/room-do.ts`, `durable-objects/room/src/protocol.ts`
- `apps/api/src/index.ts`, `apps/api/wrangler.jsonc`, `apps/api/test/agent-join.test.ts`, `apps/api/test/agent-inbox.test.ts`, `apps/api/test/helpers.ts`, `apps/api/test/room-realtime.test.ts`
- `docs/architecture/agent-runtime.md`, `overview.md`, `realtime.md`, `domain-model.md`, `docs/security/threat-model.md`, `README.md`

D1 migrations:

- `migrations/0005_phase4_agent_join.sql`
- Local apply succeeded: 9 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: `AgentDO` binding `AGENT`, SQLite, local tests only. `OrganizationDO` gained join-code methods. `RoomDO` verifies the agent session. No namespace was deployed.
Queues: none
Workflows: none
R2 changes: none

Security controls:

- Plaintext join codes and session tokens are returned once and are not stored. Logs record the error name and request id.
- Throttle: 5 failures in 60 seconds per organization. A throttled valid code stays `active`.
- Wrong organization, wrong employee, expiry, revoke, and a second use are denied. Parallel consume yields one `ALLOW` and one `ALREADY_USED`.
- A forged room token for a real member is `SESSION_INVALID` and does not emit `session.ready`.
- Revoke closes the agent socket and the next room frame with `session.revoked` and close code 4001.
- Manager template cannot issue or revoke. A suspended employee cannot consume a code.

Tests:

- focused: `pnpm test` — 67 passed (domain 7, policy 15, schemas 2, api 43)
- integration: Workers Vitest, including `agent-join.test.ts`, `agent-inbox.test.ts`, `room-realtime.test.ts`, and `room-race.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.
- End-to-end six-agent POC: NOT RUN

Known limitations:

- Issue and revoke have no HTTP route until a human session exists.
- `RESYNC_REQUIRED` still has no tail API.
- Direct Durable Object RPC can name an employee id. That path is trusted.
- JSON `ping` wakes AgentDO and RoomDO. Only the bare `ping` frame stays on the auto-response path.
- Inbox ACK is not a task state machine. Queue duplicate delivery remains Phase 6.
- The Worker imports `@ai-company/domain`, which is an API devDependency. Tests and the local bundle resolve it.
- Repository git identity is `vn-tak` / `335007142+vn-tak@users.noreply.github.com`. Global git identity is unset. This phase was not committed.

Deferred items: tasks, queues, artifacts, workflows, Vectorize, Drizzle.

Production mutations: NONE
Secrets changed: NONE

Next safe step: Phase 5, the task state machine. Do not start it until this report is accepted.
