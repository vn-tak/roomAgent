import { PERMISSION_CODES, type PermissionCode } from "./permissions";

export const SYSTEM_ROLE_CODES = [
  "owner",
  "executive",
  "manager",
  "employee",
  "qa",
  "security",
  "auditor",
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

export interface RoleTemplate {
  readonly code: SystemRoleCode;
  readonly name: string;
  readonly permissions: readonly PermissionCode[];
}

function perms<const T extends readonly PermissionCode[]>(values: T): T {
  return values;
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: "owner",
    name: "Owner",
    permissions: PERMISSION_CODES,
  },
  {
    code: "executive",
    name: "Executive",
    permissions: perms([
      "room.read",
      "room.message.send",
      "task.read",
      "task.create",
      "task.assign",
      "task.cancel",
      "artifact.read",
      "artifact.review",
      "agent.invite",
      "agent.role.assign",
      "workflow.approve",
    ]),
  },
  {
    code: "manager",
    name: "Manager",
    permissions: perms([
      "room.read",
      "room.message.send",
      "task.read",
      "task.accept",
      "task.create",
      "task.assign",
      "task.cancel",
      "artifact.read",
      "artifact.review",
    ]),
  },
  {
    code: "employee",
    name: "Employee",
    permissions: perms([
      "room.read",
      "room.message.send",
      "task.read",
      "task.accept",
      "artifact.read",
      "artifact.create",
      "artifact.modify",
    ]),
  },
  {
    code: "qa",
    name: "QA",
    permissions: perms([
      "room.read",
      "room.message.send",
      "task.read",
      "task.accept",
      "artifact.read",
      "artifact.review",
    ]),
  },
  {
    code: "security",
    name: "Security",
    permissions: perms([
      "room.read",
      "task.read",
      "artifact.read",
      "security.audit",
      "security.block",
      "security.approve",
    ]),
  },
  {
    code: "auditor",
    name: "Auditor",
    permissions: perms(["room.read", "task.read", "artifact.read", "security.audit"]),
  },
];

export function roleTemplate(code: SystemRoleCode): RoleTemplate {
  const template = ROLE_TEMPLATES.find((item) => item.code === code);
  if (!template) {
    throw new Error(`Missing role template ${code}`);
  }
  return template;
}
