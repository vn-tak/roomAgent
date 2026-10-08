-- Phase 9 workflow run projection.
-- ProductionTaskWorkflow is the durable process.
-- OrganizationDO remains the permission authority.
-- ArtifactDO remains the review and approval authority.
-- TaskDO remains the task transition authority.
-- Identity columns stay fixed. Status, stage, and iteration may advance.

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  instance_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1 AND artifact_version <= 1000000),
  status TEXT NOT NULL CHECK (
    status IN (
      'running',
      'revision',
      'waiting_for_approval',
      'complete',
      'denied',
      'paused'
    )
  ),
  stage TEXT NOT NULL CHECK (
    stage IN (
      'worker_submit',
      'qa_review',
      'revision',
      'security',
      'human_approval',
      'complete'
    )
  ),
  iteration INTEGER NOT NULL CHECK (iteration >= 0 AND iteration <= 8),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, instance_id)
);

CREATE INDEX workflow_runs_org_idx ON workflow_runs (org_id, id);

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

CREATE TRIGGER workflow_runs_no_delete
BEFORE DELETE ON workflow_runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE');
END;

CREATE TRIGGER workflow_runs_status_only
BEFORE UPDATE ON workflow_runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_IMMUTABLE')
  WHERE NEW.id IS NOT OLD.id
     OR NEW.org_id IS NOT OLD.org_id
     OR NEW.instance_id IS NOT OLD.instance_id
     OR NEW.task_id IS NOT OLD.task_id
     OR NEW.artifact_id IS NOT OLD.artifact_id
     OR NEW.artifact_version IS NOT OLD.artifact_version
     OR NEW.created_at IS NOT OLD.created_at
     OR NEW.iteration < OLD.iteration;
END;
