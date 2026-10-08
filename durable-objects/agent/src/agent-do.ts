import { DurableObject } from "cloudflare:workers";
import { createId, isId, randomSecret, sameSecret, sha256Hex } from "@ai-company/domain";
import type { OrganizationDO } from "@ai-company/organization";
import {
  agentEnvelope,
  inboxIdFrom,
  isKnownAgentType,
  parseAgentMessage,
  sessionToken,
  type AgentData,
  type AgentEnvelope,
} from "./protocol";

interface AgentEnv {
  DB: D1Database;
  ORGANIZATION: DurableObjectNamespace<OrganizationDO>;
}

type ActorType = "human" | "employee";

export interface RedeemCommand {
  orgId: string;
  employeeId: string;
  code: string;
}

export interface RedeemResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  sessionId: string | null;
  token: string | null;
  expiresAt: string | null;
}

export interface SessionCheck {
  decision: "ALLOW" | "DENY";
  reason: string;
  sessionId: string | null;
}

export interface SessionScopeCommand {
  orgId: string;
  employeeId: string;
  scope: string;
}

export interface VerifyCommand extends SessionScopeCommand {
  token: string;
}

export interface SessionOpenCommand extends SessionScopeCommand {
  sessionId: string;
}

export interface AgentSnapshot {
  decision: "ALLOW" | "DENY";
  reason: string;
  reachability: string;
  availability: string;
  wakeMode: string;
  sessionId: string | null;
  currentTaskId: string | null;
  pending: number;
}

export interface InboxCommand {
  orgId: string;
  employeeId: string;
  type: string;
  taskId: string | null;
  roomId: string | null;
  priority: number;
  body: string;
  idempotencyKey: string;
}

export interface InboxResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  inboxId: string | null;
  state: string | null;
  duplicate: boolean;
}

export interface RevokeSessionCommand {
  orgId: string;
  actorType: ActorType;
  actorId: string;
  sessionId: string;
}

export interface DropSessionCommand {
  orgId: string;
  employeeId: string;
  sessionId: string;
}

export interface SweepCommand {
  orgId: string;
  employeeId: string;
  before: string;
}

export interface SweepResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  expired: number;
}

interface BoundAgent {
  orgId: string;
  employeeId: string;
}

type SessionRow = {
  id: string;
  binding_id: string;
  token_hash: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
};

type InboxRow = {
  id: string;
  type: string;
  task_id: string | null;
  room_id: string | null;
  priority: number;
  state: string;
  body: string;
};

type MetaRow = {
  reachability: string;
  availability: string;
  wake_mode: string;
  current_task_id: string | null;
};

interface SocketAttachment {
  sessionId: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LEASE_MS = 30_000;

function deny(reason: string): SessionCheck {
  return { decision: "DENY", reason, sessionId: null };
}

export class AgentDO extends DurableObject<AgentEnv> {
  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json(
        { error: { code: "UPGRADE_REQUIRED", message: "WebSocket upgrade is required." } },
        { status: 426 },
      );
    }
    const bound = this.bound();
    if (!bound || !(await this.employeeExists(bound))) {
      return Response.json(
        { error: { code: "TENANT_BOUNDARY", message: "Employee was not found." } },
        { status: 404 },
      );
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async redeem(command: RedeemCommand): Promise<RedeemResult> {
    if (!this.same(command.orgId, command.employeeId)) {
      return redeemDeny("TENANT_BOUNDARY");
    }
    const consumed = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).consumeJoinCode(
      command,
    );
    if (consumed.decision !== "ALLOW" || !consumed.joinId) {
      return redeemDeny(consumed.reason);
    }
    const bindingId = await this.ensureBinding(command.orgId, command.employeeId);
    if (!bindingId) {
      return redeemDeny("TENANT_BOUNDARY");
    }
    const token = randomSecret();
    const tokenHash = await sha256Hex(token);
    const sessionId = createId("ses");
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const scopes = JSON.stringify(consumed.scopes);
    const previous = this.replaceSession({
      sessionId,
      bindingId,
      tokenHash,
      scopes,
      issuedAt,
      expiresAt,
    });
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE runtime_sessions
           SET revoked_at = ?
           WHERE org_id = ? AND employee_id = ? AND revoked_at IS NULL`,
        ).bind(issuedAt, command.orgId, command.employeeId),
        this.env.DB.prepare(
          `INSERT INTO runtime_sessions (
            id, org_id, employee_id, runtime_binding_id, token_hash, scopes, issued_at, expires_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).bind(
          sessionId,
          command.orgId,
          command.employeeId,
          bindingId,
          tokenHash,
          scopes,
          issuedAt,
          expiresAt,
        ),
      ]);
    } catch (error) {
      this.restoreSessions(previous, sessionId);
      throw error;
    }
    return { decision: "ALLOW", reason: "ALLOWED", sessionId, token, expiresAt };
  }

  async verify(command: VerifyCommand): Promise<SessionCheck> {
    if (!this.same(command.orgId, command.employeeId)) {
      return deny("TENANT_BOUNDARY");
    }
    if (!/^[0-9a-f]{64}$/.test(command.token)) {
      return deny("SESSION_INVALID");
    }
    const hash = await sha256Hex(command.token);
    const row = this.sessionByHash(hash);
    if (!row || !sameSecret(row.token_hash, hash)) {
      return deny("SESSION_INVALID");
    }
    return this.acceptSession(command.orgId, command.employeeId, row, command.scope);
  }

  async sessionOpen(command: SessionOpenCommand): Promise<SessionCheck> {
    if (!this.same(command.orgId, command.employeeId) || !isId(command.sessionId, "ses")) {
      return deny("TENANT_BOUNDARY");
    }
    const row = this.sessionById(command.sessionId);
    if (!row) {
      return deny("SESSION_INVALID");
    }
    return this.acceptSession(command.orgId, command.employeeId, row, command.scope);
  }

  async snapshot(command: { orgId: string; employeeId: string }): Promise<AgentSnapshot> {
    if (!this.same(command.orgId, command.employeeId)) {
      return emptySnapshot("TENANT_BOUNDARY");
    }
    this.ctx.storage.transactionSync(() => {
      this.ensureMeta(command.orgId, command.employeeId);
    });
    const meta = this.meta();
    const session = this.activeSession();
    return {
      decision: "ALLOW",
      reason: "ALLOWED",
      reachability: meta?.reachability ?? "UNREACHABLE",
      availability: meta?.availability ?? "OFFLINE",
      wakeMode: meta?.wake_mode ?? "BROWSER",
      sessionId: session?.id ?? null,
      currentTaskId: meta?.current_task_id ?? null,
      pending: this.pendingCount(),
    };
  }

  async enqueue(command: InboxCommand): Promise<InboxResult> {
    if (!this.same(command.orgId, command.employeeId)) {
      return inboxDeny("TENANT_BOUNDARY");
    }
    const body = packetBody(command.body);
    const key = packetKey(command.idempotencyKey);
    const type = packetType(command.type);
    const taskId = command.taskId === null ? null : packetTask(command.taskId);
    const roomId = command.roomId === null ? null : packetRoom(command.roomId);
    if (
      !body ||
      !key ||
      !type ||
      taskId === undefined ||
      roomId === undefined ||
      !Number.isInteger(command.priority) ||
      command.priority < 0 ||
      command.priority > 9
    ) {
      return inboxDeny("INVALID_INPUT");
    }
    let result: InboxResult = inboxDeny("INVALID_INPUT");
    let deliver: InboxRow | null = null;
    this.ctx.storage.transactionSync(() => {
      this.ensureMeta(command.orgId, command.employeeId);
      const existing = this.inboxByKey(key);
      if (existing) {
        result = {
          decision: "ALLOW",
          reason: "ALLOWED",
          inboxId: existing.id,
          state: existing.state,
          duplicate: true,
        };
        return;
      }
      const inboxId = createId("inb");
      const at = new Date().toISOString();
      const sockets = this.openSockets();
      const state = sockets.length > 0 ? "DELIVERED" : "QUEUED";
      const deliveredAt = state === "DELIVERED" ? at : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO inbox (
          id, type, task_id, room_id, priority, state, body, idempotency_key, created_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        inboxId,
        type,
        taskId,
        roomId,
        command.priority,
        state,
        body,
        key,
        at,
        deliveredAt,
      );
      result = {
        decision: "ALLOW",
        reason: "ALLOWED",
        inboxId,
        state,
        duplicate: false,
      };
      if (state === "DELIVERED") {
        deliver = {
          id: inboxId,
          type,
          task_id: taskId,
          room_id: roomId,
          priority: command.priority,
          state,
          body,
        };
      }
    });
    if (deliver) {
      this.broadcast(agentEnvelope("inbox.delivered", inboxData(deliver)));
    }
    return result;
  }

  async revokeSession(command: RevokeSessionCommand): Promise<SessionCheck> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId || !isId(command.sessionId, "ses")) {
      return deny("TENANT_BOUNDARY");
    }
    const decision = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).authorize({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      action: "runtime.revoke",
      resourceType: "employee",
      resourceId: bound.employeeId,
    });
    if (decision.decision === "DENY") {
      return deny(decision.reason);
    }
    return this.dropSession({
      orgId: bound.orgId,
      employeeId: bound.employeeId,
      sessionId: command.sessionId,
    });
  }

  async dropSession(command: DropSessionCommand): Promise<SessionCheck> {
    if (!this.same(command.orgId, command.employeeId) || !isId(command.sessionId, "ses")) {
      return deny("TENANT_BOUNDARY");
    }
    const at = new Date().toISOString();
    const found = this.markRevoked(command.sessionId, at);
    if (!found) {
      return deny("TENANT_BOUNDARY");
    }
    await this.env.DB.prepare(
      `UPDATE runtime_sessions
       SET revoked_at = ?
       WHERE org_id = ? AND id = ? AND revoked_at IS NULL`,
    )
      .bind(at, command.orgId, command.sessionId)
      .run();
    this.closeSockets("SESSION_REVOKED");
    return { decision: "ALLOW", reason: "ALLOWED", sessionId: command.sessionId };
  }

  async sweep(command: SweepCommand): Promise<SweepResult> {
    if (!this.same(command.orgId, command.employeeId) || Number.isNaN(Date.parse(command.before))) {
      return { decision: "DENY", reason: "INVALID_INPUT", expired: 0 };
    }
    let expired = 0;
    this.ctx.storage.transactionSync(() => {
      this.ensureMeta(command.orgId, command.employeeId);
      const rows = this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM inbox WHERE state = 'DELIVERED' AND delivered_at < ?`,
          command.before,
        )
        .toArray();
      for (const row of rows) {
        this.ctx.storage.sql.exec(`UPDATE inbox SET state = 'EXPIRED' WHERE id = ?`, row.id);
      }
      expired = rows.length;
      if (expired > 0) {
        this.ctx.storage.sql.exec(`UPDATE meta SET availability = 'DEGRADED'`);
      }
    });
    return { decision: "ALLOW", reason: "ALLOWED", expired };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.send(
        ws,
        agentEnvelope("error", { code: "INVALID_INPUT", message: "Message is not valid." }),
      );
      return;
    }
    const parsed = parseAgentMessage(message);
    if (!parsed) {
      this.send(
        ws,
        agentEnvelope("error", { code: "INVALID_INPUT", message: "Message is not valid." }),
      );
      return;
    }
    if (!isKnownAgentType(parsed.type)) {
      this.send(
        ws,
        agentEnvelope("error", { code: "UNKNOWN_TYPE", message: "Message type is not supported." }),
      );
      return;
    }
    if (parsed.type === "ping") {
      this.send(ws, agentEnvelope("pong", {}));
      return;
    }
    const bound = this.bound();
    if (!bound) {
      this.send(
        ws,
        agentEnvelope("error", { code: "TENANT_BOUNDARY", message: "Employee was not found." }),
      );
      return;
    }
    if (parsed.type === "session.hello") {
      await this.hello(ws, bound, parsed.data);
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      this.send(
        ws,
        agentEnvelope("error", { code: "NOT_READY", message: "Session hello is required." }),
      );
      return;
    }
    const live = await this.sessionOpen({
      ...bound,
      sessionId: attachment.sessionId,
      scope: "",
    });
    if (live.decision === "DENY") {
      this.closeSockets(live.reason);
      return;
    }
    if (parsed.type === "heartbeat") {
      this.heartbeat(ws);
      return;
    }
    const inboxId = inboxIdFrom(parsed.data);
    if (!inboxId) {
      this.send(
        ws,
        agentEnvelope("error", { code: "INVALID_INPUT", message: "Inbox item is not valid." }),
      );
      return;
    }
    this.acknowledge(ws, inboxId);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (!readAttachment(ws)) {
      return;
    }
    if (this.openSockets().some((socket) => socket !== ws)) {
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE meta SET reachability = 'UNREACHABLE', availability = 'OFFLINE'`,
    );
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    console.log(JSON.stringify({ level: "error", name: "WebSocketError" }));
    ws.close(1011, "error");
  }

  private async hello(
    ws: WebSocket,
    bound: BoundAgent,
    data: Record<string, unknown>,
  ): Promise<void> {
    const token = sessionToken(data);
    if (!token) {
      this.send(
        ws,
        agentEnvelope("error", { code: "SESSION_INVALID", message: "Session was rejected." }),
      );
      return;
    }
    const checked = await this.verify({ ...bound, token, scope: "" });
    if (checked.decision === "DENY" || !checked.sessionId) {
      if (checked.reason === "SUSPENDED_AGENT_DENY") {
        this.send(ws, agentEnvelope("session.revoked", { reason: checked.reason }));
        ws.close(4001, "session.revoked");
        return;
      }
      this.send(
        ws,
        agentEnvelope("error", { code: checked.reason, message: "Session was rejected." }),
      );
      return;
    }
    const now = new Date().toISOString();
    const meta = this.meta();
    const availability = meta?.current_task_id ? "BUSY" : "IDLE";
    this.ctx.storage.sql.exec(
      `UPDATE meta
       SET reachability = 'BROWSER_CONNECTED', availability = ?, last_seen = ?, wake_mode = 'BROWSER'`,
      availability,
      now,
    );
    ws.serializeAttachment({ sessionId: checked.sessionId } satisfies SocketAttachment);
    this.catchUp(ws, now);
    const current = this.meta();
    this.send(
      ws,
      agentEnvelope("session.ready", {
        session_id: checked.sessionId,
        reachability: current?.reachability ?? "BROWSER_CONNECTED",
        availability: current?.availability ?? availability,
      }),
    );
  }

  private heartbeat(ws: WebSocket): void {
    const now = Date.now();
    const seen = new Date(now).toISOString();
    const leaseUntil = new Date(now + LEASE_MS).toISOString();
    const meta = this.meta();
    const availability =
      meta?.availability === "DEGRADED" ? "DEGRADED" : meta?.current_task_id ? "BUSY" : "IDLE";
    this.ctx.storage.sql.exec(
      `UPDATE meta SET last_seen = ?, last_heartbeat = ?, lease_until = ?, availability = ?`,
      seen,
      seen,
      leaseUntil,
      availability,
    );
    this.send(ws, agentEnvelope("heartbeat.ack", { lease_until: leaseUntil }));
  }

  private acknowledge(ws: WebSocket, inboxId: string): void {
    let row: InboxRow | null = null;
    this.ctx.storage.transactionSync(() => {
      const current = this.inboxById(inboxId);
      if (!current || (current.state !== "DELIVERED" && current.state !== "ACKNOWLEDGED")) {
        return;
      }
      if (current.state === "DELIVERED") {
        const at = new Date().toISOString();
        this.ctx.storage.sql.exec(
          `UPDATE inbox SET state = 'ACKNOWLEDGED', acknowledged_at = ? WHERE id = ?`,
          at,
          inboxId,
        );
        if (current.type === "task" && current.task_id) {
          this.ctx.storage.sql.exec(
            `UPDATE meta SET current_task_id = ?, availability = 'BUSY'`,
            current.task_id,
          );
        }
      }
      row = { ...current, state: "ACKNOWLEDGED" };
    });
    if (!row) {
      this.send(
        ws,
        agentEnvelope("error", { code: "NOT_DELIVERED", message: "Inbox item is not delivered." }),
      );
      return;
    }
    const acked: InboxRow = row;
    this.send(ws, agentEnvelope("inbox.acknowledged", inboxData(acked)));
  }

  private catchUp(ws: WebSocket, now: string): void {
    const rows = this.ctx.storage.sql
      .exec<InboxRow>(
        `SELECT id, type, task_id, room_id, priority, state, body
         FROM inbox
         WHERE state IN ('QUEUED', 'DELIVERED')
         ORDER BY priority DESC, created_at ASC`,
      )
      .toArray();
    for (const row of rows) {
      if (row.state === "QUEUED") {
        this.ctx.storage.sql.exec(
          `UPDATE inbox SET state = 'DELIVERED', delivered_at = ? WHERE id = ? AND state = 'QUEUED'`,
          now,
          row.id,
        );
      }
      this.send(ws, agentEnvelope("inbox.delivered", inboxData({ ...row, state: "DELIVERED" })));
    }
  }

  private async acceptSession(
    orgId: string,
    employeeId: string,
    row: SessionRow,
    scope: string,
  ): Promise<SessionCheck> {
    const now = new Date().toISOString();
    if (row.revoked_at) {
      return deny("SESSION_REVOKED");
    }
    if (row.expires_at <= now) {
      return deny("SESSION_EXPIRED");
    }
    if (scope && !parseScopes(row.scopes).includes(scope)) {
      return deny("NO_SCOPE");
    }
    const linked = await this.env.DB.prepare(
      `SELECT e.status AS employee_status, b.status AS binding_status
       FROM employees e
       JOIN runtime_bindings b ON b.org_id = e.org_id AND b.id = ?
       WHERE e.org_id = ? AND e.id = ?`,
    )
      .bind(row.binding_id, orgId, employeeId)
      .first<{ employee_status: string; binding_status: string }>();
    if (!linked || linked.binding_status !== "active") {
      return deny("SESSION_REVOKED");
    }
    if (linked.employee_status === "suspended") {
      return deny("SUSPENDED_AGENT_DENY");
    }
    this.ctx.storage.sql.exec(`UPDATE meta SET last_seen = ?`, now);
    return { decision: "ALLOW", reason: "ALLOWED", sessionId: row.id };
  }

  private replaceSession(input: {
    sessionId: string;
    bindingId: string;
    tokenHash: string;
    scopes: string;
    issuedAt: string;
    expiresAt: string;
  }): string[] {
    const previous: string[] = [];
    this.ctx.storage.transactionSync(() => {
      this.ensureMetaFromSession(input.issuedAt);
      for (const row of this.ctx.storage.sql
        .exec<{ id: string }>(`SELECT id FROM sessions WHERE revoked_at IS NULL`)
        .toArray()) {
        previous.push(row.id);
      }
      if (previous.length > 0) {
        this.ctx.storage.sql.exec(
          `UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL`,
          input.issuedAt,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (id, binding_id, token_hash, scopes, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        input.sessionId,
        input.bindingId,
        input.tokenHash,
        input.scopes,
        input.issuedAt,
        input.expiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE meta SET wake_mode = 'BROWSER', last_seen = ?`,
        input.issuedAt,
      );
    });
    return previous;
  }

  private restoreSessions(previous: string[], sessionId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId);
      for (const id of previous) {
        this.ctx.storage.sql.exec(`UPDATE sessions SET revoked_at = NULL WHERE id = ?`, id);
      }
    });
  }

  private markRevoked(sessionId: string, at: string): boolean {
    let found = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.sessionById(sessionId);
      if (!row) {
        return;
      }
      found = true;
      if (!row.revoked_at) {
        this.ctx.storage.sql.exec(`UPDATE sessions SET revoked_at = ? WHERE id = ?`, at, sessionId);
      }
      this.ctx.storage.sql.exec(
        `UPDATE meta SET reachability = 'UNREACHABLE', availability = 'OFFLINE'`,
      );
    });
    return found;
  }

  private async ensureBinding(orgId: string, employeeId: string): Promise<string | null> {
    const existing = await this.env.DB.prepare(
      `SELECT id FROM runtime_bindings WHERE org_id = ? AND employee_id = ? AND status = 'active'`,
    )
      .bind(orgId, employeeId)
      .first<{ id: string }>();
    if (existing) {
      return existing.id;
    }
    const id = createId("rb");
    const createdAt = new Date().toISOString();
    try {
      await this.env.DB.prepare(
        `INSERT INTO runtime_bindings (
          id, org_id, employee_id, runtime_type, adapter_type, external_ref, status, created_at, revoked_at
        ) VALUES (?, ?, ?, 'BROWSER', 'browser', NULL, 'active', ?, NULL)`,
      )
        .bind(id, orgId, employeeId, createdAt)
        .run();
      return id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("TENANT_MISMATCH")) {
        return null;
      }
      if (message.includes("runtime_bindings")) {
        const again = await this.env.DB.prepare(
          `SELECT id FROM runtime_bindings WHERE org_id = ? AND employee_id = ? AND status = 'active'`,
        )
          .bind(orgId, employeeId)
          .first<{ id: string }>();
        return again?.id ?? null;
      }
      throw error;
    }
  }

  private async employeeExists(bound: BoundAgent): Promise<boolean> {
    const row = await this.env.DB.prepare(`SELECT id FROM employees WHERE org_id = ? AND id = ?`)
      .bind(bound.orgId, bound.employeeId)
      .first<{ id: string }>();
    return row !== null;
  }

  private bound(): BoundAgent | null {
    const name = this.ctx.id.name ?? "";
    const prefix = "agent:";
    if (!name.startsWith(prefix)) {
      return null;
    }
    const rest = name.slice(prefix.length);
    const splitAt = rest.indexOf(":");
    if (splitAt < 0) {
      return null;
    }
    const orgId = rest.slice(0, splitAt);
    const employeeId = rest.slice(splitAt + 1);
    if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
      return null;
    }
    return { orgId, employeeId };
  }

  private same(orgId: string, employeeId: string): boolean {
    const bound = this.bound();
    return !!bound && bound.orgId === orgId && bound.employeeId === employeeId;
  }

  private ensureSchema(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS meta (
        org_id TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        reachability TEXT NOT NULL,
        availability TEXT NOT NULL,
        wake_mode TEXT NOT NULL,
        last_seen TEXT,
        last_heartbeat TEXT,
        lease_until TEXT,
        current_task_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash ON sessions (token_hash)`,
      `CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        task_id TEXT,
        room_id TEXT,
        priority INTEGER NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS inbox_key
        ON inbox (idempotency_key)
        WHERE idempotency_key IS NOT NULL`,
    ];
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  private ensureMeta(orgId: string, employeeId: string): void {
    if (this.meta()) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (
        org_id, employee_id, reachability, availability, wake_mode, last_seen, last_heartbeat, lease_until, current_task_id
      ) VALUES (?, ?, 'UNREACHABLE', 'OFFLINE', 'BROWSER', NULL, NULL, NULL, NULL)`,
      orgId,
      employeeId,
    );
  }

  private ensureMetaFromSession(seen: string): void {
    const bound = this.bound();
    if (!bound) {
      return;
    }
    this.ensureMeta(bound.orgId, bound.employeeId);
    this.ctx.storage.sql.exec(`UPDATE meta SET last_seen = ?`, seen);
  }

  private meta(): MetaRow | null {
    return (
      this.ctx.storage.sql
        .exec<MetaRow>(
          `SELECT reachability, availability, wake_mode, current_task_id FROM meta LIMIT 1`,
        )
        .toArray()[0] ?? null
    );
  }

  private sessionByHash(hash: string): SessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT id, binding_id, token_hash, scopes, expires_at, revoked_at
           FROM sessions WHERE token_hash = ?`,
          hash,
        )
        .toArray()[0] ?? null
    );
  }

  private sessionById(id: string): SessionRow | null {
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT id, binding_id, token_hash, scopes, expires_at, revoked_at
           FROM sessions WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private activeSession(): SessionRow | null {
    const now = new Date().toISOString();
    return (
      this.ctx.storage.sql
        .exec<SessionRow>(
          `SELECT id, binding_id, token_hash, scopes, expires_at, revoked_at
           FROM sessions
           WHERE revoked_at IS NULL AND expires_at > ?
           ORDER BY issued_at DESC
           LIMIT 1`,
          now,
        )
        .toArray()[0] ?? null
    );
  }

  private inboxByKey(key: string): InboxRow | null {
    return (
      this.ctx.storage.sql
        .exec<InboxRow>(
          `SELECT id, type, task_id, room_id, priority, state, body
           FROM inbox WHERE idempotency_key = ?`,
          key,
        )
        .toArray()[0] ?? null
    );
  }

  private inboxById(id: string): InboxRow | null {
    return (
      this.ctx.storage.sql
        .exec<InboxRow>(
          `SELECT id, type, task_id, room_id, priority, state, body FROM inbox WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private pendingCount(): number {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox WHERE state IN ('QUEUED', 'DELIVERED')`)
      .toArray()[0];
    return row?.n ?? 0;
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private closeSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, agentEnvelope("session.revoked", { reason }));
      socket.close(4001, "session.revoked");
    }
  }

  private broadcast(event: AgentEnvelope): void {
    const text = JSON.stringify(event);
    for (const socket of this.openSockets()) {
      socket.send(text);
    }
  }

  private send(ws: WebSocket, event: AgentEnvelope): void {
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return;
    }
    ws.send(JSON.stringify(event));
  }
}

function redeemDeny(reason: string): RedeemResult {
  return { decision: "DENY", reason, sessionId: null, token: null, expiresAt: null };
}

function inboxDeny(reason: string): InboxResult {
  return { decision: "DENY", reason, inboxId: null, state: null, duplicate: false };
}

function emptySnapshot(reason: string): AgentSnapshot {
  return {
    decision: "DENY",
    reason,
    reachability: "UNREACHABLE",
    availability: "OFFLINE",
    wakeMode: "BROWSER",
    sessionId: null,
    currentTaskId: null,
    pending: 0,
  };
}

function inboxData(row: InboxRow): AgentData {
  return {
    inbox_id: row.id,
    type: row.type,
    task_id: row.task_id,
    room_id: row.room_id,
    priority: row.priority,
    state: row.state,
    body: row.body,
  };
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function packetBody(value: string): string | null {
  const body = value.trim();
  if (body.length < 1 || body.length > 4000) {
    return null;
  }
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10) {
      return null;
    }
  }
  return body;
}

function packetKey(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    return null;
  }
  return value;
}

function packetType(value: string): string | null {
  if (!/^[a-z_]{1,40}$/.test(value)) {
    return null;
  }
  return value;
}

function packetTask(value: string): string | null | undefined {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    return undefined;
  }
  return value;
}

function packetRoom(value: string): string | null | undefined {
  if (!isId(value, "room")) {
    return undefined;
  }
  return value;
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object") {
    return null;
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || !isId(sessionId, "ses")) {
    return null;
  }
  return { sessionId };
}
