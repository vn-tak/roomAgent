import type { Organization } from "@ai-company/domain";
import type { RoomEnvelope } from "@ai-company/room";
import { exports, env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
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

async function setEmployeeRole(
  store: Awaited<ReturnType<typeof createStudio>>["store"],
  org: Organization,
  employeeId: string,
): Promise<void> {
  const role = await store.getRoleByCode(org.id, "employee");
  if (!role) {
    throw new Error("Missing employee role");
  }
  await organizationStub(org.id).assignRole({ ...ownerOf(org), employeeId, roleId: role.id });
}

async function connect(orgId: string, roomId: string): Promise<WebSocket> {
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

type RoomMessage = RoomEnvelope;

function collect(socket: WebSocket): RoomMessage[] {
  const messages: RoomMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RoomMessage);
  });
  return messages;
}

async function until(messages: RoomMessage[], predicate: (messages: RoomMessage[]) => boolean) {
  await vi.waitFor(() => expect(predicate(messages)).toBe(true));
}

describe("room snapshot and replay recovery", () => {
  it("bootstraps a mature room snapshot and resumes from its head", async () => {
    const studio = await createStudio("Mature room snapshot");
    const author = await hire(studio.store, studio.org.id, "Author");
    const newcomer = await hire(studio.store, studio.org.id, "New member");
    await setEmployeeRole(studio.store, studio.org, author.id);
    await setEmployeeRole(studio.store, studio.org, newcomer.id);
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Mature room",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    await live.join({ ...ownerOf(studio.org), roomId: room.id, employeeId: author.id });

    for (let index = 0; index < 101; index += 1) {
      const posted = await live.postMessage({
        orgId: studio.org.id,
        roomId: room.id,
        actorType: "employee",
        actorId: author.id,
        body: `Message ${index}`,
        idempotencyKey: `snapshot_event_${String(index).padStart(4, "0")}`,
      });
      expect(posted.decision).toBe("ALLOW");
    }

    const task = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "snapshot_task_01",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Open task",
      objective: "Included in the room bootstrap.",
      roomId: room.id,
      dependsOn: [],
    });
    expect(task.decision).toBe("ALLOW");
    const artifactId = "art_snapshot_0001";
    const at = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO artifacts (
         id, org_id, room_id, task_id, creator_type, creator_id,
         canonical_version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'human', ?, 1, ?, ?)`,
    )
      .bind(artifactId, studio.org.id, room.id, task.taskId, studio.org.createdByUserId, at, at)
      .run();

    const authorSession = await openBrowserSession(studio.org, author.id, ["room.read"]);
    const authorSocket = await connect(studio.org.id, room.id);
    const authorMessages = collect(authorSocket);
    const beforePresence = await live.eventsSince({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: author.id,
      afterSeq: 0,
    });
    expect(beforePresence.reason).toBe("RESYNC_REQUIRED");
    const beforeHead = await runHead(live, studio.org.id, room.id, author.id);
    authorSocket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: beforeHead,
        data: { employee_id: author.id, token: authorSession.token },
      }),
    );
    await until(authorMessages, (items) => items.some((item) => item.type === "session.ready"));

    await live.join({ ...ownerOf(studio.org), roomId: room.id, employeeId: newcomer.id });
    const snapshot = await live.snapshot({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: newcomer.id,
    });
    expect(snapshot).toMatchObject({
      decision: "ALLOW",
      roomId: room.id,
      room: { id: room.id, name: "Mature room", status: "active" },
    });
    expect(snapshot.headSeq).toBeGreaterThan(100);
    expect(snapshot.members.map((member) => member.employeeId)).toEqual(
      expect.arrayContaining([author.id, newcomer.id]),
    );
    expect(snapshot.presence).toContainEqual({ employeeId: author.id, state: "online" });
    expect(snapshot.tasks).toContainEqual(
      expect.objectContaining({ id: task.taskId, state: "CREATED", title: "Open task" }),
    );
    expect(snapshot.artifacts).toContainEqual(
      expect.objectContaining({ id: artifactId, taskId: task.taskId, canonicalVersion: 1 }),
    );

    const behindNinetyNine = await live.eventsSince({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: newcomer.id,
      afterSeq: snapshot.headSeq - 99,
    });
    expect(behindNinetyNine.decision).toBe("ALLOW");
    expect(behindNinetyNine.events).toHaveLength(99);
    const tooFarBehind = await live.eventsSince({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: newcomer.id,
      afterSeq: 0,
    });
    expect(tooFarBehind).toMatchObject({ decision: "DENY", reason: "RESYNC_REQUIRED" });

    const newcomerSession = await openBrowserSession(studio.org, newcomer.id, ["room.read"]);
    const newcomerSocket = await connect(studio.org.id, room.id);
    const newcomerMessages = collect(newcomerSocket);
    newcomerSocket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: snapshot.headSeq,
        data: { employee_id: newcomer.id, token: newcomerSession.token },
      }),
    );
    await until(newcomerMessages, (items) => items.some((item) => item.type === "session.ready"));
    expect(newcomerMessages.find((item) => item.type === "session.ready")?.data.replayed).toBe(1);
    newcomerSocket.close();
    authorSocket.close();
  });

  it("denies snapshots to non-members and cross-organization callers", async () => {
    const studio = await createStudio("Snapshot authorization");
    const member = await hire(studio.store, studio.org.id, "Member");
    const outsider = await hire(studio.store, studio.org.id, "Not a member");
    await setEmployeeRole(studio.store, studio.org, member.id);
    await setEmployeeRole(studio.store, studio.org, outsider.id);
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Private room",
      departmentId: null,
    });
    await roomStub(studio.org.id, room.id).join({
      ...ownerOf(studio.org),
      roomId: room.id,
      employeeId: member.id,
    });
    const live = roomStub(studio.org.id, room.id);
    const nonMember = await live.snapshot({
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee",
      actorId: outsider.id,
    });
    expect(nonMember).toMatchObject({ decision: "DENY", reason: "NOT_MEMBER" });

    const other = await createStudio("Other organization");
    const otherRoom = await other.store.createRoom(other.org.id, {
      name: "Foreign room",
      departmentId: null,
    });
    const crossOrg = await live.snapshot({
      orgId: other.org.id,
      roomId: otherRoom.id,
      actorType: "human",
      actorId: other.org.createdByUserId,
    });
    expect(crossOrg).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY" });
  });
});

async function runHead(
  live: ReturnType<typeof roomStub>,
  orgId: string,
  roomId: string,
  employeeId: string,
): Promise<number> {
  const events = await live.eventsSince({
    orgId,
    roomId,
    actorType: "employee",
    actorId: employeeId,
    afterSeq: 0,
  });
  if (events.reason === "RESYNC_REQUIRED") {
    const snapshot = await live.snapshot({
      orgId,
      roomId,
      actorType: "employee",
      actorId: employeeId,
    });
    return snapshot.headSeq;
  }
  return events.seq;
}
