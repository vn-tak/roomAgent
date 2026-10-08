import { artifactObjectKey, canonicalMediaType, MAX_DIRECT_ARTIFACT_BYTES } from "./artifact";
import { createId, isId } from "./ids";
import { isTaskState, type TaskCommandName, type TaskState } from "./task-machine";

export const EVENT_VERSION = 1;

const TASK_EVENT_TYPES = [
  "task.created",
  "task.assigned",
  "task.paused",
  "task.delivered",
  "task.acknowledged",
  "task.started",
  "task.submitted",
  "task.revision_requested",
  "task.approved",
  "task.completed",
  "task.failed",
  "task.cancelled",
] as const;

export const ARTIFACT_EVENT_TYPE = "artifact.version.created" as const;

export const REVIEW_RESULTS = ["PASS", "FAIL", "REVISION_REQUIRED"] as const;

export const GOVERNANCE_EVENT_TYPES = [
  "review.recorded",
  "approval.granted",
  "approval.denied",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];
export type ArtifactEventType = typeof ARTIFACT_EVENT_TYPE;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];
export type GovernanceEventType = (typeof GOVERNANCE_EVENT_TYPES)[number];
export type GovernanceKind = "review" | "final" | "security";

export interface TaskEventPayload {
  from_state: TaskState | null;
  to_state: TaskState;
  assignee_id: string | null;
  handoff_count: number;
  human_review_required: 0 | 1;
  pause_reason: string | null;
}

export interface ArtifactEventPayload {
  version: number;
  sha256: string;
  media_type: string;
  size: number;
  r2_key: string;
}

export interface GovernanceEventPayload {
  record_id: string;
  artifact_version: number;
  result: ReviewResult;
  decision: "ALLOW" | "DENY";
  reason: "ALLOWED" | "NO_SELF_APPROVAL";
  kind: GovernanceKind;
  policy_version: number;
  before_digest: string | null;
  after_digest: string;
}

interface EventEnvelope {
  event_id: string;
  event_version: typeof EVENT_VERSION;
  org_id: string;
  room_id: string | null;
  type: string;
  actor_type: "human" | "employee";
  actor_id: string;
  subject_type: string;
  subject_id: string;
  seq: number;
  correlation_id: string;
  causation_id: string;
  idempotency_key: string;
  occurred_at: string;
}

export interface TaskDomainEvent extends EventEnvelope {
  type: TaskEventType;
  subject_type: "task";
  payload: TaskEventPayload;
}

export interface ArtifactDomainEvent extends EventEnvelope {
  type: ArtifactEventType;
  subject_type: "artifact";
  room_id: string;
  payload: ArtifactEventPayload;
}

export interface GovernanceDomainEvent extends EventEnvelope {
  type: GovernanceEventType;
  subject_type: "artifact";
  room_id: string;
  payload: GovernanceEventPayload;
}

export type DomainEvent = TaskDomainEvent | ArtifactDomainEvent | GovernanceDomainEvent;

export interface TaskEventInput {
  correlationId?: string;
  causationId?: string;
  command: TaskCommandName;
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  occurredAt: string;
  taskId: string;
  fromState: TaskState | null;
  state: TaskState;
  assigneeId: string | null;
  roomId: string | null;
  handoffCount: number;
  humanReviewRequired: number;
  pauseReason: string | null;
  version: number;
}

export interface ArtifactEventInput {
  correlationId?: string;
  causationId?: string;
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  occurredAt: string;
  roomId: string;
  artifactId: string;
  version: number;
  sha256: string;
  mediaType: string;
  size: number;
  r2Key: string;
}

export interface GovernanceEventInput {
  causationId?: string;
  eventId: string;
  correlationId: string;
  type: GovernanceEventType;
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  occurredAt: string;
  roomId: string;
  artifactId: string;
  version: number;
  recordId: string;
  result: ReviewResult;
  decision: "ALLOW" | "DENY";
  reason: "ALLOWED" | "NO_SELF_APPROVAL";
  kind: GovernanceKind;
  policyVersion: number;
  beforeDigest: string | null;
  afterDigest: string;
}

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const PAUSE = /^[A-Z0-9_]{1,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function taskEventType(command: TaskCommandName, paused: boolean): TaskEventType {
  if (paused) {
    return "task.paused";
  }
  switch (command) {
    case "create":
      return "task.created";
    case "assign":
      return "task.assigned";
    case "deliver":
      return "task.delivered";
    case "ack":
      return "task.acknowledged";
    case "start":
      return "task.started";
    case "submit":
      return "task.submitted";
    case "request_revision":
      return "task.revision_requested";
    case "approve":
      return "task.approved";
    case "complete":
      return "task.completed";
    case "fail":
      return "task.failed";
    case "cancel":
      return "task.cancelled";
  }
}

export function buildTaskEvent(input: TaskEventInput): TaskDomainEvent {
  const paused = input.state === "PAUSED";
  const review = input.humanReviewRequired === 1 ? 1 : 0;
  return {
    event_id: createId("evt"),
    event_version: EVENT_VERSION,
    org_id: input.orgId,
    room_id: input.roomId,
    type: taskEventType(input.command, paused),
    actor_type: input.actorType,
    actor_id: input.actorId,
    subject_type: "task",
    subject_id: input.taskId,
    seq: input.version,
    correlation_id: input.correlationId ?? createId("corr"),
    causation_id: input.causationId ?? input.idempotencyKey,
    idempotency_key: input.idempotencyKey,
    occurred_at: input.occurredAt,
    payload: {
      from_state: input.fromState,
      to_state: input.state,
      assignee_id: input.assigneeId,
      handoff_count: input.handoffCount,
      human_review_required: review,
      pause_reason: input.pauseReason,
    },
  };
}

export function isReviewResult(value: string): value is ReviewResult {
  return (REVIEW_RESULTS as readonly string[]).includes(value);
}

export function buildGovernanceEvent(input: GovernanceEventInput): GovernanceDomainEvent {
  return {
    event_id: input.eventId,
    event_version: EVENT_VERSION,
    org_id: input.orgId,
    room_id: input.roomId,
    type: input.type,
    actor_type: input.actorType,
    actor_id: input.actorId,
    subject_type: "artifact",
    subject_id: input.artifactId,
    seq: input.version,
    correlation_id: input.correlationId,
    causation_id: input.causationId ?? input.idempotencyKey,
    idempotency_key: input.idempotencyKey,
    occurred_at: input.occurredAt,
    payload: {
      record_id: input.recordId,
      artifact_version: input.version,
      result: input.result,
      decision: input.decision,
      reason: input.reason,
      kind: input.kind,
      policy_version: input.policyVersion,
      before_digest: input.beforeDigest,
      after_digest: input.afterDigest,
    },
  };
}

export function buildArtifactEvent(input: ArtifactEventInput): ArtifactDomainEvent {
  return {
    event_id: createId("evt"),
    event_version: EVENT_VERSION,
    org_id: input.orgId,
    room_id: input.roomId,
    type: ARTIFACT_EVENT_TYPE,
    actor_type: input.actorType,
    actor_id: input.actorId,
    subject_type: "artifact",
    subject_id: input.artifactId,
    seq: input.version,
    correlation_id: input.correlationId ?? createId("corr"),
    causation_id: input.causationId ?? input.idempotencyKey,
    idempotency_key: input.idempotencyKey,
    occurred_at: input.occurredAt,
    payload: {
      version: input.version,
      sha256: input.sha256,
      media_type: input.mediaType,
      size: input.size,
      r2_key: input.r2Key,
    },
  };
}

export function parseDomainEvent(value: unknown): DomainEvent | null {
  const envelope = parseEnvelope(value);
  if (!envelope || !isRecord(value)) {
    return null;
  }
  if (envelope.type === ARTIFACT_EVENT_TYPE) {
    return parseArtifactEvent(envelope, value.payload);
  }
  if (isGovernanceEventType(envelope.type)) {
    return parseGovernanceEvent(envelope, envelope.type, value.payload);
  }
  if (!isTaskEventType(envelope.type)) {
    return null;
  }
  return parseTaskEvent(envelope, envelope.type, value.payload);
}

function parseTaskEvent(
  envelope: EventEnvelope,
  type: TaskEventType,
  payloadValue: unknown,
): TaskDomainEvent | null {
  if (envelope.subject_type !== "task" || !isId(envelope.subject_id, "task")) {
    return null;
  }
  const payload = parseTaskPayload(payloadValue);
  if (!payload) {
    return null;
  }
  return {
    ...envelope,
    type,
    subject_type: "task",
    payload,
  };
}

function parseArtifactEvent(
  envelope: EventEnvelope,
  payloadValue: unknown,
): ArtifactDomainEvent | null {
  if (
    envelope.subject_type !== "artifact" ||
    !isId(envelope.subject_id, "art") ||
    envelope.room_id === null
  ) {
    return null;
  }
  const payload = parseArtifactPayload(payloadValue, envelope);
  if (!payload) {
    return null;
  }
  return {
    ...envelope,
    room_id: envelope.room_id,
    type: ARTIFACT_EVENT_TYPE,
    subject_type: "artifact",
    payload,
  };
}

function parseEnvelope(value: unknown): EventEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = readString(value, "event_id");
  const orgId = readString(value, "org_id");
  const type = readString(value, "type");
  const actorType = readString(value, "actor_type");
  const actorId = readString(value, "actor_id");
  const subjectType = readString(value, "subject_type");
  const subjectId = readString(value, "subject_id");
  const correlationId = readString(value, "correlation_id");
  const causationId = readString(value, "causation_id");
  const idempotencyKey = readString(value, "idempotency_key");
  const occurredAt = readString(value, "occurred_at");
  const roomId = readNullableString(value, "room_id");
  const seq = value.seq;
  if (
    value.event_version !== EVENT_VERSION ||
    !eventId ||
    !isId(eventId, "evt") ||
    !orgId ||
    !isId(orgId, "org") ||
    !type ||
    (actorType !== "human" && actorType !== "employee") ||
    !actorId ||
    (actorType === "human" ? !isId(actorId, "usr") : !isId(actorId, "emp")) ||
    !subjectType ||
    !subjectId ||
    !Number.isInteger(seq) ||
    typeof seq !== "number" ||
    seq < 1 ||
    seq > 1_000_000 ||
    !correlationId ||
    !isId(correlationId, "corr") ||
    !causationId ||
    !KEY.test(causationId) ||
    !idempotencyKey ||
    !KEY.test(idempotencyKey) ||
    !occurredAt ||
    !WHEN.test(occurredAt) ||
    roomId === undefined ||
    (roomId !== null && !isId(roomId, "room"))
  ) {
    return null;
  }
  return {
    event_id: eventId,
    event_version: EVENT_VERSION,
    org_id: orgId,
    room_id: roomId,
    type,
    actor_type: actorType,
    actor_id: actorId,
    subject_type: subjectType,
    subject_id: subjectId,
    seq,
    correlation_id: correlationId,
    causation_id: causationId,
    idempotency_key: idempotencyKey,
    occurred_at: occurredAt,
  };
}

function isTaskEventType(value: string): value is TaskEventType {
  return (TASK_EVENT_TYPES as readonly string[]).includes(value);
}

function isGovernanceEventType(value: string): value is GovernanceEventType {
  return (GOVERNANCE_EVENT_TYPES as readonly string[]).includes(value);
}

function parseGovernanceEvent(
  envelope: EventEnvelope,
  type: GovernanceEventType,
  payloadValue: unknown,
): GovernanceDomainEvent | null {
  if (
    envelope.subject_type !== "artifact" ||
    !isId(envelope.subject_id, "art") ||
    envelope.room_id === null
  ) {
    return null;
  }
  const payload = parseGovernancePayload(payloadValue, envelope, type);
  if (!payload) {
    return null;
  }
  return {
    ...envelope,
    room_id: envelope.room_id,
    type,
    subject_type: "artifact",
    payload,
  };
}

function parseGovernancePayload(
  value: unknown,
  envelope: EventEnvelope,
  type: GovernanceEventType,
): GovernanceEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const recordId = readString(value, "record_id");
  const result = readString(value, "result");
  const decision = readString(value, "decision");
  const reason = readString(value, "reason");
  const kind = readString(value, "kind");
  const beforeDigest = readNullableString(value, "before_digest");
  const afterDigest = readString(value, "after_digest");
  const artifactVersion = value.artifact_version;
  const policyVersion = value.policy_version;
  const recordPrefix = type === "review.recorded" ? "rev" : "apr";
  if (
    !recordId ||
    !isId(recordId, recordPrefix) ||
    !Number.isInteger(artifactVersion) ||
    typeof artifactVersion !== "number" ||
    artifactVersion !== envelope.seq ||
    !result ||
    !isReviewResult(result) ||
    (decision !== "ALLOW" && decision !== "DENY") ||
    (reason !== "ALLOWED" && reason !== "NO_SELF_APPROVAL") ||
    (kind !== "review" && kind !== "final" && kind !== "security") ||
    !Number.isInteger(policyVersion) ||
    typeof policyVersion !== "number" ||
    policyVersion < 1 ||
    policyVersion > 1_000_000 ||
    beforeDigest === undefined ||
    (beforeDigest !== null && !SHA256.test(beforeDigest)) ||
    !afterDigest ||
    !SHA256.test(afterDigest) ||
    !governanceShape(type, result, decision, reason, kind)
  ) {
    return null;
  }
  return {
    record_id: recordId,
    artifact_version: artifactVersion,
    result,
    decision,
    reason,
    kind,
    policy_version: policyVersion,
    before_digest: beforeDigest,
    after_digest: afterDigest,
  };
}

function governanceShape(
  type: GovernanceEventType,
  result: ReviewResult,
  decision: "ALLOW" | "DENY",
  reason: "ALLOWED" | "NO_SELF_APPROVAL",
  kind: GovernanceKind,
): boolean {
  if (type === "review.recorded") {
    return kind === "review" && decision === "ALLOW" && reason === "ALLOWED";
  }
  if (type === "approval.granted") {
    return (
      result === "PASS" &&
      decision === "ALLOW" &&
      reason === "ALLOWED" &&
      (kind === "final" || kind === "security")
    );
  }
  return (
    result === "PASS" &&
    decision === "DENY" &&
    reason === "NO_SELF_APPROVAL" &&
    (kind === "final" || kind === "security")
  );
}

function parseTaskPayload(value: unknown): TaskEventPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const fromState = readNullableString(value, "from_state");
  const toState = readString(value, "to_state");
  const assigneeId = readNullableString(value, "assignee_id");
  const pauseReason = readNullableString(value, "pause_reason");
  const handoff = value.handoff_count;
  const review = value.human_review_required;
  if (
    fromState === undefined ||
    (fromState !== null && !isTaskState(fromState)) ||
    !toState ||
    !isTaskState(toState) ||
    assigneeId === undefined ||
    (assigneeId !== null && !isId(assigneeId, "emp")) ||
    !Number.isInteger(handoff) ||
    typeof handoff !== "number" ||
    handoff < 0 ||
    handoff > 8 ||
    (review !== 0 && review !== 1) ||
    pauseReason === undefined ||
    (pauseReason !== null && !PAUSE.test(pauseReason))
  ) {
    return null;
  }
  return {
    from_state: fromState,
    to_state: toState,
    assignee_id: assigneeId,
    handoff_count: handoff,
    human_review_required: review,
    pause_reason: pauseReason,
  };
}

function parseArtifactPayload(
  value: unknown,
  envelope: EventEnvelope,
): ArtifactEventPayload | null {
  if (!isRecord(value) || envelope.room_id === null) {
    return null;
  }
  const sha256 = readString(value, "sha256");
  const mediaType = readString(value, "media_type");
  const r2Key = readString(value, "r2_key");
  const version = value.version;
  const size = value.size;
  if (
    !Number.isInteger(version) ||
    typeof version !== "number" ||
    version !== envelope.seq ||
    !sha256 ||
    !SHA256.test(sha256) ||
    !mediaType ||
    canonicalMediaType(mediaType) !== mediaType ||
    !Number.isInteger(size) ||
    typeof size !== "number" ||
    size < 1 ||
    size > MAX_DIRECT_ARTIFACT_BYTES ||
    !r2Key ||
    r2Key !== artifactObjectKey(envelope.org_id, envelope.room_id, envelope.subject_id, version)
  ) {
    return null;
  }
  return {
    version,
    sha256,
    media_type: mediaType,
    size,
    r2_key: r2Key,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}
