import { describe, expect, it } from "vitest";
import { artifactObjectKey, canonicalMediaType, createId, isArtifactFilename } from "../src/index";

describe("artifact identity", () => {
  it("builds a tenant key and does not use the filename", () => {
    const orgId = createId("org");
    const roomId = createId("room");
    const artifactId = createId("art");
    const key = artifactObjectKey(orgId, roomId, artifactId, 2);
    expect(key).toBe(`org/${orgId}/project/${roomId}/artifact/${artifactId}/v2`);
    expect(key).not.toContain("shot17.mp4");
    expect(canonicalMediaType("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(canonicalMediaType("text/html")).toBeNull();
    expect(isArtifactFilename("shot17.mp4")).toBe(true);
    expect(isArtifactFilename("../shot17.mp4")).toBe(false);
    expect(isArtifactFilename("a/b")).toBe(false);
    expect(isArtifactFilename("a\\b")).toBe(false);
  });
});
