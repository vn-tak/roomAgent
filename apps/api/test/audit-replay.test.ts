import { createId, type Organization, type Role, type TaskCommandName } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ProductionTaskParams } from "../src/production-task-workflow";
import { artifactStub, createStudio, hire, organizationStub, taskStub } from "./helpers";

interface EventPayload {
  [key: string]: unknown;
}

interface ReplayEvent {
  event_id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  seq: number;
  occurred_at: string;
  correlation_id: string;
  body: string;
}

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function roleByCode(
  store: Awaited<ReturnType<typeof createStudio>>["store"],
  orgId: string,
  code: string,
): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) throw new Error(`Missing role ${code}`);
  return role;
}

async function waitForEvents(orgId: string, correlationId: string, count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND correlation_id = ?`,
      )
        .bind(orgId, correlationId)
        .first<{ n: number }>();
      expect(row?.n).toBeGreaterThanOrEqual(count);
    },
    { timeout: 8_000, interval: 20 },
  );
}

function replay(records: ReplayEvent[]) {
  const state = {
    taskState: "",
    assigneeId: null as string | null,
    versions: [] as number[],
    reviews: [] as Array<{ version: number; result: string }>,
    securityApproved: false,
    humanApproved: false,
    governanceSatisfied: false,
  };
  const milestones: string[] = [];
  for (const record of records) {
    const event = JSON.parse(record.body) as { payload?: EventPayload };
    const payload = event.payload ?? {};
    if (record.subject_type === "task") {
      if (record.type === "task.created") milestones.push("created");
      if (record.type === "task.assigned") {
        milestones.push("assigned");
        state.assigneeId = typeof payload.assignee_id === "string" ? payload.assignee_id : null;
      }
      if (record.type === "task.delivered") milestones.push("delivered");
      if (record.type === "task.acknowledged") milestones.push("acknowledged");
      if (record.type === "task.started") milestones.push("working");
      if (record.type === "task.submitted") milestones.push("submitted");
      if (record.type === "task.revision_requested") milestones.push("revision");
      if (record.type === "task.approved") milestones.push("task-approved");
      if (record.type === "task.completed") milestones.push("complete");
      if (typeof payload.to_state === "string") state.taskState = payload.to_state;
    }
    if (record.type === "artifact.version.created") {
      const version = payload.version;
      if (typeof version === "number") {
        state.versions.push(version);
        milestones.push(`artifact-v${version}`);
      }
    }
    if (record.type === "review.recorded" && payload.kind === "review") {
      const version = payload.artifact_version;
      const result = payload.result;
      if (typeof version === "number" && typeof result === "string") {
        state.reviews.push({ version, result });
        if (result === "REVISION_REQUIRED") milestones.push("qa-revision");
        if (result === "PASS") milestones.push("qa-pass");
      }
    }
    if (record.type === "approval.granted" && payload.decision === "ALLOW") {
      if (payload.kind === "security") {
        state.securityApproved = true;
        milestones.push("security-approve");
      }
      if (payload.kind === "final") {
        state.humanApproved = true;
        milestones.push("human-approve");
        state.governanceSatisfied =
          state.securityApproved &&
          state.reviews.some(
            (review) => review.version === state.versions.at(-1) && review.result === "PASS",
          );
      }
    }
  }
  return { ...state, milestones };
}

describe("certified POC audit replay", () => {
  it("replays the revision-to-completion path from domain and audit evidence", async () => {
    const studio = await createStudio("Audit replay POC-001");
    const creator = await hire(studio.store, studio.org.id, "Coordinator");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const qa = await hire(studio.store, studio.org.id, "QA");
    const security = await hire(studio.store, studio.org.id, "Security");
    const owner = ownerOf(studio.org);
    const organization = organizationStub(studio.org.id);
    const creatorRole = await roleByCode(studio.store, studio.org.id, "executive");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const workerRole = await roleByCode(studio.store, studio.org.id, "employee");
    const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    for (const [employee, role] of [
      [creator, creatorRole],
      [manager, managerRole],
      [worker, workerRole],
      [qa, qaRole],
      [security, securityRole],
    ] as const) {
      expect(
        (await organization.assignRole({ ...owner, employeeId: employee.id, roleId: role.id }))
          .decision,
      ).toBe("ALLOW");
    }
    const room = await studio.store.createRoom(studio.org.id, {
      name: "PROJECT POC-001",
      departmentId: null,
    });
    for (const employee of [worker, qa, security]) {
      await studio.store.addRoomMember(studio.org.id, room.id, employee.id);
    }

    const command = async (
      actor: { actorType: "human" | "employee"; actorId: string },
      name: TaskCommandName,
      idempotencyKey: string,
      taskId: string | null,
      assigneeId: string | null = null,
      completionPolicy?: "QA_SECURITY",
    ) =>
      taskStub(studio.org.id).execute({
        orgId: studio.org.id,
        ...actor,
        idempotencyKey,
        command: name,
        taskId,
        assigneeId,
        title: name === "create" ? "PROJECT POC-001 scene" : null,
        objective: name === "create" ? "Produce the scene and revise it after QA." : null,
        roomId: name === "create" ? room.id : null,
        dependsOn: [],
        ...(completionPolicy ? { completionPolicy } : {}),
      });
    const created = await command(
      { actorType: "employee", actorId: creator.id },
      "create",
      "replay_task_create",
      null,
      null,
      "QA_SECURITY",
    );
    expect(created.decision).toBe("ALLOW");
    const taskId = created.taskId ?? "";
    for (const [actor, action, key, assignee] of [
      [
        { actorType: "employee" as const, actorId: creator.id },
        "assign",
        "replay_assign",
        worker.id,
      ],
      [{ actorType: "employee" as const, actorId: creator.id }, "deliver", "replay_deliver", null],
      [{ actorType: "employee" as const, actorId: worker.id }, "ack", "replay_ack", null],
      [{ actorType: "employee" as const, actorId: worker.id }, "start", "replay_start", null],
    ] as const) {
      expect((await command(actor, action, key, taskId, assignee)).decision).toBe("ALLOW");
    }
    const artifactOne = await artifactStub(studio.org.id).put({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "replay_artifact_v1",
      roomId: room.id,
      artifactId: null,
      taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("POC-001 first version"),
    });
    expect(artifactOne).toMatchObject({ decision: "ALLOW", version: 1 });
    const artifactId = artifactOne.artifactId ?? "";
    expect(
      (
        await command(
          { actorType: "employee", actorId: worker.id },
          "submit",
          "replay_submit_v1",
          taskId,
        )
      ).state,
    ).toBe("REVIEW");
    expect(
      (
        await artifactStub(studio.org.id).review({
          orgId: studio.org.id,
          actorType: "employee",
          actorId: qa.id,
          idempotencyKey: "replay_qa_revision",
          artifactId,
          version: 1,
          result: "REVISION_REQUIRED",
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await command(
          { actorType: "employee", actorId: qa.id },
          "request_revision",
          "replay_revision",
          taskId,
        )
      ).state,
    ).toBe("REVISION");
    expect(
      (
        await command(
          { actorType: "employee", actorId: worker.id },
          "start",
          "replay_start_v2",
          taskId,
        )
      ).state,
    ).toBe("WORKING");
    const artifactTwo = await artifactStub(studio.org.id).put({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "replay_artifact_v2",
      roomId: room.id,
      artifactId,
      taskId,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("POC-001 revised version"),
    });
    expect(artifactTwo).toMatchObject({ decision: "ALLOW", version: 2 });
    expect(
      (
        await command(
          { actorType: "employee", actorId: worker.id },
          "submit",
          "replay_submit_v2",
          taskId,
        )
      ).state,
    ).toBe("REVIEW");
    expect(
      (
        await artifactStub(studio.org.id).review({
          orgId: studio.org.id,
          actorType: "employee",
          actorId: qa.id,
          idempotencyKey: "replay_qa_pass",
          artifactId,
          version: 2,
          result: "PASS",
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await artifactStub(studio.org.id).securityApprove({
          orgId: studio.org.id,
          actorType: "employee",
          actorId: security.id,
          idempotencyKey: "replay_security_approval",
          artifactId,
          version: 2,
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await artifactStub(studio.org.id).finalize({
          orgId: studio.org.id,
          actorType: "human",
          actorId: studio.org.createdByUserId,
          idempotencyKey: "replay_human_approval",
          artifactId,
          version: 2,
        })
      ).decision,
    ).toBe("ALLOW");
    const taskTrace = await env.DB.prepare(
      `SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ correlation_id: string }>();
    const correlationId = taskTrace?.correlation_id ?? "";
    expect(correlationId).toMatch(/^corr_/);
    const workflowRunId = createId("wfr");
    const workflow = await introspectWorkflowInstance(env.PRODUCTION_TASK, workflowRunId);
    try {
      const params: ProductionTaskParams = {
        orgId: studio.org.id,
        taskId,
        artifactId,
        version: 1,
        roomId: room.id,
        correlationId,
      };
      await env.PRODUCTION_TASK.create({ id: workflowRunId, params });
      await workflow.waitForStatus("complete");
      const completedRun = await env.DB.prepare(
        `SELECT status, completed_artifact_version FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(studio.org.id, workflowRunId)
        .first<{ status: string; completed_artifact_version: number }>();
      expect(completedRun).toEqual({ status: "complete", completed_artifact_version: 2 });
      const workflowTrace = await env.DB.prepare(
        `SELECT tasks.correlation_id AS correlation_id
         FROM workflow_runs
         INNER JOIN tasks
           ON tasks.org_id = workflow_runs.org_id AND tasks.id = workflow_runs.task_id
         WHERE workflow_runs.org_id = ? AND workflow_runs.instance_id = ?`,
      )
        .bind(studio.org.id, workflowRunId)
        .first<{ correlation_id: string }>();
      expect(workflowTrace?.correlation_id).toBe(correlationId);
    } finally {
      await workflow.dispose();
    }
    expect(
      (
        await command(
          { actorType: "human", actorId: studio.org.createdByUserId },
          "approve",
          "replay_task_approve",
          taskId,
        )
      ).state,
    ).toBe("APPROVED");
    expect(
      (
        await command(
          { actorType: "employee", actorId: manager.id },
          "complete",
          "replay_task_complete",
          taskId,
        )
      ).state,
    ).toBe("COMPLETED");

    await waitForEvents(studio.org.id, correlationId, 17);

    const records = await env.DB.prepare(
      `SELECT rowid AS projection_order, event_id, type, subject_type, subject_id, seq,
              occurred_at, correlation_id, body
       FROM domain_events
       WHERE org_id = ? AND correlation_id = ?
       ORDER BY projection_order`,
    )
      .bind(studio.org.id, correlationId)
      .all<ReplayEvent & { projection_order: number }>();
    const audit = await env.DB.prepare(
      `SELECT event_id, type, subject_type, subject_id, seq, correlation_id
       FROM audit_events WHERE org_id = ? AND correlation_id = ?`,
    )
      .bind(studio.org.id, correlationId)
      .all<{
        event_id: string;
        type: string;
        subject_type: string;
        subject_id: string;
        seq: number;
        correlation_id: string;
      }>();
    expect(audit.results).toHaveLength(records.results.length);
    const auditById = new Map(audit.results.map((row) => [row.event_id, row]));
    for (const record of records.results) {
      expect(auditById.get(record.event_id)).toMatchObject({
        type: record.type,
        subject_type: record.subject_type,
        subject_id: record.subject_id,
        seq: record.seq,
        correlation_id: correlationId,
      });
    }

    const orderedRecords = [...records.results].sort(
      (left, right) =>
        left.occurred_at.localeCompare(right.occurred_at) ||
        left.projection_order - right.projection_order,
    );
    expect(orderedRecords.map((record) => record.occurred_at)).toEqual(
      [...orderedRecords.map((record) => record.occurred_at)].sort(),
    );
    const taskSequences = orderedRecords
      .filter((record) => record.subject_type === "task")
      .map((record) => record.seq);
    expect(taskSequences).toEqual([...taskSequences].sort((left, right) => left - right));
    const reconstructed = replay(orderedRecords);
    expect(reconstructed.milestones).toEqual([
      "created",
      "assigned",
      "delivered",
      "acknowledged",
      "working",
      "artifact-v1",
      "submitted",
      "qa-revision",
      "revision",
      "working",
      "artifact-v2",
      "submitted",
      "qa-pass",
      "security-approve",
      "human-approve",
      "task-approved",
      "complete",
    ]);
    expect(reconstructed.versions).toEqual([1, 2]);
    expect(reconstructed.reviews).toEqual([
      { version: 1, result: "REVISION_REQUIRED" },
      { version: 2, result: "PASS" },
    ]);
    expect(reconstructed).toMatchObject({
      taskState: "COMPLETED",
      assigneeId: worker.id,
      securityApproved: true,
      humanApproved: true,
      governanceSatisfied: true,
    });

    const canonicalTask = await env.DB.prepare(
      `SELECT state, assignee_id FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ state: string; assignee_id: string | null }>();
    const canonicalArtifact = await env.DB.prepare(
      `SELECT canonical_version FROM artifacts WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, artifactId)
      .first<{ canonical_version: number }>();
    const canonicalApprovals = await env.DB.prepare(
      `SELECT kind, decision FROM approvals WHERE org_id = ? AND artifact_id = ? ORDER BY kind`,
    )
      .bind(studio.org.id, artifactId)
      .all<{ kind: string; decision: string }>();
    const canonicalWorkflow = await env.DB.prepare(
      `SELECT status FROM workflow_runs WHERE org_id = ? AND task_id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ status: string }>();
    expect(reconstructed.taskState).toBe(canonicalTask?.state);
    expect(reconstructed.assigneeId).toBe(canonicalTask?.assignee_id);
    expect(reconstructed.versions.at(-1)).toBe(canonicalArtifact?.canonical_version);
    expect(canonicalWorkflow?.status).toBe("complete");
    expect(reconstructed.governanceSatisfied).toBe(
      canonicalApprovals.results.every((approval) => approval.decision === "PASS"),
    );
    expect(canonicalApprovals.results).toEqual([
      { kind: "final", decision: "PASS" },
      { kind: "security", decision: "PASS" },
    ]);
  }, 30_000);
});
