import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createStudio, hire, organizationStub } from "./helpers";

describe("join remediation", () => {
  it("isolates failed redemptions by employee in one organization", async () => {
    const { org, store } = await createStudio("Join isolation");
    const a = await hire(store, org.id, "A");
    const b = await hire(store, org.id, "B");
    const stub = organizationStub(org.id);
    for (let n = 0; n < 5; n++) {
      expect(
        await stub.consumeJoinCode({ orgId: org.id, employeeId: a.id, code: "0".repeat(64) }),
      ).toMatchObject({ decision: "DENY", reason: "INVALID_CODE" });
    }
    expect(
      await stub.consumeJoinCode({ orgId: org.id, employeeId: a.id, code: "0".repeat(64) }),
    ).toMatchObject({ reason: "THROTTLED" });
    const issued = await stub.issueJoinCode({
      orgId: org.id,
      actorType: "human",
      actorId: org.createdByUserId,
      employeeId: b.id,
      scopes: ["room.read"],
      ttlSeconds: 600,
    });
    expect(
      await stub.consumeJoinCode({ orgId: org.id, employeeId: b.id, code: issued.code ?? "" }),
    ).toMatchObject({ decision: "ALLOW" });
  });

  it("resolves an opaque one-time join URL without client org or employee ids", async () => {
    const { org, store } = await createStudio("Opaque join");
    const worker = await hire(store, org.id, "Worker");
    const issued = await organizationStub(org.id).issueJoinCode({
      orgId: org.id,
      actorType: "human",
      actorId: org.createdByUserId,
      employeeId: worker.id,
      scopes: ["room.read"],
      ttlSeconds: 600,
    });
    expect(issued.joinToken).toBe(issued.code);
    const url = `https://company.local${issued.joinPath}`;
    const first = await exports.default.fetch(url, { method: "POST" });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toMatchObject({ token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const duplicate = await exports.default.fetch(url, { method: "POST" });
    expect(duplicate.status).toBe(403);
    expect(await duplicate.json()).toMatchObject({ error: { code: "ALREADY_USED" } });
  });
});
