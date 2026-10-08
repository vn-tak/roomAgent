import { isId } from "@ai-company/domain";

export const AGENT_ENVELOPE_VERSION = 1;

export type AgentValue = string | number | boolean | null;

export type AgentData = Record<string, AgentValue>;

export interface AgentEnvelope {
  v: 1;
  type: string;
  data: AgentData;
}

export interface AgentClientMessage {
  type: string;
  data: Record<string, unknown>;
}

const CLIENT_TYPES = new Set(["session.hello", "heartbeat", "inbox.ack", "ping"]);

export function parseAgentMessage(raw: string): AgentClientMessage | null {
  if (raw.length > 8000) {
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
  if (record.v !== AGENT_ENVELOPE_VERSION || typeof record.type !== "string") {
    return null;
  }
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : {};
  if (!CLIENT_TYPES.has(record.type)) {
    return { type: record.type, data };
  }
  return { type: record.type, data };
}

export function isKnownAgentType(type: string): boolean {
  return CLIENT_TYPES.has(type);
}

export function sessionToken(data: Record<string, unknown>): string | null {
  const token = data.token;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    return null;
  }
  return token;
}

export function inboxIdFrom(data: Record<string, unknown>): string | null {
  const inboxId = data.inbox_id;
  if (typeof inboxId !== "string" || !isId(inboxId, "inb")) {
    return null;
  }
  return inboxId;
}

export function agentEnvelope(type: string, data: AgentData): AgentEnvelope {
  return { v: AGENT_ENVELOPE_VERSION, type, data };
}
