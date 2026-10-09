import { createId, isId } from "@ai-company/domain";
import type { Context, Hono } from "hono";
import { resolveHttpPrincipal } from "./http-principal";
import type { ProductionTaskParams } from "./production-task-workflow";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type StartContext = Context<EnvVars>;

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_BODY = 1024;
const START_SCOPE = "task.assign";
const GOVERNED_POLICIES = new Set(["ARTIFACT_APPROVED", "QA_SECURITY", "HUMAN_FINAL"]);
const TERMINAL_RUN = new Set(["complete", "denied", "paused"]);
const TERMINAL_INSTANCE = new Set(["errored", "terminated", "complete"]);

interface StartRequest {
  orgId: string;
  taskId: string;
  artifactId: string;
  version: number;
  actorType: "human" | "employee";
  actorId: string;
  idempotencyKey: string;
}

interface ClaimRow {
  id: string;
  task_id: string;
  artifact_id: string;
  artifact_version: number;
  actor_type: string;
  actor_id: string;
  state: "claimed" | "created" | "released";
}

type Failure = { status: 400 | 401 | 403 | 404 | 409; code: string; runId?: string };

export function registerWorkflowStartRoutes(app: App): void {
  app.post("/orgs/:orgId/tasks/:taskId/workflow-runs", (c) => start(c));
}

async function start(c: StartContext): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const taskId = c.req.param("taskId");
  if (!isId(orgId, "org") || !isId(taskId, "task")) {
    return fail(c, { status: 404, code: "NOT_FOUND" });
  }
  // 1-3. Authenticate a server-resolved actor and authorize the structured action.
  const principal = await resolveHttpPrincipal(
    c.env,
    orgId,
    c.req.header("authorization"),
    c.req.header("x-employee-id"),
    START_SCOPE,
  );
  if (principal.decision === "DENY" || !principal.actorType || !principal.actorId) {
    return fail(c, { status: sessionStatus(principal.reason), code: principal.reason });
  }
  const idempotencyKey = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(idempotencyKey)) return fail(c, { status: 400, code: "INVALID_INPUT" });
  const body = await readBody(c);
  if (!body) return fail(c, { status: 400, code: "INVALID_INPUT" });

  const decision = await c.env.ORGANIZATION.getByName(`org:${orgId}`).authorize({
    orgId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    action: "workflow.start",
    resourceType: "task",
    resourceId: taskId,
  });
  if (decision.decision === "DENY") {
    return fail(c, {
      status: decision.reason === "TENANT_BOUNDARY" ? 404 : 403,
      code: decision.reason,
    });
  }

  const request: StartRequest = {
    orgId,
    taskId,
    artifactId: body.artifactId,
    version: body.version,
    actorType: principal.actorType,
    actorId: principal.actorId,
    idempotencyKey,
  };
  // A retried request returns its original logical run even if the task has moved on.
  const replay = await claimByKey(c.env, orgId, idempotencyKey);
  if (replay) return respondReplay(c, request, replay);

  // 4-9. Eligibility is read from the authoritative projections the workflow also uses.
  const eligible = await eligibility(c.env, request);
  if (!eligible.ok) return fail(c, eligible.failure);

  // 10-11. Durable claim before instance creation; the partial unique index admits one winner.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const active = await activeClaim(c.env, orgId, taskId);
    if (active) {
      if (await releaseIfTerminal(c.env, orgId, active)) continue;
      await ensureInstance(c.env, active.id, await paramsFor(c.env, orgId, active));
      return fail(c, { status: 409, code: "WORKFLOW_ACTIVE", runId: active.id });
    }
    const legacy = await legacyActiveRun(c.env, orgId, taskId);
    if (legacy) return fail(c, { status: 409, code: "WORKFLOW_ACTIVE", runId: legacy });

    const runId = createId("wfr");
    const now = new Date().toISOString();
    try {
      await c.env.DB.prepare(
        `INSERT INTO workflow_start_claims (
           id, org_id, task_id, artifact_id, artifact_version, actor_type, actor_id,
           idempotency_key, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
      )
        .bind(
          runId,
          orgId,
          taskId,
          request.artifactId,
          request.version,
          request.actorType,
          request.actorId,
          idempotencyKey,
          now,
          now,
        )
        .run();
    } catch (error) {
      const text = String(error);
      if (text.includes("TENANT_MISMATCH")) {
        return fail(c, { status: 409, code: "ARTIFACT_TASK_MISMATCH" });
      }
      if (!text.includes("UNIQUE constraint failed")) throw error;
      const raced = await claimByKey(c.env, orgId, idempotencyKey);
      if (raced) return respondReplay(c, request, raced);
      continue;
    }
    // 11. Instance id equals the claim id, so a lost response or crash is reconcilable.
    await ensureInstance(c.env, runId, eligible.params(runId));
    await c.env.DB.prepare(
      `UPDATE workflow_start_claims SET state = 'created', updated_at = ?
       WHERE org_id = ? AND id = ? AND state = 'claimed'`,
    )
      .bind(new Date().toISOString(), orgId, runId)
      .run();
    log(requestId, runId, "created");
    // 12. Stable id and status.
    return c.json(
      await runBody(
        c.env,
        orgId,
        runId,
        request.taskId,
        request.artifactId,
        request.version,
        false,
      ),
      201,
    );
  }
  return fail(c, { status: 409, code: "WORKFLOW_ACTIVE" });
}

async function respondReplay(
  c: StartContext,
  request: StartRequest,
  claim: ClaimRow,
): Promise<Response> {
  if (
    claim.task_id !== request.taskId ||
    claim.artifact_id !== request.artifactId ||
    claim.artifact_version !== request.version ||
    claim.actor_type !== request.actorType ||
    claim.actor_id !== request.actorId
  ) {
    return fail(c, { status: 409, code: "IDEMPOTENCY_MISMATCH" });
  }
  if (claim.state === "claimed") {
    await ensureInstance(c.env, claim.id, await paramsFor(c.env, request.orgId, claim));
    await c.env.DB.prepare(
      `UPDATE workflow_start_claims SET state = 'created', updated_at = ?
       WHERE org_id = ? AND id = ? AND state = 'claimed'`,
    )
      .bind(new Date().toISOString(), request.orgId, claim.id)
      .run();
    log(c.get("requestId"), claim.id, "reconciled");
  }
  return c.json(
    await runBody(
      c.env,
      request.orgId,
      claim.id,
      claim.task_id,
      claim.artifact_id,
      claim.artifact_version,
      true,
      claim.state === "released",
    ),
    200,
  );
}

async function eligibility(
  env: Env,
  request: StartRequest,
): Promise<
  { ok: true; params: (runId: string) => ProductionTaskParams } | { ok: false; failure: Failure }
> {
  const row = await env.DB.prepare(
    `SELECT tasks.state AS state, tasks.room_id AS task_room, tasks.assignee_id AS assignee_id,
            tasks.completion_policy AS completion_policy, tasks.correlation_id AS correlation_id,
            artifacts.id AS artifact_id, artifacts.task_id AS artifact_task,
            artifacts.room_id AS artifact_room, artifacts.creator_type AS creator_type,
            artifacts.creator_id AS creator_id, artifacts.canonical_version AS canonical_version
     FROM tasks
     LEFT JOIN artifacts ON artifacts.org_id = tasks.org_id AND artifacts.id = ?
     WHERE tasks.org_id = ? AND tasks.id = ?`,
  )
    .bind(request.artifactId, request.orgId, request.taskId)
    .first<{
      state: string;
      task_room: string | null;
      assignee_id: string | null;
      completion_policy: string;
      correlation_id: string;
      artifact_id: string | null;
      artifact_task: string | null;
      artifact_room: string | null;
      creator_type: string | null;
      creator_id: string | null;
      canonical_version: number | null;
    }>();
  if (!row) return { ok: false, failure: { status: 404, code: "NOT_FOUND" } };
  if (!row.artifact_id) return { ok: false, failure: { status: 404, code: "ARTIFACT_NOT_FOUND" } };
  if (row.artifact_task !== request.taskId) {
    return { ok: false, failure: { status: 409, code: "ARTIFACT_TASK_MISMATCH" } };
  }
  if (!row.task_room || row.artifact_room !== row.task_room) {
    return { ok: false, failure: { status: 409, code: "ROOM_MISMATCH" } };
  }
  if (!GOVERNED_POLICIES.has(row.completion_policy)) {
    return { ok: false, failure: { status: 409, code: "COMPLETION_POLICY_NOT_GOVERNED" } };
  }
  if (row.state !== "REVIEW") {
    return { ok: false, failure: { status: 409, code: "TASK_STATE_INVALID" } };
  }
  if (row.creator_type !== "employee" || row.creator_id !== row.assignee_id) {
    return { ok: false, failure: { status: 409, code: "ARTIFACT_CREATOR_NOT_ASSIGNEE" } };
  }
  if (row.canonical_version !== request.version) {
    return { ok: false, failure: { status: 409, code: "ARTIFACT_VERSION_STALE" } };
  }
  const roomId = row.task_room;
  return {
    ok: true,
    params: () => ({
      orgId: request.orgId,
      taskId: request.taskId,
      artifactId: request.artifactId,
      version: request.version,
      roomId,
      correlationId: row.correlation_id,
    }),
  };
}

async function claimByKey(env: Env, orgId: string, key: string): Promise<ClaimRow | null> {
  return env.DB.prepare(
    `SELECT id, task_id, artifact_id, artifact_version, actor_type, actor_id, state
     FROM workflow_start_claims WHERE org_id = ? AND idempotency_key = ?`,
  )
    .bind(orgId, key)
    .first<ClaimRow>();
}

async function activeClaim(env: Env, orgId: string, taskId: string): Promise<ClaimRow | null> {
  return env.DB.prepare(
    `SELECT id, task_id, artifact_id, artifact_version, actor_type, actor_id, state
     FROM workflow_start_claims WHERE org_id = ? AND task_id = ? AND state <> 'released'`,
  )
    .bind(orgId, taskId)
    .first<ClaimRow>();
}

// Runs registered before claims existed still block a second active workflow.
async function legacyActiveRun(env: Env, orgId: string, taskId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM workflow_runs
     WHERE org_id = ? AND task_id = ? AND status IN ('running', 'revision', 'waiting_for_approval')
     LIMIT 1`,
  )
    .bind(orgId, taskId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function releaseIfTerminal(env: Env, orgId: string, claim: ClaimRow): Promise<boolean> {
  const run = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, claim.id)
    .first<{ status: string }>();
  let terminal = run ? TERMINAL_RUN.has(run.status) : false;
  if (run && !terminal) {
    // A registered run whose instance died (for example after exhausting step retries)
    // would otherwise block the task forever; only an explicit terminal status counts.
    const status = await instanceStatus(env, claim.id);
    if (status === "errored" || status === "terminated") {
      await env.DB.prepare(
        `UPDATE workflow_runs SET status = 'paused', updated_at = ?
         WHERE org_id = ? AND id = ? AND status IN ('running', 'revision', 'waiting_for_approval')`,
      )
        .bind(new Date().toISOString(), orgId, claim.id)
        .run();
      terminal = true;
    }
  } else if (!run) {
    // Never registered: the instance rejected its input, or a created instance is gone.
    // A missing instance for a 'claimed' row is a crash before create and is reconciled instead.
    const status = await instanceStatus(env, claim.id);
    terminal =
      (status !== null && TERMINAL_INSTANCE.has(status)) ||
      (status === null && claim.state === "created");
  }
  if (!terminal) return false;
  await env.DB.prepare(
    `UPDATE workflow_start_claims SET state = 'released', updated_at = ?
     WHERE org_id = ? AND id = ? AND state <> 'released'`,
  )
    .bind(new Date().toISOString(), orgId, claim.id)
    .run();
  return true;
}

async function paramsFor(env: Env, orgId: string, claim: ClaimRow): Promise<ProductionTaskParams> {
  const task = await env.DB.prepare(
    `SELECT room_id, correlation_id FROM tasks WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, claim.task_id)
    .first<{ room_id: string; correlation_id: string }>();
  return {
    orgId,
    taskId: claim.task_id,
    artifactId: claim.artifact_id,
    version: claim.artifact_version,
    roomId: task?.room_id ?? "",
    correlationId: task?.correlation_id ?? "",
  };
}

async function ensureInstance(env: Env, id: string, params: ProductionTaskParams): Promise<void> {
  try {
    await env.PRODUCTION_TASK.create({ id, params });
  } catch (error) {
    // Same durable id means the same logical run; only a missing instance is a failure.
    if ((await instanceStatus(env, id)) === null) throw error;
  }
}

async function instanceStatus(env: Env, id: string): Promise<string | null> {
  try {
    return (await (await env.PRODUCTION_TASK.get(id)).status()).status;
  } catch {
    return null;
  }
}

async function runBody(
  env: Env,
  orgId: string,
  runId: string,
  taskId: string,
  artifactId: string,
  version: number,
  duplicate: boolean,
  released = false,
) {
  const run = await env.DB.prepare(
    `SELECT status, stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, runId)
    .first<{ status: string; stage: string }>();
  return {
    workflow_run_id: runId,
    task_id: taskId,
    artifact_id: artifactId,
    version,
    // A released claim without a run row never started; a retry with a new key may start one.
    status: run?.status ?? (released ? "not_started" : "starting"),
    stage: run?.stage ?? null,
    duplicate,
  };
}

async function readBody(c: StartContext): Promise<{ artifactId: string; version: number } | null> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) {
    return null;
  }
  let body: unknown;
  try {
    // The bound also applies to bodies sent without a content-length header.
    const text = await c.req.text();
    if (text.length > MAX_BODY) return null;
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  // Actor, authority, and evidence are server-resolved; any extra field is rejected.
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "artifact_id" || keys[1] !== "version") return null;
  const artifactId = record.artifact_id;
  const version = record.version;
  if (typeof artifactId !== "string" || !isId(artifactId, "art")) return null;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1_000_000
  ) {
    return null;
  }
  return { artifactId, version };
}

function sessionStatus(reason: string): 401 | 403 | 404 {
  if (reason === "TENANT_BOUNDARY") return 404;
  if (reason === "NO_SCOPE" || reason === "SUSPENDED_AGENT_DENY") return 403;
  return 401;
}

function fail(c: StartContext, failure: Failure): Response {
  return c.json(
    {
      error: {
        code: failure.code,
        message: "Workflow start was rejected.",
        request_id: c.get("requestId"),
        ...(failure.runId ? { workflow_run_id: failure.runId } : {}),
      },
    },
    failure.status,
  );
}

function log(requestId: string, runId: string, outcome: string): void {
  console.log(
    JSON.stringify({ level: "info", event: "workflow.start", requestId, runId, outcome }),
  );
}
