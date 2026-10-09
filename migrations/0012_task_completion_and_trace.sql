ALTER TABLE tasks ADD COLUMN completion_policy TEXT NOT NULL DEFAULT 'NONE'
  CHECK (completion_policy IN ('NONE', 'ARTIFACT_APPROVED', 'QA_SECURITY', 'HUMAN_FINAL'));
ALTER TABLE tasks ADD COLUMN correlation_id TEXT NOT NULL
  DEFAULT 'corr_00000000000000000000000000000000';
UPDATE tasks SET correlation_id = 'corr_' || substr(id, 6);
