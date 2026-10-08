# Phase 8 report

STATUS: PHASE8_GOVERNANCE_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- Review records with result `PASS`, `FAIL`, or `REVISION_REQUIRED`.
- Final approval records. The creator cannot final-approve an artifact they created.
- Security approval records on the same approval table, kind `security`.
- Existing OrganizationDO security blocks still deny review and approval.
- Append-only `audit_events`, `domain_events`, `reviews`, and `approvals`.

Architecture decisions:

- ArtifactDO stores the record. OrganizationDO remains the block and permission authority. A second block store was not added.
- `authorize()` receives the creator id stored on the artifact. A denial with `NO_SELF_APPROVAL` is projected to D1 and replayed for the same idempotency key.
- A review `PASS` is not a final approval. QA can record `FAIL`, `REVISION_REQUIRED`, and a review `PASS`. QA cannot final-approve.
- A security employee can record a security approval and cannot final-approve. The stored creator cannot security-approve that artifact.
- Reviews do not write R2, move the canonical pointer, or transition a task.
- Events `review.recorded`, `approval.granted`, and `approval.denied` use the existing `DOMAIN_EVENTS` queue after the D1 commit. They do not fan out to agents. `artifact.approved` stays rejected.
- The audit row for a governance event copies the authorization decision, policy version, digests, correlation id, and causation id. No remote R2 audit archive was added.
- `@ai-company/domain` remains an API devDependency that the Worker imports.

Files:

- `packages/domain/src/events.ts`, `packages/domain/src/ids.ts`
- `migrations/0009_phase8_governance.sql`
- `durable-objects/artifact/src/artifact-do.ts`
- `apps/api/src/governance-route.ts`, `apps/api/src/events/consumer.ts`, `apps/api/src/index.ts`
- `apps/api/test/governance.test.ts`
- `docs/architecture/reviews.md`, `events.md`, `overview.md`, `domain-model.md`
- `docs/security/threat-model.md`, `README.md`

D1 migrations:

- `migrations/0009_phase8_governance.sql`
- Local apply succeeded: 21 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: existing `OrganizationDO`, `RoomDO`, `AgentDO`, `TaskDO`, and `ArtifactDO`. No namespace was deployed.

Queues: unchanged local names. No `wrangler queues create`. Governance events use `DOMAIN_EVENTS`.

Workflows: none

R2 changes: none. `wrangler r2 bucket create` was not run. No remote object was written.

Security controls:

- Creator final approval stores `DENY` / `NO_SELF_APPROVAL` and does not grant a second row on replay.
- A different actor with `artifact.approve` can store a final `PASS`.
- An active security block denies a later review. Earlier review rows remain.
- Direct `DELETE` and `UPDATE` of audit, domain, review, and approval rows abort.
- Event bodies do not contain artifact bytes, a filename, an objective, or review text.
- Logs do not record review bodies, tokens, or event payloads.

Tests:

- focused: `pnpm test` — 87 passed (domain 14, policy 15, schemas 2, api 56)
- integration: Workers Vitest, including `governance.test.ts`, `artifact-pipeline.test.ts`, and `authority.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.
- End-to-end six-agent POC: NOT RUN

Known limitations:

- Human review and human final approval stay on trusted RPC until a human session exists.
- An operator with direct D1 access can still drop the database file.
- Direct Durable Object RPC can name an actor.
- Workflow runs are not implemented.
- The six-agent production workflow is not implemented.

Production mutations: none
Secrets: none
Unrelated account resources: untouched

Next safe step: Phase 9, one demonstration workflow. Do not start it until this phase stays green.
