import { createId } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FAULT_WORKFLOW_STATUS } from "../src/events/names";
import { armEventFault, clearEventFaults } from "../src/events/test-seam";
import { claimWorkflowStart, organizationStub } from "./helpers";
import { paramsOf, prepare, runStatus, type Prepared } from "./workflow-fixtures";

interface Body {
  workflow_run_id?: string;
  duplicate?: boolean;
  error?: { code: string; workflow_run_id?: string };
}

async function ownerToken(prepared: Prepared): Promise<string> {
  const issued = await organizationStub(prepared.org.id).issueHumanSession({
    orgId: prepared.org.id,
    actorType: "human",
    actorId: prepared.org.createdByUserId,
    ttlSeconds: 600,
  });
  return issued.token ?? "";
}

function post(path: string, token: string, key: string, body: unknown) {
  return exports.default.fetch(`https://company.local${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

async function start(prepared: Prepared, token: string, key: string) {
  const response = await post(
    `/orgs/${prepared.org.id}/tasks/${prepared.taskId}/workflow-runs`,
    token,
    key,
    { artifact_id: prepared.artifactId, version: 1 },
  );
  return { status: response.status, body: await response.json<Body>() };
}

async function claims(prepared: Prepared) {
  return (
    await env.DB.prepare(
      `SELECT id, state, release_reason FROM workflow_start_claims
       WHERE org_id = ? AND task_id = ? ORDER BY created_at, id`,
    )
      .bind(prepared.org.id, prepared.taskId)
      .all<{ id: string; state: string; release_reason: string | null }>()
  ).results;
}

function expectUnavailable(result: { status: number; body: Body }, runId: string) {
  expect(result.status).toBe(503);
  expect(result.body.error).toMatchObject({
    code: "WORKFLOW_STATUS_UNAVAILABLE",
    workflow_run_id: runId,
  });
}

describe("workflow start with ambiguous instance status", () => {
  it("keeps the claim of a live unregistered instance when status lookup throws", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    // Registration keeps failing and retrying, so the instance exists without a D1 run row.
    await workflows.modifyAll(async (m) => {
      await m.mockStepError({ name: "register-run" }, new Error("D1 unavailable"), 5);
    });
    const prepared = await prepare("Fault live instance");
    const token = await ownerToken(prepared);
    const first = await start(prepared, token, "fault_live_a");
    expect(first.status).toBe(201);
    const runId = first.body.workflow_run_id ?? "";
    expect(await runStatus(prepared.org.id, runId)).toBeNull();
    expect(["queued", "running", "waiting"]).toContain(
      (await (await env.PRODUCTION_TASK.get(runId)).status()).status,
    );

    await armEventFault(env.DB, FAULT_WORKFLOW_STATUS, 100);
    try {
      expectUnavailable(await start(prepared, token, "fault_live_b"), runId);
      const concurrent = await Promise.all(
        ["fault_live_c", "fault_live_d", "fault_live_b"].map((key) => start(prepared, token, key)),
      );
      for (const result of concurrent) expectUnavailable(result, runId);
      // A replay of the original key needs no status lookup and still names the same run.
      const replay = await start(prepared, token, "fault_live_a");
      expect(replay.status).toBe(200);
      expect(replay.body.workflow_run_id).toBe(runId);
      const resolution = await post(
        `/orgs/${prepared.org.id}/workflow-runs/${runId}/resolution`,
        token,
        "fault_live_resolve",
        { hold_reason: "INSTANCE_FAILED" },
      );
      expect(resolution.status).toBe(503);

      expect(await claims(prepared)).toEqual([
        { id: runId, state: "created", release_reason: null },
      ]);
      expect(await workflows.get()).toHaveLength(1);
    } finally {
      await clearEventFaults(env.DB);
    }

    // Workflows API recovered: the live instance is still the only logical run.
    const recovered = await start(prepared, token, "fault_live_e");
    expect(recovered.status).toBe(409);
    expect(recovered.body.error).toMatchObject({ code: "WORKFLOW_ACTIVE", workflow_run_id: runId });
    expect(await claims(prepared)).toHaveLength(1);
    expect(await workflows.get()).toHaveLength(1);
  });

  it("releases a created claim only after a confirmed not-found, retried after recovery", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Fault not found");
    const token = await ownerToken(prepared);
    // A claim recorded as created whose instance does not exist (rejected, deleted, expired).
    const orphan = createId("wfr");
    await claimWorkflowStart(orphan, await paramsOf(prepared));
    await env.DB.prepare(`UPDATE workflow_start_claims SET state = 'created' WHERE id = ?`)
      .bind(orphan)
      .run();
    await expect(env.PRODUCTION_TASK.get(orphan)).rejects.toThrow(/instance\.not_found/);

    await armEventFault(env.DB, FAULT_WORKFLOW_STATUS, 100);
    try {
      expectUnavailable(await start(prepared, token, "fault_missing_a"), orphan);
      expect(await claims(prepared)).toEqual([
        { id: orphan, state: "created", release_reason: null },
      ]);
    } finally {
      await clearEventFaults(env.DB);
    }

    const retried = await start(prepared, token, "fault_missing_a");
    expect(retried.status).toBe(201);
    const next = retried.body.workflow_run_id ?? "";
    expect(next).not.toBe(orphan);
    expect(await claims(prepared)).toEqual(
      expect.arrayContaining([
        { id: orphan, state: "released", release_reason: "never_registered" },
        { id: next, state: "created", release_reason: null },
      ]),
    );
    expect(await workflows.get()).toHaveLength(1);
  });

  it("does not reconcile a crashed-before-create claim until its absence is confirmed", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    // A crash between the durable claim and create() left this claim behind.
    const other = await prepare("Fault crashed claim");
    const stranded = createId("wfr");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workflow_start_claims (
         id, org_id, task_id, artifact_id, artifact_version, actor_type, actor_id,
         idempotency_key, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'human', ?, 'fault_crash_key', 'claimed', ?, ?)`,
    )
      .bind(
        stranded,
        other.org.id,
        other.taskId,
        other.artifactId,
        other.org.createdByUserId,
        now,
        now,
      )
      .run();
    const otherToken = await ownerToken(other);

    await armEventFault(env.DB, FAULT_WORKFLOW_STATUS, 100);
    try {
      expectUnavailable(await start(other, otherToken, "fault_crash_other"), stranded);
      expect(await claims(other)).toEqual([
        { id: stranded, state: "claimed", release_reason: null },
      ]);
    } finally {
      await clearEventFaults(env.DB);
    }

    const reconciled = await start(other, otherToken, "fault_crash_key");
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.workflow_run_id).toBe(stranded);
    expect(await claims(other)).toEqual([{ id: stranded, state: "created", release_reason: null }]);
    expect(await workflows.get()).toHaveLength(1);
  });
});
