-- Global permission catalog. Organization roles reference these codes.
-- Keep this list identical to PERMISSIONS in packages/policy.

INSERT INTO permissions (code, description) VALUES
  ('agent.invite', 'Invite an employee into the organization.'),
  ('agent.remove', 'Remove an employee from the organization.'),
  ('agent.role.assign', 'Assign or revoke an employee role.'),
  ('artifact.approve', 'Final-approve an artifact.'),
  ('artifact.create', 'Create an artifact.'),
  ('artifact.modify', 'Modify an artifact the actor is allowed to change.'),
  ('artifact.read', 'Read artifacts the actor is allowed to see.'),
  ('artifact.review', 'Submit a review result for an artifact.'),
  ('organization.policy.manage', 'Change organization policy.'),
  ('override.security', 'Override an active security block.'),
  ('room.message.send', 'Send a message in a room the actor belongs to.'),
  ('room.read', 'Read room state the actor is allowed to see.'),
  ('runtime.bind', 'Bind a runtime to an employee.'),
  ('runtime.revoke', 'Revoke a runtime binding.'),
  ('security.approve', 'Grant a security approval.'),
  ('security.audit', 'Read audit history and evidence.'),
  ('security.block', 'Create or clear an authorized security block.'),
  ('task.accept', 'Accept a task assigned to the actor.'),
  ('task.assign', 'Assign a task to another employee.'),
  ('task.cancel', 'Cancel a task.'),
  ('task.create', 'Create a task.'),
  ('task.read', 'Read tasks the actor is allowed to see.'),
  ('workflow.approve', 'Grant a workflow approval.');
