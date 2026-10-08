import { isId } from "@ai-company/domain";
import { Hono } from "hono";
import { registerArtifactRoutes } from "./artifacts-route";
import { registerGovernanceRoutes } from "./governance-route";
import { handleQueue } from "./events/consumer";

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
