# Phase 2 report

STATUS: PHASE2_AUTHORITY_ENGINE_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- Pure `authorize()` decision in `@ai-company/policy`.
- OrganizationDO, one SQLite object per organization, named `org:{org_id}`.
- RPC for authorize, assign, revoke, suspend, create block, clear block, and override.
- D1 projection for policy version, role links, suspension, blocks, and overrides.
- Race coverage for role conflict, idempotent assign, parallel version bumps, and hydration.

Architecture decisions:

- New Workers declare the class with `exports` and SQLite storage. The legacy `migrations` array is not used.
- The object is the authority. D1 is the query copy. Chat text and HTTP routes are not authority.
- The creating human holds the full catalog. Other humans hold nothing until sessions exist.
- Conflict checks run inside the storage transaction. A repeated assign, revoke, suspend, clear, or override does not bump `policy_version`.
- The policy projection keeps the higher version if two writes finish out of order.
- `FoundationStore.assignEmployeeRole()` stays as the Phase 1 path and does not enforce separation of duties.

D1 migrations:

- `migrations/0003_phase2_authority.sql`
- Local apply succeeded: 7 commands on placeholder database `ai-company-os`. Remote apply was not run.

Durable Objects: `OrganizationDO` binding `ORGANIZATION`, SQLite, local tests only. No namespace was deployed.
Queues: none
Workflows: none
R2 changes: none

Security controls:

- Tenant mismatch and unknown employees return `TENANT_BOUNDARY`.
- Suspended employees are denied before permissions, including after eviction.
- Self-approval and security blocks are denied by `authorize()`.
- A manager cannot override a block. The owner can, with a reason.
- `employee` plus `security`, and a non-owner implement-plus-approve pair, are `ROLE_CONFLICT`.

Tests:

- focused: `pnpm test` — 53 passed (domain 6, policy 15, schemas 2, api 30)
- integration: Workers Vitest, including `authority.test.ts` and `authority-race.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.

Known limitations:

- No session authentication, so mutation routes are still absent.
- The Phase 1 store can still assign a conflicting role pair. Privileged callers must use OrganizationDO.
- Artifact creator and implementation actor are supplied by the caller. Artifact rows do not exist yet.
- Git `user.name` and `user.email` are unset, so this phase was not committed.

Deferred items: RoomDO, AgentDO, join codes, tasks, queues, artifacts, workflows, Vectorize, Drizzle.

Production mutations: NONE
Secrets changed: NONE

Next safe step: Phase 3, RoomDO with a hibernating WebSocket. Do not start it until this report is accepted.
