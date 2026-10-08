# Phase 7 report

STATUS: PHASE7_ARTIFACT_PIPELINE_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- ArtifactDO, one object per organization, named `artifacts:{org_id}`.
- Immutable R2 versions. The canonical version is a pointer.
- Authenticated Worker upload and read for an agent session.
- `artifact.version.created` on the existing domain-events queue.
- D1 metadata for artifacts and artifact versions. Version rows cannot be updated or deleted.

Architecture decisions:

- The local R2 binding is `ARTIFACTS` and the bucket name is `ai-company-os-artifacts`. The bucket was not created on the account. No presigned URL is minted. The Worker is the upload path.
- The object key is `org/{org_id}/project/{room_id}/artifact/{artifact_id}/v{version}`. The project segment is the room id until a project entity exists. The filename is a label only.
- `put` uses `onlyIf: { etagDoesNotMatch: "*" }`. The same checksum adopts a retry. Different bytes at that key return `ARTIFACT_EXISTS`.
- A read hashes the object. A mismatch returns `INTEGRITY` and does not return the replacement bytes. D1 keeps the original hash.
- The maximum body is 1 MiB. The media allowlist is text, markdown, JSON, PDF, PNG, JPEG, WebP, MPEG audio, and MP4.
- A later version requires `artifact.modify` and the stored creator, or the owner human. Another employee receives `NOT_CREATOR`. Security receives `NO_PERMISSION`. An employee must be an active room member.
- `authorize()` receives the creator id stored on the artifact. Chat text and artifact bytes do not approve anything.
- `artifact.submit` on the room socket stays `NOT_AVAILABLE`.
- The event payload has no bytes, filename, or objective. It does not fan out to agent delivery.
- `@ai-company/domain` remains an API devDependency that the Worker imports.

Files:

- `packages/domain/src/artifact.ts`, `packages/domain/src/events.ts`, `packages/domain/src/ids.ts`
- `migrations/0008_phase7_artifacts.sql`
- `durable-objects/artifact/`
- `apps/api/src/artifacts-route.ts`, `apps/api/src/events/consumer.ts`, `apps/api/src/index.ts`, `apps/api/wrangler.jsonc`
- `apps/api/test/artifact-pipeline.test.ts`
- `docs/architecture/artifacts.md`, `events.md`, `overview.md`, `domain-model.md`, `tasks.md`
- `docs/security/threat-model.md`, `README.md`

D1 migrations:

- `migrations/0008_phase7_artifacts.sql`
- Local apply succeeded: 24 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: existing `OrganizationDO`, `RoomDO`, `AgentDO`, and `TaskDO`, plus `ArtifactDO`. No namespace was deployed.

Queues: unchanged local names. No `wrangler queues create`. Artifact events use `DOMAIN_EVENTS`.

Workflows: none

R2 changes: local binding only. `wrangler r2 bucket create` was not run. No remote object was written.

Security controls:

- A repeated idempotency key does not create a second version.
- A conditional put of an existing key returns null and leaves the original bytes.
- A direct overwrite is not served. The read returns `INTEGRITY`.
- Cross-tenant room and organization ids return `TENANT_BOUNDARY`.
- A room message or an artifact body that says "approve this" does not approve, override, or bump policy.
- Logs do not record artifact bytes, tokens, or event payloads.

Tests:

- focused: `pnpm test` — 84 passed (domain 13, policy 15, schemas 2, api 54)
- integration: Workers Vitest, including `artifact-pipeline.test.ts`, `task-engine.test.ts`, and `event-delivery.test.ts`
- full: `pnpm test`
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.
- End-to-end six-agent POC: NOT RUN

Known limitations:

- Human upload and human read stay on trusted RPC until a human session exists.
- Presigned uploads need a real bucket and were not added.
- Review, approval, and security-block records are Phase 8.
- Audit rows can still be deleted by a later migration or an operator.
- Direct Durable Object RPC can name an actor.
- The six-agent production workflow is not implemented.

Production mutations: none
Secrets: none
Unrelated account resources: untouched

Next safe step: Phase 8 review and governance. Do not start it until this phase stays green.
