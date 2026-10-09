import { PERMISSION_CODES, isPermissionCode, type PermissionCode } from "./permissions";

export type ActorType = "human" | "employee";

export type DecisionReason =
  | "ALLOWED"
  | "NO_PERMISSION"
  | "NO_SELF_APPROVAL"
  | "ROLE_CONFLICT"
  | "SUSPENDED_AGENT_DENY"
  | "TENANT_BOUNDARY"
  | "SECURITY_BLOCK";

export interface AuthorityDecision {
  decision: "ALLOW" | "DENY";
  reason: DecisionReason;
  policy_version: number;
}

export interface AuthorityEmployee {
  status: "active" | "suspended";
  permissions: ReadonlySet<string>;
}

export interface AuthorityBlock {
  id: string;
  resourceType: string;
  resourceId: string;
  state: "active" | "cleared";
}

export interface AuthoritySnapshot {
  orgId: string;
  policyVersion: number;
  ownerHumanId: string;
  employees: ReadonlyMap<string, AuthorityEmployee>;
  blocks: readonly AuthorityBlock[];
  overriddenBlockIds: ReadonlySet<string>;
}

export interface AuthorizationCommand {
  orgId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  creatorId?: string | null;
  implementationActorId?: string | null;
}

const ACTION_PERMISSION: Readonly<Record<string, PermissionCode>> = {
  "artifact.final_approve": "artifact.approve",
  "security.block.create": "security.block",
  "security.block.clear": "security.block",
  "security.block.override": "override.security",
  // Starting a governed workflow is task orchestration; no role gains a new permission.
  "workflow.start": "task.assign",
};

const SELF_APPROVAL_ACTIONS = new Set(["artifact.approve", "artifact.final_approve"]);

const IMPLEMENTATION_PERMISSIONS = new Set<PermissionCode>(["artifact.create", "artifact.modify"]);

export function requiredPermission(action: string): string {
  return ACTION_PERMISSION[action] ?? action;
}

function deny(reason: DecisionReason, policyVersion: number): AuthorityDecision {
  return { decision: "DENY", reason, policy_version: policyVersion };
}

function allow(policyVersion: number): AuthorityDecision {
  return { decision: "ALLOW", reason: "ALLOWED", policy_version: policyVersion };
}

export function actorPermissions(
  snapshot: AuthoritySnapshot,
  actorType: ActorType,
  actorId: string,
): ReadonlySet<string> | null {
  if (actorType === "human") {
    if (actorId !== snapshot.ownerHumanId) {
      return new Set();
    }
    return new Set(PERMISSION_CODES);
  }
  return snapshot.employees.get(actorId)?.permissions ?? null;
}

function blockStops(snapshot: AuthoritySnapshot, command: AuthorizationCommand): boolean {
  const covered = snapshot.blocks.some(
    (block) =>
      block.state === "active" &&
      block.resourceType === command.resourceType &&
      block.resourceId === command.resourceId &&
      !snapshot.overriddenBlockIds.has(block.id),
  );
  if (!covered) {
    return false;
  }
  if (
    command.action === "security.block.clear" ||
    command.action === "security.block.override" ||
    command.action === "security.block.create" ||
    command.action === "security.audit" ||
    command.action.endsWith(".read")
  ) {
    return false;
  }
  return true;
}

export function decideAuthorization(
  snapshot: AuthoritySnapshot,
  command: AuthorizationCommand,
): AuthorityDecision {
  const version = snapshot.policyVersion;
  if (command.orgId !== snapshot.orgId) {
    return deny("TENANT_BOUNDARY", version);
  }
  if (command.actorType === "employee" && !snapshot.employees.has(command.actorId)) {
    return deny("TENANT_BOUNDARY", version);
  }
  const employee = snapshot.employees.get(command.actorId);
  if (command.actorType === "employee" && employee?.status === "suspended") {
    return deny("SUSPENDED_AGENT_DENY", version);
  }

  const permissions = actorPermissions(snapshot, command.actorType, command.actorId);
  const required = requiredPermission(command.action);
  if (!permissions || !isPermissionCode(required) || !permissions.has(required)) {
    return deny("NO_PERMISSION", version);
  }

  if (
    SELF_APPROVAL_ACTIONS.has(command.action) &&
    command.creatorId &&
    command.creatorId === command.actorId
  ) {
    return deny("NO_SELF_APPROVAL", version);
  }
  if (
    command.action === "security.approve" &&
    command.implementationActorId &&
    command.implementationActorId === command.actorId
  ) {
    return deny("NO_SELF_APPROVAL", version);
  }
  if (blockStops(snapshot, command)) {
    return deny("SECURITY_BLOCK", version);
  }
  return allow(version);
}

export function rolesConflict(
  roleCodes: readonly string[],
  permissionsByRole: ReadonlyMap<string, readonly string[]>,
): boolean {
  const codes = new Set(roleCodes);
  if (codes.has("employee") && codes.has("security")) {
    return true;
  }
  let implementsArtifact = false;
  let approvesSecurity = false;
  for (const code of roleCodes) {
    if (code === "owner") {
      continue;
    }
    for (const permission of permissionsByRole.get(code) ?? []) {
      if (IMPLEMENTATION_PERMISSIONS.has(permission as PermissionCode)) {
        implementsArtifact = true;
      }
      if (permission === "security.approve") {
        approvesSecurity = true;
      }
    }
  }
  return implementsArtifact && approvesSecurity;
}
