import { DurableObject } from "cloudflare:workers";
import type { AgentDO } from "@ai-company/agent";
import {
  MAX_HANDOFFS,
  buildTaskEvent,
  createId,
  dependencyCycle,
  isId,
  isTaskCommand,
  isTaskState,
  nextTaskState,
  parseDomainEvent,
  type DomainEvent,
  type TaskCommandName,
  type TaskState,
} from "@ai-company/domain";
import type { OrganizationDO } from "@ai-company/organization";

interface TaskEnv {
  DB: D1Database;
  ORGANIZATION: DurableObjectNamespace<OrganizationDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  DOMAIN_EVENTS: Queue<DomainEvent>;
  TEST_MIGRATIONS?: unknown;
}

export interface TaskCommand {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  command: TaskCommandName;
  taskId: string | null;
  assigneeId: string | null;
  title: string | null;
  objective: string | null;
  roomId: string | null;
  dependsOn: string[];
}

export interface TaskResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  taskId: string | null;
  state: string | null;
  duplicate: boolean;
  handoffCount: number;
  humanReviewRequired: boolean;
  pauseReason: string | null;
}

type TaskRow = {
  id: string;
  title: string;
  objective: string;
  state: TaskState;
  creator_type: string;
  creator_id: string;
  assignee_id: string | null;
  room_id: string | null;
  handoff_count: number;
  human_review_required: number;
  pause_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type CommandRow = {
  task_id: string;
  command_name: string;
  decision: string;
  reason: string;
  state: string | null;
  handoff_count: number;
  human_review_required: number;
  pause_reason: string | null;
};

interface Change {
  state: TaskState;
  assigneeId: string | null;
  handoffCount: number;
  humanReviewRequired: number;
  pauseReason: string | null;
  reason: string;
}

const PERMISSION: Record<TaskCommandName, string> = {
  create: "task.create",
  assign: "task.assign",
  deliver: "task.assign",
  ack: "task.accept",
  start: "task.accept",
  submit: "task.accept",
  request_revision: "artifact.review",
  approve: "artifact.final_approve",
  complete: "task.assign",
  fail: "task.cancel",
  cancel: "task.cancel",
};

const ASSIGNEE_COMMANDS = new Set<TaskCommandName>(["ack", "start", "submit"]);
const DEPENDENCY_COMMANDS = new Set<TaskCommandName>(["start", "submit", "complete"]);

function denied(reason: string, task: TaskRow | null = null): TaskResult {
  return {
    decision: "DENY",
    reason,
    taskId: task?.id ?? null,
    state: task?.state ?? null,
    duplicate: false,
    handoffCount: task?.handoff_count ?? 0,
    humanReviewRequired: task?.human_review_required === 1,
    pauseReason: task?.pause_reason ?? null,
  };
}

function allowed(row: TaskRow, reason: string, duplicate: boolean): TaskResult {
  return {
    decision: "ALLOW",
    reason,
    taskId: row.id,
    state: row.state,
    duplicate,
    handoffCount: row.handoff_count,
    humanReviewRequired: row.human_review_required === 1,
    pauseReason: row.pause_reason,
  };
}

function storageText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function textField(value: string | null, max: number, multiline: boolean): string | null {
  if (value === null) {
    return null;
  }
  const text = value.trim();
  if (text.length < 1 || text.length > max) {
    return null;
  }
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10) {
      return null;
    }
    if (!multiline && (code === 9 || code === 10)) {
      return null;
    }
  }
  return text;
}

function idempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

export class TaskDO extends DurableObject<TaskEnv> {
  constructor(ctx: DurableObjectState, env: TaskEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async execute(command: TaskCommand): Promise<TaskResult> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId) {
      return denied("TENANT_BOUNDARY");
    }
    if (!isTaskCommand(command.command) || !idempotencyKey(command.idempotencyKey)) {
      return denied("INVALID_INPUT");
    }
    if (command.actorType !== "human" && command.actorType !== "employee") {
      return denied("INVALID_INPUT");
    }
    if (command.actorType === "human" && !isId(command.actorId, "usr")) {
      return denied("TENANT_BOUNDARY");
    }
    if (command.actorType === "employee" && !isId(command.actorId, "emp")) {
      return denied("TENANT_BOUNDARY");
    }
    if (command.command === "create") {
      return this.create(command);
    }
    return this.mutate(command);
  }

  async armPublishFault(times: number): Promise<{ armed: boolean }> {
    if (!this.testMode() || !Number.isInteger(times) || times < 0 || times > 8) {
      return { armed: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO publish_fault (id, remaining) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining`,
      times,
    );
    return { armed: true };
  }

  private async create(command: TaskCommand): Promise<TaskResult> {
    const decision = await this.authorize(command, "task.create", command.orgId, null);
    if (decision.decision === "DENY") {
      return denied(decision.reason);
    }
    const replay = this.replay(command);
    if (replay) {
      if (replay.decision === "ALLOW") {
        await this.publishStaged(command);
      }
      return replay;
    }
    const title = textField(command.title, 120, false);
    const objective = textField(command.objective, 2000, true);
    if (!title || !objective || !Array.isArray(command.dependsOn)) {
      return denied("INVALID_INPUT");
    }
    if (
      command.dependsOn.length > 8 ||
      new Set(command.dependsOn).size !== command.dependsOn.length
    ) {
      return denied("INVALID_INPUT");
    }
    for (const dep of command.dependsOn) {
      if (!isId(dep, "task")) {
        return denied("INVALID_INPUT");
      }
    }
    if (command.roomId !== null && !isId(command.roomId, "room")) {
      return denied("INVALID_INPUT");
    }
    if (command.roomId && !(await this.roomExists(command.orgId, command.roomId))) {
      return denied("TENANT_BOUNDARY");
    }
    for (const dep of command.dependsOn) {
      if (!this.taskById(dep)) {
        return denied("TENANT_BOUNDARY");
      }
    }
    const taskId = createId("task");
    if (dependencyCycle(this.dependencyMap(), taskId, command.dependsOn)) {
      return denied("DEPENDENCY_CYCLE");
    }
    const at = new Date().toISOString();
    const row: TaskRow = {
      id: taskId,
      title,
      objective,
      state: "CREATED",
      creator_type: command.actorType,
      creator_id: command.actorId,
      assignee_id: null,
      room_id: command.roomId,
      handoff_count: 0,
      human_review_required: 0,
      pause_reason: null,
      version: 1,
      created_at: at,
      updated_at: at,
    };
    const deps = command.dependsOn;
    let undo: (() => void) | null = null;
    this.ctx.storage.transactionSync(() => {
      this.insertTask(row);
      for (const dep of deps) {
        this.ctx.storage.sql.exec(
          `INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)`,
          taskId,
          dep,
        );
      }
      this.remember(command, row, "ALLOWED");
      this.stageEvent(command, null, row);
      undo = () => {
        this.deleteOutbox(command);
        this.deleteCommand(command);
        this.ctx.storage.sql.exec(`DELETE FROM task_dependencies WHERE task_id = ?`, taskId);
        this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE id = ?`, taskId);
      };
    });
    try {
      await this.projectInsert(command.orgId, row, deps);
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        undo?.();
      });
      if (storageText(error).includes("TENANT_MISMATCH")) {
        return denied("TENANT_BOUNDARY");
      }
      throw error;
    }
    await this.publishStaged(command);
    return allowed(row, "ALLOWED", false);
  }

  private async mutate(command: TaskCommand): Promise<TaskResult> {
    if (!command.taskId || !isId(command.taskId, "task")) {
      return denied("TENANT_BOUNDARY");
    }
    const current = this.taskById(command.taskId);
    if (!current || !isTaskState(current.state)) {
      return denied("TENANT_BOUNDARY");
    }
    const decision = await this.authorize(
      command,
      this.permissionFor(command, current),
      current.id,
      command.command === "approve" ? current.creator_id : null,
    );
    if (decision.decision === "DENY") {
      return denied(decision.reason, current);
    }
    const replay = this.replay(command);
    if (replay) {
      if (replay.decision === "ALLOW") {
        await this.publishStaged(command);
      }
      return replay;
    }
    if (command.command === "approve" && current.assignee_id === command.actorId) {
      return denied("NO_SELF_APPROVAL", current);
    }
    if (command.command === "assign" && current.state === "PAUSED") {
      return denied("LOOP_GUARD", current);
    }
    const next = nextTaskState(current.state, command.command);
    if (!next) {
      return denied("INVALID_TRANSITION", current);
    }
    if (
      ASSIGNEE_COMMANDS.has(command.command) &&
      (command.actorType !== "employee" || current.assignee_id !== command.actorId)
    ) {
      return denied("NOT_ASSIGNEE", current);
    }
    if (DEPENDENCY_COMMANDS.has(command.command)) {
      const dependency = this.dependencyBlock(current.id);
      if (dependency) {
        return denied(dependency, current);
      }
    }
    if (command.command === "deliver") {
      return this.deliver(command, current, next);
    }
    const result =
      command.command === "assign"
        ? await this.assign(command, current)
        : await this.transition(command, current, {
            state: next,
            assigneeId: current.assignee_id,
            handoffCount: current.handoff_count,
            humanReviewRequired: current.human_review_required,
            pauseReason: current.pause_reason,
            reason: "ALLOWED",
          });
    if (result.decision === "ALLOW" && !result.duplicate) {
      await this.publishStaged(command);
    }
    return result;
  }

  private async assign(command: TaskCommand, current: TaskRow): Promise<TaskResult> {
    if (!command.assigneeId || !isId(command.assigneeId, "emp")) {
      return denied("INVALID_INPUT", current);
    }
    const next = nextTaskState(current.state, "assign");
    if (!next) {
      return denied("INVALID_TRANSITION", current);
    }
    const status = await this.employeeStatus(command.orgId, command.assigneeId);
    if (!status) {
      return denied("TENANT_BOUNDARY", current);
    }
    if (status === "suspended") {
      return denied("SUSPENDED_AGENT_DENY", current);
    }
    if (command.assigneeId === current.assignee_id) {
      if (current.state === next) {
        return allowed(current, "ALLOWED", false);
      }
      return this.transition(command, current, {
        state: next,
        assigneeId: current.assignee_id,
        handoffCount: current.handoff_count,
        humanReviewRequired: 0,
        pauseReason: null,
        reason: "ALLOWED",
      });
    }
    const handoff =
      current.assignee_id === null ? current.handoff_count : current.handoff_count + 1;
    if (current.assignee_id !== null && handoff > MAX_HANDOFFS) {
      return this.transition(command, current, {
        state: "PAUSED",
        assigneeId: current.assignee_id,
        handoffCount: current.handoff_count,
        humanReviewRequired: 1,
        pauseReason: "LOOP_GUARD",
        reason: "LOOP_GUARD",
      });
    }
    return this.transition(command, current, {
      state: next,
      assigneeId: command.assigneeId,
      handoffCount: handoff,
      humanReviewRequired: 0,
      pauseReason: null,
      reason: "ALLOWED",
    });
  }

  private async deliver(
    command: TaskCommand,
    current: TaskRow,
    next: TaskState,
  ): Promise<TaskResult> {
    if (!current.assignee_id) {
      return denied("INVALID_TRANSITION", current);
    }
    const body = JSON.stringify({
      task_id: current.id,
      objective: current.objective,
      requested_by: current.creator_id,
    });
    if (body.length > 4000) {
      return denied("INVALID_INPUT", current);
    }
    const result = await this.transition(command, current, {
      state: next,
      assigneeId: current.assignee_id,
      handoffCount: current.handoff_count,
      humanReviewRequired: current.human_review_required,
      pauseReason: current.pause_reason,
      reason: "ALLOWED",
    });
    if (result.decision === "DENY") {
      return result;
    }
    let inbox: { decision: "ALLOW" | "DENY"; reason: string };
    try {
      inbox = await this.env.AGENT.getByName(
        `agent:${command.orgId}:${current.assignee_id}`,
      ).enqueue({
        orgId: command.orgId,
        employeeId: current.assignee_id,
        type: "task",
        taskId: current.id,
        roomId: current.room_id,
        priority: 0,
        body,
        idempotencyKey: command.idempotencyKey,
      });
    } catch (error) {
      await this.revert(command, current);
      throw error;
    }
    if (inbox.decision === "DENY") {
      await this.revert(command, current);
      return denied(inbox.reason, current);
    }
    await this.publishStaged(command);
    return result;
  }

  private async transition(
    command: TaskCommand,
    before: TaskRow,
    change: Change,
  ): Promise<TaskResult> {
    const applied: { row: TaskRow | null; undo: (() => void) | null } = { row: null, undo: null };
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const fresh = this.taskById(before.id);
      if (!fresh || fresh.version !== before.version) {
        return;
      }
      const row: TaskRow = {
        ...fresh,
        state: change.state,
        assignee_id: change.assigneeId,
        handoff_count: change.handoffCount,
        human_review_required: change.humanReviewRequired,
        pause_reason: change.pauseReason,
        version: fresh.version + 1,
        updated_at: at,
      };
      this.writeRow(row);
      this.remember(command, row, change.reason);
      this.stageEvent(command, fresh, row);
      applied.row = row;
      applied.undo = () => {
        this.writeRow(fresh);
        this.deleteOutbox(command);
        this.deleteCommand(command);
      };
    });
    const row = applied.row;
    if (!row) {
      return denied("INVALID_TRANSITION", this.taskById(before.id) ?? before);
    }
    try {
      await this.projectUpdate(command.orgId, row);
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        applied.undo?.();
      });
      if (storageText(error).includes("TENANT_MISMATCH")) {
        return denied("TENANT_BOUNDARY", before);
      }
      throw error;
    }
    return allowed(row, change.reason, false);
  }

  private async revert(command: TaskCommand, before: TaskRow): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.writeRow(before);
      this.deleteOutbox(command);
      this.deleteCommand(command);
    });
    await this.projectUpdate(command.orgId, before);
  }

  private permissionFor(command: TaskCommand, task: TaskRow): string {
    if (
      command.command === "fail" &&
      command.actorType === "employee" &&
      task.assignee_id === command.actorId
    ) {
      return "task.accept";
    }
    return PERMISSION[command.command];
  }

  private async authorize(
    command: TaskCommand,
    action: string,
    resourceId: string,
    creatorId: string | null,
  ): Promise<{ decision: "ALLOW" | "DENY"; reason: string }> {
    const decision = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).authorize({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      action,
      resourceType: "task",
      resourceId,
      creatorId,
    });
    return { decision: decision.decision, reason: decision.reason };
  }

  private dependencyBlock(taskId: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<{ depends_on: string }>(
        `SELECT depends_on FROM task_dependencies WHERE task_id = ?`,
        taskId,
      )
      .toArray();
    for (const row of rows) {
      const dep = this.taskById(row.depends_on);
      if (!dep) {
        return "TENANT_BOUNDARY";
      }
      if (dep.state !== "COMPLETED") {
        return "DEPENDENCY_NOT_COMPLETED";
      }
    }
    return null;
  }

  private dependencyMap(): Map<string, readonly string[]> {
    const rows = this.ctx.storage.sql
      .exec<{ task_id: string; depends_on: string }>(
        `SELECT task_id, depends_on FROM task_dependencies`,
      )
      .toArray();
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.task_id) ?? [];
      list.push(row.depends_on);
      map.set(row.task_id, list);
    }
    return map;
  }

  private replay(command: TaskCommand): TaskResult | null {
    const row = this.commandByKey(command);
    if (!row) {
      return null;
    }
    if (row.command_name !== command.command) {
      return denied("IDEMPOTENCY_MISMATCH");
    }
    return {
      decision: row.decision === "ALLOW" ? "ALLOW" : "DENY",
      reason: row.reason,
      taskId: row.task_id,
      state: row.state,
      duplicate: true,
      handoffCount: row.handoff_count,
      humanReviewRequired: row.human_review_required === 1,
      pauseReason: row.pause_reason,
    };
  }

  private bound(): { orgId: string } | null {
    const name = this.ctx.id.name;
    if (!name?.startsWith("tasks:")) {
      return null;
    }
    const orgId = name.slice("tasks:".length);
    if (!isId(orgId, "org")) {
      return null;
    }
    return { orgId };
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

  private async roomExists(orgId: string, roomId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT id FROM rooms WHERE org_id = ? AND id = ? AND status = 'active'`,
    )
      .bind(orgId, roomId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async projectInsert(orgId: string, row: TaskRow, deps: string[]): Promise<void> {
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO tasks (
          id, org_id, title, objective, state, creator_type, creator_id, assignee_id, room_id,
          handoff_count, human_review_required, pause_reason, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        orgId,
        row.title,
        row.objective,
        row.state,
        row.creator_type,
        row.creator_id,
        row.assignee_id,
        row.room_id,
        row.handoff_count,
        row.human_review_required,
        row.pause_reason,
        row.version,
        row.created_at,
        row.updated_at,
      ),
    ];
    for (const dep of deps) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO task_dependencies (org_id, task_id, depends_on) VALUES (?, ?, ?)`,
        ).bind(orgId, row.id, dep),
      );
    }
    const results = await this.env.DB.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) {
      throw new Error("TASK_PROJECTION_MISMATCH");
    }
  }

  private async projectUpdate(orgId: string, row: TaskRow): Promise<void> {
    const result = await this.env.DB.prepare(
      `UPDATE tasks
       SET state = ?, assignee_id = ?, handoff_count = ?, human_review_required = ?,
           pause_reason = ?, version = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`,
    )
      .bind(
        row.state,
        row.assignee_id,
        row.handoff_count,
        row.human_review_required,
        row.pause_reason,
        row.version,
        row.updated_at,
        orgId,
        row.id,
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("TASK_PROJECTION_MISMATCH");
    }
  }

  private taskById(id: string): TaskRow | null {
    return (
      this.ctx.storage.sql
        .exec<TaskRow>(
          `SELECT id, title, objective, state, creator_type, creator_id, assignee_id, room_id,
                  handoff_count, human_review_required, pause_reason, version, created_at, updated_at
           FROM tasks WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private commandByKey(command: TaskCommand): CommandRow | null {
    return (
      this.ctx.storage.sql
        .exec<CommandRow>(
          `SELECT task_id, command_name, decision, reason, state, handoff_count,
                  human_review_required, pause_reason
           FROM task_commands
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          command.actorType,
          command.actorId,
          command.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  private insertTask(row: TaskRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks (
        id, title, objective, state, creator_type, creator_id, assignee_id, room_id,
        handoff_count, human_review_required, pause_reason, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.objective,
      row.state,
      row.creator_type,
      row.creator_id,
      row.assignee_id,
      row.room_id,
      row.handoff_count,
      row.human_review_required,
      row.pause_reason,
      row.version,
      row.created_at,
      row.updated_at,
    );
  }

  private writeRow(row: TaskRow): void {
    this.ctx.storage.sql.exec(
      `UPDATE tasks
       SET title = ?, objective = ?, state = ?, creator_type = ?, creator_id = ?, assignee_id = ?,
           room_id = ?, handoff_count = ?, human_review_required = ?, pause_reason = ?, version = ?,
           created_at = ?, updated_at = ?
       WHERE id = ?`,
      row.title,
      row.objective,
      row.state,
      row.creator_type,
      row.creator_id,
      row.assignee_id,
      row.room_id,
      row.handoff_count,
      row.human_review_required,
      row.pause_reason,
      row.version,
      row.created_at,
      row.updated_at,
      row.id,
    );
  }

  private remember(command: TaskCommand, row: TaskRow, reason: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO task_commands (
        actor_type, actor_id, idempotency_key, task_id, command_name, decision, reason, state,
        handoff_count, human_review_required, pause_reason
      ) VALUES (?, ?, ?, ?, ?, 'ALLOW', ?, ?, ?, ?, ?)`,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
      row.id,
      command.command,
      reason,
      row.state,
      row.handoff_count,
      row.human_review_required,
      row.pause_reason,
    );
  }

  private testMode(): boolean {
    return "TEST_MIGRATIONS" in this.env && this.env.TEST_MIGRATIONS !== undefined;
  }

  private consumePublishFault(): boolean {
    if (!this.testMode()) {
      return false;
    }
    const row = this.ctx.storage.sql
      .exec<{ remaining: number }>(`SELECT remaining FROM publish_fault WHERE id = 1`)
      .toArray()[0];
    if (!row || row.remaining <= 0) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `UPDATE publish_fault SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0`,
    );
    return true;
  }

  private stageEvent(command: TaskCommand, before: TaskRow | null, row: TaskRow): void {
    const event = buildTaskEvent({
      command: command.command,
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: command.idempotencyKey,
      occurredAt: row.updated_at,
      taskId: row.id,
      fromState: before?.state ?? null,
      state: row.state,
      assigneeId: row.assignee_id,
      roomId: row.room_id,
      handoffCount: row.handoff_count,
      humanReviewRequired: row.human_review_required,
      pauseReason: row.pause_reason,
      version: row.version,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO event_outbox (
        event_id, actor_type, actor_id, idempotency_key, body, status
      ) VALUES (?, ?, ?, ?, ?, 'pending')`,
      event.event_id,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
      JSON.stringify(event),
    );
  }

  private async publishStaged(command: TaskCommand): Promise<void> {
    const pending = this.outboxByCommand(command);
    if (!pending || pending.status !== "pending") {
      return;
    }
    const event = parseDomainEvent(readJson(pending.body));
    if (!event || this.consumePublishFault()) {
      return;
    }
    try {
      await this.env.DOMAIN_EVENTS.send(event);
    } catch {
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE event_outbox SET status = 'sent' WHERE event_id = ? AND status = 'pending'`,
      event.event_id,
    );
  }

  private outboxByCommand(
    command: TaskCommand,
  ): { event_id: string; body: string; status: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ event_id: string; body: string; status: string }>(
          `SELECT event_id, body, status FROM event_outbox
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          command.actorType,
          command.actorId,
          command.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  private deleteOutbox(command: TaskCommand): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM event_outbox WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
    );
  }

  private deleteCommand(command: TaskCommand): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM task_commands WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
    );
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      state TEXT NOT NULL,
      creator_type TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      assignee_id TEXT,
      room_id TEXT,
      handoff_count INTEGER NOT NULL,
      human_review_required INTEGER NOT NULL,
      pause_reason TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (task_id, depends_on)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS event_outbox (
      event_id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS publish_fault (
      id INTEGER PRIMARY KEY,
      remaining INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS task_commands (
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      state TEXT,
      handoff_count INTEGER NOT NULL,
      human_review_required INTEGER NOT NULL,
      pause_reason TEXT,
      PRIMARY KEY (actor_type, actor_id, idempotency_key)
    )`);
  }
}
