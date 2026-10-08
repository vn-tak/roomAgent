# Artifacts

Phase 7 stores immutable artifact bytes in R2 and metadata in D1. ArtifactDO is the version authority. OrganizationDO remains the permission authority. The API Worker authenticates an agent session, checks the request shape, and calls ArtifactDO.

The local binding is `ARTIFACTS`. The bucket name is `ai-company-os-artifacts`. That bucket is not created on the live account. `wrangler dev` and the Workers test runner simulate R2. There is no presigned upload. The authenticated Worker is the upload path until a human session exists.

## Identity

One ArtifactDO is named `artifacts:{org_id}`. Object keys are:

```text
org/{org_id}/project/{room_id}/artifact/{artifact_id}/v{version}
```

The `project` segment is the room id until a project entity exists. The caller filename is a D1 label. It is never part of the key. `shot17.mp4` stays `shot17.mp4` in `artifact_versions.filename` and becomes `.../v1`, `.../v2` in R2.

`artifact_id` is an `art_` id. Version numbers start at 1. The canonical version is `artifacts.canonical_version`, a pointer. Version rows reject update and delete with `ARTIFACT_IMMUTABLE`.

## Upload

`put` uses `onlyIf: { etagDoesNotMatch: "*" }`. A new key is written once. If that key already holds the same SHA-256, a retry adopts it. If it holds different bytes, the command returns `ARTIFACT_EXISTS` and the canonical pointer stays put. A failed D1 projection leaves the object in place and leaves the command pending so the same key can be adopted. A new idempotency key allocates the next version.

The body is at most 1 MiB and cannot be empty. The SHA-256 is computed in ArtifactDO. An optional caller checksum must match or the command returns `CHECKSUM_MISMATCH` before any row or object is created. Media types are `text/plain`, `text/markdown`, `application/json`, `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `audio/mpeg`, and `video/mp4`. Parameters such as `charset` are stripped.

Every read hashes the stored object again. A missing object or a different hash returns `INTEGRITY`, with no replacement bytes. The D1 hash stays the original.

## Authority

`artifact.create` opens version 1. `artifact.modify` adds a later version. The stored creator, or the organization owner human, may add that version. Another employee with `artifact.modify` receives `NOT_CREATOR`. A security employee receives `NO_PERMISSION`. An employee must be an active member of the artifact's room. The owner human does not need a membership. A missing room, a foreign room, or a foreign task is `TENANT_BOUNDARY`.

`authorize()` receives the creator id from the artifact row. Create and modify do not approve the artifact. `artifact.submit` on the room socket stays `NOT_AVAILABLE`.

An optional `task_id` must already exist in the organization. Saving an artifact does not change the task state.

## HTTP

Agent routes require `Authorization: Bearer` with the 64-hex session token and `x-employee-id`. The header is not authority by itself. `AgentDO.verify` checks the token and the scope, then ArtifactDO calls `authorize()`.

| Route                                              | Scope             | Result                                  |
| -------------------------------------------------- | ----------------- | --------------------------------------- |
| `POST /orgs/:orgId/rooms/:roomId/artifacts`        | `artifact.create` | Creates version 1                       |
| `POST /orgs/:orgId/artifacts/:artifactId/versions` | `artifact.modify` | Adds a version                          |
| `GET /orgs/:orgId/artifacts/:artifactId`           | `artifact.read`   | Returns canonical bytes, or `?version=` |

A successful upload returns `artifact_id`, `version`, `canonical_version`, `r2_key`, `sha256`, and `duplicate`. A successful read returns the raw bytes with `content-type`, `x-artifact-id`, `x-artifact-version`, and `x-checksum-sha256`. Logs do not record the body, the token, or the checksum header value beyond the structured error code.

Direct Durable Object RPC remains a trusted path, as it does for tasks. Human upload stays on that path until a human session exists.

## Event

After the D1 rows commit, ArtifactDO publishes `artifact.version.created` on the existing domain-events queue. The payload is the version, hash, media type, size, and key. It does not contain bytes, the filename, or a task objective. The consumer writes one domain row and one audit row. It does not enqueue an agent.
