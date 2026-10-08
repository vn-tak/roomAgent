export const TASK_STATES = [
  "CREATED",
  "QUEUED",
  "DELIVERED",
  "ACKNOWLEDGED",
  "WORKING",
  "SUBMITTED",
  "REVIEW",
  "REVISION",
  "APPROVED",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "EXPIRED",
  "BLOCKED",
  "PAUSED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TASK_COMMANDS = [
  "create",
  "assign",
  "deliver",
  "ack",
  "start",
  "submit",
  "request_revision",
  "approve",
  "complete",
  "fail",
  "cancel",
] as const;

export type TaskCommandName = (typeof TASK_COMMANDS)[number];

export const MAX_HANDOFFS = 8;

const TERMINAL: ReadonlySet<TaskState> = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

const OPEN: Partial<Record<TaskState, TaskState>> = {
  CREATED: "FAILED",
  QUEUED: "FAILED",
  DELIVERED: "FAILED",
  ACKNOWLEDGED: "FAILED",
  WORKING: "FAILED",
  SUBMITTED: "FAILED",
  REVIEW: "FAILED",
  REVISION: "FAILED",
  APPROVED: "FAILED",
  EXPIRED: "FAILED",
  BLOCKED: "FAILED",
  PAUSED: "FAILED",
};

const NEXT: Record<Exclude<TaskCommandName, "create">, Partial<Record<TaskState, TaskState>>> = {
  assign: {
    CREATED: "QUEUED",
    QUEUED: "QUEUED",
    DELIVERED: "QUEUED",
    ACKNOWLEDGED: "QUEUED",
    WORKING: "QUEUED",
    SUBMITTED: "QUEUED",
    REVIEW: "QUEUED",
    REVISION: "QUEUED",
  },
  deliver: { QUEUED: "DELIVERED" },
  ack: { DELIVERED: "ACKNOWLEDGED" },
  start: { ACKNOWLEDGED: "WORKING", REVISION: "WORKING" },
  submit: { WORKING: "REVIEW" },
  request_revision: { REVIEW: "REVISION" },
  approve: { REVIEW: "APPROVED" },
  complete: { APPROVED: "COMPLETED" },
  fail: OPEN,
  cancel: {
    CREATED: "CANCELLED",
    QUEUED: "CANCELLED",
    DELIVERED: "CANCELLED",
    ACKNOWLEDGED: "CANCELLED",
    WORKING: "CANCELLED",
    SUBMITTED: "CANCELLED",
    REVIEW: "CANCELLED",
    REVISION: "CANCELLED",
    APPROVED: "CANCELLED",
    EXPIRED: "CANCELLED",
    BLOCKED: "CANCELLED",
    PAUSED: "CANCELLED",
  },
};

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function isTaskCommand(value: string): value is TaskCommandName {
  return (TASK_COMMANDS as readonly string[]).includes(value);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL.has(state);
}

export function nextTaskState(from: TaskState | null, command: TaskCommandName): TaskState | null {
  if (command === "create") {
    return from === null ? "CREATED" : null;
  }
  if (from === null) {
    return null;
  }
  return NEXT[command][from] ?? null;
}

export function dependencyCycle(
  edges: ReadonlyMap<string, readonly string[]>,
  taskId: string,
  roots: readonly string[],
): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === taskId) {
      return true;
    }
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return (edges.get(id) ?? []).some((next) => visit(next));
  };
  return roots.some((root) => root === taskId || visit(root));
}
