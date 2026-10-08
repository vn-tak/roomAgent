-- Phase 5 projection of the task engine. TaskDO remains the transition authority.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'CREATED',
      'QUEUED',
      'DELIVERED',
      'ACKNOWLEDGED',
      'WORKING',
      'SUBMITTED',
      'REVIEW',
      'REVISION',
      'APPROVED',
      'COMPLETED',
      'CANCELLED',
      'FAILED',
      'EXPIRED',
      'BLOCKED',
      'PAUSED'
    )
  ),
  creator_type TEXT NOT NULL CHECK (creator_type IN ('human', 'employee')),
  creator_id TEXT NOT NULL,
  assignee_id TEXT,
  room_id TEXT,
  handoff_count INTEGER NOT NULL CHECK (handoff_count >= 0 AND handoff_count <= 8),
  human_review_required INTEGER NOT NULL CHECK (human_review_required IN (0, 1)),
  pause_reason TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_org_idx ON tasks (org_id, id);

CREATE INDEX tasks_org_assignee_idx ON tasks (org_id, assignee_id);

CREATE TRIGGER tasks_same_org
BEFORE INSERT ON tasks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (
       NEW.assignee_id IS NOT NULL
       AND (SELECT org_id FROM employees WHERE id = NEW.assignee_id) IS NOT NEW.org_id
     )
     OR (
       NEW.room_id IS NOT NULL
       AND (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
     )
     OR (
       NEW.creator_type = 'employee'
       AND (SELECT org_id FROM employees WHERE id = NEW.creator_id) IS NOT NEW.org_id
     );
END;

CREATE TRIGGER tasks_assignee_org
BEFORE UPDATE OF assignee_id, room_id ON tasks
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (
      NEW.assignee_id IS NOT NULL
      AND (SELECT org_id FROM employees WHERE id = NEW.assignee_id) IS NOT NEW.org_id
    )
     OR (
      NEW.room_id IS NOT NULL
      AND (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
    );
END;

CREATE TABLE task_dependencies (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  depends_on TEXT NOT NULL REFERENCES tasks (id),
  PRIMARY KEY (org_id, task_id, depends_on)
);

CREATE INDEX task_dependencies_org_idx ON task_dependencies (org_id, task_id);

CREATE TRIGGER task_dependencies_same_org
BEFORE INSERT ON task_dependencies
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM tasks WHERE id = NEW.task_id) IS NOT NEW.org_id
     OR (SELECT org_id FROM tasks WHERE id = NEW.depends_on) IS NOT NEW.org_id;
END;
