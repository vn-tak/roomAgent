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
  TASK: DurableObjectNamespace;
  TEST_MIGRATIONS?: unknown;
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
  authenticated: boolean;
  authDeadlineAt: number;
  sessionId?: string;
}

interface AuthenticatedSocketAttachment extends SocketAttachment {
  authenticated: true;
  sessionId: string;
}

interface TaskAckCommand {
  orgId: string;
  actorType: "employee";
  actorId: string;
  idempotencyKey: string;
  command: "ack";
  taskId: string;
  assigneeId: null;
  title: null;
  objective: null;
  roomId: null;
  dependsOn: string[];
  expectedRoomId: string | null;
}

interface TaskAckResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  taskId: string | null;
  state: string | null;
}

interface PendingWorkAck {
  [key: string]: string | number | null;
  inbox_id: string;
  task_id: string;
  room_id: string | null;
  idempotency_key: string;
  canonical_acknowledged: number;
  attempts: number;
}

export interface ApplyCanonicalTaskAckCommand {
  orgId: string;
  employeeId: string;
  taskId: string;
  idempotencyKey: string;
}

interface ProjectAcceptedTaskCommand {
  orgId: string;
  employeeId: string;
  roomId: string | null;
  taskId: string;
}

interface AcceptedTaskMarker {
  [key: string]: string | null;
  task_id: string;
  room_id: string | null;
}

export interface WorkAckResult {
  decision: "ALLOW" | "DENY";
  reason: string;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LEASE_MS = 30_000;
const WS_AUTH_TIMEOUT_MS = 10_000;
const WORK_ACK_RETRY_BASE_MS = 1_000;
const WORK_ACK_RETRY_MAX_MS = 60_000;
const ACCEPTED_TASK_STATES = new Set([
  "ACKNOWLEDGED",
  "WORKING",
  "SUBMITTED",
  "REVIEW",
  "REVISION",
  "APPROVED",
  "COMPLETED",
]);

function isAcceptedTaskState(state: string): boolean {
  return ACCEPTED_TASK_STATES.has(state);
}

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
    server.serializeAttachment({
      authenticated: false,
      authDeadlineAt: Date.now() + WS_AUTH_TIMEOUT_MS,
    } satisfies SocketAttachment);
    await this.refreshAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (attachment && !attachment.authenticated && attachment.authDeadlineAt <= now) {
        this.send(
          socket,
          agentEnvelope("error", { code: "AUTH_TIMEOUT", message: "Session hello timed out." }),
        );
        socket.close(4001, "authentication.timeout");
      }
    }
    await this.retryPendingWorkAcks();
    await this.refreshAlarm();
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
    const currentTaskId = this.meta()?.current_task_id;
    if (currentTaskId) {
      const task = await this.env.DB.prepare(
        `SELECT state, assignee_id FROM tasks WHERE org_id = ? AND id = ?`,
      )
        .bind(command.orgId, currentTaskId)
        .first<{ state: string; assignee_id: string | null }>();
      if (
        !task ||
        task.assignee_id !== command.employeeId ||
        ["COMPLETED", "CANCELLED", "FAILED"].includes(task.state)
      ) {
        this.releaseTaskProjection(currentTaskId);
      }
    }
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
    let acknowledged: InboxRow | null = null;
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
      const accepted =
        type === "task" && taskId !== null ? this.acceptedTaskMarker(taskId, roomId) : null;
      const sockets = this.openSockets();
      const state = accepted ? "ACKNOWLEDGED" : sockets.length > 0 ? "DELIVERED" : "QUEUED";
      const deliveredAt = state === "QUEUED" ? null : at;
      this.ctx.storage.sql.exec(
        `INSERT INTO inbox (
          id, type, task_id, room_id, priority, state, body, idempotency_key, created_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        accepted ? at : null,
      );
      if (accepted && taskId) {
        this.ctx.storage.sql.exec(
          `UPDATE meta SET current_task_id = ?, availability = 'BUSY'`,
          taskId,
        );
        this.deleteAcceptedTaskMarker(taskId, roomId);
      }
      result = {
        decision: "ALLOW",
        reason: "ALLOWED",
        inboxId,
        state,
        duplicate: false,
      };
      if (state === "DELIVERED" || state === "ACKNOWLEDGED") {
        const eventRow = {
          id: inboxId,
          type,
          task_id: taskId,
          room_id: roomId,
          priority: command.priority,
          state,
          body,
        };
        if (state === "ACKNOWLEDGED") {
          acknowledged = eventRow;
        } else {
          deliver = eventRow;
        }
      }
    });
    if (acknowledged) {
      this.broadcast(agentEnvelope("inbox.acknowledged", inboxData(acknowledged)));
    }
    if (deliver) {
      this.broadcast(agentEnvelope("inbox.delivered", inboxData(deliver)));
    }
    return result;
  }

  async applyCanonicalTaskAck(command: ApplyCanonicalTaskAckCommand): Promise<WorkAckResult> {
    if (
      !this.same(command.orgId, command.employeeId) ||
      !isId(command.taskId, "task") ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(command.idempotencyKey)
    ) {
      return { decision: "DENY", reason: "TENANT_BOUNDARY" };
    }
    const task = await this.env.DB.prepare(
      `SELECT room_id, state FROM tasks WHERE org_id = ? AND id = ? AND assignee_id = ?`,
    )
      .bind(command.orgId, command.taskId, command.employeeId)
      .first<{ room_id: string | null; state: string }>();
    if (task && ["COMPLETED", "CANCELLED", "FAILED"].includes(task.state)) {
      this.releaseTaskProjection(command.taskId);
      return { decision: "ALLOW", reason: "ALLOWED" };
    }
    if (!task || !isAcceptedTaskState(task.state)) {
      return { decision: "DENY", reason: "TASK_NOT_ACCEPTED" };
    }
    return this.projectAcceptedTask({
      orgId: command.orgId,
      employeeId: command.employeeId,
      taskId: command.taskId,
      roomId: task.room_id,
    });
  }

  private releaseTaskProjection(taskId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM accepted_tasks WHERE task_id = ?`, taskId);
      this.ctx.storage.sql.exec(
        `UPDATE meta SET current_task_id = NULL, availability = 'IDLE' WHERE current_task_id = ?`,
        taskId,
      );
    });
  }

  private async projectAcceptedTask(command: ProjectAcceptedTaskCommand): Promise<WorkAckResult> {
    if (
      !this.same(command.orgId, command.employeeId) ||
      !isId(command.taskId, "task") ||
      (command.roomId !== null && !isId(command.roomId, "room"))
    ) {
      return { decision: "DENY", reason: "TENANT_BOUNDARY" };
    }
    this.ctx.storage.transactionSync(() => {
      this.ensureMeta(command.orgId, command.employeeId);
      this.ctx.storage.sql.exec(
        `INSERT INTO accepted_tasks (task_id, room_id, accepted_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           room_id = excluded.room_id,
           accepted_at = excluded.accepted_at`,
        command.taskId,
        command.roomId,
        new Date().toISOString(),
      );
      this.ctx.storage.sql.exec(
        `UPDATE meta SET current_task_id = ?, availability = 'BUSY'`,
        command.taskId,
      );
    });
    const rows = this.ctx.storage.sql
      .exec<InboxRow>(
        `SELECT id, type, task_id, room_id, priority, state, body FROM inbox
         WHERE type = 'task' AND task_id = ? AND room_id IS ?
           AND state IN ('QUEUED', 'DELIVERED', 'ACKNOWLEDGED')
         ORDER BY created_at, id LIMIT 50`,
        command.taskId,
        command.roomId,
      )
      .toArray();
    for (const row of rows) {
      this.queueWorkAck(row, true);
      try {
        const projected = this.applyWorkAckProjection(row.id);
        if (projected?.changed) {
          this.broadcast(agentEnvelope("inbox.acknowledged", inboxData(projected.row)));
        }
      } catch {
        this.scheduleWorkAckRetry(row.id);
        await this.refreshAlarm();
        return { decision: "DENY", reason: "ACK_PENDING" };
      }
    }
    return { decision: "ALLOW", reason: "ALLOWED" };
  }

  async armProjectionFault(times: number): Promise<{ armed: boolean }> {
    if (!this.testMode() || !Number.isInteger(times) || times < 0 || times > 8) {
      return { armed: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO projection_fault (id, remaining) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining`,
      times,
    );
    return { armed: true };
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
    await this.acknowledge(ws, inboxId);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (!readAttachment(ws)) {
      await this.refreshAlarm();
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
    ws.serializeAttachment({
      authenticated: true,
      authDeadlineAt: 0,
      sessionId: checked.sessionId,
    } satisfies SocketAttachment);
    await this.refreshAlarm();
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

  private async acknowledge(ws: WebSocket, inboxId: string): Promise<void> {
    const row = this.inboxById(inboxId);
    if (!row || (row.state !== "DELIVERED" && row.state !== "ACKNOWLEDGED")) {
      this.send(
        ws,
        agentEnvelope("error", { code: "NOT_DELIVERED", message: "Inbox item is not delivered." }),
      );
      return;
    }
    if (row.type !== "task") {
      const projected = this.applyNonTaskAck(inboxId);
      if (!projected) {
        this.send(
          ws,
          agentEnvelope("error", {
            code: "NOT_DELIVERED",
            message: "Inbox item is not delivered.",
          }),
        );
        return;
      }
      this.send(ws, agentEnvelope("inbox.acknowledged", inboxData(projected)));
      return;
    }
    if (!row.task_id || !isId(row.task_id, "task")) {
      this.send(ws, agentEnvelope("error", { code: "INVALID_INPUT", message: "Task is invalid." }));
      return;
    }
    this.queueWorkAck(row, false);
    await this.refreshAlarm();
    let accepted: TaskAckResult;
    try {
      accepted = await this.executeCanonicalAck(row);
    } catch {
      this.scheduleWorkAckRetry(row.id);
      await this.refreshAlarm();
      this.send(
        ws,
        agentEnvelope("error", { code: "ACK_PENDING", message: "Work acceptance is pending." }),
      );
      return;
    }
    if (accepted.decision !== "ALLOW" || accepted.state !== "ACKNOWLEDGED") {
      this.deletePendingWorkAck(row.id);
      this.send(
        ws,
        agentEnvelope("error", { code: accepted.reason, message: "Work acceptance was rejected." }),
      );
      return;
    }
    this.markCanonicalAck(row.id);
    const projected = this.inboxById(row.id);
    if (projected?.state === "ACKNOWLEDGED") {
      this.send(ws, agentEnvelope("inbox.acknowledged", inboxData(projected)));
    } else {
      this.scheduleWorkAckRetry(row.id);
      await this.refreshAlarm();
      this.send(
        ws,
        agentEnvelope("error", {
          code: "ACK_PENDING",
          message: "Work acceptance is pending projection.",
        }),
      );
    }
  }

  private applyNonTaskAck(inboxId: string): InboxRow | null {
    let result: InboxRow | null = null;
    this.ctx.storage.transactionSync(() => {
      const current = this.inboxById(inboxId);
      if (!current || (current.state !== "DELIVERED" && current.state !== "ACKNOWLEDGED")) {
        return;
      }
      if (current.state === "DELIVERED") {
        this.ctx.storage.sql.exec(
          `UPDATE inbox SET state = 'ACKNOWLEDGED', acknowledged_at = ? WHERE id = ?`,
          new Date().toISOString(),
          inboxId,
        );
      }
      result = { ...current, state: "ACKNOWLEDGED" };
    });
    return result;
  }

  private queueWorkAck(row: InboxRow, canonicalAcknowledged: boolean): void {
    if (!row.task_id) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO work_ack_retries (
         inbox_id, task_id, room_id, idempotency_key, canonical_acknowledged, attempts, next_attempt_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(inbox_id) DO UPDATE SET
         canonical_acknowledged = MAX(work_ack_retries.canonical_acknowledged, excluded.canonical_acknowledged),
         next_attempt_at = excluded.next_attempt_at`,
      row.id,
      row.task_id,
      row.room_id,
      `inbox_work_ack_${row.id}`,
      canonicalAcknowledged ? 1 : 0,
      new Date().toISOString(),
    );
  }

  private async executeCanonicalAck(row: InboxRow): Promise<TaskAckResult> {
    const bound = this.bound();
    if (!bound || !row.task_id) {
      return { decision: "DENY", reason: "TENANT_BOUNDARY", taskId: null, state: null };
    }
    const stub = this.env.TASK.getByName(`tasks:${bound.orgId}`) as unknown as {
      execute(command: TaskAckCommand): Promise<TaskAckResult>;
    };
    return stub.execute({
      orgId: bound.orgId,
      actorType: "employee",
      actorId: bound.employeeId,
      idempotencyKey: `inbox_work_ack_${row.id}`,
      command: "ack",
      taskId: row.task_id,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
      expectedRoomId: row.room_id,
    });
  }

  private markCanonicalAck(inboxId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE work_ack_retries SET canonical_acknowledged = 1, next_attempt_at = ? WHERE inbox_id = ?`,
      new Date().toISOString(),
      inboxId,
    );
  }

  private applyWorkAckProjection(inboxId: string): { row: InboxRow; changed: boolean } | null {
    if (this.consumeProjectionFault()) {
      throw new Error("Injected work acknowledgement projection failure.");
    }
    const bound = this.bound();
    if (!bound) {
      return null;
    }
    let result: { row: InboxRow; changed: boolean } | null = null;
    this.ctx.storage.transactionSync(() => {
      const current = this.inboxById(inboxId);
      if (
        !current ||
        current.type !== "task" ||
        !current.task_id ||
        (current.state !== "QUEUED" &&
          current.state !== "DELIVERED" &&
          current.state !== "ACKNOWLEDGED")
      ) {
        this.deletePendingWorkAck(inboxId);
        return;
      }
      this.ensureMeta(bound.orgId, bound.employeeId);
      const changed = current.state !== "ACKNOWLEDGED";
      if (changed) {
        this.ctx.storage.sql.exec(
          `UPDATE inbox SET state = 'ACKNOWLEDGED', acknowledged_at = ? WHERE id = ?`,
          new Date().toISOString(),
          inboxId,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE meta SET current_task_id = ?, availability = 'BUSY'`,
        current.task_id,
      );
      this.deleteAcceptedTaskMarker(current.task_id, current.room_id);
      this.deletePendingWorkAck(inboxId);
      result = { row: { ...current, state: "ACKNOWLEDGED" }, changed };
    });
    return result;
  }

  private deletePendingWorkAck(inboxId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM work_ack_retries WHERE inbox_id = ?`, inboxId);
  }

  private acceptedTaskMarker(taskId: string, roomId: string | null): AcceptedTaskMarker | null {
    return (
      this.ctx.storage.sql
        .exec<AcceptedTaskMarker>(
          `SELECT task_id, room_id FROM accepted_tasks WHERE task_id = ? AND room_id IS ?`,
          taskId,
          roomId,
        )
        .toArray()[0] ?? null
    );
  }

  private deleteAcceptedTaskMarker(taskId: string, roomId: string | null): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM accepted_tasks WHERE task_id = ? AND room_id IS ?`,
      taskId,
      roomId,
    );
  }

  private scheduleWorkAckRetry(inboxId: string): void {
    const row = this.ctx.storage.sql
      .exec<{ attempts: number }>(
        `SELECT attempts FROM work_ack_retries WHERE inbox_id = ?`,
        inboxId,
      )
      .toArray()[0];
    if (!row) {
      return;
    }
    const attempts = row.attempts + 1;
    const delay = Math.min(
      WORK_ACK_RETRY_MAX_MS,
      WORK_ACK_RETRY_BASE_MS * 2 ** Math.min(attempts, 6),
    );
    this.ctx.storage.sql.exec(
      `UPDATE work_ack_retries SET attempts = ?, next_attempt_at = ? WHERE inbox_id = ?`,
      attempts,
      new Date(Date.now() + delay).toISOString(),
      inboxId,
    );
  }

  private async retryPendingWorkAcks(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<PendingWorkAck>(
        `SELECT inbox_id, task_id, room_id, idempotency_key, canonical_acknowledged, attempts
         FROM work_ack_retries ORDER BY next_attempt_at, inbox_id LIMIT 50`,
      )
      .toArray();
    for (const ack of pending) {
      const inbox = this.inboxById(ack.inbox_id);
      if (
        !inbox ||
        inbox.type !== "task" ||
        inbox.task_id !== ack.task_id ||
        inbox.room_id !== ack.room_id ||
        (inbox.state !== "QUEUED" && inbox.state !== "DELIVERED" && inbox.state !== "ACKNOWLEDGED")
      ) {
        this.deletePendingWorkAck(ack.inbox_id);
        continue;
      }
      try {
        if (ack.canonical_acknowledged === 0) {
          const result = await this.executeCanonicalAck(inbox);
          if (result.decision !== "ALLOW" || result.state !== "ACKNOWLEDGED") {
            this.deletePendingWorkAck(ack.inbox_id);
            continue;
          }
          this.markCanonicalAck(ack.inbox_id);
        }
        const projected = this.applyWorkAckProjection(ack.inbox_id);
        if (projected?.changed) {
          this.broadcast(agentEnvelope("inbox.acknowledged", inboxData(projected.row)));
        }
      } catch {
        this.scheduleWorkAckRetry(ack.inbox_id);
      }
    }
  }

  private async refreshAlarm(): Promise<void> {
    const socketDeadlines = this.ctx
      .getWebSockets()
      .map(readSocketAttachment)
      .filter(
        (attachment): attachment is SocketAttachment => !!attachment && !attachment.authenticated,
      )
      .map((attachment) => attachment.authDeadlineAt);
    const pending = this.ctx.storage.sql
      .exec<{ next_attempt_at: string | null }>(
        `SELECT MIN(next_attempt_at) AS next_attempt_at FROM work_ack_retries`,
      )
      .toArray()[0]?.next_attempt_at;
    const pendingAt = pending ? Date.parse(pending) : Number.NaN;
    const deadlines = [...socketDeadlines, ...(Number.isFinite(pendingAt) ? [pendingAt] : [])];
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private testMode(): boolean {
    return "TEST_MIGRATIONS" in this.env && this.env.TEST_MIGRATIONS !== undefined;
  }

  private consumeProjectionFault(): boolean {
    if (!this.testMode()) {
      return false;
    }
    let fail = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ remaining: number }>(`SELECT remaining FROM projection_fault WHERE id = 1`)
        .toArray()[0];
      if (row && row.remaining > 0) {
        fail = true;
        this.ctx.storage.sql.exec(
          `UPDATE projection_fault SET remaining = remaining - 1 WHERE id = 1`,
        );
      }
    });
    return fail;
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
      `CREATE TABLE IF NOT EXISTS work_ack_retries (
        inbox_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        room_id TEXT,
        idempotency_key TEXT NOT NULL,
        canonical_acknowledged INTEGER NOT NULL CHECK (canonical_acknowledged IN (0, 1)),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS accepted_tasks (
        task_id TEXT PRIMARY KEY,
        room_id TEXT,
        accepted_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS projection_fault (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        remaining INTEGER NOT NULL CHECK (remaining >= 0)
      )`,
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
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.OPEN && !!readAttachment(socket));
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
      if (readAttachment(socket)) {
        socket.send(text);
      }
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

function readSocketAttachment(ws: WebSocket): SocketAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<SocketAttachment>;
  if (
    typeof record.authenticated !== "boolean" ||
    typeof record.authDeadlineAt !== "number" ||
    !Number.isFinite(record.authDeadlineAt)
  ) {
    return null;
  }
  return {
    authenticated: record.authenticated,
    authDeadlineAt: record.authDeadlineAt,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  };
}

function readAttachment(ws: WebSocket): AuthenticatedSocketAttachment | null {
  const attachment = readSocketAttachment(ws);
  if (
    !attachment ||
    !attachment.authenticated ||
    typeof attachment.sessionId !== "string" ||
    !isId(attachment.sessionId, "ses")
  ) {
    return null;
  }
  return {
    authenticated: true,
    authDeadlineAt: attachment.authDeadlineAt,
    sessionId: attachment.sessionId,
  };
}
