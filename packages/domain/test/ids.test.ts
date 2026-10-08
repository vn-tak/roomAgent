import { describe, expect, it } from "vitest";
import { createId, isId, randomSecret, sha256Hex } from "../src/index";

describe("createId", () => {
  it("issues opaque prefixed ids", () => {
    const id = createId("org");
    expect(isId(id, "org")).toBe(true);
    expect(isId(id, "emp")).toBe(false);
    expect(Number.isNaN(Number(id))).toBe(true);
  });

  it("hashes a secret without keeping the plaintext", async () => {
    const secret = randomSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const hash = await sha256Hex("abc");
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(secret)).not.toBe(secret);
  });

  it("does not issue sequential ids", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      ids.add(createId("emp"));
    }
    expect(ids.size).toBe(200);
  });
});
