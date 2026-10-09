import type { Organization } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { openBrowserSession, organizationStub } from "./helpers";
import { prepare, type Prepared } from "./workflow-fixtures";

interface Actor {
  token: string;
  employeeId?: string;
}

interface Body {
  workflow_run_id?: string;
  policy?: string;
  duplicate?: boolean;
  error?: { code: string; workflow_run_id?: string; hold_reason?: string };
}

async function actors(prepared: Prepared): Promise<{
  owner: Actor;
  manager: Actor;
  executive: Actor;
}> {
  const org: Organization = prepared.org;
  const owner = await organizationStub(org.id).issueHumanSession({
    orgId: org.id,
    actorType: "human",
    actorId: org.createdByUserId,
    ttlSeconds: 600,
  });
  // Both hold the resolution scope so any denial comes from authority, not the session.
  const scopes = ["task.assign", "workflow.approve"];
  const manager = await openBrowserSession(org, prepared.managerId, scopes);
  const executive = await openBrowserSession(org, prepared.executiveId, scopes);
  return {
    owner: { token: owner.token ?? "" },
    manager: { token: manager.token, employeeId: prepared.managerId },
    executive: { token: executive.token, employeeId: prepared.executiveId },
  };
}

function headers(actor: Actor, key: string): Record<string, string> {
  return {
    authorization: `Bearer ${actor.token}`,
    "content-type": "application/json",
    "x-idempotency-key": key,
    ...(actor.employeeId ? { "x-employee-id": actor.employeeId } : {}),
  };
}

async function start(prepared: Prepared, actor: Actor, key: string) {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${prepared.org.id}/tasks/${prepared.taskId}/workflow-runs`,
    {
      method: "POST",
      headers: headers(actor, key),
      body: JSON.stringify({ artifact_id: prepared.artifactId, version: 1 }),
    },
  );
  return { status: response.status, body: await response.json<Body>() };
}

async function resolve(
  prepared: Prepared,
  actor: Actor,
  runId: string,
  key: string,
  reason: string,
) {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${prepared.org.id}/workflow-runs/${runId}/resolution`,
    {
      method: "POST",
      headers: headers(actor, key),
      body: JSON.stringify({ hold_reason: reason }),
    },
  );
  return { status: response.status, body: await response.json<Body>() };
}

async function untilHeld(orgId: string, runId: string, reason: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        `SELECT hold_reason FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(orgId, runId)
        .first<{ hold_reason: string | null }>();
      expect(row?.hold_reason).toBe(reason);
    },
    { timeout: 8_000, interval: 20 },
  );
}

async function startedRun(prepared: Prepared, actor: Actor, key: string): Promise<string> {
  const started = await start(prepared, actor, key);
  expect(started.status).toBe(201);
  return started.body.workflow_run_id ?? "";
}

describe("workflow hold resolution", () => {
  it("keeps a LOOP_GUARD hold across new idempotency keys until the owner resolves it", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    // Drive the real revision loop to its cap: every QA read says REVISION_REQUIRED and
    // every version read finds a new version, so the workflow itself writes LOOP_GUARD.
    await workflows.modifyAll(async (m) => {
      for (let i = 0; i < 8; i += 1) {
        await m.mockStepResult({ name: `read-qa-${i}-0` }, { result: "REVISION_REQUIRED" });
        await m.mockStepResult({ name: `read-version-${i + 1}-0` }, i + 2);
      }
    });
    const prepared = await prepare("Hold loop guard");
    const { owner, manager, executive } = await actors(prepared);
    const runId = await startedRun(prepared, manager, "hold_loop_start");
    await untilHeld(prepared.org.id, runId, "LOOP_GUARD");
    const run = await env.DB.prepare(`SELECT status, iteration FROM workflow_runs WHERE id = ?`)
      .bind(runId)
      .first<{ status: string; iteration: number }>();
    expect(run).toEqual({ status: "paused", iteration: 8 });

    for (const key of ["hold_loop_retry_a", "hold_loop_retry_b"]) {
      const retried = await start(prepared, manager, key);
      expect(retried.status).toBe(409);
      expect(retried.body.error).toMatchObject({
        code: "WORKFLOW_HELD",
        workflow_run_id: runId,
        hold_reason: "LOOP_GUARD",
      });
    }
    const replay = await start(prepared, manager, "hold_loop_start");
    expect(replay.status).toBe(200);
    expect(replay.body.workflow_run_id).toBe(runId);

    // The database refuses to clear the hold or the run outside a recorded resolution.
    await expect(
      env.DB.prepare(
        `UPDATE workflow_start_claims SET state = 'released', release_reason = 'completed'
         WHERE id = ?`,
      )
        .bind(runId)
        .run(),
    ).rejects.toThrow(/WORKFLOW_RELEASE_DENIED/);
    await expect(
      env.DB.prepare(`UPDATE workflow_runs SET status = 'running', hold_reason = NULL WHERE id = ?`)
        .bind(runId)
        .run(),
    ).rejects.toThrow(/WORKFLOW_IMMUTABLE/);

    expect((await resolve(prepared, manager, runId, "hold_loop_mgr", "LOOP_GUARD")).status).toBe(
      403,
    );
    const byExecutive = await resolve(prepared, executive, runId, "hold_loop_exec", "LOOP_GUARD");
    expect(byExecutive.status).toBe(403);
    expect(byExecutive.body.error?.code).toBe("NO_PERMISSION");
    const wrongReason = await resolve(prepared, owner, runId, "hold_loop_wrong", "TIMEOUT");
    expect(wrongReason.status).toBe(409);
    expect(wrongReason.body.error?.code).toBe("HOLD_REASON_MISMATCH");

    const resolved = await resolve(prepared, owner, runId, "hold_loop_owner", "LOOP_GUARD");
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ policy: "owner_human", duplicate: false });
    const again = await resolve(prepared, owner, runId, "hold_loop_owner", "LOOP_GUARD");
    expect(again.body.duplicate).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT hold_reason, policy, actor_type, actor_id FROM workflow_run_resolutions
       WHERE run_id = ?`,
    )
      .bind(runId)
      .all();
    expect(audit.results).toEqual([
      {
        hold_reason: "LOOP_GUARD",
        policy: "owner_human",
        actor_type: "human",
        actor_id: prepared.org.createdByUserId,
      },
    ]);
    const claim = await env.DB.prepare(
      `SELECT state, release_reason FROM workflow_start_claims WHERE id = ?`,
    )
      .bind(runId)
      .first();
    expect(claim).toEqual({ state: "released", release_reason: "resolved" });

    const restarted = await start(prepared, manager, "hold_loop_after");
    expect(restarted.status).toBe(201);
    expect(restarted.body.workflow_run_id).not.toBe(runId);
  });

  it("lets workflow approvers clear TIMEOUT holds with separation of duties and a budget", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    await workflows.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "qa-wakeup-0-0" });
    });
    const prepared = await prepare("Hold timeout");
    const { owner, manager, executive } = await actors(prepared);

    const first = await startedRun(prepared, executive, "hold_timeout_1");
    await untilHeld(prepared.org.id, first, "TIMEOUT");
    expect((await start(prepared, manager, "hold_timeout_bypass")).body.error?.code).toBe(
      "WORKFLOW_HELD",
    );
    const self = await resolve(prepared, executive, first, "hold_timeout_self", "TIMEOUT");
    expect(self.status).toBe(403);
    expect(self.body.error?.code).toBe("NO_SELF_RESOLUTION");
    expect((await resolve(prepared, manager, first, "hold_timeout_mgr", "TIMEOUT")).status).toBe(
      403,
    );
    const ownerResolved = await resolve(prepared, owner, first, "hold_timeout_r1", "TIMEOUT");
    expect(ownerResolved.body.policy).toBe("workflow_approver");

    const second = await startedRun(prepared, manager, "hold_timeout_2");
    await untilHeld(prepared.org.id, second, "TIMEOUT");
    expect((await resolve(prepared, executive, second, "hold_timeout_r2", "TIMEOUT")).status).toBe(
      200,
    );
    const third = await startedRun(prepared, manager, "hold_timeout_3");
    await untilHeld(prepared.org.id, third, "TIMEOUT");
    expect((await resolve(prepared, owner, third, "hold_timeout_r3", "TIMEOUT")).status).toBe(200);

    const fourth = await startedRun(prepared, manager, "hold_timeout_4");
    await untilHeld(prepared.org.id, fourth, "TIMEOUT");
    const exhausted = await resolve(prepared, owner, fourth, "hold_timeout_r4", "TIMEOUT");
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error?.code).toBe("RESOLUTION_BUDGET_EXHAUSTED");
    const blocked = await start(prepared, manager, "hold_timeout_5");
    expect(blocked.body.error).toMatchObject({ code: "WORKFLOW_HELD", workflow_run_id: fourth });
  });

  it("holds a failed instance that consumed revision budget instead of restarting it", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    await workflows.modifyAll(async (m) => {
      await m.mockStepResult({ name: "read-qa-0-0" }, { result: "REVISION_REQUIRED" });
    });
    const prepared = await prepare("Hold failed instance");
    const { manager, executive } = await actors(prepared);
    const runId = await startedRun(prepared, manager, "hold_failed_start");
    await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(`SELECT status, iteration FROM workflow_runs WHERE id = ?`)
          .bind(runId)
          .first();
        expect(row).toEqual({ status: "revision", iteration: 1 });
      },
      { timeout: 8_000, interval: 20 },
    );
    await (await env.PRODUCTION_TASK.get(runId)).terminate();
    await vi.waitFor(
      async () =>
        expect((await (await env.PRODUCTION_TASK.get(runId)).status()).status).toBe("terminated"),
      { timeout: 8_000, interval: 20 },
    );

    const retried = await start(prepared, manager, "hold_failed_retry");
    expect(retried.status).toBe(409);
    expect(retried.body.error).toMatchObject({
      code: "WORKFLOW_HELD",
      hold_reason: "INSTANCE_FAILED",
    });
    const resolved = await resolve(prepared, executive, runId, "hold_failed_r", "INSTANCE_FAILED");
    expect(resolved.status).toBe(200);
    expect((await start(prepared, manager, "hold_failed_after")).status).toBe(201);
  });
});
