-- Phase 7 artifact projection. ArtifactDO remains the version authority.
-- Version rows are immutable. The canonical version is a pointer on artifacts.
-- domain_events and audit_events are rebuilt because SQLite cannot drop a CHECK.

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  room_id TEXT NOT NULL,
  task_id TEXT,
  creator_type TEXT NOT NULL CHECK (creator_type IN ('human', 'employee')),
  creator_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL CHECK (canonical_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX artifacts_org_idx ON artifacts (org_id, room_id);

CREATE TRIGGER artifacts_same_org
BEFORE INSERT ON artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
     OR (
       NEW.task_id IS NOT NULL
       AND (SELECT org_id FROM tasks WHERE id = NEW.task_id) IS NOT NEW.org_id
     )
     OR (
       NEW.creator_type = 'employee'
       AND (SELECT org_id FROM employees WHERE id = NEW.creator_id) IS NOT NEW.org_id
     )
     OR (
       NEW.creator_type = 'human'
       AND (SELECT id FROM human_users WHERE id = NEW.creator_id) IS NULL
     );
END;

CREATE TRIGGER artifacts_pointer_only
BEFORE UPDATE ON artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE')
  WHERE NEW.id IS NOT OLD.id
     OR NEW.org_id IS NOT OLD.org_id
     OR NEW.room_id IS NOT OLD.room_id
     OR NEW.task_id IS NOT OLD.task_id
     OR NEW.creator_type IS NOT OLD.creator_type
     OR NEW.creator_id IS NOT OLD.creator_id
     OR NEW.created_at IS NOT OLD.created_at
     OR NEW.canonical_version < OLD.canonical_version;
END;

CREATE TRIGGER artifacts_no_delete
BEFORE DELETE ON artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;

CREATE TABLE artifact_versions (
  org_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  version INTEGER NOT NULL CHECK (version >= 1 AND version <= 1000000),
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT NOT NULL CHECK (
    media_type IN (
      'text/plain',
      'text/markdown',
      'application/json',
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'audio/mpeg',
      'video/mp4'
    )
  ),
  size INTEGER NOT NULL CHECK (size >= 1 AND size <= 1048576),
  filename TEXT CHECK (
    filename IS NULL
    OR (
      length(filename) BETWEEN 1 AND 80
      AND filename NOT LIKE '%..%'
      AND filename NOT LIKE '%/%'
      AND filename NOT GLOB '*\*'
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, artifact_id, version)
);

CREATE TRIGGER artifact_versions_same_org
BEFORE INSERT ON artifact_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM artifacts WHERE id = NEW.artifact_id) IS NOT NEW.org_id
     OR NEW.r2_key IS NOT (
       'org/' || NEW.org_id || '/project/' ||
       (SELECT room_id FROM artifacts WHERE id = NEW.artifact_id) ||
       '/artifact/' || NEW.artifact_id || '/v' || NEW.version
     );
END;

CREATE TRIGGER artifact_versions_no_update
BEFORE UPDATE ON artifact_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;

CREATE TRIGGER artifact_versions_no_delete
BEFORE DELETE ON artifact_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_IMMUTABLE');
END;

CREATE TABLE domain_events_v2 (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  room_id TEXT,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task', 'artifact')),
  subject_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 1000000),
  correlation_id TEXT NOT NULL,
  causation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 80
  ),
  occurred_at TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 4000),
  created_at TEXT NOT NULL
);

INSERT INTO domain_events_v2 (
  event_id, org_id, room_id, type, actor_type, actor_id, subject_type, subject_id, seq,
  correlation_id, causation_id, idempotency_key, occurred_at, body, created_at
)
SELECT
  event_id, org_id, room_id, type, actor_type, actor_id, subject_type, subject_id, seq,
  correlation_id, causation_id, idempotency_key, occurred_at, body, created_at
FROM domain_events;

DROP TRIGGER domain_events_same_org;

DROP TABLE domain_events;

ALTER TABLE domain_events_v2 RENAME TO domain_events;

CREATE INDEX domain_events_org_idx ON domain_events (org_id, subject_id);

CREATE TRIGGER domain_events_same_org
BEFORE INSERT ON domain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (
       NEW.subject_type = 'task'
       AND (SELECT org_id FROM tasks WHERE id = NEW.subject_id) IS NOT NEW.org_id
     )
     OR (
       NEW.subject_type = 'artifact'
       AND (SELECT org_id FROM artifacts WHERE id = NEW.subject_id) IS NOT NEW.org_id
     )
     OR (
       NEW.room_id IS NOT NULL
       AND (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
     );
END;

CREATE TABLE audit_events_v2 (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task', 'artifact')),
  subject_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 1000000),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

INSERT INTO audit_events_v2 (
  event_id, org_id, type, actor_type, actor_id, subject_type, subject_id, seq, occurred_at, recorded_at
)
SELECT
  event_id, org_id, type, actor_type, actor_id, subject_type, subject_id, seq, occurred_at, recorded_at
FROM audit_events;

DROP TRIGGER audit_events_same_org;

DROP TABLE audit_events;

ALTER TABLE audit_events_v2 RENAME TO audit_events;

CREATE INDEX audit_events_org_idx ON audit_events (org_id, subject_id);

CREATE TRIGGER audit_events_same_org
BEFORE INSERT ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (
       NEW.subject_type = 'task'
       AND (SELECT org_id FROM tasks WHERE id = NEW.subject_id) IS NOT NEW.org_id
     )
     OR (
       NEW.subject_type = 'artifact'
       AND (SELECT org_id FROM artifacts WHERE id = NEW.subject_id) IS NOT NEW.org_id
     );
END;
