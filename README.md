# AI Company OS

Cloudflare-native control plane for an organization of independent AI employees.

Muse and CUE are replaceable execution runtimes. They are not the employee record.

## Status

Phase 0 discovery through Phase 10 company POC records are in this repository. The six-agent company test ran locally on browser sessions. Muse and CUE were not contacted.

Historical certification: `AI_COMPANY_OS_POC_PARTIAL`. Architecture remediation v1 is implemented awaiting independent review (`ROOMAGENT_REMEDIATION_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`); neither the historical POC gate nor remediation implies production, staging, or Muse readiness.

- Remediation ledger: [docs/reports/architecture-remediation-v1.md](docs/reports/architecture-remediation-v1.md)

- Current state: [docs/STATUS.md](docs/STATUS.md)
- Remaining plan: [docs/PLAN.md](docs/PLAN.md)
- Review package: [docs/reports/publication.md](docs/reports/publication.md)
- Company proof: [docs/testing/e2e-company-poc.md](docs/testing/e2e-company-poc.md)

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm --filter @ai-company/api types
pnpm format
pnpm lint
pnpm typecheck
pnpm test
python3 scripts/test-migrations.py
```

D1 is local-only. The database id in `apps/api/wrangler.jsonc` is a placeholder.

Do not run `wrangler deploy` or `wrangler d1 migrations apply --remote` until a staging database is created on purpose. This Cloudflare account already holds unrelated production databases.

## Layout

```text
apps/api                         stateless Worker gateway, queue consumers, and ProductionTaskWorkflow
packages/domain                  ids, validation, entity types, task machine, artifact keys, event envelope, workflow cap, adapter port
packages/policy                  permission catalog, role templates, decision function
packages/schemas                 command validation
packages/db                      tenant-scoped D1 store
durable-objects/organization     OrganizationDO authority and join codes
durable-objects/room             RoomDO hibernating WebSocket
durable-objects/agent            AgentDO session, inbox, browser adapter
durable-objects/task             TaskDO state machine
durable-objects/artifact         ArtifactDO immutable versions, reviews, and approvals
migrations                       schema, permission seed, authority, room, join, session, task, event, artifact, governance, and workflow projections
```
