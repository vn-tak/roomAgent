import type { ArtifactReadResult, ArtifactResult } from "@ai-company/artifact";
import {
  MAX_ARTIFACT_BYTES,
  canonicalMediaType,
  isArtifactFilename,
  isId,
} from "@ai-company/domain";
import type { Context, Hono } from "hono";

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
      actorType: "employee",
      actorId: session.employeeId,
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
      actorType: "employee",
      actorId: session.employeeId,
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
      actorType: "employee",
      actorId: session.employeeId,
      artifactId,
      version,
    });
    return readResponse(c, requestId, result);
  });
}

async function openSession(
  c: ArtifactContext,
  orgId: string,
  scope: string,
): Promise<{ ok: true; employeeId: string } | { ok: false; response: Response }> {
  const requestId = c.get("requestId");
  const header = c.req.header("authorization");
  const employeeId = c.req.header("x-employee-id");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!employeeId || !isId(employeeId, "emp") || !/^[0-9a-f]{64}$/.test(token)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "SESSION_INVALID", "Session is not valid."), 401),
    };
  }
  const verified = await c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`).verify({
    orgId,
    employeeId,
    token,
    scope,
  });
  if (verified.decision === "DENY") {
    return {
      ok: false,
      response: c.json(
        errorBody(requestId, verified.reason, "Session is not valid."),
        sessionStatus(verified.reason),
      ),
    };
  }
  return { ok: true, employeeId };
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
    return c.json(
      errorBody(requestId, result.reason, messageFor(result.reason)),
      statusFor(result.reason),
    );
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

function readResponse(c: ArtifactContext, requestId: string, result: ArtifactReadResult): Response {
  if (result.decision === "DENY" || !result.bodyBase64 || !result.mediaType || !result.sha256) {
    const reason = result.decision === "DENY" ? result.reason : "INTEGRITY";
    return c.json(errorBody(requestId, reason, messageFor(reason)), statusFor(reason));
  }
  const bytes = decodeBase64(result.bodyBase64);
  if (!bytes) {
    return c.json(errorBody(requestId, "INTEGRITY", messageFor("INTEGRITY")), 409);
  }
  c.header("content-type", result.mediaType);
  c.header("x-artifact-id", result.artifactId ?? "");
  c.header("x-artifact-version", String(result.version ?? ""));
  c.header("x-checksum-sha256", result.sha256);
  const buffer = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(buffer);
  view.set(bytes);
  return c.body(view);
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

function statusFor(reason: string): 400 | 403 | 404 | 409 | 413 {
  switch (reason) {
    case "INVALID_INPUT":
    case "CHECKSUM_MISMATCH":
      return 400;
    case "TENANT_BOUNDARY":
      return 404;
    case "ARTIFACT_EXISTS":
    case "INTEGRITY":
    case "IDEMPOTENCY_MISMATCH":
      return 409;
    case "PAYLOAD_TOO_LARGE":
      return 413;
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

function decodeBase64(value: string): Uint8Array | null {
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (!decode) {
    return null;
  }
  try {
    const binary = decode(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
