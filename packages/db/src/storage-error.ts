import { DomainError } from "@ai-company/domain";

export function mapStorageError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TENANT_MISMATCH")) {
    throw new DomainError("NOT_FOUND", "Resource was not found.");
  }
  if (message.includes("roles.org_id") && message.includes("roles.code")) {
    throw new DomainError("ROLE_CODE_TAKEN", "Role code already exists in this organization.");
  }
  if (message.includes("runtime_bindings.org_id")) {
    throw new DomainError(
      "BINDING_ALREADY_ACTIVE",
      "Employee already has an active runtime binding.",
    );
  }
  if (message.includes("room_memberships.org_id")) {
    throw new DomainError("ALREADY_MEMBER", "Employee is already an active member of this room.");
  }
  if (message.includes("employee_roles.org_id") || message.includes("role_permissions.org_id")) {
    throw new DomainError("ALREADY_ASSIGNED", "That assignment already exists.");
  }
  throw error instanceof Error ? error : new Error(message);
}
