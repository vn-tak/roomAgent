import { parseDomainEvent, type DomainEvent } from "@ai-company/domain";
import type { TaskCommand, TaskResult } from "@ai-company/task";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAULT_AGENT, FAULT_CRASH, FAULT_D1 } from "../src/events/names";
import { armEventFault, clearEventFaults, readEventCounter } from "../src/events/test-seam";
import { agentStub, createStudio, hire, taskStub } from "./helpers";

afterEach(async () => {
  await clearEventFaults(env.DB);
});

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
}

async function until(assertion: () => Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      await pump();
      await assertion();
    },
    { timeout: 8_000, interval: 20 },
  );
}

async function run(
  actor: { orgId: string; actorType: "human" | "employee"; actorId: string },
  command: TaskCommand["command"],
  fields: {
    key: string;
    taskId?: string;
    assigneeId?: string;
    title?: string;
    objective?: string;
  },
): Promise<TaskResult> {
  return taskStub(actor.orgId).execute({
    orgId: actor.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    idempotencyKey: fields.key,
    command,
    taskId: fields.taskId ?? null,
    assigneeId: fields.assigneeId ?? null,
    title: fields.title ?? null,
    objective: fields.objective ?? null,
    roomId: null,
    dependsOn: [],
  });
}

async function countWhere(sql: string, orgId: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function domainCount(orgId: string): Promise<number> {
  return countWhere(`SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ?`, orgId);
}

async function auditCount(orgId: string): Promise<number> {
  return countWhere(`SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`, orgId);
}

async function deadCount(orgId: string): Promise<number> {
  return countWhere(`SELECT COUNT(*) AS n FROM dead_letters WHERE org_id = ?`, orgId);
}

async function storedEvent(orgId: string, type: string): Promise<DomainEvent> {
  const row = await env.DB.prepare(`SELECT body FROM domain_events WHERE org_id = ? AND type = ?`)
    .bind(orgId, type)
    .first<{ body: string }>();
  const parsed = parseDomainEvent(JSON.parse(row?.body ?? "null") as unknown);
  if (!parsed) {
    throw new Error("Stored event is not an envelope.");
  }
  return parsed;
}

describe("event delivery", () => {
  it("publishes one event after the task commit and ignores a duplicate delivery", async () => {
    const studio = await createStudio("Event bus");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const created = await run(owner, "create", {
      key: "create_event_01",
      title: "Scene board",
      objective: "Revise the scene.",
    });
    expect(created.decision).toBe("ALLOW");
    await until(async () => {
      expect(await domainCount(studio.org.id)).toBe(1);
      expect(await auditCount(studio.org.id)).toBe(1);
    });
    const stored = await storedEvent(studio.org.id, "task.created");
    expect(stored.idempotency_key).toBe("create_event_01");
    expect(stored.causation_id).toBe("create_event_01");
    expect(stored.correlation_id.startsWith("corr_")).toBe(true);
    expect(stored.payload).toMatchObject({ from_state: null, to_state: "CREATED" });
    expect(JSON.stringify(stored)).not.toContain("Revise the scene.");
    await env.DOMAIN_EVENTS.send(stored);
    await until(async () => {
      expect(await domainCount(studio.org.id)).toBe(1);
      expect(await auditCount(studio.org.id)).toBe(1);
    });
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`)
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(tasks?.n).toBe(1);
  });

  it("keeps the task when publish fails and the replay sends the same event once", async () => {
    const studio = await createStudio("Event outbox");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const armed = await taskStub(studio.org.id).armPublishFault(1);
    expect(armed.armed).toBe(true);
    const created = await run(owner, "create", {
      key: "create_outbox_01",
      title: "Held event",
      objective: "Stay committed.",
    });
    expect(created).toMatchObject({ decision: "ALLOW", duplicate: false, state: "CREATED" });
    await pump();
    expect(await domainCount(studio.org.id)).toBe(0);
    const again = await run(owner, "create", {
      key: "create_outbox_01",
      title: "Held event",
      objective: "Stay committed.",
    });
    expect(again.duplicate).toBe(true);
    await until(async () => {
      expect(await domainCount(studio.org.id)).toBe(1);
      expect(await auditCount(studio.org.id)).toBe(1);
    });
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ?`)
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(tasks?.n).toBe(1);
  });

  it("retries a consumer crash and a temporary D1 failure without a second row", async () => {
    const studio = await createStudio("Event retry");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const before = await readEventCounter(env.DB, "domain");
    await armEventFault(env.DB, FAULT_CRASH, 1);
    await run(owner, "create", {
      key: "create_crash_01",
      title: "Crash once",
      objective: "Retry the bus.",
    });
    await until(async () => {
      expect(await domainCount(studio.org.id)).toBe(1);
      expect((await readEventCounter(env.DB, "domain")) - before).toBeGreaterThanOrEqual(2);
    });
    expect(await deadCount(studio.org.id)).toBe(0);

    const worker = await hire(studio.store, studio.org.id, "Worker");
    await armEventFault(env.DB, FAULT_D1, 1);
    const d1Before = await readEventCounter(env.DB, "domain");
    await run(owner, "assign", {
      key: "assign_d1_01",
      taskId: (await domainTaskId(studio.org.id)) ?? "",
      assigneeId: worker.id,
    });
    await until(async () => {
      expect(await domainCount(studio.org.id)).toBe(2);
      expect((await readEventCounter(env.DB, "domain")) - d1Before).toBeGreaterThanOrEqual(2);
    });
    expect(await auditCount(studio.org.id)).toBe(2);
    expect(await deadCount(studio.org.id)).toBe(0);
  });

  it("retries an agent delivery timeout and then hands off once", async () => {
    const studio = await createStudio("Event delivery timeout");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const created = await run(owner, "create", {
      key: "create_timeout_01",
      title: "Deliver once",
      objective: "Packet text stays in D1.",
    });
    await run(owner, "assign", {
      key: "assign_timeout_01",
      taskId: created.taskId ?? "",
      assigneeId: worker.id,
    });
    await armEventFault(env.DB, FAULT_AGENT, 1);
    const before = await readEventCounter(env.DB, "agent");
    const delivered = await run(owner, "deliver", {
      key: "deliver_timeout_01",
      taskId: created.taskId ?? "",
    });
    expect(delivered).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    await until(async () => {
      expect((await readEventCounter(env.DB, "agent")) - before).toBeGreaterThanOrEqual(2);
      expect(await domainCount(studio.org.id)).toBe(3);
    });
    expect(await deadCount(studio.org.id)).toBe(0);
    const snap = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(snap.pending).toBe(1);
    expect(snap.currentTaskId).toBeNull();
    const stored = await storedEvent(studio.org.id, "task.delivered");
    await env.AGENT_DELIVERY.send(stored);
    await pump();
    const again = await agentStub(studio.org.id, worker.id).snapshot({
      orgId: studio.org.id,
      employeeId: worker.id,
    });
    expect(again.pending).toBe(1);
    expect(again.currentTaskId).toBeNull();
  });

  it("moves a message to the dead letter queue after the retry budget", async () => {
    const studio = await createStudio("Event dead letter");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    await armEventFault(env.DB, FAULT_CRASH, 8);
    const beforeDlq = await readEventCounter(env.DB, "dlq");
    await run(owner, "create", {
      key: "create_dlq_01",
      title: "Poison event",
      objective: "Do not persist.",
    });
    await until(async () => {
      expect(await deadCount(studio.org.id)).toBe(1);
      expect((await readEventCounter(env.DB, "dlq")) - beforeDlq).toBeGreaterThanOrEqual(1);
    });
    expect(await domainCount(studio.org.id)).toBe(0);
    expect(await auditCount(studio.org.id)).toBe(0);
    const letter = await env.DB.prepare(
      `SELECT reason, attempts FROM dead_letters WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .first<{ reason: string; attempts: number }>();
    expect(letter?.reason).toBe("MAX_RETRIES");
    expect(letter?.attempts).toBeGreaterThanOrEqual(1);

    const beforeNull = await nullDeadLetters();
    await env.DOMAIN_EVENTS.send({ event_id: "not-an-event" });
    await until(async () => {
      expect(await nullDeadLetters()).toBe(beforeNull + 1);
    });
    expect(await domainCount(studio.org.id)).toBe(0);
  });
});

async function domainTaskId(orgId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT id FROM tasks WHERE org_id = ?`)
    .bind(orgId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function nullDeadLetters(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM dead_letters WHERE event_id IS NULL`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}
