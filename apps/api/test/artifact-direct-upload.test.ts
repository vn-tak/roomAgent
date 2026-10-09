import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  taskStub,
} from "./helpers";

function bytes(size: number): Uint8Array {
  const value = new Uint8Array(size);
  for (let index = 0; index < value.length; index += 1) {
    value[index] = index % 251;
  }
  return value;
}

async function checksum(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uploadHeaders(
  session: { token: string },
  employeeId: string,
  value: Uint8Array,
  key: string,
  sha256: string,
  taskId?: string,
): HeadersInit {
  return {
    authorization: `Bearer ${session.token}`,
    "content-type": "video/mp4",
    "content-length": String(value.byteLength),
    "x-checksum-sha256": sha256,
    "x-employee-id": employeeId,
    "x-idempotency-key": key,
    ...(taskId ? { "x-task-id": taskId } : {}),
  };
}

async function reserve(
  url: string,
  session: { token: string },
  employeeId: string,
  value: Uint8Array,
  key: string,
  sha256: string,
  taskId?: string,
): Promise<Response> {
  return exports.default.fetch(url, {
    method: "POST",
    headers: uploadHeaders(session, employeeId, value, key, sha256, taskId),
  });
}

describe("direct artifact byte transport", () => {
  it("streams a large immutable R2 version using an actor-bound reservation and explicit commit", async () => {
    const studio = await createStudio("Artifact direct upload");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const outsider = await hire(studio.store, studio.org.id, "Other worker");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!employeeRole) {
      throw new Error("Employee role is missing.");
    }
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: outsider.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Render room",
      departmentId: null,
    });
    const otherRoom = await studio.store.createRoom(studio.org.id, {
      name: "Different render room",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const workerSession = await openBrowserSession(studio.org, worker.id, [
      "artifact.create",
      "artifact.modify",
      "artifact.read",
    ]);
    const outsiderSession = await openBrowserSession(studio.org, outsider.id, ["artifact.create"]);
    const payload = bytes(1_250_000);
    const digest = await checksum(payload);
    const root = `https://company.local/orgs/${studio.org.id}`;
    const otherRoomTask = await taskStub(studio.org.id).execute({
      ...owner,
      idempotencyKey: "direct_wrong_room_task",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Other room task",
      objective: "Belongs to the other room.",
      roomId: otherRoom.id,
      dependsOn: [],
    });
    if (!otherRoomTask.taskId) {
      throw new Error("Task creation failed.");
    }
    const wrongRoomTask = await reserve(
      `${root}/rooms/${room.id}/artifacts/uploads`,
      workerSession,
      worker.id,
      payload,
      "direct_wrong_task1",
      digest,
      otherRoomTask.taskId,
    );
    expect(wrongRoomTask.status).toBe(404);
    expect(await wrongRoomTask.json()).toMatchObject({ error: { code: "TENANT_BOUNDARY" } });
    const reservationResponse = await reserve(
      `${root}/rooms/${room.id}/artifacts/uploads`,
      workerSession,
      worker.id,
      payload,
      "direct_reserve_01",
      digest,
    );
    expect(reservationResponse.status).toBe(201);
    const reservation = (await reservationResponse.json()) as {
      artifact_id: string;
      version: number;
      upload_url: string;
      commit_url: string;
      sha256: string;
      duplicate: boolean;
      r2_key?: string;
    };
    expect(reservation).toMatchObject({ version: 1, sha256: digest, duplicate: false });
    expect(reservation.r2_key).toBeUndefined();
    expect(reservation.upload_url).toContain("/artifacts/uploads/");

    const unauthenticated = await exports.default.fetch(reservation.upload_url, {
      method: "PUT",
      headers: { "content-length": String(payload.byteLength) },
      body: payload,
    });
    expect(unauthenticated.status).toBe(401);
    const wrongActor = await exports.default.fetch(reservation.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${outsiderSession.token}`,
        "content-length": String(payload.byteLength),
        "x-employee-id": outsider.id,
      },
      body: payload,
    });
    expect(wrongActor.status).toBe(409);

    const missingCommit = await exports.default.fetch(reservation.commit_url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "x-employee-id": worker.id,
      },
    });
    expect(missingCommit.status).toBe(409);

    const upload = await exports.default.fetch(reservation.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "content-length": String(payload.byteLength),
        "x-employee-id": worker.id,
      },
      body: payload,
    });
    expect(upload.status).toBe(201);
    const commit = await exports.default.fetch(reservation.commit_url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "x-employee-id": worker.id,
      },
    });
    expect(commit.status).toBe(201);
    const committed = (await commit.json()) as {
      artifact_id: string;
      version: number;
      r2_key: string;
    };
    expect(committed).toMatchObject({ artifact_id: reservation.artifact_id, version: 1 });
    expect(committed.r2_key).toBe(
      `org/${studio.org.id}/project/${room.id}/artifact/${reservation.artifact_id}/v1`,
    );

    const overwrite = await exports.default.fetch(reservation.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "content-length": String(payload.byteLength),
        "x-employee-id": worker.id,
      },
      body: payload,
    });
    expect(overwrite.status).toBe(409);
    const duplicateCommit = await exports.default.fetch(reservation.commit_url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "x-employee-id": worker.id,
      },
    });
    expect(duplicateCommit.status).toBe(201);
    expect(await duplicateCommit.json()).toMatchObject({ duplicate: true, version: 1 });

    const secondPayload = bytes(8);
    const secondDigest = await checksum(secondPayload);
    const secondReservationResponse = await reserve(
      `${root}/artifacts/${reservation.artifact_id}/uploads`,
      workerSession,
      worker.id,
      secondPayload,
      "direct_reserve_02",
      secondDigest,
    );
    expect(secondReservationResponse.status).toBe(201);
    const secondReservation = (await secondReservationResponse.json()) as {
      version: number;
      upload_url: string;
      commit_url: string;
    };
    expect(secondReservation.version).toBe(2);
    const secondUpload = await exports.default.fetch(secondReservation.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "content-length": String(secondPayload.byteLength),
        "x-employee-id": worker.id,
      },
      body: secondPayload,
    });
    expect(secondUpload.status).toBe(201);
    expect(
      (
        await exports.default.fetch(secondReservation.commit_url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${workerSession.token}`,
            "x-employee-id": worker.id,
          },
        })
      ).status,
    ).toBe(201);

    const fetched = await exports.default.fetch(
      `${root}/artifacts/${reservation.artifact_id}?version=1`,
      {
        headers: {
          authorization: `Bearer ${workerSession.token}`,
          "x-employee-id": worker.id,
        },
      },
    );
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("x-checksum-sha256")).toBe(digest);
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(payload);

    const stored = await env.DB.prepare(
      `SELECT sha256, size FROM artifact_versions WHERE org_id = ? AND artifact_id = ? AND version = 1`,
    )
      .bind(studio.org.id, reservation.artifact_id)
      .first<{ sha256: string; size: number }>();
    expect(stored).toEqual({ sha256: digest, size: payload.byteLength });
  });

  it("rechecks authority after reserve and before upload or commit", async () => {
    const { org, store } = await createStudio("Upload revoked authority");
    const worker = await hire(store, org.id, "Worker");
    const owner = { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
    const authority = organizationStub(org.id);
    const role = await store.getRoleByCode(org.id, "employee");
    await authority.assignRole({ ...owner, employeeId: worker.id, roleId: role?.id ?? "" });
    const room = await store.createRoom(org.id, { name: "Revoked upload", departmentId: null });
    await store.addRoomMember(org.id, room.id, worker.id);
    const actor = { orgId: org.id, actorType: "employee" as const, actorId: worker.id };
    const reservation = await artifactStub(org.id).reserveUpload({
      ...actor,
      roomId: room.id,
      artifactId: null,
      taskId: null,
      idempotencyKey: "upload_revoked_reserve",
      mediaType: "video/mp4",
      filename: null,
      size: 1024,
      checksum: await checksum(bytes(1024)),
    });
    expect(reservation.decision).toBe("ALLOW");
    const command = { ...actor, uploadToken: reservation.uploadToken ?? "" };
    expect(await artifactStub(org.id).uploadTarget(command)).toMatchObject({ decision: "ALLOW" });
    await authority.createSecurityBlock({
      ...owner,
      resourceType: "artifact",
      resourceId: reservation.artifactId ?? "",
      severity: "high",
      reason: "Review required",
    });
    expect(await artifactStub(org.id).uploadTarget(command)).toMatchObject({
      decision: "DENY",
      reason: "SECURITY_BLOCK",
    });
    expect(await artifactStub(org.id).commitUpload(command)).toMatchObject({
      decision: "DENY",
      reason: "SECURITY_BLOCK",
    });
    await authority.suspendEmployee({ ...owner, employeeId: worker.id });
    expect(await artifactStub(org.id).commitUpload(command)).toMatchObject({
      decision: "DENY",
      reason: "SUSPENDED_AGENT_DENY",
    });
  });

  it("rejects a body whose reserved checksum differs and does not commit it", async () => {
    const studio = await createStudio("Artifact bad checksum");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!employeeRole) {
      throw new Error("Employee role is missing.");
    }
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Checksum room",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const session = await openBrowserSession(studio.org, worker.id, ["artifact.create"]);
    const intended = bytes(1024 * 1024 + 1);
    const incorrect = bytes(intended.byteLength);
    const lastByte = incorrect.at(-1);
    if (lastByte === undefined) {
      throw new Error("Test payload cannot be empty.");
    }
    incorrect[incorrect.length - 1] = lastByte ^ 0xff;
    const reservationResponse = await reserve(
      `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/artifacts/uploads`,
      session,
      worker.id,
      intended,
      "direct_bad_hash1",
      await checksum(intended),
    );
    expect(reservationResponse.status).toBe(201);
    const reservation = (await reservationResponse.json()) as {
      upload_url: string;
      commit_url: string;
    };
    const upload = await exports.default.fetch(reservation.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-length": String(incorrect.byteLength),
        "x-employee-id": worker.id,
      },
      body: incorrect,
    });
    if (upload.status === 201) {
      const commit = await exports.default.fetch(reservation.commit_url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-employee-id": worker.id,
        },
      });
      expect(commit.status).toBe(400);
      expect(await commit.json()).toMatchObject({ error: { code: "CHECKSUM_MISMATCH" } });
    } else {
      expect(upload.status).toBe(400);
      expect(await upload.json()).toMatchObject({ error: { code: "CHECKSUM_MISMATCH" } });
    }
  });

  it("retries the artifact outbox on its alarm without replaying a command", async () => {
    const studio = await createStudio("Artifact outbox retry");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!employeeRole) {
      throw new Error("Employee role is missing.");
    }
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Outbox room",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    const armed = await artifactStub(studio.org.id).armPublishFault(2);
    expect(armed.armed).toBe(true);
    const data = bytes(32);
    const session = await openBrowserSession(studio.org, worker.id, ["artifact.create"]);
    const created = await reserve(
      `https://company.local/orgs/${studio.org.id}/rooms/${room.id}/artifacts/uploads`,
      session,
      worker.id,
      data,
      "outbox_reserve_01",
      await checksum(data),
    );
    expect(created.status).toBe(201);
    const value = (await created.json()) as { upload_url: string; commit_url: string };
    await exports.default.fetch(value.upload_url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-length": String(data.byteLength),
        "x-employee-id": worker.id,
      },
      body: data,
    });
    const committed = await exports.default.fetch(value.commit_url, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "x-employee-id": worker.id },
    });
    expect(committed.status).toBe(201);
    const beforeRetry = await artifactStub(studio.org.id).outboxStateForTest();
    expect(beforeRetry).toContainEqual(
      expect.objectContaining({
        status: "pending",
        attempts: 1,
        failureReason: "QUEUE_SEND_FAILED",
      }),
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
      )
        .bind(studio.org.id)
        .first<{ n: number }>(),
    ).toMatchObject({ n: 0 });
    await scheduler.wait(6_500);
    const outbox = await artifactStub(studio.org.id).outboxStateForTest();
    expect(outbox).toContainEqual(
      expect.objectContaining({ status: "sent", attempts: 2, failureReason: null }),
    );
    const event = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(event?.n).toBe(1);
  });

  it("marks malformed persisted outbox events failed without retrying them", async () => {
    const studio = await createStudio("Artifact invalid outbox event");
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Invalid outbox room",
      departmentId: null,
    });
    const owner = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
    };
    expect(await artifactStub(studio.org.id).armPublishFault(1)).toMatchObject({ armed: true });
    const created = await artifactStub(studio.org.id).put({
      ...owner,
      idempotencyKey: "invalid_outbox_01",
      roomId: room.id,
      artifactId: null,
      taskId: null,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("outbox payload"),
    });
    expect(created.decision).toBe("ALLOW");
    expect(await artifactStub(studio.org.id).corruptPendingOutboxForTest()).toBe(true);
    await scheduler.wait(2_000);
    expect(await artifactStub(studio.org.id).outboxStateForTest()).toContainEqual(
      expect.objectContaining({
        status: "failed",
        attempts: 1,
        failureReason: "INVALID_EVENT",
      }),
    );
    const events = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.version.created'`,
    )
      .bind(studio.org.id)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);
  });
});
