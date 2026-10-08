import type { FoundationStore } from "@ai-company/db";
import { createId, type Organization, type Role } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { HUMAN_APPROVAL_EVENT, type ProductionTaskParams } from "../src/production-task-workflow";
import { artifactStub, createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
}

async function count(orgId: string, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectAbort(sql: string, ...bindings: string[]): Promise<void> {
  let failed = false;
  try {
    await env.DB.prepare(sql)
      .bind(...bindings)
      .run();
  } catch (error) {
    failed = true;
    expect(error instanceof Error ? error.message : String(error)).toContain("WORKFLOW_IMMUTABLE");
  }
  expect(failed).toBe(true);
}

interface Prepared {
  org: Organization;
  workerId: string;
  qaId: string;
  securityId: string | null;
  roomId: string;
  taskId: string;
  artifactId: string;
}

async function prepare(
  name: string,
  workerKind: "employee" | "creator-approver",
  includeSecurity: boolean,
): Promise<Prepared> {
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const qa = await hire(studio.store, studio.org.id, `${name} qa`);
  const security = includeSecurity
    ? await hire(studio.store, studio.org.id, `${name} security`)
    : null;
  let workerRoleId: string;
  if (workerKind === "creator-approver") {
    const role = await studio.store.createRole(studio.org.id, {
      code: "workflow_approver",
      name: "Workflow approver",
    });
    for (const permission of [
      "artifact.read",
      "artifact.create",
      "artifact.modify",
      "artifact.approve",
      "workflow.approve",
    ]) {
      await studio.store.assignPermission(studio.org.id, role.id, permission);
    }
    workerRoleId = role.id;
  } else {
    workerRoleId = (await roleByCode(studio.store, studio.org.id, "employee")).id;
  }
  const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
  const securityRole = security ? await roleByCode(studio.store, studio.org.id, "security") : null;
  const orgDo = organizationStub(studio.org.id);
  const owner = ownerOf(studio.org);
  const assigned = await orgDo.assignRole({
    ...owner,
    employeeId: worker.id,
    roleId: workerRoleId,
  });
  expect(assigned.decision).toBe("ALLOW");
  expect(
    (await orgDo.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole.id })).decision,
  ).toBe("ALLOW");
  if (security && securityRole) {
    expect(
      (await orgDo.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id }))
        .decision,
    ).toBe("ALLOW");
  }
  const room = await studio.store.createRoom(studio.org.id, {
    name: "Episode",
    departmentId: null,
  });
  await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
  await studio.store.addRoomMember(studio.org.id, room.id, qa.id);
  const task = await taskStub(studio.org.id).execute({
    orgId: studio.org.id,
    actorType: "human",
    actorId: studio.org.createdByUserId,
    idempotencyKey: `task_${name.replaceAll(" ", "_")}`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Scene",
    objective: "Cut the scene.",
    roomId: room.id,
    dependsOn: [],
  });
  expect(task.decision).toBe("ALLOW");
  const created = await artifactStub(studio.org.id).put({
    orgId: studio.org.id,
    actorType: "employee",
    actorId: worker.id,
    idempotencyKey: `art_${name.replaceAll(" ", "_")}`,
    roomId: room.id,
    artifactId: null,
    taskId: task.taskId,
    mediaType: "text/plain",
    filename: null,
    checksum: null,
    bodyBase64: btoa("scene bytes"),
  });
  expect(created.decision).toBe("ALLOW");
  return {
    org: studio.org,
    workerId: worker.id,
    qaId: qa.id,
    securityId: security?.id ?? null,
    roomId: room.id,
    taskId: task.taskId ?? "",
    artifactId: created.artifactId ?? "",
  };
}

function paramsOf(
  prepared: Prepared,
  qaResults: Array<"PASS" | "FAIL" | "REVISION_REQUIRED">,
): ProductionTaskParams {
  return {
    orgId: prepared.org.id,
    taskId: prepared.taskId,
    artifactId: prepared.artifactId,
    version: 1,
    roomId: prepared.roomId,
    workerEmployeeId: prepared.workerId,
    qaEmployeeId: prepared.qaId,
    securityEmployeeId: prepared.securityId,
    qaResults,
    correlationId: createId("corr"),
  };
}

async function runStatus(orgId: string, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, runId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function untilRun(orgId: string, runId: string, status: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect(await runStatus(orgId, runId)).toBe(status);
    },
    { timeout: 8_000, interval: 20 },
  );
}

describe("production task workflow", () => {
  it("waits for human approval after revision and optional security", async () => {
    const prepared = await prepare("Workflow pass", "employee", true);
    const other = await createStudio("Workflow other");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: paramsOf(prepared, ["FAIL", "PASS"]),
      });
      await untilRun(prepared.org.id, runId, "waiting_for_approval");
      const handle = await env.PRODUCTION_TASK.get(runId);
      const waiting = await handle.status();
      expect(waiting.status === "running" || waiting.status === "waiting").toBe(true);
      expect(waiting.output).toBeNull();
      expect(await runStatus(other.org.id, runId)).toBeNull();
      const revision = await watched.waitForStepResult({ name: "revision-1" });
      expect(revision).toMatchObject({ status: "revision", iteration: 1 });
      const reviews = await env.DB.prepare(
        `SELECT result FROM reviews WHERE org_id = ? AND artifact_id = ? ORDER BY rowid`,
      )
        .bind(prepared.org.id, prepared.artifactId)
        .all<{ result: string }>();
      expect(reviews.results.map((row) => row.result)).toEqual(["FAIL", "PASS"]);
      await handle.sendEvent({
        type: HUMAN_APPROVAL_EVENT,
        payload: {
          actorType: "human",
          actorId: prepared.org.createdByUserId,
          decision: "ALLOW",
        },
      });
      await watched.waitForStatus("complete");
      expect(await watched.getOutput()).toEqual({ outcome: "COMPLETE", iteration: 1 });
      expect((await handle.status()).status).toBe("complete");
      expect(await runStatus(prepared.org.id, runId)).toBe("complete");
      const approvals = await env.DB.prepare(
        `SELECT kind, decision, reason FROM approvals
         WHERE org_id = ? AND artifact_id = ? ORDER BY rowid`,
      )
        .bind(prepared.org.id, prepared.artifactId)
        .all<{ kind: string; decision: string; reason: string }>();
      expect(approvals.results).toEqual([
        { kind: "security", decision: "PASS", reason: "ALLOWED" },
        { kind: "final", decision: "PASS", reason: "ALLOWED" },
      ]);
      const task = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(prepared.org.id, prepared.taskId)
        .first<{ state: string }>();
      expect(task?.state).toBe("CREATED");
      const versions = await count(
        prepared.org.id,
        `SELECT COUNT(*) AS n FROM artifact_versions WHERE org_id = ? AND artifact_id = '${prepared.artifactId}'`,
      );
      expect(versions).toBe(1);
      await pump();
      expect(
        await count(prepared.org.id, `SELECT COUNT(*) AS n FROM dead_letters WHERE org_id = ?`),
      ).toBe(0);
      await expectAbort(
        `DELETE FROM workflow_runs WHERE org_id = ? AND id = ?`,
        prepared.org.id,
        runId,
      );
      await expectAbort(
        `UPDATE workflow_runs SET iteration = 0 WHERE org_id = ? AND id = ?`,
        prepared.org.id,
        runId,
      );
    } finally {
      await watched.dispose();
    }
  });

  it("does not complete when the human event lacks workflow.approve", async () => {
    const prepared = await prepare("Workflow deny", "employee", false);
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: paramsOf(prepared, ["PASS"]),
      });
      await untilRun(prepared.org.id, runId, "waiting_for_approval");
      const handle = await env.PRODUCTION_TASK.get(runId);
      expect((await handle.status()).status).not.toBe("complete");
      await handle.sendEvent({
        type: HUMAN_APPROVAL_EVENT,
        payload: {
          actorType: "employee",
          actorId: prepared.workerId,
          decision: "ALLOW",
        },
      });
      await watched.waitForStatus("errored");
      expect((await handle.status()).status).toBe("errored");
      expect(await runStatus(prepared.org.id, runId)).toBe("denied");
      expect(
        await count(
          prepared.org.id,
          `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND artifact_id = '${prepared.artifactId}'`,
        ),
      ).toBe(0);
      const securityApprovals = await count(
        prepared.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'security'`,
      );
      expect(securityApprovals).toBe(0);
    } finally {
      await watched.dispose();
    }
  });

  it("does not complete when the creator final-approves", async () => {
    const prepared = await prepare("Workflow self", "creator-approver", false);
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: paramsOf(prepared, ["PASS"]),
      });
      await untilRun(prepared.org.id, runId, "waiting_for_approval");
      const handle = await env.PRODUCTION_TASK.get(runId);
      expect((await handle.status()).status).not.toBe("complete");
      await handle.sendEvent({
        type: HUMAN_APPROVAL_EVENT,
        payload: {
          actorType: "employee",
          actorId: prepared.workerId,
          decision: "ALLOW",
        },
      });
      await watched.waitForStatus("errored");
      expect((await handle.status()).status).toBe("errored");
      expect(await runStatus(prepared.org.id, runId)).toBe("denied");
      const approval = await env.DB.prepare(
        `SELECT decision, reason FROM approvals WHERE org_id = ? AND artifact_id = ?`,
      )
        .bind(prepared.org.id, prepared.artifactId)
        .first<{ decision: string; reason: string }>();
      expect(approval).toEqual({ decision: "DENY", reason: "NO_SELF_APPROVAL" });
    } finally {
      await watched.dispose();
    }
  });

  it("pauses when QA does not pass inside the iteration cap", async () => {
    const prepared = await prepare("Workflow loop", "employee", false);
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      await env.PRODUCTION_TASK.create({
        id: runId,
        params: paramsOf(prepared, ["REVISION_REQUIRED"]),
      });
      await watched.waitForStatus("errored");
      expect((await (await env.PRODUCTION_TASK.get(runId)).status()).status).toBe("errored");
      expect(await runStatus(prepared.org.id, runId)).toBe("paused");
      const review = await env.DB.prepare(
        `SELECT result FROM reviews WHERE org_id = ? AND artifact_id = ?`,
      )
        .bind(prepared.org.id, prepared.artifactId)
        .first<{ result: string }>();
      expect(review?.result).toBe("REVISION_REQUIRED");
      const versions = await count(
        prepared.org.id,
        `SELECT COUNT(*) AS n FROM artifact_versions WHERE org_id = ? AND artifact_id = '${prepared.artifactId}'`,
      );
      expect(versions).toBe(1);
      const task = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(prepared.org.id, prepared.taskId)
        .first<{ state: string }>();
      expect(task?.state).toBe("CREATED");
    } finally {
      await watched.dispose();
    }
  });
});
