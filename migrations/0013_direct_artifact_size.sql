-- Widen only the direct-upload projection bound. Inline RPC remains capped at 1 MiB.
-- Referencing tenant guards are restored unchanged after the SQLite table rebuild.
DROP TRIGGER reviews_same_org;
DROP TRIGGER approvals_same_org;
DROP TRIGGER workflow_runs_same_org;

CREATE TABLE artifact_versions_v2 (
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
  size INTEGER NOT NULL CHECK (size >= 1 AND size <= 104857600),
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
INSERT INTO artifact_versions_v2
  (org_id, artifact_id, version, r2_key, sha256, media_type, size, filename, created_at)
SELECT org_id, artifact_id, version, r2_key, sha256, media_type, size, filename, created_at
FROM artifact_versions;
DROP TABLE artifact_versions;
ALTER TABLE artifact_versions_v2 RENAME TO artifact_versions;

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

CREATE TRIGGER workflow_runs_same_org
BEFORE INSERT ON workflow_runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM tasks WHERE id = NEW.task_id) IS NOT NEW.org_id
     OR (SELECT org_id FROM artifacts WHERE id = NEW.artifact_id) IS NOT NEW.org_id
     OR NOT EXISTS (
       SELECT 1 FROM artifact_versions
       WHERE org_id = NEW.org_id
         AND artifact_id = NEW.artifact_id
         AND version = NEW.artifact_version
     );
END;
