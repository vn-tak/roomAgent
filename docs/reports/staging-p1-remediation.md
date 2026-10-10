# Staging P1 remediation

Status: `ROOMAGENT_STAGING_P1_REMEDIATION_AWAITING_INDEPENDENT_REVIEW`.

Not `STAGING_READY`, `STAGING_CERTIFIED`, or `PRODUCTION_READY`: nothing ran on Cloudflare.

## Provenance

- Repository `takovn2/roomAgent` (previously `vn-tak/roomAgent`), ID `1410359112`.
- Base: exact `main` `dee1e56f247c12538bd8ad3c7dfe1459e8bc4cf9`. Its push CI run
  `37878441191` / job `113652285668` concluded `success` on that SHA, and remote `main` still
  pointed to it when work started.
- Head SHA and exact-head CI receipts are recorded on the pull request. This document cannot
  contain its own commit hash.

## P1 ledger

| Finding                                       | Previous behavior                        | Remediation                                                                                                                                                  | Report                                                     | Gate                                        |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------- |
| P1-01 `WORKFLOW_UNREACHABLE`                  | Only tests created instances             | Authenticated, authorized `POST …/workflow-runs`; durable claim; unclaimed instances never register; holds released only by audited, policy-bound resolution | [workflow-start-protocol.md](workflow-start-protocol.md)   | `ROOMAGENT_P1_WORKFLOW_ENTRYPOINT_PASS`     |
| P1-02 `HUMAN_BOOTSTRAP_MISSING`               | Human sessions only via trusted RPC      | Verified Cloudflare Access JWT → pre-provisioned, attested Access subject → owner-only, 15-minute, audited, revocable session                                | [human-bootstrap-security.md](human-bootstrap-security.md) | `ROOMAGENT_P1_HUMAN_BOOTSTRAP_PASS`         |
| P1-03 `MIGRATION_LEDGER_GATE_MISSING`         | Apply relied on the binding name         | Offline preflight: identity, checksum manifest, ledger prefix, schema fingerprint, FK gates                                                                  | [d1-migration-preflight.md](d1-migration-preflight.md)     | `ROOMAGENT_P1_MIGRATION_LEDGER_PASS`        |
| P1-04 `MIGRATION_0013_RECOVERY_PLAN`          | No restore procedure                     | Time Travel runbook; offline checkpoint/restore and atomic-failure tests; 0013 unchanged                                                                     | [migration-0013-recovery.md](migration-0013-recovery.md)   | `ROOMAGENT_P1_MIGRATION_RECOVERY_PLAN_PASS` |
| P1-05 `DURABLE_OBJECT_FIRST_DEPLOY_READINESS` | No staging config; local validation only | Isolated `wrangler.staging.jsonc`, static config gate, credential-free dry-run, deploy sequence                                                              | [do-first-deploy-plan.md](do-first-deploy-plan.md)         | `ROOMAGENT_P1_DO_FIRST_DEPLOY_PLAN_PASS`    |

No P1 remains open. Every row still needs Cloudflare remote verification, listed in each report.

## Migrations

- Added: `0015_workflow_start_claims_and_human_identities.sql`, forward-only.
  - `workflow_start_claims`: durable start claims, a single-active-per-task partial unique
    index, integrity, forward-only, release-reason, and no-delete triggers.
  - `workflow_runs.hold_reason` (nullable `ADD COLUMN`) with a trigger that makes holds final.
  - `workflow_run_resolutions`: insert-only, policy- and budget-checked resolution audit.
  - `human_identities`: operator-provisioned Access identity mapping. The subject and an
    approval reference are required at provisioning and immutable.
  - `human_sessions.identity_id`: nullable `ALTER … ADD COLUMN`. Existing sessions are
    unaffected.
  - `human_session_audit`: insert-only issuance and revocation audit.
- Changed: none. `0001`–`0014` are byte-identical. All 15 checksums are pinned in
  `deploy/d1/migrations.manifest.json`.

### Domain API compatibility

- New HTTP routes only. No existing route changed shape.
- `verifyHumanSession` also returns `sessionId` (additive). It denies sessions whose linked
  identity is disabled. Sessions without an identity (`identity_id IS NULL`, all pre-0015
  rows) behave exactly as before.
- Human session issuance now writes an audit row and refuses suspended organizations. Such
  sessions could never verify anyway.
- `workflow.start` (→ `task.assign`), `workflow.resolve` (→ `workflow.approve`), and
  `workflow.resolve.limit` (→ `organization.policy.manage`) are new action aliases to existing
  permissions. No role template or permission catalog row changed.
- Paused and denied workflow runs now hold their task until an explicit resolution
  (`POST /orgs/:orgId/workflow-runs/:runId/resolution`).
- `ProductionTaskWorkflow` now requires a start claim before registering. Tests that drive the
  binding directly write the claim through the `claimWorkflowStart` fixture, which mirrors the
  entrypoint's durable claim. No assertion was weakened.

## P2 review

| Item                          | Decision                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DLQ alerting                  | Documented, not configured. Monitoring is read-only: `SELECT queue_name, reason, COUNT(*) FROM dead_letters GROUP BY 1, 2`, plus queue backlog metrics. DLQ data mutation (replay, purge) is a separate, approval-gated action. Remote alerts are follow-up work. |
| Queue `retry_delay = 0`       | Fixed for staging: `retry_delay: 30` on both consumers that have a DLQ, enforced by the config gate. The base config keeps 0 so local tests stay deterministic; it is local-only.                                                                                 |
| Abandoned upload cleanup      | Not implemented. Deleting reserved R2 keys without a retention policy could remove valid artifacts. Needs a policy decision first.                                                                                                                                |
| `TEST_MIGRATIONS` handling    | Verified test-only: declared in `apps/api/test/env.d.ts` and Vitest Miniflare bindings, absent from both Wrangler configs and from the staging dry-run binding list. The new test Access vars follow the same pattern.                                            |
| Human WebSocket authorization | RoomDO `session.hello` verifies employee sessions only. Human sessions cannot open room sockets (deny by default). Human realtime access is a feature decision, not a vulnerability.                                                                              |

## Verification classification

| Check                                                                           | Class                                 | Result                                              |
| ------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                | STATIC_PASS                           | PASS                                                |
| `pnpm --filter @ai-company/api types` (no diff)                                 | STATIC_PASS                           | PASS                                                |
| `pnpm format`, `pnpm lint`, `pnpm typecheck`                                    | STATIC_PASS                           | PASS                                                |
| `python3 scripts/d1_preflight.py manifest` / `config`                           | STATIC_PASS                           | PASS (config `deploy_ready: false`: 3 placeholders) |
| Staging `wrangler deploy --dry-run` without credentials                         | STATIC_PASS                           | PASS                                                |
| `pnpm test`: 155 tests (domain 14, schemas 2, policy 15, api 124)               | UNIT_PASS + LOCAL_WORKER_RUNTIME_PASS | PASS (baseline 135; +20)                            |
| Workflow entrypoint, bootstrap, and claim tests in workerd + local D1/Workflows | LOCAL_WORKER_RUNTIME_PASS             | PASS                                                |
| `python3 scripts/test-migrations.py`: 11 tests                                  | INTEGRATION_PASS (SQLite)             | PASS (baseline 2; +9)                               |
| `python3 scripts/test-d1-preflight.py`: 16 tests                                | UNIT_PASS                             | PASS                                                |
| Remote D1, Access, Workflows, Queues, DO provisioning                           | REMOTE_NOT_TESTED                     | —                                                   |

No test was skipped, disabled, or weakened. Mocked responses were used only for the Access JWKS
in tests and certify nothing about Cloudflare.

## Known limitations

- Remote behaviors listed under "Cloudflare remote verification required" in each report.
- Staging still needs operator provisioning: D1 UUID, Access application and vars, R2, queues,
  and a route.
- Only organization owners can bootstrap a human session.

## Safety

`cloudflare_remote_mutation = NONE`; `staging_deploy = NONE`; `production_deploy = NONE`;
`secrets_changed = NONE`; `provider_interaction = NONE`; `muse_contacted = NO`;
`cue_contacted = NO`. Wrangler ran only `types`, the test runtime, and a credential-isolated
`deploy --dry-run`. No account resource was read or changed.
