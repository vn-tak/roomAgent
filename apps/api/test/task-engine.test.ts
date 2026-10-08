import type { TaskCommand, TaskResult } from "@ai-company/task";
import type { FoundationStore } from "@ai-company/db";
import type { Organization, Role } from "@ai-company/domain";
import type { RoomEnvelope } from "@ai-company/room";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  agentStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  roomStub,
  taskStub,
} from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

function employeeActor(orgId: string, employeeId: string) {
  return { orgId, actorType: "employee" as const, actorId: employeeId };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

async function run(
  actor: { orgId: string; actorType: "human" | "employee"; actorId: string },
  command: TaskCommand["command"],
  fields: {
    key: string;
    taskId?: string;
    assigneeId?: string;
    title?: string;
    objective?: string;
    roomId?: string | null;
    dependsOn?: string[];
  },
): Promise<TaskResult> {
  return taskStub(actor.orgId).execute({
    orgId: actor.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    idempotencyKey: fields.key,
    command,
    taskId: fields.taskId ?? null,
    assigneeId: fields.assigneeId ?? null,
    title: fields.title ?? null,
    objective: fields.objective ?? null,
    roomId: fields.roomId ?? null,
    dependsOn: fields.dependsOn ?? [],
  });
}

async function storedTask(orgId: string, taskId: string) {
  return env.DB.prepare(
    `SELECT state, assignee_id, handoff_count, human_review_required, pause_reason
     FROM tasks WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, taskId)
    .first<{
      state: string;
      assignee_id: string | null;
      handoff_count: number;
      human_review_required: number;
      pause_reason: string | null;
    }>();
}

describe("task engine", () => {
  it("validates transitions, duplicates, assignment, approval, suspension, and blocks", async () => {
    const studio = await createStudio("Task path");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const reviewer = await hire(studio.store, studio.org.id, "Reviewer");
    const approver = await studio.store.createRole(studio.org.id, {
      code: "final_approver",
      name: "Final approver",
    });
    await studio.store.assignPermission(studio.org.id, approver.id, "artifact.approve");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const security = await hire(studio.store, studio.org.id, "Security");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: approver.id });
    await org.assignRole({ ...owner, employeeId: reviewer.id, roleId: approver.id });
    await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });

    const created = await run(owner, "create", {
      key: "create_task_01",
      title: "Storyboard scene 17",
      objective: "Revise the scene.",
    });
    expect(created).toMatchObject({ decision: "ALLOW", state: "CREATED", duplicate: false });
    const taskId = created.taskId ?? "";
    const again = await run(owner, "create", {
      key: "create_task_01",
      title: "Different title",
      objective: "Different objective.",
    });
    expect(again).toMatchObject({ decision: "ALLOW", taskId, duplicate: true, state: "CREATED" });
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`)
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const columns = await env.DB.prepare(`PRAGMA table_info(tasks)`).all<{ name: string }>();
    const columnNames = columns.results.map((column) => column.name);
    expect(columnNames).not.toContain("code");
    expect(columnNames).not.toContain("token");
    expect(columnNames).not.toContain("cookie");
    expect(columnNames).not.toContain("password");
    expect(columnNames).not.toContain("secret");

    expect((await run(owner, "ack", { key: "ack_too_soon", taskId })).reason).toBe(
      "INVALID_TRANSITION",
    );
    expect(
      (
        await run(employeeActor(studio.org.id, worker.id), "assign", {
          key: "worker_assign",
          taskId,
          assigneeId: worker.id,
        })
      ).reason,
    ).toBe("NO_PERMISSION");
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("CREATED");

    const assigned = await run(employeeActor(studio.org.id, manager.id), "assign", {
      key: "assign_worker",
      taskId,
      assigneeId: worker.id,
    });
    expect(assigned).toMatchObject({ decision: "ALLOW", state: "QUEUED", handoffCount: 0 });
    const delivered = await run(employeeActor(studio.org.id, manager.id), "deliver", {
      key: "deliver_worker",
      taskId,
    });
    expect(delivered).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    const snap = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(snap.pending).toBe(1);
    expect(snap.currentTaskId).toBeNull();

    const workerActor = employeeActor(studio.org.id, worker.id);
    expect((await run(workerActor, "ack", { key: "ack_worker_1", taskId })).state).toBe(
      "ACKNOWLEDGED",
    );
    expect((await run(workerActor, "ack", { key: "ack_worker_1", taskId })).duplicate).toBe(true);
    expect((await run(workerActor, "start", { key: "start_worker", taskId })).state).toBe(
      "WORKING",
    );
    expect((await run(workerActor, "submit", { key: "submit_worker", taskId })).state).toBe(
      "REVIEW",
    );
    expect(
      (
        await run(employeeActor(studio.org.id, manager.id), "request_revision", {
          key: "revise_once",
          taskId,
        })
      ).state,
    ).toBe("REVISION");
    expect((await run(workerActor, "start", { key: "start_revision", taskId })).state).toBe(
      "WORKING",
    );
    expect((await run(workerActor, "submit", { key: "submit_revision", taskId })).state).toBe(
      "REVIEW",
    );

    expect((await run(owner, "approve", { key: "owner_approve", taskId })).reason).toBe(
      "NO_SELF_APPROVAL",
    );
    expect((await run(workerActor, "approve", { key: "worker_approve", taskId })).reason).toBe(
      "NO_SELF_APPROVAL",
    );
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("REVIEW");
    expect(
      (
        await run(employeeActor(studio.org.id, reviewer.id), "approve", {
          key: "qa_approve",
          taskId,
        })
      ).state,
    ).toBe("APPROVED");
    expect(
      (
        await run(employeeActor(studio.org.id, manager.id), "complete", {
          key: "manager_complete",
          taskId,
        })
      ).state,
    ).toBe("COMPLETED");
    expect(
      (
        await run(employeeActor(studio.org.id, manager.id), "complete", {
          key: "manager_complete_2",
          taskId,
        })
      ).reason,
    ).toBe("INVALID_TRANSITION");
    expect(await storedTask(studio.org.id, taskId)).toMatchObject({
      state: "COMPLETED",
      assignee_id: worker.id,
      human_review_required: 0,
      pause_reason: null,
    });

    const held = await run(owner, "create", {
      key: "held_task_01",
      title: "Held",
      objective: "Wait.",
    });
    const heldId = held.taskId ?? "";
    await org.createSecurityBlock({
      ...owner,
      resourceType: "task",
      resourceId: heldId,
      severity: "high",
      reason: "Hold the task",
    });
    const blocked = await run(employeeActor(studio.org.id, manager.id), "assign", {
      key: "assign_held",
      taskId: heldId,
      assigneeId: worker.id,
    });
    expect(blocked.reason).toBe("SECURITY_BLOCK");
    expect((await storedTask(studio.org.id, heldId))?.state).toBe("CREATED");

    const paused = await run(owner, "create", {
      key: "pause_task_1",
      title: "Loop",
      objective: "Hand off.",
    });
    const pauseId = paused.taskId ?? "";
    const peer = await hire(studio.store, studio.org.id, "Peer");
    let handoff = await run(employeeActor(studio.org.id, manager.id), "assign", {
      key: "loop_assign_0",
      taskId: pauseId,
      assigneeId: worker.id,
    });
    expect(handoff.handoffCount).toBe(0);
    const pair = [peer.id, worker.id];
    for (let step = 1; step <= 8; step += 1) {
      handoff = await run(employeeActor(studio.org.id, manager.id), "assign", {
        key: `loop_step_${step}`,
        taskId: pauseId,
        assigneeId: pair[(step - 1) % 2] ?? worker.id,
      });
      expect(handoff).toMatchObject({ decision: "ALLOW", reason: "ALLOWED", handoffCount: step });
    }
    const guard = await run(employeeActor(studio.org.id, manager.id), "assign", {
      key: "loop_step_9",
      taskId: pauseId,
      assigneeId: peer.id,
    });
    expect(guard).toMatchObject({
      decision: "ALLOW",
      reason: "LOOP_GUARD",
      state: "PAUSED",
      handoffCount: 8,
      humanReviewRequired: true,
      pauseReason: "LOOP_GUARD",
    });
    expect(await storedTask(studio.org.id, pauseId)).toMatchObject({
      state: "PAUSED",
      handoff_count: 8,
      human_review_required: 1,
      pause_reason: "LOOP_GUARD",
      assignee_id: worker.id,
    });
  });

  it("keeps a suspended assignee from acting and rejects an open dependency", async () => {
    const studio = await createStudio("Task gates");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const reviewer = await hire(studio.store, studio.org.id, "Reviewer");
    const idle = await hire(studio.store, studio.org.id, "Idle");
    const approver = await studio.store.createRole(studio.org.id, {
      code: "final_approver",
      name: "Final approver",
    });
    await studio.store.assignPermission(studio.org.id, approver.id, "artifact.approve");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: reviewer.id, roleId: approver.id });
    await org.assignRole({ ...owner, employeeId: idle.id, roleId: employeeRole.id });
    await org.suspendEmployee({ ...owner, employeeId: idle.id });

    const ownerTask = await run(owner, "create", {
      key: "gate_create_a",
      title: "Upstream",
      objective: "Finish first.",
    });
    const upstream = ownerTask.taskId ?? "";
    const downstream = await run(owner, "create", {
      key: "gate_create_b",
      title: "Downstream",
      objective: "Wait for upstream.",
      dependsOn: [upstream],
    });
    const taskId = downstream.taskId ?? "";
    expect(
      (
        await env.DB.prepare(
          `SELECT depends_on FROM task_dependencies WHERE org_id = ? AND task_id = ?`,
        )
          .bind(studio.org.id, taskId)
          .first<{ depends_on: string }>()
      )?.depends_on,
    ).toBe(upstream);

    const managerActor = employeeActor(studio.org.id, manager.id);
    expect(
      (
        await run(managerActor, "assign", {
          key: "assign_idle",
          taskId,
          assigneeId: idle.id,
        })
      ).reason,
    ).toBe("SUSPENDED_AGENT_DENY");

    await run(managerActor, "assign", {
      key: "assign_up",
      taskId: upstream,
      assigneeId: worker.id,
    });
    await run(managerActor, "deliver", { key: "deliver_up", taskId: upstream });
    await run(managerActor, "assign", { key: "assign_down", taskId, assigneeId: worker.id });
    await run(managerActor, "deliver", { key: "deliver_down", taskId });
    const workerActor = employeeActor(studio.org.id, worker.id);
    await run(workerActor, "ack", { key: "ack_down", taskId });
    expect((await run(workerActor, "start", { key: "start_down", taskId })).reason).toBe(
      "DEPENDENCY_NOT_COMPLETED",
    );

    expect((await run(workerActor, "ack", { key: "ack_upstream", taskId: upstream })).state).toBe(
      "ACKNOWLEDGED",
    );
    await org.suspendEmployee({ ...owner, employeeId: worker.id });
    expect(
      (await run(workerActor, "start", { key: "start_suspended", taskId: upstream })).reason,
    ).toBe("SUSPENDED_AGENT_DENY");
    expect((await storedTask(studio.org.id, upstream))?.state).toBe("ACKNOWLEDGED");
  });

  it("accepts one of two parallel starts and projects a room ack", async () => {
    const studio = await createStudio("Task race");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    const created = await run(owner, "create", {
      key: "race_create",
      title: "Race",
      objective: "Start once.",
    });
    const taskId = created.taskId ?? "";
    const managerActor = employeeActor(studio.org.id, manager.id);
    const workerActor = employeeActor(studio.org.id, worker.id);
    await run(managerActor, "assign", { key: "race_assign", taskId, assigneeId: worker.id });
    await run(managerActor, "deliver", { key: "race_deliver", taskId });
    await run(workerActor, "ack", { key: "race_ack", taskId });
    const [left, right] = await Promise.all([
      run(workerActor, "start", { key: "race_start_a", taskId }),
      run(workerActor, "start", { key: "race_start_b", taskId }),
    ]);
    const reasons = [left.reason, right.reason].sort();
    expect(reasons).toEqual(["ALLOWED", "INVALID_TRANSITION"]);
    expect([left, right].filter((result) => result.decision === "ALLOW")).toHaveLength(1);
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("WORKING");

    const other = await createStudio("Task other");
    const foreign = await run(ownerOf(other.org), "cancel", { key: "foreign_cancel", taskId });
    expect(foreign.reason).toBe("TENANT_BOUNDARY");

    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await roomStub(studio.org.id, room.id).join({
      ...owner,
      roomId: room.id,
      employeeId: worker.id,
    });
    const session = await openBrowserSession(studio.org, worker.id, [
      "room.read",
      "room.message.send",
      "task.accept",
    ]);
    const response = await exports.default.fetch(
      `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/socket`,
      { headers: { Upgrade: "websocket" } },
    );
    const socket = response.webSocket;
    if (!socket) {
      throw new Error("Missing WebSocket");
    }
    socket.accept();
    const messages: RoomEnvelope[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as RoomEnvelope);
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        data: { employee_id: worker.id, token: session.token },
      }),
    );
    await vi.waitFor(() => {
      expect(messages.some((item) => item.type === "session.ready")).toBe(true);
    });
    const acked = await run(owner, "create", {
      key: "socket_create",
      title: "Socket",
      objective: "Ack from the room.",
    });
    const socketTask = acked.taskId ?? "";
    await run(managerActor, "assign", {
      key: "socket_assign",
      taskId: socketTask,
      assigneeId: worker.id,
    });
    await run(managerActor, "deliver", { key: "socket_deliver", taskId: socketTask });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "task.ack",
        data: { task_id: socketTask, idempotency_key: "socket_ack_1" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        messages.some((item) => item.type === "task.updated" && item.data.task_id === socketTask),
      ).toBe(true);
    });
    expect(messages.find((item) => item.data.task_id === socketTask)?.data.status).toBe(
      "ACKNOWLEDGED",
    );
    expect((await storedTask(studio.org.id, socketTask))?.state).toBe("ACKNOWLEDGED");
    expect(
      (
        await agentStub(studio.org.id, worker.id).snapshot({
          orgId: studio.org.id,
          employeeId: worker.id,
        })
      ).currentTaskId,
    ).toBeNull();
  });
});
