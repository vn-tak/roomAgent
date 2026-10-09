import type {
  ArtifactReadResult,
  ArtifactResult,
  ArtifactUploadReserve,
  ArtifactUploadResult,
} from "@ai-company/artifact";
import { MAX_DIRECT_ARTIFACT_BYTES } from "@ai-company/artifact";
import {
  MAX_ARTIFACT_BYTES,
  canonicalMediaType,
  isArtifactFilename,
  isId,
} from "@ai-company/domain";
import type { Context, Hono } from "hono";
import { resolveHttpPrincipal } from "./http-principal";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type ArtifactContext = Context<EnvVars>;

const KEY = /^[A-Za-z0-9_-]{8,80}$/;

export function registerArtifactRoutes(app: App): void {
  app.post("/orgs/:orgId/rooms/:roomId/artifacts", async (c) => {
    const requestId = c.get("requestId");
    const orgId = c.req.param("orgId");
    const roomId = c.req.param("roomId");
    if (!isId(orgId, "org") || !isId(roomId, "room")) {
      return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openSession(c, orgId, "artifact.create");
    if (!session.ok) {
      return session.response;
    }
    const uploaded = await readUpload(c);
    if (!uploaded.ok) {
      return uploaded.response;
    }
    const result = await c.env.ARTIFACT.getByName(`artifacts:${orgId}`).put({
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      idempotencyKey: uploaded.idempotencyKey,
      roomId,
      artifactId: null,
      taskId: uploaded.taskId,
      mediaType: uploaded.mediaType,
      filename: uploaded.filename,
      checksum: uploaded.checksum,
      bodyBase64: encodeBase64(uploaded.bytes),
    });
    return putResponse(c, requestId, result);
  });

  app.post("/orgs/:orgId/artifacts/:artifactId/versions", async (c) => {
    const requestId = c.get("requestId");
    const orgId = c.req.param("orgId");
    const artifactId = c.req.param("artifactId");
    if (!isId(orgId, "org") || !isId(artifactId, "art")) {
      return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openSession(c, orgId, "artifact.modify");
    if (!session.ok) {
      return session.response;
    }
    const uploaded = await readUpload(c);
    if (!uploaded.ok) {
      return uploaded.response;
    }
    const result = await c.env.ARTIFACT.getByName(`artifacts:${orgId}`).put({
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      idempotencyKey: uploaded.idempotencyKey,
      roomId: null,
      artifactId,
      taskId: uploaded.taskId,
      mediaType: uploaded.mediaType,
      filename: uploaded.filename,
      checksum: uploaded.checksum,
      bodyBase64: encodeBase64(uploaded.bytes),
    });
    return putResponse(c, requestId, result);
  });

  app.get("/orgs/:orgId/artifacts/:artifactId", async (c) => {
    const requestId = c.get("requestId");
    const orgId = c.req.param("orgId");
    const artifactId = c.req.param("artifactId");
    if (!isId(orgId, "org") || !isId(artifactId, "art")) {
      return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openSession(c, orgId, "artifact.read");
    if (!session.ok) {
      return session.response;
    }
    const version = readVersion(c.req.query("version"));
    if (version === "invalid") {
      return c.json(errorBody(requestId, "INVALID_INPUT", "Artifact version is not valid."), 400);
    }
    const result = await c.env.ARTIFACT.getByName(`artifacts:${orgId}`).read({
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      artifactId,
      version,
      metadataOnly: true,
    });
    return readResponse(c, requestId, result);
  });

  app.post("/orgs/:orgId/rooms/:roomId/artifacts/uploads", async (c) => {
    const orgId = c.req.param("orgId");
    const roomId = c.req.param("roomId");
    if (!isId(orgId, "org") || !isId(roomId, "room")) {
      return c.json(errorBody(c.get("requestId"), "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openSession(c, orgId, "artifact.create");
    if (!session.ok) {
      return session.response;
    }
    return reserveDirectUpload(c, {
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      roomId,
      artifactId: null,
    });
  });

  app.post("/orgs/:orgId/artifacts/:artifactId/uploads", async (c) => {
    const orgId = c.req.param("orgId");
    const artifactId = c.req.param("artifactId");
    if (!isId(orgId, "org") || !isId(artifactId, "art")) {
      return c.json(errorBody(c.get("requestId"), "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openSession(c, orgId, "artifact.modify");
    if (!session.ok) {
      return session.response;
    }
    return reserveDirectUpload(c, {
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      roomId: null,
      artifactId,
    });
  });

  app.put("/orgs/:orgId/artifacts/uploads/:uploadToken", async (c) => {
    return streamReservedUpload(c);
  });

  app.post("/orgs/:orgId/artifacts/uploads/:uploadToken/commit", async (c) => {
    const requestId = c.get("requestId");
    const orgId = c.req.param("orgId");
    if (!isId(orgId, "org")) {
      return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
    }
    const session = await openUploadSession(c, orgId);
    if (!session.ok) {
      return session.response;
    }
    const result = await c.env.ARTIFACT.getByName(`artifacts:${orgId}`).commitUpload({
      orgId,
      actorType: session.actorType,
      actorId: session.actorId,
      uploadToken: c.req.param("uploadToken"),
    });
    return putResponse(c, requestId, result);
  });
}

async function openSession(
  c: ArtifactContext,
  orgId: string,
  scope: string,
): Promise<
  { ok: true; actorType: "human" | "employee"; actorId: string } | { ok: false; response: Response }
> {
  const requestId = c.get("requestId");
  const principal = await resolveHttpPrincipal(
    c.env,
    orgId,
    c.req.header("authorization"),
    c.req.header("x-employee-id"),
    scope,
  );
  if (principal.decision === "DENY" || !principal.actorType || !principal.actorId) {
    return {
      ok: false,
      response: c.json(
        errorBody(requestId, principal.reason, "Session is not valid."),
        sessionStatus(principal.reason),
      ),
    };
  }
  return {
    ok: true,
    actorType: principal.actorType,
    actorId: principal.actorId,
  };
}

async function openUploadSession(
  c: ArtifactContext,
  orgId: string,
): Promise<
  { ok: true; actorType: "human" | "employee"; actorId: string } | { ok: false; response: Response }
> {
  const createSession = await openSession(c, orgId, "artifact.create");
  if (createSession.ok || createSession.response.status !== 403) {
    return createSession;
  }
  return openSession(c, orgId, "artifact.modify");
}

async function reserveDirectUpload(
  c: ArtifactContext,
  actor: Pick<ArtifactUploadReserve, "orgId" | "actorType" | "actorId" | "roomId" | "artifactId">,
): Promise<Response> {
  const requestId = c.get("requestId");
  const parsed = directUploadMetadata(c);
  if (!parsed.ok) {
    return parsed.response;
  }
  const command: ArtifactUploadReserve = {
    ...actor,
    ...parsed.value,
  };
  const reserved = await c.env.ARTIFACT.getByName(`artifacts:${actor.orgId}`).reserveUpload(
    command,
  );
  return uploadReservationResponse(c, requestId, reserved);
}

async function streamReservedUpload(c: ArtifactContext): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
  }
  const session = await openUploadSession(c, orgId);
  if (!session.ok) {
    return session.response;
  }
  const uploadToken = c.req.param("uploadToken");
  const target = await c.env.ARTIFACT.getByName(`artifacts:${orgId}`).uploadTarget({
    orgId,
    actorType: session.actorType,
    actorId: session.actorId,
    uploadToken,
  });
  if (target.decision === "DENY" || !target.r2Key || !target.sha256 || !target.mediaType) {
    const reason = target.decision === "DENY" ? target.reason : "UPLOAD_CAPABILITY_INVALID";
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  const declared = c.req.header("content-length") ?? "";
  const size = /^\d+$/.test(declared) ? Number(declared) : 0;
  if (size !== target.size || size < 1) {
    return c.json(errorBody(requestId, "INVALID_INPUT", "Content length does not match."), 400);
  }
  const checksum = fromHex(target.sha256);
  const body = c.req.raw.body;
  if (!checksum || !body) {
    return c.json(errorBody(requestId, "INVALID_INPUT", "Artifact body is empty."), 400);
  }
  try {
    const created = await c.env.ARTIFACTS.put(target.r2Key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: checksum,
      httpMetadata: { contentType: target.mediaType },
      customMetadata: { sha256: target.sha256 },
    });
    if (!created) {
      return c.json(errorBody(requestId, "ARTIFACT_EXISTS", messageFor("ARTIFACT_EXISTS")), 409);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : "";
    const reason =
      detail.includes("checksum") || detail.includes("digest")
        ? "CHECKSUM_MISMATCH"
        : "UPLOAD_UNAVAILABLE";
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  return c.json({ uploaded: true }, 201);
}

function uploadReservationResponse(
  c: ArtifactContext,
  requestId: string,
  result: ArtifactUploadResult,
): Response {
  if (result.decision === "DENY") {
    const reason = publicArtifactReason(result.reason);
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  const uploadUrl = result.uploadToken
    ? new URL(
        `/orgs/${encodeURIComponent(c.req.param("orgId"))}/artifacts/uploads/${result.uploadToken}`,
        c.req.url,
      ).toString()
    : null;
  return c.json(
    {
      artifact_id: result.artifactId,
      version: result.version,
      sha256: result.sha256,
      upload_url: uploadUrl,
      commit_url: result.uploadToken ? `${uploadUrl}/commit` : null,
      expires_at: result.expiresAt ? new Date(result.expiresAt).toISOString() : null,
      duplicate: result.duplicate,
    },
    result.duplicate ? 200 : 201,
  );
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

function directUploadMetadata(c: ArtifactContext):
  | {
      ok: true;
      value: Pick<
        ArtifactUploadReserve,
        "idempotencyKey" | "taskId" | "mediaType" | "filename" | "checksum" | "size"
      >;
    }
  | { ok: false; response: Response } {
  const requestId = c.get("requestId");
  const idempotencyKey = c.req.header("x-idempotency-key") ?? "";
  const mediaType = canonicalMediaType(c.req.header("content-type") ?? "");
  const filename = c.req.header("x-filename") ?? null;
  const taskId = c.req.header("x-task-id") ?? null;
  const checksum = c.req.header("x-checksum-sha256")?.toLowerCase() ?? "";
  const declared = c.req.header("x-artifact-size") ?? "";
  const size = /^\d+$/.test(declared) ? Number(declared) : 0;
  const error = (code: string, message: string, status: number) => ({
    ok: false as const,
    response: c.json(errorBody(requestId, code, message), status as 400 | 413),
  });
  if (!KEY.test(idempotencyKey)) {
    return error("INVALID_INPUT", "Idempotency key is not valid.", 400);
  }
  if (!mediaType) {
    return error("INVALID_INPUT", "Media type is not allowed.", 400);
  }
  if (filename !== null && !isArtifactFilename(filename)) {
    return error("INVALID_INPUT", "Filename is not valid.", 400);
  }
  if (taskId !== null && !isId(taskId, "task")) {
    return error("INVALID_INPUT", "Task is not valid.", 400);
  }
  if (!/^[0-9a-f]{64}$/.test(checksum) || size < 1) {
    return error("INVALID_INPUT", "Upload checksum and content length are required.", 400);
  }
  if (size > MAX_DIRECT_ARTIFACT_BYTES) {
    return error("PAYLOAD_TOO_LARGE", "Artifact exceeds the direct upload limit.", 413);
  }
  return {
    ok: true,
    value: { idempotencyKey, taskId, mediaType, filename, checksum, size },
  };
}

async function readUpload(c: ArtifactContext): Promise<
  | {
      ok: true;
      bytes: Uint8Array;
      mediaType: string;
      filename: string | null;
      checksum: string | null;
      taskId: string | null;
      idempotencyKey: string;
    }
  | { ok: false; response: Response }
> {
  const requestId = c.get("requestId");
  const idempotencyKey = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(idempotencyKey)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Idempotency key is not valid."), 400),
    };
  }
  const mediaType = canonicalMediaType(c.req.header("content-type") ?? "");
  if (!mediaType) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Media type is not allowed."), 400),
    };
  }
  const filenameHeader = c.req.header("x-filename");
  if (filenameHeader !== undefined && !isArtifactFilename(filenameHeader)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Filename is not valid."), 400),
    };
  }
  const taskHeader = c.req.header("x-task-id");
  if (taskHeader !== undefined && !isId(taskHeader, "task")) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Task was not found."), 400),
    };
  }
  const checksumHeader = c.req.header("x-checksum-sha256");
  if (checksumHeader !== undefined && !/^[0-9a-fA-F]{64}$/.test(checksumHeader)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Checksum is not valid."), 400),
    };
  }
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      return {
        ok: false,
        response: c.json(
          errorBody(requestId, "INVALID_INPUT", "Content length is not valid."),
          400,
        ),
      };
    }
    const length = Number(declared);
    if (length === 0) {
      return {
        ok: false,
        response: c.json(errorBody(requestId, "INVALID_INPUT", "Artifact body is empty."), 400),
      };
    }
    if (length > MAX_ARTIFACT_BYTES) {
      return {
        ok: false,
        response: c.json(errorBody(requestId, "PAYLOAD_TOO_LARGE", "Artifact is too large."), 413),
      };
    }
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Artifact body is empty."), 400),
    };
  }
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "PAYLOAD_TOO_LARGE", "Artifact is too large."), 413),
    };
  }
  return {
    ok: true,
    bytes,
    mediaType,
    filename: filenameHeader ?? null,
    checksum: checksumHeader?.toLowerCase() ?? null,
    taskId: taskHeader ?? null,
    idempotencyKey,
  };
}

function readVersion(value: string | undefined): number | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (!/^[1-9][0-9]{0,6}$/.test(value)) {
    return "invalid";
  }
  return Number(value);
}

function putResponse(c: ArtifactContext, requestId: string, result: ArtifactResult): Response {
  if (result.decision === "DENY") {
    const reason = publicArtifactReason(result.reason);
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  return c.json(
    {
      artifact_id: result.artifactId,
      version: result.version,
      canonical_version: result.canonicalVersion,
      r2_key: result.r2Key,
      sha256: result.sha256,
      duplicate: result.duplicate,
    },
    201,
  );
}

function publicArtifactReason(reason: string): string {
  return reason === "ROOM_MISMATCH" ? "TENANT_BOUNDARY" : reason;
}

async function readResponse(
  c: ArtifactContext,
  requestId: string,
  result: ArtifactReadResult,
): Promise<Response> {
  if (
    result.decision === "DENY" ||
    !result.r2Key ||
    !result.mediaType ||
    !result.sha256 ||
    result.size === null
  ) {
    const reason = result.decision === "DENY" ? result.reason : "INTEGRITY";
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  const object = await c.env.ARTIFACTS.get(result.r2Key);
  if (!object || object.size !== result.size) {
    return c.json(errorBody(requestId, "INTEGRITY", messageFor("INTEGRITY")), 409);
  }
  const checksum = object.checksums.sha256;
  if (checksum && toHex(new Uint8Array(checksum)) !== result.sha256) {
    return c.json(errorBody(requestId, "INTEGRITY", messageFor("INTEGRITY")), 409);
  }
  c.header("content-type", result.mediaType);
  c.header("x-artifact-id", result.artifactId ?? "");
  c.header("x-artifact-version", String(result.version ?? ""));
  c.header("x-checksum-sha256", result.sha256);
  return c.body(object.body);
}

function toHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}

function sessionStatus(reason: string): 401 | 403 | 404 {
  if (reason === "TENANT_BOUNDARY") {
    return 404;
  }
  if (reason === "NO_SCOPE" || reason === "SUSPENDED_AGENT_DENY") {
    return 403;
  }
  return 401;
}

function statusFor(reason: string): 400 | 403 | 404 | 409 | 413 | 503 {
  switch (reason) {
    case "INVALID_INPUT":
    case "CHECKSUM_MISMATCH":
      return 400;
    case "TENANT_BOUNDARY":
    case "ROOM_MISMATCH":
      return 404;
    case "ARTIFACT_EXISTS":
    case "INTEGRITY":
    case "IDEMPOTENCY_MISMATCH":
    case "UPLOAD_CAPABILITY_INVALID":
    case "UPLOAD_MISSING":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "UPLOAD_UNAVAILABLE":
      return 503;
    default:
      return 403;
  }
}

function messageFor(reason: string): string {
  switch (reason) {
    case "CHECKSUM_MISMATCH":
      return "Checksum does not match the body.";
    case "ARTIFACT_EXISTS":
      return "Artifact object already exists.";
    case "INTEGRITY":
      return "Artifact bytes do not match the stored checksum.";
    case "NOT_CREATOR":
      return "Only the creator can add a version.";
    case "NOT_MEMBER":
      return "Employee is not a member of the room.";
    case "NO_PERMISSION":
      return "Permission was denied.";
    case "IDEMPOTENCY_MISMATCH":
      return "Idempotency key was already used.";
    case "TENANT_BOUNDARY":
      return "Artifact was not found.";
    case "ROOM_MISMATCH":
    case "UPLOAD_CAPABILITY_INVALID":
      return "Artifact was not found.";
    case "UPLOAD_MISSING":
      return "Reserved artifact upload is not present.";
    case "UPLOAD_UNAVAILABLE":
      return "Artifact upload is temporarily unavailable.";
    default:
      return "Artifact request was rejected.";
  }
}

function errorBody(requestId: string, code: string, message: string) {
  return {
    error: {
      code,
      message,
      request_id: requestId,
    },
  };
}

function encodeBase64(bytes: Uint8Array): string {
  const encode = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!encode) {
    throw new Error("Base64 is required.");
  }
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
  return encode(binary);
}
