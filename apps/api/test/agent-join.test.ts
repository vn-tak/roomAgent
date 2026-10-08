import { BrowserAgentAdapter } from "@ai-company/agent";
import type { FoundationStore } from "@ai-company/db";
import type { Organization, Role } from "@ai-company/domain";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { agentStub, createStudio, hire, organizationStub, roomStub } from "./helpers";

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

function issue(org: Organization, employeeId: string, ttlSeconds = 600, scopes = ["room.read"]) {
  return organizationStub(org.id).issueJoinCode({
    ...ownerOf(org),
    employeeId,
    scopes,
    ttlSeconds,
  });
}

function postJoin(orgId: string, employeeId: string, code: string) {
  return exports.default.fetch(`https://company.local/orgs/${orgId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employee_id: employeeId, code }),
  });
}

describe("agent join", () => {
  it("redeems one code and stores only hashes", async () => {
    const studio = await createStudio("Join valid");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const issued = await issue(studio.org, worker.id);
    expect(issued.decision).toBe("ALLOW");
    expect(issued.code).toMatch(/^[0-9a-f]{64}$/);
    const code = issued.code ?? "";

    const response = await postJoin(studio.org.id, worker.id, code);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { session_id: string; token: string };
    expect(body.session_id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token).not.toBe(code);

    const joinColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('join_codes')`,
    ).all<{
      name: string;
    }>();
    expect(joinColumns.results.map((row) => row.name)).not.toContain("code");
    const sessionColumns = await env.DB.prepare(
      `SELECT name FROM pragma_table_info('runtime_sessions')`,
    ).all<{ name: string }>();
    const sessionNames = sessionColumns.results.map((row) => row.name);
    expect(sessionNames).not.toContain("token");
    expect(sessionNames).not.toContain("cookie");
    expect(sessionNames).not.toContain("password");

    const stored = await env.DB.prepare(
      `SELECT code_hash, status FROM join_codes WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, issued.joinId)
      .first<{ code_hash: string; status: string }>();
    expect(stored?.status).toBe("consumed");
    expect(stored?.code_hash).not.toBe(code);
    const session = await env.DB.prepare(
      `SELECT token_hash, runtime_binding_id FROM runtime_sessions WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, body.session_id)
      .first<{ token_hash: string; runtime_binding_id: string }>();
    expect(session?.token_hash).not.toBe(body.token);
    const binding = await env.DB.prepare(
      `SELECT runtime_type, adapter_type, external_ref FROM runtime_bindings WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, session?.runtime_binding_id)
      .first<{ runtime_type: string; adapter_type: string; external_ref: string | null }>();
    expect(binding).toMatchObject({
      runtime_type: "BROWSER",
      adapter_type: "browser",
      external_ref: null,
    });

    await runInDurableObject(organizationStub(studio.org.id), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ code_hash: string }>(`SELECT code_hash FROM join_codes`)
        .toArray();
      expect(rows.some((row) => row.code_hash === code)).toBe(false);
      expect(JSON.stringify(rows)).not.toContain(code);
    });
    await runInDurableObject(agentStub(studio.org.id, worker.id), (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ token_hash: string }>(`SELECT token_hash FROM sessions`)
        .toArray();
      expect(rows.some((row) => row.token_hash === body.token)).toBe(false);
    });

    const again = await postJoin(studio.org.id, worker.id, code);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ error: { code: "ALREADY_USED" } });
  });

  it("rejects expired, revoked, mismatched, and throttled codes", async () => {
    const studio = await createStudio("Join rejects");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const other = await hire(studio.store, studio.org.id, "Other");
    const expired = await issue(studio.org, worker.id, 0);
    const expiredResponse = await postJoin(studio.org.id, worker.id, expired.code ?? "");
    expect(expiredResponse.status).toBe(403);
    expect(await expiredResponse.json()).toMatchObject({ error: { code: "EXPIRED" } });
    expect(await joinStatus(studio.org.id, expired.joinId ?? "")).toBe("expired");

    const revoked = await issue(studio.org, worker.id);
    expect(
      (
        await organizationStub(studio.org.id).revokeJoinCode({
          ...ownerOf(studio.org),
          joinId: revoked.joinId ?? "",
        })
      ).decision,
    ).toBe("ALLOW");
    const revokedResponse = await postJoin(studio.org.id, worker.id, revoked.code ?? "");
    expect(revokedResponse.status).toBe(403);
    expect(await revokedResponse.json()).toMatchObject({ error: { code: "REVOKED" } });

    const mismatched = await issue(studio.org, worker.id);
    const wrongEmployee = await postJoin(studio.org.id, other.id, mismatched.code ?? "");
    expect(wrongEmployee.status).toBe(403);
    expect(await wrongEmployee.json()).toMatchObject({ error: { code: "WRONG_EMPLOYEE" } });
    expect(await joinStatus(studio.org.id, mismatched.joinId ?? "")).toBe("active");

    const outsider = await createStudio("Join other org");
    const foreign = await hire(outsider.store, outsider.org.id, "Foreign");
    const wrongOrg = await postJoin(outsider.org.id, foreign.id, mismatched.code ?? "");
    expect(wrongOrg.status).toBe(403);
    expect(await wrongOrg.json()).toMatchObject({ error: { code: "WRONG_ORG" } });

    const fresh = await createStudio("Join throttle");
    const freshWorker = await hire(fresh.store, fresh.org.id, "Worker");
    const kept = await issue(fresh.org, freshWorker.id);
    for (const digit of ["1", "2", "3", "4", "5"]) {
      const failure = await postJoin(fresh.org.id, freshWorker.id, digit.repeat(64));
      expect(failure.status).toBe(403);
    }
    const throttled = await postJoin(fresh.org.id, freshWorker.id, kept.code ?? "");
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ error: { code: "THROTTLED" } });
    expect(await joinStatus(fresh.org.id, kept.joinId ?? "")).toBe("active");
  });

  it("denies a manager and a suspended employee", async () => {
    const studio = await createStudio("Join authority");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: manager.id,
      roleId: managerRole.id,
    });
    const denied = await organizationStub(studio.org.id).issueJoinCode({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      employeeId: worker.id,
      scopes: ["room.read"],
      ttlSeconds: 600,
    });
    expect(denied).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION", code: null });

    const issued = await issue(studio.org, worker.id);
    await organizationStub(studio.org.id).suspendEmployee({ ...owner, employeeId: worker.id });
    const response = await postJoin(studio.org.id, worker.id, issued.code ?? "");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "SUSPENDED_AGENT_DENY" } });
    expect(await joinStatus(studio.org.id, issued.joinId ?? "")).toBe("active");
  });

  it("keeps one session when the same code is redeemed twice at once", async () => {
    const studio = await createStudio("Join race");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const issued = await issue(studio.org, worker.id);
    const command = {
      orgId: studio.org.id,
      employeeId: worker.id,
      code: issued.code ?? "",
    };
    const [left, right] = await Promise.all([
      agentStub(studio.org.id, worker.id).redeem(command),
      agentStub(studio.org.id, worker.id).redeem(command),
    ]);
    const decisions = [left.decision, right.decision].sort();
    expect(decisions).toEqual(["ALLOW", "DENY"]);
    expect([left.reason, right.reason]).toContain("ALREADY_USED");
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM runtime_sessions WHERE org_id = ? AND employee_id = ?`,
    )
      .bind(studio.org.id, worker.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects a forged room hello and a revoked session", async () => {
    const studio = await createStudio("Join room session");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await roomStub(studio.org.id, room.id).join({
      ...owner,
      roomId: room.id,
      employeeId: worker.id,
    });
    const issued = await issue(studio.org, worker.id, 600, ["room.read", "room.message.send"]);
    const joined = await postJoin(studio.org.id, worker.id, issued.code ?? "");
    const session = (await joined.json()) as { session_id: string; token: string };

    const forged = await connect(studio.org.id, room.id);
    const forgedMessages = collect(forged);
    forged.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: worker.id, token: "a".repeat(64) },
      }),
    );
    await until(forgedMessages, (items) => items.some((item) => item.type === "error"));
    expect(forgedMessages[0]?.data.code).toBe("SESSION_INVALID");
    expect(forgedMessages.some((item) => item.type === "session.ready")).toBe(false);

    const live = await connect(studio.org.id, room.id);
    const messages = collect(live);
    live.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        last_seen_seq: 0,
        data: { employee_id: worker.id, token: session.token },
      }),
    );
    await until(messages, (items) => items.some((item) => item.type === "session.ready"));
    const revoked = await agentStub(studio.org.id, worker.id).revokeSession({
      ...owner,
      sessionId: session.session_id,
    });
    expect(revoked.decision).toBe("ALLOW");
    live.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "after revoke", idempotency_key: "after_revoke1" },
      }),
    );
    await until(messages, (items) => items.some((item) => item.type === "session.revoked"));

    const adapter = new BrowserAgentAdapter(env.AGENT, env.DB);
    await expect(
      adapter.createSession({ orgId: studio.org.id, employeeId: worker.id }),
    ).rejects.toMatchObject({ code: "NO_SESSION" });
  });
});

async function joinStatus(orgId: string, joinId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM join_codes WHERE org_id = ? AND id = ?`)
    .bind(orgId, joinId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function connect(orgId: string, roomId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/rooms/${roomId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Missing WebSocket");
  }
  socket.accept();
  return socket;
}

function collect(socket: WebSocket): Array<{ type: string; data: { code?: string } }> {
  const items: Array<{ type: string; data: { code?: string } }> = [];
  socket.addEventListener("message", (event) => {
    items.push(JSON.parse(String(event.data)) as { type: string; data: { code?: string } });
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
