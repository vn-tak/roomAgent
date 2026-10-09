import { BrowserAgentAdapter } from "@ai-company/agent";
import type { Organization } from "@ai-company/domain";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentStub, createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

describe("agent inbox", () => {
  it("stays queued until the socket is up and acknowledged after delivery", async () => {
    const studio = await createStudio("Inbox");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const workerRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    const managerRole = await studio.store.getRoleByCode(studio.org.id, "manager");
    if (!workerRole || !managerRole) {
      throw new Error("Missing employee or manager role");
    }
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: worker.id,
      roleId: workerRole.id,
    });
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: manager.id,
      roleId: managerRole.id,
    });
    const issued = await organizationStub(studio.org.id).issueJoinCode({
      ...ownerOf(studio.org),
      employeeId: worker.id,
      scopes: ["room.read", "task.read"],
      ttlSeconds: 600,
    });
    const redeemed = await agentStub(studio.org.id, worker.id).redeem({
      orgId: studio.org.id,
      employeeId: worker.id,
      code: issued.code ?? "",
    });
    const adapter = new BrowserAgentAdapter(env.AGENT, env.DB);
    expect(await adapter.getReachability({ orgId: studio.org.id, employeeId: worker.id })).toBe(
      "UNREACHABLE",
    );
    const created = await taskStub(studio.org.id).execute({
      ...ownerOf(studio.org),
      idempotencyKey: "inbox_task_create1",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Review scene 17",
      objective: "Check the finished scene.",
      roomId: null,
      dependsOn: [],
    });
    expect(created.decision).toBe("ALLOW");
    const taskId = created.taskId;
    if (!taskId) {
      throw new Error("Task was not created");
    }
    const assigned = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      idempotencyKey: "inbox_task_assign1",
      command: "assign",
      taskId,
      assigneeId: worker.id,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(assigned).toMatchObject({ decision: "ALLOW", state: "QUEUED" });
    const deliveryKey = "inbox_task_deliver1";
    const deliveredTask = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      idempotencyKey: deliveryKey,
      command: "deliver",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(deliveredTask).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    const payload = packet(
      taskId,
      deliveryKey,
      JSON.stringify({
        task_id: taskId,
        objective: "Check the finished scene.",
        requested_by: studio.org.createdByUserId,
      }),
    );
    const before = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(before.pending).toBe(1);
    expect(before.reachability).toBe("UNREACHABLE");

    const socket = await connect(studio.org.id, worker.id);
    const messages = collect(socket);
    socket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        data: { token: redeemed.token },
      }),
    );
    await until(
      messages,
      (items) =>
        items.some((item) => item.type === "session.ready") &&
        items.some((item) => item.type === "inbox.delivered"),
    ).catch((error: unknown) => {
      throw new Error(`${String(error)}; observed=${JSON.stringify(messages)}`);
    });
    expect(messages.some((item) => item.type === "inbox.acknowledged")).toBe(false);
    expect(await adapter.getReachability({ orgId: studio.org.id, employeeId: worker.id })).toBe(
      "BROWSER_CONNECTED",
    );

    const live = agentStub(studio.org.id, worker.id);
    await runInDurableObject(live, (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe("ping");
      expect(pair?.response).toBe("pong");
      const row = state.storage.sql
        .exec<{ state: string; acknowledged_at: string | null }>(
          `SELECT state, acknowledged_at FROM inbox`,
        )
        .toArray()[0];
      expect(row?.state).toBe("DELIVERED");
      expect(row?.acknowledged_at).toBeNull();
    });

    const delivered = messages.find((item) => item.type === "inbox.delivered");
    socket.send(
      JSON.stringify({
        v: 1,
        type: "inbox.ack",
        data: { inbox_id: delivered?.data.inbox_id },
      }),
    );
    await until(messages, (items) => items.some((item) => item.type === "inbox.acknowledged"));
    const afterAck = await live.snapshot({ orgId: studio.org.id, employeeId: worker.id });
    expect(afterAck.currentTaskId).toBe(taskId);
    expect(afterAck.availability).toBe("BUSY");
    expect(afterAck.pending).toBe(0);
    const canonicalTask = await env.DB.prepare(
      `SELECT state FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, taskId)
      .first<{ state: string }>();
    expect(canonicalTask?.state).toBe("ACKNOWLEDGED");

    expect(await adapter.deliver({ orgId: studio.org.id, employeeId: worker.id, payload })).toEqual(
      { delivered: false },
    );
    expect((await live.snapshot({ orgId: studio.org.id, employeeId: worker.id })).pending).toBe(0);

    const second = await adapter.deliver({
      orgId: studio.org.id,
      employeeId: worker.id,
      payload: packet(null, "packet_0002", "Review scene 18", "notice"),
    });
    expect(second).toEqual({ delivered: true });
    await runInDurableObject(live, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ state: string }>(`SELECT state FROM inbox WHERE idempotency_key = 'packet_0002'`)
        .toArray()[0];
      expect(row?.state).toBe("DELIVERED");
    });
    const swept = await live.sweep({
      orgId: studio.org.id,
      employeeId: worker.id,
      before: "2999-01-01T00:00:00.000Z",
    });
    expect(swept.expired).toBe(1);
    expect(
      (await live.snapshot({ orgId: studio.org.id, employeeId: worker.id })).availability,
    ).toBe("DEGRADED");

    await evictDurableObject(live, { webSockets: "hibernate" });
    await runInDurableObject(live, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ state: string; idempotency_key: string }>(
          `SELECT state, idempotency_key FROM inbox ORDER BY created_at ASC`,
        )
        .toArray();
      expect(rows.map((row) => row.state)).toEqual(["ACKNOWLEDGED", "EXPIRED"]);
      const meta = state.storage.sql
        .exec<{ current_task_id: string }>(`SELECT current_task_id FROM meta`)
        .toArray()[0];
      expect(meta?.current_task_id).toBe(taskId);
    });
    expect(await adapter.createSession({ orgId: studio.org.id, employeeId: worker.id })).toEqual({
      sessionId: redeemed.sessionId,
    });
    await adapter.revoke({ sessionId: redeemed.sessionId ?? "" });
    await expect(
      adapter.createSession({ orgId: studio.org.id, employeeId: worker.id }),
    ).rejects.toMatchObject({ code: "NO_SESSION" });
  });

  it("retains canonical acceptance before a delayed null-room task enqueue", async () => {
    const studio = await createStudio("Delayed accepted task delivery");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const workerRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    const managerRole = await studio.store.getRoleByCode(studio.org.id, "manager");
    if (!workerRole || !managerRole) {
      throw new Error("Missing employee or manager role");
    }
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: worker.id,
      roleId: workerRole.id,
    });
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: manager.id,
      roleId: managerRole.id,
    });
    const task = await taskStub(studio.org.id).execute({
      ...ownerOf(studio.org),
      idempotencyKey: "delayed_task_create",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Delayed delivery",
      objective: "Delivery arrives after canonical acceptance.",
      roomId: null,
      dependsOn: [],
    });
    const taskId = task.taskId;
    if (task.decision !== "ALLOW" || !taskId) {
      throw new Error("Task was not created");
    }
    const assigned = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      idempotencyKey: "delayed_task_assign",
      command: "assign",
      taskId,
      assigneeId: worker.id,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(assigned).toMatchObject({ decision: "ALLOW", state: "QUEUED" });
    const deliveryKey = "delayed_task_deliver";
    // Model TaskDO having committed ACK while its delivery event is still in flight.
    await env.DB.prepare(
      `UPDATE tasks SET state = 'ACKNOWLEDGED', updated_at = ? WHERE org_id = ? AND id = ?`,
    )
      .bind(new Date().toISOString(), studio.org.id, taskId)
      .run();
    const agent = agentStub(studio.org.id, worker.id);
    const accepted = await agent.applyCanonicalTaskAck({
      orgId: studio.org.id,
      employeeId: worker.id,
      taskId,
      idempotencyKey: "delayed_task_ack1",
    });
    expect(accepted).toEqual({ decision: "ALLOW", reason: "ALLOWED" });
    expect(await agent.snapshot({ orgId: studio.org.id, employeeId: worker.id })).toMatchObject({
      currentTaskId: taskId,
      availability: "BUSY",
      pending: 0,
    });
    const marker = await runInDurableObject(
      agent,
      (_instance, state) =>
        state.storage.sql
          .exec<{ task_id: string; room_id: string | null }>(
            `SELECT task_id, room_id FROM accepted_tasks WHERE task_id = ?`,
            taskId,
          )
          .toArray()[0],
    );
    expect(marker).toEqual({ task_id: taskId, room_id: null });

    const delayedDelivery = await agent.enqueue({
      orgId: studio.org.id,
      employeeId: worker.id,
      type: "task",
      taskId,
      roomId: null,
      priority: 0,
      body: JSON.stringify({
        task_id: taskId,
        objective: "Delivery arrives after canonical acceptance.",
        requested_by: studio.org.createdByUserId,
      }),
      idempotencyKey: deliveryKey,
    });
    expect(delayedDelivery).toMatchObject({ decision: "ALLOW", state: "ACKNOWLEDGED" });
    const projection = await runInDurableObject(agent, (_instance, state) => ({
      row: state.storage.sql
        .exec<{ state: string; acknowledged_at: string | null; room_id: string | null }>(
          `SELECT state, acknowledged_at, room_id FROM inbox WHERE task_id = ?`,
          taskId,
        )
        .toArray()[0],
      markerCount:
        state.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM accepted_tasks WHERE task_id = ?`,
            taskId,
          )
          .toArray()[0]?.count ?? 0,
    }));
    expect(projection.row).toMatchObject({ state: "ACKNOWLEDGED", room_id: null });
    expect(projection.row?.acknowledged_at).not.toBeNull();
    expect(projection.markerCount).toBe(0);
    expect(await agent.snapshot({ orgId: studio.org.id, employeeId: worker.id })).toMatchObject({
      currentTaskId: taskId,
      availability: "BUSY",
      pending: 0,
    });
  });
});

function packet(taskId: string | null, key: string, body: string, type = "task"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      task_id: taskId,
      priority: 1,
      idempotency_key: key,
      body,
    }),
  );
}

async function connect(orgId: string, employeeId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/agents/${employeeId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Missing WebSocket");
  }
  socket.accept();
  return socket;
}

function collect(socket: WebSocket): Array<{ type: string; data: { inbox_id?: string } }> {
  const items: Array<{ type: string; data: { inbox_id?: string } }> = [];
  socket.addEventListener("message", (event) => {
    items.push(JSON.parse(String(event.data)) as { type: string; data: { inbox_id?: string } });
  });
  return items;
}

async function until(
  items: Array<{ type: string }>,
  ready: (items: Array<{ type: string }>) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    expect(ready(items)).toBe(true);
  });
}
