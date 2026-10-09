-- Forward-only integrity guard; existing historical rows are not rewritten.
CREATE TRIGGER artifacts_task_room_integrity
BEFORE INSERT ON artifacts
FOR EACH ROW WHEN NEW.task_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ROOM_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks
    WHERE org_id = NEW.org_id AND id = NEW.task_id AND room_id = NEW.room_id
  );
END;

CREATE TABLE human_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  user_id TEXT NOT NULL REFERENCES human_users (id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX human_sessions_org_user ON human_sessions (org_id, user_id);

CREATE TRIGGER human_session_owner
BEFORE INSERT ON human_sessions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM organizations WHERE id = NEW.org_id AND created_by_user_id = NEW.user_id
  );
END;
