-- Phase 4 projection of join codes and runtime sessions.
-- The plaintext join code and session token are never columns.

CREATE TABLE join_codes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  employee_id TEXT NOT NULL REFERENCES employees (id),
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses = 1),
  used_at TEXT,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX join_codes_hash_idx ON join_codes (code_hash);

CREATE INDEX join_codes_org_idx ON join_codes (org_id, id);

CREATE TRIGGER join_codes_same_org
BEFORE INSERT ON join_codes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM employees WHERE id = NEW.employee_id) IS NOT NEW.org_id;
END;

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  employee_id TEXT NOT NULL REFERENCES employees (id),
  runtime_binding_id TEXT NOT NULL REFERENCES runtime_bindings (id),
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX runtime_sessions_token_idx ON runtime_sessions (token_hash);

CREATE INDEX runtime_sessions_employee_idx ON runtime_sessions (org_id, employee_id, issued_at);

CREATE TRIGGER runtime_sessions_same_org
BEFORE INSERT ON runtime_sessions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM employees WHERE id = NEW.employee_id) IS NOT NEW.org_id
     OR (SELECT org_id FROM runtime_bindings WHERE id = NEW.runtime_binding_id) IS NOT NEW.org_id
     OR (SELECT employee_id FROM runtime_bindings WHERE id = NEW.runtime_binding_id) IS NOT NEW.employee_id;
END;
