import { DurableObject } from "cloudflare:workers";
import type { AgentDO } from "@ai-company/agent";
import { createId, isId, type TaskCommandName } from "@ai-company/domain";
import type { OrganizationDO } from "@ai-company/organization";
import type { TaskDO } from "@ai-company/task";
import {
  employeeFrom,
  envelope,
  idempotencyKey,
  isKnownClientType,
  isUnavailableClientType,
  MAX_REPLAY,
  messageBody,
  parseClientMessage,
  presenceState,
  readSequence,
  sessionToken,
  taskSubject,
  type RoomData,
  type RoomEnvelope,
} from "./protocol";

interface RoomEnv {
  DB: D1Database;
  ORGANIZATION: DurableObjectNamespace<OrganizationDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  TASK: DurableObjectNamespace<TaskDO>;
}

type RoomActorType = "human" | "employee";

interface ActorCommand {
  orgId: string;
  roomId: string;
  actorType: RoomActorType;
  actorId: string;
}

export interface RoomMembershipCommand extends ActorCommand {
  employeeId: string;
}

export interface RoomReadCommand extends ActorCommand {
  afterSeq: number;
}

export interface RoomMessageCommand extends ActorCommand {
  body: string;
  idempotencyKey: string;
}

export interface RoomTaskCommand extends ActorCommand {
  type: "task.available" | "task.updated";
  taskId: string;
  status: string;
  idempotencyKey: string;
}

export interface RoomDecision {
  decision: "ALLOW" | "DENY";
  reason: string;
  seq: number;
}

export interface RoomMutation extends RoomDecision {
  event: RoomEnvelope | null;
  duplicate: boolean;
}

export interface RoomLog extends RoomDecision {
  events: RoomEnvelope[];
}

interface BoundRoom {
  orgId: string;
  roomId: string;
}

type StoredEvent = {
  seq: number;
  event_id: string;
  type: string;
  body: string;
};

interface AppliedEvent {
  envelope: RoomEnvelope;
  undo: () => void;
}

type Presence = "online" | "away" | "offline";

interface SocketAttachment {
  employeeId: string;
  sessionId: string;
}

const TASK_PERMISSION = {
  "task.available": "task.create",
  "task.updated": "task.assign",
} as const;

function clientTaskCommand(type: string): TaskCommandName | null {
  if (type === "task.ack") {
    return "ack";
  }
  if (type === "task.start") {
    return "start";
  }
  if (type === "task.submit") {
    return "submit";
  }
  return null;
}

function deny(reason: string, seq: number): RoomDecision {
  return { decision: "DENY", reason, seq };
}

function allow(seq: number): RoomDecision {
  return { decision: "ALLOW", reason: "ALLOWED", seq };
}

export class RoomDO extends DurableObject<RoomEnv> {
  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    // A bare "ping" frame is answered by the runtime and does not wake a hibernated room.
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
    if (!bound || !(await this.roomExists(bound))) {
      return Response.json(
        { error: { code: "TENANT_BOUNDARY", message: "Room was not found." } },
        { status: 404 },
      );
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async join(command: RoomMembershipCommand): Promise<RoomMutation> {
    const opened = await this.open(command, "agent.invite");
    if (opened.decision === "DENY") {
      return { ...opened, event: null, duplicate: false };
    }
    if (!isId(command.employeeId, "emp")) {
      return { ...deny("TENANT_BOUNDARY", opened.seq), event: null, duplicate: false };
    }
    const status = await this.employeeStatus(command.orgId, command.employeeId);
    if (!status) {
      return { ...deny("TENANT_BOUNDARY", opened.seq), event: null, duplicate: false };
    }
    if (status === "suspended") {
      return { ...deny("SUSPENDED_AGENT_DENY", opened.seq), event: null, duplicate: false };
    }
    const existing = await this.activeMembership(command.orgId, command.roomId, command.employeeId);
    if (existing) {
      return { ...allow(opened.seq), event: null, duplicate: true };
    }
    const membershipId = createId("rmem");
    const at = new Date().toISOString();
    try {
      await this.env.DB.prepare(
        `INSERT INTO room_memberships (
           id, org_id, room_id, employee_id, status, joined_at, left_at
         ) VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      )
        .bind(membershipId, command.orgId, command.roomId, command.employeeId, at)
        .run();
    } catch (error) {
      if (alreadyMember(error)) {
        return { ...allow(this.seq()), event: null, duplicate: true };
      }
      if (tenantMismatch(error)) {
        return { ...deny("TENANT_BOUNDARY", this.seq()), event: null, duplicate: false };
      }
      throw error;
    }
    const applied = this.append({
      type: "member.joined",
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: null,
      data: {
        employee_id: command.employeeId,
        membership_id: membershipId,
        actor_id: command.actorId,
        actor_type: command.actorType,
        at,
      },
    });
    if (!applied) {
      return { ...deny("TENANT_BOUNDARY", this.seq()), event: null, duplicate: false };
    }
    await this.project(command.orgId, command.roomId, applied);
    this.broadcast(applied.envelope);
    return { ...allow(applied.envelope.seq), event: applied.envelope, duplicate: false };
  }

  async leave(command: RoomMembershipCommand): Promise<RoomMutation> {
    const self = command.actorType === "employee" && command.actorId === command.employeeId;
    const opened = await this.open(command, self ? "room.read" : "agent.remove");
    if (opened.decision === "DENY") {
      return { ...opened, event: null, duplicate: false };
    }
    const membership = await this.membership(command.orgId, command.roomId, command.employeeId);
    if (!membership) {
      return { ...deny("NOT_MEMBER", opened.seq), event: null, duplicate: false };
    }
    if (membership.status === "left") {
      return { ...allow(opened.seq), event: null, duplicate: true };
    }
    const at = new Date().toISOString();
    await this.env.DB.prepare(
      `UPDATE room_memberships
       SET status = 'left', left_at = ?
       WHERE org_id = ? AND room_id = ? AND employee_id = ? AND status = 'active'`,
    )
      .bind(at, command.orgId, command.roomId, command.employeeId)
      .run();
    const applied = this.append({
      type: "member.left",
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: null,
      data: {
        employee_id: command.employeeId,
        actor_id: command.actorId,
        actor_type: command.actorType,
        at,
      },
    });
    if (!applied) {
      return { ...deny("TENANT_BOUNDARY", this.seq()), event: null, duplicate: false };
    }
    await this.project(command.orgId, command.roomId, applied);
    this.broadcast(applied.envelope);
    this.revokeSockets(command.employeeId, "MEMBERSHIP_LEFT");
    return { ...allow(applied.envelope.seq), event: applied.envelope, duplicate: false };
  }

  async postMessage(command: RoomMessageCommand): Promise<RoomMutation> {
    const opened = await this.open(command, "room.message.send");
    if (opened.decision === "DENY") {
      return { ...opened, event: null, duplicate: false };
    }
    const member = await this.requireMember(command);
    if (member) {
      return { ...member, event: null, duplicate: false };
    }
    const body = messageBody(command.body);
    const key = idempotencyKey(command.idempotencyKey);
    if (!body || !key) {
      return { ...deny("INVALID_INPUT", this.seq()), event: null, duplicate: false };
    }
    return this.publish({
      type: "message.created",
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: key,
      data: {
        actor_id: command.actorId,
        actor_type: command.actorType,
        body,
        idempotency_key: key,
        at: new Date().toISOString(),
      },
      orgId: command.orgId,
      roomId: command.roomId,
    });
  }

  async publishTask(command: RoomTaskCommand): Promise<RoomMutation> {
    const permission = TASK_PERMISSION[command.type];
    const opened = await this.open(command, permission);
    if (opened.decision === "DENY") {
      return { ...opened, event: null, duplicate: false };
    }
    const member = await this.requireMember(command);
    if (member) {
      return { ...member, event: null, duplicate: false };
    }
    const subject = taskSubject({ task_id: command.taskId, status: command.status });
    const key = idempotencyKey(command.idempotencyKey);
    if (!subject || !key) {
      return { ...deny("INVALID_INPUT", opened.seq), event: null, duplicate: false };
    }
    return this.publish({
      type: command.type,
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: key,
      data: {
        actor_id: command.actorId,
        actor_type: command.actorType,
        task_id: subject.taskId,
        status: subject.status,
        at: new Date().toISOString(),
      },
      orgId: command.orgId,
      roomId: command.roomId,
    });
  }

  async eventsSince(command: RoomReadCommand): Promise<RoomLog> {
    const opened = await this.open(command, "room.read");
    if (opened.decision === "DENY") {
      return { ...opened, events: [] };
    }
    const member = await this.requireMember(command);
    if (member) {
      return { ...member, events: [] };
    }
    if (readSequence(command.afterSeq) === null || command.afterSeq > opened.seq) {
      return { ...deny("INVALID_SEQUENCE", opened.seq), events: [] };
    }
    const events = this.replay(command.afterSeq);
    if (events === null) {
      return { decision: "DENY", reason: "RESYNC_REQUIRED", seq: opened.seq, events: [] };
    }
    return { ...allow(opened.seq), events };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.send(ws, this.errorEnvelope("INVALID_INPUT", "Message is not valid."));
      return;
    }
    const parsed = parseClientMessage(message);
    if (!parsed) {
      this.send(ws, this.errorEnvelope("INVALID_INPUT", "Message is not valid."));
      return;
    }
    if (!isKnownClientType(parsed.type)) {
      this.send(ws, this.errorEnvelope("UNKNOWN_TYPE", "Message type is not supported."));
      return;
    }
    if (parsed.type === "ping") {
      this.send(ws, envelope("pong", createId("evt"), this.seq(), {}));
      return;
    }
    if (isUnavailableClientType(parsed.type)) {
      this.send(ws, this.errorEnvelope("NOT_AVAILABLE", "That command is not available."));
      return;
    }
    if (parsed.type === "session.hello") {
      await this.hello(ws, parsed.data, parsed.lastSeenSeq);
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      this.send(ws, this.errorEnvelope("NOT_READY", "Session hello is required."));
      return;
    }
    const bound = this.bound();
    if (!bound) {
      this.send(ws, this.errorEnvelope("TENANT_BOUNDARY", "Room was not found."));
      return;
    }
    const taskCommand = clientTaskCommand(parsed.type);
    if (taskCommand) {
      await this.clientTask(ws, bound, attachment, taskCommand, parsed.data);
      return;
    }
    const scope = parsed.type === "presence.update" ? "room.read" : "room.message.send";
    if (!(await this.requireLive(ws, bound.orgId, attachment, scope))) {
      return;
    }
    const actor: ActorCommand = {
      orgId: bound.orgId,
      roomId: bound.roomId,
      actorType: "employee",
      actorId: attachment.employeeId,
    };
    if (parsed.type === "presence.update") {
      await this.updatePresence(ws, actor, parsed.data);
      return;
    }
    const body = messageBody(parsed.data.body);
    const key = idempotencyKey(parsed.data.idempotency_key);
    if (!body || !key) {
      this.send(ws, this.errorEnvelope("INVALID_INPUT", "Message is not valid."));
      return;
    }
    const result = await this.postMessage({ ...actor, body, idempotencyKey: key });
    if (result.reason === "SUSPENDED_AGENT_DENY") {
      this.revokeSockets(attachment.employeeId, "SUSPENDED_AGENT_DENY");
      return;
    }
    if (result.decision === "DENY" || !result.event) {
      this.send(ws, this.errorEnvelope(result.reason, "Message was rejected."));
      return;
    }
    if (result.duplicate) {
      this.send(ws, result.event);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      return;
    }
    const stillOpen = this.socketsFor(attachment.employeeId).some((socket) => socket !== ws);
    if (stillOpen) {
      return;
    }
    const bound = this.bound();
    if (!bound || !(await this.roomExists(bound))) {
      return;
    }
    await this.changePresence(bound, attachment.employeeId, "offline");
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    console.log(JSON.stringify({ level: "error", name: "WebSocketError" }));
    ws.close(1011, "error");
  }

  private async hello(
    ws: WebSocket,
    data: Record<string, unknown>,
    lastSeenSeq: number | null,
  ): Promise<void> {
    const bound = this.bound();
    if (!bound || !(await this.roomExists(bound))) {
      this.send(ws, this.errorEnvelope("TENANT_BOUNDARY", "Room was not found."));
      return;
    }
    const employeeId = employeeFrom(data);
    const token = sessionToken(data);
    if (!employeeId || !token) {
      this.send(ws, this.errorEnvelope("SESSION_INVALID", "Session was rejected."));
      return;
    }
    const checked = await this.env.AGENT.getByName(`agent:${bound.orgId}:${employeeId}`).verify({
      orgId: bound.orgId,
      employeeId,
      token,
      scope: "room.read",
    });
    if (checked.decision === "DENY" || !checked.sessionId) {
      if (checked.reason === "SUSPENDED_AGENT_DENY") {
        this.send(
          ws,
          envelope("session.revoked", createId("evt"), this.seq(), { reason: checked.reason }),
        );
        ws.close(4001, "session.revoked");
        return;
      }
      this.send(ws, this.errorEnvelope(checked.reason, "Session was rejected."));
      return;
    }
    const actor: ActorCommand = {
      orgId: bound.orgId,
      roomId: bound.roomId,
      actorType: "employee",
      actorId: employeeId,
    };
    const opened = await this.open(actor, "room.read");
    if (opened.reason === "SUSPENDED_AGENT_DENY") {
      this.send(
        ws,
        envelope("session.revoked", createId("evt"), opened.seq, { reason: opened.reason }),
      );
      ws.close(4001, "session.revoked");
      return;
    }
    if (opened.decision === "DENY") {
      this.send(ws, this.errorEnvelope(opened.reason, "Session was rejected."));
      return;
    }
    const membership = await this.activeMembership(bound.orgId, bound.roomId, employeeId);
    if (!membership) {
      this.send(ws, this.errorEnvelope("NOT_MEMBER", "Employee is not a member of this room."));
      return;
    }
    if (
      lastSeenSeq === null ||
      lastSeenSeq > opened.seq ||
      opened.seq - lastSeenSeq >= MAX_REPLAY
    ) {
      const reason =
        lastSeenSeq === null || lastSeenSeq > opened.seq ? "INVALID_SEQUENCE" : "RESYNC_REQUIRED";
      const message =
        reason === "INVALID_SEQUENCE" ? "Sequence is not valid." : "Replay window was exceeded.";
      this.send(ws, this.errorEnvelope(reason, message));
      return;
    }
    ws.serializeAttachment({ employeeId, sessionId: checked.sessionId } satisfies SocketAttachment);
    await this.changePresence(bound, employeeId, "online", ws);
    const head = this.seq();
    const events = this.replay(lastSeenSeq) ?? [];
    for (const event of events) {
      this.send(ws, event);
    }
    this.send(
      ws,
      envelope("session.ready", createId("evt"), head, {
        employee_id: employeeId,
        replayed: events.length,
      }),
    );
  }

  private async requireLive(
    ws: WebSocket,
    orgId: string,
    attachment: SocketAttachment,
    scope: string,
  ): Promise<boolean> {
    const checked = await this.env.AGENT.getByName(
      `agent:${orgId}:${attachment.employeeId}`,
    ).sessionOpen({
      orgId,
      employeeId: attachment.employeeId,
      sessionId: attachment.sessionId,
      scope,
    });
    if (checked.decision === "ALLOW") {
      return true;
    }
    if (
      checked.reason === "SESSION_REVOKED" ||
      checked.reason === "SESSION_EXPIRED" ||
      checked.reason === "SUSPENDED_AGENT_DENY"
    ) {
      this.revokeSockets(attachment.employeeId, checked.reason);
      return false;
    }
    this.send(ws, this.errorEnvelope(checked.reason, "Session was rejected."));
    return false;
  }

  private async clientTask(
    ws: WebSocket,
    bound: BoundRoom,
    attachment: SocketAttachment,
    command: TaskCommandName,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!(await this.requireLive(ws, bound.orgId, attachment, "task.accept"))) {
      return;
    }
    const taskId =
      typeof data.task_id === "string" && isId(data.task_id, "task") ? data.task_id : null;
    const key = idempotencyKey(data.idempotency_key);
    if (!taskId || !key) {
      this.send(ws, this.errorEnvelope("INVALID_INPUT", "Task command is not valid."));
      return;
    }
    const result = await this.env.TASK.getByName(`tasks:${bound.orgId}`).execute({
      orgId: bound.orgId,
      actorType: "employee",
      actorId: attachment.employeeId,
      idempotencyKey: key,
      command,
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    if (result.reason === "SUSPENDED_AGENT_DENY") {
      this.revokeSockets(attachment.employeeId, "SUSPENDED_AGENT_DENY");
      return;
    }
    if (result.decision === "DENY" || !result.state || !result.taskId) {
      this.send(ws, this.errorEnvelope(result.reason, "Task command was rejected."));
      return;
    }
    const roomKey = `task_${key}`;
    const published = await this.publish({
      orgId: bound.orgId,
      roomId: bound.roomId,
      type: "task.updated",
      actorType: "employee",
      actorId: attachment.employeeId,
      idempotencyKey: roomKey.length <= 80 ? roomKey : key,
      data: {
        actor_id: attachment.employeeId,
        actor_type: "employee",
        task_id: result.taskId,
        status: result.state,
        at: new Date().toISOString(),
      },
    });
    if (published.decision === "DENY" || !published.event) {
      this.send(ws, this.errorEnvelope(published.reason, "Task command was rejected."));
      return;
    }
    if (published.duplicate) {
      this.send(ws, published.event);
    }
  }

  private async updatePresence(
    ws: WebSocket,
    actor: ActorCommand,
    data: Record<string, unknown>,
  ): Promise<void> {
    const state = presenceState(data.state);
    if (!state) {
      this.send(ws, this.errorEnvelope("INVALID_INPUT", "Presence is not valid."));
      return;
    }
    const opened = await this.open(actor, "room.read");
    if (opened.reason === "SUSPENDED_AGENT_DENY") {
      this.revokeSockets(actor.actorId, "SUSPENDED_AGENT_DENY");
      return;
    }
    if (opened.decision === "DENY") {
      this.send(ws, this.errorEnvelope(opened.reason, "Presence was rejected."));
      return;
    }
    const membership = await this.activeMembership(actor.orgId, actor.roomId, actor.actorId);
    if (!membership) {
      this.revokeSockets(actor.actorId, "MEMBERSHIP_LEFT");
      return;
    }
    const bound = { orgId: actor.orgId, roomId: actor.roomId };
    await this.changePresence(bound, actor.actorId, state);
  }

  private async changePresence(
    bound: BoundRoom,
    employeeId: string,
    state: Presence,
    except?: WebSocket,
  ): Promise<RoomEnvelope | null> {
    const applied = this.appendPresence(employeeId, state);
    if (!applied) {
      return null;
    }
    await this.project(bound.orgId, bound.roomId, applied);
    this.broadcast(applied.envelope, except);
    return applied.envelope;
  }

  private async publish(input: {
    orgId: string;
    roomId: string;
    type: string;
    actorType: RoomActorType;
    actorId: string;
    idempotencyKey: string;
    data: RoomData;
  }): Promise<RoomMutation> {
    const applied = this.append({
      type: input.type,
      actorType: input.actorType,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      data: input.data,
    });
    if (!applied) {
      const existing = this.findIdempotent(input.actorId, input.idempotencyKey);
      return {
        ...allow(this.seq()),
        event: existing,
        duplicate: true,
      };
    }
    await this.project(input.orgId, input.roomId, applied);
    this.broadcast(applied.envelope);
    return { ...allow(applied.envelope.seq), event: applied.envelope, duplicate: false };
  }

  private async open(command: ActorCommand, action: string): Promise<RoomDecision> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId || command.roomId !== bound.roomId) {
      return deny("TENANT_BOUNDARY", this.seq());
    }
    if (!(await this.roomExists(bound))) {
      return deny("TENANT_BOUNDARY", 0);
    }
    this.ctx.storage.transactionSync(() => {
      this.ensureMeta(bound.orgId, bound.roomId);
    });
    const decision = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).authorize({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      action,
      resourceType: "room",
      resourceId: command.roomId,
    });
    if (decision.decision === "DENY") {
      return deny(decision.reason, this.seq());
    }
    return allow(this.seq());
  }

  private async requireMember(command: ActorCommand): Promise<RoomDecision | null> {
    if (command.actorType !== "employee") {
      return null;
    }
    const membership = await this.activeMembership(command.orgId, command.roomId, command.actorId);
    if (!membership) {
      return deny("NOT_MEMBER", this.seq());
    }
    return null;
  }

  private async roomExists(bound: BoundRoom): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT id FROM rooms WHERE org_id = ? AND id = ? AND status = 'active'`,
    )
      .bind(bound.orgId, bound.roomId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async employeeStatus(
    orgId: string,
    employeeId: string,
  ): Promise<"active" | "suspended" | null> {
    const row = await this.env.DB.prepare(
      `SELECT status FROM employees WHERE org_id = ? AND id = ?`,
    )
      .bind(orgId, employeeId)
      .first<{ status: string }>();
    if (!row) {
      return null;
    }
    return row.status === "suspended" ? "suspended" : "active";
  }

  private async activeMembership(
    orgId: string,
    roomId: string,
    employeeId: string,
  ): Promise<{ id: string } | null> {
    return this.env.DB.prepare(
      `SELECT id FROM room_memberships
       WHERE org_id = ? AND room_id = ? AND employee_id = ? AND status = 'active'`,
    )
      .bind(orgId, roomId, employeeId)
      .first<{ id: string }>();
  }

  private async membership(
    orgId: string,
    roomId: string,
    employeeId: string,
  ): Promise<{ status: string } | null> {
    return this.env.DB.prepare(
      `SELECT status FROM room_memberships
       WHERE org_id = ? AND room_id = ? AND employee_id = ?
       ORDER BY joined_at DESC
       LIMIT 1`,
    )
      .bind(orgId, roomId, employeeId)
      .first<{ status: string }>();
  }

  private bound(): BoundRoom | null {
    const name = this.ctx.id.name ?? "";
    const prefix = "room:";
    if (!name.startsWith(prefix)) {
      return null;
    }
    const rest = name.slice(prefix.length);
    const splitAt = rest.indexOf(":");
    if (splitAt < 0) {
      return null;
    }
    const orgId = rest.slice(0, splitAt);
    const roomId = rest.slice(splitAt + 1);
    if (!isId(orgId, "org") || !isId(roomId, "room")) {
      return null;
    }
    return { orgId, roomId };
  }

  private ensureSchema(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS meta (
        org_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        idempotency_key TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS events_actor_key
        ON events (actor_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS presence (
        employee_id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      )`,
    ];
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  private ensureMeta(orgId: string, roomId: string): void {
    const row = this.ctx.storage.sql.exec(`SELECT seq FROM meta LIMIT 1`).toArray()[0];
    if (row) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (org_id, room_id, seq) VALUES (?, ?, 0)`,
      orgId,
      roomId,
    );
  }

  private seq(): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(`SELECT seq FROM meta LIMIT 1`)
      .toArray()[0];
    return row?.seq ?? 0;
  }

  private append(input: {
    type: string;
    actorType: RoomActorType;
    actorId: string;
    idempotencyKey: string | null;
    data: RoomData;
  }): AppliedEvent | null {
    let applied: AppliedEvent | null = null;
    this.ctx.storage.transactionSync(() => {
      const bound = this.bound();
      if (!bound) {
        return;
      }
      this.ensureMeta(bound.orgId, bound.roomId);
      if (input.idempotencyKey) {
        const existing = this.findIdempotent(input.actorId, input.idempotencyKey);
        if (existing) {
          return;
        }
      }
      const previous = this.seq();
      const next = previous + 1;
      const eventId = createId("evt");
      const at = new Date().toISOString();
      this.ctx.storage.sql.exec(
        `INSERT INTO events (
           seq, event_id, type, actor_type, actor_id, idempotency_key, body, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        next,
        eventId,
        input.type,
        input.actorType,
        input.actorId,
        input.idempotencyKey,
        JSON.stringify(input.data),
        at,
      );
      this.ctx.storage.sql.exec(`UPDATE meta SET seq = ?`, next);
      applied = {
        envelope: envelope(input.type, eventId, next, input.data),
        undo: () => {
          this.ctx.storage.sql.exec(`DELETE FROM events WHERE seq = ?`, next);
          this.ctx.storage.sql.exec(`UPDATE meta SET seq = ?`, previous);
        },
      };
    });
    return applied;
  }

  private appendPresence(employeeId: string, state: Presence): AppliedEvent | null {
    let applied: AppliedEvent | null = null;
    this.ctx.storage.transactionSync(() => {
      const bound = this.bound();
      if (!bound) {
        return;
      }
      this.ensureMeta(bound.orgId, bound.roomId);
      const current = this.ctx.storage.sql
        .exec<{ state: string }>(`SELECT state FROM presence WHERE employee_id = ?`, employeeId)
        .toArray()[0];
      if (current?.state === state) {
        return;
      }
      const previous = this.seq();
      const next = previous + 1;
      const eventId = createId("evt");
      const at = new Date().toISOString();
      const data = { employee_id: employeeId, state, at };
      this.ctx.storage.sql.exec(
        `INSERT INTO presence (employee_id, state) VALUES (?, ?)
         ON CONFLICT(employee_id) DO UPDATE SET state = excluded.state`,
        employeeId,
        state,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO events (
           seq, event_id, type, actor_type, actor_id, idempotency_key, body, created_at
         ) VALUES (?, ?, 'presence.updated', 'employee', ?, NULL, ?, ?)`,
        next,
        eventId,
        employeeId,
        JSON.stringify(data),
        at,
      );
      this.ctx.storage.sql.exec(`UPDATE meta SET seq = ?`, next);
      applied = {
        envelope: envelope("presence.updated", eventId, next, data),
        undo: () => {
          this.ctx.storage.sql.exec(`DELETE FROM events WHERE seq = ?`, next);
          this.ctx.storage.sql.exec(`UPDATE meta SET seq = ?`, previous);
          if (!current) {
            this.ctx.storage.sql.exec(`DELETE FROM presence WHERE employee_id = ?`, employeeId);
          } else {
            this.ctx.storage.sql.exec(
              `UPDATE presence SET state = ? WHERE employee_id = ?`,
              current.state,
              employeeId,
            );
          }
        },
      };
    });
    return applied;
  }

  private findIdempotent(actorId: string, key: string): RoomEnvelope | null {
    const row = this.ctx.storage.sql
      .exec<StoredEvent>(
        `SELECT seq, event_id, type, body FROM events
         WHERE actor_id = ? AND idempotency_key = ?`,
        actorId,
        key,
      )
      .toArray()[0];
    if (!row) {
      return null;
    }
    return envelope(row.type, row.event_id, row.seq, parseData(row.body));
  }

  private replay(afterSeq: number): RoomEnvelope[] | null {
    const rows = this.ctx.storage.sql
      .exec<StoredEvent>(
        `SELECT seq, event_id, type, body FROM events
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
        afterSeq,
        MAX_REPLAY + 1,
      )
      .toArray();
    if (rows.length > MAX_REPLAY) {
      return null;
    }
    return rows.map((row) => envelope(row.type, row.event_id, row.seq, parseData(row.body)));
  }

  private async project(orgId: string, roomId: string, applied: AppliedEvent): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO room_sequences (org_id, room_id, seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, room_id) DO UPDATE SET
           seq = MAX(room_sequences.seq, excluded.seq),
           updated_at = CASE
             WHEN excluded.seq >= room_sequences.seq THEN excluded.updated_at
             ELSE room_sequences.updated_at
           END`,
      )
        .bind(orgId, roomId, applied.envelope.seq, new Date().toISOString())
        .run();
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        applied.undo();
      });
      throw error;
    }
  }

  private broadcast(event: RoomEnvelope, except?: WebSocket): void {
    const text = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      socket.send(text);
    }
  }

  private send(ws: WebSocket, event: RoomEnvelope): void {
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return;
    }
    ws.send(JSON.stringify(event));
  }

  private errorEnvelope(code: string, message: string): RoomEnvelope {
    return envelope("error", createId("evt"), this.seq(), { code, message });
  }

  private revokeSockets(employeeId: string, reason: string): void {
    for (const socket of this.socketsFor(employeeId)) {
      this.send(socket, envelope("session.revoked", createId("evt"), this.seq(), { reason }));
      socket.close(4001, "session.revoked");
    }
  }

  private socketsFor(employeeId: string): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => readAttachment(socket)?.employeeId === employeeId);
  }
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { employeeId?: unknown; sessionId?: unknown };
  if (typeof record.employeeId !== "string" || !isId(record.employeeId, "emp")) {
    return null;
  }
  if (typeof record.sessionId !== "string" || !isId(record.sessionId, "ses")) {
    return null;
  }
  return { employeeId: record.employeeId, sessionId: record.sessionId };
}

function parseData(body: string): RoomData {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const data: RoomData = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      item === null
    ) {
      data[key] = item;
    }
  }
  return data;
}

function alreadyMember(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("room_memberships.org_id");
}

function tenantMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("TENANT_MISMATCH");
}
