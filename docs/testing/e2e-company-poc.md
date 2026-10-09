# End-to-end company POC

## Remediated company path

The updated company test exercises canonical work acceptance, an externally produced
QA revision followed by QA PASS, separate security approval, and stored human approval.
Workflow notifications are wakeups, not authority. Task policies check the current
linked artifact version's authoritative governance evidence.

The audit replay regression reconstructs this bounded company path from authoritative
audit/domain records and compares its final state with canonical records. It is not a
claim of universal event sourcing or a complete D1 rebuild.

See [the remediation report](../reports/architecture-remediation-v1.md) for verification.
The earlier Phase 10 flow below records the original split ACK and scripted workflow.

## Historical baseline (superseded where noted)

Status: RUN locally in the Workers test runner (`apps/api/test/company-poc.test.ts`). Nothing was deployed.

Organization: `AI STUDIO LAB`.

Employees and seeded roles:

- EMP01 CEO / Coordinator, executive
- EMP02 Manager, manager
- EMP03 Worker A, employee
- EMP04 Worker B, employee
- EMP05 QA, qa
- EMP06 Security, security

There is no seventh employee. CUE is not required.

Runtime sessions: six browser redeem sessions. Each active binding is `runtime_type = BROWSER`, `adapter_type = browser`, and `external_ref` null. The session row stores `token_hash` only. Muse and CUE were not contacted. No provider cookie, password, or credential was stored.

Project: room `PROJECT POC-001`, created through the store by the owner human. A human HTTP session does not exist yet.

Flow that ran:

1. The CEO creates the task. The objective is `Create and review one small creative artifact.`
2. The CEO assigns the manager. That first assignment stays at handoff 0 and the task is `QUEUED`.
3. The manager assigns Worker A. Handoff becomes 1. The task stays `QUEUED`.
4. The manager delivers while the worker socket is closed. The task is `DELIVERED`. The inbox row is `QUEUED`. Reachability is `UNREACHABLE`. `current_task_id` is null.
5. The worker socket opens. The inbox row becomes `DELIVERED` and the client receives `inbox.delivered`. The task stays `DELIVERED`. Availability is `IDLE`. The inbox item is not acknowledged, so `current_task_id` stays null.
6. Worker A acks the task. The task is `ACKNOWLEDGED`. `current_task_id` stays null.
7. Worker A starts. The task is `WORKING`.
8. Worker A stores artifact version 1 and submits. The task is `REVIEW`.
9. QA records `REVISION_REQUIRED` on version 1 and requests revision. The task is `REVISION`. Version 1 remains.
10. Worker A stores version 2, starts, and submits. The task is `REVIEW`.
11. `ProductionTaskWorkflow` reviews version 2 as `PASS`, records security `APPROVE`, waits for the owner human event, then finalizes. The output is `{ outcome: "COMPLETE", iteration: 0 }`.
12. The owner approves the task. The manager completes it. The task is `COMPLETED`.
13. A sweep expires the unacked `DELIVERED` inbox row. Availability becomes `DEGRADED`. Reachability stays `BROWSER_CONNECTED` while that socket is open. The task stays `COMPLETED`.

Authority results inside this organization:

- Worker A `ArtifactDO.finalize` returns `NO_PERMISSION`. No approval row is written.
- The manager calls `security.block.override` with reason `POC` and returns `NO_PERMISSION`.
- Security `put` on the worker artifact returns `NO_PERMISSION`. The version count stays 2.
- The owner suspends Worker B. Worker B `put` returns `SUSPENDED_AGENT_DENY`.
- An employee of `AI STUDIO LAB` calling the other organization's task and artifact objects returns `TENANT_BOUNDARY`. A D1 read with the other `org_id` and this task or artifact id returns null.
- On a second task, Worker A cannot assign. The manager alternates Worker A and Worker B until handoff 8. The next change pauses that task: `PAUSED`, `LOOP_GUARD`, `human_review_required`, and the assignee stays Worker A.

Hibernation: the project room accepts a message, survives `evictDurableObject` with hibernating WebSockets, and delivers the next message at the previous sequence plus one. Presence stays `online`. The socket attachment still carries the session id.

Skipped because those runtimes are not implemented: a live Muse session and a live CUE session. No UI was started.
