import { describe, expect, it } from "vitest";
import { PERMISSION_CODES, roleTemplate } from "../src/index";
import { decideAuthorization, rolesConflict, type AuthoritySnapshot } from "../src/authority";

function permissionsOf(code: "employee" | "manager" | "security" | "owner"): Set<string> {
  if (code === "owner") {
    return new Set(PERMISSION_CODES);
  }
  return new Set(roleTemplate(code).permissions);
}

function snapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    orgId: "org_a",
    policyVersion: 4,
    ownerHumanId: "usr_owner",
    employees: new Map([
      ["emp_worker", { status: "active", permissions: permissionsOf("employee") }],
      ["emp_manager", { status: "active", permissions: permissionsOf("manager") }],
      ["emp_security", { status: "active", permissions: permissionsOf("security") }],
      [
        "emp_approver",
        { status: "active", permissions: new Set(["artifact.approve", "artifact.read"]) },
      ],
    ]),
    blocks: [],
    overriddenBlockIds: new Set(),
    ...overrides,
  };
}

describe("decideAuthorization", () => {
  it("denies a worker final-approving an artifact", () => {
    const decision = decideAuthorization(snapshot(), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_worker",
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: "emp_worker",
    });
    expect(decision).toEqual({
      decision: "DENY",
      reason: "NO_PERMISSION",
      policy_version: 4,
    });
  });

  it("denies self approval even when the actor has artifact.approve", () => {
    const decision = decideAuthorization(snapshot(), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_approver",
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: "emp_approver",
    });
    expect(decision.reason).toBe("NO_SELF_APPROVAL");
  });

  it("allows a different approver to final-approve", () => {
    const decision = decideAuthorization(snapshot(), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_approver",
      action: "artifact.final_approve",
      resourceType: "artifact",
      resourceId: "art_1",
      creatorId: "emp_worker",
    });
    expect(decision).toMatchObject({ decision: "ALLOW", reason: "ALLOWED" });
  });

  it("denies a suspended employee before considering permissions", () => {
    const employees = new Map(snapshot().employees);
    employees.set("emp_approver", {
      status: "suspended",
      permissions: permissionsOf("owner"),
    });
    const decision = decideAuthorization(snapshot({ employees }), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_approver",
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(decision.reason).toBe("SUSPENDED_AGENT_DENY");
  });

  it("denies an employee from outside the organization without extra detail", () => {
    const decision = decideAuthorization(snapshot(), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_foreign",
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    });
    expect(decision.reason).toBe("TENANT_BOUNDARY");
  });

  it("denies a manager override and blocks an action the manager is otherwise allowed to take", () => {
    const blocked = snapshot({
      blocks: [{ id: "blk_1", resourceType: "artifact", resourceId: "art_1", state: "active" }],
    });
    expect(
      decideAuthorization(blocked, {
        orgId: "org_a",
        actorType: "employee",
        actorId: "emp_manager",
        action: "security.block.override",
        resourceType: "artifact",
        resourceId: "art_1",
      }).reason,
    ).toBe("NO_PERMISSION");
    expect(
      decideAuthorization(blocked, {
        orgId: "org_a",
        actorType: "employee",
        actorId: "emp_manager",
        action: "task.assign",
        resourceType: "artifact",
        resourceId: "art_1",
      }).reason,
    ).toBe("SECURITY_BLOCK");
  });

  it("lets the owner override a block and then allows a permitted action", () => {
    const blocked = snapshot({
      blocks: [{ id: "blk_1", resourceType: "artifact", resourceId: "art_1", state: "active" }],
      overriddenBlockIds: new Set(["blk_1"]),
    });
    expect(
      decideAuthorization(snapshot({ blocks: blocked.blocks }), {
        orgId: "org_a",
        actorType: "human",
        actorId: "usr_owner",
        action: "security.block.override",
        resourceType: "artifact",
        resourceId: "art_1",
      }).decision,
    ).toBe("ALLOW");
    expect(
      decideAuthorization(blocked, {
        orgId: "org_a",
        actorType: "employee",
        actorId: "emp_worker",
        action: "artifact.modify",
        resourceType: "artifact",
        resourceId: "art_1",
      }).decision,
    ).toBe("ALLOW");
  });

  it("denies security approving their own implementation", () => {
    const decision = decideAuthorization(snapshot(), {
      orgId: "org_a",
      actorType: "employee",
      actorId: "emp_security",
      action: "security.approve",
      resourceType: "artifact",
      resourceId: "art_1",
      implementationActorId: "emp_security",
    });
    expect(decision.reason).toBe("NO_SELF_APPROVAL");
  });
});

describe("rolesConflict", () => {
  it("rejects employee together with security", () => {
    const permissions = new Map([
      ["employee", [...roleTemplate("employee").permissions]],
      ["security", [...roleTemplate("security").permissions]],
    ]);
    expect(rolesConflict(["employee", "security"], permissions)).toBe(true);
  });

  it("rejects an implementer role combined with security approval", () => {
    const permissions = new Map<string, readonly string[]>([
      ["builder", ["artifact.create"]],
      ["reviewer", ["security.approve"]],
    ]);
    expect(rolesConflict(["builder", "reviewer"], permissions)).toBe(true);
  });

  it("does not treat the owner role as a separation-of-duties conflict", () => {
    const permissions = new Map<string, readonly string[]>([["owner", [...PERMISSION_CODES]]]);
    expect(rolesConflict(["owner"], permissions)).toBe(false);
  });
});
