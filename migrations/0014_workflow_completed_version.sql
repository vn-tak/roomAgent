ALTER TABLE workflow_runs ADD COLUMN completed_artifact_version INTEGER
  CHECK (completed_artifact_version IS NULL OR completed_artifact_version BETWEEN 1 AND 1000000);

CREATE TRIGGER workflow_completed_version_integrity
BEFORE UPDATE OF completed_artifact_version ON workflow_runs
FOR EACH ROW WHEN NEW.completed_artifact_version IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM artifact_versions
    WHERE org_id = NEW.org_id AND artifact_id = NEW.artifact_id
      AND version = NEW.completed_artifact_version
  );
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE')
  WHERE OLD.completed_artifact_version IS NOT NULL
    AND NEW.completed_artifact_version IS NOT OLD.completed_artifact_version;
END;
