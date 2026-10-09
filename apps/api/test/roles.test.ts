import { DomainError } from "@ai-company/domain";
import { PERMISSION_CODES, roleTemplate } from "@ai-company/policy";
import { describe, expect, it } from "vitest";
import { createStudio, hire } from "./helpers";

describe("roles and permissions", () => {
  it("loads the global permission catalog", async () => {
    const studio = await createStudio("Catalog");
    const codes = await studio.store.listPermissionCatalog();
    expect(codes).toEqual([...PERMISSION_CODES].sort());
  });

  it("seeds system roles per organization", async () => {
    const left = await createStudio("Roles A");
    const right = await createStudio("Roles B");
    const leftOwner = await left.store.getRoleByCode(left.org.id, "owner");
    const rightOwner = await right.store.getRoleByCode(right.org.id, "owner");
    expect(leftOwner?.systemRole).toBe(true);
    expect(rightOwner?.systemRole).toBe(true);
    expect(leftOwner?.id).not.toBe(rightOwner?.id);
    expect(await right.store.getRole(right.org.id, leftOwner?.id ?? "")).toBeNull();
  });

  it("creates a custom role and assigns a catalog permission", async () => {
    const studio = await createStudio("Custom roles");
    const role = await studio.store.createRole(studio.org.id, {
      code: "story_artist",
      name: "Story artist",
    });
    await studio.store.assignPermission(studio.org.id, role.id, "artifact.create");
    const employee = await hire(studio.store, studio.org.id, "Artist");
    await studio.store.bootstrapAssignEmployeeRoleUnsafe(studio.org.id, employee.id, role.id);
    expect(await studio.store.listEmployeePermissionCodes(studio.org.id, employee.id)).toEqual([
      "artifact.create",
    ]);
  });

  it("rejects duplicate role codes, unknown permissions, and system-role edits", async () => {
    const studio = await createStudio("Role guards");
    await studio.store.createRole(studio.org.id, { code: "story_artist", name: "Story artist" });
    await expect(
      studio.store.createRole(studio.org.id, { code: "story_artist", name: "Again" }),
    ).rejects.toMatchObject({ code: "ROLE_CODE_TAKEN" });

    const custom = await studio.store.createRole(studio.org.id, {
      code: "layout",
      name: "Layout",
    });
    await expect(
      studio.store.assignPermission(studio.org.id, custom.id, "artifact.own_the_company"),
    ).rejects.toMatchObject({ code: "INVALID_PERMISSION" });
    await studio.store.assignPermission(studio.org.id, custom.id, "task.read");
    await expect(
      studio.store.assignPermission(studio.org.id, custom.id, "task.read"),
    ).rejects.toMatchObject({ code: "ALREADY_ASSIGNED" });

    const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
    expect(employeeRole).not.toBeNull();
    await expect(
      studio.store.assignPermission(studio.org.id, employeeRole?.id ?? "", "artifact.approve"),
    ).rejects.toMatchObject({ code: "SYSTEM_ROLE_LOCKED" });
    expect(roleTemplate("employee").permissions).not.toContain("artifact.approve");
  });

  it("does not assign a role from another organization", async () => {
    const left = await createStudio("Assign A");
    const right = await createStudio("Assign B");
    const employee = await hire(left.store, left.org.id, "Worker");
    const foreignRole = await right.store.getRoleByCode(right.org.id, "manager");
    await expect(
      left.store.bootstrapAssignEmployeeRoleUnsafe(left.org.id, employee.id, foreignRole?.id ?? ""),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      left.store.bootstrapAssignEmployeeRoleUnsafe(left.org.id, employee.id, foreignRole?.id ?? ""),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await left.store.listEmployeePermissionCodes(left.org.id, employee.id)).toEqual([]);
  });
});
