import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { RoomEnvelope } from "@ai-company/room";
import { createId, type Organization } from "@ai-company/domain";
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
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function setRole(
  studio: Awaited<ReturnType<typeof createStudio>>,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  const role = await studio.store.getRoleByCode(studio.org.id, roleCode);
  if (!role) {
    throw new Error(`Missing role ${roleCode}`);
  }
  await organizationStub(studio.org.id).assignRole({
    ...ownerOf(studio.org),
    employeeId,
    roleId: role.id,
  });
}

async function createDeliveredTask(
  orgId: string,
  ownerId: string,
  managerId: string,
  workerId: string,
  roomId: string,
  key: string,
): Promise<string> {
  const created = await taskStub(orgId).execute({
    orgId,
    actorType: "human",
    actorId: ownerId,
    idempotencyKey: `${key}_create`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Room task",
    objective: "Accept this assigned work.",
    roomId,
    dependsOn: [],
  });
  expect(created.decision).toBe("ALLOW");
  const taskId = created.taskId;
  if (!taskId) {
    throw new Error("Task id was not returned");
  }
  const actor = { orgId, actorType: "employee" as const, actorId: managerId };
  const assigned = await taskStub(orgId).execute({
    ...actor,
    idempotencyKey: `${key}_assign`,
    command: "assign",
    taskId,
    assigneeId: workerId,
    title: null,
    objective: null,
    roomId: null,
    dependsOn: [],
  });
  expect(assigned).toMatchObject({ decision: "ALLOW", state: "QUEUED" });
  const delivered = await taskStub(orgId).execute({
    ...actor,
    idempotencyKey: `${key}_deliver`,
    command: "deliver",
    taskId,
    assigneeId: null,
    title: null,
    objective: null,
    roomId: null,
    dependsOn: [],
  });
  expect(delivered).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
  return taskId;
}

async function connectRoom(orgId: string, roomId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/rooms/${roomId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) {
    throw new Error("Missing room WebSocket");
  }
  response.webSocket.accept();
  return response.webSocket;
}

async function connectAgent(orgId: string, employeeId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/agents/${employeeId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) {
    throw new Error("Missing agent WebSocket");
  }
  response.webSocket.accept();
  return response.webSocket;
}

type RoomMessage = RoomEnvelope;
type AgentMessage = { type: string; data: Record<string, unknown> };

function collect<T>(socket: WebSocket): T[] {
  const messages: T[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as T);
  });
  return messages;
}

async function until<T>(messages: T[], predicate: (messages: T[]) => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate(messages)).toBe(true));
}

describe("room/task and work-acceptance consistency", () => {
  it("rejects cross-room task commands before any task or room mutation", async () => {
    const studio = await createStudio("Cross-room task guard");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    await setRole(studio, worker.id, "employee");
    await setRole(studio, manager.id, "manager");
    const roomA = await studio.store.createRoom(studio.org.id, {
      name: "Room A",
      departmentId: null,
    });
    const roomB = await studio.store.createRoom(studio.org.id, {
      name: "Room B",
      departmentId: null,
    });
    await roomStub(studio.org.id, roomA.id).join({
      ...ownerOf(studio.org),
      roomId: roomA.id,
      employeeId: worker.id,
    });
    const taskId = await createDeliveredTask(
      studio.org.id,
      studio.org.createdByUserId,
      manager.id,
      worker.id,
      roomB.id,
      "cross_room_task",
    );
    const session = await openBrowserSession(studio.org, worker.id, ["room.read", "task.accept"]);
    const socket = await connectRoom(studio.org.id, roomA.id);
    const messages = collect<RoomMessage>(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: worker.id, token: session.token },
      }),
    );
    await until(messages, (items) => items.some((item) => item.type === "session.ready"));

    const beforeRoom = await runInDurableObject(
      roomStub(studio.org.id, roomA.id),
      (_obj, state) =>
        state.storage.sql.exec<{ seq: number }>("SELECT seq FROM meta").toArray()[0]?.seq ?? 0,
    );
    const beforeTask = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    const beforeDomainEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    const beforeAuditEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();

    for (const [type, key] of [
      ["task.ack", "cross_room_ack_01"],
      ["task.start", "cross_room_start_1"],
      ["task.submit", "cross_room_submit1"],
    ]) {
      const rejected = messages.filter(
        (item) => item.type === "error" && item.data.code === "ROOM_MISMATCH",
      ).length;
      socket.send(
        JSON.stringify({
          v: 1,
          type,
          data: { task_id: taskId, idempotency_key: key },
        }),
      );
      await until(
        messages,
        (items) =>
          items.filter((item) => item.type === "error" && item.data.code === "ROOM_MISMATCH")
            .length ===
          rejected + 1,
      );
    }

    const afterRoom = await runInDurableObject(
      roomStub(studio.org.id, roomA.id),
      (_obj, state) =>
        state.storage.sql.exec<{ seq: number }>("SELECT seq FROM meta").toArray()[0]?.seq ?? 0,
    );
    const afterTask = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    const afterDomainEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    const afterAuditEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();

    expect(beforeTask?.state).toBe("DELIVERED");
    expect(afterTask?.state).toBe("DELIVERED");
    expect(afterRoom).toBe(beforeRoom);
    expect(afterDomainEvents?.n).toBe(beforeDomainEvents?.n);
    expect(afterAuditEvents?.n).toBe(beforeAuditEvents?.n);
    expect(
      messages.some((item) => item.type === "task.updated" && item.data.task_id === taskId),
    ).toBe(false);
    socket.close();
  });

  it("uses TaskDO as inbox ACK authority and reconciles a failed Agent projection", async () => {
    const studio = await createStudio("Canonical inbox acknowledgement");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    await setRole(studio, worker.id, "employee");
    await setRole(studio, manager.id, "manager");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Acceptance room",
      departmentId: null,
    });
    const session = await openBrowserSession(studio.org, worker.id, ["room.read", "task.accept"]);
    const socket = await connectAgent(studio.org.id, worker.id);
    const messages = collect<AgentMessage>(socket);
    socket.send(JSON.stringify({ v: 1, type: "session.hello", data: { token: session.token } }));
    await until(messages, (items) => items.some((item) => item.type === "session.ready"));

    const taskId = await createDeliveredTask(
      studio.org.id,
      studio.org.createdByUserId,
      manager.id,
      worker.id,
      room.id,
      "canonical_ack_task",
    );
    await until(messages, (items) =>
      items.some((item) => item.type === "inbox.delivered" && item.data.task_id === taskId),
    );
    const inbox = messages.find(
      (item) => item.type === "inbox.delivered" && item.data.task_id === taskId,
    );
    const inboxId = inbox?.data.inbox_id;
    expect(typeof inboxId).toBe("string");
    expect(await agentStub(studio.org.id, worker.id).armProjectionFault(1)).toEqual({
      armed: true,
    });

    socket.send(JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: inboxId } }));
    await until(
      messages,
      (items) =>
        items.some((item) => item.type === "error" && item.data.code === "ACK_PENDING") ||
        items.some((item) => item.type === "inbox.acknowledged" && item.data.inbox_id === inboxId),
    );
    const canonicalTask = await env.DB.prepare(
      `SELECT state FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    expect(canonicalTask?.state).toBe("ACKNOWLEDGED");

    await runInDurableObject(agentStub(studio.org.id, worker.id), async (instance) => {
      await instance.alarm();
    });
    await until(messages, (items) =>
      items.some((item) => item.type === "inbox.acknowledged" && item.data.inbox_id === inboxId),
    );
    const agentState = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(agentState).toMatchObject({ currentTaskId: taskId, availability: "BUSY" });
    const inboxState = await runInDurableObject(
      agentStub(studio.org.id, worker.id),
      (_obj, state) =>
        state.storage.sql
          .exec<{ state: string }>("SELECT state FROM inbox WHERE id = ?", inboxId)
          .toArray()[0]?.state,
    );
    expect(inboxState).toBe("ACKNOWLEDGED");

    const ackCommandsBefore = await runInDurableObject(
      taskStub(studio.org.id),
      (_obj, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM task_commands WHERE task_id = ? AND command_name = 'ack'`,
            taskId,
          )
          .toArray()[0]?.n ?? 0,
    );
    socket.send(JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: inboxId } }));
    await until(
      messages,
      (items) =>
        items.filter((item) => item.type === "inbox.acknowledged" && item.data.inbox_id === inboxId)
          .length >= 2,
    );
    const ackCommandsAfter = await runInDurableObject(
      taskStub(studio.org.id),
      (_obj, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM task_commands WHERE task_id = ? AND command_name = 'ack'`,
            taskId,
          )
          .toArray()[0]?.n ?? 0,
    );
    expect(ackCommandsAfter).toBe(ackCommandsBefore);
    socket.close();
  });

  it("denies a wrong employee, an unknown task, and a suspended Agent ACK", async () => {
    const studio = await createStudio("Rejected work acknowledgements");
    const worker = await hire(studio.store, studio.org.id, "Assignee");
    const peer = await hire(studio.store, studio.org.id, "Other employee");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    await setRole(studio, worker.id, "employee");
    await setRole(studio, peer.id, "employee");
    await setRole(studio, manager.id, "manager");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Rejected work room",
      departmentId: null,
    });
    const workerSession = await openBrowserSession(studio.org, worker.id, ["task.accept"]);
    const peerSession = await openBrowserSession(studio.org, peer.id, ["task.accept"]);
    const workerSocket = await connectAgent(studio.org.id, worker.id);
    const peerSocket = await connectAgent(studio.org.id, peer.id);
    const workerMessages = collect<AgentMessage>(workerSocket);
    const peerMessages = collect<AgentMessage>(peerSocket);
    workerSocket.send(
      JSON.stringify({ v: 1, type: "session.hello", data: { token: workerSession.token } }),
    );
    peerSocket.send(
      JSON.stringify({ v: 1, type: "session.hello", data: { token: peerSession.token } }),
    );
    await until(workerMessages, (items) => items.some((item) => item.type === "session.ready"));
    await until(peerMessages, (items) => items.some((item) => item.type === "session.ready"));

    const taskId = await createDeliveredTask(
      studio.org.id,
      studio.org.createdByUserId,
      manager.id,
      worker.id,
      room.id,
      "wrong_employee_task",
    );
    const wrongEmployeeInbox = await agentStub(studio.org.id, peer.id).enqueue({
      orgId: studio.org.id,
      employeeId: peer.id,
      type: "task",
      taskId,
      roomId: room.id,
      priority: 1,
      body: "This task is assigned to another employee.",
      idempotencyKey: "wrong_employee_01",
    });
    expect(wrongEmployeeInbox).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    const beforeWrongEmployee = peerMessages.filter((item) => item.type === "error").length;
    peerSocket.send(
      JSON.stringify({
        v: 1,
        type: "inbox.ack",
        data: { inbox_id: wrongEmployeeInbox.inboxId },
      }),
    );
    await until(
      peerMessages,
      (items) => items.filter((item) => item.type === "error").length > beforeWrongEmployee,
    );
    expect(peerMessages.at(-1)?.data.code).toBe("NOT_ASSIGNEE");
    const taskAfterWrongEmployee = await env.DB.prepare(
      `SELECT state FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    expect(taskAfterWrongEmployee?.state).toBe("DELIVERED");

    const unknownInbox = await agentStub(studio.org.id, peer.id).enqueue({
      orgId: studio.org.id,
      employeeId: peer.id,
      type: "task",
      taskId: createId("task"),
      roomId: room.id,
      priority: 1,
      body: "This task does not exist.",
      idempotencyKey: "wrong_task_0001",
    });
    expect(unknownInbox).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    const beforeUnknown = peerMessages.filter((item) => item.type === "error").length;
    peerSocket.send(
      JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: unknownInbox.inboxId } }),
    );
    await until(
      peerMessages,
      (items) => items.filter((item) => item.type === "error").length > beforeUnknown,
    );
    expect(peerMessages.at(-1)?.data.code).toBe("TENANT_BOUNDARY");

    const suspendedTaskId = await createDeliveredTask(
      studio.org.id,
      studio.org.createdByUserId,
      manager.id,
      worker.id,
      room.id,
      "suspended_employee_task",
    );
    await until(workerMessages, (items) =>
      items.some(
        (item) => item.type === "inbox.delivered" && item.data.task_id === suspendedTaskId,
      ),
    );
    const suspendedInbox = workerMessages.find(
      (item) => item.type === "inbox.delivered" && item.data.task_id === suspendedTaskId,
    );
    await env.DB.prepare(`UPDATE employees SET status = 'suspended' WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, worker.id)
      .run();
    workerSocket.send(
      JSON.stringify({
        v: 1,
        type: "inbox.ack",
        data: { inbox_id: suspendedInbox?.data.inbox_id },
      }),
    );
    await until(workerMessages, (items) => items.some((item) => item.type === "session.revoked"));
    const afterSuspend = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, suspendedTaskId)
      .first<{ state: string }>();
    expect(afterSuspend?.state).toBe("DELIVERED");
    workerSocket.close();
    peerSocket.close();
  });
});
