# Workflows

Phase 9 adds one demonstration workflow, `ProductionTaskWorkflow`. Cloudflare Workflows are for a long business process. A chat message does not start a workflow. Realtime stays on RoomDO. Fan-out stays on the existing queues. Task transitions stay on TaskDO.

The local binding is `PRODUCTION_TASK`. The workflow name is `ai-company-os-production-task`. It is not created on the live account.

## Steps

```text
Worker submit
    ↓
QA review
    ↓
if fail → revision
    ↓
if pass → Security optional
    ↓
Human approval
    ↓
COMPLETE
```

Worker submit checks the stored artifact version for this organization, task, and room. It does not read bytes. QA review calls ArtifactDO `review` with a structured result: `PASS`, `FAIL`, or `REVISION_REQUIRED`. `FAIL` and `REVISION_REQUIRED` move the run to `revision` and keep the version. A pass may call ArtifactDO `securityApprove` when a security employee id is present. A null security id skips that step.

Human approval is `step.waitForEvent()` with event type `human-approval` and a 24 hour timeout. The workflow does not poll instance status. The event payload is an actor id and `ALLOW` or `DENY`. It is not permission. OrganizationDO must allow `workflow.approve` on the artifact. An `ALLOW` then calls ArtifactDO `finalize`, which still enforces creator self-approval and an active security block. A denial, a timeout, or eight revisions without a QA pass does not return `COMPLETE`. The instance errors. The run row is `denied` or `paused`.

`max_workflow_iterations` is 8, the same cap order as `max_handoffs`. Past that cap the run is `paused` with `LOOP_GUARD`.

## Projection

`workflow_runs` is queried by `org_id` and id. The id is `wfr_` plus 128 bits, and it is also the workflow instance id. Insert checks that the task, artifact, and version belong to the organization. Delete is rejected. An update may change status, stage, iteration, and `updated_at`. It cannot change the organization, task, artifact, or version, and it cannot lower the iteration.

The workflow does not publish a new domain event. Review and approval events still use the existing queue and do not fan out to agents. The workflow does not write R2 and does not transition the task.

## Authority

`workflow.approve` stays on the owner and executive templates. Employee, QA, and security do not receive it. A test-only custom role can hold it.

Runs start only through `POST /orgs/:orgId/tasks/:taskId/workflow-runs`. The action `workflow.start` requires `task.assign`. The route writes a durable `workflow_start_claims` row whose id is the instance id before it calls `create()`. `registerRun` refuses any instance without an unreleased claim. See [workflow-start-protocol.md](../reports/workflow-start-protocol.md).

Parameters carry ids, a correlation id, and the structured QA results. They do not carry an objective, a filename, bytes, or review text. Logs do not record the event payload.

The local Workers test runtime keeps instance status `running` while `waitForEvent` is pending. The run row is `waiting_for_approval` during that wait. The run reaches `complete` only after a permitted human `ALLOW` and a final approval.
