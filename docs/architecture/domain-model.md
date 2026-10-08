# Domain model

## Identity

```text
Human user
  creates Organization
    owns Employees
      optionally bound to RuntimeBinding
    owns Departments
    owns Roles
      granted Permissions from the global catalog
    owns Rooms
      with RoomMembership
```

An employee is not a runtime. `employees` has no provider password, cookie, or account id. `runtime_bindings.external_ref` is an operator label. Credential-shaped values are rejected. At most one binding per employee may be `active`. Revoking a binding leaves the employee row in place.

Ids are opaque: `org_`, `usr_`, `emp_`, `rb_`, `dept_`, `role_`, `room_`, `rmem_`, `blk_`, `ovr_`, `evt_`, `corr_`, `join_`, `ses_`, `inb_`, `task_`, `art_`, `rev_`, `apr_`, `wfr_` plus 128 bits. They are not sequential. The monotonic room sequence lives in RoomDO SQLite. D1 `room_sequences` stores the head for queries. Join-code hashes live in OrganizationDO. Session token hashes and inbox rows live in AgentDO. Task transitions live in TaskDO. Artifact versions, reviews, and approvals live in ArtifactDO. Correlation ids live on the event envelope.

## Tenancy

Tenant-owned tables include `org_id`. Reads and writes in `FoundationStore` predicate on `org_id` and the entity id. A miss in the caller's organization is `NOT_FOUND`.

`human_users` and `permissions` are global. A human can create an organization. Permission codes are a system catalog, not per-tenant rows.

SQLite triggers abort an insert when a parent row belongs to a different organization. The store also checks the parent before writing.

## Roles

Creating an organization seeds `owner`, `executive`, `manager`, `employee`, `qa`, `security`, and `auditor` from `packages/policy`. System role rows reject further permission edits so the template cannot be widened by a store call. Custom roles can receive catalog permissions. OrganizationDO is the live authority: it denies a suspended employee, self-approval, a covered security block, and an `employee`/`security` assignment or any non-owner pair that both changes an artifact and approves security. `FoundationStore.assignEmployeeRole()` does not apply that conflict check.

## Projections

Reviews and approvals are projected to D1. A review result is `PASS`, `FAIL`, or `REVISION_REQUIRED`. A final or security approval is `PASS` or `DENY`. Workflow runs are projected to `workflow_runs` and queried by `org_id` and id. Identity columns on a run stay fixed. Status, stage, and iteration may advance. Artifacts and artifact versions are projected to D1. The bytes live in R2 under an immutable version key. Tasks, task dependencies, domain events, audit rows, and dead letters are projected to D1. TaskDO remains the transition authority. ArtifactDO remains the version authority and the review authority. OrganizationDO remains the security-block authority. Audit, domain, review, and approval rows are insert-only. Join codes and runtime sessions are projected to D1. Those tables store hashes. They have no plaintext code or token column. Security blocks, overrides, and the organization policy version are stored by OrganizationDO and projected to D1.
