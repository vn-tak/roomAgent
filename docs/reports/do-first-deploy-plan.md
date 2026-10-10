# Durable Object first-deploy plan (P1-05)

Gate: `ROOMAGENT_P1_DO_FIRST_DEPLOY_PLAN_PASS` (local evidence; nothing provisioned).

| Gate                                   | Status | Evidence                                                                 |
| -------------------------------------- | ------ | ------------------------------------------------------------------------ |
| `DO_CLASSES_VALIDATED_LOCALLY`         | PASS   | `d1_preflight.py config`; Worker test runtime exercises all five classes |
| `DO_BINDINGS_VALIDATED_LOCALLY`        | PASS   | `d1_preflight.py config`; staging dry-run binding table                  |
| `DO_FIRST_DEPLOY_PLAN_VERIFIED`        | PASS   | This plan, checked against current Cloudflare docs                       |
| `DO_REMOTE_PROVISIONING_NOT_PERFORMED` | TRUE   | No `wrangler deploy`, no remote resource creation                        |

## Finding

The five Durable Object classes were validated only in the local runtime, and there was no
staging configuration (`DURABLE_OBJECT_FIRST_DEPLOY_READINESS`).

## Audit of `apps/api/wrangler.jsonc`

| Item                    | Finding                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker entrypoint       | `main: src/index.ts`; default export provides `fetch` and `queue`                                                                                                                                     |
| Class exports           | `index.ts` exports `OrganizationDO`, `RoomDO`, `AgentDO`, `TaskDO`, `ArtifactDO`, `ProductionTaskWorkflow`                                                                                            |
| SQLite storage          | `exports` declares each class `{ type: "durable-object", storage: "sqlite" }`                                                                                                                         |
| First-deploy migrations | None needed. Cloudflare provisions a namespace for each declared class on first deploy. `exports` and the legacy `migrations` array are mutually exclusive, so no `new_sqlite_classes` entry is added |
| Namespace bindings      | `ORGANIZATION`, `ROOM`, `AGENT`, `TASK`, `ARTIFACT` with matching class names, no `script_name`                                                                                                       |
| Compatibility date      | `2026-10-08`                                                                                                                                                                                          |
| Workflow binding        | `PRODUCTION_TASK` → `ProductionTaskWorkflow`                                                                                                                                                          |
| Queue consumers         | Domain events and agent delivery with DLQ, `max_retries: 2`; DLQ consumer `max_retries: 0`                                                                                                            |
| Staging isolation       | The base config uses local-only names and a zero UUID. Unsafe to deploy as-is; staging needs its own file                                                                                             |

Sources: [Durable Object migrations / exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
documents the declarative `exports` form, its mutual exclusion with `migrations`, provisioning
on first deploy, and per-Worker, per-environment namespaces. The installed Wrangler 4.148.0
schema contains `exports` ("mutually exclusive with `migrations`"), and its CLI has no
`X_DO_EXPORTS` gate. The local dry-run accepted the config.

## Staging configuration: `apps/api/wrangler.staging.jsonc`

- Worker `ai-company-os-api-staging`. Its Durable Object namespaces are therefore separate
  from any other Worker's.
- `account_id` pinned to the auditor-recorded target account. Wrangler refuses to deploy to a
  different account.
- `workers_dev: false`, `preview_urls: false`. The operator attaches an Access-protected route.
- Identical binding names and classes as the base config, so code and generated types do not
  diverge.
- Staging-only resource names: D1 `ai-company-os-staging`, R2
  `ai-company-os-staging-artifacts`, Workflow `ai-company-os-staging-production-task`, Queues
  `ai-company-os-staging-{domain-events,agent-delivery,dead-letter}`.
- D1 `database_id` and Access vars are explicit `REPLACE_…` placeholders. No ID is invented.
- Queue `retry_delay: 30` (see P2).

Static gate: `python3 scripts/d1_preflight.py config` checks SQLite exports for every bound
class, Worker exports, no legacy `migrations`, binding parity with base, staging-only names
with no reuse, the pinned account, no public `workers.dev`, consumers for every producer and
DLQ, and non-zero retry delay. It lists unprovisioned placeholders and reports
`deploy_ready: false` until they are replaced.

Local dry-run (no credentials, isolated `HOME`, nothing uploaded):

```text
wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir <tmp>
Total Upload: 385.13 KiB / gzip: 74.63 KiB
env.ORGANIZATION (OrganizationDO) … env.ARTIFACT (ArtifactDO)  Durable Object
env.PRODUCTION_TASK (ProductionTaskWorkflow)                   Workflow
env.DOMAIN_EVENTS / AGENT_DELIVERY / DEAD_LETTER (…-staging-…) Queue
env.DB (ai-company-os-staging)                                 D1 Database
env.ARTIFACTS (ai-company-os-staging-artifacts)                R2 Bucket
--dry-run: exiting now.
```

`TEST_MIGRATIONS` and the test Access values do not appear: they are Vitest-only bindings.

## First-deploy sequence (separate, operator-authorized task)

1. Create D1 `ai-company-os-staging` (not alpha). Record its UUID in
   `deploy/staging/d1-target.json` and `wrangler.staging.jsonc` through a reviewed PR.
2. Create R2 `ai-company-os-staging-artifacts` and the three staging queues.
3. Run the D1 preflight (`EMPTY_STAGING_DATABASE`, PASS), record a Time Travel bookmark, and
   apply `0001`–`0015`. Re-run the preflight (`FULLY_MIGRATED_DATABASE`).
4. Create the Access application and set `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`.
5. Run `wrangler deploy --config wrangler.staging.jsonc`. This first deploy provisions the five
   SQLite DO namespaces and the Workflow.
6. Add the Access-protected route, map the operator identity, and smoke test `/health`,
   bootstrap, and workflow start.

Rollback before data exists: delete the staging Worker. After data exists, follow
[migration-0013-recovery.md](migration-0013-recovery.md) for D1. Durable Object storage has no
Time Travel equivalent through Wrangler. DO namespaces are tied to the Worker and class, and
renaming or removing a class requires an explicit migration.

## Remaining risks

- Declarative `exports` is recent. Provisioning behavior is confirmed only by docs and a local
  dry-run.
- Queue name scope is not stated in the Queues API docs. Staging names are unique anyway.

## Cloudflare remote verification required

- First deploy creating five SQLite-backed namespaces and the Workflow.
- Queue consumers attaching with the configured retry delay and DLQ.
- `REMOTE_NOT_TESTED`.
