import { isId } from "@ai-company/domain";

export const ROOM_ENVELOPE_VERSION = 1;
export const MAX_REPLAY = 100;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_MESSAGE_BYTES = 8000;

export type RoomValue = string | number | boolean | null;

export type RoomData = Record<string, RoomValue>;

export interface RoomEnvelope {
  v: 1;
  type: string;
  event_id: string;
  seq: number;
  data: RoomData;
}

export interface ClientMessage {
  type: string;
  lastSeenSeq: number | null;
  data: Record<string, unknown>;
}

const CLIENT_TYPES = new Set([
  "session.hello",
  "presence.update",
  "message.send",
  "ping",
  "task.ack",
  "task.start",
  "task.submit",
  "artifact.submit",
]);

const UNAVAILABLE_TYPES = new Set(["artifact.submit"]);

export function isUnavailableClientType(type: string): boolean {
  return UNAVAILABLE_TYPES.has(type);
}

export function isKnownClientType(type: string): boolean {
  return CLIENT_TYPES.has(type);
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (
    raw.length > MAX_MESSAGE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== ROOM_ENVELOPE_VERSION || typeof record.type !== "string") {
    return null;
  }
  if (!isKnownClientType(record.type)) {
    return { type: record.type, lastSeenSeq: null, data: {} };
  }
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  return {
    type: record.type,
    lastSeenSeq: readSequence(record.last_seen_seq),
    data,
  };
}

export function readSequence(value: unknown): number | null {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

export function messageBody(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const body = value.trim();
  if (body.length < 1 || body.length > MAX_MESSAGE_CHARS) {
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

export function idempotencyKey(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    return null;
  }
  return value;
}

export function presenceState(value: unknown): "online" | "away" | null {
  if (value === "online" || value === "away") {
    return value;
  }
  return null;
}

export function sessionToken(data: Record<string, unknown>): string | null {
  const token = data.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    return null;
  }
  return token;
}

export function employeeFrom(data: Record<string, unknown>): string | null {
  const employeeId = data.employee_id;
  if (typeof employeeId !== "string" || !isId(employeeId, "emp")) {
    return null;
  }
  return employeeId;
}

export function taskSubject(
  data: Record<string, unknown>,
): { taskId: string; status: string } | null {
  const taskId = data.task_id;
  const status = data.status;
  if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) {
    return null;
  }
  if (typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status)) {
    return null;
  }
  return { taskId, status };
}

export function envelope(type: string, eventId: string, seq: number, data: RoomData): RoomEnvelope {
  return { v: ROOM_ENVELOPE_VERSION, type, event_id: eventId, seq, data };
}
