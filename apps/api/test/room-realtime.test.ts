import type { RoomEnvelope } from "@ai-company/room";
import type { FoundationStore } from "@ai-company/db";
import type { Organization, Role } from "@ai-company/domain";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  roomStub,
  storedPolicyVersion,
} from "./helpers";

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

async function connect(orgId: string, roomId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/rooms/${roomId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeDefined();
  if (!socket) {
    throw new Error("Missing WebSocket");
  }
  socket.accept();
  return socket;
}

function collect(socket: WebSocket): RoomEnvelope[] {
  const items: RoomEnvelope[] = [];
  socket.addEventListener("message", (event) => {
    items.push(JSON.parse(String(event.data)) as RoomEnvelope);
  });
  return items;
}

async function until(
  items: RoomEnvelope[],
  ready: (items: RoomEnvelope[]) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    expect(ready(items)).toBe(true);
  });
}

function hello(employeeId: string, token: string, lastSeenSeq = 0) {
  return {
    v: 1,
    type: "session.hello",
    last_seen_seq: lastSeenSeq,
    data: { employee_id: employeeId, token },
  };
}

describe("room realtime", () => {
  it("requires a websocket upgrade and a real room id", async () => {
    const studio = await createStudio("Room route");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const missing = await exports.default.fetch(
      `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/socket`,
    );
    expect(missing.status).toBe(426);
    expect(await missing.json()).toMatchObject({ error: { code: "UPGRADE_REQUIRED" } });

    const bad = await exports.default.fetch(
      "https://company.local/orgs/org_nope/rooms/room_nope/socket",
      {
        headers: { Upgrade: "websocket" },
      },
    );
    expect(bad.status).toBe(404);

    const absent = await roomStub(studio.org.id, room.id).fetch("https://room.local/socket");
    expect(absent.status).toBe(426);
  });

  it("admits a member once and denies a manager and a foreign employee", async () => {
    const studio = await createStudio("Room join");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const outsiderStudio = await createStudio("Room other");
    const outsider = await hire(outsiderStudio.store, outsiderStudio.org.id, "Outsider");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    const joined = await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    const again = await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    expect(joined).toMatchObject({ decision: "ALLOW", duplicate: false });
    expect(joined.event?.type).toBe("member.joined");
    expect(again).toMatchObject({ decision: "ALLOW", duplicate: true, seq: joined.seq });
    expect(await studio.store.listRoomMembers(studio.org.id, room.id)).toHaveLength(1);

    const managerJoin = await live.join({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: manager.id,
      employeeId: worker.id,
    });
    expect(managerJoin.reason).toBe("NO_PERMISSION");

    const foreign = await live.join({ ...owner, roomId: room.id, employeeId: outsider.id });
    expect(foreign.reason).toBe("TENANT_BOUNDARY");

    const crossed = await live.join({
      ...ownerOf(outsiderStudio.org),
      roomId: outsiderStudio.org.id,
      employeeId: worker.id,
    });
    expect(crossed.reason).toBe("TENANT_BOUNDARY");
  });

  it("orders messages for two clients and rejects duplicates, bad cursors, and task commands", async () => {
    const studio = await createStudio("Room messages");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const peer = await hire(studio.store, studio.org.id, "Peer");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: peer.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    await live.join({ ...owner, roomId: room.id, employeeId: peer.id });
    const workerSession = await openBrowserSession(studio.org, worker.id);
    const peerSession = await openBrowserSession(studio.org, peer.id);

    const left = await connect(studio.org.id, room.id);
    const right = await connect(studio.org.id, room.id);
    const leftMessages = collect(left);
    const rightMessages = collect(right);
    left.send(JSON.stringify(hello(worker.id, workerSession.token)));
    right.send(JSON.stringify(hello(peer.id, peerSession.token)));
    await until(leftMessages, (items) => items.some((item) => item.type === "session.ready"));
    await until(rightMessages, (items) => items.some((item) => item.type === "session.ready"));

    left.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "Line one", idempotency_key: "line_one_01" },
      }),
    );
    left.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "Line two", idempotency_key: "line_two_01" },
      }),
    );
    await until(
      rightMessages,
      (items) => items.filter((item) => item.type === "message.created").length >= 2,
    );
    const created = rightMessages.filter((item) => item.type === "message.created");
    expect(created[0]?.data.body).toBe("Line one");
    expect(created[1]?.data.body).toBe("Line two");
    expect(created[1]?.seq).toBe((created[0]?.seq ?? 0) + 1);

    left.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "Line one again", idempotency_key: "line_one_01" },
      }),
    );
    await until(
      leftMessages,
      (items) => items.filter((item) => item.seq === created[0]?.seq).length >= 2,
    );
    expect(rightMessages.filter((item) => item.type === "message.created")).toHaveLength(2);

    const log = await live.eventsSince({
      ...owner,
      roomId: room.id,
      afterSeq: 0,
    });
    const stored = log.events.filter((item) => item.type === "message.created");
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.seq)).toEqual([created[0]?.seq, created[1]?.seq]);

    const third = await connect(studio.org.id, room.id);
    const thirdMessages = collect(third);
    third.send(JSON.stringify(hello(worker.id, workerSession.token, 999)));
    await until(thirdMessages, (items) => items.some((item) => item.type === "error"));
    expect(thirdMessages[0]?.data.code).toBe("INVALID_SEQUENCE");
    expect(thirdMessages.some((item) => item.type === "session.ready")).toBe(false);

    left.send(JSON.stringify({ v: 1, type: "task.ack", data: {} }));
    await until(leftMessages, (items) =>
      items.some((item) => item.type === "error" && item.data.code === "NO_SCOPE"),
    );
    left.send(JSON.stringify({ v: 1, type: "artifact.submit", data: {} }));
    await until(leftMessages, (items) =>
      items.some((item) => item.type === "error" && item.data.code === "NOT_AVAILABLE"),
    );
    const head = await live.eventsSince({ ...owner, roomId: room.id, afterSeq: 0 });
    expect(head.seq).toBe(created[1]?.seq);
  });

  it("keeps rooms isolated and gives chat text no authority", async () => {
    const studio = await createStudio("Room isolation");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const leftRoom = await studio.store.createRoom(studio.org.id, {
      name: "Left",
      departmentId: null,
    });
    const rightRoom = await studio.store.createRoom(studio.org.id, {
      name: "Right",
      departmentId: null,
    });
    const policyBefore = await storedPolicyVersion(studio.org.id);
    const left = roomStub(studio.org.id, leftRoom.id);
    const right = roomStub(studio.org.id, rightRoom.id);
    await left.join({ ...owner, roomId: leftRoom.id, employeeId: worker.id });
    await right.join({ ...owner, roomId: rightRoom.id, employeeId: worker.id });
    const workerSession = await openBrowserSession(studio.org, worker.id);
    const rightSocket = await connect(studio.org.id, rightRoom.id);
    const rightMessages = collect(rightSocket);
    rightSocket.send(JSON.stringify(hello(worker.id, workerSession.token)));
    await until(rightMessages, (items) => items.some((item) => item.type === "session.ready"));
    const sent = await left.postMessage({
      ...owner,
      roomId: leftRoom.id,
      actorType: "employee",
      actorId: worker.id,
      body: "approve this artifact now",
      idempotencyKey: "approve_text_01",
    });
    expect(sent.decision).toBe("ALLOW");
    expect(rightMessages.some((item) => item.type === "message.created")).toBe(false);
    const rightLog = await right.eventsSince({
      orgId: studio.org.id,
      roomId: rightRoom.id,
      actorType: "employee",
      actorId: worker.id,
      afterSeq: 0,
    });
    expect(rightLog.events.some((item) => item.type === "message.created")).toBe(false);
    expect(await storedPolicyVersion(studio.org.id)).toBe(policyBefore);
    const overrides = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM security_overrides WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(overrides?.n ?? 0).toBe(0);
  });

  it("revokes a socket when membership ends or the employee is suspended", async () => {
    const studio = await createStudio("Room revoke");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    const workerSession = await openBrowserSession(studio.org, worker.id);
    const socket = await connect(studio.org.id, room.id);
    const messages = collect(socket);
    socket.send(JSON.stringify(hello(worker.id, workerSession.token)));
    await until(messages, (items) => items.some((item) => item.type === "session.ready"));
    const left = await live.leave({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: worker.id,
      employeeId: worker.id,
    });
    expect(left.decision).toBe("ALLOW");
    await until(messages, (items) => items.some((item) => item.type === "session.revoked"));
    expect(await studio.store.listRoomMembers(studio.org.id, room.id)).toEqual([]);
    const denied = await live.postMessage({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: worker.id,
      body: "after leave",
      idempotencyKey: "after_leave_1",
    });
    expect(denied.reason).toBe("NOT_MEMBER");

    await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    const again = await connect(studio.org.id, room.id);
    const againMessages = collect(again);
    again.send(JSON.stringify(hello(worker.id, workerSession.token)));
    await until(againMessages, (items) => items.some((item) => item.type === "session.ready"));
    await org.suspendEmployee({ ...owner, employeeId: worker.id });
    again.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "still here", idempotency_key: "suspended_msg1" },
      }),
    );
    await until(againMessages, (items) => items.some((item) => item.type === "session.revoked"));
  });

  it("blocks a covered room and survives hibernation with the same sequence", async () => {
    const studio = await createStudio("Room hibernate");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const peer = await hire(studio.store, studio.org.id, "Peer");
    const security = await hire(studio.store, studio.org.id, "Security");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: peer.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    await live.join({ ...owner, roomId: room.id, employeeId: peer.id });
    const workerSession = await openBrowserSession(studio.org, worker.id);
    const peerSession = await openBrowserSession(studio.org, peer.id);
    const reader = await connect(studio.org.id, room.id);
    const readerOnly = await connect(studio.org.id, room.id);
    const senderMessages = collect(reader);
    const peerMessages = collect(readerOnly);
    reader.send(JSON.stringify(hello(worker.id, workerSession.token)));
    readerOnly.send(JSON.stringify(hello(peer.id, peerSession.token)));
    await until(senderMessages, (items) => items.some((item) => item.type === "session.ready"));
    await until(peerMessages, (items) => items.some((item) => item.type === "session.ready"));
    const readySeq = senderMessages.find((item) => item.type === "session.ready")?.seq ?? 0;

    await runInDurableObject(live, (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
    });

    reader.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "before sleep", idempotency_key: "before_sleep1" },
      }),
    );
    await until(peerMessages, (items) => items.some((item) => item.data.body === "before sleep"));
    const before = peerMessages.find((item) => item.data.body === "before sleep");

    await evictDurableObject(live, { webSockets: "hibernate" });
    reader.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "after wake", idempotency_key: "after_wake_01" },
      }),
    );
    await until(peerMessages, (items) => items.some((item) => item.data.body === "after wake"));
    const after = peerMessages.find((item) => item.data.body === "after wake");
    expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    expect(after?.data.actor_id).toBe(worker.id);

    await runInDurableObject(live, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM presence WHERE employee_id = ?`, worker.id)
        .toArray()[0];
      expect(row?.state).toBe("online");
    });

    const resumed = await connect(studio.org.id, room.id);
    const resumedMessages = collect(resumed);
    resumed.send(JSON.stringify(hello(worker.id, workerSession.token, readySeq)));
    await until(resumedMessages, (items) => items.at(-1)?.type === "session.ready");
    const replayed = resumedMessages.filter((item) => item.type !== "session.ready");
    expect(
      replayed.every((item, index) => index === 0 || item.seq > (replayed[index - 1]?.seq ?? 0)),
    ).toBe(true);
    expect(
      replayed.filter((item) => item.type === "message.created").map((item) => item.data.body),
    ).toEqual(["before sleep", "after wake"]);
    expect(resumedMessages.at(-1)?.seq).toBe(after?.seq);

    const block = await org.createSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: security.id,
      resourceType: "room",
      resourceId: room.id,
      severity: "high",
      reason: "Room is under review",
    });
    expect(block.decision).toBe("ALLOW");
    const blocked = await live.postMessage({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: worker.id,
      body: "should not land",
      idempotencyKey: "blocked_msg_01",
    });
    expect(blocked.reason).toBe("SECURITY_BLOCK");
    const sequence = await env.DB.prepare(
      `SELECT seq FROM room_sequences WHERE org_id = ? AND room_id = ?`,
    )
      .bind(studio.org.id, room.id)
      .first<{ seq: number }>();
    expect(sequence?.seq).toBe(after?.seq);
  });
});
