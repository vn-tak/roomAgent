import type { ArtifactPut, ArtifactResult } from "@ai-company/artifact";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  taskStub,
} from "./helpers";

function ownerOf(org: { id: string; createdByUserId: string }) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function taskFor(
  orgId: string,
  ownerId: string,
  roomId: string,
  key: string,
): Promise<string> {
  const result = await taskStub(orgId).execute({
    orgId,
    actorType: "human",
    actorId: ownerId,
    idempotencyKey: key,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Scene task",
    objective: "Create the scene.",
    roomId,
    dependsOn: [],
  });
  if (result.decision !== "ALLOW" || !result.taskId) {
    throw new Error(`Task creation failed: ${result.reason}`);
  }
  return result.taskId;
}

async function put(
  orgId: string,
  actorId: string,
  key: string,
  fields: { roomId: string | null; artifactId: string | null; taskId: string | null },
): Promise<ArtifactResult> {
  const command: ArtifactPut = {
    orgId,
    actorType: "employee",
    actorId,
    idempotencyKey: key,
    roomId: fields.roomId,
    artifactId: fields.artifactId,
    taskId: fields.taskId,
    mediaType: "text/plain",
    filename: null,
    checksum: null,
    bodyBase64: btoa(key),
  };
  return artifactStub(orgId).put(command);
}

async function until(assertion: () => Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      for (let step = 0; step < 4; step += 1) {
        await scheduler.wait(1);
      }
      await assertion();
    },
    { timeout: 8_000, interval: 20 },
  );
}

async function artifactCount(orgId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE org_id = ?`)
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("artifact/task room integrity", () => {
  it("rejects cross-room links for first and later versions at DO and HTTP boundaries", async () => {
    const studio = await createStudio("Artifact room integrity");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const owner = ownerOf(studio.org);
    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!employeeRole) {
      throw new Error("Employee role is missing.");
    }
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const roomA = await studio.store.createRoom(studio.org.id, {
      name: "Room A",
      departmentId: null,
    });
    const roomB = await studio.store.createRoom(studio.org.id, {
      name: "Room B",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, roomA.id, worker.id);
    await studio.store.addRoomMember(studio.org.id, roomB.id, worker.id);
    const taskA = await taskFor(
      studio.org.id,
      studio.org.createdByUserId,
      roomA.id,
      "task_room_a1",
    );
    const taskB = await taskFor(
      studio.org.id,
      studio.org.createdByUserId,
      roomB.id,
      "task_room_b1",
    );
    await until(async () => {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'task.created'`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>();
      expect(row?.n).toBe(2);
    });

    const beforeEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(
      await put(studio.org.id, worker.id, "do_wrong_room_01", {
        roomId: roomA.id,
        artifactId: null,
        taskId: taskB,
      }),
    ).toMatchObject({ decision: "DENY", reason: "ROOM_MISMATCH" });
    expect(await artifactCount(studio.org.id)).toBe(0);
    const afterEvents = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(afterEvents?.n).toBe(beforeEvents?.n);

    const first = await put(studio.org.id, worker.id, "do_room_v1_0001", {
      roomId: roomA.id,
      artifactId: null,
      taskId: taskA,
    });
    expect(first).toMatchObject({ decision: "ALLOW", version: 1 });
    const artifactId = first.artifactId;
    if (!artifactId) {
      throw new Error("Artifact creation did not return an id.");
    }
    expect(
      await put(studio.org.id, worker.id, "do_wrong_v2_0001", {
        roomId: null,
        artifactId,
        taskId: taskB,
      }),
    ).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY" });
    expect(
      await put(studio.org.id, worker.id, "do_room_v2_0001", {
        roomId: null,
        artifactId,
        taskId: taskA,
      }),
    ).toMatchObject({ decision: "ALLOW", version: 2 });

    const taskCorrelation = await env.DB.prepare(
      `SELECT correlation_id FROM domain_events
       WHERE org_id = ? AND subject_type = 'task' AND subject_id = ? ORDER BY seq LIMIT 1`,
    )
      .bind(studio.org.id, taskA)
      .first<{ correlation_id: string }>();
    await until(async () => {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND subject_id = ?
         AND type = 'artifact.version.created'`,
      )
        .bind(studio.org.id, artifactId)
        .first<{ n: number }>();
      expect(count?.n).toBe(2);
    });
    const artifactEvents = await env.DB.prepare(
      `SELECT correlation_id FROM domain_events
       WHERE org_id = ? AND subject_id = ? AND type = 'artifact.version.created' ORDER BY seq`,
    )
      .bind(studio.org.id, artifactId)
      .all<{ correlation_id: string }>();
    expect(artifactEvents.results.map((row) => row.correlation_id)).toEqual([
      taskCorrelation?.correlation_id,
      taskCorrelation?.correlation_id,
    ]);
    const review = await artifactStub(studio.org.id).review({
      ...owner,
      idempotencyKey: "review_task_corr_01",
      artifactId,
      version: 2,
      result: "PASS",
    });
    expect(review.decision).toBe("ALLOW");
    await until(async () => {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND subject_id = ?
         AND type = 'review.recorded'`,
      )
        .bind(studio.org.id, artifactId)
        .first<{ n: number }>();
      expect(count?.n).toBe(1);
    });
    const correlatedEvents = await env.DB.prepare(
      `SELECT correlation_id, seq FROM domain_events
       WHERE org_id = ? AND subject_id = ?
         AND type IN ('artifact.version.created', 'review.recorded')
       ORDER BY seq`,
    )
      .bind(studio.org.id, artifactId)
      .all<{ correlation_id: string; seq: number }>();
    expect(correlatedEvents.results.map((row) => row.correlation_id)).toEqual([
      taskCorrelation?.correlation_id,
      taskCorrelation?.correlation_id,
      taskCorrelation?.correlation_id,
    ]);
    expect(correlatedEvents.results.map((row) => row.seq)).toEqual(
      [...correlatedEvents.results.map((row) => row.seq)].sort((left, right) => left - right),
    );

    const session = await openBrowserSession(studio.org, worker.id, [
      "artifact.create",
      "artifact.modify",
    ]);
    const headers = {
      authorization: `Bearer ${session.token}`,
      "x-employee-id": worker.id,
      "content-type": "text/plain",
    };
    const root = `https://company.local/orgs/${studio.org.id}`;
    const httpWrong = await exports.default.fetch(`${root}/rooms/${roomA.id}/artifacts`, {
      method: "POST",
      headers: { ...headers, "x-idempotency-key": "http_wrong_r1", "x-task-id": taskB },
      body: "wrong room",
    });
    expect(httpWrong.status).toBe(404);
    expect(await artifactCount(studio.org.id)).toBe(1);

    const httpCreated = await exports.default.fetch(`${root}/rooms/${roomA.id}/artifacts`, {
      method: "POST",
      headers: { ...headers, "x-idempotency-key": "http_room_v1", "x-task-id": taskA },
      body: "room A artifact",
    });
    expect(httpCreated.status).toBe(201);
    const createdBody = (await httpCreated.json()) as { artifact_id: string };
    const httpWrongVersion = await exports.default.fetch(
      `${root}/artifacts/${createdBody.artifact_id}/versions`,
      {
        method: "POST",
        headers: { ...headers, "x-idempotency-key": "http_wrong_v2", "x-task-id": taskB },
        body: "wrong room revision",
      },
    );
    expect(httpWrongVersion.status).toBe(404);
    const httpGoodVersion = await exports.default.fetch(
      `${root}/artifacts/${createdBody.artifact_id}/versions`,
      {
        method: "POST",
        headers: { ...headers, "x-idempotency-key": "http_room_v2", "x-task-id": taskA },
        body: "room A revision",
      },
    );
    expect(httpGoodVersion.status).toBe(201);
    expect(await artifactCount(studio.org.id)).toBe(2);
  });
});
