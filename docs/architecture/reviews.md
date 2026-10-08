# Reviews and approvals

Phase 8 stores a review or an approval as a record about an existing artifact version. ArtifactDO is the record authority. OrganizationDO remains the permission and security-block authority. The bytes stay in R2. The canonical pointer stays on the artifact. A review does not transition a task.

## Results

A review result is exactly one of `PASS`, `FAIL`, or `REVISION_REQUIRED`. That `PASS` is a review opinion. It requires `artifact.review`. It does not write an approval row.

A final approval requires `artifact.approve` through the action `artifact.final_approve`. The only successful final result is `PASS`. `FAIL` and `REVISION_REQUIRED` belong on the review record. QA has `artifact.review` and does not have `artifact.approve`.

A security approval requires `security.approve`. It is stored with kind `security`. It is not a final artifact approval. The implementation actor is the stored artifact creator. That actor cannot security-approve the artifact.

## Creator rule

`authorize()` receives the creator id stored on the artifact. The caller cannot supply a different creator. When the actor is that creator and holds `artifact.approve`, the result is `NO_SELF_APPROVAL`. ArtifactDO stores an approval with decision `DENY` and reason `NO_SELF_APPROVAL`. The same idempotency key replays that denial. No artifact version, canonical pointer, or task state changes.

## Checks

The order is the stored version, then `authorize()`, then room membership for an employee review or final grant. A security employee without `artifact.review` receives `NO_PERMISSION` before the membership check. An active security block denies review, final approval, and security approval. A read still bypasses the block. The owner human does not need room membership. A security approval does not require room membership.

A missing artifact or version is `TENANT_BOUNDARY`. The same actor and key with a different artifact, version, or result is `IDEMPOTENCY_MISMATCH`.

## Records

D1 `reviews` and `approvals` are insert-only, and so are `audit_events` and `domain_events`. There is no HTTP method that deletes them. Rows carry no review comment, filename, or bytes.

Events `review.recorded`, `approval.granted`, and `approval.denied` go out on the existing domain-events queue after the D1 row commits. They do not fan out to an agent. `artifact.approved` is rejected by the event parser.

## HTTP

An agent session calls:

| Method | Path                                                    | Scope              |
| ------ | ------------------------------------------------------- | ------------------ |
| POST   | `/orgs/:orgId/artifacts/:artifactId/reviews`            | `artifact.review`  |
| POST   | `/orgs/:orgId/artifacts/:artifactId/approvals`          | `artifact.approve` |
| POST   | `/orgs/:orgId/artifacts/:artifactId/security-approvals` | `security.approve` |

The review body is `{ "version", "result" }`. The approval bodies are `{ "version" }`. An extra field is rejected. A missing token is 401. The wrong scope is 403. Creator final approval is 403 `NO_SELF_APPROVAL`. Owner humans still use trusted Durable Object RPC.
