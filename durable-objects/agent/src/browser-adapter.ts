import { DomainError, isId } from "@ai-company/domain";
import type {
  AgentAdapter,
  AgentDelivery,
  AgentSessionRequest,
  Reachability,
} from "@ai-company/domain";
import type { AgentDO } from "./agent-do";

const REACHABILITY = new Set<Reachability>([
  "NATIVE_PUSH",
  "BROWSER_ACTIVE",
  "BROWSER_CONNECTED",
  "POLL_ONLY",
  "MANUAL",
  "UNREACHABLE",
]);

export class BrowserAgentAdapter implements AgentAdapter {
  readonly type = "browser";

  constructor(
    private readonly namespace: DurableObjectNamespace<AgentDO>,
    private readonly db: D1Database,
  ) {}

  async createSession(input: AgentSessionRequest): Promise<{ sessionId: string }> {
    const snap = await this.stub(input.orgId, input.employeeId).snapshot({
      orgId: input.orgId,
      employeeId: input.employeeId,
    });
    if (snap.decision !== "ALLOW" || !snap.sessionId) {
      throw new DomainError("NO_SESSION", "Runtime session is not active.");
    }
    return { sessionId: snap.sessionId };
  }

  async getReachability(input: { orgId: string; employeeId: string }): Promise<Reachability> {
    const snap = await this.stub(input.orgId, input.employeeId).snapshot({
      orgId: input.orgId,
      employeeId: input.employeeId,
    });
    if (REACHABILITY.has(snap.reachability as Reachability)) {
      return snap.reachability as Reachability;
    }
    return "UNREACHABLE";
  }

  async deliver(input: AgentDelivery): Promise<{ delivered: boolean }> {
    const packet = parsePacket(input.payload);
    if (!packet) {
      return { delivered: false };
    }
    const result = await this.stub(input.orgId, input.employeeId).enqueue({
      orgId: input.orgId,
      employeeId: input.employeeId,
      ...packet,
    });
    return {
      delivered: result.decision === "ALLOW" && result.state === "DELIVERED" && !result.duplicate,
    };
  }

  async revoke(input: { sessionId: string }): Promise<void> {
    if (!isId(input.sessionId, "ses")) {
      return;
    }
    const row = await this.db
      .prepare(`SELECT org_id, employee_id FROM runtime_sessions WHERE id = ?`)
      .bind(input.sessionId)
      .first<{ org_id: string; employee_id: string }>();
    if (!row || !isId(row.org_id, "org") || !isId(row.employee_id, "emp")) {
      return;
    }
    await this.stub(row.org_id, row.employee_id).dropSession({
      orgId: row.org_id,
      employeeId: row.employee_id,
      sessionId: input.sessionId,
    });
  }

  private stub(orgId: string, employeeId: string) {
    if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
      throw new DomainError("NOT_FOUND", "Employee was not found.");
    }
    return this.namespace.getByName(`agent:${orgId}:${employeeId}`);
  }
}

function parsePacket(payload: Uint8Array): {
  type: string;
  taskId: string | null;
  roomId: string | null;
  priority: number;
  body: string;
  idempotencyKey: string;
} | null {
  const text = new TextDecoder().decode(payload);
  if (text.length > 4000) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.body !== "string") {
    return null;
  }
  if (typeof record.idempotency_key !== "string") {
    return null;
  }
  const priority = record.priority === undefined ? 0 : record.priority;
  if (typeof priority !== "number") {
    return null;
  }
  const taskId = record.task_id === undefined || record.task_id === null ? null : record.task_id;
  const roomId = record.room_id === undefined || record.room_id === null ? null : record.room_id;
  if (
    (taskId !== null && typeof taskId !== "string") ||
    (roomId !== null && typeof roomId !== "string")
  ) {
    return null;
  }
  return {
    type: record.type,
    taskId,
    roomId,
    priority,
    body: record.body,
    idempotencyKey: record.idempotency_key,
  };
}
