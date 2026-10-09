import { DurableObject } from "cloudflare:workers";
import { DomainError, createId, isId, randomSecret, sha256Hex } from "@ai-company/domain";
import {
  actorPermissions,
  decideAuthorization,
  isPermissionCode,
  rolesConflict,
  type ActorType,
  type AuthorityBlock,
  type AuthorityDecision,
  type AuthorityEmployee,
  type AuthoritySnapshot,
} from "@ai-company/policy";

interface OrganizationEnv {
  DB: D1Database;
}

interface ActorCommand {
  orgId: string;
  actorType: ActorType;
  actorId: string;
}

export interface AuthorizeCommand extends ActorCommand {
  action: string;
  resourceType: string;
  resourceId: string;
  creatorId?: string | null;
  implementationActorId?: string | null;
}

export interface AssignRoleCommand extends ActorCommand {
  employeeId: string;
  roleId: string;
}

export interface SuspendEmployeeCommand extends ActorCommand {
  employeeId: string;
}

export interface SecurityBlockCommand extends ActorCommand {
  resourceType: string;
  resourceId: string;
  severity: string;
  reason: string;
  evidence?: string | null;
}

export interface BlockCommand extends ActorCommand {
  blockId: string;
  reason?: string;
}

export interface IssueJoinCodeCommand extends ActorCommand {
  employeeId: string;
  scopes: string[];
  ttlSeconds: number;
}

export interface IssueJoinCodeResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  joinId: string | null;
  code: string | null;
  expiresAt: string | null;
  joinToken?: string;
  joinPath?: string;
}

export interface RevokeJoinCodeCommand extends ActorCommand {
  joinId: string;
}

export interface RevokeJoinCodeResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  joinId: string | null;
}

export interface ConsumeJoinCodeCommand {
  orgId: string;
  employeeId: string;
  code: string;
}

export interface JoinConsumeResult {
  decision: "ALLOW" | "DENY";
  reason: string;
  joinId: string | null;
  employeeId: string | null;
  scopes: string[];
}

type MetaRow = {
  org_id: string;
  owner_human_id: string;
  policy_version: number;
};

const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const JOIN_WINDOW_MS = 60_000;
const JOIN_FAILURE_LIMIT = 5;

type JoinRow = {
  id: string;
  employee_id: string;
  status: string;
  expires_at: string;
  scopes: string;
};

type FailureRow = {
  window_started_at: number;
  failures: number;
};

type ClaimKind = "active" | "expired" | "revoked" | "consumed" | "missing";

function deny(reason: AuthorityDecision["reason"], policyVersion: number): AuthorityDecision {
  return { decision: "DENY", reason, policy_version: policyVersion };
}

function allow(policyVersion: number): AuthorityDecision {
  return { decision: "ALLOW", reason: "ALLOWED", policy_version: policyVersion };
}

export class OrganizationDO extends DurableObject<OrganizationEnv> {
  constructor(ctx: DurableObjectState, env: OrganizationEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  async authorize(command: AuthorizeCommand): Promise<AuthorityDecision> {
    const boundary = this.boundary(command.orgId);
    if (boundary) {
      return boundary;
    }
    if (!(await this.ensureHydrated(command.orgId))) {
      return deny("TENANT_BOUNDARY", 0);
    }
    return decideAuthorization(this.snapshot(), command);
  }

  // Trusted RPC bootstrap only; HTTP never accepts a claimed human identity.
  async issueHumanSession(command: ActorCommand & { ttlSeconds: number }) {
    const gate = await this.gate(command, "runtime.bind");
    if (gate.decision === "DENY" || command.actorType !== "human") {
      return {
        decision: "DENY" as const,
        reason: "PERMISSION_DENIED",
        token: null,
        sessionId: null,
      };
    }
    if (
      !Number.isInteger(command.ttlSeconds) ||
      command.ttlSeconds < 1 ||
      command.ttlSeconds > 3600
    ) {
      return { decision: "DENY" as const, reason: "INVALID_INPUT", token: null, sessionId: null };
    }
    const token = `hum_${randomSecret()}`;
    const sessionId = createId("ses");
    const expiresAt = new Date(Date.now() + command.ttlSeconds * 1000).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO human_sessions (id, org_id, user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(
        sessionId,
        command.orgId,
        command.actorId,
        await sha256Hex(token),
        expiresAt,
        this.now(),
      )
      .run();
    return { decision: "ALLOW" as const, reason: "ALLOWED", token, sessionId, expiresAt };
  }

  async verifyHumanSession(command: { orgId: string; token: string }) {
    if (this.boundary(command.orgId) || !/^hum_[0-9a-f]{64}$/.test(command.token)) {
      return { decision: "DENY" as const, reason: "SESSION_INVALID", userId: null };
    }
    const row = await this.env.DB.prepare(
      `SELECT s.user_id FROM human_sessions s
       JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
       WHERE s.org_id = ? AND s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
      .bind(command.orgId, await sha256Hex(command.token), this.now())
      .first<{ user_id: string }>();
    return row
      ? { decision: "ALLOW" as const, reason: "ALLOWED", userId: row.user_id }
      : { decision: "DENY" as const, reason: "SESSION_INVALID", userId: null };
  }

  async revokeHumanSession(command: ActorCommand & { sessionId: string }) {
    const gate = await this.gate(command, "runtime.bind");
    if (gate.decision === "DENY") return gate;
    if (command.actorType !== "human") return deny("NO_PERMISSION", gate.policy_version);
    await this.env.DB.prepare(
      `UPDATE human_sessions SET revoked_at = ? WHERE org_id = ? AND id = ? AND user_id = ?`,
    )
      .bind(this.now(), command.orgId, command.sessionId, command.actorId)
      .run();
    return gate;
  }

  async assignRole(command: AssignRoleCommand): Promise<AuthorityDecision> {
    const gate = await this.gate(command, "agent.role.assign");
    if (gate.decision === "DENY") {
      return gate;
    }
    if (!isId(command.employeeId, "emp") || !isId(command.roleId, "role")) {
      return deny("TENANT_BOUNDARY", this.policyVersion());
    }

    let conflict = false;
    let missing = false;
    const applied = this.apply(() => {
      if (!this.employeeRow(command.employeeId) || !this.roleRow(command.roleId)) {
        missing = true;
        return null;
      }
      if (this.hasRole(command.employeeId, command.roleId)) {
        return null;
      }
      const codes = this.roleCodes(command.employeeId);
      const role = this.roleRow(command.roleId);
      if (!role || rolesConflict([...codes, role.code], this.permissionsByRoleCode())) {
        conflict = true;
        return null;
      }
      return this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`,
          command.employeeId,
          command.roleId,
        );
        return () => {
          this.ctx.storage.sql.exec(
            `DELETE FROM employee_roles WHERE employee_id = ? AND role_id = ?`,
            command.employeeId,
            command.roleId,
          );
        };
      });
    });
    if (missing) {
      return deny("TENANT_BOUNDARY", this.policyVersion());
    }
    if (conflict) {
      return deny("ROLE_CONFLICT", this.policyVersion());
    }
    if (!applied) {
      return allow(this.policyVersion());
    }
    await this.project(applied, [
      this.env.DB.prepare(
        `INSERT INTO employee_roles (org_id, employee_id, role_id, assigned_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(command.orgId, command.employeeId, command.roleId, this.now()),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return allow(applied.version);
  }

  async revokeRole(command: AssignRoleCommand): Promise<AuthorityDecision> {
    const gate = await this.gate(command, "agent.role.assign");
    if (gate.decision === "DENY") {
      return gate;
    }
    const applied = this.apply(() => {
      if (!this.hasRole(command.employeeId, command.roleId)) {
        return null;
      }
      return this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `DELETE FROM employee_roles WHERE employee_id = ? AND role_id = ?`,
          command.employeeId,
          command.roleId,
        );
        return () => {
          this.ctx.storage.sql.exec(
            `INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`,
            command.employeeId,
            command.roleId,
          );
        };
      });
    });
    if (!applied) {
      return allow(this.policyVersion());
    }
    await this.project(applied, [
      this.env.DB.prepare(
        `DELETE FROM employee_roles WHERE org_id = ? AND employee_id = ? AND role_id = ?`,
      ).bind(command.orgId, command.employeeId, command.roleId),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return allow(applied.version);
  }

  async suspendEmployee(command: SuspendEmployeeCommand): Promise<AuthorityDecision> {
    const gate = await this.gate(command, "agent.remove");
    if (gate.decision === "DENY") {
      return gate;
    }
    if (!isId(command.employeeId, "emp")) {
      return deny("TENANT_BOUNDARY", this.policyVersion());
    }
    let missing = false;
    const applied = this.apply(() => {
      const employee = this.employeeRow(command.employeeId);
      if (!employee) {
        missing = true;
        return null;
      }
      if (employee.status === "suspended") {
        return null;
      }
      return this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `UPDATE employees SET status = 'suspended' WHERE id = ?`,
          command.employeeId,
        );
        return () => {
          this.ctx.storage.sql.exec(
            `UPDATE employees SET status = 'active' WHERE id = ?`,
            command.employeeId,
          );
        };
      });
    });
    if (missing) {
      return deny("TENANT_BOUNDARY", this.policyVersion());
    }
    if (!applied) {
      return allow(this.policyVersion());
    }
    const at = this.now();
    await this.project(applied, [
      this.env.DB.prepare(
        `UPDATE employees SET status = 'suspended', updated_at = ? WHERE org_id = ? AND id = ?`,
      ).bind(at, command.orgId, command.employeeId),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return allow(applied.version);
  }

  async createSecurityBlock(
    command: SecurityBlockCommand,
  ): Promise<AuthorityDecision & { block_id?: string }> {
    this.assertBlockShape(command);
    const gate = await this.gate(command, "security.block.create");
    if (gate.decision === "DENY") {
      return gate;
    }
    const blockId = createId("blk");
    const at = this.now();
    const applied = this.apply(() =>
      this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO security_blocks (
             id, resource_type, resource_id, created_by, severity, reason, evidence, state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
          blockId,
          command.resourceType,
          command.resourceId,
          command.actorId,
          command.severity,
          command.reason.trim(),
          command.evidence ?? null,
          at,
        );
        return () => {
          this.ctx.storage.sql.exec(`DELETE FROM security_blocks WHERE id = ?`, blockId);
        };
      }),
    );
    if (!applied) {
      return allow(this.policyVersion());
    }
    await this.project(applied, [
      this.env.DB.prepare(
        `INSERT INTO security_blocks (
           id, org_id, resource_type, resource_id, created_by, severity, reason, evidence, state, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      ).bind(
        blockId,
        command.orgId,
        command.resourceType,
        command.resourceId,
        command.actorId,
        command.severity,
        command.reason.trim(),
        command.evidence ?? null,
        at,
      ),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return { ...allow(applied.version), block_id: blockId };
  }

  async clearSecurityBlock(command: BlockCommand): Promise<AuthorityDecision> {
    const gate = await this.gate(command, "security.block.clear");
    if (gate.decision === "DENY") {
      return gate;
    }
    const permissions = this.snapshotPermissions(command.actorType, command.actorId);
    let missing = false;
    let forbidden = false;
    const at = this.now();
    const applied = this.apply(() => {
      const block = this.blockRow(command.blockId);
      if (!block) {
        missing = true;
        return null;
      }
      if (block.state === "cleared") {
        return null;
      }
      if (block.created_by !== command.actorId && !permissions.has("security.approve")) {
        forbidden = true;
        return null;
      }
      return this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `UPDATE security_blocks
           SET state = 'cleared', cleared_at = ?, cleared_by = ?
           WHERE id = ?`,
          at,
          command.actorId,
          command.blockId,
        );
        return () => {
          this.ctx.storage.sql.exec(
            `UPDATE security_blocks
             SET state = 'active', cleared_at = NULL, cleared_by = NULL
             WHERE id = ?`,
            command.blockId,
          );
        };
      });
    });
    if (missing || forbidden) {
      return deny("NO_PERMISSION", this.policyVersion());
    }
    if (!applied) {
      return allow(this.policyVersion());
    }
    await this.project(applied, [
      this.env.DB.prepare(
        `UPDATE security_blocks
         SET state = 'cleared', cleared_at = ?, cleared_by = ?
         WHERE org_id = ? AND id = ?`,
      ).bind(at, command.actorId, command.orgId, command.blockId),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return allow(applied.version);
  }

  async overrideSecurityBlock(command: BlockCommand): Promise<AuthorityDecision> {
    const reason = command.reason?.trim() ?? "";
    if (reason.length < 1 || reason.length > 500) {
      throw new DomainError("INVALID_INPUT", "Override reason is required.");
    }
    const gate = await this.gate(command, "security.block.override");
    if (gate.decision === "DENY") {
      return gate;
    }
    const overrideId = createId("ovr");
    const at = this.now();
    let missing = false;
    const applied = this.apply(() => {
      const block = this.blockRow(command.blockId);
      if (!block || block.state !== "active") {
        missing = true;
        return null;
      }
      const existing = this.ctx.storage.sql
        .exec<{ id: string }>(
          `SELECT id FROM security_overrides WHERE block_id = ? LIMIT 1`,
          command.blockId,
        )
        .toArray()[0];
      if (existing) {
        return null;
      }
      return this.withVersion(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO security_overrides (id, block_id, actor_type, actor_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          overrideId,
          command.blockId,
          command.actorType,
          command.actorId,
          reason,
          at,
        );
        return () => {
          this.ctx.storage.sql.exec(`DELETE FROM security_overrides WHERE id = ?`, overrideId);
        };
      });
    });
    if (missing) {
      return deny("NO_PERMISSION", this.policyVersion());
    }
    if (!applied) {
      return allow(this.policyVersion());
    }
    await this.project(applied, [
      this.env.DB.prepare(
        `INSERT INTO security_overrides (id, org_id, block_id, actor_type, actor_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        overrideId,
        command.orgId,
        command.blockId,
        command.actorType,
        command.actorId,
        reason,
        at,
      ),
      this.policyProjection(command.orgId, applied.version),
    ]);
    return allow(applied.version);
  }

  async issueJoinCode(command: IssueJoinCodeCommand): Promise<IssueJoinCodeResult> {
    const gate = await this.gate(command, "runtime.bind");
    if (gate.decision === "DENY") {
      return issueDeny(gate.reason);
    }
    const scopes = normalizeScopes(command.scopes);
    if (
      !scopes ||
      !isId(command.employeeId, "emp") ||
      !Number.isInteger(command.ttlSeconds) ||
      command.ttlSeconds < 0 ||
      command.ttlSeconds > 600
    ) {
      return issueDeny("INVALID_INPUT");
    }
    const status = await this.targetStatus(command.orgId, command.employeeId);
    if (!status) {
      return issueDeny("TENANT_BOUNDARY");
    }
    if (status === "suspended") {
      return issueDeny("SUSPENDED_AGENT_DENY");
    }
    const joinId = createId("join");
    const code = randomSecret();
    const codeHash = await sha256Hex(code);
    const createdAt = this.now();
    const expiresAt = new Date(Date.now() + command.ttlSeconds * 1000).toISOString();
    const scopeText = JSON.stringify(scopes);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO join_codes (
          id, employee_id, code_hash, status, expires_at, scopes, created_at, used_at, revoked_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, NULL)`,
        joinId,
        command.employeeId,
        codeHash,
        expiresAt,
        scopeText,
        createdAt,
      );
    });
    try {
      const inserted = await this.env.DB.prepare(
        `INSERT INTO join_codes (
          id, org_id, employee_id, code_hash, status, expires_at, max_uses, used_at, scopes, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, 'active', ?, 1, NULL, ?, ?, NULL)`,
      )
        .bind(joinId, command.orgId, command.employeeId, codeHash, expiresAt, scopeText, createdAt)
        .run();
      if (inserted.meta.changes !== 1) {
        this.deleteJoin(joinId);
        return issueDeny("TENANT_BOUNDARY");
      }
    } catch (error) {
      this.deleteJoin(joinId);
      if (storageText(error).includes("TENANT_MISMATCH")) {
        return issueDeny("TENANT_BOUNDARY");
      }
      throw error;
    }
    return {
      decision: "ALLOW",
      reason: "ALLOWED",
      joinId,
      code,
      expiresAt,
      joinToken: code,
      joinPath: `/j/${code}`,
    };
  }

  async revokeJoinCode(command: RevokeJoinCodeCommand): Promise<RevokeJoinCodeResult> {
    const gate = await this.gate(command, "runtime.revoke");
    if (gate.decision === "DENY") {
      return { decision: "DENY", reason: gate.reason, joinId: null };
    }
    if (!isId(command.joinId, "join")) {
      return { decision: "DENY", reason: "TENANT_BOUNDARY", joinId: null };
    }
    const at = this.now();
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.joinById(command.joinId);
      if (!row || row.status !== "active") {
        return;
      }
      this.ctx.storage.sql.exec(
        `UPDATE join_codes SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`,
        at,
        command.joinId,
      );
      changed = true;
    });
    if (!changed) {
      const row = this.joinById(command.joinId);
      if (!row) {
        return { decision: "DENY", reason: "TENANT_BOUNDARY", joinId: null };
      }
      return { decision: "ALLOW", reason: "ALLOWED", joinId: row.id };
    }
    try {
      await this.env.DB.prepare(
        `UPDATE join_codes
         SET status = 'revoked', revoked_at = ?
         WHERE org_id = ? AND id = ? AND status = 'active'`,
      )
        .bind(at, command.orgId, command.joinId)
        .run();
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE join_codes SET status = 'active', revoked_at = NULL WHERE id = ?`,
          command.joinId,
        );
      });
      throw error;
    }
    return { decision: "ALLOW", reason: "ALLOWED", joinId: command.joinId };
  }

  async consumeJoinCode(command: ConsumeJoinCodeCommand): Promise<JoinConsumeResult> {
    const boundary = this.boundary(command.orgId);
    if (boundary) {
      return consumeDeny(boundary.reason);
    }
    if (!(await this.ensureHydrated(command.orgId))) {
      return consumeDeny("TENANT_BOUNDARY");
    }
    if (!isId(command.employeeId, "emp")) {
      this.noteFailure(command.employeeId);
      return consumeDeny("TENANT_BOUNDARY");
    }
    if (this.throttled(command.employeeId)) {
      return consumeDeny("THROTTLED");
    }
    if (!/^[0-9a-f]{64}$/.test(command.code)) {
      this.noteFailure(command.employeeId);
      return consumeDeny("INVALID_CODE");
    }
    const hash = await sha256Hex(command.code);
    const local = this.joinByHash(hash);
    if (!local) {
      const remote = await this.env.DB.prepare(`SELECT org_id FROM join_codes WHERE code_hash = ?`)
        .bind(hash)
        .first<{ org_id: string }>();
      this.noteFailure(command.employeeId);
      return consumeDeny(remote && remote.org_id !== command.orgId ? "WRONG_ORG" : "INVALID_CODE");
    }
    if (local.employee_id !== command.employeeId) {
      this.noteFailure(command.employeeId);
      return consumeDeny("WRONG_EMPLOYEE");
    }
    const status = await this.targetStatus(command.orgId, command.employeeId);
    if (!status) {
      this.noteFailure(command.employeeId);
      return consumeDeny("TENANT_BOUNDARY");
    }
    if (status === "suspended") {
      this.noteFailure(command.employeeId);
      return consumeDeny("SUSPENDED_AGENT_DENY");
    }
    const nowIso = this.now();
    const claimed = this.claimJoin(local.id, nowIso);
    if (claimed.kind === "active") {
      try {
        const updated = await this.env.DB.prepare(
          `UPDATE join_codes
           SET status = 'consumed', used_at = ?
           WHERE org_id = ? AND id = ? AND status = 'active'`,
        )
          .bind(nowIso, command.orgId, local.id)
          .run();
        if (updated.meta.changes !== 1) {
          this.ctx.storage.transactionSync(() => {
            claimed.undo();
          });
          return consumeDeny("INVALID_CODE");
        }
      } catch (error) {
        this.ctx.storage.transactionSync(() => {
          claimed.undo();
        });
        throw error;
      }
      return {
        decision: "ALLOW",
        reason: "ALLOWED",
        joinId: local.id,
        employeeId: local.employee_id,
        scopes: parseScopes(local.scopes),
      };
    }
    if (claimed.kind === "expired") {
      try {
        await this.env.DB.prepare(
          `UPDATE join_codes SET status = 'expired' WHERE org_id = ? AND id = ? AND status = 'active'`,
        )
          .bind(command.orgId, local.id)
          .run();
      } catch (error) {
        this.ctx.storage.transactionSync(() => {
          claimed.undo();
        });
        throw error;
      }
    }
    this.noteFailure(command.employeeId);
    const reason =
      claimed.kind === "expired"
        ? "EXPIRED"
        : claimed.kind === "revoked"
          ? "REVOKED"
          : claimed.kind === "consumed"
            ? "ALREADY_USED"
            : "INVALID_CODE";
    return consumeDeny(reason);
  }

  private ensureSchema(): void {
    const statements = [
      `CREATE TABLE IF NOT EXISTS meta (
        org_id TEXT PRIMARY KEY,
        owner_human_id TEXT NOT NULL,
        policy_version INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS role_permissions (
        role_id TEXT NOT NULL,
        permission_code TEXT NOT NULL,
        PRIMARY KEY (role_id, permission_code)
      )`,
      `CREATE TABLE IF NOT EXISTS employee_roles (
        employee_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        PRIMARY KEY (employee_id, role_id)
      )`,
      `CREATE TABLE IF NOT EXISTS security_blocks (
        id TEXT PRIMARY KEY,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        severity TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cleared_at TEXT,
        cleared_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS security_overrides (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS join_codes (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS join_codes_hash ON join_codes (code_hash)`,
      `CREATE TABLE IF NOT EXISTS join_redemption_failures (
        employee_id TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        failures INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS join_failures (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        window_started_at INTEGER NOT NULL,
        failures INTEGER NOT NULL
      )`,
    ];
    for (const statement of statements) {
      this.ctx.storage.sql.exec(statement);
    }
  }

  private boundary(orgId: string): AuthorityDecision | null {
    const bound = this.boundOrgId();
    if (!bound || orgId !== bound) {
      return deny("TENANT_BOUNDARY", this.isReady() ? this.policyVersion() : 0);
    }
    return null;
  }

  private boundOrgId(): string | null {
    const name = this.ctx.id.name ?? "";
    if (!name.startsWith("org:")) {
      return null;
    }
    const orgId = name.slice("org:".length);
    return isId(orgId, "org") ? orgId : null;
  }

  private async gate(command: ActorCommand, action: string): Promise<AuthorityDecision> {
    const boundary = this.boundary(command.orgId);
    if (boundary) {
      return boundary;
    }
    if (!(await this.ensureHydrated(command.orgId))) {
      return deny("TENANT_BOUNDARY", 0);
    }
    return decideAuthorization(this.snapshot(), {
      ...command,
      action,
      resourceType: "organization",
      resourceId: command.orgId,
    });
  }

  private async ensureHydrated(orgId: string): Promise<boolean> {
    if (this.isReady()) {
      return true;
    }
    const organization = await this.env.DB.prepare(
      `SELECT created_by_user_id AS owner_id FROM organizations WHERE id = ?`,
    )
      .bind(orgId)
      .first<{ owner_id: string }>();
    if (!organization) {
      return false;
    }
    const employees = await this.env.DB.prepare(`SELECT id, status FROM employees WHERE org_id = ?`)
      .bind(orgId)
      .all<{ id: string; status: string }>();
    const roles = await this.env.DB.prepare(`SELECT id, code FROM roles WHERE org_id = ?`)
      .bind(orgId)
      .all<{ id: string; code: string }>();
    const permissions = await this.env.DB.prepare(
      `SELECT role_id, permission_code FROM role_permissions WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{ role_id: string; permission_code: string }>();
    const links = await this.env.DB.prepare(
      `SELECT employee_id, role_id FROM employee_roles WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{ employee_id: string; role_id: string }>();
    const policy = await this.env.DB.prepare(
      `SELECT version FROM organization_policy WHERE org_id = ?`,
    )
      .bind(orgId)
      .first<{ version: number }>();
    const blocks = await this.env.DB.prepare(
      `SELECT id, resource_type, resource_id, created_by, severity, reason, evidence, state, created_at, cleared_at, cleared_by
       FROM security_blocks WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{
        id: string;
        resource_type: string;
        resource_id: string;
        created_by: string;
        severity: string;
        reason: string;
        evidence: string | null;
        state: string;
        created_at: string;
        cleared_at: string | null;
        cleared_by: string | null;
      }>();
    const overrides = await this.env.DB.prepare(
      `SELECT id, block_id, actor_type, actor_id, reason, created_at
       FROM security_overrides WHERE org_id = ?`,
    )
      .bind(orgId)
      .all<{
        id: string;
        block_id: string;
        actor_type: string;
        actor_id: string;
        reason: string;
        created_at: string;
      }>();

    this.ctx.storage.transactionSync(() => {
      if (this.isReady()) {
        return;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO meta (org_id, owner_human_id, policy_version) VALUES (?, ?, ?)`,
        orgId,
        organization.owner_id,
        policy?.version ?? 1,
      );
      for (const employee of employees.results) {
        this.ctx.storage.sql.exec(
          `INSERT INTO employees (id, status) VALUES (?, ?)`,
          employee.id,
          employee.status,
        );
      }
      for (const role of roles.results) {
        this.ctx.storage.sql.exec(`INSERT INTO roles (id, code) VALUES (?, ?)`, role.id, role.code);
      }
      for (const permission of permissions.results) {
        this.ctx.storage.sql.exec(
          `INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)`,
          permission.role_id,
          permission.permission_code,
        );
      }
      for (const link of links.results) {
        this.ctx.storage.sql.exec(
          `INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)`,
          link.employee_id,
          link.role_id,
        );
      }
      for (const block of blocks.results) {
        this.ctx.storage.sql.exec(
          `INSERT INTO security_blocks (
             id, resource_type, resource_id, created_by, severity, reason, evidence, state, created_at, cleared_at, cleared_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          block.id,
          block.resource_type,
          block.resource_id,
          block.created_by,
          block.severity,
          block.reason,
          block.evidence,
          block.state,
          block.created_at,
          block.cleared_at,
          block.cleared_by,
        );
      }
      for (const override of overrides.results) {
        this.ctx.storage.sql.exec(
          `INSERT INTO security_overrides (id, block_id, actor_type, actor_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          override.id,
          override.block_id,
          override.actor_type,
          override.actor_id,
          override.reason,
          override.created_at,
        );
      }
    });
    return true;
  }

  private isReady(): boolean {
    const row = this.ctx.storage.sql
      .exec<{ org_id: string }>(`SELECT org_id FROM meta LIMIT 1`)
      .toArray()[0];
    return row !== undefined;
  }

  private meta(): MetaRow {
    const row = this.ctx.storage.sql
      .exec<MetaRow>(`SELECT org_id, owner_human_id, policy_version FROM meta`)
      .toArray()[0];
    if (!row) {
      throw new DomainError("NOT_FOUND", "Organization authority is not hydrated.");
    }
    return row;
  }

  private policyVersion(): number {
    if (!this.isReady()) {
      return 0;
    }
    return this.meta().policy_version;
  }

  private snapshot(): AuthoritySnapshot {
    const meta = this.meta();
    const permissionsByRole = this.permissionsByRoleId();
    const employees = new Map<string, AuthorityEmployee>();
    for (const employee of this.ctx.storage.sql
      .exec<{ id: string; status: string }>(`SELECT id, status FROM employees`)
      .toArray()) {
      const permissions = new Set<string>();
      for (const link of this.ctx.storage.sql
        .exec<{ role_id: string }>(
          `SELECT role_id FROM employee_roles WHERE employee_id = ?`,
          employee.id,
        )
        .toArray()) {
        for (const permission of permissionsByRole.get(link.role_id) ?? []) {
          permissions.add(permission);
        }
      }
      employees.set(employee.id, {
        status: employee.status === "suspended" ? "suspended" : "active",
        permissions,
      });
    }
    const blocks: AuthorityBlock[] = this.ctx.storage.sql
      .exec<{ id: string; resource_type: string; resource_id: string; state: string }>(
        `SELECT id, resource_type, resource_id, state FROM security_blocks`,
      )
      .toArray()
      .flatMap((block) =>
        block.state === "active" || block.state === "cleared"
          ? [
              {
                id: block.id,
                resourceType: block.resource_type,
                resourceId: block.resource_id,
                state: block.state,
              },
            ]
          : [],
      );
    const overriddenBlockIds = new Set(
      this.ctx.storage.sql
        .exec<{ block_id: string }>(`SELECT block_id FROM security_overrides`)
        .toArray()
        .map((row) => row.block_id),
    );
    return {
      orgId: meta.org_id,
      policyVersion: meta.policy_version,
      ownerHumanId: meta.owner_human_id,
      employees,
      blocks,
      overriddenBlockIds,
    };
  }

  private snapshotPermissions(actorType: ActorType, actorId: string): ReadonlySet<string> {
    return actorPermissions(this.snapshot(), actorType, actorId) ?? new Set();
  }

  private permissionsByRoleId(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of this.ctx.storage.sql
      .exec<{ role_id: string; permission_code: string }>(
        `SELECT role_id, permission_code FROM role_permissions`,
      )
      .toArray()) {
      const list = map.get(row.role_id) ?? [];
      list.push(row.permission_code);
      map.set(row.role_id, list);
    }
    return map;
  }

  private permissionsByRoleCode(): Map<string, string[]> {
    const roles = new Map(
      this.ctx.storage.sql
        .exec<{ id: string; code: string }>(`SELECT id, code FROM roles`)
        .toArray()
        .map((role) => [role.id, role.code]),
    );
    const map = new Map<string, string[]>();
    for (const [roleId, permissions] of this.permissionsByRoleId()) {
      const code = roles.get(roleId);
      if (!code) {
        continue;
      }
      map.set(code, permissions);
    }
    return map;
  }

  private roleCodes(employeeId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ code: string }>(
        `SELECT roles.code AS code
         FROM employee_roles
         JOIN roles ON roles.id = employee_roles.role_id
         WHERE employee_roles.employee_id = ?`,
        employeeId,
      )
      .toArray()
      .map((row) => row.code);
  }

  private employeeRow(employeeId: string): { id: string; status: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ id: string; status: string }>(
          `SELECT id, status FROM employees WHERE id = ?`,
          employeeId,
        )
        .toArray()[0] ?? null
    );
  }

  private roleRow(roleId: string): { id: string; code: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ id: string; code: string }>(`SELECT id, code FROM roles WHERE id = ?`, roleId)
        .toArray()[0] ?? null
    );
  }

  private blockRow(blockId: string): { id: string; created_by: string; state: string } | null {
    return (
      this.ctx.storage.sql
        .exec<{ id: string; created_by: string; state: string }>(
          `SELECT id, created_by, state FROM security_blocks WHERE id = ?`,
          blockId,
        )
        .toArray()[0] ?? null
    );
  }

  private hasRole(employeeId: string, roleId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          `SELECT 1 AS ok FROM employee_roles WHERE employee_id = ? AND role_id = ?`,
          employeeId,
          roleId,
        )
        .toArray().length > 0
    );
  }

  private withVersion(change: () => () => void): AppliedMutation {
    const previous = this.policyVersion();
    const next = previous + 1;
    const undoChange = change();
    this.ctx.storage.sql.exec(`UPDATE meta SET policy_version = ?`, next);
    return {
      version: next,
      undo: () => {
        undoChange();
        this.ctx.storage.sql.exec(`UPDATE meta SET policy_version = ?`, previous);
      },
    };
  }

  private apply(change: () => AppliedMutation | null): AppliedMutation | null {
    let applied: AppliedMutation | null = null;
    this.ctx.storage.transactionSync(() => {
      applied = change();
    });
    return applied;
  }

  private async project(
    applied: AppliedMutation,
    statements: D1PreparedStatement[],
  ): Promise<void> {
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        applied.undo();
      });
      throw error;
    }
  }

  private policyProjection(orgId: string, version: number): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO organization_policy (org_id, version, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET
         version = MAX(organization_policy.version, excluded.version),
         updated_at = CASE
           WHEN excluded.version >= organization_policy.version THEN excluded.updated_at
           ELSE organization_policy.updated_at
         END`,
    ).bind(orgId, version, this.now());
  }

  private assertBlockShape(command: SecurityBlockCommand): void {
    const reason = command.reason.trim();
    if (!SEVERITIES.has(command.severity) || reason.length < 1 || reason.length > 500) {
      throw new DomainError("INVALID_INPUT", "Security block is not valid.");
    }
    if (command.resourceType.trim().length < 1 || command.resourceId.trim().length < 1) {
      throw new DomainError("INVALID_INPUT", "Security block resource is not valid.");
    }
    if ((command.evidence ?? "").length > 2000) {
      throw new DomainError("INVALID_INPUT", "Security block evidence is too large.");
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async targetStatus(
    orgId: string,
    employeeId: string,
  ): Promise<"active" | "suspended" | null> {
    const row = await this.env.DB.prepare(
      `SELECT status FROM employees WHERE org_id = ? AND id = ?`,
    )
      .bind(orgId, employeeId)
      .first<{ status: string }>();
    if (!row) {
      return null;
    }
    return row.status === "suspended" ? "suspended" : "active";
  }

  private joinByHash(hash: string): JoinRow | null {
    return (
      this.ctx.storage.sql
        .exec<JoinRow>(
          `SELECT id, employee_id, status, expires_at, scopes FROM join_codes WHERE code_hash = ?`,
          hash,
        )
        .toArray()[0] ?? null
    );
  }

  private joinById(id: string): JoinRow | null {
    return (
      this.ctx.storage.sql
        .exec<JoinRow>(
          `SELECT id, employee_id, status, expires_at, scopes FROM join_codes WHERE id = ?`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private deleteJoin(id: string): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`DELETE FROM join_codes WHERE id = ?`, id);
    });
  }

  private failureRow(employeeId: string): FailureRow | null {
    return (
      this.ctx.storage.sql
        .exec<FailureRow>(
          `SELECT window_started_at, failures FROM join_redemption_failures WHERE employee_id = ?`,
          employeeId,
        )
        .toArray()[0] ?? null
    );
  }

  private throttled(employeeId: string): boolean {
    const row = this.failureRow(employeeId);
    return (
      !!row &&
      Date.now() - row.window_started_at < JOIN_WINDOW_MS &&
      row.failures >= JOIN_FAILURE_LIMIT
    );
  }

  private noteFailure(employeeId: string): void {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `DELETE FROM join_redemption_failures WHERE window_started_at <= ?`,
        now - JOIN_WINDOW_MS,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO join_redemption_failures (employee_id, window_started_at, failures)
         VALUES (?, ?, 1)
         ON CONFLICT(employee_id) DO UPDATE SET failures = MIN(failures + 1, ?)`,
        employeeId,
        now,
        JOIN_FAILURE_LIMIT,
      );
    });
  }

  private claimJoin(id: string, nowIso: string): { kind: ClaimKind; undo: () => void } {
    let kind: ClaimKind = "missing";
    let undo = (): void => {};
    this.ctx.storage.transactionSync(() => {
      const row = this.joinById(id);
      if (!row) {
        kind = "missing";
        return;
      }
      if (row.status === "consumed") {
        kind = "consumed";
        return;
      }
      if (row.status === "revoked") {
        kind = "revoked";
        return;
      }
      if (row.status !== "active") {
        kind = "missing";
        return;
      }
      if (row.expires_at <= nowIso) {
        this.ctx.storage.sql.exec(`UPDATE join_codes SET status = 'expired' WHERE id = ?`, id);
        kind = "expired";
        undo = () => {
          this.ctx.storage.sql.exec(`UPDATE join_codes SET status = 'active' WHERE id = ?`, id);
        };
        return;
      }
      this.ctx.storage.sql.exec(
        `UPDATE join_codes SET status = 'consumed', used_at = ? WHERE id = ?`,
        nowIso,
        id,
      );
      kind = "active";
      undo = () => {
        this.ctx.storage.sql.exec(
          `UPDATE join_codes SET status = 'active', used_at = NULL WHERE id = ?`,
          id,
        );
      };
    });
    return { kind, undo };
  }
}

function issueDeny(reason: string): IssueJoinCodeResult {
  return { decision: "DENY", reason, joinId: null, code: null, expiresAt: null };
}

function consumeDeny(reason: string): JoinConsumeResult {
  return { decision: "DENY", reason, joinId: null, employeeId: null, scopes: [] };
}

function normalizeScopes(scopes: string[]): string[] | null {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 8) {
    return null;
  }
  const unique = [...new Set(scopes)];
  if (unique.length !== scopes.length || !unique.every((scope) => isPermissionCode(scope))) {
    return null;
  }
  return unique;
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function storageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AppliedMutation {
  version: number;
  undo: () => void;
}
