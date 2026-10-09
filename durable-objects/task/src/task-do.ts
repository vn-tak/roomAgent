import { DurableObject } from "cloudflare:workers";
import type { AgentDO } from "@ai-company/agent";
import {
  MAX_HANDOFFS,
  DEFAULT_TASK_BUDGETS,
  buildTaskEvent,
  createId,
  dependencyCycle,
  isId,
  isTaskCommand,
  isTaskCompletionPolicy,
  isTaskState,
  nextTaskState,
  parseDomainEvent,
  taskBudgetExceeded,
  type DomainEvent,
  type TaskBudgets,
  type TaskCommandName,
  type TaskCompletionPolicy,
  type TaskState,
} from "@ai-company/domain";
import type { OrganizationDO } from "@ai-company/organization";

interface TaskEnv {
  DB: D1Database;
  ORGANIZATION: DurableObjectNamespace<OrganizationDO>;
  AGENT: DurableObjectNamespace<AgentDO>;
  DOMAIN_EVENTS: Queue<DomainEvent>;
  TEST_MIGRATIONS?: unknown;
  TASK_BUDGETS?: Partial<TaskBudgets>;
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
  expectedRoomId?: string | null;
  completionPolicy?: TaskCompletionPolicy;
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

export interface TaskAgentMessageInput {
  orgId: string;
  employeeId: string;
  taskId: string;
  expectedRoomId: string | null;
  idempotencyKey: string;
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
  completion_policy: TaskCompletionPolicy;
  correlation_id: string;
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
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000] as const;

interface OutboxRow extends Record<string, string | number | null | ArrayBuffer> {
  event_id: string;
  body: string;
  attempts: number;
  next_attempt_at: number;
}

interface AckProjectionRow extends Record<string, string | number | null | ArrayBuffer> {
  task_id: string;
  employee_id: string;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: number;
}

interface TaskAgentMessageRow extends Record<string, string | number | null | ArrayBuffer> {
  task_id: string;
  accepted: number;
}

interface TaskAckProjector {
  applyCanonicalTaskAck(input: {
    orgId: string;
    employeeId: string;
    taskId: string;
    idempotencyKey: string;
  }): Promise<{ decision: "ALLOW" | "DENY"; reason: string }>;
}

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
    if (
      command.expectedRoomId !== undefined &&
      command.expectedRoomId !== null &&
      !isId(command.expectedRoomId, "room")
    ) {
      return denied("INVALID_INPUT");
    }
    if (
      command.completionPolicy !== undefined &&
      !isTaskCompletionPolicy(command.completionPolicy)
    ) {
      return denied("INVALID_INPUT");
    }
    if (command.command === "create") {
      return this.create(command);
    }
    return this.mutate(command);
  }

  async recordAgentMessage(input: TaskAgentMessageInput): Promise<TaskResult> {
    const bound = this.bound();
    if (!bound || input.orgId !== bound.orgId) {
      return denied("TENANT_BOUNDARY");
    }
    if (
      !isId(input.employeeId, "emp") ||
      !isId(input.taskId, "task") ||
      (input.expectedRoomId !== null && !isId(input.expectedRoomId, "room")) ||
      !idempotencyKey(input.idempotencyKey)
    ) {
      return denied("INVALID_INPUT");
    }
    const current = this.taskById(input.taskId);
    if (!current) {
      return denied("TENANT_BOUNDARY");
    }
    if (current.room_id !== input.expectedRoomId) {
      return denied("ROOM_MISMATCH");
    }
    const command: TaskCommand = {
      orgId: input.orgId,
      actorType: "employee",
      actorId: input.employeeId,
      idempotencyKey: input.idempotencyKey,
      command: "submit",
      taskId: input.taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
      expectedRoomId: input.expectedRoomId,
    };
    const authorized = await this.authorize(command, "task.accept", current.id, null);
    if (authorized.decision === "DENY") {
      return denied(authorized.reason, current);
    }
    if (current.assignee_id !== input.employeeId) {
      return denied("NOT_ASSIGNEE", current);
    }
    const existing = this.ctx.storage.sql
      .exec<TaskAgentMessageRow>(
        `SELECT task_id, accepted FROM task_agent_messages
         WHERE employee_id = ? AND idempotency_key = ?`,
        input.employeeId,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (existing) {
      if (existing.task_id !== input.taskId) {
        return denied("IDEMPOTENCY_MISMATCH", current);
      }
      return existing.accepted === 1
        ? allowed(current, "ALLOWED", true)
        : { ...denied("BUDGET_GUARD", current), duplicate: true };
    }
    if (this.commandByKey(command)) {
      return denied("IDEMPOTENCY_MISMATCH", current);
    }
    if (["COMPLETED", "CANCELLED", "FAILED", "PAUSED"].includes(current.state)) {
      return denied(current.pause_reason ?? "TASK_NOT_ACTIVE", current);
    }

    const actionBudgetExceeded = await this.budgetExceeded(command, current, null);
    const latest = this.taskById(current.id);
    if (!latest) {
      return denied("TENANT_BOUNDARY");
    }
    if (latest.room_id !== input.expectedRoomId) {
      return denied("ROOM_MISMATCH");
    }
    if (latest.assignee_id !== input.employeeId) {
      return denied("NOT_ASSIGNEE", latest);
    }
    const latestMessage = this.ctx.storage.sql
      .exec<TaskAgentMessageRow>(
        `SELECT task_id, accepted FROM task_agent_messages
         WHERE employee_id = ? AND idempotency_key = ?`,
        input.employeeId,
        input.idempotencyKey,
      )
      .toArray()[0];
    if (latestMessage) {
      if (latestMessage.task_id !== input.taskId) {
        return denied("IDEMPOTENCY_MISMATCH", latest);
      }
      return latestMessage.accepted === 1
        ? allowed(latest, "ALLOWED", true)
        : { ...denied("BUDGET_GUARD", latest), duplicate: true };
    }
    if (actionBudgetExceeded) {
      return this.pauseForAgentMessageBudget(command, current);
    }
    const result = this.ctx.storage.transactionSync(() => {
      const fresh = this.taskById(input.taskId);
      if (!fresh) {
        return { kind: "denied" as const, reason: "TENANT_BOUNDARY", task: null };
      }
      if (fresh.room_id !== input.expectedRoomId) {
        return { kind: "denied" as const, reason: "ROOM_MISMATCH", task: fresh };
      }
      if (fresh.assignee_id !== input.employeeId) {
        return { kind: "denied" as const, reason: "NOT_ASSIGNEE", task: fresh };
      }
      if (["COMPLETED", "CANCELLED", "FAILED", "PAUSED"].includes(fresh.state)) {
        return {
          kind: "denied" as const,
          reason: fresh.pause_reason ?? "TASK_NOT_ACTIVE",
          task: fresh,
        };
      }
      const seen = this.ctx.storage.sql
        .exec<TaskAgentMessageRow>(
          `SELECT task_id, accepted FROM task_agent_messages
           WHERE employee_id = ? AND idempotency_key = ?`,
          input.employeeId,
          input.idempotencyKey,
        )
        .toArray()[0];
      if (seen) {
        return seen.task_id === input.taskId
          ? {
              kind: seen.accepted === 1 ? ("duplicate" as const) : ("budget" as const),
              task: fresh,
            }
          : { kind: "denied" as const, reason: "IDEMPOTENCY_MISMATCH", task: fresh };
      }
      const count =
        this.ctx.storage.sql
          .exec<{ n: number }>(
            `SELECT COUNT(*) AS n FROM task_agent_messages WHERE task_id = ? AND accepted = 1`,
            input.taskId,
          )
          .toArray()[0]?.n ?? 0;
      if (taskBudgetExceeded(count, this.budgets().maxAgentMessagesPerTask)) {
        return { kind: "budget" as const, task: fresh };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO task_agent_messages (employee_id, idempotency_key, task_id, accepted, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        input.employeeId,
        input.idempotencyKey,
        input.taskId,
        new Date().toISOString(),
      );
      return { kind: "allowed" as const, task: fresh };
    });
    if (result.kind === "denied") {
      return denied(result.reason, result.reason === "ROOM_MISMATCH" ? null : result.task);
    }
    if (result.kind === "duplicate") {
      return allowed(result.task, "ALLOWED", true);
    }
    if (result.kind === "budget") {
      return this.pauseForAgentMessageBudget(command, result.task);
    }
    return allowed(result.task, "ALLOWED", false);
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

  async armAckProjectionFault(times: number): Promise<{ armed: boolean }> {
    if (!this.testMode() || !Number.isInteger(times) || times < 0 || times > 8) {
      return { armed: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO ack_projection_fault (id, remaining) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET remaining = excluded.remaining`,
      times,
    );
    return { armed: true };
  }

  async configureBudgetsForTest(values: Partial<TaskBudgets>): Promise<{ configured: boolean }> {
    if (
      !this.testMode() ||
      Object.values(values).some(
        (value) => !Number.isInteger(value) || value < 1 || value > 1_000_000,
      )
    ) {
      return { configured: false };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO task_budget_config (id, values_json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET values_json = excluded.values_json`,
      JSON.stringify(values),
    );
    return { configured: true };
  }

  async runAlarmForTest(): Promise<{ ran: boolean }> {
    if (!this.testMode()) {
      return { ran: false };
    }
    this.ctx.storage.sql.exec(
      `UPDATE event_outbox SET next_attempt_at = 0 WHERE status = 'pending'`,
    );
    this.ctx.storage.sql.exec(
      `UPDATE ack_projection_outbox SET next_attempt_at = 0 WHERE status = 'pending'`,
    );
    await this.alarm();
    return { ran: true };
  }

  async outboxStatusForTest(): Promise<{
    pendingEvents: number;
    sentEvents: number;
    failedEvents: number;
    pendingAcknowledgements: number;
    alarmAt: number | null;
  }> {
    if (!this.testMode()) {
      return {
        pendingEvents: 0,
        sentEvents: 0,
        failedEvents: 0,
        pendingAcknowledgements: 0,
        alarmAt: null,
      };
    }
    const result = this.ctx.storage.sql
      .exec<{
        pending_events: number;
        sent_events: number;
        failed_events: number;
        pending_acknowledgements: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM event_outbox WHERE status = 'pending') AS pending_events,
          (SELECT COUNT(*) FROM event_outbox WHERE status = 'sent') AS sent_events,
          (SELECT COUNT(*) FROM event_outbox WHERE status = 'failed') AS failed_events,
          (SELECT COUNT(*) FROM ack_projection_outbox WHERE status = 'pending') AS pending_acknowledgements`,
      )
      .toArray()[0];
    return {
      pendingEvents: result?.pending_events ?? 0,
      sentEvents: result?.sent_events ?? 0,
      failedEvents: result?.failed_events ?? 0,
      pendingAcknowledgements: result?.pending_acknowledgements ?? 0,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
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
    const budgetExceeded = await this.budgetExceeded(command, null, null);
    const completionPolicy = command.completionPolicy ?? "NONE";
    const at = new Date().toISOString();
    const row: TaskRow = {
      id: taskId,
      title,
      objective,
      state: budgetExceeded ? "PAUSED" : "CREATED",
      creator_type: command.actorType,
      creator_id: command.actorId,
      assignee_id: null,
      room_id: command.roomId,
      completion_policy: completionPolicy,
      correlation_id: createId("corr"),
      handoff_count: 0,
      human_review_required: budgetExceeded ? 1 : 0,
      pause_reason: budgetExceeded ? "BUDGET_GUARD" : null,
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
      this.remember(command, row, budgetExceeded ? "BUDGET_GUARD" : "ALLOWED");
      this.stageEvent(command, null, row);
      undo = () => {
        this.deleteOutbox(command);
        this.deleteCommand(command);
        this.ctx.storage.sql.exec(`DELETE FROM task_dependencies WHERE task_id = ?`, taskId);
        this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE id = ?`, taskId);
      };
    });
    try {
      await this.ensureOutboxAlarm();
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
    return allowed(row, budgetExceeded ? "BUDGET_GUARD" : "ALLOWED", false);
  }

  private async mutate(command: TaskCommand): Promise<TaskResult> {
    if (!command.taskId || !isId(command.taskId, "task")) {
      return denied("TENANT_BOUNDARY");
    }
    const current = this.taskById(command.taskId);
    if (!current || !isTaskState(current.state)) {
      return denied("TENANT_BOUNDARY");
    }
    if (command.expectedRoomId !== undefined && current.room_id !== command.expectedRoomId) {
      return denied("ROOM_MISMATCH");
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
    if (command.command === "approve" || command.command === "complete") {
      const evidenceFailure = await this.completionEvidenceFailure(command, current);
      if (evidenceFailure) {
        return denied(evidenceFailure, current);
      }
    }
    const replay = this.replay(command);
    if (replay) {
      if (replay.decision === "ALLOW") {
        await this.publishStaged(command);
        if (command.command === "ack" && replay.state === "ACKNOWLEDGED") {
          await this.projectAgentAcknowledgement(command.taskId);
        }
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
    if (command.command !== "assign" && (await this.budgetExceeded(command, current, null))) {
      const paused = await this.transition(command, current, {
        state: "PAUSED",
        assigneeId: current.assignee_id,
        handoffCount: current.handoff_count,
        humanReviewRequired: 1,
        pauseReason: "BUDGET_GUARD",
        reason: "BUDGET_GUARD",
      });
      if (paused.decision === "ALLOW" && !paused.duplicate) {
        await this.publishStaged(command);
      }
      return paused;
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
      if (command.command === "ack" && result.state === "ACKNOWLEDGED") {
        await this.projectAgentAcknowledgement(current.id);
      }
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
    if (await this.activeTaskBudgetExceeded(command, current, command.assigneeId)) {
      return this.transition(command, current, {
        state: "PAUSED",
        assigneeId: command.assigneeId,
        handoffCount: current.handoff_count,
        humanReviewRequired: 1,
        pauseReason: "BUDGET_GUARD",
        reason: "BUDGET_GUARD",
      });
    }
    if (await this.budgetExceeded(command, current, command.assigneeId)) {
      return this.transition(command, current, {
        state: "PAUSED",
        assigneeId: current.assignee_id,
        handoffCount: current.handoff_count,
        humanReviewRequired: 1,
        pauseReason: "BUDGET_GUARD",
        reason: "BUDGET_GUARD",
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
      if (command.command === "ack" && row.state === "ACKNOWLEDGED" && row.assignee_id) {
        this.stageAgentAcknowledgement(command, row);
      }
      applied.row = row;
      applied.undo = () => {
        this.writeRow(fresh);
        this.deleteOutbox(command);
        this.deleteAgentAcknowledgement(row.id);
        this.deleteCommand(command);
      };
    });
    const row = applied.row;
    if (!row) {
      return denied("INVALID_TRANSITION", this.taskById(before.id) ?? before);
    }
    try {
      await this.ensureOutboxAlarm();
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
    resourceType = "task",
  ): Promise<{ decision: "ALLOW" | "DENY"; reason: string }> {
    const decision = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).authorize({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      action,
      resourceType,
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

  private budgets(): TaskBudgets {
    const testValues = this.ctx.storage.sql
      .exec<{ values_json: string }>(`SELECT values_json FROM task_budget_config WHERE id = 1`)
      .toArray()[0];
    const fromTest = testValues ? readJson(testValues.values_json) : null;
    return {
      ...DEFAULT_TASK_BUDGETS,
      ...this.env.TASK_BUDGETS,
      ...(fromTest && typeof fromTest === "object" ? fromTest : {}),
    } as TaskBudgets;
  }

  private async budgetExceeded(
    command: TaskCommand,
    task: TaskRow | null,
    assigneeId: string | null,
  ): Promise<boolean> {
    // D1 events are org-wide; local TaskDO rows include actions not yet projected.
    const budgets = this.budgets();
    const now = new Date();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const localTaskActions =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM task_commands WHERE created_at >= ?`,
          dayStart,
        )
        .toArray()[0]?.n ?? 0;
    const localAgentMessages =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM task_agent_messages WHERE accepted = 1 AND created_at >= ?`,
          dayStart,
        )
        .toArray()[0]?.n ?? 0;
    const localTaskActorActions =
      command.actorType === "employee"
        ? (this.ctx.storage.sql
            .exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM task_commands
               WHERE actor_type = 'employee' AND actor_id = ? AND created_at >= ?`,
              command.actorId,
              dayStart,
            )
            .toArray()[0]?.n ?? 0)
        : 0;
    const localAgentActorMessages =
      command.actorType === "employee"
        ? (this.ctx.storage.sql
            .exec<{ n: number }>(
              `SELECT COUNT(*) AS n FROM task_agent_messages
               WHERE accepted = 1 AND employee_id = ? AND created_at >= ?`,
              command.actorId,
              dayStart,
            )
            .toArray()[0]?.n ?? 0)
        : 0;
    const projected = await this.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND occurred_at >= ?`,
    )
      .bind(command.orgId, dayStart)
      .first<{ n: number }>();
    const projectedActor =
      command.actorType === "employee"
        ? await this.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM domain_events
             WHERE org_id = ? AND actor_type = 'employee' AND actor_id = ? AND occurred_at >= ?`,
          )
            .bind(command.orgId, command.actorId, dayStart)
            .first<{ n: number }>()
        : null;
    if (
      task &&
      command.command === "start" &&
      this.countTaskCommands(task.id, "start") > budgets.maxTaskRetries
    ) {
      return true;
    }
    return (
      taskBudgetExceeded(
        Math.max(localTaskActions, projected?.n ?? 0) + localAgentMessages,
        budgets.orgDailyActionBudget,
      ) ||
      taskBudgetExceeded(
        Math.max(localTaskActorActions, projectedActor?.n ?? 0) + localAgentActorMessages,
        budgets.agentActionBudget,
      ) ||
      (assigneeId !== null && (await this.activeTaskBudgetExceeded(command, task, assigneeId)))
    );
  }

  private async activeTaskBudgetExceeded(
    command: TaskCommand,
    task: TaskRow | null,
    assigneeId: string,
  ): Promise<boolean> {
    const active =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM tasks
         WHERE assignee_id = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
           AND id != ?`,
          assigneeId,
          task?.id ?? "",
        )
        .toArray()[0]?.n ?? 0;
    return taskBudgetExceeded(active, this.budgets().maxActiveTasksPerAgent);
  }

  private countTaskCommands(taskId: string, commandName: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM task_commands WHERE task_id = ? AND command_name = ?`,
          taskId,
          commandName,
        )
        .toArray()[0]?.n ?? 0
    );
  }

  private async pauseForAgentMessageBudget(
    command: TaskCommand,
    before: TaskRow,
  ): Promise<TaskResult> {
    if (before.state === "PAUSED") {
      return denied("BUDGET_GUARD", before);
    }
    const at = new Date().toISOString();
    const row: TaskRow = {
      ...before,
      state: "PAUSED",
      human_review_required: 1,
      pause_reason: "BUDGET_GUARD",
      version: before.version + 1,
      updated_at: at,
    };
    const applied = this.ctx.storage.transactionSync(() => {
      const fresh = this.taskById(before.id);
      if (
        !fresh ||
        fresh.version !== before.version ||
        fresh.room_id !== command.expectedRoomId ||
        fresh.assignee_id !== command.actorId ||
        ["COMPLETED", "CANCELLED", "FAILED", "PAUSED"].includes(fresh.state)
      ) {
        return false;
      }
      this.writeRow(row);
      this.ctx.storage.sql.exec(
        `INSERT INTO task_agent_messages (employee_id, idempotency_key, task_id, accepted, created_at)
         VALUES (?, ?, ?, 0, ?)`,
        command.actorId,
        command.idempotencyKey,
        command.taskId,
        at,
      );
      this.stageEvent(command, fresh, row);
      return true;
    });
    if (!applied) {
      return denied("INVALID_TRANSITION", this.taskById(before.id) ?? before);
    }
    try {
      await this.ensureOutboxAlarm();
      await this.projectUpdate(command.orgId, row);
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        this.writeRow(before);
        this.deleteOutbox(command);
        this.ctx.storage.sql.exec(
          `DELETE FROM task_agent_messages WHERE employee_id = ? AND idempotency_key = ?`,
          command.actorId,
          command.idempotencyKey,
        );
      });
      if (storageText(error).includes("TENANT_MISMATCH")) {
        return denied("TENANT_BOUNDARY", before);
      }
      throw error;
    }
    await this.publishStaged(command);
    return denied("BUDGET_GUARD", row);
  }

  private async completionEvidenceFailure(
    command: TaskCommand,
    task: TaskRow,
  ): Promise<string | null> {
    if (task.completion_policy === "NONE") {
      return null;
    }
    const approvals =
      task.completion_policy === "ARTIFACT_APPROVED"
        ? `EXISTS (
             SELECT 1 FROM approvals
             WHERE approvals.org_id = artifacts.org_id
               AND approvals.artifact_id = artifacts.id
               AND approvals.artifact_version = artifacts.canonical_version
               AND approvals.kind = 'final' AND approvals.decision = 'PASS'
           )`
        : task.completion_policy === "HUMAN_FINAL"
          ? `EXISTS (
             SELECT 1 FROM approvals
             WHERE approvals.org_id = artifacts.org_id
               AND approvals.artifact_id = artifacts.id
               AND approvals.artifact_version = artifacts.canonical_version
               AND approvals.kind = 'final' AND approvals.decision = 'PASS'
               AND approvals.actor_type = 'human'
           ) AND EXISTS (
             SELECT 1 FROM workflow_runs AS runs
             WHERE runs.org_id = artifacts.org_id
               AND runs.task_id = artifacts.task_id
               AND runs.artifact_id = artifacts.id
               AND COALESCE(runs.completed_artifact_version, runs.artifact_version) = artifacts.canonical_version
               AND runs.status = 'complete'
           )`
          : `EXISTS (
             SELECT 1 FROM reviews
             WHERE reviews.org_id = artifacts.org_id
               AND reviews.artifact_id = artifacts.id
               AND reviews.artifact_version = artifacts.canonical_version
               AND reviews.result = 'PASS'
           ) AND EXISTS (
             SELECT 1 FROM approvals
             WHERE approvals.org_id = artifacts.org_id
               AND approvals.artifact_id = artifacts.id
               AND approvals.artifact_version = artifacts.canonical_version
               AND approvals.kind = 'security' AND approvals.decision = 'PASS'
           )`;
    const evidence = await this.env.DB.prepare(
      `SELECT artifacts.id, artifacts.creator_id FROM artifacts
       INNER JOIN artifact_versions ON artifact_versions.org_id = artifacts.org_id
        AND artifact_versions.artifact_id = artifacts.id
        AND artifact_versions.version = artifacts.canonical_version
       WHERE artifacts.org_id = ? AND artifacts.task_id = ? AND (${approvals})
       ORDER BY artifacts.created_at DESC
       LIMIT 1`,
    )
      .bind(command.orgId, task.id)
      .first<{ id: string; creator_id: string }>();
    if (!evidence) {
      return "COMPLETION_POLICY_EVIDENCE_REQUIRED";
    }
    const decision = await this.authorize(
      command,
      this.permissionFor(command, task),
      evidence.id,
      evidence.creator_id,
      "artifact",
    );
    return decision.decision === "DENY" ? decision.reason : null;
  }

  private async projectInsert(orgId: string, row: TaskRow, deps: string[]): Promise<void> {
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO tasks (
          id, org_id, title, objective, state, creator_type, creator_id, assignee_id, room_id,
          completion_policy, correlation_id, handoff_count, human_review_required, pause_reason,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.completion_policy,
        row.correlation_id,
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
           pause_reason = ?, completion_policy = ?, correlation_id = ?, version = ?, updated_at = ?
       WHERE org_id = ? AND id = ?`,
    )
      .bind(
        row.state,
        row.assignee_id,
        row.handoff_count,
        row.human_review_required,
        row.pause_reason,
        row.completion_policy,
        row.correlation_id,
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
                  completion_policy, correlation_id,
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
        completion_policy, correlation_id, handoff_count, human_review_required, pause_reason,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.title,
      row.objective,
      row.state,
      row.creator_type,
      row.creator_id,
      row.assignee_id,
      row.room_id,
      row.completion_policy,
      row.correlation_id,
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
           room_id = ?, completion_policy = ?, correlation_id = ?, handoff_count = ?,
           human_review_required = ?, pause_reason = ?, version = ?,
           created_at = ?, updated_at = ?
       WHERE id = ?`,
      row.title,
      row.objective,
      row.state,
      row.creator_type,
      row.creator_id,
      row.assignee_id,
      row.room_id,
      row.completion_policy,
      row.correlation_id,
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
        handoff_count, human_review_required, pause_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, 'ALLOW', ?, ?, ?, ?, ?, ?)`,
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
      row.updated_at,
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
      correlationId: row.correlation_id,
      assigneeId: row.assignee_id,
      roomId: row.room_id,
      handoffCount: row.handoff_count,
      humanReviewRequired: row.human_review_required,
      pauseReason: row.pause_reason,
      version: row.version,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO event_outbox (
        event_id, actor_type, actor_id, idempotency_key, body, status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0)`,
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
    await this.tryPublishOutbox(pending);
  }

  private outboxByCommand(command: TaskCommand): (OutboxRow & { status: string }) | null {
    return (
      this.ctx.storage.sql
        .exec<OutboxRow & { status: string }>(
          `SELECT event_id, body, attempts, next_attempt_at, status FROM event_outbox
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          command.actorType,
          command.actorId,
          command.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const events = this.ctx.storage.sql
      .exec<OutboxRow>(
        `SELECT event_id, body, attempts, next_attempt_at FROM event_outbox
         WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, event_id`,
        now,
      )
      .toArray();
    for (const event of events) {
      await this.tryPublishOutbox(event);
    }
    const acknowledgements = this.ctx.storage.sql
      .exec<AckProjectionRow>(
        `SELECT task_id, employee_id, idempotency_key, attempts, next_attempt_at
         FROM ack_projection_outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, task_id`,
        now,
      )
      .toArray();
    for (const acknowledgement of acknowledgements) {
      await this.projectAgentAcknowledgement(acknowledgement.task_id);
    }
    await this.ensureOutboxAlarm();
  }

  private async tryPublishOutbox(pending: OutboxRow): Promise<void> {
    const event = parseDomainEvent(readJson(pending.body));
    if (!event) {
      this.ctx.storage.sql.exec(
        `UPDATE event_outbox SET status = 'failed', failed_reason = 'INVALID_EVENT'
         WHERE event_id = ? AND status = 'pending'`,
        pending.event_id,
      );
      return;
    }
    try {
      if (this.consumePublishFault()) {
        throw new Error("INJECTED_QUEUE_FAILURE");
      }
      await this.env.DOMAIN_EVENTS.send(event);
      this.ctx.storage.sql.exec(
        `UPDATE event_outbox SET status = 'sent' WHERE event_id = ? AND status = 'pending'`,
        event.event_id,
      );
    } catch {
      const attempts = pending.attempts + 1;
      this.ctx.storage.sql.exec(
        `UPDATE event_outbox SET attempts = ?, next_attempt_at = ?
         WHERE event_id = ? AND status = 'pending'`,
        attempts,
        Date.now() + this.retryDelay(attempts),
        pending.event_id,
      );
      await this.ensureOutboxAlarm();
    }
  }

  private stageAgentAcknowledgement(command: TaskCommand, row: TaskRow): void {
    if (!row.assignee_id) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO ack_projection_outbox (
        task_id, employee_id, idempotency_key, status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, 'pending', 0, 0)
      ON CONFLICT(task_id) DO UPDATE SET
        employee_id = excluded.employee_id,
        idempotency_key = excluded.idempotency_key,
        status = 'pending', attempts = 0, next_attempt_at = 0`,
      row.id,
      row.assignee_id,
      command.idempotencyKey,
    );
  }

  private async projectAgentAcknowledgement(taskId: string | null): Promise<void> {
    if (!taskId) {
      return;
    }
    const pending = this.ctx.storage.sql
      .exec<AckProjectionRow>(
        `SELECT task_id, employee_id, idempotency_key, attempts, next_attempt_at
         FROM ack_projection_outbox WHERE task_id = ? AND status = 'pending'`,
        taskId,
      )
      .toArray()[0];
    if (!pending) {
      return;
    }
    try {
      if (this.consumeAckProjectionFault()) {
        throw new Error("INJECTED_ACK_PROJECTION_FAILURE");
      }
      const orgId = this.bound()?.orgId;
      if (!orgId) {
        return;
      }
      const agent = this.env.AGENT.getByName(
        `agent:${orgId}:${pending.employee_id}`,
      ) as unknown as TaskAckProjector;
      const result = await agent.applyCanonicalTaskAck({
        orgId,
        employeeId: pending.employee_id,
        taskId: pending.task_id,
        idempotencyKey: pending.idempotency_key,
      });
      if (result.decision !== "ALLOW") {
        throw new Error(result.reason);
      }
      this.ctx.storage.sql.exec(
        `UPDATE ack_projection_outbox SET status = 'sent' WHERE task_id = ? AND status = 'pending'`,
        taskId,
      );
    } catch {
      const attempts = pending.attempts + 1;
      this.ctx.storage.sql.exec(
        `UPDATE ack_projection_outbox SET attempts = ?, next_attempt_at = ?
         WHERE task_id = ? AND status = 'pending'`,
        attempts,
        Date.now() + this.retryDelay(attempts),
        taskId,
      );
      await this.ensureOutboxAlarm();
    }
  }

  private deleteAgentAcknowledgement(taskId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM ack_projection_outbox WHERE task_id = ?`, taskId);
  }

  private consumeAckProjectionFault(): boolean {
    if (!this.testMode()) {
      return false;
    }
    const row = this.ctx.storage.sql
      .exec<{ remaining: number }>(`SELECT remaining FROM ack_projection_fault WHERE id = 1`)
      .toArray()[0];
    if (!row || row.remaining <= 0) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `UPDATE ack_projection_fault SET remaining = remaining - 1 WHERE id = 1 AND remaining > 0`,
    );
    return true;
  }

  private retryDelay(attempt: number): number {
    return (
      RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)] ?? 300_000
    );
  }

  private async ensureOutboxAlarm(): Promise<void> {
    const pending = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(next_at) AS next_at FROM (
          SELECT next_attempt_at AS next_at FROM event_outbox WHERE status = 'pending'
          UNION ALL
          SELECT next_attempt_at AS next_at FROM ack_projection_outbox WHERE status = 'pending'
        )`,
      )
      .toArray()[0]?.next_at;
    const current = await this.ctx.storage.getAlarm();
    if (pending === null || pending === undefined) {
      if (current !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }
    const scheduled = Math.max(Date.now() + 1_000, pending);
    if (current === null || current > scheduled) {
      await this.ctx.storage.setAlarm(scheduled);
    }
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
      completion_policy TEXT NOT NULL DEFAULT 'NONE',
      correlation_id TEXT NOT NULL DEFAULT '',
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
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      failed_reason TEXT,
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
      created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      PRIMARY KEY (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ack_projection_outbox (
      task_id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ack_projection_fault (
      id INTEGER PRIMARY KEY,
      remaining INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS task_budget_config (
      id INTEGER PRIMARY KEY,
      values_json TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS task_agent_messages (
      employee_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (employee_id, idempotency_key)
    )`);
    this.addColumnIfMissing("tasks", "completion_policy", "TEXT NOT NULL DEFAULT 'NONE'");
    this.addColumnIfMissing("tasks", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("event_outbox", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("event_outbox", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("event_outbox", "failed_reason", "TEXT");
    this.addColumnIfMissing(
      "task_commands",
      "created_at",
      "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
    );
    const missingCorrelation = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM tasks WHERE correlation_id = ''`)
      .toArray();
    for (const row of missingCorrelation) {
      this.ctx.storage.sql.exec(
        `UPDATE tasks SET correlation_id = ? WHERE id = ?`,
        createId("corr"),
        row.id,
      );
    }
  }

  private addColumnIfMissing(table: string, column: string, declaration: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (!columns.some((item) => item.name === column)) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}
