# Plan

Recorded: 2026-10-09

The numbered build order in the master plan is P0 through P10. Those ten implementation phases have local gates. This plan says what that means, what is still open, and what a later session may do.

## Closed locally

| Order | Work                                                                         | Gate                            |
| ----- | ---------------------------------------------------------------------------- | ------------------------------- |
| P0    | Discovery. Empty repository. No product resources on the Cloudflare account. | `PHASE0_DISCOVERY_COMPLETE`     |
| P1    | Domain types, permission catalog, tenant-scoped D1.                          | `PHASE1_DOMAIN_FOUNDATION_PASS` |
| P2    | OrganizationDO authority.                                                    | `PHASE2_AUTHORITY_ENGINE_PASS`  |
| P3    | RoomDO hibernating WebSocket.                                                | `PHASE3_ROOM_REALTIME_PASS`     |
| P4    | Join codes, browser session, inbox.                                          | `PHASE4_AGENT_JOIN_PASS`        |
| P5    | TaskDO state machine and handoff cap.                                        | `PHASE5_TASK_ENGINE_PASS`       |
| P6    | Domain events, idempotent consumers, retry, dead letter.                     | `PHASE6_EVENT_DELIVERY_PASS`    |
| P7    | ArtifactDO and immutable R2 versions.                                        | `PHASE7_ARTIFACT_PIPELINE_PASS` |
| P8    | Reviews, approvals, append-only audit.                                       | `PHASE8_GOVERNANCE_PASS`        |
| P9    | One `ProductionTaskWorkflow`. Human approval waits on `waitForEvent`.        | `PHASE9_DURABLE_WORKFLOW_PASS`  |
| P10   | Six-employee company proof on browser sessions.                              | `PHASE10_COMPANY_POC_PASS`      |

Policies that already constrain the code: test layers, format/lint/typecheck/test gates, forward-only local migrations, no secrets in the repo, no production deploy, structured denials, and the threat model.

## Certification

State: `AI_COMPANY_OS_POC_PARTIAL`.

`AI_COMPANY_OS_POC_CERTIFIED` stays unissued. The master-plan success list includes a real Muse join. This repository proved the same company flow with browser sessions and left Muse unimplemented on purpose. A browser row labeled `muse` would be a false session, so that shortcut is rejected.

## Still open

These items are specified and not built. They are the remaining product plan. They are not started in the publication commit.

1. Human session. HTTP mutations for a person stay off until a real human session exists. Today the owner acts through trusted Durable Object RPC and the store. `x-employee-id` is not authority.
2. Minimum human UI after that session: organizations, employees, departments, rooms, tasks, artifacts, approvals, security blocks, audit, and runtime sessions. Function before visual polish.
3. Muse adapter as a replaceable runtime. The employee record stays the authority. The adapter must not store a Muse password, cookie, or provider credential, and it must not bypass a provider login wall.
4. CUE adapter on the same rule. The baseline company proof does not require CUE.
5. Remaining runaway limits. Implemented today: `max_handoffs` 8 and `max_workflow_iterations` 8. Not implemented: `max_active_tasks_per_agent`, `max_agent_messages_per_task`, `max_task_retries`, `org_daily_action_budget`, and `agent_action_budget`.
6. One asserted audit replay of the company path. Domain events and audit rows are append-only. The company test does not yet reconstruct every step from `audit_events` alone.
7. Vectorize stays unused. Add it only when a retrieval feature has a tenant-scoped design. It is not required for the control plane.
8. Staging deploy. Create a new staging D1 database, R2 bucket, queues, and workflow on purpose. Then point Wrangler at those new ids. The placeholder id `00000000-0000-4000-8000-000000000001` must not be applied remotely. Existing account databases and buckets stay out of scope.

## Suggested order for the next session

Do this only when someone explicitly asks to continue.

1. Keep the current gates green.
2. Add a human session and move owner mutations off raw RPC.
3. Add the minimum UI against that session, and verify it in a browser.
4. Add one provider adapter only with an explicit non-credential binding design.
5. Add the remaining loop and budget limits with tests.
6. Add the audit-replay assertion for `PROJECT POC-001`.
7. Open a staging Cloudflare namespace that contains only AI Company OS resources, then deploy that namespace.

A UI, a second workflow, Vectorize, or a deploy is out of scope until that session starts.

## Safety rules that stay in force

- Workers, Durable Objects with SQLite, D1, Queues, Workflows, and R2. KV only if a later design shows it is required.
- OrganizationDO authorizes. RoomDO orders messages. AgentDO owns inbox and reachability. TaskDO owns task transitions. ArtifactDO owns versions, reviews, and approvals. D1 is the relational query. Queues are the at-least-once bus. The one workflow waits for a human. R2 stores immutable bytes.
- Chat text and artifact bytes have zero authority.
- Logs omit Authorization, Cookie, tokens, join codes, session tokens, event payloads, artifact bytes, review text, and task objectives.
- Role templates stay as seeded. Employee plus security is rejected. `workflow.approve` stays off the employee, QA, and security templates.
- Wrangler stays without `"remote": true`.
- Git identity for this repo is local: `vn-tak` / `335007142+vn-tak@users.noreply.github.com`.
