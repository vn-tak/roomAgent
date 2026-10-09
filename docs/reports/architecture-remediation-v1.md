# Architecture remediation v1

Status: `ROOMAGENT_REMEDIATION_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`.

## Scope and provenance

- Repository: `vn-tak/roomAgent`; repository ID: `1410359112`.
- Reviewed base SHA: `0263e45784e85f3fe3ee32fa9304bb3af6de63aa` (the supplied reference resolves to this commit; remote `main` still matches).
- Branch: `fix/architecture-remediation-v1`.
- The immutable publication head and exact-head CI run/job IDs will be pinned in the PR verification record. This document cannot contain its own commit hash.
- Independent review is required. Do not merge, deploy, or start provider integration.

The Worker / OrganizationDO / RoomDO / AgentDO / TaskDO / ArtifactDO / D1 /
Queues / Workflow / R2 responsibility split is retained. Employee identity is
independent of runtime bindings and sessions. OrganizationDO remains the sole
permission authority. Chat, objectives, artifact bytes, comments, and workflow
wakeups have no authority.

## Finding ledger

Priorities below are implementation triage, not additional reviewer findings.
FIXED records implementation and local regression coverage, not production certification.

| Finding                  | Severity | Previous behavior                                   | Remediation                                                                                    | Regression evidence                     | Status |
| ------------------------ | -------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- | ------ |
| R1 ROOM_TASK_BOUNDARY    | P1       | Room A could mutate Task B                          | Canonical TaskDO validates expected room before effects and replay                             | room-task-boundary                      | FIXED  |
| R2 ARTIFACT_ROOM_TASK    | P1       | Same org was insufficient for artifact/task links   | Every version validates task org and room; forward D1 guard                                    | artifact-room-task-integrity            | FIXED  |
| R3 ACK_CONSISTENCY       | P1       | Inbox and Task ACK could diverge                    | TaskDO canonical ACK; durable, idempotent Agent projection                                     | work-acceptance-consistency             | FIXED  |
| R4 OUTBOX_RETRY          | P1       | Queue failure required command replay               | Task/artifact/governance alarms retry with persisted backoff; invalid events terminal          | outbox-alarm-retry                      | FIXED  |
| R5 ROOM_RESYNC           | P2       | Replay beyond 100 had no recovery path              | Authenticated member snapshot and resume from head cursor                                      | room-resync                             | FIXED  |
| R6 COMPLETION_POLICY     | P1       | Production completion did not require governance    | Explicit NONE / ARTIFACT_APPROVED / QA_SECURITY / HUMAN_FINAL, stored current-version evidence | task-completion-policy                  | FIXED  |
| R7 WORKFLOW_EVIDENCE     | P1       | Workflow scripted QA and acted as security          | External authorized evidence and durable waiting; forged notifications confer no authority     | workflow-external-evidence, company-poc | FIXED  |
| R8 ARTIFACT_TRANSPORT    | P2       | All bytes traversed DO RPC/base64                   | Reserve exact key, short-lived capability, Worker-to-R2 streaming, validated commit            | artifact-direct-upload                  | FIXED  |
| R9 HUMAN_SESSION         | P1       | No authenticated human HTTP principal               | Hashed, expiring/revocable bearer session; server-resolved user; trusted internal issuance     | human-session                           | FIXED  |
| R10 CORRELATION          | P2       | Events generated independent trace roots            | Persist task root and inherit across artifact/governance/workflow                              | correlation-trace                       | FIXED  |
| R11 AUDIT_REPLAY         | P2       | Company path replay was unasserted                  | Deterministic bounded replay compared with canonical final state                               | audit-replay                            | FIXED  |
| R12 QUEUE_CONFIG         | P2       | Deployment config forced one consumer               | Deployable config omits hard-coded concurrency; retry and DLQ remain intact                    | event-delivery                          | FIXED  |
| R13 AUTHORITY_WRITE_PATH | P2       | Raw role assignment looked production-safe          | Rename raw store method bootstrapAssignEmployeeRoleUnsafe; live commands use OrganizationDO    | roles, authority                        | FIXED  |
| R14 JOIN_THROTTLE        | P2       | One org-wide failure bucket enabled DoS             | Failure window keyed by employee inside org authority                                          | join-remediation                        | FIXED  |
| R15 WS_AUTH_PROTECTION   | P2       | Unauthenticated sockets held resources indefinitely | Short durable auth deadline; no actions/presence/replay before hello                           | ws-auth-protection                      | FIXED  |
| R16 JOIN_UX              | P2       | Clients had to supply org and employee IDs          | Opaque 256-bit /j/:token, server-side hash lookup, one-time redemption, TTL at most 600s       | join-remediation                        | FIXED  |
| R17 RUNAWAY_LIMITS       | P2       | Handoff/workflow caps only                          | Active-task, task-message, retry, org and agent execution budgets, explicit pause/review       | runaway-budget                          | FIXED  |

Test suite names are in `apps/api/test`; the verification below supports all FIXED rows. Exact-head CI and independent review remain distinct gates.

## Migrations and compatibility

Only new, forward-only migrations are added. Historical `0001–0010` are unchanged.

- `0011_architecture_integrity_and_human_sessions.sql`: artifact/task room guard and hashed human sessions.
- `0012_task_completion_and_trace.sql`: default-compatible task completion policy and legacy trace root backfill.
- `0013_direct_artifact_size.sql`: immutable version projection table rebuilt at a 100 MiB bound, preserving all historical rows and tenant/immutability guards.
- `0014_workflow_completed_version.sql`: persist the actual completed revision version without rewriting the workflow's initial version identity.

All generic tasks retain policy NONE unless their creator explicitly requests
production governance. Old independent inbox ACK semantics are not retained:
one work acceptance now targets the canonical Task lifecycle, with projections
converging through durable retries. The protocol remains structured; text does
not trigger business actions.

The opaque join path reuses the existing one-time, hashed join secret. Tokens
and bearer sessions must not be logged, embedded in public reports, or cached.
Human session mint/revoke is an internal trusted RPC primitive, not a login
implementation or public actor-id-based mutation endpoint.

## Distributed-system behavior

Queue transport is at least once. Domain/audit consumers deduplicate by event ID;
ACK projection and inbox delivery are idempotent. A queue acknowledgement lost
after send may cause duplicate transport, never a second logical audit row.

Canonical DO state, not a client-provided QA/security boolean or workflow event,
determines completion. Governance evidence must identify the same org, linked
artifact, and current stored version. Revisions invalidate earlier-version
evidence for completion. Authority is rechecked against the artifact at approval/completion and against upload capabilities at use/commit; a later security block or suspension is not bypassed by earlier evidence.

Snapshot recovery is current state plus a room head cursor, not full historical
event sourcing. Audit replay proves the named company path only; it does not
claim every D1 table can be rebuilt from events. Workflow completion is checked separately against canonical workflow records; it is not fabricated as an audit event from the presence of approvals.

TaskDO per org and ArtifactDO per org remain MVP serialization domains.
Future scale can move TaskDO to project/task shards and ArtifactDO to per-artifact
or shards. No sharding rewrite is performed in this remediation.

## Supported limits and protocols

- Reserve requests carry metadata only (`x-artifact-size`, `x-checksum-sha256`, media type and optional task/filename headers); `Content-Length` describes the actual body only on the subsequent streaming PUT.
- Inline artifacts: 1 MiB; reserved streamed artifacts: 100 MiB. Upload capabilities expire after 15 minutes and require the authenticated reserving actor.
- WebSocket pre-authentication deadline: 10 seconds; UTF-8 frame bound: 8 KB.
- Room replay: 100 events. An employee session can call `GET /orgs/:orgId/rooms/:roomId/snapshot`, then reconnect with `last_seen_seq = head_seq`. Non-members and foreign tenants cannot snapshot.
- Default guards: 10 active tasks/agent, 100 messages/task, 3 task retries, 1,000 daily organization execution actions, 200 daily employee execution actions, 8 handoffs, and 8 workflow revisions.
- Real room messages derive the employee's current task server-side before calling the canonical task budget guard; omitting a task ID is not a bypass. Generic messages without a current task remain room chat.
- Task execution guards include projected organization domain actions and durable task-message counters. They are not global HTTP throttles or billing limits.
- Generic tasks keep completion policy `NONE`. Production creators opt into `ARTIFACT_APPROVED`, `QA_SECURITY`, or `HUMAN_FINAL`.
- Task terminal/reassignment projections reconcile on Agent snapshot reads; late terminal ACK cannot make the Agent busy again.

## Verification ledger

Final local verification: PASS on the frozen implementation tree (`84728403f1277a7b6cb9ac9f4e8d5687f158c7c8`; only review-document updates follow).

| Check                                                                                  | Result                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile                                                         | PASS                                                                                                            |
| pnpm --filter @ai-company/api types (local)                                            | PASS                                                                                                            |
| pnpm format                                                                            | PASS                                                                                                            |
| pnpm lint                                                                              | PASS                                                                                                            |
| pnpm typecheck                                                                         | PASS                                                                                                            |
| pnpm test                                                                              | PASS — 135 tests / 41 files (domain 14, policy 15, schemas 2, API 104)                                          |
| Fresh SQLite migration chain                                                           | PASS                                                                                                            |
| Populated 0010 → 0014 upgrade, preserved artifact/governance data and immutable guards | PASS                                                                                                            |
| Diff review and no .skip/.only/.todo test exclusions                                   | PASS                                                                                                            |
| Exact-head GitHub CI                                                                   | Pinned in the PR checks and verification comment after publication; do not infer success from this local ledger |

Negative checksum/workflow tests can emit expected local workerd diagnostics; suite exit code is zero. No failing test was skipped or expectation weakened to obtain a pass. Legacy inbox fixtures now create canonical delivered tasks; room-socket fixtures bind those tasks to the room. The old null-current-task assertion after ACK is replaced by the required BUSY projection and terminal read reconciliation.

The API suite also applies all migrations using local Miniflare D1. Python
migration checks are an additional SQLite fresh/upgrade assertion, not a claim
of remote D1 validation.

## Remaining limitations

- No real human identity-provider/login UI; session issuance is trusted internal RPC.
- No UI, live Muse/CUE adapters, staging, production, or remote resource provisioning.
- Large bytes are streamed via an authenticated Worker-to-R2 capability, not a publicly exposed bucket or presigned S3 URL.
- Existing small inline upload remains intentionally bounded and may use DO RPC.
- Application immutability does not prevent an administrator with direct R2/D1 access from tampering with storage.
- Budget guards protect task execution; generic chat without active work is not charged to a task-message budget. They are not billing or a universal edge abuse limiter.
- Terminal Agent availability is reconciled on snapshot reads, rather than a separate completion-event fan-out.
- D1 evidence projections and queue delivery are eventually consistent; delayed evidence must be retried or delivered, never assumed true.
- The review and exact-head CI gates must pass before remediation completion is claimed.

## Safety

`production_mutation = NONE`; `staging_deploy = NONE`;
`production_deploy = NONE`; `cloudflare_remote_resource_creation = NONE`;
`secrets_changed = NONE`; `provider_credentials_added = NONE`;
`muse_contacted = NO`; `cue_contacted = NO`.

All Cloudflare commands and tests in this task are local-only. GitHub branch/PR/CI
publication is not a Cloudflare deployment. No unrelated account resources were
read or changed for remediation.
