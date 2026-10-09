import { isId } from "@ai-company/domain";
import type { Context, Hono } from "hono";
import { accessConfig, verifyAccessJwt } from "./access-jwt";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type BootstrapContext = Context<EnvVars>;

const ACCESS_HEADER = "cf-access-jwt-assertion";
const SESSION_TTL_SECONDS = 900;

interface IdentityRow {
  id: string;
  user_id: string;
  email: string;
  status: string;
}

export function registerHumanBootstrapRoutes(app: App): void {
  app.post("/orgs/:orgId/human-sessions", (c) => issue(c));
  app.delete("/orgs/:orgId/human-sessions/current", (c) => revoke(c));
}

async function issue(c: BootstrapContext): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return c.json(errorBody(requestId, "NOT_FOUND", "Organization was not found."), 404);
  }
  const config = accessConfig(c.env);
  if (!config) {
    return c.json(
      errorBody(requestId, "BOOTSTRAP_NOT_CONFIGURED", "Operator bootstrap is disabled."),
      503,
    );
  }
  const assertion = c.req.header(ACCESS_HEADER);
  const identity = assertion ? await verifyAccessJwt(assertion, config) : null;
  if (!identity) {
    audit(requestId, "denied", "ACCESS_IDENTITY_INVALID");
    return c.json(errorBody(requestId, "ACCESS_IDENTITY_INVALID", "Identity was rejected."), 401);
  }

  const mapped = await resolveIdentity(c.env, identity.issuer, identity.email, identity.subject);
  if (!mapped.ok) {
    audit(requestId, "denied", mapped.reason);
    return c.json(errorBody(requestId, mapped.reason, "Identity was rejected."), 403);
  }
  const issued = await c.env.ORGANIZATION.getByName(`org:${orgId}`).issueAccessHumanSession({
    orgId,
    userId: mapped.row.user_id,
    identityId: mapped.row.id,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  if (issued.decision !== "ALLOW" || !issued.token || !issued.sessionId) {
    audit(requestId, "denied", issued.reason);
    return c.json(errorBody(requestId, "PERMISSION_DENIED", "Session was not issued."), 403);
  }
  audit(requestId, "issued", "ALLOWED");
  return c.json(
    {
      session_id: issued.sessionId,
      token: issued.token,
      expires_at: issued.expiresAt,
      token_type: "Bearer",
    },
    201,
  );
}

async function revoke(c: BootstrapContext): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return c.json(errorBody(requestId, "NOT_FOUND", "Organization was not found."), 404);
  }
  const authorization = c.req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!/^hum_[0-9a-f]{64}$/.test(token)) {
    return c.json(errorBody(requestId, "SESSION_INVALID", "Session is not valid."), 401);
  }
  const revoked = await c.env.ORGANIZATION.getByName(`org:${orgId}`).revokeHumanSessionToken({
    orgId,
    token,
  });
  if (revoked.decision !== "ALLOW") {
    return c.json(errorBody(requestId, "SESSION_INVALID", "Session is not valid."), 401);
  }
  audit(requestId, "revoked", "ALLOWED");
  return c.json({ session_id: revoked.sessionId, revoked: true });
}

// The operator provisions (issuer, subject, email) with an approval reference before first
// use. Identity is the verified Access subject; the email must still match it.
async function resolveIdentity(
  env: Env,
  issuer: string,
  email: string,
  subject: string,
): Promise<{ ok: true; row: IdentityRow } | { ok: false; reason: string }> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, email, status FROM human_identities WHERE issuer = ? AND subject = ?`,
  )
    .bind(issuer, subject)
    .first<IdentityRow>();
  if (!row) {
    // A known email under an unknown subject is a reassigned or impersonated account.
    const byEmail = await env.DB.prepare(
      `SELECT 1 AS found FROM human_identities WHERE issuer = ? AND email = ?`,
    )
      .bind(issuer, email)
      .first<{ found: number }>();
    return { ok: false, reason: byEmail ? "IDENTITY_MISMATCH" : "IDENTITY_NOT_MAPPED" };
  }
  if (row.email !== email) return { ok: false, reason: "IDENTITY_MISMATCH" };
  if (row.status !== "active") return { ok: false, reason: "IDENTITY_DISABLED" };
  return { ok: true, row };
}

// Structured log without identity, token, or assertion material.
function audit(requestId: string, outcome: string, reason: string): void {
  console.log(
    JSON.stringify({ level: "info", event: "human.bootstrap", requestId, outcome, reason }),
  );
}

function errorBody(requestId: string, code: string, message: string) {
  return { error: { code, message, request_id: requestId } };
}
