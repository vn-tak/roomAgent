import { describe, expect, it } from "vitest";
import {
  PERMISSION_CODES,
  ROLE_TEMPLATES,
  isMutatingPermission,
  isPermissionCode,
  roleTemplate,
} from "../src/index";

describe("role templates", () => {
  it("only references permissions that exist in the catalog", () => {
    for (const template of ROLE_TEMPLATES) {
      for (const permission of template.permissions) {
        expect(isPermissionCode(permission)).toBe(true);
      }
    }
  });

  it("keeps system role codes unique", () => {
    const codes = ROLE_TEMPLATES.map((template) => template.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([
      "owner",
      "executive",
      "manager",
      "employee",
      "qa",
      "security",
      "auditor",
    ]);
  });

  it("gives the owner the full catalog and keeps other templates inside it", () => {
    expect(roleTemplate("owner").permissions).toEqual(PERMISSION_CODES);
    expect(roleTemplate("manager").permissions).not.toContain("override.security");
    expect(roleTemplate("manager").permissions).not.toContain("organization.policy.manage");
    expect(roleTemplate("manager").permissions).not.toContain("artifact.approve");
    expect(roleTemplate("employee").permissions).not.toContain("task.assign");
    expect(roleTemplate("employee").permissions).not.toContain("artifact.approve");
    expect(roleTemplate("qa").permissions).not.toContain("artifact.modify");
    expect(roleTemplate("qa").permissions).not.toContain("artifact.approve");
    expect(roleTemplate("security").permissions).not.toContain("artifact.modify");
    expect(roleTemplate("security").permissions).not.toContain("artifact.create");
    expect(roleTemplate("security").permissions).not.toContain("artifact.approve");
  });

  it("gives the auditor no mutating permission", () => {
    for (const permission of roleTemplate("auditor").permissions) {
      expect(isMutatingPermission(permission)).toBe(false);
    }
  });
});
