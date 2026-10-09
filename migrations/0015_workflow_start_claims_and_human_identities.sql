-- Staging P1: durable workflow start claims, verified human operator identities,
-- and an insert-only human session audit. Forward-only; no historical table is rebuilt.

-- One row per logical ProductionTaskWorkflow start. The id is also the workflow
-- instance id, so every instance created by the API is traceable to an actor.
CREATE TABLE workflow_start_claims (
  id TEXT PRIMARY KEY CHECK (id GLOB 'wfr_*' AND length(id) = 36),
  org_id TEXT NOT NULL REFERENCES organizations (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  artifact_version INTEGER NOT NULL CHECK (artifact_version BETWEEN 1 AND 1000000),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'created', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key)
);

-- At most one unreleased start claim per task, enforced by the database.
CREATE UNIQUE INDEX workflow_start_claims_one_active
  ON workflow_start_claims (org_id, task_id) WHERE state <> 'released';

CREATE TRIGGER workflow_start_claims_integrity
BEFORE INSERT ON workflow_start_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CLAIM_INVALID') WHERE NEW.state IS NOT 'claimed';
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE NOT EXISTS (
      SELECT 1 FROM tasks
      INNER JOIN artifacts
        ON artifacts.org_id = tasks.org_id
       AND artifacts.task_id = tasks.id
       AND artifacts.room_id = tasks.room_id
      INNER JOIN artifact_versions
        ON artifact_versions.org_id = artifacts.org_id
       AND artifact_versions.artifact_id = artifacts.id
       AND artifact_versions.version = NEW.artifact_version
      WHERE tasks.org_id = NEW.org_id
        AND tasks.id = NEW.task_id
        AND artifacts.id = NEW.artifact_id
    )
     OR (
       NEW.actor_type = 'employee'
       AND (SELECT org_id FROM employees WHERE id = NEW.actor_id) IS NOT NEW.org_id
     )
     OR (
       NEW.actor_type = 'human'
       AND (SELECT id FROM human_users WHERE id = NEW.actor_id) IS NULL
     );
END;

CREATE TRIGGER workflow_start_claims_forward_only
BEFORE UPDATE ON workflow_start_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE')
  WHERE NEW.id IS NOT OLD.id
     OR NEW.org_id IS NOT OLD.org_id
     OR NEW.task_id IS NOT OLD.task_id
     OR NEW.artifact_id IS NOT OLD.artifact_id
     OR NEW.artifact_version IS NOT OLD.artifact_version
     OR NEW.actor_type IS NOT OLD.actor_type
     OR NEW.actor_id IS NOT OLD.actor_id
     OR NEW.idempotency_key IS NOT OLD.idempotency_key
     OR NEW.created_at IS NOT OLD.created_at
     OR OLD.state = 'released'
     OR (OLD.state = 'created' AND NEW.state = 'claimed');
END;

CREATE TRIGGER workflow_start_claims_no_delete
BEFORE DELETE ON workflow_start_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE');
END;

-- Operator-provisioned mapping from a verified Cloudflare Access identity to a human user.
-- The Access subject is pinned on first verified use and cannot change afterwards.
CREATE TABLE human_identities (
  id TEXT PRIMARY KEY CHECK (id GLOB 'hid_*' AND length(id) = 36),
  issuer TEXT NOT NULL CHECK (issuer GLOB 'https://?*.cloudflareaccess.com'),
  email TEXT NOT NULL CHECK (
    email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email GLOB '?*@?*'
  ),
  subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES human_users (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (issuer, email),
  UNIQUE (issuer, subject)
);

CREATE TRIGGER human_identities_pinned
BEFORE UPDATE ON human_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_IMMUTABLE')
  WHERE NEW.id IS NOT OLD.id
     OR NEW.issuer IS NOT OLD.issuer
     OR NEW.email IS NOT OLD.email
     OR NEW.user_id IS NOT OLD.user_id
     OR NEW.created_at IS NOT OLD.created_at
     OR (OLD.subject IS NOT NULL AND NEW.subject IS NOT OLD.subject);
END;

CREATE TRIGGER human_identities_no_delete
BEFORE DELETE ON human_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_IMMUTABLE');
END;

-- Sessions issued from a verified identity stop verifying as soon as it is disabled.
ALTER TABLE human_sessions ADD COLUMN identity_id TEXT REFERENCES human_identities (id);

CREATE TABLE human_session_audit (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  session_id TEXT NOT NULL REFERENCES human_sessions (id),
  user_id TEXT NOT NULL REFERENCES human_users (id),
  identity_id TEXT REFERENCES human_identities (id),
  action TEXT NOT NULL CHECK (action IN ('issued', 'revoked')),
  method TEXT NOT NULL CHECK (method IN ('cloudflare_access', 'trusted_rpc')),
  recorded_at TEXT NOT NULL
);

CREATE INDEX human_session_audit_org_idx ON human_session_audit (org_id, session_id);

CREATE TRIGGER human_session_audit_no_update
BEFORE UPDATE ON human_session_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER human_session_audit_no_delete
BEFORE DELETE ON human_session_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;
