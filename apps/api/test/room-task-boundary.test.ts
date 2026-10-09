import type { TaskCommand, TaskResult } from "@ai-company/task";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  roomStub,
  taskStub,
} from "./helpers";

interface RoomFrame {
  type: string;
  data: { code?: string; task_id?: string; status?: string };
  seq: number;
}

async function execute(
  orgId: string,
  actorType: TaskCommand["actorType"],
  actorId: string,
  command: TaskCommand["command"],
  taskId: string | null,
  key: string,
  fields: Partial<
    Pick<TaskCommand, "assigneeId" | "title" | "objective" | "roomId" | "completionPolicy">
  > = {},
): Promise<TaskResult> {
  return taskStub(orgId).execute({
    orgId,
    actorType,
    actorId,
    idempotencyKey: key,
    command,
    taskId,
    assigneeId: fields.assigneeId ?? null,
    title: fields.title ?? null,
    objective: fields.objective ?? null,
    roomId: fields.roomId ?? null,
    dependsOn: [],
    ...(fields.completionPolicy ? { completionPolicy: fields.completionPolicy } : {}),
  });
}

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
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

function collect(socket: WebSocket): RoomFrame[] {
  const frames: RoomFrame[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as RoomFrame);
  });
  return frames;
}

async function waitFor(frames: RoomFrame[], ready: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(ready()).toBe(true));
}

describe("canonical task room boundary", () => {
  it("denies ACK, start, and submit from a different room without side effects", async () => {
    const studio = await createStudio("Task room boundary");
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
    const roomA = await studio.store.createRoom(studio.org.id, {
      name: "Room A",
      departmentId: null,
    });
    const roomB = await studio.store.createRoom(studio.org.id, {
      name: "Room B",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, roomA.id, worker.id);
    const session = await openBrowserSession(studio.org, worker.id, ["room.read", "task.accept"]);
    const socket = await connect(studio.org.id, roomA.id);
    const frames = collect(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: worker.id, token: session.token },
      }),
    );
    await waitFor(frames, () => frames.some((frame) => frame.type === "session.ready"));

    const scenarios = [
      { command: "ack" as const, state: "DELIVERED" },
      { command: "start" as const, state: "ACKNOWLEDGED" },
      { command: "submit" as const, state: "WORKING" },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const created = await execute(
        studio.org.id,
        "human",
        studio.org.createdByUserId,
        "create",
        null,
        `boundary_create_${index}`,
        { title: `Task ${index}`, objective: "Run in Room B.", roomId: roomB.id },
      );
      expect(created.decision).toBe("ALLOW");
      const taskId = created.taskId;
      if (!taskId) throw new Error("Task create did not return an id");
      expect(
        (
          await execute(
            studio.org.id,
            "human",
            studio.org.createdByUserId,
            "assign",
            taskId,
            `boundary_assign_${index}`,
            { assigneeId: worker.id },
          )
        ).decision,
      ).toBe("ALLOW");
      expect(
        (
          await execute(
            studio.org.id,
            "human",
            studio.org.createdByUserId,
            "deliver",
            taskId,
            `boundary_deliver_${index}`,
          )
        ).decision,
      ).toBe("ALLOW");
      if (scenario.command !== "ack") {
        expect(
          (
            await execute(
              studio.org.id,
              "employee",
              worker.id,
              "ack",
              taskId,
              `boundary_direct_ack_${index}`,
            )
          ).decision,
        ).toBe("ALLOW");
      }
      if (scenario.command === "submit") {
        expect(
          (
            await execute(
              studio.org.id,
              "employee",
              worker.id,
              "start",
              taskId,
              `boundary_direct_start_${index}`,
            )
          ).decision,
        ).toBe("ALLOW");
      }
      const beforeTask = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(studio.org.id, taskId)
        .first<{ state: string }>();
      expect(beforeTask?.state).toBe(scenario.state);
      await pump();
      const beforeDomain = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>();
      const beforeAudit = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>();
      const beforeRoom = await runInDurableObject(
        roomStub(studio.org.id, roomA.id),
        (_room, state) => ({
          seq:
            state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM meta LIMIT 1`).toArray()[0]
              ?.seq ?? 0,
          taskUpdates:
            state.storage.sql
              .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = 'task.updated'`)
              .toArray()[0]?.n ?? 0,
        }),
      );

      const errorCount = frames.filter((frame) => frame.type === "error").length;
      socket.send(
        JSON.stringify({
          v: 1,
          type: `task.${scenario.command}`,
          data: { task_id: taskId, idempotency_key: `cross_room_${scenario.command}_${index}` },
        }),
      );
      await waitFor(
        frames,
        () =>
          frames.filter((frame) => frame.type === "error").length > errorCount &&
          frames.some((frame) => frame.type === "error" && frame.data.code === "ROOM_MISMATCH"),
      );
      const afterTask = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(studio.org.id, taskId)
        .first<{ state: string }>();
      expect(afterTask?.state).toBe(beforeTask?.state);
      const afterDomain = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>();
      const afterAudit = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>();
      const afterRoom = await runInDurableObject(
        roomStub(studio.org.id, roomA.id),
        (_room, state) => ({
          seq:
            state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM meta LIMIT 1`).toArray()[0]
              ?.seq ?? 0,
          taskUpdates:
            state.storage.sql
              .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = 'task.updated'`)
              .toArray()[0]?.n ?? 0,
        }),
      );
      expect(afterDomain?.n).toBe(beforeDomain?.n);
      expect(afterAudit?.n).toBe(beforeAudit?.n);
      expect(afterRoom).toEqual(beforeRoom);

      if (scenario.command === "ack") {
        const replayAck: TaskCommand = {
          orgId: studio.org.id,
          actorType: "employee",
          actorId: worker.id,
          idempotencyKey: `cross_room_ack_${index}`,
          command: "ack",
          taskId,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
          expectedRoomId: roomB.id,
        };
        expect(await taskStub(studio.org.id).execute(replayAck)).toMatchObject({
          decision: "ALLOW",
          state: "ACKNOWLEDGED",
        });
        await pump();
        const replayDomain = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
        )
          .bind(studio.org.id)
          .first<{ n: number }>();
        const replayAudit = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
        )
          .bind(studio.org.id)
          .first<{ n: number }>();
        const replayRoom = await runInDurableObject(
          roomStub(studio.org.id, roomA.id),
          (_room, state) =>
            state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM meta LIMIT 1`).toArray()[0]
              ?.seq ?? 0,
        );
        const wrongRoomReplay = await taskStub(studio.org.id).execute({
          ...replayAck,
          expectedRoomId: roomA.id,
        });
        expect(wrongRoomReplay).toMatchObject({
          decision: "DENY",
          reason: "ROOM_MISMATCH",
          taskId: null,
          state: null,
          duplicate: false,
        });
        await pump();
        const afterReplayDomain = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`,
        )
          .bind(studio.org.id)
          .first<{ n: number }>();
        const afterReplayAudit = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
        )
          .bind(studio.org.id)
          .first<{ n: number }>();
        const afterReplayRoom = await runInDurableObject(
          roomStub(studio.org.id, roomA.id),
          (_room, state) =>
            state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM meta LIMIT 1`).toArray()[0]
              ?.seq ?? 0,
        );
        expect(afterReplayDomain?.n).toBe(replayDomain?.n);
        expect(afterReplayAudit?.n).toBe(replayAudit?.n);
        expect(afterReplayRoom).toBe(replayRoom);
      }
    }
    socket.close();
  });
});
