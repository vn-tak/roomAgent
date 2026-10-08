import type { FoundationStore } from "@ai-company/db";
import type { Organization, Role } from "@ai-company/domain";
import { OrganizationDO } from "@ai-company/organization";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createStudio,
  hire,
  organizationStub,
  storedPolicyVersion,
  storedRoleCount,
} from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

describe("organization authority", () => {
  it("does not expose authority over HTTP", async () => {
    const response = await exports.default.fetch("https://company.local/organizations", {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });

  it("hydrates version 1 without writing a policy row", async () => {
    const studio = await createStudio("Version start");
    const decision = await organizationStub(studio.org.id).authorize({
      ...ownerOf(studio.org),
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(decision).toEqual({ decision: "ALLOW", reason: "ALLOWED", policy_version: 1 });
    expect(await storedPolicyVersion(studio.org.id)).toBeNull();
  });

  it("denies an unknown organization and a foreign organization id", async () => {
    const studio = await createStudio("Boundary A");
    const other = await createStudio("Boundary B");
    const missing = `org_${"ab".repeat(16)}`;
    const missingDecision = await organizationStub(missing).authorize({
      orgId: missing,
      actorType: "human",
      actorId: studio.org.createdByUserId,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(missingDecision).toEqual({
      decision: "DENY",
      reason: "TENANT_BOUNDARY",
      policy_version: 0,
    });

    const stub = organizationStub(studio.org.id);
    const crossed = await stub.authorize({
      ...ownerOf(other.org),
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(crossed).toEqual({ decision: "DENY", reason: "TENANT_BOUNDARY", policy_version: 0 });
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec(`SELECT org_id FROM meta`).toArray();
      expect(rows).toHaveLength(0);
    });
  });

  it("denies an employee from another organization", async () => {
    const studio = await createStudio("Tenant A");
    const other = await createStudio("Tenant B");
    const foreign = await hire(other.store, other.org.id, "Foreign");
    const decision = await organizationStub(studio.org.id).authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: foreign.id,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(decision.reason).toBe("TENANT_BOUNDARY");
    expect(decision.policy_version).toBe(1);
  });

  it("denies self approval and allows a different approver", async () => {
    const studio = await createStudio("Approvers");
    const creator = await hire(studio.store, studio.org.id, "Creator");
    const reviewer = await hire(studio.store, studio.org.id, "Reviewer");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const approver = await studio.store.createRole(studio.org.id, {
      code: "final_approver",
      name: "Final approver",
    });
    await studio.store.assignPermission(studio.org.id, approver.id, "artifact.approve");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);

    expect(
      (await stub.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id }))
        .policy_version,
    ).toBe(2);
    await stub.assignRole({ ...owner, employeeId: creator.id, roleId: approver.id });
    await stub.assignRole({ ...owner, employeeId: reviewer.id, roleId: approver.id });

    const ownWork = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: worker.id,
    });
    expect(ownWork.reason).toBe("NO_PERMISSION");

    const self = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: creator.id,
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: creator.id,
    });
    expect(self.reason).toBe("NO_SELF_APPROVAL");

    const otherApprover = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: reviewer.id,
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: creator.id,
    });
    expect(otherApprover).toMatchObject({
      decision: "ALLOW",
      reason: "ALLOWED",
      policy_version: 4,
    });
    expect(await storedPolicyVersion(studio.org.id)).toBe(4);
    expect(await storedRoleCount(studio.org.id, creator.id)).toBe(1);
  });

  it("rejects conflicting roles and keeps an idempotent assign at one row", async () => {
    const studio = await createStudio("Conflicts");
    const employee = await hire(studio.store, studio.org.id, "Builder");
    const specialist = await hire(studio.store, studio.org.id, "Specialist");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const ownerRole = await roleByCode(studio.store, studio.org.id, "owner");
    const builder = await studio.store.createRole(studio.org.id, {
      code: "builder",
      name: "Builder",
    });
    const reviewer = await studio.store.createRole(studio.org.id, {
      code: "security_reviewer",
      name: "Security reviewer",
    });
    await studio.store.assignPermission(studio.org.id, builder.id, "artifact.create");
    await studio.store.assignPermission(studio.org.id, reviewer.id, "security.approve");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    const assign = {
      ...owner,
      employeeId: employee.id,
    };

    const first = await stub.assignRole({ ...assign, roleId: employeeRole.id });
    const repeat = await stub.assignRole({ ...assign, roleId: employeeRole.id });
    expect(first).toMatchObject({ decision: "ALLOW", policy_version: 2 });
    expect(repeat).toMatchObject({ decision: "ALLOW", policy_version: 2 });

    const conflict = await stub.assignRole({ ...assign, roleId: securityRole.id });
    expect(conflict).toEqual({ decision: "DENY", reason: "ROLE_CONFLICT", policy_version: 2 });
    expect(await storedRoleCount(studio.org.id, employee.id)).toBe(1);

    const ownerAssign = await stub.assignRole({ ...assign, roleId: ownerRole.id });
    expect(ownerAssign).toMatchObject({ decision: "ALLOW", policy_version: 3 });

    await stub.assignRole({ ...owner, employeeId: specialist.id, roleId: builder.id });
    const customConflict = await stub.assignRole({
      ...owner,
      employeeId: specialist.id,
      roleId: reviewer.id,
    });
    expect(customConflict.reason).toBe("ROLE_CONFLICT");
    expect(await storedRoleCount(studio.org.id, specialist.id)).toBe(1);
  });

  it("denies a manager override and allows the owner to lift a block", async () => {
    const studio = await createStudio("Blocks");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const security = await hire(studio.store, studio.org.id, "Security");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await stub.assignRole({ ...owner, employeeId: worker.id, roleId: employeeRole.id });
    await stub.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    await stub.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });

    const managerAssign = await stub.assignRole({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      employeeId: worker.id,
      roleId: securityRole.id,
    });
    expect(managerAssign.reason).toBe("NO_PERMISSION");

    const created = await stub.createSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: security.id,
      resourceType: "artifact",
      resourceId: "art_blocked",
      severity: "high",
      reason: "Unreviewed asset",
    });
    expect(created.decision).toBe("ALLOW");
    expect(created.block_id).toMatch(/^blk_[0-9a-f]{32}$/);
    const blockId = created.block_id ?? "";

    const blockedAssign = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      action: "task.assign",
      resourceType: "artifact",
      resourceId: "art_blocked",
    });
    expect(blockedAssign.reason).toBe("SECURITY_BLOCK");

    const otherResource = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      action: "task.assign",
      resourceType: "artifact",
      resourceId: "art_other",
    });
    expect(otherResource.decision).toBe("ALLOW");

    const blockedModify = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      action: "artifact.modify",
      resourceType: "artifact",
      resourceId: "art_blocked",
    });
    expect(blockedModify.reason).toBe("SECURITY_BLOCK");

    const read = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      action: "artifact.read",
      resourceType: "artifact",
      resourceId: "art_blocked",
    });
    expect(read.decision).toBe("ALLOW");

    const managerOverride = await stub.overrideSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      blockId,
      reason: "Ship the asset.",
    });
    expect(managerOverride.reason).toBe("NO_PERMISSION");

    const ownerOverride = await stub.overrideSecurityBlock({
      ...owner,
      blockId,
      reason: "Accepted residual risk for this asset.",
    });
    expect(ownerOverride.decision).toBe("ALLOW");

    const modifyAfter = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: worker.id,
      action: "artifact.modify",
      resourceType: "artifact",
      resourceId: "art_blocked",
    });
    expect(modifyAfter.decision).toBe("ALLOW");

    const block = await env.DB.prepare(
      `SELECT state FROM security_blocks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, blockId)
      .first<{ state: string }>();
    const overrides = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM security_overrides WHERE org_id = ? AND block_id = ?`,
    )
      .bind(studio.org.id, blockId)
      .first<{ n: number }>();
    expect(block?.state).toBe("active");
    expect(overrides?.n).toBe(1);

    const selfApproval = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: security.id,
      action: "security.approve",
      resourceType: "artifact",
      resourceId: "art_blocked",
      implementationActorId: security.id,
    });
    expect(selfApproval.reason).toBe("NO_SELF_APPROVAL");
  });

  it("clears only with block permission and keeps a second clear idempotent", async () => {
    const studio = await createStudio("Clear block");
    const security = await hire(studio.store, studio.org.id, "Security");
    const manager = await hire(studio.store, studio.org.id, "Manager");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const managerRole = await roleByCode(studio.store, studio.org.id, "manager");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await stub.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    await stub.assignRole({ ...owner, employeeId: manager.id, roleId: managerRole.id });
    const created = await stub.createSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: security.id,
      resourceType: "artifact",
      resourceId: "art_clear",
      severity: "medium",
      reason: "Needs review",
    });
    const blockId = created.block_id ?? "";
    const managerClear = await stub.clearSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: manager.id,
      blockId,
    });
    expect(managerClear.reason).toBe("NO_PERMISSION");
    const cleared = await stub.clearSecurityBlock({ ...owner, blockId });
    const again = await stub.clearSecurityBlock({ ...owner, blockId });
    expect(cleared.decision).toBe("ALLOW");
    expect(again).toEqual(cleared);
    const row = await env.DB.prepare(
      `SELECT state, cleared_by FROM security_blocks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, blockId)
      .first<{ state: string; cleared_by: string }>();
    expect(row).toEqual({ state: "cleared", cleared_by: owner.actorId });
  });

  it("keeps a suspended employee denied after the object is evicted", async () => {
    const studio = await createStudio("Suspend");
    const employee = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await stub.assignRole({ ...owner, employeeId: employee.id, roleId: employeeRole.id });
    const before = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: employee.id,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(before.decision).toBe("ALLOW");

    const suspended = await stub.suspendEmployee({ ...owner, employeeId: employee.id });
    const repeat = await stub.suspendEmployee({ ...owner, employeeId: employee.id });
    expect(suspended).toMatchObject({ decision: "ALLOW", policy_version: 3 });
    expect(repeat.policy_version).toBe(3);
    expect((await studio.store.getEmployee(studio.org.id, employee.id))?.status).toBe("suspended");

    const denied = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: employee.id,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(denied).toEqual({
      decision: "DENY",
      reason: "SUSPENDED_AGENT_DENY",
      policy_version: 3,
    });

    await evictDurableObject(stub);
    const afterEvict = await stub.authorize({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: employee.id,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(afterEvict.reason).toBe("SUSPENDED_AGENT_DENY");
    expect(afterEvict.policy_version).toBe(3);
    expect(await storedPolicyVersion(studio.org.id)).toBe(3);
  });

  it("rejects an invalid block and an empty override reason", async () => {
    const studio = await createStudio("Invalid authority");
    const stub = organizationStub(studio.org.id);
    const owner = ownerOf(studio.org);
    await runInDurableObject(stub, async (instance: OrganizationDO) => {
      await expect(
        instance.createSecurityBlock({
          ...owner,
          resourceType: "artifact",
          resourceId: "art_1",
          severity: "urgent",
          reason: "Bad severity",
        }),
      ).rejects.toMatchObject({ name: "DomainError", code: "INVALID_INPUT" });
    });

    const security = await hire(studio.store, studio.org.id, "Security");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    await stub.assignRole({ ...owner, employeeId: security.id, roleId: securityRole.id });
    const created = await stub.createSecurityBlock({
      orgId: studio.org.id,
      actorType: "employee",
      actorId: security.id,
      resourceType: "artifact",
      resourceId: "art_1",
      severity: "low",
      reason: "Hold",
    });
    await runInDurableObject(stub, async (instance: OrganizationDO) => {
      await expect(
        instance.overrideSecurityBlock({
          ...owner,
          blockId: created.block_id ?? "",
          reason: "   ",
        }),
      ).rejects.toMatchObject({ name: "DomainError", code: "INVALID_INPUT" });
    });
  });
});
