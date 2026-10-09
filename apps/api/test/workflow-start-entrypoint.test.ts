import { createId } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  HUMAN_APPROVAL_EVENT,
  QA_EVIDENCE_EVENT,
  SECURITY_EVIDENCE_EVENT,
  notifyProductionTaskEvidence,
} from "../src/production-task-workflow";
import {
  artifactStub,
  claimWorkflowStart,
  createStudio,
  organizationStub,
  taskStub,
} from "./helpers";
import {
  governanceCommand,
  paramsOf,
  prepare,
  runStatus,
  sendWakeup,
  untilRun,
  type Prepared,
} from "./workflow-fixtures";

interface StartBody {
  workflow_run_id: string;
  status: string;
  duplicate: boolean;
}

interface ErrorBody {
  error: { code: string; workflow_run_id?: string };
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

async function startRun(
  orgId: string,
  taskId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return exports.default.fetch(
    `https://company.local/orgs/${orgId}/tasks/${taskId}/workflow-runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}

function as(token: string, key: string, employeeId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-idempotency-key": key,
    ...(employeeId ? { "x-employee-id": employeeId } : {}),
  };
}

async function activeClaims(orgId: string, taskId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM workflow_start_claims
     WHERE org_id = ? AND task_id = ? AND state <> 'released'`,
  )
    .bind(orgId, taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function stage(orgId: string, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, runId)
    .first<{ stage: string }>();
  return row?.stage ?? null;
}

describe("workflow start entrypoint", () => {
  it("starts an authorized run with a server-resolved actor and replays duplicates", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start authorized");
    const token = await ownerToken(prepared);
    const body = { artifact_id: prepared.artifactId, version: 1 };

    const forgedFields = await startRun(
      prepared.org.id,
      prepared.taskId,
      { ...body, actor_id: prepared.qaId, actor_type: "employee" },
      as(token, "start_forged_fields"),
    );
    expect(forgedFields.status).toBe(400);

    const started = await startRun(prepared.org.id, prepared.taskId, body, as(token, "start_one"));
    expect(started.status).toBe(201);
    const run = await started.json<StartBody>();
    expect(run.workflow_run_id).toMatch(/^wfr_[0-9a-f]{32}$/);
    expect(run.duplicate).toBe(false);
    await untilRun(prepared.org.id, run.workflow_run_id, "running");

    const claim = await env.DB.prepare(
      `SELECT actor_type, actor_id, state FROM workflow_start_claims WHERE id = ?`,
    )
      .bind(run.workflow_run_id)
      .first<{ actor_type: string; actor_id: string; state: string }>();
    expect(claim).toEqual({
      actor_type: "human",
      actor_id: prepared.org.createdByUserId,
      state: "created",
    });

    const replay = await startRun(prepared.org.id, prepared.taskId, body, as(token, "start_one"));
    expect(replay.status).toBe(200);
    expect(await replay.json<StartBody>()).toMatchObject({
      workflow_run_id: run.workflow_run_id,
      duplicate: true,
      status: "running",
    });
    const reused = await startRun(
      prepared.org.id,
      prepared.taskId,
      { ...body, version: 2 },
      as(token, "start_one"),
    );
    expect(reused.status).toBe(409);
    expect((await reused.json<ErrorBody>()).error.code).toBe("IDEMPOTENCY_MISMATCH");

    const second = await startRun(prepared.org.id, prepared.taskId, body, as(token, "start_two"));
    expect(second.status).toBe(409);
    expect(await second.json<ErrorBody>()).toMatchObject({
      error: { code: "WORKFLOW_ACTIVE", workflow_run_id: run.workflow_run_id },
    });
    expect(await activeClaims(prepared.org.id, prepared.taskId)).toBe(1);
    expect(await workflows.get()).toHaveLength(1);
  });

  it("denies unauthenticated, unauthorized, and cross-organization starts", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start denied");
    const body = { artifact_id: prepared.artifactId, version: 1 };

    const anonymous = await startRun(prepared.org.id, prepared.taskId, body, {
      "x-idempotency-key": "start_anonymous",
      "x-actor-type": "human",
      "x-actor-id": prepared.org.createdByUserId,
    });
    expect(anonymous.status).toBe(401);

    // QA holds artifact.review but not task orchestration authority.
    const qa = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(prepared.qaToken, "start_by_qa", prepared.qaId),
    );
    expect(qa.status).toBe(403);
    const worker = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(prepared.workerReviewToken, "start_by_worker", prepared.workerId),
    );
    expect(worker.status).toBe(403);

    const foreign = await createStudio("Start foreign org");
    const foreignToken = await organizationStub(foreign.org.id).issueHumanSession({
      orgId: foreign.org.id,
      actorType: "human",
      actorId: foreign.org.createdByUserId,
      ttlSeconds: 600,
    });
    const foreignSession = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(foreignToken.token ?? "", "start_foreign_session"),
    );
    expect(foreignSession.status).toBe(401);
    const foreignTask = await startRun(
      foreign.org.id,
      prepared.taskId,
      body,
      as(foreignToken.token ?? "", "start_foreign_task"),
    );
    expect(foreignTask.status).toBe(404);

    expect(await activeClaims(prepared.org.id, prepared.taskId)).toBe(0);
    expect(await workflows.get()).toHaveLength(0);
  });

  it("denies wrong artifact relationships, stale versions, and ineligible tasks", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start relationship");
    const other = await prepare("Start relationship other");
    const token = await ownerToken(prepared);

    const unrelated = await startRun(
      prepared.org.id,
      prepared.taskId,
      { artifact_id: other.artifactId, version: 1 },
      as(token, "start_foreign_artifact"),
    );
    expect(unrelated.status).toBe(404);

    const sibling = await taskStub(prepared.org.id).execute({
      orgId: prepared.org.id,
      actorType: "human",
      actorId: prepared.org.createdByUserId,
      idempotencyKey: "start_sibling_task",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Sibling",
      objective: "Another task in the room.",
      roomId: prepared.roomId,
      dependsOn: [],
      completionPolicy: "QA_SECURITY",
    });
    expect(sibling.decision).toBe("ALLOW");
    const mismatched = await startRun(
      prepared.org.id,
      sibling.taskId ?? "",
      { artifact_id: prepared.artifactId, version: 1 },
      as(token, "start_wrong_task"),
    );
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json<ErrorBody>()).error.code).toBe("ARTIFACT_TASK_MISMATCH");

    const future = await startRun(
      prepared.org.id,
      prepared.taskId,
      { artifact_id: prepared.artifactId, version: 2 },
      as(token, "start_future_version"),
    );
    expect(future.status).toBe(409);
    expect((await future.json<ErrorBody>()).error.code).toBe("ARTIFACT_VERSION_STALE");
    const versionTwo = await artifactStub(prepared.org.id).put({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.workerId,
      idempotencyKey: "start_second_version",
      roomId: prepared.roomId,
      artifactId: prepared.artifactId,
      taskId: prepared.taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("version two"),
    });
    expect(versionTwo).toMatchObject({ decision: "ALLOW", version: 2 });
    const stale = await startRun(
      prepared.org.id,
      prepared.taskId,
      { artifact_id: prepared.artifactId, version: 1 },
      as(token, "start_stale_version"),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json<ErrorBody>()).error.code).toBe("ARTIFACT_VERSION_STALE");

    const notReview = await startRun(
      prepared.org.id,
      sibling.taskId ?? "",
      { artifact_id: other.artifactId, version: 1 },
      as(token, "start_not_review"),
    );
    expect(notReview.status).toBe(404);
    expect(await activeClaims(prepared.org.id, prepared.taskId)).toBe(0);
    expect(await workflows.get()).toHaveLength(0);
  });

  it("admits exactly one of two concurrent starts", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start concurrent");
    const token = await ownerToken(prepared);
    const body = { artifact_id: prepared.artifactId, version: 1 };
    const responses = await Promise.all([
      startRun(prepared.org.id, prepared.taskId, body, as(token, "start_race_a")),
      startRun(prepared.org.id, prepared.taskId, body, as(token, "start_race_b")),
      startRun(prepared.org.id, prepared.taskId, body, as(token, "start_race_a")),
    ]);
    const bodies = await Promise.all(
      responses.map(async (r) => ({
        status: r.status,
        body: await r.json<StartBody & ErrorBody>(),
      })),
    );
    const created = bodies.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    const winner = created[0]?.body.workflow_run_id;
    for (const result of bodies) {
      expect(result.body.workflow_run_id ?? result.body.error?.workflow_run_id).toBe(winner);
    }
    expect(await activeClaims(prepared.org.id, prepared.taskId)).toBe(1);
    await untilRun(prepared.org.id, winner ?? "", "running");
    expect(await workflows.get()).toHaveLength(1);
  });

  it("recovers a claim stranded before instance creation and releases terminal runs", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start recovery");
    const token = await ownerToken(prepared);
    const body = { artifact_id: prepared.artifactId, version: 1 };

    // Simulate a crash after the durable claim and before PRODUCTION_TASK.create().
    const stranded = createId("wfr");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workflow_start_claims (
         id, org_id, task_id, artifact_id, artifact_version, actor_type, actor_id,
         idempotency_key, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'human', ?, 'start_crashed', 'claimed', ?, ?)`,
    )
      .bind(
        stranded,
        prepared.org.id,
        prepared.taskId,
        prepared.artifactId,
        prepared.org.createdByUserId,
        now,
        now,
      )
      .run();
    const blocked = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(token, "start_other"),
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json<ErrorBody>()).error.workflow_run_id).toBe(stranded);
    const retried = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(token, "start_crashed"),
    );
    expect(retried.status).toBe(200);
    expect((await retried.json<StartBody>()).workflow_run_id).toBe(stranded);
    await untilRun(prepared.org.id, stranded, "running");
    expect(await workflows.get()).toHaveLength(1);

    const failed = await governanceCommand(
      prepared,
      prepared.qaToken,
      prepared.qaId,
      "reviews",
      "start_recovery_qa_fail",
      { result: "FAIL", version: 1 },
    );
    expect(failed.status).toBe(201);
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      QA_EVIDENCE_EVENT,
    );
    await untilRun(prepared.org.id, stranded, "denied");

    const restarted = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(token, "start_after"),
    );
    expect(restarted.status).toBe(201);
    const next = (await restarted.json<StartBody>()).workflow_run_id;
    expect(next).not.toBe(stranded);
    const states = await env.DB.prepare(
      `SELECT id, state FROM workflow_start_claims WHERE org_id = ? AND task_id = ? ORDER BY created_at`,
    )
      .bind(prepared.org.id, prepared.taskId)
      .all<{ id: string; state: string }>();
    expect(states.results).toEqual([
      { id: stranded, state: "released" },
      { id: next, state: "created" },
    ]);
  });

  it("releases claims whose instance died before or after registering", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start dead instance");
    const token = await ownerToken(prepared);
    const body = { artifact_id: prepared.artifactId, version: 1 };
    const instanceState = async (id: string) =>
      (await (await env.PRODUCTION_TASK.get(id)).status()).status;

    // Claim never advanced past 'claimed' and its instance errored before registerRun.
    const params = await paramsOf(prepared);
    const unregistered = createId("wfr");
    await claimWorkflowStart(unregistered, params);
    await env.PRODUCTION_TASK.create({
      id: unregistered,
      params: { ...params, correlationId: createId("corr") },
    });
    await vi.waitFor(async () => expect(await instanceState(unregistered)).toBe("errored"), {
      timeout: 8_000,
      interval: 20,
    });
    const afterUnregistered = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(token, "start_after_unregistered"),
    );
    expect(afterUnregistered.status).toBe(201);
    const registered = (await afterUnregistered.json<StartBody>()).workflow_run_id;
    await untilRun(prepared.org.id, registered, "running");

    // A registered run whose instance is terminated must not block the task forever.
    await (await env.PRODUCTION_TASK.get(registered)).terminate();
    await vi.waitFor(async () => expect(await instanceState(registered)).toBe("terminated"), {
      timeout: 8_000,
      interval: 20,
    });
    const afterTerminated = await startRun(
      prepared.org.id,
      prepared.taskId,
      body,
      as(token, "start_after_terminated"),
    );
    expect(afterTerminated.status).toBe(201);
    expect(await runStatus(prepared.org.id, registered)).toBe("paused");
    const states = await env.DB.prepare(
      `SELECT id, state FROM workflow_start_claims WHERE org_id = ? AND id IN (?, ?)`,
    )
      .bind(prepared.org.id, unregistered, registered)
      .all<{ id: string; state: string }>();
    expect(states.results.every((row) => row.state === "released")).toBe(true);
    expect(await activeClaims(prepared.org.id, prepared.taskId)).toBe(1);
    expect(await workflows.get()).toHaveLength(3);
  });

  it("advances an entrypoint-started run only on authorized evidence and human approval", async () => {
    await using workflows = await introspectWorkflow(env.PRODUCTION_TASK);
    const prepared = await prepare("Start governed");
    const token = await ownerToken(prepared);
    const started = await startRun(
      prepared.org.id,
      prepared.taskId,
      { artifact_id: prepared.artifactId, version: 1 },
      as(token, "start_governed"),
    );
    expect(started.status).toBe(201);
    const runId = (await started.json<StartBody>()).workflow_run_id;
    await untilRun(prepared.org.id, runId, "running");

    await sendWakeup(runId, QA_EVIDENCE_EVENT, { result: "PASS", actorId: prepared.qaId });
    await sendWakeup(runId, SECURITY_EVIDENCE_EVENT, { decision: "PASS" });
    expect(await stage(prepared.org.id, runId)).toBe("qa_review");

    const forged = await governanceCommand(
      prepared,
      prepared.workerReviewToken,
      prepared.workerId,
      "reviews",
      "start_worker_review",
      { result: "PASS", version: 1 },
    );
    expect(forged.status).toBe(403);
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      QA_EVIDENCE_EVENT,
    );
    expect(await stage(prepared.org.id, runId)).toBe("qa_review");

    const qa = await governanceCommand(
      prepared,
      prepared.qaToken,
      prepared.qaId,
      "reviews",
      "start_qa_pass",
      { result: "PASS", version: 1 },
    );
    expect(qa.status).toBe(201);
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      QA_EVIDENCE_EVENT,
    );
    await vi.waitFor(async () => expect(await stage(prepared.org.id, runId)).toBe("security"), {
      timeout: 8_000,
      interval: 20,
    });
    const security = await governanceCommand(
      prepared,
      prepared.securityToken,
      prepared.securityId,
      "security-approvals",
      "start_security_pass",
      { version: 1 },
    );
    expect(security.status).toBe(201);
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      SECURITY_EVIDENCE_EVENT,
    );
    await untilRun(prepared.org.id, runId, "waiting_for_approval");

    await sendWakeup(runId, HUMAN_APPROVAL_EVENT, { decision: "PASS" });
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      HUMAN_APPROVAL_EVENT,
    );
    expect(await runStatus(prepared.org.id, runId)).toBe("waiting_for_approval");

    const approval = await exports.default.fetch(
      `https://company.local/orgs/${prepared.org.id}/artifacts/${prepared.artifactId}/approvals`,
      {
        method: "POST",
        headers: {
          ...as(token, "start_human_final"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: 1 }),
      },
    );
    expect(approval.status).toBe(201);
    await notifyProductionTaskEvidence(
      env,
      prepared.org.id,
      prepared.artifactId,
      HUMAN_APPROVAL_EVENT,
    );
    await untilRun(prepared.org.id, runId, "complete");
    expect(await workflows.get()).toHaveLength(1);
  });
});
