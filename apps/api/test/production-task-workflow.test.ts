import type { ArtifactFinalize } from "@ai-company/artifact";
import type { FoundationStore } from "@ai-company/db";
import { createId, type Organization, type Role } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_VERSION_EVENT,
  HUMAN_APPROVAL_EVENT,
  QA_EVIDENCE_EVENT,
  SECURITY_EVIDENCE_EVENT,
  notifyProductionTaskEvidence,
  type ProductionTaskParams,
} from "../src/production-task-workflow";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  taskStub,
} from "./helpers";

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) throw new Error(`Missing role ${code}`);
  return role;
}

async function count(orgId: string, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

interface Prepared {
  org: Organization;
  workerId: string;
  qaId: string;
  securityId: string;
  roomId: string;
  taskId: string;
  artifactId: string;
  qaToken: string;
  workerReviewToken: string;
  securityToken: string;
}

async function prepare(name: string): Promise<Prepared> {
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const qa = await hire(studio.store, studio.org.id, `${name} QA`);
  const security = await hire(studio.store, studio.org.id, `${name} security`);
  const owner = ownerOf(studio.org);
  const orgDo = organizationStub(studio.org.id);
  const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
  const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
  const securityRole = await roleByCode(studio.store, studio.org.id, "security");
  for (const [employee, role] of [
    [worker, employeeRole],
    [qa, qaRole],
    [security, securityRole],
  ] as const) {
    expect(
      (await orgDo.assignRole({ ...owner, employeeId: employee.id, roleId: role.id })).decision,
    ).toBe("ALLOW");
  }

  const room = await studio.store.createRoom(studio.org.id, {
    name: "Episode",
    departmentId: null,
  });
  for (const employee of [worker, qa, security]) {
    await studio.store.addRoomMember(studio.org.id, room.id, employee.id);
  }
  const created = await taskStub(studio.org.id).execute({
    ...owner,
    idempotencyKey: `task_${name.replaceAll(" ", "_")}`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Scene",
    objective: "Cut the scene.",
    roomId: room.id,
    dependsOn: [],
    completionPolicy: "QA_SECURITY",
  });
  expect(created.decision).toBe("ALLOW");
  const taskId = created.taskId ?? "";
  for (const [command, assigneeId, actor] of [
    ["assign", worker.id, owner],
    ["deliver", null, owner],
    ["ack", null, { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id }],
    ["start", null, { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id }],
  ] as const) {
    const result = await taskStub(studio.org.id).execute({
      ...actor,
      idempotencyKey: `${command}_${name.replaceAll(" ", "_")}`,
      command,
      taskId,
      assigneeId,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(result.decision).toBe("ALLOW");
  }
  const uploaded = await artifactStub(studio.org.id).put({
    orgId: studio.org.id,
    actorType: "employee",
    actorId: worker.id,
    idempotencyKey: `artifact_${name.replaceAll(" ", "_")}`,
    roomId: room.id,
    artifactId: null,
    taskId,
    mediaType: "text/plain",
    filename: null,
    checksum: null,
    bodyBase64: btoa("version one"),
  });
  expect(uploaded).toMatchObject({ decision: "ALLOW", version: 1 });
  const submitted = await taskStub(studio.org.id).execute({
    orgId: studio.org.id,
    actorType: "employee",
    actorId: worker.id,
    idempotencyKey: `submit_${name.replaceAll(" ", "_")}`,
    command: "submit",
    taskId,
    assigneeId: null,
    title: null,
    objective: null,
    roomId: null,
    dependsOn: [],
  });
  expect(submitted).toMatchObject({ decision: "ALLOW", state: "REVIEW" });

  const qaSession = await openBrowserSession(studio.org, qa.id, ["artifact.review"]);
  const workerSession = await openBrowserSession(studio.org, worker.id, ["artifact.review"]);
  const securitySession = await openBrowserSession(studio.org, security.id, ["security.approve"]);
  return {
    org: studio.org,
    workerId: worker.id,
    qaId: qa.id,
    securityId: security.id,
    roomId: room.id,
    taskId,
    artifactId: uploaded.artifactId ?? "",
    qaToken: qaSession.token,
    workerReviewToken: workerSession.token,
    securityToken: securitySession.token,
  };
}

async function paramsOf(prepared: Prepared): Promise<ProductionTaskParams> {
  const trace = await env.DB.prepare(`SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ?`)
    .bind(prepared.org.id, prepared.taskId)
    .first<{ correlation_id: string }>();
  if (!trace) throw new Error("Task correlation is missing");
  return {
    orgId: prepared.org.id,
    taskId: prepared.taskId,
    artifactId: prepared.artifactId,
    version: 1,
    roomId: prepared.roomId,
    correlationId: trace.correlation_id,
  };
}

async function runStatus(orgId: string, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, runId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function untilRun(orgId: string, runId: string, status: string): Promise<void> {
  await vi.waitFor(async () => expect(await runStatus(orgId, runId)).toBe(status), {
    timeout: 8_000,
    interval: 20,
  });
}

async function governanceCommand(
  prepared: Prepared,
  token: string,
  employeeId: string,
  kind: "reviews" | "security-approvals",
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    `https://company.local/orgs/${prepared.org.id}/artifacts/${prepared.artifactId}/${kind}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-employee-id": employeeId,
        "x-idempotency-key": key,
      },
      body: JSON.stringify(body),
    },
  );
}

async function sendWakeup(runId: string, type: string, payload: unknown = {}): Promise<void> {
  await (await env.PRODUCTION_TASK.get(runId)).sendEvent({ type, payload });
  for (let index = 0; index < 8; index += 1) await scheduler.wait(1);
}

describe("production task workflow external evidence", () => {
  it("ignores forged wakeups and advances only from authorized stored evidence", async () => {
    const prepared = await prepare("Evidence flow");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({ id: runId, params: await paramsOf(prepared) });
      await untilRun(prepared.org.id, runId, "running");

      await sendWakeup(runId, SECURITY_EVIDENCE_EVENT, { decision: "PASS" });
      await sendWakeup(runId, ARTIFACT_VERSION_EVENT, { version: 2 });
      await sendWakeup(runId, QA_EVIDENCE_EVENT, {
        artifactId: prepared.artifactId,
        version: 1,
        actorId: prepared.qaId,
        result: "PASS",
      });
      await sendWakeup(runId, QA_EVIDENCE_EVENT, {
        artifactId: prepared.artifactId,
        version: 1,
        actorId: prepared.qaId,
        result: "PASS",
      });
      expect(await runStatus(prepared.org.id, runId)).toBe("running");
      const waitingForQa = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string }>();
      expect(waitingForQa?.stage).toBe("qa_review");
      expect(
        await count(
          prepared.org.id,
          `SELECT COUNT(*) AS n FROM reviews WHERE org_id = ? AND artifact_id = '${prepared.artifactId}'`,
        ),
      ).toBe(0);

      const unauthorized = await governanceCommand(
        prepared,
        prepared.workerReviewToken,
        prepared.workerId,
        "reviews",
        "worker_try_review",
        { result: "PASS", version: 1 },
      );
      expect(unauthorized.status).toBe(403);
      await sendWakeup(runId, QA_EVIDENCE_EVENT, { result: "PASS" });
      expect(await runStatus(prepared.org.id, runId)).toBe("running");

      const qa = await governanceCommand(
        prepared,
        prepared.qaToken,
        prepared.qaId,
        "reviews",
        "qa_review_v1",
        { result: "PASS", version: 1 },
      );
      expect(qa.status).toBe(201);
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      await untilRun(prepared.org.id, runId, "running");
      await vi.waitFor(
        async () => {
          const row = await env.DB.prepare(
            `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
          )
            .bind(prepared.org.id, runId)
            .first<{ stage: string }>();
          expect(row?.stage).toBe("security");
        },
        { timeout: 8_000, interval: 20 },
      );

      const wrongSecurity = await governanceCommand(
        prepared,
        prepared.qaToken,
        prepared.qaId,
        "security-approvals",
        "qa_try_security",
        { version: 1 },
      );
      expect(wrongSecurity.status).toBe(403);
      await sendWakeup(runId, SECURITY_EVIDENCE_EVENT, { decision: "ALLOW" });
      const stillWaitingForSecurity = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string }>();
      expect(stillWaitingForSecurity?.stage).toBe("security");

      const security = await governanceCommand(
        prepared,
        prepared.securityToken,
        prepared.securityId,
        "security-approvals",
        "security_approve_v1",
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

      await sendWakeup(runId, HUMAN_APPROVAL_EVENT, {
        actorType: "human",
        actorId: prepared.org.createdByUserId,
        decision: "ALLOW",
      });
      expect(await runStatus(prepared.org.id, runId)).toBe("waiting_for_approval");

      const creator = await artifactStub(prepared.org.id).finalize({
        orgId: prepared.org.id,
        actorType: "employee",
        actorId: prepared.workerId,
        idempotencyKey: "creator_final_try",
        artifactId: prepared.artifactId,
        version: 1,
      } satisfies ArtifactFinalize);
      expect(creator).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });

      const human = await artifactStub(prepared.org.id).finalize({
        orgId: prepared.org.id,
        actorType: "human",
        actorId: prepared.org.createdByUserId,
        idempotencyKey: "human_final_approve",
        artifactId: prepared.artifactId,
        version: 1,
      } satisfies ArtifactFinalize);
      expect(human.decision).toBe("ALLOW");
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        HUMAN_APPROVAL_EVENT,
      );

      await watched.waitForStatus("complete");
      expect(await watched.getOutput()).toEqual({ outcome: "COMPLETE", iteration: 0 });
      expect(await runStatus(prepared.org.id, runId)).toBe("complete");
    } finally {
      await watched.dispose();
    }
  });

  it("uses only the exact artifact version when resolving QA evidence", async () => {
    const prepared = await prepare("Wrong version");
    const versionTwo = await artifactStub(prepared.org.id).put({
      orgId: prepared.org.id,
      actorType: "employee",
      actorId: prepared.workerId,
      idempotencyKey: "upload_second_version",
      roomId: prepared.roomId,
      artifactId: prepared.artifactId,
      taskId: prepared.taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("version two"),
    });
    expect(versionTwo).toMatchObject({ decision: "ALLOW", version: 2 });
    const qa = await governanceCommand(
      prepared,
      prepared.qaToken,
      prepared.qaId,
      "reviews",
      "qa_review_v2",
      { result: "PASS", version: 2 },
    );
    expect(qa.status).toBe(201);

    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({ id: runId, params: await paramsOf(prepared) });
      await untilRun(prepared.org.id, runId, "running");
      await notifyProductionTaskEvidence(
        env,
        prepared.org.id,
        prepared.artifactId,
        QA_EVIDENCE_EVENT,
      );
      const row = await env.DB.prepare(
        `SELECT stage, status FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(prepared.org.id, runId)
        .first<{ stage: string; status: string }>();
      expect(row).toEqual({ stage: "qa_review", status: "running" });
      expect((await (await env.PRODUCTION_TASK.get(runId)).status()).status).not.toBe("complete");
    } finally {
      await watched.dispose();
    }
  });

  it("rejects a workflow correlation ID that differs from its persisted task root", async () => {
    const prepared = await prepare("Wrong correlation");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const params = await paramsOf(prepared);
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: { ...params, correlationId: createId("corr") },
      });
      await watched.waitForStatus("errored");
      expect(await runStatus(prepared.org.id, runId)).toBeNull();
    } finally {
      await watched.dispose();
    }
  });
});
