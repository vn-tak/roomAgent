import { BrowserAgentAdapter } from "@ai-company/agent";
import type { Organization } from "@ai-company/domain";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentStub, createStudio, hire, organizationStub } from "./helpers";

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
    const payload = packet("task_demo_01", "packet_0001", "Review scene 17");
    expect(await adapter.deliver({ orgId: studio.org.id, employeeId: worker.id, payload })).toEqual(
      { delivered: false },
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
    );
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
    expect(afterAck.currentTaskId).toBe("task_demo_01");
    expect(afterAck.availability).toBe("BUSY");
    expect(afterAck.pending).toBe(0);

    expect(await adapter.deliver({ orgId: studio.org.id, employeeId: worker.id, payload })).toEqual(
      { delivered: false },
    );
    expect((await live.snapshot({ orgId: studio.org.id, employeeId: worker.id })).pending).toBe(0);

    const second = await adapter.deliver({
      orgId: studio.org.id,
      employeeId: worker.id,
      payload: packet("task_demo_02", "packet_0002", "Review scene 18"),
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
      expect(meta?.current_task_id).toBe("task_demo_01");
    });
    expect(await adapter.createSession({ orgId: studio.org.id, employeeId: worker.id })).toEqual({
      sessionId: redeemed.sessionId,
    });
    await adapter.revoke({ sessionId: redeemed.sessionId ?? "" });
    await expect(
      adapter.createSession({ orgId: studio.org.id, employeeId: worker.id }),
    ).rejects.toMatchObject({ code: "NO_SESSION" });
  });
});

function packet(taskId: string, key: string, body: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "task",
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
