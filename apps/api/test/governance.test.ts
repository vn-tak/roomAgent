import type { ArtifactFinalize, ArtifactReview, GovernanceResult } from "@ai-company/artifact";
import type { FoundationStore } from "@ai-company/db";
import { parseDomainEvent, type Organization, type Role } from "@ai-company/domain";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  artifactStub,
  createStudio,
  hire,
  openBrowserSession,
  organizationStub,
  storedPolicyVersion,
  taskStub,
} from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

function employeeActor(orgId: string, employeeId: string) {
  return { orgId, actorType: "employee" as const, actorId: employeeId };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

async function review(command: ArtifactReview): Promise<GovernanceResult> {
  return artifactStub(command.orgId).review(command);
}

async function finalize(command: ArtifactFinalize): Promise<GovernanceResult> {
  return artifactStub(command.orgId).finalize(command);
}

async function securityApprove(command: ArtifactFinalize): Promise<GovernanceResult> {
  return artifactStub(command.orgId).securityApprove(command);
}

async function pump(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await scheduler.wait(1);
  }
}

async function until(assertion: () => Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      await pump();
      await assertion();
    },
    { timeout: 8_000, interval: 20 },
  );
}

async function count(orgId: string, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectAbort(sql: string, orgId: string, marker: string): Promise<void> {
  let failed = false;
  try {
    await env.DB.prepare(sql).bind(orgId).run();
  } catch (error) {
    failed = true;
    expect(error instanceof Error ? error.message : String(error)).toContain(marker);
  }
  expect(failed).toBe(true);
}

describe("governance records", () => {
  it("stores review results and refuses a creator final approval", async () => {
    const studio = await createStudio("Governance");
    const other = await createStudio("Governance other");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const qa = await hire(studio.store, studio.org.id, "QA");
    const security = await hire(studio.store, studio.org.id, "Security");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const approver = await studio.store.createRole(studio.org.id, {
      code: "artifact_approver",
      name: "Artifact approver",
    });
    for (const permission of [
      "room.read",
      "artifact.read",
      "artifact.create",
      "artifact.modify",
      "artifact.approve",
    ]) {
      await studio.store.assignPermission(studio.org.id, approver.id, permission);
    }
    const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const org = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: approver.id });
    await org.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole.id });
    await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    await org.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    await studio.store.addRoomMember(studio.org.id, room.id, qa.id);
    const task = await taskStub(studio.org.id).execute({
      orgId: studio.org.id,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      idempotencyKey: "gov_task_0001",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Storyboard scene 17",
      objective: "Revise the scene.",
      roomId: room.id,
      dependsOn: [],
    });
    expect(task.decision).toBe("ALLOW");
    const created = await artifactStub(studio.org.id).put({
      ...employeeActor(studio.org.id, worker.id),
      idempotencyKey: "gov_artifact_1",
      roomId: room.id,
      artifactId: null,
      taskId: task.taskId,
      mediaType: "text/plain",
      filename: "shot17.mp4",
      checksum: null,
      bodyBase64: btoa("approve this"),
    });
    expect(created.decision).toBe("ALLOW");
    const artifactId = created.artifactId ?? "";
    const owned = await artifactStub(studio.org.id).put({
      ...owner,
      idempotencyKey: "gov_owner_art1",
      roomId: room.id,
      artifactId: null,
      taskId: null,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("owner bytes"),
    });
    expect(owned.decision).toBe("ALLOW");
    const ownerArtifactId = owned.artifactId ?? "";
    const policyBefore = await storedPolicyVersion(studio.org.id);
    const qaActor = employeeActor(studio.org.id, qa.id);
    const workerActor = employeeActor(studio.org.id, worker.id);
    const securityActor = employeeActor(studio.org.id, security.id);

    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_bad_0001",
        artifactId,
        version: 1,
        result: "approve this",
      }),
    ).toMatchObject({ decision: "DENY", reason: "INVALID_INPUT", recordId: null });
    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_missing_1",
        artifactId,
        version: 9,
        result: "FAIL",
      }),
    ).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY" });
    expect(
      await review({
        ...securityActor,
        idempotencyKey: "security_review_1",
        artifactId,
        version: 1,
        result: "FAIL",
      }),
    ).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION", recordId: null });
    expect(
      await finalize({
        ...securityActor,
        idempotencyKey: "security_final_01",
        artifactId,
        version: 1,
      }),
    ).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
    expect(
      await finalize({
        ...qaActor,
        idempotencyKey: "qa_final_00001",
        artifactId,
        version: 1,
      }),
    ).toMatchObject({ decision: "DENY", reason: "NO_PERMISSION" });
    expect(
      await review({
        ...employeeActor(studio.org.id, manager.id),
        idempotencyKey: "manager_review_1",
        artifactId,
        version: 1,
        result: "FAIL",
      }),
    ).toMatchObject({ decision: "DENY", reason: "NOT_MEMBER" });
    expect(
      await artifactStub(other.org.id).review({
        orgId: other.org.id,
        actorType: "human",
        actorId: other.org.createdByUserId,
        idempotencyKey: "review_cross_001",
        artifactId,
        version: 1,
        result: "FAIL",
      }),
    ).toMatchObject({ decision: "DENY", reason: "TENANT_BOUNDARY", recordId: null });

    const denied = await finalize({
      ...workerActor,
      idempotencyKey: "self_approve_1",
      artifactId,
      version: 1,
    });
    expect(denied).toMatchObject({
      decision: "DENY",
      reason: "NO_SELF_APPROVAL",
      artifactId,
      version: 1,
      result: "PASS",
      duplicate: false,
    });
    expect(denied.recordId?.startsWith("apr_")).toBe(true);
    const replayed = await finalize({
      ...workerActor,
      idempotencyKey: "self_approve_1",
      artifactId,
      version: 1,
    });
    expect(replayed).toMatchObject({
      decision: "DENY",
      reason: "NO_SELF_APPROVAL",
      recordId: denied.recordId,
      duplicate: true,
    });
    expect(
      await finalize({
        ...workerActor,
        idempotencyKey: "self_approve_1",
        artifactId: ownerArtifactId,
        version: 1,
      }),
    ).toMatchObject({ decision: "DENY", reason: "IDEMPOTENCY_MISMATCH" });
    expect(await count(studio.org.id, `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ?`)).toBe(
      1,
    );

    const armed = await artifactStub(studio.org.id).armPublishFault(1);
    expect(armed.armed).toBe(true);
    const failed = await review({
      ...qaActor,
      idempotencyKey: "review_fail_001",
      artifactId,
      version: 1,
      result: "FAIL",
    });
    expect(failed).toMatchObject({
      decision: "ALLOW",
      result: "FAIL",
      duplicate: false,
    });
    await pump();
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'review.recorded'`,
      ),
    ).toBe(0);
    const failedAgain = await review({
      ...qaActor,
      idempotencyKey: "review_fail_001",
      artifactId,
      version: 1,
      result: "FAIL",
    });
    expect(failedAgain).toMatchObject({ recordId: failed.recordId, duplicate: true });
    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_fail_001",
        artifactId,
        version: 1,
        result: "PASS",
      }),
    ).toMatchObject({ decision: "DENY", reason: "IDEMPOTENCY_MISMATCH" });
    await until(async () => {
      expect(
        await count(
          studio.org.id,
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'review.recorded'`,
        ),
      ).toBe(1);
    });
    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_revision1",
        artifactId,
        version: 1,
        result: "REVISION_REQUIRED",
      }),
    ).toMatchObject({ decision: "ALLOW", result: "REVISION_REQUIRED" });
    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_pass_001",
        artifactId,
        version: 1,
        result: "PASS",
      }),
    ).toMatchObject({ decision: "ALLOW", result: "PASS" });
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'final' AND decision = 'PASS'`,
      ),
    ).toBe(0);

    const granted = await finalize({
      ...owner,
      idempotencyKey: "owner_approve_1",
      artifactId,
      version: 1,
    });
    expect(granted).toMatchObject({
      decision: "ALLOW",
      reason: "ALLOWED",
      result: "PASS",
      duplicate: false,
    });
    expect(granted.recordId?.startsWith("apr_")).toBe(true);
    const securityGrant = await securityApprove({
      ...securityActor,
      idempotencyKey: "security_grant_1",
      artifactId,
      version: 1,
    });
    expect(securityGrant).toMatchObject({ decision: "ALLOW", result: "PASS" });
    const ownerDenied = await securityApprove({
      ...owner,
      idempotencyKey: "owner_security_1",
      artifactId: ownerArtifactId,
      version: 1,
    });
    expect(ownerDenied).toMatchObject({
      decision: "DENY",
      reason: "NO_SELF_APPROVAL",
      duplicate: false,
    });
    const securityOnOwner = await securityApprove({
      ...securityActor,
      idempotencyKey: "security_owner_01",
      artifactId: ownerArtifactId,
      version: 1,
    });
    expect(securityOnOwner).toMatchObject({ decision: "ALLOW", result: "PASS" });

    await until(async () => {
      expect(
        await count(
          studio.org.id,
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'approval.granted'`,
        ),
      ).toBe(3);
      expect(
        await count(
          studio.org.id,
          `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'approval.denied'`,
        ),
      ).toBe(2);
    });
    expect(await storedPolicyVersion(studio.org.id)).toBe(policyBefore);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'final' AND decision = 'PASS'`,
      ),
    ).toBe(1);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'security' AND decision = 'PASS'`,
      ),
    ).toBe(2);
    const denial = await env.DB.prepare(
      `SELECT decision, reason, kind FROM approvals WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, denied.recordId)
      .first<{ decision: string; reason: string; kind: string }>();
    expect(denial).toEqual({ decision: "DENY", reason: "NO_SELF_APPROVAL", kind: "final" });
    const reviewRows = await env.DB.prepare(
      `SELECT result FROM reviews WHERE org_id = ? AND artifact_id = ? ORDER BY created_at ASC`,
    )
      .bind(studio.org.id, artifactId)
      .all<{ result: string }>();
    expect(reviewRows.results.map((row) => row.result)).toEqual([
      "FAIL",
      "REVISION_REQUIRED",
      "PASS",
    ]);

    const blocked = await org.createSecurityBlock({
      ...owner,
      resourceType: "artifact",
      resourceId: artifactId,
      severity: "high",
      reason: "Hold the artifact",
    });
    expect(blocked.decision).toBe("ALLOW");
    const reviewCount = await count(
      studio.org.id,
      `SELECT COUNT(*) AS n FROM reviews WHERE org_id = ?`,
    );
    expect(
      await review({
        ...qaActor,
        idempotencyKey: "review_blocked_1",
        artifactId,
        version: 1,
        result: "FAIL",
      }),
    ).toMatchObject({ decision: "DENY", reason: "SECURITY_BLOCK", recordId: null });
    expect(
      await securityApprove({
        ...securityActor,
        idempotencyKey: "security_block_1",
        artifactId,
        version: 1,
      }),
    ).toMatchObject({ decision: "DENY", reason: "SECURITY_BLOCK" });
    expect(await count(studio.org.id, `SELECT COUNT(*) AS n FROM reviews WHERE org_id = ?`)).toBe(
      reviewCount,
    );
    const readable = await artifactStub(studio.org.id).read({
      ...owner,
      artifactId,
      version: 1,
    });
    expect(readable.decision).toBe("ALLOW");
    expect(readable.bodyBase64 ? atob(readable.bodyBase64) : "").toBe("approve this");
    const pointer = await env.DB.prepare(
      `SELECT canonical_version, creator_id FROM artifacts WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, artifactId)
      .first<{ canonical_version: number; creator_id: string }>();
    expect(pointer).toEqual({ canonical_version: 1, creator_id: worker.id });
    const taskRow = await env.DB.prepare(`SELECT state FROM tasks WHERE org_id = ? AND id = ?`)
      .bind(studio.org.id, task.taskId)
      .first<{ state: string }>();
    expect(taskRow?.state).toBe("CREATED");
    const hash = await env.DB.prepare(
      `SELECT sha256 FROM artifact_versions WHERE org_id = ? AND artifact_id = ? AND version = 1`,
    )
      .bind(studio.org.id, artifactId)
      .first<{ sha256: string }>();
    expect(hash?.sha256).toBe(created.sha256);

    const bodies = await env.DB.prepare(`SELECT type, body FROM domain_events WHERE org_id = ?`)
      .bind(studio.org.id)
      .all<{ type: string; body: string }>();
    const kinds = new Set<string>();
    for (const row of bodies.results) {
      const parsed = parseDomainEvent(JSON.parse(row.body) as unknown);
      expect(parsed?.type).toBe(row.type);
      expect(row.body).not.toContain("shot17");
      expect(row.body).not.toContain("approve this");
      expect(row.body).not.toContain("Revise the scene");
      expect(row.body).not.toContain("objective");
      expect(row.body).not.toContain("filename");
      if (
        parsed &&
        (parsed.type === "review.recorded" ||
          parsed.type === "approval.granted" ||
          parsed.type === "approval.denied")
      ) {
        kinds.add(`${parsed.type}:${parsed.payload.kind}`);
      }
    }
    expect(kinds).toEqual(
      new Set([
        "review.recorded:review",
        "approval.granted:final",
        "approval.granted:security",
        "approval.denied:final",
        "approval.denied:security",
      ]),
    );
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'artifact.approved'`,
      ),
    ).toBe(0);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND type = 'task.approved'`,
      ),
    ).toBe(0);
    const audit = await env.DB.prepare(
      `SELECT authorization_decision, policy_version, before_digest, after_digest, correlation_id, causation_id
       FROM audit_events WHERE org_id = ? AND type = 'approval.denied' AND subject_id = ?`,
    )
      .bind(studio.org.id, artifactId)
      .first<{
        authorization_decision: string;
        policy_version: number;
        before_digest: string | null;
        after_digest: string;
        correlation_id: string;
        causation_id: string;
      }>();
    expect(audit?.authorization_decision).toBe("DENY");
    expect(audit?.policy_version).toBeGreaterThan(0);
    expect(audit?.before_digest).toBeNull();
    expect(audit?.after_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(audit?.correlation_id.startsWith("corr_")).toBe(true);
    expect(audit?.causation_id).toBe("self_approve_1");
    expect(
      await count(studio.org.id, `SELECT COUNT(*) AS n FROM dead_letters WHERE org_id = ?`),
    ).toBe(0);
    const beforeDelete = await count(
      studio.org.id,
      `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`,
    );
    await expectAbort(
      `DELETE FROM audit_events WHERE org_id = ?`,
      studio.org.id,
      "AUDIT_IMMUTABLE",
    );
    await expectAbort(
      `UPDATE audit_events SET type = 'tampered' WHERE org_id = ?`,
      studio.org.id,
      "AUDIT_IMMUTABLE",
    );
    await expectAbort(
      `DELETE FROM domain_events WHERE org_id = ?`,
      studio.org.id,
      "AUDIT_IMMUTABLE",
    );
    await expectAbort(
      `UPDATE domain_events SET type = 'tampered' WHERE org_id = ?`,
      studio.org.id,
      "AUDIT_IMMUTABLE",
    );
    await expectAbort(
      `DELETE FROM reviews WHERE org_id = ?`,
      studio.org.id,
      "GOVERNANCE_IMMUTABLE",
    );
    await expectAbort(
      `UPDATE approvals SET decision = 'PASS' WHERE org_id = ?`,
      studio.org.id,
      "GOVERNANCE_IMMUTABLE",
    );
    expect(
      await count(studio.org.id, `SELECT COUNT(*) AS n FROM audit_events WHERE org_id = ?`),
    ).toBe(beforeDelete);
  });

  it("accepts an agent review and stores a creator denial", async () => {
    const studio = await createStudio("Governance http");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const qa = await hire(studio.store, studio.org.id, "QA");
    const security = await hire(studio.store, studio.org.id, "Security");
    const approver = await studio.store.createRole(studio.org.id, {
      code: "artifact_approver",
      name: "Artifact approver",
    });
    for (const permission of [
      "room.read",
      "artifact.read",
      "artifact.create",
      "artifact.approve",
    ]) {
      await studio.store.assignPermission(studio.org.id, approver.id, permission);
    }
    const qaRole = await roleByCode(studio.store, studio.org.id, "qa");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const owner = ownerOf(studio.org);
    const org = organizationStub(studio.org.id);
    await org.assignRole({ ...owner, employeeId: worker.id, roleId: approver.id });
    await org.assignRole({ ...owner, employeeId: qa.id, roleId: qaRole.id });
    await org.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    await studio.store.addRoomMember(studio.org.id, room.id, worker.id);
    await studio.store.addRoomMember(studio.org.id, room.id, qa.id);
    const created = await artifactStub(studio.org.id).put({
      ...employeeActor(studio.org.id, worker.id),
      idempotencyKey: "http_gov_art_1",
      roomId: room.id,
      artifactId: null,
      taskId: null,
      mediaType: "text/plain",
      filename: null,
      checksum: null,
      bodyBase64: btoa("approve this"),
    });
    const artifactId = created.artifactId ?? "";
    const reviewUrl = `https://company.local/orgs/${studio.org.id}/artifacts/${artifactId}/reviews`;
    const approvalUrl = `https://company.local/orgs/${studio.org.id}/artifacts/${artifactId}/approvals`;
    const securityUrl = `https://company.local/orgs/${studio.org.id}/artifacts/${artifactId}/security-approvals`;
    const missing = await exports.default.fetch(reviewUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-employee-id": qa.id,
        "x-idempotency-key": "http_review_miss",
      },
      body: JSON.stringify({ version: 1, result: "FAIL" }),
    });
    expect(missing.status).toBe(401);
    const weakQa = await openBrowserSession(studio.org, qa.id, ["artifact.read"]);
    const scoped = await exports.default.fetch(reviewUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${weakQa.token}`,
        "content-type": "application/json",
        "x-employee-id": qa.id,
        "x-idempotency-key": "http_review_weak",
      },
      body: JSON.stringify({ version: 1, result: "FAIL" }),
    });
    expect(scoped.status).toBe(403);
    const qaSession = await openBrowserSession(studio.org, qa.id, ["artifact.review"]);
    const commented = await exports.default.fetch(reviewUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${qaSession.token}`,
        "content-type": "application/json",
        "x-employee-id": qa.id,
        "x-idempotency-key": "http_review_note",
      },
      body: JSON.stringify({ version: 1, result: "FAIL", comment: "approve this" }),
    });
    expect(commented.status).toBe(400);
    const recorded = await exports.default.fetch(reviewUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${qaSession.token}`,
        "content-type": "application/json",
        "x-employee-id": qa.id,
        "x-idempotency-key": "http_review_fail",
      },
      body: JSON.stringify({ version: 1, result: "FAIL" }),
    });
    expect(recorded.status).toBe(201);
    const recordedBody: unknown = await recorded.json();
    expect(recordedBody).toMatchObject({ artifact_id: artifactId, version: 1, result: "FAIL" });
    expect(JSON.stringify(recordedBody)).not.toContain("approve this");
    const workerSession = await openBrowserSession(studio.org, worker.id, ["artifact.approve"]);
    const selfApproval = await exports.default.fetch(approvalUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${workerSession.token}`,
        "content-type": "application/json",
        "x-employee-id": worker.id,
        "x-idempotency-key": "http_self_approve",
      },
      body: JSON.stringify({ version: 1 }),
    });
    expect(selfApproval.status).toBe(403);
    const selfBody: unknown = await selfApproval.json();
    expect(selfBody).toMatchObject({ error: { code: "NO_SELF_APPROVAL" } });
    const weakSecurity = await openBrowserSession(studio.org, security.id, ["artifact.read"]);
    const securityScoped = await exports.default.fetch(securityUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${weakSecurity.token}`,
        "content-type": "application/json",
        "x-employee-id": security.id,
        "x-idempotency-key": "http_security_wk",
      },
      body: JSON.stringify({ version: 1 }),
    });
    expect(securityScoped.status).toBe(403);
    const securitySession = await openBrowserSession(studio.org, security.id, ["security.approve"]);
    const securityDecision = await exports.default.fetch(securityUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${securitySession.token}`,
        "content-type": "application/json",
        "x-employee-id": security.id,
        "x-idempotency-key": "http_security_ok",
      },
      body: JSON.stringify({ version: 1 }),
    });
    expect(securityDecision.status).toBe(201);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'final' AND decision = 'PASS'`,
      ),
    ).toBe(0);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'final' AND decision = 'DENY'`,
      ),
    ).toBe(1);
    expect(
      await count(
        studio.org.id,
        `SELECT COUNT(*) AS n FROM approvals WHERE org_id = ? AND kind = 'security' AND decision = 'PASS'`,
      ),
    ).toBe(1);
  });
});
