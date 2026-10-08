# Authority

OrganizationDO is the authority for one organization. Its object name is `org:{org_id}`. Callers use RPC on the `ORGANIZATION` binding. Conversation text has no authority. The Worker still has no mutation route, so HTTP cannot assign a role, suspend an employee, approve, block, or override.

`authorize()` returns `ALLOW` or `DENY`, a machine-readable reason, and the current `policy_version`. A denial does not change the version.

The decision order is fixed:

1. `TENANT_BOUNDARY` when the object name is not that organization, the organization does not exist, or the employee is not in it. A mismatched organization id does not hydrate the other tenant into this object.
2. `SUSPENDED_AGENT_DENY` for a suspended employee, before permissions are read.
3. `NO_PERMISSION` when the action does not map to a catalog permission held by the actor.
4. `NO_SELF_APPROVAL` when the actor final-approves or approves an artifact they created, or security-approves their own implementation.
5. `SECURITY_BLOCK` when an active block covers the same resource type and id and has no override. Reads, `security.audit`, and block create, clear, and override are not stopped by the block.

`artifact.final_approve` requires `artifact.approve`. Creating or clearing a block requires `security.block`. Overriding a block requires `override.security` and a reason.

The human who created the organization holds the full permission catalog. Any other human holds nothing until a session model exists. An employee's permissions are the union of their assigned roles.

`assignRole()` returns `ROLE_CONFLICT` for the `employee` and `security` pair, and for any non-owner combination that both implements an artifact (`artifact.create` or `artifact.modify`) and holds `security.approve`. The owner role is exempt from that combination. The check runs inside the same storage transaction as the insert. Assigning, revoking, suspending, clearing, or overriding an already-applied change does not bump the version.

The object writes first. It then projects `employee_roles`, employee status, `security_blocks`, `security_overrides`, and `organization_policy` to D1. The policy projection keeps the higher version if two writes complete out of order. A failed D1 batch undoes the object write.

`FoundationStore.assignEmployeeRole()` remains the Phase 1 relational path and does not apply the conflict rules. Privileged changes go through OrganizationDO.

The class uses declarative Wrangler `exports` with SQLite storage. No Durable Object namespace is deployed.
