import { createId, type Organization } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_EVENT, type ProductionTaskParams } from "../src/production-task-workflow";
import { artifactStub, createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function waitForStage(orgId: string, runId: string, stage: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(orgId, runId)
        .first<{ stage: string }>();
      expect(row?.stage).toBe(stage);
    },
    { timeout: 8_000, interval: 20 },
  );
}

describe("workflow external evidence", () => {
  it("does not treat legacy scripted QA or a forged wakeup as authority", async () => {
    const studio = await createStudio("Workflow wakeup");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const qa = await hire(studio.store, studio.org.id, "QA");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    const workerRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    const qaRole = await studio.store.getRoleByCode(studio.org.id, "qa");
    if (!workerRole || !qaRole) throw new Error("Workflow test roles missing");
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: workerRole.id });
    await org.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Review",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    await studio.store.addRoomMember(studio.org.id, room.id, qa.id);
    const task = await taskStub(studio.org.id).execute({
      ...owner,
      idempotencyKey: "workflow_task_create",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Create scene",
      objective: "Submit a scene for QA.",
      roomId: room.id,
      dependsOn: [],
      completionPolicy: "QA_SECURITY",
    });
    expect(task.decision).toBe("ALLOW");
    const taskId = task.taskId ?? "";
    for (const [command, actor, assigneeId] of [
      ["assign", owner, worker.id],
      ["deliver", owner, null],
      ["ack", { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id }, null],
      ["start", { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id }, null],
    ] as const) {
      const result = await taskStub(studio.org.id).execute({
        ...actor,
        idempotencyKey: `workflow_${command}_1`,
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
    const artifact = await artifactStub(studio.org.id).put({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "workflow_artifact_v1",
      roomId: room.id,
      artifactId: null,
      taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("submitted scene"),
    });
    expect(artifact.decision).toBe("ALLOW");
    await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "workflow_task_submit",
      command: "submit",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });

    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const trace = await env.DB.prepare(
        `SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ?`,
      )
        .bind(studio.org.id, taskId)
        .first<{ correlation_id: string }>();
      if (!trace) throw new Error("Task correlation is missing");
      const params: ProductionTaskParams & {
        qaResults: string[];
        qaEmployeeId: string;
        securityEmployeeId: string;
      } = {
        orgId: studio.org.id,
        taskId,
        artifactId: artifact.artifactId ?? "",
        version: 1,
        roomId: room.id,
        correlationId: trace.correlation_id,
        qaResults: ["PASS"],
        qaEmployeeId: qa.id,
        securityEmployeeId: worker.id,
      };
      await env.PRODUCTION_TASK.create({ id: runId, params });
      await waitForStage(studio.org.id, runId, "qa_review");
      await (
        await env.PRODUCTION_TASK.get(runId)
      ).sendEvent({
        type: QA_EVIDENCE_EVENT,
        payload: {
          orgId: studio.org.id,
          artifactId: artifact.artifactId,
          version: 1,
          actorId: qa.id,
          result: "PASS",
        },
      });
      for (let index = 0; index < 8; index += 1) await scheduler.wait(1);
      const run = await env.DB.prepare(
        `SELECT stage, status FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(studio.org.id, runId)
        .first<{ stage: string; status: string }>();
      expect(run).toEqual({ stage: "qa_review", status: "running" });
      const reviews = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM reviews WHERE org_id = ? AND artifact_id = ?`,
      )
        .bind(studio.org.id, artifact.artifactId)
        .first<{ n: number }>();
      expect(reviews?.n).toBe(0);
      expect((await (await env.PRODUCTION_TASK.get(runId)).status()).status).not.toBe("complete");
    } finally {
      await watched.dispose();
    }
  });
});
