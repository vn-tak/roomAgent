import type { AgentDO } from "@ai-company/agent";
import { parseDomainEvent, type DomainEvent } from "@ai-company/domain";
import {
  AGENT_DELIVERY_QUEUE,
  DEAD_LETTER_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  FAULT_AGENT,
  FAULT_CRASH,
  FAULT_D1,
} from "./names";
import { bumpEventCounter, takeEventFault } from "./test-seam";

const DELIVERY_TIMEOUT_MS = 5_000;

interface EventBindings {
  DB: D1Database;
  AGENT: DurableObjectNamespace<AgentDO>;
  AGENT_DELIVERY: Queue;
}

export async function handleQueue(batch: MessageBatch<unknown>, env: EventBindings): Promise<void> {
  for (const message of batch.messages) {
    try {
      await dispatch(batch.queue, message, env);
      message.ack();
    } catch (error) {
      noteFailure(batch.queue, error);
      message.retry();
    }
  }
}

async function dispatch(
  queue: string,
  message: Message<unknown>,
  env: EventBindings,
): Promise<void> {
  if (queue === DOMAIN_EVENTS_QUEUE) {
    await consumeDomain(message, env);
    return;
  }
  if (queue === AGENT_DELIVERY_QUEUE) {
    await consumeDelivery(message, env);
    return;
  }
  if (queue === DEAD_LETTER_QUEUE) {
    await consumeDeadLetter(message, env);
    return;
  }
  throw new EventDeliveryError("UNKNOWN_QUEUE");
}

async function consumeDomain(message: Message<unknown>, env: EventBindings): Promise<void> {
  await bumpEventCounter(env, "domain");
  if (await takeEventFault(env, FAULT_CRASH)) {
    throw new EventDeliveryError("CONSUMER_CRASH");
  }
  if (await takeEventFault(env, FAULT_D1)) {
    throw new EventDeliveryError("D1_UNAVAILABLE");
  }
  const event = parseDomainEvent(message.body);
  if (!event) {
    throw new EventDeliveryError("INVALID_EVENT");
  }
  const at = new Date().toISOString();
  await insertDomain(env, event, at);
  await insertAudit(env, event, at);
  if (event.type === "task.delivered") {
    await env.AGENT_DELIVERY.send(event);
  }
}

async function consumeDelivery(message: Message<unknown>, env: EventBindings): Promise<void> {
  await bumpEventCounter(env, "agent");
  if (await takeEventFault(env, FAULT_AGENT)) {
    throw new EventDeliveryError("AGENT_DELIVERY_TIMEOUT");
  }
  const event = parseDomainEvent(message.body);
  if (!event || event.type !== "task.delivered" || !event.payload.assignee_id) {
    throw new EventDeliveryError("INVALID_EVENT");
  }
  const task = await env.DB.prepare(
    `SELECT id, objective, creator_id, room_id
     FROM tasks WHERE org_id = ? AND id = ?`,
  )
    .bind(event.org_id, event.subject_id)
    .first<{ id: string; objective: string; creator_id: string; room_id: string | null }>();
  if (!task) {
    throw new EventDeliveryError("DELIVERY_UNAVAILABLE");
  }
  const body = JSON.stringify({
    task_id: task.id,
    objective: task.objective,
    requested_by: task.creator_id,
  });
  if (body.length > 4000) {
    throw new EventDeliveryError("DELIVERY_DENIED");
  }
  const inbox = await withTimeout(
    env.AGENT.getByName(`agent:${event.org_id}:${event.payload.assignee_id}`).enqueue({
      orgId: event.org_id,
      employeeId: event.payload.assignee_id,
      type: "task",
      taskId: task.id,
      roomId: task.room_id,
      priority: 0,
      body,
      idempotencyKey: event.idempotency_key,
    }),
    DELIVERY_TIMEOUT_MS,
  );
  if (inbox.decision === "DENY") {
    throw new EventDeliveryError("DELIVERY_DENIED");
  }
}

async function consumeDeadLetter(message: Message<unknown>, env: EventBindings): Promise<void> {
  await bumpEventCounter(env, "dlq");
  const event = parseDomainEvent(message.body);
  const at = new Date().toISOString();
  const attempts = message.attempts >= 1 ? message.attempts : 1;
  try {
    await insertDeadLetter(
      env,
      message.id,
      event?.event_id ?? null,
      event?.org_id ?? null,
      attempts,
      at,
    );
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("TENANT_MISMATCH")) {
      throw error;
    }
    await insertDeadLetter(env, message.id, event?.event_id ?? null, null, attempts, at);
  }
}

async function insertDomain(env: EventBindings, event: DomainEvent, at: string): Promise<void> {
  const body = JSON.stringify(event);
  await env.DB.prepare(
    `INSERT INTO domain_events (
      event_id, org_id, room_id, type, actor_type, actor_id, subject_type, subject_id, seq,
      correlation_id, causation_id, idempotency_key, occurred_at, body, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`,
  )
    .bind(
      event.event_id,
      event.org_id,
      event.room_id,
      event.type,
      event.actor_type,
      event.actor_id,
      event.subject_type,
      event.subject_id,
      event.seq,
      event.correlation_id,
      event.causation_id,
      event.idempotency_key,
      event.occurred_at,
      body,
      at,
    )
    .run();
}

function auditMetadata(event: DomainEvent): {
  authorizationDecision: string | null;
  policyVersion: number | null;
  beforeDigest: string | null;
  afterDigest: string | null;
} {
  if (
    event.type !== "review.recorded" &&
    event.type !== "approval.granted" &&
    event.type !== "approval.denied"
  ) {
    return {
      authorizationDecision: null,
      policyVersion: null,
      beforeDigest: null,
      afterDigest: null,
    };
  }
  return {
    authorizationDecision: event.payload.decision,
    policyVersion: event.payload.policy_version,
    beforeDigest: event.payload.before_digest,
    afterDigest: event.payload.after_digest,
  };
}

async function insertAudit(env: EventBindings, event: DomainEvent, at: string): Promise<void> {
  const audit = auditMetadata(event);
  await env.DB.prepare(
    `INSERT INTO audit_events (
      event_id, org_id, type, actor_type, actor_id, subject_type, subject_id, seq, occurred_at, recorded_at,
      authorization_decision, policy_version, before_digest, after_digest, correlation_id, causation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING`,
  )
    .bind(
      event.event_id,
      event.org_id,
      event.type,
      event.actor_type,
      event.actor_id,
      event.subject_type,
      event.subject_id,
      event.seq,
      event.occurred_at,
      at,
      audit.authorizationDecision,
      audit.policyVersion,
      audit.beforeDigest,
      audit.afterDigest,
      event.correlation_id,
      event.causation_id,
    )
    .run();
}

async function insertDeadLetter(
  env: EventBindings,
  messageId: string,
  eventId: string | null,
  orgId: string | null,
  attempts: number,
  at: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dead_letters (
      message_id, queue_name, event_id, org_id, reason, attempts, recorded_at
    ) VALUES (?, ?, ?, ?, 'MAX_RETRIES', ?, ?)
    ON CONFLICT(message_id) DO NOTHING`,
  )
    .bind(messageId, DEAD_LETTER_QUEUE, eventId, orgId, attempts, at)
    .run();
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new EventDeliveryError("AGENT_DELIVERY_TIMEOUT"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class EventDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventDeliveryError";
  }
}

function noteFailure(queue: string, error: unknown): void {
  if (error instanceof EventDeliveryError) {
    return;
  }
  const name = error instanceof Error ? error.name : "Error";
  console.log(JSON.stringify({ level: "error", queue, name }));
}
