export const PERMISSIONS = [
  { code: "room.read", description: "Read room state the actor is allowed to see." },
  { code: "room.message.send", description: "Send a message in a room the actor belongs to." },
  { code: "task.read", description: "Read tasks the actor is allowed to see." },
  { code: "task.accept", description: "Accept a task assigned to the actor." },
  { code: "task.create", description: "Create a task." },
  { code: "task.assign", description: "Assign a task to another employee." },
  { code: "task.cancel", description: "Cancel a task." },
  { code: "artifact.read", description: "Read artifacts the actor is allowed to see." },
  { code: "artifact.create", description: "Create an artifact." },
  { code: "artifact.modify", description: "Modify an artifact the actor is allowed to change." },
  { code: "artifact.review", description: "Submit a review result for an artifact." },
  { code: "artifact.approve", description: "Final-approve an artifact." },
  { code: "agent.invite", description: "Invite an employee into the organization." },
  { code: "agent.remove", description: "Remove an employee from the organization." },
  { code: "agent.role.assign", description: "Assign or revoke an employee role." },
  { code: "security.audit", description: "Read audit history and evidence." },
  { code: "security.block", description: "Create or clear an authorized security block." },
  { code: "security.approve", description: "Grant a security approval." },
  { code: "organization.policy.manage", description: "Change organization policy." },
  { code: "workflow.approve", description: "Grant a workflow approval." },
  { code: "override.security", description: "Override an active security block." },
  { code: "runtime.bind", description: "Bind a runtime to an employee." },
  { code: "runtime.revoke", description: "Revoke a runtime binding." },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

const PERMISSION_CODE_SET: ReadonlySet<string> = new Set(PERMISSIONS.map((item) => item.code));

export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODE_SET.has(value);
}

export const PERMISSION_CODES: readonly PermissionCode[] = PERMISSIONS.map((item) => item.code);

const MUTATING = new Set<PermissionCode>([
  "room.message.send",
  "task.accept",
  "task.create",
  "task.assign",
  "task.cancel",
  "artifact.create",
  "artifact.modify",
  "artifact.review",
  "artifact.approve",
  "agent.invite",
  "agent.remove",
  "agent.role.assign",
  "security.block",
  "security.approve",
  "organization.policy.manage",
  "workflow.approve",
  "override.security",
  "runtime.bind",
  "runtime.revoke",
]);

export function isMutatingPermission(code: PermissionCode): boolean {
  return MUTATING.has(code);
}
