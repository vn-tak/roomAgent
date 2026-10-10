import { createId, isId } from "@ai-company/domain";
import type { Context, Hono } from "hono";
import { resolveHttpPrincipal } from "./http-principal";
import { FAULT_WORKFLOW_STATUS } from "./events/names";
import { takeEventFault } from "./events/test-seam";
import type { ProductionTaskParams } from "./production-task-workflow";

type EnvVars = { Bindings: Env; Variables: { requestId: string } };
type App = Hono<EnvVars>;
type StartContext = Context<EnvVars>;

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_BODY = 1024;
const START_SCOPE = "task.assign";
const GOVERNED_POLICIES = new Set(["ARTIFACT_APPROVED", "QA_SECURITY", "HUMAN_FINAL"]);
const HELD_RUN = new Set(["denied", "paused"]);
const ACTIVE_RUN = new Set(["running", "revision", "waiting_for_approval"]);
const TERMINAL_INSTANCE = new Set(["errored", "terminated", "complete"]);
const MAX_AUTOMATIC_RECOVERIES = 2;
const MAX_RESOLUTIONS = 3;
// Holds that reset a governance limit or override a recorded decision need the owner.
const OWNER_HOLDS = new Set(["LOOP_GUARD", "SECURITY_DENIED", "APPROVAL_DENIED"]);
const HOLD_REASONS = new Set([
  "LOOP_GUARD",
  "TIMEOUT",
  "EVIDENCE_TIMEOUT",
  "QA_FAILED",
  "SECURITY_DENIED",
  "APPROVAL_DENIED",
  "INSTANCE_FAILED",
]);

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

type Failure = {
  status: 400 | 401 | 403 | 404 | 409 | 503;
  code: string;
  runId?: string;
  holdReason?: string;
};

type Settlement =
  | { kind: "released" }
  | { kind: "active" }
  | { kind: "held"; reason: string }
  | { kind: "unavailable" };

// `missing` only on an explicit not-found answer; every other lookup failure is `unknown`.
type InstanceState = { kind: "found"; status: string } | { kind: "missing" } | { kind: "unknown" };

const UNAVAILABLE = "WORKFLOW_STATUS_UNAVAILABLE";

export function registerWorkflowStartRoutes(app: App): void {
  app.post("/orgs/:orgId/tasks/:taskId/workflow-runs", (c) => start(c));
  app.post("/orgs/:orgId/workflow-runs/:runId/resolution", (c) => resolve(c));
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
      const settled = await settle(c.env, orgId, active);
      if (settled.kind === "released") continue;
      if (settled.kind === "unavailable") {
        // Unknown instance state: keep the claim and create nothing; the caller retries.
        return fail(c, { status: 503, code: UNAVAILABLE, runId: active.id });
      }
      if (settled.kind === "held") {
        // A new idempotency key never clears a hold; only an explicit resolution does.
        return fail(c, {
          status: 409,
          code: "WORKFLOW_HELD",
          runId: active.id,
          holdReason: settled.reason,
        });
      }
      if (!(await ensureInstance(c.env, active.id, await paramsFor(c.env, orgId, active)))) {
        return fail(c, { status: 503, code: UNAVAILABLE, runId: active.id });
      }
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
    if (!(await ensureInstance(c.env, runId, eligible.params(runId)))) {
      // The claim stays 'claimed'; a retry with this key or any later start reconciles it.
      return fail(c, { status: 503, code: UNAVAILABLE, runId });
    }
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
    if (!(await ensureInstance(c.env, claim.id, await paramsFor(c.env, request.orgId, claim)))) {
      return fail(c, { status: 503, code: UNAVAILABLE, runId: claim.id });
    }
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

// Decides what an unreleased claim means now. Only outcomes the database can corroborate
// are released automatically; governance holds stay until an explicit resolution.
async function settle(env: Env, orgId: string, claim: ClaimRow): Promise<Settlement> {
  let run = await runRow(env, orgId, claim.id);
  if (!run) {
    // Never registered: release only on positive evidence that the instance is dead, or was
    // created and is now confirmed absent (rejected, deleted, or past retention). A missing
    // instance for a 'claimed' row is a crash before create and is reconciled instead.
    const instance = await instanceStatus(env, claim.id);
    if (instance.kind === "unknown") return { kind: "unavailable" };
    const dead =
      (instance.kind === "found" && TERMINAL_INSTANCE.has(instance.status)) ||
      (instance.kind === "missing" && claim.state === "created");
    if (!dead) return { kind: "active" };
    return (await release(env, orgId, claim.id, "never_registered"))
      ? { kind: "released" }
      : { kind: "active" };
  }
  if (run.status === "complete") {
    return (await release(env, orgId, claim.id, "completed"))
      ? { kind: "released" }
      : { kind: "active" };
  }
  if (ACTIVE_RUN.has(run.status)) {
    const instance = await instanceStatus(env, claim.id);
    if (instance.kind === "unknown") return { kind: "unavailable" };
    // A registered run whose instance is missing stays active: absence alone is not a
    // governance outcome, and the run row keeps the task blocked until it is explained.
    if (
      instance.kind !== "found" ||
      (instance.status !== "errored" && instance.status !== "terminated")
    ) {
      return { kind: "active" };
    }
    // The instance died without recording a governance outcome.
    await env.DB.prepare(
      `UPDATE workflow_runs SET status = 'paused', hold_reason = 'INSTANCE_FAILED', updated_at = ?
       WHERE org_id = ? AND id = ? AND status IN ('running', 'revision', 'waiting_for_approval')`,
    )
      .bind(new Date().toISOString(), orgId, claim.id)
      .run();
    run = await runRow(env, orgId, claim.id);
    if (!run) return { kind: "active" };
  }
  const reason = run.hold_reason ?? "UNSPECIFIED";
  if (!HELD_RUN.has(run.status)) return { kind: "active" };
  // Automatic crash recovery only when no revision budget was consumed, at most twice per task.
  if (
    reason === "INSTANCE_FAILED" &&
    run.iteration === 0 &&
    (await automaticRecoveries(env, orgId, claim.task_id)) < MAX_AUTOMATIC_RECOVERIES &&
    (await release(env, orgId, claim.id, "instance_failed"))
  ) {
    return { kind: "released" };
  }
  return { kind: "held", reason };
}

async function runRow(
  env: Env,
  orgId: string,
  runId: string,
): Promise<{ status: string; hold_reason: string | null; iteration: number } | null> {
  return env.DB.prepare(
    `SELECT status, hold_reason, iteration FROM workflow_runs WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, runId)
    .first();
}

async function automaticRecoveries(env: Env, orgId: string, taskId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM workflow_start_claims
     WHERE org_id = ? AND task_id = ? AND release_reason = 'instance_failed'`,
  )
    .bind(orgId, taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The database trigger re-checks every release reason; a refused release stays unreleased.
async function release(
  env: Env,
  orgId: string,
  claimId: string,
  reason: "completed" | "never_registered" | "instance_failed",
): Promise<boolean> {
  try {
    const updated = await env.DB.prepare(
      `UPDATE workflow_start_claims SET state = 'released', release_reason = ?, updated_at = ?
       WHERE org_id = ? AND id = ? AND state <> 'released'`,
    )
      .bind(reason, new Date().toISOString(), orgId, claimId)
      .run();
    return updated.meta.changes === 1;
  } catch (error) {
    if (String(error).includes("WORKFLOW_RELEASE_DENIED")) return false;
    throw error;
  }
}

async function resolve(c: StartContext): Promise<Response> {
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const runId = c.req.param("runId");
  if (!isId(orgId, "org") || !isId(runId, "wfr")) {
    return fail(c, { status: 404, code: "NOT_FOUND" });
  }
  const principal = await resolveHttpPrincipal(
    c.env,
    orgId,
    c.req.header("authorization"),
    c.req.header("x-employee-id"),
    "workflow.approve",
  );
  if (principal.decision === "DENY" || !principal.actorType || !principal.actorId) {
    return fail(c, { status: sessionStatus(principal.reason), code: principal.reason });
  }
  const idempotencyKey = c.req.header("x-idempotency-key") ?? "";
  if (!KEY.test(idempotencyKey)) return fail(c, { status: 400, code: "INVALID_INPUT" });
  const holdReason = await readResolutionBody(c);
  if (!holdReason) return fail(c, { status: 400, code: "INVALID_INPUT" });

  const prior = await c.env.DB.prepare(
    `SELECT id, run_id, actor_type, actor_id FROM workflow_run_resolutions
     WHERE org_id = ? AND idempotency_key = ?`,
  )
    .bind(orgId, idempotencyKey)
    .first<{ id: string; run_id: string; actor_type: string; actor_id: string }>();
  if (prior) {
    if (
      prior.run_id !== runId ||
      prior.actor_type !== principal.actorType ||
      prior.actor_id !== principal.actorId
    ) {
      return fail(c, { status: 409, code: "IDEMPOTENCY_MISMATCH" });
    }
    return c.json({ workflow_run_id: runId, resolution_id: prior.id, duplicate: true });
  }

  const claim = await c.env.DB.prepare(
    `SELECT id, task_id, artifact_id, artifact_version, actor_type, actor_id, state
     FROM workflow_start_claims WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, runId)
    .first<ClaimRow>();
  if (!claim) return fail(c, { status: 404, code: "NOT_FOUND" });
  const settled = claim.state === "released" ? null : await settle(c.env, orgId, claim);
  if (settled?.kind === "unavailable") {
    return fail(c, { status: 503, code: UNAVAILABLE, runId });
  }
  if (!settled || settled.kind !== "held") {
    return fail(c, { status: 409, code: "WORKFLOW_NOT_HELD", runId });
  }
  if (settled.reason !== holdReason) {
    return fail(c, { status: 409, code: "HOLD_REASON_MISMATCH", runId });
  }

  // Policy by hold reason: limit resets and overridden decisions need the human owner;
  // timeouts, QA failures, and failed instances need workflow approval authority.
  const policy = OWNER_HOLDS.has(holdReason) ? "owner_human" : "workflow_approver";
  if (policy === "owner_human" && principal.actorType !== "human") {
    return fail(c, { status: 403, code: "NO_PERMISSION" });
  }
  if (principal.actorType === "employee" && claim.actor_id === principal.actorId) {
    return fail(c, { status: 403, code: "NO_SELF_RESOLUTION" });
  }
  const decision = await c.env.ORGANIZATION.getByName(`org:${orgId}`).authorize({
    orgId,
    actorType: principal.actorType,
    actorId: principal.actorId,
    action: policy === "owner_human" ? "workflow.resolve.limit" : "workflow.resolve",
    resourceType: "task",
    resourceId: claim.task_id,
  });
  if (decision.decision === "DENY") {
    return fail(c, {
      status: decision.reason === "TENANT_BOUNDARY" ? 404 : 403,
      code: decision.reason,
    });
  }
  const used = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM workflow_run_resolutions WHERE org_id = ? AND task_id = ?`,
  )
    .bind(orgId, claim.task_id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) >= MAX_RESOLUTIONS) {
    return fail(c, { status: 409, code: "RESOLUTION_BUDGET_EXHAUSTED", runId });
  }

  const resolutionId = createId("evt");
  const now = new Date().toISOString();
  try {
    // Audit row and release commit together; the claim trigger requires the audit row.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO workflow_run_resolutions (
           id, org_id, run_id, task_id, hold_reason, policy, actor_type, actor_id,
           idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        resolutionId,
        orgId,
        runId,
        claim.task_id,
        holdReason,
        policy,
        principal.actorType,
        principal.actorId,
        idempotencyKey,
        now,
      ),
      c.env.DB.prepare(
        `UPDATE workflow_start_claims SET state = 'released', release_reason = 'resolved',
           updated_at = ?
         WHERE org_id = ? AND id = ? AND state <> 'released'`,
      ).bind(now, orgId, runId),
    ]);
  } catch (error) {
    const text = String(error);
    if (text.includes("RESOLUTION_BUDGET_EXHAUSTED")) {
      return fail(c, { status: 409, code: "RESOLUTION_BUDGET_EXHAUSTED", runId });
    }
    if (text.includes("UNIQUE constraint failed") || text.includes("WORKFLOW_NOT_HELD")) {
      return fail(c, { status: 409, code: "WORKFLOW_NOT_HELD", runId });
    }
    if (text.includes("RESOLUTION_POLICY")) return fail(c, { status: 403, code: "NO_PERMISSION" });
    throw error;
  }
  log(requestId, runId, `resolved:${holdReason}`);
  return c.json({
    workflow_run_id: runId,
    resolution_id: resolutionId,
    hold_reason: holdReason,
    policy,
    released: true,
    resolutions_remaining: MAX_RESOLUTIONS - (used?.n ?? 0) - 1,
    duplicate: false,
  });
}

async function readResolutionBody(c: StartContext): Promise<string | null> {
  let body: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return null;
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "hold_reason") return null;
  const reason = record.hold_reason;
  return typeof reason === "string" && HOLD_REASONS.has(reason) ? reason : null;
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

// True when an instance with this id is known to exist. False means its existence could not
// be confirmed; callers keep the claim unchanged and report the start as unavailable.
async function ensureInstance(
  env: Env,
  id: string,
  params: ProductionTaskParams,
): Promise<boolean> {
  try {
    await env.PRODUCTION_TASK.create({ id, params });
    return true;
  } catch {
    // Same durable id means the same logical run, e.g. `instance.already_exists`.
    return (await instanceStatus(env, id)).kind === "found";
  }
}

async function instanceStatus(env: Env, id: string): Promise<InstanceState> {
  try {
    if (await takeEventFault(env, FAULT_WORKFLOW_STATUS)) {
      throw new Error("workflow status lookup unavailable");
    }
    return { kind: "found", status: (await (await env.PRODUCTION_TASK.get(id)).status()).status };
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unknown" };
  }
}

function isNotFound(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return text.includes("instance.not_found");
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
        ...(failure.holdReason ? { hold_reason: failure.holdReason } : {}),
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
