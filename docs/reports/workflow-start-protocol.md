# Workflow start protocol (P1-01)

Gate: `ROOMAGENT_P1_WORKFLOW_ENTRYPOINT_PASS` (local evidence; remote not tested).

## Finding

`ProductionTaskWorkflow` was exported and bound as `PRODUCTION_TASK`, but only tests called
`PRODUCTION_TASK.create()`. No controlled runtime path could start a governed run, so the
workflow was unreachable by real business actions (`WORKFLOW_UNREACHABLE`).

## Previous behavior

- No HTTP route, queue consumer, or service created instances.
- `notifyProductionTaskEvidence` only woke runs that already existed.
- Any holder of the binding (or an account operator triggering the workflow) could create an
  instance with arbitrary parameters. `registerRun` re-validated the task, but nothing
  recorded who started the run or prevented a second concurrent run for the same task.

## Root cause

The phase 9 design deferred the entrypoint until a human session existed. Remediation v1
(R9) added the human session, but the start path itself was never built.

## Implementation

### Architecture choice

A synchronous HTTP command, `POST /orgs/:orgId/tasks/:taskId/workflow-runs`, in the stateless
Worker (`apps/api/src/workflow-start-route.ts`). An HTTP command gives the caller an immediate
authorization decision and a stable run id. A queue consumer would make denial asynchronous
and hide authorization failures. TaskDO stays the transition authority: starting a workflow
does not transition the task. Eligibility is read from the same D1 projections that
`registerRun` already trusts.

### Request

```http
POST /orgs/{orgId}/tasks/{taskId}/workflow-runs
Authorization: Bearer <human session | employee session>
X-Employee-Id: <emp_… for employee sessions only>
X-Idempotency-Key: <8–80 chars [A-Za-z0-9_-]>
Content-Type: application/json

{ "artifact_id": "art_…", "version": 1 }
```

The body must contain exactly `artifact_id` and `version`. Any other field, including
`actor_id`, `actor_type`, `owner`, `authority`, or evidence, returns `400 INVALID_INPUT`.

### Checks, in order

| #   | Check                                    | Failure                                                        |
| --- | ---------------------------------------- | -------------------------------------------------------------- |
| 1   | Authenticate (`resolveHttpPrincipal`)    | 401 `SESSION_INVALID`, 403 `NO_SCOPE` / `SUSPENDED_AGENT_DENY` |
| 2   | Resolve organization from path/session   | 401 (session is org-bound), 404 `TENANT_BOUNDARY`              |
| 3   | OrganizationDO `authorize`               | 403 `NO_PERMISSION` / `SECURITY_BLOCK`                         |
|     | action `workflow.start` on `task`        |                                                                |
| 4   | Task belongs to organization             | 404 `NOT_FOUND`                                                |
| 5   | Artifact belongs to task                 | 404 `ARTIFACT_NOT_FOUND`, 409 `ARTIFACT_TASK_MISMATCH`         |
| 6   | Task and artifact share room             | 409 `ROOM_MISMATCH`                                            |
| 7   | Completion policy is governed            | 409 `COMPLETION_POLICY_NOT_GOVERNED` (NONE is not a workflow)  |
| 8   | Task state is `REVIEW`; creator is the   | 409 `TASK_STATE_INVALID`, `ARTIFACT_CREATOR_NOT_ASSIGNEE`      |
|     | employee assignee                        |                                                                |
| 9   | Version equals `canonical_version`       | 409 `ARTIFACT_VERSION_STALE`                                   |
| 10  | No unreleased claim or legacy active run | 409 `WORKFLOW_ACTIVE` with the existing `workflow_run_id`      |
| 11  | Durable claim, then `create({ id })`     | Unique-index loser re-reads and replays or conflicts           |
| 12  | Return id and status                     | 201 new, 200 replay (`duplicate: true`)                        |

`workflow.start` is an action alias for the existing `task.assign` permission
(`packages/policy/src/authority.ts`). Owner, executive, and manager can start runs. Employee,
QA, security, and auditor cannot. No role template or permission catalog row changed.
An employee session additionally needs the `task.assign` scope.

### Durable claim and idempotency

Migration `0015` adds `workflow_start_claims`:

- `id` is the workflow instance id (`wfr_…`). Every API-created instance has a row recording
  the server-resolved actor, task, artifact, version, and idempotency key.
- `UNIQUE (org_id, idempotency_key)` makes a retried request map to the same logical run.
- A partial unique index `ON (org_id, task_id) WHERE state <> 'released'` makes the database
  admit at most one active start per task. D1 serializes writes, so two concurrent requests
  cannot both insert.
- The insert trigger re-validates the org/task/artifact/room/version and actor relationships,
  so a claim cannot be written for a mismatched pair even by a buggy caller.
- Claims are forward-only (`claimed → created → released`) and cannot be deleted.

`ProductionTaskWorkflow.registerRun` now joins on an unreleased claim with the same id, task,
artifact, and version. An instance created outside the API, for example with
`wrangler workflows trigger`, fails with `NonRetryableError(TENANT_BOUNDARY)` and never writes
a `workflow_runs` row.

### Failure and reconciliation

| Situation                                  | Behavior                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| Response lost after create                 | Same key → 200, same `workflow_run_id`, `duplicate: true`      |
| Crash after claim, before create           | Same key, or any later start for the task, calls               |
|                                            | `create({ id: claim.id })`; the stranded claim becomes a run   |
| Concurrent create of the same id           | `instance.already_exists` is caught and `get(id)` is confirmed |
| Same key with different task/artifact/     | 409 `IDEMPOTENCY_MISMATCH`; no run id is disclosed             |
| version/actor                              |                                                                |
| Run reaches `complete`                     | Released (`completed`); a new run may start                    |
| Run is `paused` or `denied`                | **Held.** 409 `WORKFLOW_HELD` with `hold_reason`, for any key, |
|                                            | until an explicit resolution (below)                           |
| Instance errored before registering        | Released (`never_registered`) once `get(id).status()` reports  |
|                                            | `errored`/`terminated`/`complete`, or a `created` claim's      |
|                                            | instance is confirmed absent (`instance.not_found`)            |
| Status lookup fails for any other reason   | **Fail closed.** 503 `WORKFLOW_STATUS_UNAVAILABLE` with the    |
|                                            | existing `workflow_run_id`; claim unchanged, nothing created,  |
|                                            | no resolution; the caller retries                              |
| Registered run whose instance died at      | Run marked `paused`/`INSTANCE_FAILED`, released automatically  |
| iteration 0                                | (`instance_failed`), at most twice per task                    |
| Registered run whose instance died after   | Held as `INSTANCE_FAILED`: restarting would reset the revision |
| consuming revisions, or a third crash      | budget                                                         |
| Same key after a released, unstarted claim | 200 with the original id and status `not_started`              |

### Instance status classification

`instanceStatus()` returns one of three states. `found` carries the reported status. `missing`
is returned only when the error carries the `instance.not_found` code. Every other failure,
including timeouts and service errors, is `unknown`. Only `missing` or a terminal `found`
status can release a claim that has no run row. `unknown` never releases a claim, never
creates or reconciles an instance, and never accepts a resolution. A claim that is
`claimed` but not yet `created` reconciles with `create({ id })` only after `missing` is
confirmed. `ensureInstance()` treats a failed `create()` as success only when the same id is
then `found`.

### Holds and explicit resolution

Every `paused`/`denied` run records `workflow_runs.hold_reason`. A hold is final: the run row
cannot change afterwards, and the claim stays unreleased, so the task cannot start a new
workflow under any idempotency key. Only an explicit resolution releases it:

```http
POST /orgs/{orgId}/workflow-runs/{runId}/resolution
Authorization: Bearer <session>      X-Idempotency-Key: <key>
{ "hold_reason": "LOOP_GUARD" }      // must equal the recorded reason
```

| Hold reason                                                   | Policy              | Who may resolve                                                                                 |
| ------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `LOOP_GUARD`, `SECURITY_DENIED`, `APPROVAL_DENIED`            | `owner_human`       | The organization's human owner only (`organization.policy.manage`)                              |
| `TIMEOUT`, `EVIDENCE_TIMEOUT`, `QA_FAILED`, `INSTANCE_FAILED` | `workflow_approver` | Holders of `workflow.approve` (owner, executive); an employee cannot resolve a run they started |

Managers hold neither permission. Each task allows at most three resolutions in total. After
that, the task needs a different decision (for example cancellation) rather than another run.
The resolution row (`workflow_run_resolutions`) is the insert-only audit record: run, task,
reason, policy, actor, and time. It is written in the same D1 batch as the claim release.
Resolving does not start a run. The next start must pass every eligibility check again and
begins a new, fully governed run.

The database enforces the policy independently of the API. The claim trigger allows a release
only for `completed` (run complete), `never_registered` (no run row), `instance_failed`
(`INSTANCE_FAILED` at iteration 0, fewer than two per task), or `resolved` (a resolution row
exists). The resolution trigger checks the held state, the reason/policy mapping, owner
identity, separation of duties, and the budget.

### Governance

The workflow still never impersonates QA, Security, or the Human Owner. It advances only on
stored evidence from authorized commands. Wakeup events carry no authority. Starting a run
grants no review or approval power.

## Security impact

- Closes untraceable workflow creation: unclaimed instances cannot register.
- Actor identity comes only from a verified session; forged body fields are rejected.
- The database enforces single-active-run, not only application logic.
- Error bodies for idempotency mismatches do not reveal another caller's run id.

## Regression tests

`apps/api/test/workflow-start-entrypoint.test.ts` (7), `workflow-hold-resolution.test.ts` (3),
`workflow-start-faults.test.ts` (3), and
`apps/api/test/production-task-workflow.test.ts` (+1):

| Required case                         | Test evidence                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorized start → PASS               | 201, run registers `running`, claim actor is the session owner                                                                                                                            |
| Unauthorized start → DENY             | anonymous 401, QA 403, worker 403                                                                                                                                                         |
| Wrong organization → DENY             | foreign session 401, foreign org path 404                                                                                                                                                 |
| Wrong task/artifact relationship      | foreign artifact 404, sibling task 409 `ARTIFACT_TASK_MISMATCH`                                                                                                                           |
| Wrong artifact version → DENY         | future and superseded versions 409 `ARTIFACT_VERSION_STALE`                                                                                                                               |
| Duplicate request → same workflow     | 200, same id, `duplicate: true`; reused key 409                                                                                                                                           |
| Concurrent start → no duplicate       | 3 parallel requests → exactly one 201, one claim, one instance                                                                                                                            |
| Workflow event before evidence        | wakeups without stored evidence leave stage `qa_review`                                                                                                                                   |
| Authorized QA evidence → advance      | QA PASS → `security`; security PASS → `waiting_for_approval`                                                                                                                              |
| Forged evidence → cannot advance      | worker review 403, forged human-approval wakeup ignored                                                                                                                                   |
| Human approval missing → no complete  | remains `waiting_for_approval` until owner HTTP final approval                                                                                                                            |
| Restart/retry → recoverable           | stranded claim reconciled; denied run held until resolved, then a new run admitted                                                                                                        |
| LOOP_GUARD cannot be reset by Manager | real 8-revision loop → held; new keys 409; manager/executive resolution 403; owner resolution audited, then new run                                                                       |
| TIMEOUT policy and budget             | forced event timeout → held; starter cannot self-resolve; approvers resolve; 4th resolution `RESOLUTION_BUDGET_EXHAUSTED`                                                                 |
| Failed instance after revisions       | terminated at iteration 1 → held `INSTANCE_FAILED`, released only by resolution                                                                                                           |
| DB enforcement (SQLite)               | `scripts/test-migrations.py` `WorkflowHoldPolicyTests` (5)                                                                                                                                |
| Untraceable instance                  | direct `create()` without claim → `errored`, no run row                                                                                                                                   |
| Dead instance                         | errored-unregistered and terminated-registered runs release task                                                                                                                          |
| Ambiguous status (fault injection)    | live, unregistered instance + status lookup throws → 503 for new keys and 3 concurrent starts; claim stays `created`, one instance; after recovery 409 `WORKFLOW_ACTIVE` with the same id |
| Confirmed not-found + recovery        | `created` claim with no instance: 503 while lookup fails, then `never_registered` release and one new run                                                                                 |
| Crashed-before-create + fault         | `claimed` claim: 503 while lookup fails; after recovery, same key reconciles the same id                                                                                                  |

Existing direct-binding tests now write the same claim with a fixture
(`claimWorkflowStart`) before `create()`, because unclaimed instances are rejected by design.

## Remaining risks

- Eligibility reads D1 projections; TaskDO projects synchronously, but a concurrent task
  transition between the check and `registerRun` makes the instance error and the claim
  release on the next start. This is fail-closed, not a lost run.
- Instances past Workflows retention (30 days on Paid) are reported as not found. A `created`
  claim with no run row is then released as `never_registered`.
- If the deployed Workflows service reports a missing instance without the
  `instance.not_found` code, the claim stays unreleased and starts for that task return 503.
  That is fail-closed, but it must be checked on staging.
- The local emulator's `get()` turns any status failure into `instance.not_found`. Transient
  failures are therefore injected through the test-harness fault seam, which is inactive
  outside the Vitest bindings.
- The `workflow_runs` projection is not yet exposed on a read route.

## Cloudflare remote verification required

- Workflow instance creation, `instance.already_exists`, and `get()` semantics on the deployed
  Workflows service, including retention and the exact not-found error code.
- D1 partial unique index and trigger behavior on remote D1 under concurrent requests.
- `REMOTE_NOT_TESTED`.
