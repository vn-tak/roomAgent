-- Phase 2 authority projection. The OrganizationDO is the source of truth.
-- These tables are the cross-organization query copy.

CREATE TABLE organization_policy (
  org_id TEXT PRIMARY KEY REFERENCES organizations (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
);

CREATE TABLE security_blocks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason TEXT NOT NULL,
  evidence TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'cleared')),
  created_at TEXT NOT NULL,
  cleared_at TEXT,
  cleared_by TEXT
);

CREATE INDEX security_blocks_org_idx ON security_blocks (org_id, id);

CREATE INDEX security_blocks_resource_idx
  ON security_blocks (org_id, resource_type, resource_id, state);

CREATE TABLE security_overrides (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations (id),
  block_id TEXT NOT NULL REFERENCES security_blocks (id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'employee')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX security_overrides_block_idx ON security_overrides (org_id, block_id);
