-- Phase 1 schema.
-- Tenant-owned tables carry org_id. human_users and permissions are global catalogs.
-- Triggers reject a child row whose parent belongs to a different organization.

CREATE TABLE human_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_by_user_id TEXT NOT NULL REFERENCES human_users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX employees_org_idx ON employees (org_id, id);

CREATE TABLE runtime_bindings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  employee_id TEXT NOT NULL REFERENCES employees (id),
  runtime_type TEXT NOT NULL CHECK (runtime_type IN ('MUSE_BROWSER', 'CUE', 'A2A', 'API', 'BROWSER')),
  adapter_type TEXT NOT NULL CHECK (adapter_type IN ('browser', 'muse', 'cue', 'a2a', 'webhook')),
  external_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX runtime_bindings_employee_idx ON runtime_bindings (org_id, employee_id);

CREATE UNIQUE INDEX runtime_bindings_one_active
  ON runtime_bindings (org_id, employee_id)
  WHERE status = 'active';

CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL,
  parent_department_id TEXT REFERENCES departments (id),
  created_at TEXT NOT NULL
);

CREATE INDEX departments_org_idx ON departments (org_id, id);

CREATE TABLE permissions (
  code TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  system_role INTEGER NOT NULL CHECK (system_role IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, code)
);

CREATE INDEX roles_org_idx ON roles (org_id, id);

CREATE TABLE role_permissions (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  permission_code TEXT NOT NULL REFERENCES permissions (code),
  PRIMARY KEY (org_id, role_id, permission_code)
);

CREATE TABLE employee_roles (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  employee_id TEXT NOT NULL REFERENCES employees (id),
  role_id TEXT NOT NULL REFERENCES roles (id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (org_id, employee_id, role_id)
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  name TEXT NOT NULL,
  department_id TEXT REFERENCES departments (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL
);

CREATE INDEX rooms_org_idx ON rooms (org_id, id);

CREATE TABLE room_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  room_id TEXT NOT NULL REFERENCES rooms (id),
  employee_id TEXT NOT NULL REFERENCES employees (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'left')),
  joined_at TEXT NOT NULL,
  left_at TEXT
);

CREATE UNIQUE INDEX room_memberships_one_active
  ON room_memberships (org_id, room_id, employee_id)
  WHERE status = 'active';

CREATE INDEX room_memberships_room_idx ON room_memberships (org_id, room_id, status);

CREATE TRIGGER runtime_bindings_employee_org
BEFORE INSERT ON runtime_bindings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM employees WHERE id = NEW.employee_id) IS NOT NEW.org_id;
END;

CREATE TRIGGER departments_parent_org
BEFORE INSERT ON departments
FOR EACH ROW
WHEN NEW.parent_department_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM departments WHERE id = NEW.parent_department_id) IS NOT NEW.org_id;
END;

CREATE TRIGGER role_permissions_role_org
BEFORE INSERT ON role_permissions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM roles WHERE id = NEW.role_id) IS NOT NEW.org_id;
END;

CREATE TRIGGER employee_roles_same_org
BEFORE INSERT ON employee_roles
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM employees WHERE id = NEW.employee_id) IS NOT NEW.org_id
     OR (SELECT org_id FROM roles WHERE id = NEW.role_id) IS NOT NEW.org_id;
END;

CREATE TRIGGER rooms_department_org
BEFORE INSERT ON rooms
FOR EACH ROW
WHEN NEW.department_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM departments WHERE id = NEW.department_id) IS NOT NEW.org_id;
END;

CREATE TRIGGER room_memberships_same_org
BEFORE INSERT ON room_memberships
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'TENANT_MISMATCH')
  WHERE (SELECT org_id FROM rooms WHERE id = NEW.room_id) IS NOT NEW.org_id
     OR (SELECT org_id FROM employees WHERE id = NEW.employee_id) IS NOT NEW.org_id;
END;
