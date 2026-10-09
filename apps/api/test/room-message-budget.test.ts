import type { Organization } from "@ai-company/domain";
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
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

type SocketMessage = RoomEnvelope;

function collect(socket: WebSocket): SocketMessage[] {
  const messages: SocketMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as SocketMessage);
  });
  return messages;
}

async function until(
  messages: SocketMessage[],
  start: number,
  predicate: (message: SocketMessage) => boolean,
): Promise<SocketMessage> {
  let found: SocketMessage | undefined;
  await vi.waitFor(() => {
    found = messages.slice(start).find(predicate);
    expect(found).toBeDefined();
  });
  if (!found) throw new Error("Expected socket message was not received");
  return found;
}

async function connect(orgId: string, roomId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/rooms/${roomId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Missing room WebSocket");
  response.webSocket.accept();
  return response.webSocket;
}

async function connectMember(
  org: Organization,
  employeeId: string,
  roomId: string,
  scopes?: string[],
): Promise<{ socket: WebSocket; messages: SocketMessage[] }> {
  const session = await openBrowserSession(org, employeeId, scopes);
  const socket = await connect(org.id, roomId);
  const messages = collect(socket);
  socket.send(
    JSON.stringify({
      v: 1,
      type: "session.hello",
      last_seen_seq: 0,
      data: { employee_id: employeeId, token: session.token },
    }),
  );
  await until(messages, 0, (message) => message.type === "session.ready");
  return { socket, messages };
}

async function setup(name: string, taskRoom: "a" | "b") {
  const prefix = name.toLowerCase().replaceAll(" ", "_");
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
  if (!employeeRole) throw new Error("Missing employee role");
  expect(
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: worker.id,
      roleId: employeeRole.id,
    }),
  ).toMatchObject({ decision: "ALLOW" });

  const roomA = await studio.store.createRoom(studio.org.id, {
    name: `${name} room A`,
    departmentId: null,
  });
  const roomB = await studio.store.createRoom(studio.org.id, {
    name: `${name} room B`,
    departmentId: null,
  });
  for (const room of [roomA, roomB]) {
    expect(
      await roomStub(studio.org.id, room.id).join({
        ...ownerOf(studio.org),
        roomId: room.id,
        employeeId: worker.id,
      }),
    ).toMatchObject({ decision: "ALLOW" });
  }

  const roomId = taskRoom === "a" ? roomA.id : roomB.id;
  const task = taskStub(studio.org.id);
  const created = await task.execute({
    ...ownerOf(studio.org),
    idempotencyKey: `${prefix}_create`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Room message budget",
    objective: "Count real room messages for the server-bound active task.",
    roomId,
    dependsOn: [],
  });
  expect(created.decision).toBe("ALLOW");
  if (!created.taskId) throw new Error("Task create did not return an id");

  const employee = {
    orgId: studio.org.id,
    actorType: "employee" as const,
    actorId: worker.id,
  };
  for (const [command, key, assigneeId, actor] of [
    ["assign", `${prefix}_assign`, worker.id, ownerOf(studio.org)],
    ["deliver", `${prefix}_deliver`, null, ownerOf(studio.org)],
    ["ack", `${prefix}_ack`, null, employee],
    ["start", `${prefix}_start`, null, employee],
  ] as const) {
    expect(
      await task.execute({
        ...actor,
        idempotencyKey: key,
        command,
        taskId: created.taskId,
        assigneeId,
        title: null,
        objective: null,
        roomId: null,
        dependsOn: [],
        ...(command === "ack" || command === "start" ? { expectedRoomId: roomId } : {}),
      }),
    ).toMatchObject({ decision: "ALLOW" });
  }
  expect(
    await agentStub(studio.org.id, worker.id).applyCanonicalTaskAck({
      orgId: studio.org.id,
      employeeId: worker.id,
      taskId: created.taskId,
      idempotencyKey: `${prefix}_agent_ack`,
    }),
  ).toMatchObject({ decision: "ALLOW" });
  expect(
    await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    }),
  ).toMatchObject({ currentTaskId: created.taskId });
  expect(await task.configureBudgetsForTest({ maxAgentMessagesPerTask: 1 })).toEqual({
    configured: true,
  });

  return { studio, worker, roomA, roomB, roomId, task, taskId: created.taskId, prefix };
}

async function headSeq(org: Organization, roomId: string, employeeId: string): Promise<number> {
  const snapshot = await roomStub(org.id, roomId).snapshot({
    orgId: org.id,
    roomId,
    actorType: "employee",
    actorId: employeeId,
  });
  expect(snapshot.decision).toBe("ALLOW");
  return snapshot.headSeq;
}

function sendMessage(socket: WebSocket, body: string, idempotencyKey: string): void {
  socket.send(
    JSON.stringify({
      v: 1,
      type: "message.send",
      data: { body, idempotency_key: idempotencyKey },
    }),
  );
}

async function eventCount(
  table: "domain_events" | "audit_events",
  orgId: string,
  taskId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE org_id = ? AND subject_id = ?`,
  )
    .bind(orgId, taskId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function taskStart(state: Awaited<ReturnType<typeof setup>>) {
  return state.task.execute({
    orgId: state.studio.org.id,
    actorType: "employee",
    actorId: state.worker.id,
    idempotencyKey: `${state.prefix}_start`,
    command: "start",
    taskId: state.taskId,
    assigneeId: null,
    title: null,
    objective: null,
    roomId: null,
    dependsOn: [],
    expectedRoomId: state.roomId,
  });
}

describe("RoomDO task message budgets", () => {
  it("counts socket messages once and rejects a message beyond the task limit", async () => {
    const state = await setup("Socket task message budget", "a");
    const { socket, messages } = await connectMember(
      state.studio.org,
      state.worker.id,
      state.roomA.id,
    );
    const startSeq = await headSeq(state.studio.org, state.roomA.id, state.worker.id);

    let start = messages.length;
    sendMessage(socket, "First task message", "socket_task_message_1");
    const accepted = await until(
      messages,
      start,
      (message) => message.type === "message.created" && message.data.body === "First task message",
    );

    start = messages.length;
    sendMessage(socket, "First task message", "socket_task_message_1");
    const duplicate = await until(
      messages,
      start,
      (message) => message.type === "message.created" && message.data.body === "First task message",
    );
    expect(duplicate.event_id).toBe(accepted.event_id);
    expect(duplicate.seq).toBe(accepted.seq);
    expect(await headSeq(state.studio.org, state.roomA.id, state.worker.id)).toBe(startSeq + 1);

    start = messages.length;
    sendMessage(socket, "Over the task limit", "socket_task_message_2");
    const denied = await until(messages, start, (message) => message.type === "error");
    expect(denied.data.code).toBe("BUDGET_GUARD");
    expect(await headSeq(state.studio.org, state.roomA.id, state.worker.id)).toBe(startSeq + 1);
    const task = await env.DB.prepare(
      `SELECT state, human_review_required, pause_reason FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(state.studio.org.id, state.taskId)
      .first<{ state: string; human_review_required: number; pause_reason: string | null }>();
    expect(task).toEqual({
      state: "PAUSED",
      human_review_required: 1,
      pause_reason: "BUDGET_GUARD",
    });
    socket.close();
  });

  it("publishes the canonical task correlation root on socket task events", async () => {
    const state = await setup("Socket task event correlation", "a");
    const task = await env.DB.prepare(
      `SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ? AND room_id = ?`,
    )
      .bind(state.studio.org.id, state.taskId, state.roomA.id)
      .first<{ correlation_id: string }>();
    expect(task?.correlation_id).toMatch(/^corr_/);

    const { socket, messages } = await connectMember(
      state.studio.org,
      state.worker.id,
      state.roomA.id,
      ["room.read", "room.message.send", "task.accept"],
    );
    const start = messages.length;
    socket.send(
      JSON.stringify({
        v: 1,
        type: "task.start",
        data: {
          task_id: state.taskId,
          idempotency_key: `${state.prefix}_start`,
        },
      }),
    );
    const update = await until(
      messages,
      start,
      (message) => message.type === "task.updated" && message.data.task_id === state.taskId,
    );
    expect(update.data.correlation_id).toBe(task?.correlation_id);
    socket.close();
  });

  it("rejects a Room A message for the active Room B task without consuming task or room state", async () => {
    const state = await setup("Cross room task message", "b");
    const taskState = await taskStart(state);
    expect(taskState).toMatchObject({ decision: "ALLOW", state: "WORKING", duplicate: true });

    const { socket: roomASocket, messages: roomAMessages } = await connectMember(
      state.studio.org,
      state.worker.id,
      state.roomA.id,
    );
    const roomASeq = await headSeq(state.studio.org, state.roomA.id, state.worker.id);
    const beforeState = await taskStart(state);
    const domainEvents = await eventCount("domain_events", state.studio.org.id, state.taskId);
    const auditEvents = await eventCount("audit_events", state.studio.org.id, state.taskId);

    const start = roomAMessages.length;
    sendMessage(roomASocket, "This belongs to Room B", "cross_room_message_01");
    const rejected = await until(roomAMessages, start, (message) => message.type === "error");
    expect(rejected.data.code).toBe("ROOM_MISMATCH");
    expect(await headSeq(state.studio.org, state.roomA.id, state.worker.id)).toBe(roomASeq);
    expect(await taskStart(state)).toEqual(beforeState);
    expect(await eventCount("domain_events", state.studio.org.id, state.taskId)).toBe(domainEvents);
    expect(await eventCount("audit_events", state.studio.org.id, state.taskId)).toBe(auditEvents);

    const { socket: roomBSocket, messages: roomBMessages } = await connectMember(
      state.studio.org,
      state.worker.id,
      state.roomB.id,
    );
    const roomBSeq = await headSeq(state.studio.org, state.roomB.id, state.worker.id);
    const beforeMessage = roomBMessages.length;
    sendMessage(roomBSocket, "The actual Room B task message", "room_b_task_message_1");
    const accepted = await until(
      roomBMessages,
      beforeMessage,
      (message) => message.type === "message.created",
    );
    expect(accepted.data.body).toBe("The actual Room B task message");
    expect(await headSeq(state.studio.org, state.roomB.id, state.worker.id)).toBe(roomBSeq + 1);
    roomASocket.close();
    roomBSocket.close();
  });
});
