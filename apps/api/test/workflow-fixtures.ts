import type { FoundationStore } from "@ai-company/db";
import { type Organization, type Role } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";
import type { ProductionTaskParams } from "../src/production-task-workflow";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  taskStub,
} from "./helpers";

// Shared governed-task fixture for workflow tests: QA_SECURITY task in REVIEW with v1.
export function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

export async function roleByCode(
  store: FoundationStore,
  orgId: string,
  code: string,
): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) throw new Error(`Missing role ${code}`);
  return role;
}

export async function count(orgId: string, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface Prepared {
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
  managerId: string;
  executiveId: string;
}

export async function prepare(name: string): Promise<Prepared> {
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const qa = await hire(studio.store, studio.org.id, `${name} QA`);
  const security = await hire(studio.store, studio.org.id, `${name} security`);
  // Hired before OrganizationDO hydrates so the authority snapshot includes them.
  const manager = await hire(studio.store, studio.org.id, `${name} manager`);
  const executive = await hire(studio.store, studio.org.id, `${name} executive`);
  const owner = ownerOf(studio.org);
  const orgDo = organizationStub(studio.org.id);
  const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
  const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
  const securityRole = await roleByCode(studio.store, studio.org.id, "security");
  const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
  const executiveRole = await roleByCode(studio.store, studio.org.id, "executive");
  for (const [employee, role] of [
    [worker, employeeRole],
    [qa, qaRole],
    [security, securityRole],
    [manager, managerRole],
    [executive, executiveRole],
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
    managerId: manager.id,
    executiveId: executive.id,
  };
}

export async function paramsOf(prepared: Prepared): Promise<ProductionTaskParams> {
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

export async function runStatus(orgId: string, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, runId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

export async function untilRun(orgId: string, runId: string, status: string): Promise<void> {
  await vi.waitFor(async () => expect(await runStatus(orgId, runId)).toBe(status), {
    timeout: 8_000,
    interval: 20,
  });
}

export async function governanceCommand(
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

export async function sendWakeup(
  runId: string,
  type: string,
  payload: unknown = {},
): Promise<void> {
  await (await env.PRODUCTION_TASK.get(runId)).sendEvent({ type, payload });
  for (let index = 0; index < 8; index += 1) await scheduler.wait(1);
}
