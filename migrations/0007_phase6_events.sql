-- Phase 6 event projection. TaskDO remains the transition authority.
-- The queue is at-least-once. event_id is the idempotency key for both tables.

CREATE TABLE domain_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  room_id TEXT,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type = 'task'),
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

CREATE INDEX domain_events_org_idx ON domain_events (org_id, subject_id);

CREATE TRIGGER domain_events_same_org
BEFORE INSERT ON domain_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM tasks WHERE id = NEW.subject_id) IS NOT NEW.org_id
     OR (
       NEW.room_id IS NOT NULL
       AND (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
     );
END;

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type = 'task'),
  subject_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 1000000),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX audit_events_org_idx ON audit_events (org_id, subject_id);

CREATE TRIGGER audit_events_same_org
BEFORE INSERT ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL
     OR (SELECT org_id FROM tasks WHERE id = NEW.subject_id) IS NOT NEW.org_id;
END;

CREATE TABLE dead_letters (
  message_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  event_id TEXT,
  org_id TEXT,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  recorded_at TEXT NOT NULL
);

CREATE INDEX dead_letters_org_idx ON dead_letters (org_id, message_id);

CREATE TRIGGER dead_letters_same_org
BEFORE INSERT ON dead_letters
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE NEW.org_id IS NOT NULL
    AND (SELECT id FROM organizations WHERE id = NEW.org_id) IS NULL;
END;
