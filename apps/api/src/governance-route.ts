import type { GovernanceResult } from "@ai-company/artifact";
import { isId, isReviewResult } from "@ai-company/domain";
import type { Context, Hono } from "hono";
import { resolveHttpPrincipal } from "./http-principal";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type GovernanceContext = Context<EnvVars>;

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_BODY = 2048;

export function registerGovernanceRoutes(app: App): void {
  app.post("/orgs/:orgId/artifacts/:artifactId/reviews", async (c) => {
    return submit(c, "review");
  });
  app.post("/orgs/:orgId/artifacts/:artifactId/approvals", async (c) => {
    return submit(c, "final");
  });
  app.post("/orgs/:orgId/artifacts/:artifactId/security-approvals", async (c) => {
    return submit(c, "security");
  });
}

async function submit(
  c: GovernanceContext,
  kind: "review" | "final" | "security",
): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const artifactId = c.req.param("artifactId");
  if (!isId(orgId, "org") || !isId(artifactId, "art")) {
    return c.json(errorBody(requestId, "NOT_FOUND", "Artifact was not found."), 404);
  }
  const scope =
    kind === "review"
      ? "artifact.review"
      : kind === "final"
        ? "artifact.approve"
        : "security.approve";
  const session = await openSession(c, orgId, scope);
  if (!session.ok) {
    return session.response;
  }
  const idempotencyKey = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(idempotencyKey)) {
    return c.json(errorBody(requestId, "INVALID_INPUT", "Idempotency key is not valid."), 400);
  }
  const parsed = await readCommand(c, kind);
  if (!parsed.ok) {
    return parsed.response;
  }
  const stub = c.env.ARTIFACT.getByName(`artifacts:${orgId}`);
  const actor = {
    orgId,
    actorType: session.actorType,
    actorId: session.actorId,
    idempotencyKey,
    artifactId,
    version: parsed.version,
  };
  const result =
    kind === "review"
      ? await stub.review({ ...actor, result: parsed.result ?? "" })
      : kind === "final"
        ? await stub.finalize(actor)
        : await stub.securityApprove(actor);
  return governanceResponse(c, requestId, result);
}

async function openSession(
  c: GovernanceContext,
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
  return { ok: true, actorType: principal.actorType, actorId: principal.actorId };
}

async function readCommand(
  c: GovernanceContext,
  kind: "review" | "final" | "security",
): Promise<
  { ok: true; version: number; result: string | null } | { ok: false; response: Response }
> {
  const requestId = c.get("requestId");
  const declared = c.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Review body is not valid."), 400),
    };
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Review body is not valid."), 400),
    };
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Review body is not valid."), 400),
    };
  }
  const keys = Object.keys(body);
  const expected = kind === "review" ? ["result", "version"] : ["version"];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Review body is not valid."), 400),
    };
  }
  const version = body.version;
  if (!Number.isInteger(version) || typeof version !== "number") {
    return {
      ok: false,
      response: c.json(
        errorBody(requestId, "INVALID_INPUT", "Artifact version is not valid."),
        400,
      ),
    };
  }
  if (kind !== "review") {
    return { ok: true, version, result: null };
  }
  const result = body.result;
  if (typeof result !== "string" || !isReviewResult(result)) {
    return {
      ok: false,
      response: c.json(errorBody(requestId, "INVALID_INPUT", "Review result is not valid."), 400),
    };
  }
  return { ok: true, version, result };
}

function governanceResponse(
  c: GovernanceContext,
  requestId: string,
  result: GovernanceResult,
): Response {
  if (result.decision === "DENY") {
    return c.json(
      errorBody(requestId, result.reason, messageFor(result.reason)),
      statusFor(result.reason),
    );
  }
  return c.json(
    {
      record_id: result.recordId,
      artifact_id: result.artifactId,
      version: result.version,
      result: result.result,
      duplicate: result.duplicate,
    },
    201,
  );
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

function statusFor(reason: string): 400 | 403 | 404 | 409 {
  switch (reason) {
    case "INVALID_INPUT":
      return 400;
    case "TENANT_BOUNDARY":
      return 404;
    case "IDEMPOTENCY_MISMATCH":
      return 409;
    default:
      return 403;
  }
}

function messageFor(reason: string): string {
  switch (reason) {
    case "NO_PERMISSION":
      return "Permission was denied.";
    case "NO_SELF_APPROVAL":
      return "Creator cannot final-approve this artifact.";
    case "SECURITY_BLOCK":
      return "A security block is active.";
    case "NOT_MEMBER":
      return "Employee is not a member of the room.";
    case "IDEMPOTENCY_MISMATCH":
      return "Idempotency key was already used.";
    case "TENANT_BOUNDARY":
      return "Artifact was not found.";
    default:
      return "Review request was rejected.";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
