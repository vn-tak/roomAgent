-- Phase 8 review and approval projection.
-- OrganizationDO remains the security-block authority.
-- Review, approval, domain, and audit rows are insert-only.

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1 AND artifact_version <= 1000000),
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'employee')),
  reviewer_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'REVISION_REQUIRED')),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1 AND policy_version <= 1000000),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, reviewer_type, reviewer_id, idempotency_key)
);

CREATE INDEX reviews_org_idx ON reviews (org_id, artifact_id);

CREATE TRIGGER reviews_same_org
BEFORE INSERT ON reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM artifacts WHERE id = NEW.artifact_id) IS NOT NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM artifact_versions
       WHERE org_id = NEW.org_id
         AND artifact_id = NEW.artifact_id
         AND version = NEW.artifact_version
     )
     OR (
       NEW.reviewer_type = 'employee'
       AND (SELECT org_id FROM employees WHERE id = NEW.reviewer_id) IS NOT NEW.org_id
     )
     OR (
       NEW.reviewer_type = 'human'
       AND (SELECT id FROM human_users WHERE id = NEW.reviewer_id) IS NULL
     );
END;

CREATE TRIGGER reviews_no_update
BEFORE UPDATE ON reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'GOVERNANCE_IMMUTABLE');
END;

CREATE TRIGGER reviews_no_delete
BEFORE DELETE ON reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'GOVERNANCE_IMMUTABLE');
END;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1 AND artifact_version <= 1000000),
  kind TEXT NOT NULL CHECK (kind IN ('final', 'security')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('PASS', 'DENY')),
  reason TEXT NOT NULL CHECK (reason IN ('ALLOWED', 'NO_SELF_APPROVAL')),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1 AND policy_version <= 1000000),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, actor_type, actor_id, idempotency_key),
  CHECK (
    (decision = 'PASS' AND reason = 'ALLOWED')
    OR (decision = 'DENY' AND reason = 'NO_SELF_APPROVAL')
  )
);

CREATE INDEX approvals_org_idx ON approvals (org_id, artifact_id, kind);

CREATE TRIGGER approvals_same_org
BEFORE INSERT ON approvals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM artifacts WHERE id = NEW.artifact_id) IS NOT NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM artifact_versions
       WHERE org_id = NEW.org_id
         AND artifact_id = NEW.artifact_id
         AND version = NEW.artifact_version
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

CREATE TRIGGER approvals_no_update
BEFORE UPDATE ON approvals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'GOVERNANCE_IMMUTABLE');
END;

CREATE TRIGGER approvals_no_delete
BEFORE DELETE ON approvals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'GOVERNANCE_IMMUTABLE');
END;

ALTER TABLE audit_events ADD COLUMN authorization_decision TEXT
  CHECK (
    authorization_decision IS NULL
    OR authorization_decision IN ('ALLOW', 'DENY')
  );

ALTER TABLE audit_events ADD COLUMN policy_version INTEGER
  CHECK (policy_version IS NULL OR (policy_version >= 1 AND policy_version <= 1000000));

ALTER TABLE audit_events ADD COLUMN before_digest TEXT
  CHECK (
    before_digest IS NULL
    OR (length(before_digest) = 64 AND before_digest NOT GLOB '*[^0-9a-f]*')
  );

ALTER TABLE audit_events ADD COLUMN after_digest TEXT
  CHECK (
    after_digest IS NULL
    OR (length(after_digest) = 64 AND after_digest NOT GLOB '*[^0-9a-f]*')
  );

ALTER TABLE audit_events ADD COLUMN correlation_id TEXT;

ALTER TABLE audit_events ADD COLUMN causation_id TEXT
  CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 8 AND 80);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER domain_events_no_update
BEFORE UPDATE ON domain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;

CREATE TRIGGER domain_events_no_delete
BEFORE DELETE ON domain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_IMMUTABLE');
END;
