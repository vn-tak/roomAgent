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
  release_reason TEXT CHECK (
    release_reason IS NULL
    OR release_reason IN ('completed', 'never_registered', 'instance_failed', 'resolved')
  ),
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
  SELECT RAISE(ABORT, 'WORKFLOW_CLAIM_INVALID')
  WHERE NEW.state IS NOT 'claimed' OR NEW.release_reason IS NOT NULL;
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

-- Why a run ended is recorded on the run, so a governance hold cannot be mistaken for a crash.
ALTER TABLE workflow_runs ADD COLUMN hold_reason TEXT CHECK (
  hold_reason IS NULL
  OR hold_reason IN (
    'LOOP_GUARD', 'TIMEOUT', 'EVIDENCE_TIMEOUT', 'QA_FAILED', 'SECURITY_DENIED',
    'APPROVAL_DENIED', 'INSTANCE_FAILED'
  )
);

CREATE TRIGGER workflow_runs_hold_integrity
BEFORE UPDATE ON workflow_runs
FOR EACH ROW
BEGIN
  -- A finished or held run is final; only an explicit resolution releases its task.
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE')
  WHERE OLD.status IN ('complete', 'denied', 'paused')
    AND (
      NEW.status IS NOT OLD.status
      OR NEW.hold_reason IS NOT OLD.hold_reason
      OR NEW.stage IS NOT OLD.stage
      OR NEW.iteration IS NOT OLD.iteration
    );
  SELECT RAISE(ABORT, 'WORKFLOW_HOLD_REASON')
  WHERE (NEW.status IN ('denied', 'paused')) IS NOT (NEW.hold_reason IS NOT NULL);
END;

-- Explicit, audited release of a held run. One per run; at most three per task.
CREATE TABLE workflow_run_resolutions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  hold_reason TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('owner_human', 'workflow_approver')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, idempotency_key)
);

CREATE TRIGGER workflow_run_resolutions_policy
BEFORE INSERT ON workflow_run_resolutions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_NOT_HELD')
  WHERE NOT EXISTS (
    SELECT 1 FROM workflow_runs
    WHERE org_id = NEW.org_id AND id = NEW.run_id AND task_id = NEW.task_id
      AND status IN ('denied', 'paused') AND hold_reason = NEW.hold_reason
  )
     OR NOT EXISTS (
    SELECT 1 FROM workflow_start_claims
    WHERE org_id = NEW.org_id AND id = NEW.run_id AND state <> 'released'
  );
  SELECT RAISE(ABORT, 'RESOLUTION_POLICY')
  WHERE NEW.policy IS NOT (
    CASE
      WHEN NEW.hold_reason IN ('LOOP_GUARD', 'SECURITY_DENIED', 'APPROVAL_DENIED')
        THEN 'owner_human'
      ELSE 'workflow_approver'
    END
  )
     OR (
       NEW.policy = 'owner_human'
       AND (
         NEW.actor_type IS NOT 'human'
         OR (SELECT created_by_user_id FROM organizations WHERE id = NEW.org_id)
            IS NOT NEW.actor_id
       )
     )
     OR (
       NEW.actor_type = 'employee'
       AND (
         (SELECT org_id FROM employees WHERE id = NEW.actor_id) IS NOT NEW.org_id
         OR EXISTS (
           SELECT 1 FROM workflow_start_claims
           WHERE id = NEW.run_id AND actor_type = 'employee' AND actor_id = NEW.actor_id
         )
       )
     )
     OR (
       NEW.actor_type = 'human'
       AND (SELECT id FROM human_users WHERE id = NEW.actor_id) IS NULL
     );
  SELECT RAISE(ABORT, 'RESOLUTION_BUDGET_EXHAUSTED')
  WHERE (
    SELECT COUNT(*) FROM workflow_run_resolutions
    WHERE org_id = NEW.org_id AND task_id = NEW.task_id
  ) >= 3;
END;

CREATE TRIGGER workflow_run_resolutions_no_update
BEFORE UPDATE ON workflow_run_resolutions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER workflow_run_resolutions_no_delete
BEFORE DELETE ON workflow_run_resolutions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
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
     OR (OLD.state = 'created' AND NEW.state = 'claimed')
     OR ((NEW.state = 'released') IS NOT (NEW.release_reason IS NOT NULL));
  -- Release is allowed only for a reason the database can corroborate. A held run
  -- (LOOP_GUARD, TIMEOUT, denial, or a failed instance that had made progress) needs a
  -- recorded resolution; automatic crash recovery is capped at two per task.
  SELECT RAISE(ABORT, 'WORKFLOW_RELEASE_DENIED')
  WHERE NEW.state = 'released' AND NOT (
    (
      NEW.release_reason = 'completed'
      AND EXISTS (
        SELECT 1 FROM workflow_runs
        WHERE org_id = NEW.org_id AND id = NEW.id AND status = 'complete'
      )
    )
    OR (
      NEW.release_reason = 'never_registered'
      AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE org_id = NEW.org_id AND id = NEW.id)
    )
    OR (
      NEW.release_reason = 'instance_failed'
      AND EXISTS (
        SELECT 1 FROM workflow_runs
        WHERE org_id = NEW.org_id AND id = NEW.id AND status = 'paused'
          AND hold_reason = 'INSTANCE_FAILED' AND iteration = 0
      )
      AND (
        SELECT COUNT(*) FROM workflow_start_claims
        WHERE org_id = NEW.org_id AND task_id = NEW.task_id
          AND release_reason = 'instance_failed'
      ) < 2
    )
    OR (
      NEW.release_reason = 'resolved'
      AND EXISTS (
        SELECT 1 FROM workflow_run_resolutions WHERE org_id = NEW.org_id AND run_id = NEW.id
      )
    )
  );
END;

CREATE TRIGGER workflow_start_claims_no_delete
BEFORE DELETE ON workflow_start_claims
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE');
END;

-- Operator-provisioned mapping from a verified Cloudflare Access identity to a human user.
-- The Access subject is provisioned up front with an approval reference; there is no
-- first-use or email-only binding.
CREATE TABLE human_identities (
  id TEXT PRIMARY KEY CHECK (id GLOB 'hid_*' AND length(id) = 36),
  issuer TEXT NOT NULL CHECK (issuer GLOB 'https://?*.cloudflareaccess.com'),
  email TEXT NOT NULL CHECK (
    email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email GLOB '?*@?*'
  ),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  user_id TEXT NOT NULL REFERENCES human_users (id),
  attestation_ref TEXT NOT NULL CHECK (length(attestation_ref) BETWEEN 8 AND 200),
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
     OR NEW.subject IS NOT OLD.subject
     OR NEW.attestation_ref IS NOT OLD.attestation_ref
     OR NEW.created_at IS NOT OLD.created_at;
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
