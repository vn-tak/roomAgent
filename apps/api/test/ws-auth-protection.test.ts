import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentStub, createStudio, hire, roomStub } from "./helpers";

type SocketMessage = { type: string; data: Record<string, unknown>; seq?: number };

function collect(socket: WebSocket): SocketMessage[] {
  const messages: SocketMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as SocketMessage);
  });
  return messages;
}

async function connect(url: string): Promise<WebSocket> {
  const response = await exports.default.fetch(url, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  if (!response.webSocket) {
    throw new Error("Missing WebSocket");
  }
  response.webSocket.accept();
  return response.webSocket;
}

async function until(
  messages: SocketMessage[],
  predicate: (messages: SocketMessage[]) => boolean,
): Promise<void> {
  await vi.waitFor(() => expect(predicate(messages)).toBe(true));
}

async function untilClosed(socket: WebSocket): Promise<void> {
  await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
}

describe("WebSocket authentication deadline and message limits", () => {
  it("blocks room actions before hello and closes the unauthenticated socket on deadline", async () => {
    const studio = await createStudio("Room socket auth deadline");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Protected room",
      departmentId: null,
    });
    const member = await hire(studio.store, studio.org.id, "Room member");
    await roomStub(studio.org.id, room.id).join({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      employeeId: member.id,
    });
    const socket = await connect(
      `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/socket`,
    );
    const messages = collect(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "task.ack",
        data: { task_id: "task_fake_0001", idempotency_key: "unauth_ack_01" },
      }),
    );
    await until(messages, (items) => items.some((item) => item.data.code === "NOT_READY"));
    socket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "💥".repeat(3000), idempotency_key: "oversized_body1" },
      }),
    );
    await until(messages, (items) => items.some((item) => item.data.code === "INVALID_INPUT"));

    const live = roomStub(studio.org.id, room.id);
    const initial = await runRoomState(live);
    expect(initial).toMatchObject({ seq: 1, presenceCount: 0 });
    expect(messages.some((item) => item.type === "member.joined")).toBe(false);
    await runInDurableObject(live, async (instance, state) => {
      const server = state.getWebSockets()[0];
      if (!server) {
        throw new Error("Missing accepted room socket");
      }
      const attachment = server.deserializeAttachment() as Record<string, unknown>;
      server.serializeAttachment({ ...attachment, authDeadlineAt: Date.now() - 1 });
      await instance.alarm();
    });
    await untilClosed(socket);
    expect(await runRoomState(live)).toMatchObject({ seq: 1, presenceCount: 0 });
  });

  it("keeps inbox queued, rejects ACK, and closes unauthenticated Agent sockets", async () => {
    const studio = await createStudio("Agent socket auth deadline");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Inbox room",
      departmentId: null,
    });
    const live = agentStub(studio.org.id, worker.id);
    const socket = await connect(
      `https://company.local/orgs/${studio.org.id}/agents/${worker.id}/socket`,
    );
    const messages = collect(socket);
    const enqueued = await live.enqueue({
      orgId: studio.org.id,
      employeeId: worker.id,
      type: "task",
      taskId: "task_fake_0001",
      roomId: room.id,
      priority: 1,
      body: "A task held until session hello.",
      idempotencyKey: "unauth_inbox_01",
    });
    expect(enqueued).toMatchObject({ decision: "ALLOW", state: "QUEUED" });
    socket.send(JSON.stringify({ v: 1, type: "inbox.ack", data: { inbox_id: "inb_fake_0001" } }));
    await until(messages, (items) => items.some((item) => item.data.code === "NOT_READY"));
    socket.send(
      JSON.stringify({
        v: 1,
        type: "heartbeat",
        data: { padding: "💥".repeat(3000) },
      }),
    );
    await until(messages, (items) => items.some((item) => item.data.code === "INVALID_INPUT"));
    expect(messages.some((item) => item.type === "inbox.delivered")).toBe(false);

    const row = await runInDurableObject(
      live,
      (_instance, state) =>
        state.storage.sql
          .exec<{ state: string }>(
            "SELECT state FROM inbox WHERE idempotency_key = 'unauth_inbox_01'",
          )
          .toArray()[0]?.state,
    );
    expect(row).toBe("QUEUED");
    expect(await live.snapshot({ orgId: studio.org.id, employeeId: worker.id })).toMatchObject({
      reachability: "UNREACHABLE",
      availability: "OFFLINE",
    });

    await runInDurableObject(live, async (instance, state) => {
      const server = state.getWebSockets()[0];
      if (!server) {
        throw new Error("Missing accepted Agent socket");
      }
      const attachment = server.deserializeAttachment() as Record<string, unknown>;
      server.serializeAttachment({ ...attachment, authDeadlineAt: Date.now() - 1 });
      await instance.alarm();
    });
    await untilClosed(socket);
    const afterClose = await runInDurableObject(
      live,
      (_instance, state) =>
        state.storage.sql
          .exec<{ state: string }>(
            "SELECT state FROM inbox WHERE idempotency_key = 'unauth_inbox_01'",
          )
          .toArray()[0]?.state,
    );
    expect(afterClose).toBe("QUEUED");
  });
});

async function runRoomState(
  live: ReturnType<typeof roomStub>,
): Promise<{ seq: number; presenceCount: number }> {
  return runInDurableObject(live, (_instance, state) => ({
    seq: state.storage.sql.exec<{ seq: number }>("SELECT seq FROM meta").toArray()[0]?.seq ?? 0,
    presenceCount:
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM presence").toArray()[0]?.n ??
      0,
  }));
}
