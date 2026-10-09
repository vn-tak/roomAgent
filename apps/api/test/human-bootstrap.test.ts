import { createId } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveHttpPrincipal } from "../src/http-principal";
import { createStudio } from "./helpers";

const TEAM = "https://roomagent-test.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = "test-key-1";

let signer: CryptoKey;
let forger: CryptoKey;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function accessToken(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson(options.header ?? { alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encodeJson({
    iss: TEAM,
    aud: [AUD],
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    type: "app",
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signer,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function generate(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

beforeAll(async () => {
  const pair = await generate();
  signer = pair.privateKey;
  forger = (await generate()).privateKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const realFetch = globalThis.fetch;
  // Serve the Access certs endpoint for the test team; nothing leaves the sandbox.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });
    }
    return realFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function mapIdentity(
  userId: string,
  email: string,
  status: "active" | "disabled" = "active",
): Promise<string> {
  const id = createId("usr").replace("usr_", "hid_");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO human_identities (id, issuer, email, subject, user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(id, TEAM, email, userId, status, now, now)
    .run();
  return id;
}

async function bootstrap(orgId: string, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(`https://company.local/orgs/${orgId}/human-sessions`, {
    method: "POST",
    headers,
  });
}

describe("human operator bootstrap through Cloudflare Access", () => {
  it("issues a short-lived, tenant-bound, audited session for a verified owner", async () => {
    const { org } = await createStudio("Access owner");
    const identityId = await mapIdentity(org.createdByUserId, "owner@roomagent.test");
    const response = await bootstrap(org.id, {
      "cf-access-jwt-assertion": await accessToken({
        email: "Owner@RoomAgent.test",
        sub: "access-sub-owner",
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<{ token: string; session_id: string; expires_at: string }>();
    expect(body.token).toMatch(/^hum_[0-9a-f]{64}$/);
    const ttl = Date.parse(body.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900_000);

    expect(
      await resolveHttpPrincipal(env, org.id, `Bearer ${body.token}`, undefined, "task.assign"),
    ).toMatchObject({ decision: "ALLOW", actorType: "human", actorId: org.createdByUserId });
    const other = await createStudio("Access other org");
    expect(
      await resolveHttpPrincipal(
        env,
        other.org.id,
        `Bearer ${body.token}`,
        undefined,
        "task.assign",
      ),
    ).toMatchObject({ decision: "DENY" });

    const stored = await env.DB.prepare(
      `SELECT identity_id, token_hash FROM human_sessions WHERE id = ?`,
    )
      .bind(body.session_id)
      .first<{ identity_id: string; token_hash: string }>();
    expect(stored?.identity_id).toBe(identityId);
    expect(stored?.token_hash).not.toBe(body.token);
    const pinned = await env.DB.prepare(`SELECT subject FROM human_identities WHERE id = ?`)
      .bind(identityId)
      .first<{ subject: string }>();
    expect(pinned?.subject).toBe("access-sub-owner");
    const audit = await env.DB.prepare(
      `SELECT action, method FROM human_session_audit WHERE session_id = ?`,
    )
      .bind(body.session_id)
      .all<{ action: string; method: string }>();
    expect(audit.results).toEqual([{ action: "issued", method: "cloudflare_access" }]);

    // A reassigned email with a different Access subject cannot inherit the mapping.
    const reassigned = await bootstrap(org.id, {
      "cf-access-jwt-assertion": await accessToken({
        email: "owner@roomagent.test",
        sub: "access-sub-someone-else",
      }),
    });
    expect(reassigned.status).toBe(403);
  });

  it("denies untrusted, forged, wrong-audience, wrong-issuer, and expired identities", async () => {
    const { org } = await createStudio("Access forged");
    await mapIdentity(org.createdByUserId, "forged@roomagent.test");
    const claims = { email: "forged@roomagent.test", sub: "access-sub-forged" };
    const now = Math.floor(Date.now() / 1000);

    const unauthenticated = await bootstrap(org.id, {
      "cf-access-authenticated-user-email": "forged@roomagent.test",
      "x-actor-id": org.createdByUserId,
    });
    expect(unauthenticated.status).toBe(401);

    const attempts = [
      await accessToken(claims, { key: forger }),
      await accessToken({ ...claims, aud: ["b".repeat(64)] }),
      await accessToken({ ...claims, iss: "https://attacker.cloudflareaccess.com" }),
      await accessToken({ ...claims, exp: now - 1 }),
      await accessToken({ ...claims, nbf: now + 3600 }),
      await accessToken({ ...claims, type: "service" }),
      await accessToken(claims, { header: { alg: "none", kid: KID } }),
      (await accessToken(claims)).replace(
        /\.[^.]+\./,
        `.${encodeJson({ ...claims, iss: TEAM, aud: [AUD], exp: now + 300 })}.`,
      ),
      "not-a-jwt",
    ];
    for (const assertion of attempts) {
      const response = await bootstrap(org.id, { "cf-access-jwt-assertion": assertion });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("hum_");
    }
    const issued = await env.DB.prepare(`SELECT COUNT(*) AS n FROM human_sessions WHERE org_id = ?`)
      .bind(org.id)
      .first<{ n: number }>();
    expect(issued?.n).toBe(0);
  });

  it("denies a verified identity for an organization it does not own, or that is unmapped", async () => {
    const owned = await createStudio("Access home org");
    const foreign = await createStudio("Access foreign org");
    await mapIdentity(owned.org.createdByUserId, "home@roomagent.test");
    const assertion = await accessToken({ email: "home@roomagent.test", sub: "access-sub-home" });

    const wrongOrg = await bootstrap(foreign.org.id, { "cf-access-jwt-assertion": assertion });
    expect(wrongOrg.status).toBe(403);
    const unmapped = await bootstrap(owned.org.id, {
      "cf-access-jwt-assertion": await accessToken({
        email: "stranger@roomagent.test",
        sub: "access-sub-stranger",
      }),
    });
    expect(unmapped.status).toBe(403);
    expect((await unmapped.json<{ error: { code: string } }>()).error.code).toBe(
      "IDENTITY_NOT_MAPPED",
    );
  });

  it("revokes a session and denies disabled identities, including their live sessions", async () => {
    const { org } = await createStudio("Access revoke");
    const identityId = await mapIdentity(org.createdByUserId, "revoke@roomagent.test");
    const assertion = await accessToken({ email: "revoke@roomagent.test", sub: "access-sub-rv" });
    const first = await (
      await bootstrap(org.id, { "cf-access-jwt-assertion": assertion })
    ).json<{ token: string; session_id: string }>();

    const revoked = await exports.default.fetch(
      `https://company.local/orgs/${org.id}/human-sessions/current`,
      { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } },
    );
    expect(revoked.status).toBe(200);
    expect(
      await resolveHttpPrincipal(env, org.id, `Bearer ${first.token}`, undefined, "task.assign"),
    ).toMatchObject({ decision: "DENY" });
    const replayRevoke = await exports.default.fetch(
      `https://company.local/orgs/${org.id}/human-sessions/current`,
      { method: "DELETE", headers: { authorization: `Bearer ${first.token}` } },
    );
    expect(replayRevoke.status).toBe(401);
    const audit = await env.DB.prepare(
      `SELECT action FROM human_session_audit WHERE session_id = ? ORDER BY action`,
    )
      .bind(first.session_id)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(["issued", "revoked"]);

    const second = await (
      await bootstrap(org.id, { "cf-access-jwt-assertion": assertion })
    ).json<{ token: string }>();
    await env.DB.prepare(`UPDATE human_identities SET status = 'disabled' WHERE id = ?`)
      .bind(identityId)
      .run();
    expect(
      await resolveHttpPrincipal(env, org.id, `Bearer ${second.token}`, undefined, "task.assign"),
    ).toMatchObject({ decision: "DENY" });
    const disabled = await bootstrap(org.id, { "cf-access-jwt-assertion": assertion });
    expect(disabled.status).toBe(403);
    expect((await disabled.json<{ error: { code: string } }>()).error.code).toBe(
      "IDENTITY_DISABLED",
    );
  });
});
