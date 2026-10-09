import { sha256Hex } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveHttpPrincipal } from "../src/http-principal";
import { artifactStub, createStudio, hire, organizationStub } from "./helpers";

describe("human session authority boundary", () => {
  it("resolves only the authenticated human, hashes secrets, and revokes sessions", async () => {
    const { org } = await createStudio("Human sessions");
    const stub = organizationStub(org.id);
    const actor = { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
    const issued = await stub.issueHumanSession({ ...actor, ttlSeconds: 600 });
    expect(issued.decision).toBe("ALLOW");
    const token = issued.token ?? "";
    expect(token).toMatch(/^hum_[0-9a-f]{64}$/);
    const row = await env.DB.prepare("SELECT token_hash FROM human_sessions WHERE id = ?")
      .bind(issued.sessionId)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    expect(row?.token_hash).not.toBe(token);
    expect(
      await resolveHttpPrincipal(env, org.id, `Bearer ${token}`, "usr_forged", "artifact.approve"),
    ).toMatchObject({ decision: "ALLOW", actorType: "human", actorId: org.createdByUserId });
    const other = await createStudio("Other human org");
    expect(
      await resolveHttpPrincipal(
        env,
        other.org.id,
        `Bearer ${token}`,
        undefined,
        "artifact.approve",
      ),
    ).toMatchObject({ decision: "DENY", actorId: null });
    await stub.revokeHumanSession({ ...actor, sessionId: issued.sessionId ?? "" });
    expect(await stub.verifyHumanSession({ orgId: org.id, token })).toMatchObject({
      decision: "DENY",
    });
  });

  it("authenticates HTTP human approvals instead of trusting actor identity headers", async () => {
    const { org, store } = await createStudio("Human HTTP");
    const worker = await hire(store, org.id, "Worker");
    const role = await store.getRoleByCode(org.id, "employee");
    const owner = { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
    await organizationStub(org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: role?.id ?? "",
    });
    const room = await store.createRoom(org.id, { name: "Human approval", departmentId: null });
    await store.addRoomMember(org.id, room.id, worker.id);
    const artifact = await artifactStub(org.id).put({
      orgId: org.id,
      actorType: "employee",
      actorId: worker.id,
      idempotencyKey: "human_http_artifact",
      roomId: room.id,
      taskId: null,
      artifactId: null,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("Review me"),
    });
    expect(artifact.decision).toBe("ALLOW");
    const url = `https://company.local/orgs/${org.id}/artifacts/${artifact.artifactId}/approvals`;
    const forgedHeaders = {
      "content-type": "application/json",
      "x-idempotency-key": "human_http_approval",
      "x-actor-type": "human",
      "x-actor-id": org.createdByUserId,
    };
    const forged = await exports.default.fetch(url, {
      method: "POST",
      headers: forgedHeaders,
      body: JSON.stringify({ version: 1 }),
    });
    expect(forged.status).toBe(401);
    const issued = await organizationStub(org.id).issueHumanSession({ ...owner, ttlSeconds: 600 });
    const authenticated = await exports.default.fetch(url, {
      method: "POST",
      headers: {
        ...forgedHeaders,
        authorization: `Bearer ${issued.token}`,
        "x-actor-id": "usr_" + "0".repeat(32),
      },
      body: JSON.stringify({ version: 1 }),
    });
    expect(authenticated.status).toBe(201);
    const approval = await env.DB.prepare(
      "SELECT actor_id FROM approvals WHERE org_id = ? AND artifact_id = ? AND kind = 'final'",
    )
      .bind(org.id, artifact.artifactId)
      .first<{ actor_id: string }>();
    expect(approval?.actor_id).toBe(org.createdByUserId);
  });

  it("rejects identity headers without a token and expired sessions", async () => {
    const { org } = await createStudio("Human expired");
    expect(
      await resolveHttpPrincipal(env, org.id, undefined, org.createdByUserId, "artifact.approve"),
    ).toMatchObject({ decision: "DENY", actorId: null });
    const issued = await organizationStub(org.id).issueHumanSession({
      orgId: org.id,
      actorType: "human",
      actorId: org.createdByUserId,
      ttlSeconds: 600,
    });
    await env.DB.prepare("UPDATE human_sessions SET expires_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", issued.sessionId)
      .run();
    expect(
      await organizationStub(org.id).verifyHumanSession({
        orgId: org.id,
        token: issued.token ?? "",
      }),
    ).toMatchObject({ decision: "DENY" });
  });
});
