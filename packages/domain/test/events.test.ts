import { describe, expect, it } from "vitest";
import {
  artifactObjectKey,
  buildArtifactEvent,
  buildGovernanceEvent,
  createId,
  sha256Hex,
  type TaskDomainEvent,
} from "../src/index";
import { parseDomainEvent } from "../src/events";

function event(overrides: Partial<TaskDomainEvent> = {}): TaskDomainEvent {
  return {
    event_id: createId("evt"),
    event_version: 1,
    org_id: createId("org"),
    room_id: null,
    type: "task.created",
    actor_type: "human",
    actor_id: createId("usr"),
    subject_type: "task",
    subject_id: createId("task"),
    seq: 1,
    correlation_id: createId("corr"),
    causation_id: "create_task_01",
    idempotency_key: "create_task_01",
    occurred_at: "2026-10-09T00:00:00.000Z",
    payload: {
      from_state: null,
      to_state: "CREATED",
      assignee_id: null,
      handoff_count: 0,
      human_review_required: 0,
      pause_reason: null,
    },
    ...overrides,
  };
}

describe("domain events", () => {
  it("keeps a valid envelope and drops fields that are not part of it", () => {
    const body = { ...event(), objective: "Revise the scene." };
    const parsed = parseDomainEvent(body);
    expect(parsed?.type).toBe("task.created");
    expect(parsed && "objective" in parsed).toBe(false);
    if (parsed?.subject_type !== "task") {
      throw new Error("expected a task envelope");
    }
    expect(parsed.payload.pause_reason).toBeNull();
  });

  it("rejects a body that is not a task envelope", () => {
    expect(parseDomainEvent(null)).toBeNull();
    expect(parseDomainEvent({ ...event(), event_version: 2 })).toBeNull();
    expect(parseDomainEvent({ ...event(), org_id: createId("emp") })).toBeNull();
    expect(parseDomainEvent({ ...event(), type: "artifact.approved" })).toBeNull();
    const smuggled = event();
    const payload = { ...smuggled.payload, objective: "secret objective" };
    const parsed = parseDomainEvent({ ...smuggled, payload });
    if (parsed?.subject_type !== "task") {
      throw new Error("expected a task envelope");
    }
    expect(parsed.payload).toEqual(smuggled.payload);
  });

  it("keeps an artifact version envelope and drops bytes, filename, and objective", () => {
    const orgId = createId("org");
    const roomId = createId("room");
    const artifactId = createId("art");
    const body = buildArtifactEvent({
      orgId,
      actorType: "employee",
      actorId: createId("emp"),
      idempotencyKey: "artifact_v1_key",
      occurredAt: "2026-10-09T00:00:00.000Z",
      roomId,
      artifactId,
      version: 1,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      mediaType: "text/plain",
      size: 3,
      r2Key: artifactObjectKey(orgId, roomId, artifactId, 1),
    });
    const parsed = parseDomainEvent({
      ...body,
      objective: "approve this",
      filename: "shot17.mp4",
      bytes: "aaaa",
    });
    expect(parsed).toEqual(body);
    expect(parsed && "filename" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("shot17.mp4");
    expect(JSON.stringify(parsed)).not.toContain("approve this");
    expect(parseDomainEvent({ ...body, type: "artifact.approved" })).toBeNull();
    expect(
      parseDomainEvent({
        ...body,
        payload: { ...body.payload, r2_key: `org/${orgId}/shot17.mp4` },
      }),
    ).toBeNull();
  });

  it("keeps a governance envelope and drops review text", async () => {
    const orgId = createId("org");
    const roomId = createId("room");
    const artifactId = createId("art");
    const digest = await sha256Hex("final|record|artifact|1|PASS|ALLOW|ALLOWED");
    const body = buildGovernanceEvent({
      eventId: createId("evt"),
      correlationId: createId("corr"),
      type: "approval.denied",
      orgId,
      actorType: "employee",
      actorId: createId("emp"),
      idempotencyKey: "self_approve_1",
      occurredAt: "2026-10-09T00:00:00.000Z",
      roomId,
      artifactId,
      version: 1,
      recordId: createId("apr"),
      result: "PASS",
      decision: "DENY",
      reason: "NO_SELF_APPROVAL",
      kind: "final",
      policyVersion: 1,
      beforeDigest: null,
      afterDigest: digest,
    });
    const parsed = parseDomainEvent({
      ...body,
      objective: "approve this",
      filename: "shot17.mp4",
      bytes: "aaaa",
    });
    expect(parsed).toEqual(body);
    expect(JSON.stringify(parsed)).not.toContain("shot17.mp4");
    expect(JSON.stringify(parsed)).not.toContain("approve this");
    expect(parseDomainEvent({ ...body, type: "artifact.approved" })).toBeNull();
    expect(parseDomainEvent({ ...body, type: "approval.granted" })).toBeNull();
    expect(
      parseDomainEvent({
        ...body,
        payload: { ...body.payload, kind: "review", comment: "looks fine" },
      }),
    ).toBeNull();
  });
});
