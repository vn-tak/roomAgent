import type { ArtifactFinalize, ArtifactPut, GovernanceResult } from "@ai-company/artifact";
import type { FoundationStore } from "@ai-company/db";
import { createId, type Organization, type Role } from "@ai-company/domain";
import type { RoomEnvelope } from "@ai-company/room";
import type { TaskCommand, TaskResult } from "@ai-company/task";
import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  introspectWorkflowInstance,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_VERSION_EVENT,
  HUMAN_APPROVAL_EVENT,
  QA_EVIDENCE_EVENT,
  SECURITY_EVIDENCE_EVENT,
  notifyProductionTaskEvidence,
  type ProductionTaskParams,
} from "../src/production-task-workflow";
import {
  agentStub,
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  roomStub,
  taskStub,
} from "./helpers";

const GOAL = "Create and review one small creative artifact.";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

function employeeActor(orgId: string, employeeId: string) {
  return { orgId, actorType: "employee" as const, actorId: employeeId };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

async function run(
  actor: { orgId: string; actorType: "human" | "employee"; actorId: string },
  command: TaskCommand["command"],
  fields: {
    key: string;
    taskId?: string;
    assigneeId?: string;
    title?: string;
    objective?: string;
    roomId?: string | null;
    dependsOn?: string[];
    completionPolicy?: TaskCommand["completionPolicy"];
  },
): Promise<TaskResult> {
  return taskStub(actor.orgId).execute({
    orgId: actor.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    idempotencyKey: fields.key,
    command,
    taskId: fields.taskId ?? null,
    assigneeId: fields.assigneeId ?? null,
    title: fields.title ?? null,
    objective: fields.objective ?? null,
    roomId: fields.roomId ?? null,
    dependsOn: fields.dependsOn ?? [],
    ...(fields.completionPolicy ? { completionPolicy: fields.completionPolicy } : {}),
  });
}

async function storedTask(orgId: string, taskId: string) {
  return env.DB.prepare(
    `SELECT state, assignee_id, handoff_count, human_review_required, pause_reason, objective
     FROM tasks WHERE org_id = ? AND id = ?`,
  )
    .bind(orgId, taskId)
    .first<{
      state: string;
      assignee_id: string | null;
      handoff_count: number;
      human_review_required: number;
      pause_reason: string | null;
      objective: string;
    }>();
}

async function count(orgId: string, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function governanceHttp(
  orgId: string,
  artifactId: string,
  employeeId: string | undefined,
  token: string,
  kind: "reviews" | "approvals" | "security-approvals",
  key: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return exports.default.fetch(
    `https://company.local/orgs/${orgId}/artifacts/${artifactId}/${kind}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(employeeId ? { "x-employee-id": employeeId } : {}),
        "x-idempotency-key": key,
      },
      body: JSON.stringify(body),
    },
  );
}

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
}

async function connectRoom(orgId: string, roomId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/rooms/${roomId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Missing room WebSocket");
  }
  socket.accept();
  return socket;
}

async function connectAgent(orgId: string, employeeId: string): Promise<WebSocket> {
  const response = await exports.default.fetch(
    `https://company.local/orgs/${orgId}/agents/${employeeId}/socket`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Missing agent WebSocket");
  }
  socket.accept();
  return socket;
}

function collectRoom(socket: WebSocket): RoomEnvelope[] {
  const items: RoomEnvelope[] = [];
  socket.addEventListener("message", (event) => {
    items.push(JSON.parse(String(event.data)) as RoomEnvelope);
  });
  return items;
}

function collectAgent(socket: WebSocket): Array<{ type: string }> {
  const items: Array<{ type: string }> = [];
  socket.addEventListener("message", (event) => {
    items.push(JSON.parse(String(event.data)) as { type: string });
  });
  return items;
}

async function until<T>(items: T[], ready: (items: T[]) => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      expect(ready(items)).toBe(true);
    },
    { timeout: 8_000, interval: 20 },
  );
}

function roomHello(employeeId: string, token: string) {
  return {
    v: 1,
    type: "session.hello",
    last_seen_seq: 0,
    data: { employee_id: employeeId, token },
  };
}

function putBytes(
  actorId: string,
  orgId: string,
  key: string,
  roomId: string,
  taskId: string,
  artifactId: string | null,
  text: string,
): ArtifactPut {
  return {
    orgId,
    actorType: "employee",
    actorId,
    idempotencyKey: key,
    roomId,
    artifactId,
    taskId,
    mediaType: "text/plain",
    filename: null,
    checksum: null,
    bodyBase64: btoa(text),
  };
}

async function runStatus(orgId: string, runId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status FROM workflow_runs WHERE org_id = ? AND id = ?`)
    .bind(orgId, runId)
    .first<{ status: string }>();
  return row?.status ?? null;
}

async function untilWorkflowStage(orgId: string, runId: string, stage: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        `SELECT stage FROM workflow_runs WHERE org_id = ? AND id = ?`,
      )
        .bind(orgId, runId)
        .first<{ stage: string }>();
      expect(row?.stage).toBe(stage);
    },
    { timeout: 8_000, interval: 20 },
  );
}

describe("AI STUDIO LAB company POC", () => {
  it("completes one creative artifact and rejects the authority attacks", async () => {
    const studio = await createStudio("AI STUDIO LAB");
    const ceo = await hire(studio.store, studio.org.id, "EMP01 CEO / Coordinator");
    const manager = await hire(studio.store, studio.org.id, "EMP02 Manager");
    const workerA = await hire(studio.store, studio.org.id, "EMP03 Worker A");
    const workerB = await hire(studio.store, studio.org.id, "EMP04 Worker B");
    const qa = await hire(studio.store, studio.org.id, "EMP05 QA");
    const security = await hire(studio.store, studio.org.id, "EMP06 Security");
    const executive = await roleByCode(studio.store, studio.org.id, "executive");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    expect(
      (await org.assignRole({ ...owner, employeeId: ceo.id, roleId: executive.id })).decision,
    ).toBe("ALLOW");
    expect(
      (await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id })).decision,
    ).toBe("ALLOW");
    expect(
      (await org.assignRole({ ...owner, employeeId: workerA.id, roleId: employeeRole.id }))
        .decision,
    ).toBe("ALLOW");
    expect(
      (await org.assignRole({ ...owner, employeeId: workerB.id, roleId: employeeRole.id }))
        .decision,
    ).toBe("ALLOW");
    expect(
      (await org.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole.id })).decision,
    ).toBe("ALLOW");
    expect(
      (await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id }))
        .decision,
    ).toBe("ALLOW");

    const people = [ceo, manager, workerA, workerB, qa, security];
    const tokens = new Map<string, string>();
    for (const person of people) {
      const scopes = ["room.read", "room.message.send"];
      if (person.id === qa.id) scopes.push("artifact.review");
      if (person.id === security.id) scopes.push("security.approve");
      const opened = await openBrowserSession(studio.org, person.id, scopes);
      tokens.set(person.id, opened.token);
    }
    const humanSession = await organizationStub(studio.org.id).issueHumanSession({
      ...owner,
      ttlSeconds: 600,
    });
    expect(humanSession.decision).toBe("ALLOW");
    const humanToken = humanSession.token ?? "";

    const orgName = await env.DB.prepare(`SELECT name FROM organizations WHERE id = ?`)
      .bind(studio.org.id)
      .first<{ name: string }>();
    expect(orgName?.name).toBe("AI STUDIO LAB");
    expect(await count(studio.org.id, `SELECT COUNT(*) AS n FROM employees WHERE org_id = ?`)).toBe(
      6,
    );
    const bindings = await env.DB.prepare(
      `SELECT employees.display_name AS display_name,
              runtime_bindings.runtime_type AS runtime_type,
              runtime_bindings.adapter_type AS adapter_type,
              runtime_bindings.external_ref AS external_ref
       FROM runtime_bindings
       INNER JOIN employees
         ON employees.org_id = runtime_bindings.org_id
        AND employees.id = runtime_bindings.employee_id
       WHERE runtime_bindings.org_id = ? AND runtime_bindings.status = 'active'
       ORDER BY employees.display_name`,
    )
      .bind(studio.org.id)
      .all<{
        display_name: string;
        runtime_type: string;
        adapter_type: string;
        external_ref: string | null;
      }>();
    expect(bindings.results).toEqual([
      {
        display_name: "EMP01 CEO / Coordinator",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
      {
        display_name: "EMP02 Manager",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
      {
        display_name: "EMP03 Worker A",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
      {
        display_name: "EMP04 Worker B",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
      {
        display_name: "EMP05 QA",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
      {
        display_name: "EMP06 Security",
        runtime_type: "BROWSER",
        adapter_type: "browser",
        external_ref: null,
      },
    ]);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM runtime_bindings
         WHERE org_id = ? AND adapter_type IN ('muse', 'cue')`,
      ),
    ).toBe(0);
    const sessionRows = await env.DB.prepare(
      `SELECT token_hash, revoked_at FROM runtime_sessions WHERE org_id = ?`,
    )
      .bind(studio.org.id)
      .all<{ token_hash: string; revoked_at: string | null }>();
    expect(sessionRows.results).toHaveLength(6);
    expect(
      sessionRows.results.every(
        (row) => /^[0-9a-f]{64}$/.test(row.token_hash) && row.revoked_at === null,
      ),
    ).toBe(true);
    const sessionColumns = await env.DB.prepare(`PRAGMA table_info(runtime_sessions)`).all<{
      name: string;
    }>();
    const sessionColumnNames = sessionColumns.results.map((column) => column.name);
    expect(sessionColumnNames).toContain("token_hash");
    expect(sessionColumnNames).not.toContain("token");
    expect(sessionColumnNames).not.toContain("password");
    expect(sessionColumnNames).not.toContain("cookie");
    expect(sessionColumnNames).not.toContain("secret");

    const room = await studio.store.createRoom(studio.org.id, {
      name: "PROJECT POC-001",
      departmentId: null,
    });
    const roomName = await env.DB.prepare(`SELECT name FROM rooms WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, room.id)
      .first<{ name: string }>();
    expect(roomName?.name).toBe("PROJECT POC-001");
    const live = roomStub(studio.org.id, room.id);
    for (const member of [ceo, workerA, qa]) {
      expect((await live.join({ ...owner, roomId: room.id, employeeId: member.id })).decision).toBe(
        "ALLOW",
      );
    }

    const ceoSocket = await connectRoom(studio.org.id, room.id);
    const workerSocket = await connectRoom(studio.org.id, room.id);
    const ceoMessages = collectRoom(ceoSocket);
    const workerMessages = collectRoom(workerSocket);
    ceoSocket.send(JSON.stringify(roomHello(ceo.id, tokens.get(ceo.id) ?? "")));
    workerSocket.send(JSON.stringify(roomHello(workerA.id, tokens.get(workerA.id) ?? "")));
    await until(ceoMessages, (items) => items.some((item) => item.type === "session.ready"));
    await until(workerMessages, (items) => items.some((item) => item.type === "session.ready"));
    ceoSocket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "poc before", idempotency_key: "poc_room_before" },
      }),
    );
    await until(workerMessages, (items) => items.some((item) => item.data.body === "poc before"));
    const before = workerMessages.find((item) => item.data.body === "poc before");
    await evictDurableObject(live, { webSockets: "hibernate" });
    ceoSocket.send(
      JSON.stringify({
        v: 1,
        type: "message.send",
        data: { body: "poc after", idempotency_key: "poc_room_after1" },
      }),
    );
    await until(workerMessages, (items) => items.some((item) => item.data.body === "poc after"));
    const after = workerMessages.find((item) => item.data.body === "poc after");
    expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    expect(after?.data.actor_id).toBe(ceo.id);
    await runInDurableObject(live, (_instance, state) => {
      const presence = state.storage.sql
        .exec<{ employee_id: string; state: string }>(`SELECT employee_id, state FROM presence`)
        .toArray();
      expect(presence).toHaveLength(2);
      expect(presence).toEqual(
        expect.arrayContaining([
          { employee_id: ceo.id, state: "online" },
          { employee_id: workerA.id, state: "online" },
        ]),
      );
      const attached = state.getWebSockets().some((socket) => {
        const value: unknown = socket.deserializeAttachment();
        return (
          typeof value === "object" &&
          value !== null &&
          "sessionId" in value &&
          typeof value.sessionId === "string"
        );
      });
      expect(attached).toBe(true);
    });

    const ceoActor = employeeActor(studio.org.id, ceo.id);
    const managerActor = employeeActor(studio.org.id, manager.id);
    const workerActor = employeeActor(studio.org.id, workerA.id);
    const qaActor = employeeActor(studio.org.id, qa.id);
    const created = await run(ceoActor, "create", {
      key: "poc_task_create1",
      title: "PROJECT POC-001",
      objective: GOAL,
      roomId: room.id,
      completionPolicy: "QA_SECURITY",
    });
    expect(created).toMatchObject({ decision: "ALLOW", state: "CREATED" });
    const taskId = created.taskId ?? "";
    expect(await storedTask(studio.org.id, taskId)).toMatchObject({
      objective: GOAL,
      state: "CREATED",
    });

    const toManager = await run(ceoActor, "assign", {
      key: "poc_assign_mgr1",
      taskId,
      assigneeId: manager.id,
    });
    expect(toManager).toMatchObject({
      decision: "ALLOW",
      state: "QUEUED",
      handoffCount: 0,
    });
    const toWorker = await run(managerActor, "assign", {
      key: "poc_assign_wrkr",
      taskId,
      assigneeId: workerA.id,
    });
    expect(toWorker).toMatchObject({
      decision: "ALLOW",
      state: "QUEUED",
      handoffCount: 1,
    });
    const delivered = await run(managerActor, "deliver", {
      key: "poc_deliver_wrk",
      taskId,
    });
    expect(delivered).toMatchObject({ decision: "ALLOW", state: "DELIVERED" });
    const beforeSocket = await agentStub(studio.org.id, workerA.id).snapshot({
      orgId: studio.org.id,
      employeeId: workerA.id,
    });
    expect(beforeSocket.reachability).toBe("UNREACHABLE");
    expect(beforeSocket.currentTaskId).toBeNull();
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("DELIVERED");
    await runInDurableObject(agentStub(studio.org.id, workerA.id), (_instance, state) => {
      const rows = state.storage.sql.exec<{ state: string }>(`SELECT state FROM inbox`).toArray();
      expect(rows.map((row) => row.state)).toEqual(["QUEUED"]);
    });

    const agentSocket = await connectAgent(studio.org.id, workerA.id);
    const agentMessages = collectAgent(agentSocket);
    agentSocket.send(
      JSON.stringify({
        v: 1,
        type: "session.hello",
        data: { token: tokens.get(workerA.id) },
      }),
    );
    await until(agentMessages, (items) => items.some((item) => item.type === "inbox.delivered"));
    expect(agentMessages.some((item) => item.type === "inbox.acknowledged")).toBe(false);
    const connected = await agentStub(studio.org.id, workerA.id).snapshot({
      orgId: studio.org.id,
      employeeId: workerA.id,
    });
    expect(connected.reachability).toBe("BROWSER_CONNECTED");
    expect(connected.availability).toBe("IDLE");
    expect(connected.currentTaskId).toBeNull();
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("DELIVERED");
    await runInDurableObject(agentStub(studio.org.id, workerA.id), (_instance, state) => {
      const rows = state.storage.sql.exec<{ state: string }>(`SELECT state FROM inbox`).toArray();
      expect(rows.map((row) => row.state)).toEqual(["DELIVERED"]);
    });

    expect((await run(workerActor, "ack", { key: "poc_ack_worker1", taskId })).state).toBe(
      "ACKNOWLEDGED",
    );
    expect(
      (
        await agentStub(studio.org.id, workerA.id).snapshot({
          orgId: studio.org.id,
          employeeId: workerA.id,
        })
      ).currentTaskId,
    ).toBe(taskId);
    expect(
      (
        await agentStub(studio.org.id, workerA.id).snapshot({
          orgId: studio.org.id,
          employeeId: workerA.id,
        })
      ).availability,
    ).toBe("BUSY");
    await runInDurableObject(agentStub(studio.org.id, workerA.id), (_instance, state) => {
      const rows = state.storage.sql.exec<{ state: string }>(`SELECT state FROM inbox`).toArray();
      expect(rows.map((row) => row.state)).toEqual(["ACKNOWLEDGED"]);
    });
    expect((await run(workerActor, "start", { key: "poc_start_work1", taskId })).state).toBe(
      "WORKING",
    );

    const versionOne = await artifactStub(studio.org.id).put(
      putBytes(workerA.id, studio.org.id, "poc_art_v1_put1", room.id, taskId, null, "poc v1"),
    );
    expect(versionOne).toMatchObject({ decision: "ALLOW", version: 1 });
    const artifactId = versionOne.artifactId ?? "";
    expect((await run(workerActor, "submit", { key: "poc_submit_wrk1", taskId })).state).toBe(
      "REVIEW",
    );
    const other = await createStudio("ORG B");
    const runId = createId("wfr");
    const watched = await introspectWorkflowInstance(env.PRODUCTION_TASK, runId);
    try {
      const taskTrace = await env.DB.prepare(
        `SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ?`,
      )
        .bind(studio.org.id, taskId)
        .first<{ correlation_id: string }>();
      expect(taskTrace?.correlation_id).toMatch(/^corr_/);
      const params: ProductionTaskParams = {
        orgId: studio.org.id,
        taskId,
        artifactId,
        version: 1,
        roomId: room.id,
        correlationId: taskTrace?.correlation_id ?? "",
      };
      await env.PRODUCTION_TASK.create({ id: runId, params });
      await untilWorkflowStage(studio.org.id, runId, "qa_review");

      const rejected = await governanceHttp(
        studio.org.id,
        artifactId,
        qa.id,
        tokens.get(qa.id) ?? "",
        "reviews",
        "poc_qa_reject1",
        { result: "REVISION_REQUIRED", version: 1 },
      );
      expect(rejected.status).toBe(201);
      await notifyProductionTaskEvidence(env, studio.org.id, artifactId, QA_EVIDENCE_EVENT);
      await untilWorkflowStage(studio.org.id, runId, "revision");
      expect(
        (await run(qaActor, "request_revision", { key: "poc_task_revise1", taskId })).state,
      ).toBe("REVISION");
      expect((await run(workerActor, "start", { key: "poc_start_rev01", taskId })).state).toBe(
        "WORKING",
      );
      const versionTwo = await artifactStub(studio.org.id).put(
        putBytes(
          workerA.id,
          studio.org.id,
          "poc_art_v2_put1",
          room.id,
          taskId,
          artifactId,
          "poc v2",
        ),
      );
      expect(versionTwo).toMatchObject({ decision: "ALLOW", version: 2 });
      expect((await run(workerActor, "submit", { key: "poc_submit_rev1", taskId })).state).toBe(
        "REVIEW",
      );
      await notifyProductionTaskEvidence(env, studio.org.id, artifactId, ARTIFACT_VERSION_EVENT);
      await untilWorkflowStage(studio.org.id, runId, "qa_review");

      const workerFinal: GovernanceResult = await artifactStub(studio.org.id).finalize({
        orgId: studio.org.id,
        actorType: "employee",
        actorId: workerA.id,
        idempotencyKey: "poc_worker_fin1",
        artifactId,
        version: 2,
      } satisfies ArtifactFinalize);
      expect(workerFinal).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
      const managerOverride = await org.overrideSecurityBlock({
        ...managerActor,
        blockId: `blk_${"ab".repeat(16)}`,
        reason: "POC",
      });
      expect(managerOverride).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
      const securityEdit = await artifactStub(studio.org.id).put(
        putBytes(
          security.id,
          studio.org.id,
          "poc_sec_modify1",
          room.id,
          taskId,
          artifactId,
          "nope",
        ),
      );
      expect(securityEdit).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
      expect(
        await count(
          studio.org.id,
          `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND artifact_id = '${artifactId}'`,
        ),
      ).toBe(0);
      expect(
        await count(
          studio.org.id,
          `SELECT COUNT(*) AS n FROM artifact_versions WHERE org_id = ? AND artifact_id = '${artifactId}'`,
        ),
      ).toBe(2);

      const qaPass = await governanceHttp(
        studio.org.id,
        artifactId,
        qa.id,
        tokens.get(qa.id) ?? "",
        "reviews",
        "poc_qa_pass_v2",
        { result: "PASS", version: 2 },
      );
      expect(qaPass.status).toBe(201);
      await notifyProductionTaskEvidence(env, studio.org.id, artifactId, QA_EVIDENCE_EVENT);
      await untilWorkflowStage(studio.org.id, runId, "security");

      const securityApproval = await governanceHttp(
        studio.org.id,
        artifactId,
        security.id,
        tokens.get(security.id) ?? "",
        "security-approvals",
        "poc_security_approve",
        { version: 2 },
      );
      expect(securityApproval.status).toBe(201);
      await notifyProductionTaskEvidence(env, studio.org.id, artifactId, SECURITY_EVIDENCE_EVENT);
      await vi.waitFor(
        async () => expect(await runStatus(studio.org.id, runId)).toBe("waiting_for_approval"),
        { timeout: 8_000, interval: 20 },
      );
      const waiting = await (await env.PRODUCTION_TASK.get(runId)).status();
      expect(waiting.status === "running" || waiting.status === "waiting").toBe(true);
      expect(waiting.output).toBeNull();
      expect(await runStatus(other.org.id, runId)).toBeNull();
      const reviews = await env.DB.prepare(
        `SELECT artifact_version, result FROM reviews
         WHERE org_id = ? AND artifact_id = ? ORDER BY artifact_version`,
      )
        .bind(studio.org.id, artifactId)
        .all<{ artifact_version: number; result: string }>();
      expect(reviews.results).toEqual([
        { artifact_version: 1, result: "REVISION_REQUIRED" },
        { artifact_version: 2, result: "PASS" },
      ]);
      expect((await storedTask(studio.org.id, taskId))?.state).toBe("REVIEW");
      await (
        await env.PRODUCTION_TASK.get(runId)
      ).sendEvent({
        type: HUMAN_APPROVAL_EVENT,
        payload: { actorType: "human", actorId: studio.org.createdByUserId, decision: "ALLOW" },
      });
      await pump();
      expect(await runStatus(studio.org.id, runId)).toBe("waiting_for_approval");

      const final = await governanceHttp(
        studio.org.id,
        artifactId,
        undefined,
        humanToken,
        "approvals",
        "poc_human_final",
        { version: 2 },
      );
      expect(final.status).toBe(201);
      await notifyProductionTaskEvidence(env, studio.org.id, artifactId, HUMAN_APPROVAL_EVENT);
      await watched.waitForStatus("complete");
      expect(await watched.getOutput()).toEqual({ outcome: "COMPLETE", iteration: 1 });
      expect(await runStatus(studio.org.id, runId)).toBe("complete");
      const approvals = await env.DB.prepare(
        `SELECT kind, decision, reason FROM approvals
         WHERE org_id = ? AND artifact_id = ? ORDER BY rowid`,
      )
        .bind(studio.org.id, artifactId)
        .all<{ kind: string; decision: string; reason: string }>();
      expect(approvals.results).toEqual([
        { kind: "security", decision: "PASS", reason: "ALLOWED" },
        { kind: "final", decision: "PASS", reason: "ALLOWED" },
      ]);
    } finally {
      await watched.dispose();
    }

    expect((await run(owner, "approve", { key: "poc_owner_appr1", taskId })).state).toBe(
      "APPROVED",
    );
    expect((await run(managerActor, "complete", { key: "poc_mgr_done_01", taskId })).state).toBe(
      "COMPLETED",
    );
    expect(await storedTask(studio.org.id, taskId)).toMatchObject({
      state: "COMPLETED",
      assignee_id: workerA.id,
      handoff_count: 1,
      human_review_required: 0,
      pause_reason: null,
    });

    const swept = await agentStub(studio.org.id, workerA.id).sweep({
      orgId: studio.org.id,
      employeeId: workerA.id,
      before: "2999-01-01T00:00:00.000Z",
    });
    expect(swept).toMatchObject({ decision: "ALLOW", expired: 0 });
    const afterCompletion = await agentStub(studio.org.id, workerA.id).snapshot({
      orgId: studio.org.id,
      employeeId: workerA.id,
    });
    expect(afterCompletion.availability).toBe("IDLE");
    expect(afterCompletion.reachability).toBe("BROWSER_CONNECTED");
    expect(afterCompletion.currentTaskId).toBeNull();
    expect(
      await agentStub(studio.org.id, workerA.id).applyCanonicalTaskAck({
        orgId: studio.org.id,
        employeeId: workerA.id,
        taskId,
        idempotencyKey: "poc_late_completed_ack",
      }),
    ).toMatchObject({ decision: "ALLOW" });
    expect(
      (
        await agentStub(studio.org.id, workerA.id).snapshot({
          orgId: studio.org.id,
          employeeId: workerA.id,
        })
      ).currentTaskId,
    ).toBeNull();
    expect((await storedTask(studio.org.id, taskId))?.state).toBe("COMPLETED");

    const loop = await run(ceoActor, "create", {
      key: "poc_loop_create1",
      title: "Handoff loop",
      objective: "Alternate until the guard pauses the task.",
      roomId: room.id,
    });
    expect(loop.decision).toBe("ALLOW");
    const loopId = loop.taskId ?? "";
    expect(
      (
        await run(workerActor, "assign", {
          key: "poc_loop_deny_a1",
          taskId: loopId,
          assigneeId: workerB.id,
        })
      ).reason,
    ).toBe("NO_PERMISSION");
    let handoff = await run(managerActor, "assign", {
      key: "poc_loop_assign0",
      taskId: loopId,
      assigneeId: workerA.id,
    });
    expect(handoff).toMatchObject({ decision: "ALLOW", state: "QUEUED", handoffCount: 0 });
    const pair = [workerB.id, workerA.id];
    for (let step = 1; step <= 8; step += 1) {
      handoff = await run(managerActor, "assign", {
        key: `poc_loop_step_${step}`,
        taskId: loopId,
        assigneeId: pair[(step - 1) % 2] ?? workerA.id,
      });
      expect(handoff).toMatchObject({
        decision: "ALLOW",
        reason: "ALLOWED",
        handoffCount: step,
      });
    }
    const guard = await run(managerActor, "assign", {
      key: "poc_loop_step_9",
      taskId: loopId,
      assigneeId: workerB.id,
    });
    expect(guard).toMatchObject({
      decision: "ALLOW",
      reason: "LOOP_GUARD",
      state: "PAUSED",
      handoffCount: 8,
      humanReviewRequired: true,
      pauseReason: "LOOP_GUARD",
    });
    expect(await storedTask(studio.org.id, loopId)).toMatchObject({
      state: "PAUSED",
      assignee_id: workerA.id,
      handoff_count: 8,
      human_review_required: 1,
      pause_reason: "LOOP_GUARD",
    });

    expect((await org.suspendEmployee({ ...owner, employeeId: workerB.id })).decision).toBe(
      "ALLOW",
    );
    const suspended = await artifactStub(studio.org.id).put(
      putBytes(workerB.id, studio.org.id, "poc_suspended_b1", room.id, loopId, null, "blocked"),
    );
    expect(suspended).toMatchObject({ decision: "DENY", reason: "SUSPENDED_AGENT_DENY" });
    const suspendedRow = await env.DB.prepare(
      `SELECT status FROM employees WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, workerB.id)
      .first<{ status: string }>();
    expect(suspendedRow?.status).toBe("suspended");

    const foreignTask = await taskStub(other.org.id).execute({
      orgId: other.org.id,
      actorType: "employee",
      actorId: workerA.id,
      idempotencyKey: "poc_cross_org_a1",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Foreign",
      objective: "Should not land.",
      roomId: null,
      dependsOn: [],
    });
    expect(foreignTask).toMatchObject({
      decision: "DENY",
      reason: "TENANT_BOUNDARY",
      taskId: null,
      state: null,
    });
    const mismatched = await taskStub(other.org.id).execute({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: workerA.id,
      idempotencyKey: "poc_cross_bind1",
      command: "ack",
      taskId,
      assigneeId: null,
      title: null,
      objective: null,
      roomId: null,
      dependsOn: [],
    });
    expect(mismatched).toMatchObject({
      decision: "DENY",
      reason: "TENANT_BOUNDARY",
      taskId: null,
      state: null,
    });
    const foreignRead = await artifactStub(other.org.id).read({
      orgId: other.org.id,
      actorType: "employee",
      actorId: workerA.id,
      artifactId,
      version: 2,
    });
    expect(foreignRead).toMatchObject({
      decision: "DENY",
      reason: "TENANT_BOUNDARY",
      bodyBase64: null,
      filename: null,
      sha256: null,
    });
    expect(
      await env.DB.prepare(`SELECT id, title, objective FROM tasks WHERE org_id = ? AND id = ?`)
        .bind(other.org.id, taskId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(`SELECT id FROM artifacts WHERE org_id = ? AND id = ?`)
        .bind(other.org.id, artifactId)
        .first(),
    ).toBeNull();
    expect(
      (
        await env.DB.prepare(`SELECT id FROM tasks WHERE org_id = ? AND id = ?`)
          .bind(studio.org.id, taskId)
          .first<{ id: string }>()
      )?.id,
    ).toBe(taskId);

    await pump();
    expect(
      await count(studio.org.id, `SELECT COUNT(*) AS n FROM dead_letters WHERE org_id = ?`),
    ).toBe(0);
  }, 60_000);
});
