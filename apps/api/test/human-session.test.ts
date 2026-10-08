import { sha256Hex } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveHttpPrincipal } from "../src/http-principal";
import { createStudio, organizationStub } from "./helpers";

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
