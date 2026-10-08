# Phase 10 report

STATUS: PHASE10_COMPANY_POC_PASS

Repository: https://github.com/vn-tak/roomAgent
Branch: main
Starting SHA: none
Ending SHA: none. Changes are local and uncommitted.

Scope implemented:

- One local company proof for organization `AI STUDIO LAB`.
- Six employees on seeded roles, each with a browser runtime session.
- Room `PROJECT POC-001`, one creative task, artifact versions 1 and 2, and the existing production-task workflow.
- Authority attacks A through E, the handoff loop guard, delivery states, and room hibernation.

Architecture decisions:

- The project is a room. There is no project table.
- The CEO creates the task, so the owner human is not the task creator. The owner can approve the task and can send the workflow human-approval event.
- The CEO assigns the manager first. The manager assigns Worker A and delivers.
- QA rejection of version 1 is a direct ArtifactDO review plus TaskDO `request_revision`. The workflow then records `PASS` on version 2, security approval, and the owner final approval.
- Muse and CUE stay unimplemented. The authorized session is the browser join and redeem path. `external_ref` is null.
- No new migration, domain event, queue, workflow class, HTTP route, or adapter.
- `@ai-company/domain` remains an API devDependency that the Worker imports.

Files:

- `apps/api/test/company-poc.test.ts`
- `docs/testing/e2e-company-poc.md`
- `docs/architecture/overview.md`
- `docs/security/threat-model.md`
- `README.md`

D1 migrations:

- None added. Local migrations `0001` through `0010` stay as applied in earlier phases. `0010` was 6 commands on placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run.

Durable Objects: existing `OrganizationDO`, `RoomDO`, `AgentDO`, `TaskDO`, and `ArtifactDO`. No namespace was deployed.

Queues: unchanged local names. No `wrangler queues create`.

Workflows: the existing local class `ProductionTaskWorkflow`, binding `PRODUCTION_TASK`, name `ai-company-os-production-task`. `wrangler workflows` was not run against the account. The workflow was not deployed.

R2 changes: none. `wrangler r2 bucket create` was not run. No remote object was written. The POC stores two small text versions through the existing local binding.

Security controls:

- Worker final approval returns `NO_PERMISSION` and writes no approval row.
- Manager security override returns `NO_PERMISSION` when a short reason is supplied.
- Security cannot modify the worker artifact.
- A suspended Worker B is denied with `SUSPENDED_AGENT_DENY` before the action runs.
- A call from this organization into another organization's task or artifact returns `TENANT_BOUNDARY`. The other organization's D1 lookup returns null.
- The ninth assignee change on a second task pauses it with `LOOP_GUARD` and `human_review_required`. The assignee stays in place.
- An open socket moves the inbox from `QUEUED` to `DELIVERED`. It does not move the task to `WORKING`. Task ack does not set `current_task_id`. After the sweep, availability is `DEGRADED` and reachability stays `BROWSER_CONNECTED`.

Tests:

- focused: `pnpm --filter @ai-company/api exec vitest run test/company-poc.test.ts` — 1 passed
- integration: Workers Vitest, including `company-poc.test.ts`
- full: `pnpm test` — 92 passed (domain 14, policy 15, schemas 2, api 61)
- typecheck: `pnpm typecheck` passed
- lint: `pnpm lint` passed
- format: `pnpm format` passed
- build: Worker executed inside the Workers test runner. No deploy and no remote dry-run.
- End-to-end six-agent POC: RUN locally

Known limitations:

- Muse and CUE were not contacted. A browser session is not a Muse session.
- The local workflow engine can report instance status `running` while `waitForEvent` is pending. The run row is `waiting_for_approval`. Completion still requires the human event.
- The 24 hour event timeout can print a hang warning in the local engine. The suite exit code was 0.
- Phase 9 denial paths still throw `NonRetryableError`. The local engine prints that and records those instances as `errored`. The company path itself completes.
- Human commands stay on trusted RPC until a human session exists.
- Reachability has no degraded value. The timeout signal is availability `DEGRADED`.
- Direct Durable Object RPC can name an actor.
- An operator with direct D1 access can still drop the database file.

Production mutations: none
Secrets: none
Unrelated account resources: untouched

Next safe step: stop. The numbered build order ends at this company proof. Do not start a UI, Vectorize, a second workflow, or a deploy from this result.
