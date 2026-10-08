export const MAX_ARTIFACT_BYTES = 1_048_576;
export const MAX_ARTIFACT_BASE64 = 1_400_000;

const MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "video/mp4",
] as const;

const MEDIA = new Set<string>(MEDIA_TYPES);

export function canonicalMediaType(value: string): string | null {
  const base = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!MEDIA.has(base)) {
    return null;
  }
  return base;
}

export function isArtifactFilename(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,80}$/.test(value) && !value.includes("..");
}

export function artifactObjectKey(
  orgId: string,
  roomId: string,
  artifactId: string,
  version: number,
): string {
  return `org/${orgId}/project/${roomId}/artifact/${artifactId}/v${version}`;
}
