import { DurableObject } from "cloudflare:workers";
import {
  MAX_ARTIFACT_BASE64,
  MAX_ARTIFACT_BYTES,
  MAX_DIRECT_ARTIFACT_BYTES,
  artifactObjectKey,
  buildArtifactEvent,
  buildGovernanceEvent,
  canonicalMediaType,
  createId,
  isArtifactFilename,
  isId,
  isReviewResult,
  parseDomainEvent,
  sameSecret,
  sha256Hex,
  type DomainEvent,
  type GovernanceDomainEvent,
  type ReviewResult,
} from "@ai-company/domain";
import type { OrganizationDO } from "@ai-company/organization";

interface ArtifactEnv {
  DB: D1Database;
  ORGANIZATION: DurableObjectNamespace<OrganizationDO>;
  ARTIFACTS: R2Bucket;
  DOMAIN_EVENTS: Queue<DomainEvent>;
  TEST_MIGRATIONS?: unknown;
}

export interface ArtifactPut {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  roomId: string | null;
  artifactId: string | null;
  taskId: string | null;
  mediaType: string;
  filename: string | null;
  checksum: string | null;
  bodyBase64: string;
}

export interface ArtifactUploadReserve extends Omit<ArtifactPut, "bodyBase64"> {
  size: number;
}

export interface ArtifactUploadResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  artifactId: string | null;
  version: number | null;
  r2Key: string | null;
  sha256: string | null;
  uploadToken: string | null;
  expiresAt: number | null;
  duplicate: boolean;
}

export interface ArtifactUploadTarget {
  decision: "ALLOW" | "DENY";
  reason: string;
  r2Key: string | null;
  sha256: string | null;
  size: number | null;
  mediaType: string | null;
}

export interface ArtifactUploadCommand {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  uploadToken: string;
}

export { MAX_DIRECT_ARTIFACT_BYTES };
const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
const OUTBOX_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 300_000] as const;

export interface ArtifactResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  artifactId: string | null;
  version: number | null;
  canonicalVersion: number | null;
  r2Key: string | null;
  sha256: string | null;
  duplicate: boolean;
}

export interface ArtifactRead {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  artifactId: string;
  version: number | null;
  metadataOnly?: boolean;
}

export interface ArtifactReadResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  artifactId: string | null;
  version: number | null;
  canonicalVersion: number | null;
  r2Key: string | null;
  sha256: string | null;
  mediaType: string | null;
  size: number | null;
  filename: string | null;
  bodyBase64: string | null;
}

export interface ArtifactReview {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  artifactId: string;
  version: number;
  result: string;
}

export interface ArtifactFinalize {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
  artifactId: string;
  version: number;
}

export interface GovernanceResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  recordId: string | null;
  artifactId: string | null;
  version: number | null;
  result: string | null;
  policyVersion: number | null;
  duplicate: boolean;
}

interface Actor {
  orgId: string;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey?: string;
}

type ArtifactRow = {
  id: string;
  room_id: string;
  task_id: string | null;
  creator_type: string;
  creator_id: string;
  canonical_version: number;
  correlation_id: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  artifact_id: string;
  version: number;
  room_id: string;
  task_id: string | null;
  correlation_id: string;
  r2_key: string;
  sha256: string;
  media_type: string;
  size: number;
  filename: string | null;
  status: string;
  created_at: string;
};

type CommandRow = {
  requested_artifact_id: string;
  artifact_id: string;
  version: number;
  sha256: string;
  decision: string;
  reason: string;
  status: string;
};

type GovernanceKind = "review" | "final" | "security";

type GovernanceReason = "ALLOWED" | "NO_SELF_APPROVAL";

interface GovernancePlan {
  actor: Actor & { idempotencyKey: string };
  kind: GovernanceKind;
  artifact: ArtifactRow;
  version: number;
  result: ReviewResult;
  decision: "ALLOW" | "DENY";
  reason: GovernanceReason;
  policyVersion: number;
}

type GovernanceCommandRow = {
  kind: string;
  artifact_id: string;
  version: number;
  result: string;
  decision: string;
  reason: string;
  record_id: string;
  policy_version: number;
  before_digest: string | null;
  after_digest: string;
  event_id: string;
  correlation_id: string;
  created_at: string;
  status: string;
};

interface ParsedPut {
  roomId: string | null;
  artifactId: string | null;
  taskId: string | null;
  mediaType: string;
  filename: string | null;
  checksum: string | null;
}

type ArtifactCommand = Omit<ArtifactPut, "bodyBase64">;
type OutboxTable = "event_outbox" | "governance_outbox";

interface UploadCapabilityRow extends Record<string, string | number | null> {
  token_hash: string;
  actor_type: "human" | "employee";
  actor_id: string;
  idempotency_key: string;
  artifact_id: string;
  version: number;
  expires_at: number;
  status: string;
}

type Replay =
  | { kind: "missing" }
  | { kind: "mismatch" }
  | { kind: "pending"; version: VersionRow }
  | { kind: "allow"; result: ArtifactResult }
  | { kind: "deny"; result: ArtifactResult };

const KEY = /^[A-Za-z0-9_-]{8,80}$/;

function denyGovernance(reason: string, duplicate = false): GovernanceResult {
  return {
    decision: "DENY",
    reason,
    recordId: null,
    artifactId: null,
    version: null,
    result: null,
    policyVersion: null,
    duplicate,
  };
}

function governanceFrom(row: GovernanceCommandRow, duplicate: boolean): GovernanceResult {
  return {
    decision: row.decision === "ALLOW" ? "ALLOW" : "DENY",
    reason: row.reason,
    recordId: row.record_id,
    artifactId: row.artifact_id,
    version: row.version,
    result: row.result,
    policyVersion: row.policy_version,
    duplicate,
  };
}

function governanceEventType(
  row: GovernanceCommandRow,
): "review.recorded" | "approval.granted" | "approval.denied" {
  if (row.kind === "review") {
    return "review.recorded";
  }
  return row.decision === "ALLOW" ? "approval.granted" : "approval.denied";
}

function digestSource(parts: {
  kind: string;
  recordId: string;
  artifactId: string;
  version: number;
  result: string;
  decision: string;
  reason: string;
}): string {
  return [
    parts.kind,
    parts.recordId,
    parts.artifactId,
    String(parts.version),
    parts.result,
    parts.decision,
    parts.reason,
  ].join("|");
}

function denied(reason: string, duplicate = false): ArtifactResult {
  return {
    decision: "DENY",
    reason,
    artifactId: null,
    version: null,
    canonicalVersion: null,
    r2Key: null,
    sha256: null,
    duplicate,
  };
}

function deniedUpload(reason: string): ArtifactUploadResult {
  return {
    decision: "DENY",
    reason,
    artifactId: null,
    version: null,
    r2Key: null,
    sha256: null,
    uploadToken: null,
    expiresAt: null,
    duplicate: false,
  };
}

function uploadReservation(
  result: ArtifactResult,
  uploadToken: string | null,
  expiresAt: number | null,
): ArtifactUploadResult {
  return {
    decision: result.decision,
    reason: result.reason,
    artifactId: result.artifactId,
    version: result.version,
    r2Key: result.r2Key,
    sha256: result.sha256,
    uploadToken,
    expiresAt,
    duplicate: result.duplicate,
  };
}

function deniedUploadTarget(reason: string): ArtifactUploadTarget {
  return {
    decision: "DENY",
    reason,
    r2Key: null,
    sha256: null,
    size: null,
    mediaType: null,
  };
}

function denyRead(
  reason: string,
  artifact: ArtifactRow | null = null,
  version: VersionRow | null = null,
): ArtifactReadResult {
  return {
    decision: "DENY",
    reason,
    artifactId: artifact?.id ?? null,
    version: version?.version ?? null,
    canonicalVersion: artifact?.canonical_version ?? null,
    r2Key: version && reason === "INTEGRITY" ? version.r2_key : null,
    sha256: version?.sha256 ?? null,
    mediaType: version?.media_type ?? null,
    size: version?.size ?? null,
    filename: version?.filename ?? null,
    bodyBase64: null,
  };
}

function allowed(version: VersionRow, canonical: number, duplicate: boolean): ArtifactResult {
  return {
    decision: "ALLOW",
    reason: "ALLOWED",
    artifactId: version.artifact_id,
    version: version.version,
    canonicalVersion: canonical,
    r2Key: version.r2_key,
    sha256: version.sha256,
    duplicate,
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

function sameLabel(left: string | null, right: string | null): boolean {
  return (left ?? null) === (right ?? null);
}

function toHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function actorProblem(actor: { actorType: string; actorId: string }): string | null {
  if (actor.actorType !== "human" && actor.actorType !== "employee") {
    return "INVALID_INPUT";
  }
  if (actor.actorType === "human" && !isId(actor.actorId, "usr")) {
    return "TENANT_BOUNDARY";
  }
  if (actor.actorType === "employee" && !isId(actor.actorId, "emp")) {
    return "TENANT_BOUNDARY";
  }
  return null;
}

function parsePut(command: ArtifactCommand): ParsedPut | null {
  if (!KEY.test(command.idempotencyKey)) {
    return null;
  }
  if (command.roomId !== null && !isId(command.roomId, "room")) {
    return null;
  }
  if (command.artifactId !== null && !isId(command.artifactId, "art")) {
    return null;
  }
  if (command.taskId !== null && !isId(command.taskId, "task")) {
    return null;
  }
  const mediaType = canonicalMediaType(command.mediaType);
  if (!mediaType) {
    return null;
  }
  if (command.filename !== null && !isArtifactFilename(command.filename)) {
    return null;
  }
  let checksum: string | null = null;
  if (command.checksum !== null) {
    checksum = command.checksum.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) {
      return null;
    }
  }
  if (!command.artifactId && !command.roomId) {
    return null;
  }
  return {
    roomId: command.roomId,
    artifactId: command.artifactId,
    taskId: command.taskId,
    mediaType,
    filename: command.filename,
    checksum,
  };
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > MAX_ARTIFACT_BASE64 || value.length % 4 !== 0) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const estimated = (value.length / 4) * 3 - padding;
  if (!Number.isInteger(estimated) || estimated < 1 || estimated > MAX_ARTIFACT_BYTES) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  if (binary.length !== estimated) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    const slice = bytes.subarray(index, index + size);
    let part = "";
    for (const byte of slice) {
      part += String.fromCharCode(byte);
    }
    binary += part;
  }
  return btoa(binary);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export class ArtifactDO extends DurableObject<ArtifactEnv> {
  constructor(ctx: DurableObjectState, env: ArtifactEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async put(command: ArtifactPut): Promise<ArtifactResult> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId) {
      return denied("TENANT_BOUNDARY");
    }
    const actor = actorProblem(command);
    if (actor) {
      return denied(actor);
    }
    const parsed = parsePut(command);
    if (!parsed) {
      return denied("INVALID_INPUT");
    }
    const bytes = decodeBase64(command.bodyBase64);
    if (!bytes) {
      return denied("INVALID_INPUT");
    }
    const sha = await sha256Bytes(bytes);
    if (parsed.checksum && !sameSecret(parsed.checksum, sha)) {
      return denied("CHECKSUM_MISMATCH");
    }
    const existing = parsed.artifactId ? this.artifactById(parsed.artifactId) : null;
    if (parsed.artifactId && !existing) {
      return denied("TENANT_BOUNDARY");
    }
    if (existing && parsed.roomId !== null && parsed.roomId !== existing.room_id) {
      return denied("TENANT_BOUNDARY");
    }
    if (existing && parsed.taskId !== null && !sameLabel(parsed.taskId, existing.task_id)) {
      return denied("TENANT_BOUNDARY");
    }
    const roomId = existing?.room_id ?? parsed.roomId;
    const taskId = existing ? existing.task_id : parsed.taskId;
    if (!roomId) {
      return denied("INVALID_INPUT");
    }
    if (!(await this.roomActive(command.orgId, roomId))) {
      return denied("TENANT_BOUNDARY");
    }
    const taskLink = taskId ? await this.taskInRoom(command.orgId, taskId, roomId) : null;
    if (taskLink && taskLink.decision !== "ALLOW") {
      return denied(taskLink.reason);
    }
    const decision = await this.authorize(
      command,
      existing ? "artifact.modify" : "artifact.create",
      existing?.id ?? command.orgId,
      existing?.creator_id ?? null,
    );
    if (decision.decision === "DENY") {
      return denied(decision.reason);
    }
    if (
      command.actorType === "employee" &&
      !(await this.activeMember(command.orgId, roomId, command.actorId))
    ) {
      return denied("NOT_MEMBER");
    }
    if (existing && !(await this.canRevise(command, existing))) {
      return denied("NOT_CREATOR");
    }
    const replay = this.replay(
      command,
      sha,
      roomId,
      taskId,
      parsed.mediaType,
      parsed.filename,
      bytes.byteLength,
    );
    if (replay.kind === "mismatch") {
      return denied("IDEMPOTENCY_MISMATCH");
    }
    if (replay.kind === "deny") {
      return replay.result;
    }
    if (replay.kind === "allow") {
      await this.publishStaged(command);
      return replay.result;
    }
    const reserved =
      replay.kind === "pending"
        ? replay.version
        : this.claim(
            command,
            roomId,
            taskId,
            parsed,
            sha,
            bytes.byteLength,
            existing?.correlation_id || taskLink?.correlationId || createId("corr"),
          );
    if (!reserved) {
      const raced = this.replay(
        command,
        sha,
        roomId,
        taskId,
        parsed.mediaType,
        parsed.filename,
        bytes.byteLength,
      );
      if (raced.kind === "allow") {
        await this.publishStaged(command);
        return raced.result;
      }
      if (raced.kind === "deny") {
        return raced.result;
      }
      if (raced.kind === "mismatch") {
        return denied("IDEMPOTENCY_MISMATCH");
      }
      if (raced.kind === "pending") {
        return this.finish(command, raced.version, bytes, sha, parsed.mediaType);
      }
      return denied("INVALID_INPUT");
    }
    return this.finish(command, reserved, bytes, sha, parsed.mediaType);
  }

  private async issueUploadCapability(
    command: ArtifactCommand,
    version: VersionRow,
  ): Promise<ArtifactUploadResult> {
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await sha256Hex(token);
    const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO upload_capabilities (
        token_hash, actor_type, actor_id, idempotency_key, artifact_id, version, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      tokenHash,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
      version.artifact_id,
      version.version,
      expiresAt,
    );
    return uploadReservation(allowed(version, version.version, false), token, expiresAt);
  }

  private async uploadCapability(
    command: ArtifactUploadCommand,
  ): Promise<UploadCapabilityRow | null> {
    const bound = this.bound();
    if (
      !bound ||
      command.orgId !== bound.orgId ||
      actorProblem(command) !== null ||
      !/^[0-9a-f]{64}$/.test(command.uploadToken)
    ) {
      return null;
    }
    const tokenHash = await sha256Hex(command.uploadToken);
    const row = this.ctx.storage.sql
      .exec<UploadCapabilityRow>(
        `SELECT token_hash, actor_type, actor_id, idempotency_key, artifact_id, version, expires_at, status
         FROM upload_capabilities WHERE token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.actor_type !== command.actorType || row.actor_id !== command.actorId) {
      return null;
    }
    return row;
  }

  private artifactCommand(
    cap: UploadCapabilityRow,
    version: VersionRow | null,
  ): ArtifactCommand | null {
    const bound = this.bound();
    const stored = this.commandByKey({
      orgId: bound?.orgId ?? "",
      actorType: cap.actor_type,
      actorId: cap.actor_id,
      idempotencyKey: cap.idempotency_key,
      roomId: version?.room_id ?? null,
      artifactId: null,
      taskId: version?.task_id ?? null,
      mediaType: version?.media_type ?? "",
      filename: version?.filename ?? null,
      checksum: version?.sha256 ?? null,
    });
    if (!bound || !version || !stored) {
      return null;
    }
    return {
      orgId: bound.orgId,
      actorType: cap.actor_type,
      actorId: cap.actor_id,
      idempotencyKey: cap.idempotency_key,
      roomId: version.room_id,
      artifactId: stored.requested_artifact_id || null,
      taskId: version.task_id,
      mediaType: version.media_type,
      filename: version.filename,
      checksum: version.sha256,
    };
  }

  private async finishReserved(command: ArtifactCommand, version: VersionRow): Promise<void> {
    try {
      await this.project(command.orgId, version, command.actorType, command.actorId);
    } catch (error) {
      if (storageText(error).includes("TENANT_MISMATCH")) {
        this.sealDenial(command, version, "TENANT_BOUNDARY");
        throw new Error("ARTIFACT_PROJECTION_BOUNDARY", { cause: error });
      }
      throw error;
    }
    await this.markStored(command, version);
    await this.scheduleOutboxAlarm();
    await this.publishStaged(command);
  }

  async reserveUpload(command: ArtifactUploadReserve): Promise<ArtifactUploadResult> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId) {
      return deniedUpload("TENANT_BOUNDARY");
    }
    const actor = actorProblem(command);
    const parsed = parsePut(command);
    if (
      actor ||
      !parsed ||
      !parsed.checksum ||
      !Number.isInteger(command.size) ||
      command.size < 1 ||
      command.size > MAX_DIRECT_ARTIFACT_BYTES
    ) {
      return deniedUpload(actor ?? "INVALID_INPUT");
    }
    const existing = parsed.artifactId ? this.artifactById(parsed.artifactId) : null;
    if (parsed.artifactId && !existing) {
      return deniedUpload("TENANT_BOUNDARY");
    }
    if (existing && parsed.roomId !== null && parsed.roomId !== existing.room_id) {
      return deniedUpload("TENANT_BOUNDARY");
    }
    if (existing && parsed.taskId !== null && !sameLabel(parsed.taskId, existing.task_id)) {
      return deniedUpload("TENANT_BOUNDARY");
    }
    const roomId = existing?.room_id ?? parsed.roomId;
    const taskId = existing ? existing.task_id : parsed.taskId;
    if (!roomId || !(await this.roomActive(command.orgId, roomId))) {
      return deniedUpload("TENANT_BOUNDARY");
    }
    const taskLink = taskId ? await this.taskInRoom(command.orgId, taskId, roomId) : null;
    if (taskLink && taskLink.decision !== "ALLOW") {
      return deniedUpload(taskLink.reason);
    }
    const decision = await this.authorize(
      command,
      existing ? "artifact.modify" : "artifact.create",
      existing?.id ?? command.orgId,
      existing?.creator_id ?? null,
    );
    if (decision.decision === "DENY") {
      return deniedUpload(decision.reason);
    }
    if (
      command.actorType === "employee" &&
      !(await this.activeMember(command.orgId, roomId, command.actorId))
    ) {
      return deniedUpload("NOT_MEMBER");
    }
    if (existing && !(await this.canRevise(command, existing))) {
      return deniedUpload("NOT_CREATOR");
    }
    const replay = this.replay(
      command,
      parsed.checksum,
      roomId,
      taskId,
      parsed.mediaType,
      parsed.filename,
      command.size,
    );
    if (replay.kind === "mismatch") {
      return deniedUpload("IDEMPOTENCY_MISMATCH");
    }
    if (replay.kind === "deny") {
      return deniedUpload(replay.result.reason);
    }
    if (replay.kind === "allow") {
      return uploadReservation(replay.result, null, null);
    }
    const correlationId = existing?.correlation_id || taskLink?.correlationId || createId("corr");
    const version =
      replay.kind === "pending"
        ? replay.version
        : this.claim(command, roomId, taskId, parsed, parsed.checksum, command.size, correlationId);
    if (!version) {
      const raced = this.replay(
        command,
        parsed.checksum,
        roomId,
        taskId,
        parsed.mediaType,
        parsed.filename,
        command.size,
      );
      if (raced.kind === "allow") {
        return uploadReservation(raced.result, null, null);
      }
      if (raced.kind === "pending") {
        return this.issueUploadCapability(command, raced.version);
      }
      return deniedUpload(raced.kind === "mismatch" ? "IDEMPOTENCY_MISMATCH" : "INVALID_INPUT");
    }
    return this.issueUploadCapability(command, version);
  }

  private async uploadAuthority(
    cap: UploadCapabilityRow,
    version: VersionRow,
  ): Promise<string | null> {
    const command = this.artifactCommand(cap, version);
    if (!command || !(await this.roomActive(command.orgId, version.room_id))) {
      return "TENANT_BOUNDARY";
    }
    if (version.task_id) {
      const linked = await this.taskInRoom(command.orgId, version.task_id, version.room_id);
      if (linked.decision === "DENY") return linked.reason;
    }
    const artifact = this.artifactById(version.artifact_id);
    const decision = await this.authorize(
      command,
      command.artifactId ? "artifact.modify" : "artifact.create",
      version.artifact_id,
      artifact?.creator_id ?? null,
    );
    if (decision.decision === "DENY") return decision.reason;
    if (
      command.actorType === "employee" &&
      !(await this.activeMember(command.orgId, version.room_id, command.actorId))
    ) {
      return "NOT_MEMBER";
    }
    return null;
  }

  async uploadTarget(command: ArtifactUploadCommand): Promise<ArtifactUploadTarget> {
    const cap = await this.uploadCapability(command);
    if (!cap || cap.status !== "pending" || cap.expires_at < Date.now()) {
      return deniedUploadTarget("UPLOAD_CAPABILITY_INVALID");
    }
    const version = this.versionBy(cap.artifact_id, cap.version);
    if (!version || version.status !== "pending") {
      return deniedUploadTarget("UPLOAD_CAPABILITY_INVALID");
    }
    const authority = await this.uploadAuthority(cap, version);
    if (authority) return deniedUploadTarget(authority);
    return {
      decision: "ALLOW",
      reason: "ALLOWED",
      r2Key: version.r2_key,
      sha256: version.sha256,
      size: version.size,
      mediaType: version.media_type,
    };
  }

  async commitUpload(command: ArtifactUploadCommand): Promise<ArtifactResult> {
    const cap = await this.uploadCapability(command);
    if (!cap) {
      return denied("UPLOAD_CAPABILITY_INVALID");
    }
    const version = this.versionBy(cap.artifact_id, cap.version);
    const artifactCommand = this.artifactCommand(cap, version);
    if (!version || !artifactCommand) {
      return denied("UPLOAD_CAPABILITY_INVALID");
    }
    const authority = await this.uploadAuthority(cap, version);
    if (authority) return denied(authority);
    if (version.status === "stored") {
      const artifact = this.artifactById(version.artifact_id);
      return allowed(version, artifact?.canonical_version ?? version.version, true);
    }
    if (cap.status !== "pending" || cap.expires_at < Date.now()) {
      return denied("UPLOAD_CAPABILITY_INVALID");
    }
    const object = await this.env.ARTIFACTS.head(version.r2_key);
    if (!object) {
      return denied("UPLOAD_MISSING");
    }
    if (object.size !== version.size) {
      return denied("CHECKSUM_MISMATCH");
    }
    if (
      object.customMetadata?.sha256 !== version.sha256 ||
      object.httpMetadata?.contentType !== version.media_type
    ) {
      return denied("CHECKSUM_MISMATCH");
    }
    const nativeChecksum = object.checksums.sha256;
    let actualChecksum: string;
    if (nativeChecksum) {
      actualChecksum = toHex(new Uint8Array(nativeChecksum));
    } else {
      const stored = await this.env.ARTIFACTS.get(version.r2_key);
      if (!stored) {
        return denied("UPLOAD_MISSING");
      }
      actualChecksum = await sha256Bytes(new Uint8Array(await stored.arrayBuffer()));
    }
    if (!sameSecret(actualChecksum, version.sha256)) {
      return denied("CHECKSUM_MISMATCH");
    }
    try {
      await this.finishReserved(artifactCommand, version);
    } catch (error) {
      if (storageText(error).includes("ARTIFACT_PROJECTION_BOUNDARY")) {
        return denied("TENANT_BOUNDARY");
      }
      throw error;
    }
    const artifact = this.artifactById(version.artifact_id);
    return allowed(version, artifact?.canonical_version ?? version.version, false);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const pending = this.ctx.storage.sql
      .exec<{ event_id: string; body: string; outbox: OutboxTable }>(
        `SELECT event_id, body, 'event_outbox' AS outbox FROM event_outbox
         WHERE status = 'pending' AND COALESCE(next_retry_at, 0) <= ?
         UNION ALL
         SELECT event_id, body, 'governance_outbox' AS outbox FROM governance_outbox
         WHERE status = 'pending' AND COALESCE(next_retry_at, 0) <= ?`,
        now,
        now,
      )
      .toArray();
    for (const item of pending) {
      await this.deliverOutbox(item.outbox, item.event_id, item.body);
    }
    await this.scheduleOutboxAlarm();
  }

  async read(command: ArtifactRead): Promise<ArtifactReadResult> {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId || !isId(command.artifactId, "art")) {
      return denyRead("TENANT_BOUNDARY");
    }
    const actor = actorProblem(command);
    if (actor) {
      return denyRead(actor);
    }
    if (
      command.version !== null &&
      (!Number.isInteger(command.version) || command.version < 1 || command.version > 1_000_000)
    ) {
      return denyRead("INVALID_INPUT");
    }
    const artifact = this.artifactById(command.artifactId);
    if (!artifact) {
      return denyRead("TENANT_BOUNDARY");
    }
    const decision = await this.authorize(
      command,
      "artifact.read",
      artifact.id,
      artifact.creator_id,
    );
    if (decision.decision === "DENY") {
      return denyRead(decision.reason);
    }
    if (
      command.actorType === "employee" &&
      !(await this.activeMember(command.orgId, artifact.room_id, command.actorId))
    ) {
      return denyRead("NOT_MEMBER");
    }
    const version = this.versionBy(artifact.id, command.version ?? artifact.canonical_version);
    if (!version || version.status !== "stored") {
      return denyRead("TENANT_BOUNDARY");
    }
    const expected = artifactObjectKey(
      command.orgId,
      artifact.room_id,
      artifact.id,
      version.version,
    );
    if (version.r2_key !== expected || !version.r2_key.startsWith(`org/${command.orgId}/`)) {
      return denyRead("INTEGRITY", artifact, version);
    }
    const object = await this.env.ARTIFACTS.get(version.r2_key);
    if (!object || object.size !== version.size) {
      return denyRead("INTEGRITY", artifact, version);
    }
    if (command.metadataOnly) {
      const checksum = object.checksums.sha256;
      const actual = checksum
        ? toHex(new Uint8Array(checksum))
        : await this.readObjectChecksum(version.r2_key);
      if (!actual || !sameSecret(actual, version.sha256)) {
        return denyRead("INTEGRITY", artifact, version);
      }
      return {
        decision: "ALLOW",
        reason: "ALLOWED",
        artifactId: artifact.id,
        version: version.version,
        canonicalVersion: artifact.canonical_version,
        r2Key: version.r2_key,
        sha256: version.sha256,
        mediaType: version.media_type,
        size: version.size,
        filename: version.filename,
        bodyBase64: null,
      };
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const actual = await sha256Bytes(bytes);
    if (!sameSecret(actual, version.sha256)) {
      return denyRead("INTEGRITY", artifact, version);
    }
    return {
      decision: "ALLOW",
      reason: "ALLOWED",
      artifactId: artifact.id,
      version: version.version,
      canonicalVersion: artifact.canonical_version,
      r2Key: version.r2_key,
      sha256: version.sha256,
      mediaType: version.media_type,
      size: version.size,
      filename: version.filename,
      bodyBase64: encodeBase64(bytes),
    };
  }

  async review(command: ArtifactReview): Promise<GovernanceResult> {
    const opened = await this.openGovernance(command, "review", command.result);
    if (opened.kind === "result") {
      return opened.result;
    }
    if (opened.plan.decision === "ALLOW" && !(await this.memberIfEmployee(opened.plan))) {
      return denyGovernance("NOT_MEMBER");
    }
    return this.finishGovernance(opened.plan);
  }

  async finalize(command: ArtifactFinalize): Promise<GovernanceResult> {
    const opened = await this.openGovernance(command, "final", "PASS");
    if (opened.kind === "result") {
      return opened.result;
    }
    if (opened.plan.decision === "ALLOW" && !(await this.memberIfEmployee(opened.plan))) {
      return denyGovernance("NOT_MEMBER");
    }
    return this.finishGovernance(opened.plan);
  }

  async securityApprove(command: ArtifactFinalize): Promise<GovernanceResult> {
    const opened = await this.openGovernance(command, "security", "PASS");
    if (opened.kind === "result") {
      return opened.result;
    }
    return this.finishGovernance(opened.plan);
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

  async outboxStateForTest(): Promise<
    Array<{ eventId: string; status: string; attempts: number; failureReason: string | null }>
  > {
    if (!this.testMode()) {
      return [];
    }
    return this.ctx.storage.sql
      .exec<{
        event_id: string;
        status: string;
        attempts: number;
        failure_reason: string | null;
      }>(
        `SELECT event_id, status, attempts, failure_reason FROM event_outbox
         UNION ALL
         SELECT event_id, status, attempts, failure_reason FROM governance_outbox`,
      )
      .toArray()
      .map((row) => ({
        eventId: row.event_id,
        status: row.status,
        attempts: row.attempts,
        failureReason: row.failure_reason,
      }));
  }

  async corruptPendingOutboxForTest(): Promise<boolean> {
    if (!this.testMode()) {
      return false;
    }
    const pending = this.ctx.storage.sql
      .exec<{ event_id: string; outbox: OutboxTable }>(
        `SELECT event_id, 'event_outbox' AS outbox FROM event_outbox WHERE status = 'pending'
         UNION ALL
         SELECT event_id, 'governance_outbox' AS outbox FROM governance_outbox WHERE status = 'pending'
         LIMIT 1`,
      )
      .toArray()[0];
    if (!pending) {
      return false;
    }
    this.ctx.storage.sql.exec(
      `UPDATE ${pending.outbox} SET body = '{invalid', next_retry_at = 0
       WHERE event_id = ? AND status = 'pending'`,
      pending.event_id,
    );
    await this.scheduleOutboxAlarm();
    return true;
  }

  private async finish(
    command: ArtifactPut,
    version: VersionRow,
    bytes: Uint8Array,
    sha: string,
    mediaType: string,
  ): Promise<ArtifactResult> {
    const written = await this.writeObject(version.r2_key, bytes, sha, mediaType);
    if (written === "mismatch") {
      this.sealDenial(command, version, "ARTIFACT_EXISTS");
      return denied("ARTIFACT_EXISTS");
    }
    if (written !== "written" && written !== "adopted") {
      throw new Error("ARTIFACT_OBJECT_UNAVAILABLE");
    }
    try {
      await this.finishReserved(command, version);
    } catch (error) {
      if (storageText(error).includes("ARTIFACT_PROJECTION_BOUNDARY")) {
        return denied("TENANT_BOUNDARY");
      }
      throw error;
    }
    const artifact = this.artifactById(version.artifact_id);
    return allowed(version, artifact?.canonical_version ?? version.version, false);
  }

  private async writeObject(
    key: string,
    bytes: Uint8Array,
    sha: string,
    media: string,
  ): Promise<"written" | "adopted" | "mismatch" | "failed"> {
    const orgId = this.bound()?.orgId;
    const checksum = fromHex(sha);
    if (!orgId || !key.startsWith(`org/${orgId}/`) || !checksum) {
      return "failed";
    }
    const created = await this.env.ARTIFACTS.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: checksum,
      httpMetadata: { contentType: media },
      customMetadata: { sha256: sha },
    });
    if (created) {
      return "written";
    }
    const head = await this.env.ARTIFACTS.head(key);
    if (!head) {
      return "failed";
    }
    if (head.size !== bytes.byteLength) {
      return "mismatch";
    }
    const tagged = head.customMetadata?.sha256;
    if (typeof tagged === "string" && sameSecret(tagged, sha)) {
      return "adopted";
    }
    const object = await this.env.ARTIFACTS.get(key);
    if (!object) {
      return "failed";
    }
    const stored = new Uint8Array(await object.arrayBuffer());
    const actual = await sha256Bytes(stored);
    return sameSecret(actual, sha) ? "adopted" : "mismatch";
  }

  private async readObjectChecksum(key: string): Promise<string | null> {
    const object = await this.env.ARTIFACTS.get(key);
    if (!object) {
      return null;
    }
    return sha256Bytes(new Uint8Array(await object.arrayBuffer()));
  }

  private async project(
    orgId: string,
    version: VersionRow,
    creatorType: string,
    creatorId: string,
  ): Promise<void> {
    try {
      if (version.version === 1) {
        const inserted = await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO artifacts (
              id, org_id, room_id, task_id, creator_type, creator_id, canonical_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            version.artifact_id,
            orgId,
            version.room_id,
            version.task_id,
            creatorType,
            creatorId,
            version.version,
            version.created_at,
            version.created_at,
          ),
          this.versionInsert(orgId, version),
        ]);
        if (inserted.some((result) => result.meta.changes !== 1)) {
          throw new Error("ARTIFACT_PROJECTION_MISMATCH");
        }
        return;
      }
      const updated = await this.env.DB.batch([
        this.versionInsert(orgId, version),
        this.env.DB.prepare(
          `UPDATE artifacts
           SET canonical_version = ?, updated_at = ?
           WHERE org_id = ? AND id = ? AND canonical_version < ?`,
        ).bind(version.version, version.created_at, orgId, version.artifact_id, version.version),
      ]);
      const versionInsert = updated[0];
      if (!versionInsert || versionInsert.meta.changes !== 1) {
        throw new Error("ARTIFACT_PROJECTION_MISMATCH");
      }
      const pointer = updated[1];
      if (pointer && pointer.meta.changes === 1) {
        return;
      }
      const canonical = await this.env.DB.prepare(
        `SELECT canonical_version FROM artifacts WHERE org_id = ? AND id = ?`,
      )
        .bind(orgId, version.artifact_id)
        .first<{ canonical_version: number }>();
      if (!canonical || canonical.canonical_version < version.version) {
        throw new Error("ARTIFACT_PROJECTION_MISMATCH");
      }
    } catch (error) {
      if (await this.versionMatches(orgId, version)) {
        return;
      }
      throw error;
    }
  }

  private versionInsert(orgId: string, version: VersionRow): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO artifact_versions (
        org_id, artifact_id, version, r2_key, sha256, media_type, size, filename, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orgId,
      version.artifact_id,
      version.version,
      version.r2_key,
      version.sha256,
      version.media_type,
      version.size,
      version.filename,
      version.created_at,
    );
  }

  private async versionMatches(orgId: string, version: VersionRow): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT sha256, r2_key, size FROM artifact_versions
       WHERE org_id = ? AND artifact_id = ? AND version = ?`,
    )
      .bind(orgId, version.artifact_id, version.version)
      .first<{ sha256: string; r2_key: string; size: number }>();
    return (
      row?.sha256 === version.sha256 && row.r2_key === version.r2_key && row.size === version.size
    );
  }

  private claim(
    command: ArtifactCommand,
    roomId: string,
    taskId: string | null,
    parsed: ParsedPut,
    sha: string,
    size: number,
    correlationId: string,
  ): VersionRow | null {
    const freshId = parsed.artifactId ?? createId("art");
    let reserved: VersionRow | null = null;
    this.ctx.storage.transactionSync(() => {
      if (this.commandByKey(command)) {
        return;
      }
      const versionNumber = parsed.artifactId ? this.maxVersion(parsed.artifactId) + 1 : 1;
      if (versionNumber < 1 || versionNumber > 1_000_000) {
        return;
      }
      const artifactId = freshId;
      const row: VersionRow = {
        artifact_id: artifactId,
        version: versionNumber,
        room_id: roomId,
        task_id: taskId,
        correlation_id: correlationId,
        r2_key: artifactObjectKey(command.orgId, roomId, artifactId, versionNumber),
        sha256: sha,
        media_type: parsed.mediaType,
        size,
        filename: parsed.filename,
        status: "pending",
        created_at: new Date().toISOString(),
      };
      if (!row.r2_key.startsWith(`org/${command.orgId}/`)) {
        return;
      }
      this.insertVersion(row);
      this.insertCommand(command, row);
      reserved = row;
    });
    return reserved;
  }

  private replay(
    command: ArtifactCommand,
    sha: string,
    roomId: string,
    taskId: string | null,
    mediaType: string,
    filename: string | null,
    size: number,
  ): Replay {
    const row = this.commandByKey(command);
    if (!row) {
      return { kind: "missing" };
    }
    const version = this.versionBy(row.artifact_id, row.version);
    if (
      row.sha256 !== sha ||
      row.requested_artifact_id !== (command.artifactId ?? "") ||
      !version ||
      version.sha256 !== sha ||
      version.room_id !== roomId ||
      !sameLabel(version.task_id, taskId) ||
      version.media_type !== mediaType ||
      !sameLabel(version.filename, filename) ||
      version.size !== size
    ) {
      return { kind: "mismatch" };
    }
    if (row.status === "stored") {
      if (row.decision === "ALLOW") {
        const artifact = this.artifactById(version.artifact_id);
        return {
          kind: "allow",
          result: allowed(version, artifact?.canonical_version ?? version.version, true),
        };
      }
      return { kind: "deny", result: denied(row.reason, true) };
    }
    return { kind: "pending", version };
  }

  private sealDenial(command: ArtifactCommand, version: VersionRow, reason: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE artifact_versions SET status = 'blocked'
         WHERE artifact_id = ? AND version = ? AND status = 'pending'`,
        version.artifact_id,
        version.version,
      );
      this.ctx.storage.sql.exec(
        `UPDATE artifact_commands
         SET decision = 'DENY', reason = ?, status = 'stored'
         WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ? AND status = 'pending'`,
        reason,
        command.actorType,
        command.actorId,
        command.idempotencyKey,
      );
    });
  }

  private async markStored(command: ArtifactCommand, version: VersionRow): Promise<void> {
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const current = this.commandByKey(command);
      if (!current || current.status === "stored") {
        return;
      }
      const artifact = this.artifactById(version.artifact_id);
      if (!artifact) {
        this.ctx.storage.sql.exec(
          `INSERT INTO artifacts (
            id, room_id, task_id, creator_type, creator_id, canonical_version, correlation_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version.artifact_id,
          version.room_id,
          version.task_id,
          command.actorType,
          command.actorId,
          version.version,
          version.correlation_id,
          at,
          at,
        );
      } else if (version.version > artifact.canonical_version) {
        this.ctx.storage.sql.exec(
          `UPDATE artifacts SET canonical_version = ?, updated_at = ?
           WHERE id = ? AND canonical_version < ?`,
          version.version,
          at,
          version.artifact_id,
          version.version,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE artifact_versions SET status = 'stored' WHERE artifact_id = ? AND version = ?`,
        version.artifact_id,
        version.version,
      );
      this.ctx.storage.sql.exec(
        `UPDATE upload_capabilities SET status = 'stored' WHERE artifact_id = ? AND version = ?`,
        version.artifact_id,
        version.version,
      );
      this.stageEvent(command, version, at);
      this.ctx.storage.sql.exec(
        `UPDATE artifact_commands
         SET decision = 'ALLOW', reason = 'ALLOWED', status = 'stored'
         WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
        command.actorType,
        command.actorId,
        command.idempotencyKey,
      );
    });
    await this.scheduleOutboxAlarm();
  }

  private stageEvent(command: ArtifactCommand, version: VersionRow, at: string): void {
    const event = buildArtifactEvent({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      idempotencyKey: command.idempotencyKey,
      occurredAt: at,
      correlationId: version.correlation_id,
      causationId: command.idempotencyKey,
      roomId: version.room_id,
      artifactId: version.artifact_id,
      version: version.version,
      sha256: version.sha256,
      mediaType: version.media_type,
      size: version.size,
      r2Key: version.r2_key,
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

  private async publishStaged(command: ArtifactCommand): Promise<void> {
    const pending = this.outboxByCommand(command);
    if (!pending || pending.status !== "pending") {
      return;
    }
    await this.deliverOutbox("event_outbox", pending.event_id, pending.body);
  }

  private async authorize(
    command: Actor,
    action: string,
    resourceId: string,
    creatorId: string | null,
    implementationActorId: string | null = null,
  ): Promise<{ decision: "ALLOW" | "DENY"; reason: string; policy_version: number }> {
    const decision = await this.env.ORGANIZATION.getByName(`org:${command.orgId}`).authorize({
      orgId: command.orgId,
      actorType: command.actorType,
      actorId: command.actorId,
      action,
      resourceType: "artifact",
      resourceId,
      creatorId,
      implementationActorId,
    });
    return {
      decision: decision.decision,
      reason: decision.reason,
      policy_version: decision.policy_version,
    };
  }

  private async canRevise(command: ArtifactCommand, artifact: ArtifactRow): Promise<boolean> {
    if (command.actorType === artifact.creator_type && command.actorId === artifact.creator_id) {
      return true;
    }
    if (command.actorType !== "human") {
      return false;
    }
    const owner = await this.env.DB.prepare(
      `SELECT created_by_user_id AS id FROM organizations WHERE id = ?`,
    )
      .bind(command.orgId)
      .first<{ id: string }>();
    return owner?.id === command.actorId;
  }

  private async roomActive(orgId: string, roomId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT id FROM rooms WHERE org_id = ? AND id = ? AND status = 'active'`,
    )
      .bind(orgId, roomId)
      .first<{ id: string }>();
    return row !== null;
  }

  private async taskInRoom(
    orgId: string,
    taskId: string,
    roomId: string,
  ): Promise<
    | { decision: "ALLOW"; reason: "ALLOWED"; correlationId: string }
    | { decision: "DENY"; reason: "ROOM_MISMATCH" | "TENANT_BOUNDARY" }
  > {
    let task: { id: string; correlation_id: string | null } | null;
    try {
      task = await this.env.DB.prepare(
        `SELECT id, correlation_id FROM tasks
         WHERE org_id = ? AND id = ? AND room_id = ?`,
      )
        .bind(orgId, taskId, roomId)
        .first<{ id: string; correlation_id: string | null }>();
    } catch (error) {
      const detail = storageText(error).toLowerCase();
      if (!detail.includes("correlation_id")) {
        throw error;
      }
      task = await this.env.DB.prepare(
        `SELECT id, NULL AS correlation_id FROM tasks
         WHERE org_id = ? AND id = ? AND room_id = ?`,
      )
        .bind(orgId, taskId, roomId)
        .first<{ id: string; correlation_id: null }>();
    }
    if (!task) {
      const exists = await this.env.DB.prepare(`SELECT id FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(orgId, taskId)
        .first<{ id: string }>();
      return {
        decision: "DENY",
        reason: exists ? "ROOM_MISMATCH" : "TENANT_BOUNDARY",
      };
    }
    let correlationId = task.correlation_id;
    if (!correlationId) {
      const firstEvent = await this.env.DB.prepare(
        `SELECT correlation_id FROM domain_events
         WHERE org_id = ? AND subject_type = 'task' AND subject_id = ?
         ORDER BY seq ASC, occurred_at ASC LIMIT 1`,
      )
        .bind(orgId, taskId)
        .first<{ correlation_id: string }>();
      correlationId = firstEvent?.correlation_id ?? createId("corr");
    }
    return { decision: "ALLOW", reason: "ALLOWED", correlationId };
  }

  private async activeMember(orgId: string, roomId: string, employeeId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT id FROM room_memberships
       WHERE org_id = ? AND room_id = ? AND employee_id = ? AND status = 'active'`,
    )
      .bind(orgId, roomId, employeeId)
      .first<{ id: string }>();
    return row !== null;
  }

  private bound(): { orgId: string } | null {
    const name = this.ctx.id.name;
    if (!name?.startsWith("artifacts:")) {
      return null;
    }
    const orgId = name.slice("artifacts:".length);
    if (!isId(orgId, "org")) {
      return null;
    }
    return { orgId };
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

  private async deliverOutbox(table: OutboxTable, eventId: string, body: string): Promise<void> {
    const event = parseDomainEvent(readJson(body));
    if (!event) {
      this.ctx.storage.sql.exec(
        `UPDATE ${table} SET status = 'failed', failure_reason = 'INVALID_EVENT', next_retry_at = NULL
         WHERE event_id = ? AND status = 'pending'`,
        eventId,
      );
      await this.scheduleOutboxAlarm();
      return;
    }
    if (this.consumePublishFault()) {
      await this.retryOutbox(table, eventId, "QUEUE_SEND_FAILED");
      return;
    }
    try {
      await this.env.DOMAIN_EVENTS.send(event);
    } catch {
      await this.retryOutbox(table, eventId, "QUEUE_SEND_FAILED");
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE ${table}
       SET status = 'sent', next_retry_at = NULL, failure_reason = NULL
       WHERE event_id = ? AND status = 'pending'`,
      eventId,
    );
    await this.scheduleOutboxAlarm();
  }

  private async retryOutbox(
    table: OutboxTable,
    eventId: string,
    reason: "QUEUE_SEND_FAILED",
  ): Promise<void> {
    const current = this.ctx.storage.sql
      .exec<{ attempts: number }>(`SELECT attempts FROM ${table} WHERE event_id = ?`, eventId)
      .toArray()[0];
    if (!current) {
      return;
    }
    const attempts = current.attempts + 1;
    const delay =
      OUTBOX_RETRY_DELAYS_MS[Math.min(attempts - 1, OUTBOX_RETRY_DELAYS_MS.length - 1)] ?? 300_000;
    this.ctx.storage.sql.exec(
      `UPDATE ${table}
       SET attempts = ?, next_retry_at = ?, failure_reason = ?
       WHERE event_id = ? AND status = 'pending'`,
      attempts,
      Date.now() + delay,
      reason,
      eventId,
    );
    await this.scheduleOutboxAlarm();
  }

  private async scheduleOutboxAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(at) AS at FROM (
           SELECT COALESCE(next_retry_at, 0) AS at FROM event_outbox WHERE status = 'pending'
           UNION ALL
           SELECT COALESCE(next_retry_at, 0) AS at FROM governance_outbox WHERE status = 'pending'
         )`,
      )
      .toArray()[0]?.at;
    if (next === null || next === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const alarm = await this.ctx.storage.getAlarm();
    const scheduled = Math.max(Date.now() + 1, next);
    if (alarm !== scheduled) {
      await this.ctx.storage.setAlarm(scheduled);
    }
  }

  private artifactById(id: string): ArtifactRow | null {
    return (
      this.ctx.storage.sql
        .exec<ArtifactRow>(
          `SELECT id, room_id, task_id, creator_type, creator_id, canonical_version, correlation_id,
                  created_at, updated_at
           FROM artifacts WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private versionBy(artifactId: string, version: number): VersionRow | null {
    return (
      this.ctx.storage.sql
        .exec<VersionRow>(
          `SELECT artifact_id, version, room_id, task_id, correlation_id, r2_key, sha256, media_type,
                  size, filename, status, created_at
           FROM artifact_versions WHERE artifact_id = ? AND version = ?`,
          artifactId,
          version,
        )
        .toArray()[0] ?? null
    );
  }

  private maxVersion(artifactId: string): number {
    const row = this.ctx.storage.sql
      .exec<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM artifact_versions WHERE artifact_id = ?`,
        artifactId,
      )
      .toArray()[0];
    return row?.version ?? 0;
  }

  private commandByKey(command: ArtifactCommand): CommandRow | null {
    return (
      this.ctx.storage.sql
        .exec<CommandRow>(
          `SELECT requested_artifact_id, artifact_id, version, sha256, decision, reason, status
           FROM artifact_commands
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          command.actorType,
          command.actorId,
          command.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  private outboxByCommand(
    command: ArtifactCommand,
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

  private insertVersion(row: VersionRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact_versions (
        artifact_id, version, room_id, task_id, correlation_id, r2_key, sha256, media_type,
        size, filename, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.artifact_id,
      row.version,
      row.room_id,
      row.task_id,
      row.correlation_id,
      row.r2_key,
      row.sha256,
      row.media_type,
      row.size,
      row.filename,
      row.status,
      row.created_at,
    );
  }

  private insertCommand(command: ArtifactCommand, row: VersionRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO artifact_commands (
        actor_type, actor_id, idempotency_key, requested_artifact_id, artifact_id, version, sha256,
        decision, reason, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', 'pending')`,
      command.actorType,
      command.actorId,
      command.idempotencyKey,
      command.artifactId ?? "",
      row.artifact_id,
      row.version,
      row.sha256,
    );
  }

  private async openGovernance(
    command: ArtifactFinalize,
    kind: GovernanceKind,
    result: string,
  ): Promise<
    { kind: "result"; result: GovernanceResult } | { kind: "plan"; plan: GovernancePlan }
  > {
    const bound = this.bound();
    if (!bound || command.orgId !== bound.orgId || !isId(command.artifactId, "art")) {
      return { kind: "result", result: denyGovernance("TENANT_BOUNDARY") };
    }
    const actor = actorProblem(command);
    if (actor) {
      return { kind: "result", result: denyGovernance(actor) };
    }
    if (!KEY.test(command.idempotencyKey) || !isReviewResult(result)) {
      return { kind: "result", result: denyGovernance("INVALID_INPUT") };
    }
    if (!Number.isInteger(command.version) || command.version < 1 || command.version > 1_000_000) {
      return { kind: "result", result: denyGovernance("INVALID_INPUT") };
    }
    const artifact = this.artifactById(command.artifactId);
    const version = artifact ? this.versionBy(artifact.id, command.version) : null;
    if (!artifact || !version || version.status !== "stored") {
      return { kind: "result", result: denyGovernance("TENANT_BOUNDARY") };
    }
    const action =
      kind === "review"
        ? "artifact.review"
        : kind === "final"
          ? "artifact.final_approve"
          : "security.approve";
    const decision = await this.authorize(
      command,
      action,
      artifact.id,
      kind === "security" ? null : artifact.creator_id,
      kind === "security" ? artifact.creator_id : null,
    );
    if (decision.decision === "DENY" && decision.reason !== "NO_SELF_APPROVAL") {
      return { kind: "result", result: denyGovernance(decision.reason) };
    }
    if (decision.reason === "NO_SELF_APPROVAL" && kind === "review") {
      return { kind: "result", result: denyGovernance(decision.reason) };
    }
    const allowedDecision = decision.decision === "ALLOW";
    return {
      kind: "plan",
      plan: {
        actor: {
          orgId: command.orgId,
          actorType: command.actorType,
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
        },
        kind,
        artifact,
        version: version.version,
        result,
        decision: allowedDecision ? "ALLOW" : "DENY",
        reason: allowedDecision ? "ALLOWED" : "NO_SELF_APPROVAL",
        policyVersion: decision.policy_version,
      },
    };
  }

  private async memberIfEmployee(plan: GovernancePlan): Promise<boolean> {
    if (plan.actor.actorType !== "employee") {
      return true;
    }
    return this.activeMember(plan.actor.orgId, plan.artifact.room_id, plan.actor.actorId);
  }

  private async finishGovernance(plan: GovernancePlan): Promise<GovernanceResult> {
    if (plan.policyVersion < 1) {
      return denyGovernance("TENANT_BOUNDARY");
    }
    const existing = this.governanceByKey(plan.actor);
    if (existing) {
      if (!this.samePlan(existing, plan)) {
        return denyGovernance("IDEMPOTENCY_MISMATCH");
      }
      if (existing.status === "stored") {
        await this.publishGovernance(plan.actor);
        return governanceFrom(existing, true);
      }
      return this.completeGovernance(existing, plan);
    }
    const recordId = createId(plan.kind === "review" ? "rev" : "apr");
    const eventId = createId("evt");
    const correlationId = plan.artifact.correlation_id;
    const createdAt = new Date().toISOString();
    const afterDigest = await sha256Hex(
      digestSource({
        kind: plan.kind,
        recordId,
        artifactId: plan.artifact.id,
        version: plan.version,
        result: plan.result,
        decision: plan.decision,
        reason: plan.reason,
      }),
    );
    const beforeDigest = this.previousDigest(plan.artifact.id, plan.version, plan.kind);
    const claimed = this.claimGovernance(
      plan,
      recordId,
      eventId,
      correlationId,
      beforeDigest,
      afterDigest,
      createdAt,
    );
    if (!claimed) {
      const raced = this.governanceByKey(plan.actor);
      if (!raced || !this.samePlan(raced, plan)) {
        return denyGovernance(raced ? "IDEMPOTENCY_MISMATCH" : "INVALID_INPUT");
      }
      if (raced.status === "stored") {
        await this.publishGovernance(plan.actor);
        return governanceFrom(raced, true);
      }
      return this.completeGovernance(raced, plan);
    }
    return this.completeGovernance(claimed, plan);
  }

  private async completeGovernance(
    row: GovernanceCommandRow,
    plan: GovernancePlan,
  ): Promise<GovernanceResult> {
    try {
      await this.projectGovernance(plan.actor.orgId, row);
    } catch (error) {
      if (storageText(error).includes("TENANT_MISMATCH")) {
        this.sealGovernanceDenial(plan.actor, "TENANT_BOUNDARY");
        return denyGovernance("TENANT_BOUNDARY");
      }
      if (!(await this.governanceMatches(plan.actor.orgId, row))) {
        throw error;
      }
    }
    const event = buildGovernanceEvent({
      eventId: row.event_id,
      correlationId: row.correlation_id,
      type: governanceEventType(row),
      orgId: plan.actor.orgId,
      actorType: plan.actor.actorType,
      actorId: plan.actor.actorId,
      idempotencyKey: plan.actor.idempotencyKey,
      occurredAt: row.created_at,
      roomId: plan.artifact.room_id,
      artifactId: row.artifact_id,
      version: row.version,
      recordId: row.record_id,
      result: plan.result,
      decision: row.decision === "ALLOW" ? "ALLOW" : "DENY",
      reason: row.reason === "NO_SELF_APPROVAL" ? "NO_SELF_APPROVAL" : "ALLOWED",
      kind: plan.kind,
      policyVersion: row.policy_version,
      beforeDigest: row.before_digest,
      afterDigest: row.after_digest,
    });
    this.sealGovernance(plan.actor, row, event);
    await this.scheduleOutboxAlarm();
    await this.publishGovernance(plan.actor);
    const stored = this.governanceByKey(plan.actor);
    return governanceFrom(stored ?? row, false);
  }

  private async projectGovernance(orgId: string, row: GovernanceCommandRow): Promise<void> {
    const statement =
      row.kind === "review" ? this.reviewInsert(orgId, row) : this.approvalInsert(orgId, row);
    const inserted = await statement.run();
    if (inserted.meta.changes !== 1 && !(await this.governanceMatches(orgId, row))) {
      throw new Error("GOVERNANCE_PROJECTION_MISMATCH");
    }
  }

  private reviewInsert(orgId: string, row: GovernanceCommandRow): D1PreparedStatement {
    const command = this.governanceActor(row.record_id);
    return this.env.DB.prepare(
      `INSERT INTO reviews (
        id, org_id, artifact_id, artifact_version, reviewer_type, reviewer_id, result,
        policy_version, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.record_id,
      orgId,
      row.artifact_id,
      row.version,
      command.actor_type,
      command.actor_id,
      row.result,
      row.policy_version,
      command.idempotency_key,
      row.created_at,
    );
  }

  private approvalInsert(orgId: string, row: GovernanceCommandRow): D1PreparedStatement {
    const command = this.governanceActor(row.record_id);
    return this.env.DB.prepare(
      `INSERT INTO approvals (
        id, org_id, artifact_id, artifact_version, kind, actor_type, actor_id, decision, reason,
        policy_version, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.record_id,
      orgId,
      row.artifact_id,
      row.version,
      row.kind,
      command.actor_type,
      command.actor_id,
      row.decision === "ALLOW" ? "PASS" : "DENY",
      row.reason,
      row.policy_version,
      command.idempotency_key,
      row.created_at,
    );
  }

  private governanceActor(recordId: string): {
    actor_type: string;
    actor_id: string;
    idempotency_key: string;
  } {
    const command = this.governanceByRecord(recordId);
    if (!command) {
      throw new Error("GOVERNANCE_PROJECTION_MISMATCH");
    }
    return command;
  }

  private async governanceMatches(orgId: string, row: GovernanceCommandRow): Promise<boolean> {
    const command = this.governanceByRecord(row.record_id);
    if (!command) {
      return false;
    }
    if (row.kind === "review") {
      const stored = await this.env.DB.prepare(
        `SELECT artifact_id, artifact_version, result FROM reviews
         WHERE org_id = ? AND id = ?`,
      )
        .bind(orgId, row.record_id)
        .first<{ artifact_id: string; artifact_version: number; result: string }>();
      return (
        stored?.artifact_id === row.artifact_id &&
        stored.artifact_version === row.version &&
        stored.result === row.result
      );
    }
    const stored = await this.env.DB.prepare(
      `SELECT artifact_id, artifact_version, kind, decision, reason FROM approvals
       WHERE org_id = ? AND id = ?`,
    )
      .bind(orgId, row.record_id)
      .first<{
        artifact_id: string;
        artifact_version: number;
        kind: string;
        decision: string;
        reason: string;
      }>();
    return (
      stored?.artifact_id === row.artifact_id &&
      stored.artifact_version === row.version &&
      stored.kind === row.kind &&
      stored.decision === (row.decision === "ALLOW" ? "PASS" : "DENY") &&
      stored.reason === row.reason
    );
  }

  private claimGovernance(
    plan: GovernancePlan,
    recordId: string,
    eventId: string,
    correlationId: string,
    beforeDigest: string | null,
    afterDigest: string,
    createdAt: string,
  ): GovernanceCommandRow | null {
    let reserved: GovernanceCommandRow | null = null;
    this.ctx.storage.transactionSync(() => {
      if (this.governanceByKey(plan.actor)) {
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO governance_commands (
          actor_type, actor_id, idempotency_key, kind, artifact_id, version, result, decision, reason,
          record_id, policy_version, before_digest, after_digest, event_id, correlation_id, created_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        plan.actor.actorType,
        plan.actor.actorId,
        plan.actor.idempotencyKey,
        plan.kind,
        plan.artifact.id,
        plan.version,
        plan.result,
        plan.decision,
        plan.reason,
        recordId,
        plan.policyVersion,
        beforeDigest,
        afterDigest,
        eventId,
        correlationId,
        createdAt,
      );
      reserved = {
        kind: plan.kind,
        artifact_id: plan.artifact.id,
        version: plan.version,
        result: plan.result,
        decision: plan.decision,
        reason: plan.reason,
        record_id: recordId,
        policy_version: plan.policyVersion,
        before_digest: beforeDigest,
        after_digest: afterDigest,
        event_id: eventId,
        correlation_id: correlationId,
        created_at: createdAt,
        status: "pending",
      };
    });
    return reserved;
  }

  private sealGovernance(
    actor: Actor & { idempotencyKey: string },
    row: GovernanceCommandRow,
    event: GovernanceDomainEvent,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const current = this.governanceByKey(actor);
      if (!current || current.status === "stored") {
        return;
      }
      if (row.kind === "review") {
        const review = this.ctx.storage.sql
          .exec<{ id: string }>(`SELECT id FROM governance_reviews WHERE id = ?`, row.record_id)
          .toArray()[0];
        if (!review) {
          this.ctx.storage.sql.exec(
            `INSERT INTO governance_reviews (
              id, artifact_id, version, reviewer_type, reviewer_id, result, policy_version,
              idempotency_key, before_digest, after_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.record_id,
            row.artifact_id,
            row.version,
            actor.actorType,
            actor.actorId,
            row.result,
            row.policy_version,
            actor.idempotencyKey,
            row.before_digest,
            row.after_digest,
            row.created_at,
          );
        }
      } else {
        const approval = this.ctx.storage.sql
          .exec<{ id: string }>(`SELECT id FROM governance_approvals WHERE id = ?`, row.record_id)
          .toArray()[0];
        if (!approval) {
          this.ctx.storage.sql.exec(
            `INSERT INTO governance_approvals (
              id, artifact_id, version, kind, actor_type, actor_id, decision, reason, result,
              policy_version, idempotency_key, before_digest, after_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.record_id,
            row.artifact_id,
            row.version,
            row.kind,
            actor.actorType,
            actor.actorId,
            row.decision,
            row.reason,
            row.result,
            row.policy_version,
            actor.idempotencyKey,
            row.before_digest,
            row.after_digest,
            row.created_at,
          );
        }
      }
      const outbox = this.governanceOutbox(actor);
      if (!outbox) {
        this.ctx.storage.sql.exec(
          `INSERT INTO governance_outbox (
            event_id, actor_type, actor_id, idempotency_key, body, status
          ) VALUES (?, ?, ?, ?, ?, 'pending')`,
          event.event_id,
          actor.actorType,
          actor.actorId,
          actor.idempotencyKey,
          JSON.stringify(event),
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE governance_commands SET status = 'stored'
         WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
        actor.actorType,
        actor.actorId,
        actor.idempotencyKey,
      );
    });
  }

  private sealGovernanceDenial(actor: Actor & { idempotencyKey: string }, reason: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE governance_commands
         SET decision = 'DENY', reason = ?, status = 'stored'
         WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ? AND status = 'pending'`,
        reason,
        actor.actorType,
        actor.actorId,
        actor.idempotencyKey,
      );
    });
  }

  private async publishGovernance(actor: Actor & { idempotencyKey: string }): Promise<void> {
    const pending = this.governanceOutbox(actor);
    if (!pending || pending.status !== "pending") {
      return;
    }
    await this.deliverOutbox("governance_outbox", pending.event_id, pending.body);
  }

  private previousDigest(artifactId: string, version: number, kind: GovernanceKind): string | null {
    if (kind === "review") {
      const row = this.ctx.storage.sql
        .exec<{ after_digest: string }>(
          `SELECT after_digest FROM governance_reviews
           WHERE artifact_id = ? AND version = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          artifactId,
          version,
        )
        .toArray()[0];
      return row?.after_digest ?? null;
    }
    const row = this.ctx.storage.sql
      .exec<{ after_digest: string }>(
        `SELECT after_digest FROM governance_approvals
         WHERE artifact_id = ? AND version = ? AND kind = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        artifactId,
        version,
        kind,
      )
      .toArray()[0];
    return row?.after_digest ?? null;
  }

  private samePlan(row: GovernanceCommandRow, plan: GovernancePlan): boolean {
    return (
      row.kind === plan.kind &&
      row.artifact_id === plan.artifact.id &&
      row.version === plan.version &&
      row.result === plan.result &&
      row.decision === plan.decision &&
      row.reason === plan.reason
    );
  }

  private governanceByKey(actor: Actor & { idempotencyKey: string }): GovernanceCommandRow | null {
    return (
      this.ctx.storage.sql
        .exec<GovernanceCommandRow>(
          `SELECT kind, artifact_id, version, result, decision, reason, record_id, policy_version,
                  before_digest, after_digest, event_id, correlation_id, created_at, status
           FROM governance_commands
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          actor.actorType,
          actor.actorId,
          actor.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  private governanceByRecord(recordId: string): {
    actor_type: string;
    actor_id: string;
    idempotency_key: string;
  } | null {
    return (
      this.ctx.storage.sql
        .exec<{ actor_type: string; actor_id: string; idempotency_key: string }>(
          `SELECT actor_type, actor_id, idempotency_key FROM governance_commands WHERE record_id = ?`,
          recordId,
        )
        .toArray()[0] ?? null
    );
  }

  private governanceOutbox(
    actor: Actor & { idempotencyKey: string },
  ): { event_id: string; body: string; status: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ event_id: string; body: string; status: string }>(
          `SELECT event_id, body, status FROM governance_outbox
           WHERE actor_type = ? AND actor_id = ? AND idempotency_key = ?`,
          actor.actorType,
          actor.actorId,
          actor.idempotencyKey,
        )
        .toArray()[0] ?? null
    );
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      task_id TEXT,
      creator_type TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      canonical_version INTEGER NOT NULL,
      correlation_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      room_id TEXT NOT NULL,
      task_id TEXT,
      correlation_id TEXT NOT NULL DEFAULT '',
      r2_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      filename TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS artifact_commands (
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      requested_artifact_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS event_outbox (
      event_id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      failure_reason TEXT,
      UNIQUE (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS publish_fault (
      id INTEGER PRIMARY KEY,
      remaining INTEGER NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS governance_commands (
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      result TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      record_id TEXT NOT NULL UNIQUE,
      policy_version INTEGER NOT NULL,
      before_digest TEXT,
      after_digest TEXT NOT NULL,
      event_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS governance_reviews (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      reviewer_type TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      result TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      before_digest TEXT,
      after_digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS governance_approvals (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT NOT NULL,
      result TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      before_digest TEXT,
      after_digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS governance_outbox (
      event_id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      failure_reason TEXT,
      UNIQUE (actor_type, actor_id, idempotency_key)
    )`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS upload_capabilities (
      token_hash TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL
    )`);
    this.ensureColumn("artifacts", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("artifact_versions", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    for (const table of ["event_outbox", "governance_outbox"] as const) {
      this.ensureColumn(table, "attempts", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn(table, "next_retry_at", "INTEGER");
      this.ensureColumn(table, "failure_reason", "TEXT");
    }
    this.ctx.storage.sql.exec(
      `UPDATE artifacts SET correlation_id = 'corr_legacy_' || id WHERE correlation_id = ''`,
    );
    this.ctx.storage.sql.exec(
      `UPDATE artifact_versions
       SET correlation_id = (SELECT correlation_id FROM artifacts WHERE id = artifact_id)
       WHERE correlation_id = ''`,
    );
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const exists = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((item) => item.name === column);
    if (!exists) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }
}
