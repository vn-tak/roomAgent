import { sha256Hex, isId } from "@ai-company/domain";
import { Hono } from "hono";
import { registerArtifactRoutes } from "./artifacts-route";
import { registerGovernanceRoutes } from "./governance-route";
import { registerHumanBootstrapRoutes } from "./human-bootstrap-route";
import { handleQueue } from "./events/consumer";
import { resolveHttpPrincipal } from "./http-principal";
import { registerWorkflowStartRoutes } from "./workflow-start-route";

export { AgentDO } from "@ai-company/agent";
export { ArtifactDO } from "@ai-company/artifact";
export { OrganizationDO } from "@ai-company/organization";
export { RoomDO } from "@ai-company/room";
export { TaskDO } from "@ai-company/task";
export { ProductionTaskWorkflow } from "./production-task-workflow";

type Variables = {
  requestId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function requestIdFrom(header: string | undefined): string {
  if (header && /^[A-Za-z0-9_-]{8,80}$/.test(header)) {
    return header;
  }
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

app.use("*", async (c, next) => {
  const requestId = requestIdFrom(c.req.header("x-request-id"));
  c.set("requestId", requestId);
  await next();
  if (c.res.status !== 101) {
    c.header("cache-control", "no-store");
    c.header("x-request-id", requestId);
  }
});

app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1 AS ok").first();
  return c.json({ status: "ok", service: "ai-company-os-api" });
});

app.get("/orgs/:orgId/rooms/:roomId/socket", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const roomId = c.req.param("roomId");
  if (!isId(orgId, "org") || !isId(roomId, "room")) {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Room was not found.",
          request_id: requestId,
        },
      },
      404,
    );
  }
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json(
      {
        error: {
          code: "UPGRADE_REQUIRED",
          message: "WebSocket upgrade is required.",
          request_id: requestId,
        },
      },
      426,
    );
  }
  const stub = c.env.ROOM.getByName(`room:${orgId}:${roomId}`);
  return stub.fetch(c.req.raw);
});

app.get("/orgs/:orgId/rooms/:roomId/snapshot", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const roomId = c.req.param("roomId");
  if (!isId(orgId, "org") || !isId(roomId, "room")) {
    return c.json(notFoundBody(requestId, "Room was not found."), 404);
  }
  const principal = await resolveHttpPrincipal(
    c.env,
    orgId,
    c.req.header("authorization"),
    c.req.header("x-employee-id"),
    "room.read",
  );
  if (principal.decision !== "ALLOW" || !principal.actorId || principal.actorType !== "employee") {
    return c.json(
      {
        error: {
          code: "SESSION_INVALID",
          message: "Employee session is required.",
          request_id: requestId,
        },
      },
      401,
    );
  }
  const snapshot = await c.env.ROOM.getByName(`room:${orgId}:${roomId}`).snapshot({
    orgId,
    roomId,
    actorType: "employee",
    actorId: principal.actorId,
  });
  if (snapshot.decision === "DENY") {
    return c.json(
      {
        error: {
          code: snapshot.reason,
          message: "Room snapshot was rejected.",
          request_id: requestId,
        },
      },
      snapshot.reason === "TENANT_BOUNDARY" ? 404 : 403,
    );
  }
  return c.json({
    room_id: snapshot.roomId,
    head_seq: snapshot.headSeq,
    room: snapshot.room,
    members: snapshot.members.map((m) => ({ employee_id: m.employeeId, joined_at: m.joinedAt })),
    presence: snapshot.presence.map((p) => ({ employee_id: p.employeeId, state: p.state })),
    tasks: snapshot.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      assignee_id: t.assigneeId,
      updated_at: t.updatedAt,
    })),
    artifacts: snapshot.artifacts.map((a) => ({
      id: a.id,
      task_id: a.taskId,
      canonical_version: a.canonicalVersion,
      updated_at: a.updatedAt,
    })),
  });
});

app.post("/orgs/:orgId/join", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  if (!isId(orgId, "org")) {
    return c.json(notFoundBody(requestId, "Organization was not found."), 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(invalidBody(requestId), 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json(invalidBody(requestId), 400);
  }
  const record = body as Record<string, unknown>;
  const employeeId = record.employee_id;
  const code = record.code;
  if (typeof employeeId !== "string" || !isId(employeeId, "emp")) {
    return c.json(notFoundBody(requestId, "Employee was not found."), 404);
  }
  if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) {
    return c.json(invalidBody(requestId), 400);
  }
  const result = await c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`).redeem({
    orgId,
    employeeId,
    code,
  });
  if (result.decision === "ALLOW") {
    return c.json({
      session_id: result.sessionId,
      expires_at: result.expiresAt,
      token: result.token,
    });
  }
  const status =
    result.reason === "THROTTLED" ? 429 : result.reason === "TENANT_BOUNDARY" ? 404 : 403;
  return c.json(
    {
      error: {
        code: result.reason,
        message: "Join was rejected.",
        request_id: requestId,
      },
    },
    status,
  );
});

app.post("/j/:token", async (c) => {
  const requestId = c.get("requestId");
  const token = c.req.param("token");
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return c.json(notFoundBody(requestId, "Join was not found."), 404);
  }
  const join = await c.env.DB.prepare(
    `SELECT org_id, employee_id FROM join_codes WHERE code_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<{ org_id: string; employee_id: string }>();
  if (!join) return c.json(notFoundBody(requestId, "Join was not found."), 404);
  const result = await c.env.AGENT.getByName(`agent:${join.org_id}:${join.employee_id}`).redeem({
    orgId: join.org_id,
    employeeId: join.employee_id,
    code: token,
  });
  if (result.decision === "DENY") {
    return c.json(
      { error: { code: result.reason, message: "Join was rejected.", request_id: requestId } },
      result.reason === "THROTTLED" ? 429 : 403,
    );
  }
  c.header("cache-control", "no-store");
  return c.json({
    session_id: result.sessionId,
    token: result.token,
    expires_at: result.expiresAt,
  });
});

app.get("/orgs/:orgId/agents/:employeeId/socket", async (c) => {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const employeeId = c.req.param("employeeId");
  if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
    return c.json(notFoundBody(requestId, "Employee was not found."), 404);
  }
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json(
      {
        error: {
          code: "UPGRADE_REQUIRED",
          message: "WebSocket upgrade is required.",
          request_id: requestId,
        },
      },
      426,
    );
  }
  const stub = c.env.AGENT.getByName(`agent:${orgId}:${employeeId}`);
  return stub.fetch(c.req.raw);
});

registerArtifactRoutes(app);
registerGovernanceRoutes(app);
registerHumanBootstrapRoutes(app);
registerWorkflowStartRoutes(app);

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Route was not found.",
        request_id: c.get("requestId"),
      },
    },
    404,
  ),
);

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? requestIdFrom(undefined);
  console.log(
    JSON.stringify({
      level: "error",
      requestId,
      name: error.name,
    }),
  );
  return c.json(
    {
      error: {
        code: "INTERNAL",
        message: "Request failed.",
        request_id: requestId,
      },
    },
    500,
  );
});

function notFoundBody(requestId: string, message: string) {
  return {
    error: {
      code: "NOT_FOUND",
      message,
      request_id: requestId,
    },
  };
}

function invalidBody(requestId: string) {
  return {
    error: {
      code: "INVALID_INPUT",
      message: "Join request is not valid.",
      request_id: requestId,
    },
  };
}

export default {
  fetch: app.fetch.bind(app),
  queue: handleQueue,
};
