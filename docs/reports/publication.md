# Publication report

## Remediation review package

The current review package is [architecture-remediation-v1.md](architecture-remediation-v1.md).
It supersedes the baseline's known limitations only where backed by new tests.
The original publication record below remains historical. Do not merge or deploy before independent review.

## Historical baseline (superseded where noted)

STATUS: `AI_COMPANY_OS_POC_PARTIAL`

Repository: https://github.com/vn-tak/roomAgent
Branch: `main`
Starting SHA: none. The GitHub repository was empty.
Ending SHA: this commit. It is the first commit on `main`.

This document is the package for an independent review. Phase reports `docs/reports/phase1.md` through `docs/reports/phase10.md` are the historical gate records. They say ending SHA `none` because the work was untracked until this publication.

## Scope of the commit

Local implementation of AI Company OS from discovery through the six-employee company proof.

Included:

- pnpm workspace, TypeScript 5.9, Vitest 4.1, Wrangler 4.148, Hono, Zod
- Domain, policy, schemas, and the tenant-scoped D1 store
- OrganizationDO, RoomDO, AgentDO, TaskDO, ArtifactDO
- API Worker gateway, queue consumers, and `ProductionTaskWorkflow`
- Migrations `0001` through `0010`
- Architecture notes, threat model, company POC record, status, and this plan
- GitHub Actions check: format, lint, typecheck, test. The workflow does not deploy.

Excluded on purpose:

- A live Muse or CUE login
- A human HTTP session and a human UI
- Remote D1, remote R2, remote queues, remote workflows, and `wrangler deploy`
- Secrets, cookies, passwords, and provider credentials
- Any write to unrelated Cloudflare resources already on the account

## Architecture the reviewer can rely on

```text
API Worker          stateless gateway, queue consumers, ProductionTaskWorkflow
OrganizationDO      authorize()
RoomDO              hibernating room sequence
AgentDO             inbox, reachability, browser session
TaskDO              task transitions
ArtifactDO          immutable versions, reviews, approvals
D1                  relational queries scoped by org_id and id
Queues              at-least-once domain events, agent delivery, dead letter
Workflows           one human-approval wait
R2                  immutable artifact bytes
```

An employee is an organization record. A runtime binding can be replaced. Muse and CUE are adapter labels. They are not the employee.

Direct Durable Object RPC is trusted. The untrusted edge is HTTP and WebSocket. `x-employee-id` is not authority. A human-approval workflow event is not authority: the step calls OrganizationDO for `workflow.approve`, then ArtifactDO `finalize`.

## Company proof that passed locally

Organization: `AI STUDIO LAB`.

Employees: EMP01 CEO / Coordinator, EMP02 Manager, EMP03 Worker A, EMP04 Worker B, EMP05 QA, EMP06 Security. Seeded roles `executive`, `manager`, `employee`, `qa`, and `security`. Six browser sessions. `external_ref` is null. No CUE employee was required.

Project room: `PROJECT POC-001`.
Task objective: `Create and review one small creative artifact.`

Path:

1. The owner creates the room through the store.
2. The CEO creates the task, assigns the manager at handoff 0, and the task is `QUEUED`.
3. The manager assigns Worker A at handoff 1 and delivers.
4. With the worker socket closed, the inbox is `QUEUED` and reachability is `UNREACHABLE`. The task is `DELIVERED`, not `WORKING`.
5. The worker socket receives `inbox.delivered`. The inbox is `DELIVERED`. `current_task_id` stays null because the inbox item is not acknowledged.
6. Worker ack moves the task to `ACKNOWLEDGED`. Worker start moves it to `WORKING`.
7. Worker A stores artifact version 1 and submits. QA records `REVISION_REQUIRED` and requests revision.
8. Worker A stores version 2 and submits.
9. The workflow records QA `PASS` on version 2, security `APPROVE`, waits for the owner, then finalizes. Output: `{ outcome: "COMPLETE", iteration: 0 }`.
10. The owner approves the task. The manager completes it. State `COMPLETED`.
11. Sweep expires the unacked inbox row. Availability becomes `DEGRADED`. Reachability stays `BROWSER_CONNECTED`.

Authority results in `apps/api/test/company-poc.test.ts`:

| Attack                                                       | Result                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Worker `ArtifactDO.finalize`                                 | `NO_PERMISSION`, no approval row                                                                                               |
| Manager `security.block.override` with reason `POC`          | `NO_PERMISSION`                                                                                                                |
| Security `put` on the worker artifact                        | `NO_PERMISSION`, both versions remain                                                                                          |
| Suspended Worker B `put`                                     | `SUSPENDED_AGENT_DENY`                                                                                                         |
| Employee of this org calls the other org's task and artifact | `TENANT_BOUNDARY`. D1 lookup by the other `org_id` returns null                                                                |
| Manager reassigns a second task past 8 handoffs              | `PAUSED`, `LOOP_GUARD`, `human_review_required`, assignee unchanged                                                            |
| Room hibernation                                             | next message sequence is the previous sequence plus 1. Presence stays `online`. The socket attachment still has the session id |

Test file: `apps/api/test/company-poc.test.ts`.
Narrative: `docs/testing/e2e-company-poc.md`.

## Success criteria

| Criterion                                              | Result                                                                      | Evidence                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Human can create an organization                       | Pass, through the store. No human HTTP route.                               | `createStudio` in `apps/api/test/helpers.ts`                                                        |
| Human can create six employees                         | Pass                                                                        | `company-poc.test.ts`                                                                               |
| Employees bind to independent runtime sessions         | Pass for browser redeem                                                     | `company-poc.test.ts`                                                                               |
| Muse joins with a browser and a one-time code          | Not met                                                                     | Muse client is absent. `docs/architecture/agent-runtime.md`                                         |
| Multiple Muse instances are distinguishable            | Not met                                                                     | No Muse sessions exist                                                                              |
| Different Muse instances receive different permissions | Not met as Muse. The six employees do hold different seeded roles.          | role templates and the POC role rows                                                                |
| Manager can assign a worker                            | Pass                                                                        | `company-poc.test.ts`                                                                               |
| Worker cannot exercise manager rights                  | Pass, `NO_PERMISSION` on assign                                             | `company-poc.test.ts`                                                                               |
| Security can block                                     | Pass in authority tests. The POC itself proves the manager cannot override. | `authority.test.ts`, `company-poc.test.ts`                                                          |
| Manager cannot override security                       | Pass                                                                        | `company-poc.test.ts`                                                                               |
| Creator cannot final-approve their own artifact        | Pass as `NO_SELF_APPROVAL` when the actor has the permission                | `governance.test.ts`, `production-task-workflow.test.ts`                                            |
| Agent receives a structured task                       | Pass                                                                        | inbox `QUEUED` then `DELIVERED`                                                                     |
| Delivery and ack are distinguishable                   | Pass                                                                        | task `DELIVERED` until `ack`, then `ACKNOWLEDGED`                                                   |
| Agent can submit an artifact                           | Pass                                                                        | versions 1 and 2                                                                                    |
| QA can reject                                          | Pass                                                                        | `REVISION_REQUIRED` on version 1                                                                    |
| Worker can submit a revision                           | Pass                                                                        | version 2                                                                                           |
| QA, security, and human gates function                 | Pass                                                                        | workflow output `COMPLETE`, iteration 0                                                             |
| Room survives hibernation                              | Pass                                                                        | `company-poc.test.ts`                                                                               |
| Queue duplicates do not duplicate the business effect  | Pass                                                                        | `event-delivery.test.ts`. The POC org had zero dead letters after pump                              |
| Cross-tenant access is blocked                         | Pass                                                                        | `TENANT_BOUNDARY` and a null D1 row                                                                 |
| Agent loop guard works                                 | Pass                                                                        | `LOOP_GUARD` on the second task                                                                     |
| The whole execution can be rebuilt from audit events   | Partial                                                                     | Audit rows are append-only. The POC test does not replay the company path from `audit_events` alone |

Because the Muse rows are not met, and the audit replay is partial, the certification is `AI_COMPANY_OS_POC_PARTIAL`.

## Checks recorded before publication

At the close of Phase 10:

- `pnpm test` — 92 passed (domain 14, policy 15, schemas 2, api 61)
- `pnpm typecheck` passed
- `pnpm lint` passed
- `pnpm format` passed

This publication adds documents only. The independent confirmation is the GitHub Actions run on this commit.

Local engine notes a reviewer may see in logs: instance status `running` during `waitForEvent` while the D1 row is `waiting_for_approval`; a hang warning from the 24 hour timeout; `NonRetryableError` text from Phase 9 denial tests. The suite exit code was 0.

## Review method

1. Read `docs/STATUS.md`, `docs/PLAN.md`, and this file.
2. Read `docs/security/threat-model.md` and `docs/testing/e2e-company-poc.md`.
3. Read `apps/api/test/company-poc.test.ts` against `docs/testing/e2e-company-poc.md`.
4. Confirm `apps/api/wrangler.jsonc` has the placeholder D1 id and no `"remote": true`.
5. Run `pnpm install --frozen-lockfile`, then `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
6. Treat a green CI run as the check that this commit matches those commands. Treat a red CI run as a publication defect.

Questions worth pressing:

- Human actions are trusted RPC. Is any HTTP route able to mutate as a named employee without a session?
- Can a workflow event complete a run when OrganizationDO denies `workflow.approve`?
- Can a review, a room message, or artifact bytes approve a task or move the canonical version?
- Does any table store a join code, session token, cookie, or password in plaintext?
- Does any query read a child row without both `org_id` and id?

## Production mutations

None.

## Secrets

None changed. None are stored in this commit.

## Next safe step

Stop on this publication. The next product work is listed in `docs/PLAN.md` and starts only when a later request says to continue. The first item on that list is a human session, not a deploy and not a Muse login.
