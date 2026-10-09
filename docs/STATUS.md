# Status

## Staging P1 remediation

State: `ROOMAGENT_STAGING_P1_REMEDIATION_AWAITING_INDEPENDENT_REVIEW`.

P1-01 through P1-05 are implemented with local regression coverage on top of the merged
remediation v1 (`main` `dee1e56`). The record is
[staging-p1-remediation.md](reports/staging-p1-remediation.md). Nothing was deployed or
provisioned. Staging is not ready until an operator provisions it and the remote checks pass.

## Architecture remediation v1

State: `ROOMAGENT_REMEDIATION_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`.

Implementation is on `fix/architecture-remediation-v1`, based on the reviewed publication commit.
R1–R17 have local regression coverage: 135 tests / 41 files PASS, plus two migration checks.
Exact-head CI evidence is recorded on the remediation PR; no merge or deployment is authorized.
The implementation and exact-head verification ledger is
[architecture-remediation-v1.md](reports/architecture-remediation-v1.md).
Historical phase gates below are not evidence for the new remediation.

No staging/production deployment, remote Cloudflare mutation, or Muse/CUE contact is authorized.

## Historical baseline (superseded where noted)

Recorded: 2026-10-09

Repository: https://github.com/vn-tak/roomAgent
Branch: `main`
Publication: the first commit on `main`. Phase reports still say ending SHA `none` because each phase closed while the tree was untracked.

Certification: `AI_COMPANY_OS_POC_PARTIAL`

The local company test gate is `PHASE10_COMPANY_POC_PASS`. That gate is the browser-session proof for organization `AI STUDIO LAB`. It is not `AI_COMPANY_OS_POC_CERTIFIED`. The blockers are in `docs/PLAN.md` and `docs/reports/publication.md`.

## Phase gates

| Phase | Gate                            | Record                            |
| ----- | ------------------------------- | --------------------------------- |
| 0     | `PHASE0_DISCOVERY_COMPLETE`     | `docs/PHASE0_DISCOVERY_REPORT.md` |
| 1     | `PHASE1_DOMAIN_FOUNDATION_PASS` | `docs/reports/phase1.md`          |
| 2     | `PHASE2_AUTHORITY_ENGINE_PASS`  | `docs/reports/phase2.md`          |
| 3     | `PHASE3_ROOM_REALTIME_PASS`     | `docs/reports/phase3.md`          |
| 4     | `PHASE4_AGENT_JOIN_PASS`        | `docs/reports/phase4.md`          |
| 5     | `PHASE5_TASK_ENGINE_PASS`       | `docs/reports/phase5.md`          |
| 6     | `PHASE6_EVENT_DELIVERY_PASS`    | `docs/reports/phase6.md`          |
| 7     | `PHASE7_ARTIFACT_PIPELINE_PASS` | `docs/reports/phase7.md`          |
| 8     | `PHASE8_GOVERNANCE_PASS`        | `docs/reports/phase8.md`          |
| 9     | `PHASE9_DURABLE_WORKFLOW_PASS`  | `docs/reports/phase9.md`          |
| 10    | `PHASE10_COMPANY_POC_PASS`      | `docs/reports/phase10.md`         |

## What runs locally

The API Worker is a stateless gateway, the queue consumers, and `ProductionTaskWorkflow`.

| Piece          | Local state                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OrganizationDO | Authority, roles, suspension, blocks, join codes. Tested. Not deployed.                                                                                        |
| RoomDO         | Hibernating WebSocket and monotonic sequence. Tested. Not deployed.                                                                                            |
| AgentDO        | Browser redeem, inbox, reachability, sweep. Tested. Not deployed.                                                                                              |
| TaskDO         | Task transitions and the handoff cap of 8. Tested. Not deployed.                                                                                               |
| ArtifactDO     | Immutable versions, reviews, final approval, security approval. Tested. Not deployed.                                                                          |
| D1             | Migrations `0001` through `0010` applied on the local placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run. |
| Queues         | Local names `ai-company-os-domain-events`, `ai-company-os-agent-delivery`, `ai-company-os-dead-letter`. No remote queue was created.                           |
| Workflows      | One class, `ProductionTaskWorkflow`, binding `PRODUCTION_TASK`, local name `ai-company-os-production-task`. Not deployed.                                      |
| R2             | Local binding `ARTIFACTS` / `ai-company-os-artifacts`. No remote bucket was created.                                                                           |
| Adapters       | `BrowserAgentAdapter` is implemented. Muse and CUE remain labels in the schema and are not clients.                                                            |

`@ai-company/domain` is an API devDependency that the Worker imports.

## Company proof

Organization display name: `AI STUDIO LAB`.

| Employee                | Role      |
| ----------------------- | --------- |
| EMP01 CEO / Coordinator | executive |
| EMP02 Manager           | manager   |
| EMP03 Worker A          | employee  |
| EMP04 Worker B          | employee  |
| EMP05 QA                | qa        |
| EMP06 Security          | security  |

Six browser sessions. Each active binding is `runtime_type = BROWSER`, `adapter_type = browser`, `external_ref` null. Session rows store `token_hash` only. There is no seventh CUE employee. Muse and CUE were not contacted.

The project is room `PROJECT POC-001`. The task objective is `Create and review one small creative artifact.` The recorded path is in `docs/testing/e2e-company-poc.md`.

Delivery proof on that task: inbox `QUEUED`, then `DELIVERED` after the worker socket opens. The task stays `DELIVERED` until `ack`, then `ACKNOWLEDGED`, then `start` moves it to `WORKING`. Task ack does not set `current_task_id`. After sweep, availability is `DEGRADED`. Reachability while the socket is open is `BROWSER_CONNECTED`.

## Last recorded checks

These commands passed at the close of Phase 10, before this publication document:

- `pnpm test` — 92 passed (domain 14, policy 15, schemas 2, api 61)
- `pnpm typecheck` passed
- `pnpm lint` passed
- `pnpm format` passed

The push of this commit is the first GitHub Actions run. CI uses pnpm 10.33.2, Node 22, a frozen lockfile, `pnpm --filter @ai-company/api types`, format, lint, typecheck, and test. CI does not deploy.

## Production and secrets

Production mutations: none.
Secrets: none.
Unrelated Cloudflare resources on the same login stay untouched. Examples named during discovery include `frigo`, `selinow`, `chophanmem`, `tungjpstore`, and their databases, buckets, and queues.

## Known engine limits

The local workflow engine can report instance status `running` while `waitForEvent` is pending. The `workflow_runs` row is `waiting_for_approval`. A 24 hour event timeout can print a hang warning. Denial paths throw `NonRetryableError`, and the local engine prints that while recording the instance as `errored`. Those logs are non-failures when the suite exit code is 0.
