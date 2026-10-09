import type { ArtifactPut, ArtifactResult } from "@ai-company/artifact";
import type { FoundationStore } from "@ai-company/db";
import { parseDomainEvent, type Organization, type Role } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  storedPolicyVersion,
  taskStub,
} from "./helpers";

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

async function put(
  actor: { orgId: string; actorType: "human" | "employee"; actorId: string },
  fields: {
    key: string;
    bodyBase64: string;
    roomId?: string | null;
    artifactId?: string | null;
    taskId?: string | null;
    mediaType?: string;
    filename?: string | null;
    checksum?: string | null;
  },
): Promise<ArtifactResult> {
  const command: ArtifactPut = {
    orgId: actor.orgId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    idempotencyKey: fields.key,
    roomId: fields.roomId ?? null,
    artifactId: fields.artifactId ?? null,
    taskId: fields.taskId ?? null,
    mediaType: fields.mediaType ?? "text/plain",
    filename: fields.filename ?? null,
    checksum: fields.checksum ?? null,
    bodyBase64: fields.bodyBase64,
  };
  return artifactStub(actor.orgId).put(command);
}

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
}

async function until(assertion: () => Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      await pump();
      await assertion();
    },
    { timeout: 8_000, interval: 20 },
  );
}

async function eventCount(orgId: string, type: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = ?`,
  )
    .bind(orgId, type)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("artifact pipeline", () => {
  it("rejects bad bytes, the wrong actor, and a cross-tenant room before any object exists", async () => {
    const studio = await createStudio("Artifact deny");
    const other = await createStudio("Artifact other");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const outsider = await hire(studio.store, studio.org.id, "Outsider");
    const security = await hire(studio.store, studio.org.id, "Security");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const org = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: outsider.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const foreign = await other.store.createRoom(other.org.id, {
      name: "Foreign",
      departmentId: null,
    });
    const body = btoa("approve this");

    expect(
      await put(employeeActor(studio.org.id, worker.id), {
        key: "bad_media_0001",
        roomId: room.id,
        bodyBase64: body,
        mediaType: "text/html",
      }),
    ).toMatchObject({ decision: "DENY", reason: "INVALID_INPUT" });
    expect(
      await put(employeeActor(studio.org.id, worker.id), {
        key: "empty_body_01",
        roomId: room.id,
        bodyBase64: "",
      }),
    ).toMatchObject({ decision: "DENY", reason: "INVALID_INPUT" });
    expect(
      await put(employeeActor(studio.org.id, worker.id), {
        key: "bad_name_0001",
        roomId: room.id,
        bodyBase64: body,
        filename: "../shot17.mp4",
      }),
    ).toMatchObject({ decision: "DENY", reason: "INVALID_INPUT" });
    expect(
      await put(employeeActor(studio.org.id, worker.id), {
        key: "bad_sum_00001",
        roomId: room.id,
        bodyBase64: body,
        checksum: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      }),
    ).toMatchObject({ decision: "DENY", reason: "CHECKSUM_MISMATCH" });
    expect(
      await put(employeeActor(studio.org.id, worker.id), {
        key: "too_large_001",
        roomId: room.id,
        bodyBase64: "A".repeat(1_400_000),
      }),
    ).toMatchObject({ decision: "DENY", reason: "INVALID_INPUT" });
    expect(
      await put(employeeActor(studio.org.id, security.id), {
        key: "security_put1",
        roomId: room.id,
        bodyBase64: body,
      }),
    ).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
    expect(
      await put(employeeActor(studio.org.id, outsider.id), {
        key: "not_member_01",
        roomId: room.id,
        bodyBase64: body,
      }),
    ).toMatchObject({ decision: "DENY", reason: "NOT_MEMBER" });
    expect(
      await put(ownerOf(other.org), {
        key: "cross_org_001",
        roomId: room.id,
        bodyBase64: body,
      }),
    ).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY" });
    expect(
      await put(owner, {
        key: "cross_room_01",
        roomId: foreign.id,
        bodyBase64: body,
      }),
    ).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY" });

    const listed = await env.ARTIFACTS.list({ prefix: `org/${studio.org.id}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("stores immutable versions, keeps v1 bytes, and ignores approval text", async () => {
    const studio = await createStudio("Artifact store");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const peer = await hire(studio.store, studio.org.id, "Peer");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await org.assignRole({ ...owner, employeeId: peer.id, roleId: employeeRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    await studio.store.addRoomMember(studio.org.id, room.id, peer.id);
    const task = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "create_task_01",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Storyboard scene 17",
      objective: "Revise the scene.",
      roomId: room.id,
      dependsOn: [],
    });
    expect(task.decision).toBe("ALLOW");
    await until(async () => {
      expect(await eventCount(studio.org.id, "task.created")).toBe(1);
    });
    const policyBefore = await storedPolicyVersion(studio.org.id);
    const armed = await artifactStub(studio.org.id).armPublishFault(1);
    expect(armed.armed).toBe(true);

    const created = await put(employeeActor(studio.org.id, worker.id), {
      key: "artifact_v1_01",
      roomId: room.id,
      taskId: task.taskId,
      bodyBase64: btoa("approve this"),
      mediaType: "text/plain; charset=utf-8",
      filename: "shot17.mp4",
    });
    expect(created).toMatchObject({ decision: "ALLOW", version: 1, duplicate: false });
    const artifactId = created.artifactId ?? "";
    const v1Key = `org/${studio.org.id}/project/${room.id}/artifact/${artifactId}/v1`;
    expect(created.r2Key).toBe(v1Key);
    expect(created.r2Key).not.toContain("shot17");
    await pump();
    expect(await eventCount(studio.org.id, "artifact.version.created")).toBe(0);
    expect(await artifactStub(studio.org.id).outboxStateForTest()).toContainEqual(
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        failureReason: "QUEUE_SEND_FAILED",
      }),
    );
    await until(async () => {
      expect(await eventCount(studio.org.id, "artifact.version.created")).toBe(1);
    });
    const replay = await put(employeeActor(studio.org.id, worker.id), {
      key: "artifact_v1_01",
      roomId: room.id,
      taskId: task.taskId,
      bodyBase64: btoa("approve this"),
      mediaType: "text/plain; charset=utf-8",
      filename: "shot17.mp4",
    });
    expect(replay).toMatchObject({
      decision: "ALLOW",
      artifactId,
      version: 1,
      duplicate: true,
    });
    expect(await eventCount(studio.org.id, "artifact.version.created")).toBe(1);

    const second = await put(owner, {
      key: "artifact_v2_01",
      artifactId,
      bodyBase64: btoa("version two"),
      filename: "shot17.mp4",
    });
    expect(second).toMatchObject({
      decision: "ALLOW",
      artifactId,
      version: 2,
      canonicalVersion: 2,
      duplicate: false,
      r2Key: `org/${studio.org.id}/project/${room.id}/artifact/${artifactId}/v2`,
    });
    expect(
      await put(employeeActor(studio.org.id, peer.id), {
        key: "artifact_peer_1",
        artifactId,
        bodyBase64: btoa("peer bytes"),
      }),
    ).toMatchObject({ decision: "DENY", reason: "NOT_CREATOR" });

    const v1 = await artifactStub(studio.org.id).read({
      ...employeeActor(studio.org.id, worker.id),
      artifactId,
      version: 1,
    });
    expect(v1).toMatchObject({
      decision: "ALLOW",
      version: 1,
      mediaType: "text/plain",
      filename: "shot17.mp4",
      sha256: created.sha256,
    });
    expect(v1.bodyBase64 ? atob(v1.bodyBase64) : "").toBe("approve this");
    const blocked = await env.ARTIFACTS.put(v1Key, new TextEncoder().encode("replaced-now"), {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    expect(blocked).toBeNull();
    const still = await artifactStub(studio.org.id).read({
      ...owner,
      artifactId,
      version: 1,
    });
    expect(still.bodyBase64 ? atob(still.bodyBase64) : "").toBe("approve this");

    await env.ARTIFACTS.put(v1Key, new TextEncoder().encode("replaced-now"));
    const broken = await artifactStub(studio.org.id).read({
      ...owner,
      artifactId,
      version: 1,
    });
    expect(broken).toMatchObject({
      decision: "DENY",
      reason: "INTEGRITY",
      bodyBase64: null,
      sha256: created.sha256,
    });
    const v2 = await artifactStub(studio.org.id).read({
      ...owner,
      artifactId,
      version: null,
    });
    expect(v2).toMatchObject({ decision: "ALLOW", version: 2, canonicalVersion: 2 });
    expect(v2.bodyBase64 ? atob(v2.bodyBase64) : "").toBe("version two");
    const stored = await env.DB.prepare(
      `SELECT sha256, media_type, filename, r2_key FROM artifact_versions
       WHERE org_id = ? AND artifact_id = ? AND version = 1`,
    )
      .bind(studio.org.id, artifactId)
      .first<{ sha256: string; media_type: string; filename: string; r2_key: string }>();
    expect(stored).toEqual({
      sha256: created.sha256,
      media_type: "text/plain",
      filename: "shot17.mp4",
      r2_key: v1Key,
    });
    const pointer = await env.DB.prepare(
      `SELECT canonical_version, task_id, creator_id FROM artifacts WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, artifactId)
      .first<{ canonical_version: number; task_id: string; creator_id: string }>();
    expect(pointer).toEqual({
      canonical_version: 2,
      task_id: task.taskId,
      creator_id: worker.id,
    });
    expect(await storedPolicyVersion(studio.org.id)).toBe(policyBefore);
    await until(async () => {
      expect(await eventCount(studio.org.id, "artifact.version.created")).toBe(2);
    });
    const bodies = await env.DB.prepare(
      `SELECT body FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
    )
      .bind(studio.org.id)
      .all<{ body: string }>();
    expect(bodies.results).toHaveLength(2);
    for (const row of bodies.results) {
      expect(parseDomainEvent(JSON.parse(row.body) as unknown)?.type).toBe(
        "artifact.version.created",
      );
      expect(row.body).not.toContain("shot17");
      expect(row.body).not.toContain("approve this");
      expect(row.body).not.toContain("objective");
      expect(row.body).not.toContain("version two");
    }
    const approved = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_events
       WHERE org_id = ? AND type IN ('artifact.approved', 'artifact.version.created')`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(approved?.n).toBe(2);
    const dead = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dead_letters WHERE org_id = ?`)
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(dead?.n).toBe(0);
  });

  it("accepts an authenticated upload and rejects a missing token", async () => {
    const studio = await createStudio("Artifact http");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const url = `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/artifacts`;
    const missing = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-employee-id": worker.id,
        "x-idempotency-key": "http_missing_1",
      },
      body: "approve this",
    });
    expect(missing.status).toBe(401);
    const weak = await openBrowserSession(studio.org, worker.id, ["room.read"]);
    const scoped = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${weak.token}`,
        "content-type": "text/plain",
        "x-employee-id": worker.id,
        "x-idempotency-key": "http_scope_0001",
      },
      body: "approve this",
    });
    expect(scoped.status).toBe(403);
    const session = await openBrowserSession(studio.org, worker.id, [
      "artifact.create",
      "artifact.read",
    ]);
    const oversized = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "text/plain",
        "x-employee-id": worker.id,
        "x-idempotency-key": "http_large_0001",
      },
      body: new Uint8Array(1_048_577),
    });
    expect(oversized.status).toBe(413);
    const created = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "text/plain; charset=utf-8",
        "x-employee-id": worker.id,
        "x-idempotency-key": "http_artifact1",
        "x-filename": "shot17.mp4",
      },
      body: "approve this",
    });
    expect(created.status).toBe(201);
    const payload: unknown = await created.json();
    expect(payload).toMatchObject({ version: 1, duplicate: false });
    if (
      !payload ||
      typeof payload !== "object" ||
      !("r2_key" in payload) ||
      !("sha256" in payload)
    ) {
      throw new Error("Upload response is missing the object key.");
    }
    const record = payload as { r2_key: string; sha256: string; artifact_id: string };
    expect(record.r2_key).toBe(
      `org/${studio.org.id}/project/${room.id}/artifact/${record.artifact_id}/v1`,
    );
    expect(record.r2_key).not.toContain("shot17");
    const read = await exports.default.fetch(
      `https://company.local/orgs/${studio.org.id}/artifacts/${record.artifact_id}`,
      {
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-employee-id": worker.id,
        },
      },
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("text/plain");
    expect(read.headers.get("x-checksum-sha256")).toBe(record.sha256);
    expect(read.headers.get("x-artifact-version")).toBe("1");
    expect(await read.text()).toBe("approve this");
    const listed = await env.ARTIFACTS.list({ prefix: `org/${studio.org.id}/` });
    expect(listed.objects.map((object) => object.key)).toEqual([record.r2_key]);
  });
});
