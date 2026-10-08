import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FoundationStore } from "@ai-company/db";
import type { Role } from "@ai-company/domain";
import {
  createStudio,
  hire,
  organizationStub,
  storedPolicyVersion,
  storedRoleCount,
} from "./helpers";

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

describe("organization authority races", () => {
  it("keeps one role when employee and security are assigned together", async () => {
    const studio = await createStudio("Race conflict");
    const employee = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const securityRole = await roleByCode(studio.store, studio.org.id, "security");
    const stub = organizationStub(studio.org.id);
    const actor = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
      employeeId: employee.id,
    };
    const [left, right] = await Promise.all([
      stub.assignRole({ ...actor, roleId: employeeRole.id }),
      stub.assignRole({ ...actor, roleId: securityRole.id }),
    ]);
    const decisions = [left, right].map((decision) => decision.decision).sort();
    expect(decisions).toEqual(["ALLOW", "DENY"]);
    expect([left, right].find((decision) => decision.decision === "DENY")?.reason).toBe(
      "ROLE_CONFLICT",
    );
    expect(await storedRoleCount(studio.org.id, employee.id)).toBe(1);
    expect(await storedPolicyVersion(studio.org.id)).toBe(2);
  });

  it("assigns one row and bumps the version once for the same role", async () => {
    const studio = await createStudio("Race same role");
    const employee = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const stub = organizationStub(studio.org.id);
    const command = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
      employeeId: employee.id,
      roleId: employeeRole.id,
    };
    const [left, right] = await Promise.all([stub.assignRole(command), stub.assignRole(command)]);
    expect(left.decision).toBe("ALLOW");
    expect(right.decision).toBe("ALLOW");
    expect(await storedRoleCount(studio.org.id, employee.id)).toBe(1);
    expect(await storedPolicyVersion(studio.org.id)).toBe(2);
  });

  it("bumps the version for two employees assigned in parallel", async () => {
    const studio = await createStudio("Race two employees");
    const leftEmployee = await hire(studio.store, studio.org.id, "Left");
    const rightEmployee = await hire(studio.store, studio.org.id, "Right");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const stub = organizationStub(studio.org.id);
    const actor = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
      roleId: employeeRole.id,
    };
    const [left, right] = await Promise.all([
      stub.assignRole({ ...actor, employeeId: leftEmployee.id }),
      stub.assignRole({ ...actor, employeeId: rightEmployee.id }),
    ]);
    expect(left.decision).toBe("ALLOW");
    expect(right.decision).toBe("ALLOW");
    expect(await storedRoleCount(studio.org.id, leftEmployee.id)).toBe(1);
    expect(await storedRoleCount(studio.org.id, rightEmployee.id)).toBe(1);
    expect(await storedPolicyVersion(studio.org.id)).toBe(3);
  });

  it("hydrates once when two authorizations arrive together", async () => {
    const studio = await createStudio("Race hydrate");
    const stub = organizationStub(studio.org.id);
    const command = {
      orgId: studio.org.id,
      actorType: "human" as const,
      actorId: studio.org.createdByUserId,
      action: "task.read",
      resourceType: "task",
      resourceId: "task_1",
    };
    const [left, right] = await Promise.all([stub.authorize(command), stub.authorize(command)]);
    expect(left).toEqual({ decision: "ALLOW", reason: "ALLOWED", policy_version: 1 });
    expect(right).toEqual(left);
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec(`SELECT org_id FROM meta`).toArray();
      expect(rows).toHaveLength(1);
    });
    expect(await storedPolicyVersion(studio.org.id)).toBeNull();
  });
});
