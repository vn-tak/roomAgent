import { describe, expect, it } from "vitest";
import { DomainError, assertExternalRef, assertName, assertRoleCode } from "../src/index";

describe("validation", () => {
  it("accepts a unicode display name", () => {
    expect(assertName("  Phòng sản xuất  ")).toBe("Phòng sản xuất");
  });

  it("rejects control characters in names", () => {
    expect(() => assertName("bad\nname")).toThrow(DomainError);
  });

  it("rejects credential-shaped runtime labels", () => {
    expect(() => assertExternalRef("Bearer abc")).toThrow(DomainError);
    expect(() => assertExternalRef("aaaa.bbbb.cccc")).toThrow(DomainError);
    expect(assertExternalRef("muse-runtime-17")).toBe("muse-runtime-17");
    expect(assertExternalRef(null)).toBeNull();
  });

  it("rejects role codes that are not stable identifiers", () => {
    expect(assertRoleCode("story_artist")).toBe("story_artist");
    expect(() => assertRoleCode("Manager")).toThrow(DomainError);
  });
});
