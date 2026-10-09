import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  agentStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  taskStub,
} from "./helpers";

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) await scheduler.wait(1);
}

async function connectAgent(orgId: string, employeeId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/agents/${employeeId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Missing agent WebSocket");
  response.webSocket.accept();
  return response.webSocket;
}

describe("TaskDO durable outbox retry", () => {
  it.each([1, 2, 3])("retries a queue send after %i injected failures", async (failures) => {
    const studio = await createStudio(`Outbox retry ${failures}`);
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Retry room",
      departmentId: null,
    });
    const task = taskStub(studio.org.id);
    expect(await task.armPublishFault(failures)).toEqual({ armed: true });
    const created = await task.execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: `retry_create_${failures}`,
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Retry queue publication",
      objective: "Keep the task mutation durable while publishing retries.",
      roomId: room.id,
      dependsOn: [],
    });
    expect(created.decision).toBe("ALLOW");
    const taskId = created.taskId;
    if (!taskId) throw new Error("Task create did not return an id");

    let status = await task.outboxStatusForTest();
    expect(status).toMatchObject({ pendingEvents: 1, sentEvents: 0, failedEvents: 0 });
    expect(status.alarmAt).not.toBeNull();
    for (let attempt = 1; attempt < failures; attempt += 1) {
      expect(await task.runAlarmForTest()).toEqual({ ran: true });
      status = await task.outboxStatusForTest();
      expect(status.pendingEvents).toBe(1);
      expect(status.alarmAt).not.toBeNull();
    }
    expect(await task.runAlarmForTest()).toEqual({ ran: true });
    status = await task.outboxStatusForTest();
    expect(status).toMatchObject({ pendingEvents: 0, sentEvents: 1, failedEvents: 0 });
    expect(status.alarmAt).toBeNull();
    await vi.waitFor(async () => {
      const eventCount = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND subject_id = ? AND type = 'task.created'`,
      )
        .bind(studio.org.id, taskId)
        .first<{ n: number }>();
      expect(eventCount?.n).toBe(1);
    });
  });

  it("dead-letters an invalid stored event instead of retrying it forever", async () => {
    const studio = await createStudio("Invalid outbox event");
    const task = taskStub(studio.org.id);
    const created = await task.execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "invalid_event_create",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Broken event",
      objective: "Mark invalid persisted JSON as failed.",
      roomId: null,
      dependsOn: [],
    });
    expect(created.decision).toBe("ALLOW");
    await task.armPublishFault(1);
    const second = await task.execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "invalid_event_second",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Retry event",
      objective: "Corrupt its outbox row through the local test seam.",
      roomId: null,
      dependsOn: [],
    });
    expect(second.decision).toBe("ALLOW");
    const id = second.taskId;
    if (!id) throw new Error("Task create did not return an id");
    await runInDurableObject(task, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE event_outbox SET body = '{', status = 'pending', next_attempt_at = 0 WHERE idempotency_key = 'invalid_event_second'`,
      );
    });
    await task.runAlarmForTest();
    expect(await task.outboxStatusForTest()).toMatchObject({
      pendingEvents: 0,
      failedEvents: 1,
      alarmAt: null,
    });
  });

  it("reconciles Agent inbox ACK after TaskDO commits despite a projection failure", async () => {
    const studio = await createStudio("ACK projection retry");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!employeeRole) throw new Error("Missing employee role");
    await organizationStub(studio.org.id).assignRole({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "ACK room",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const session = await openBrowserSession(studio.org, worker.id, ["task.read"]);
    const socket = await connectAgent(studio.org.id, worker.id);
    const frames: string[] = [];
    socket.addEventListener("message", (event) => frames.push(String(event.data)));
    socket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        data: { token: session.token },
      }),
    );
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.includes("session.ready"))).toBe(true),
    );

    const task = taskStub(studio.org.id);
    const created = await task.execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "ack_projection_create",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Canonical acceptance",
      objective: "Project accepted work into the employee inbox.",
      roomId: room.id,
      dependsOn: [],
    });
    const taskId = created.taskId;
    if (!taskId) throw new Error("Task create did not return an id");
    expect(
      (
        await task.execute({
          orgId: studio.org.id,
          actorType: "human",
          actorId: studio.org.createdByUserId,
          idempotencyKey: "ack_projection_assign",
          command: "assign",
          taskId,
          assigneeId: worker.id,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      (
        await task.execute({
          orgId: studio.org.id,
          actorType: "human",
          actorId: studio.org.createdByUserId,
          idempotencyKey: "ack_projection_deliver",
          command: "deliver",
          taskId,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        })
      ).decision,
    ).toBe("ALLOW");
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.includes("inbox.delivered"))).toBe(true),
    );
    expect(await agentStub(studio.org.id, worker.id).armProjectionFault(1)).toEqual({
      armed: true,
    });

    const ackCommand = {
      orgId: studio.org.id,
      actorType: "employee" as const,
      actorId: worker.id,
      idempotencyKey: "canonical_ack_once",
      command: "ack" as const,
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    };
    const ackResult = await task.execute(ackCommand);
    expect(ackResult.reason).toBe("ALLOWED");
    expect(ackResult).toMatchObject({ decision: "ALLOW", state: "ACKNOWLEDGED" });
    const persisted = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    expect(persisted?.state).toBe("ACKNOWLEDGED");
    expect(
      (
        await agentStub(studio.org.id, worker.id).snapshot({
          orgId: studio.org.id,
          employeeId: worker.id,
        })
      ).currentTaskId,
    ).toBe(taskId);
    expect((await task.outboxStatusForTest()).pendingAcknowledgements).toBe(1);

    await task.runAlarmForTest();
    const projected = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(projected.currentTaskId).toBe(taskId);
    expect(projected.availability).toBe("BUSY");
    expect(projected.pending).toBe(0);
    expect((await task.outboxStatusForTest()).pendingAcknowledgements).toBe(0);
    const duplicate = await task.execute(ackCommand);
    expect(duplicate).toMatchObject({ decision: "ALLOW", state: "ACKNOWLEDGED", duplicate: true });
    await pump();
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND subject_id = ? AND type = 'task.acknowledged'`,
    )
      .bind(studio.org.id, taskId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
    socket.close();
  });
});
