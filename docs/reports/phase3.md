# Phase 3 report

STATUS: PHASE3_ROOM_REALTIME_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- RoomDO, one SQLite object per room, named `room:{org_id}:{room_id}`.
- Hibernating WebSocket API: `acceptWebSocket`, attachment for the employee id, and a bare `ping` / `pong` auto-response.
- Monotonic room sequence, presence, membership join and leave, message events, and task-event broadcast.
- Reconnect replay of at most 100 events, duplicate idempotency keys, and cross-room isolation.
- D1 projection `room_sequences` for the head. RoomDO remains the ordering authority.
- Gateway upgrade route only. The Worker does not authorize the room.

Architecture decisions:

- Canonical sequence, events, and presence are SQLite rows. JavaScript memory is not the room log.
- The constructor sets the auto-response and schema. It does not perform external I/O.
- RoomDO calls `OrganizationDO.authorize` and adds a membership check OrganizationDO does not know.
- Chat text has zero authority. Task client frames return `NOT_AVAILABLE`.
- A failed D1 projection undoes the SQLite append. The head projection uses `MAX`.
- `session.hello` is not authentication. Phase 4 replaces it with a session.

D1 migrations:

- `migrations/0004_phase3_room_sequence.sql`
- Local apply succeeded: 3 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: `RoomDO` binding `ROOM`, SQLite, local tests only. `OrganizationDO` is unchanged. No namespace was deployed.
Queues: none
Workflows: none
R2 changes: none

Security controls:

- Object name, organization, and room id must match. A foreign employee or unknown room is `TENANT_BOUNDARY`.
- Permissions: `room.read`, `room.message.send`, `agent.invite`, `agent.remove`, `task.create`, `task.assign`.
- A security block on the room denies `room.message.send`.
- Duplicate actor and idempotency key does not bump the sequence.
- Leave or suspension sends `session.revoked` and closes the socket with code 4001.
- A message body cannot change policy or insert a security override.

Tests:

- focused: `pnpm test` — 60 passed (domain 6, policy 15, schemas 2, api 37)
- integration: Workers Vitest, including `room-realtime.test.ts` and `room-race.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.

Known limitations:

- `session.hello` accepts a forged employee id when that employee is a real member. No session credential exists yet.
- `RESYNC_REQUIRED` does not offer a tail API. The client must load history another way once one exists.
- JSON `ping` wakes the object. Only the bare `ping` frame stays on the auto-response path.
- The Worker imports `@ai-company/domain`, which is an API devDependency. Tests and the local bundle resolve it.
- Git `user.name` and `user.email` are unset, so this phase was not committed.

Deferred items: AgentDO, join codes, tasks, queues, artifacts, workflows, Vectorize, Drizzle.

Production mutations: NONE
Secrets changed: NONE

Next safe step: Phase 4, agent join and AgentDO. Do not start it until this report is accepted.
