import {
  DomainError,
  isId,
  systemClock,
  type Clock,
  type Department,
  type Employee,
  type EmployeeStatus,
  type HumanUser,
  type MembershipStatus,
  type Organization,
  type Role,
  type Room,
  type RoomMembership,
  type RoomStatus,
  type RuntimeBinding,
  type RuntimeType,
  type AdapterType,
  type BindingStatus,
  createId,
} from "@ai-company/domain";
import { ROLE_TEMPLATES, isPermissionCode, type PermissionCode } from "@ai-company/policy";
import {
  createDepartmentSchema,
  createEmployeeSchema,
  createHumanUserSchema,
  createOrganizationSchema,
  createRoleSchema,
  createRoomSchema,
  createRuntimeBindingSchema,
} from "@ai-company/schemas";
import { parseCommand } from "./parse";
import { mapStorageError } from "./storage-error";

interface EmployeeRow {
  id: string;
  org_id: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface BindingRow {
  id: string;
  org_id: string;
  employee_id: string;
  runtime_type: string;
  adapter_type: string;
  external_ref: string | null;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

interface DepartmentRow {
  id: string;
  org_id: string;
  name: string;
  parent_department_id: string | null;
  created_at: string;
}

interface RoleRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  system_role: number;
  created_at: string;
}

interface RoomRow {
  id: string;
  org_id: string;
  name: string;
  department_id: string | null;
  status: string;
  created_at: string;
}

interface MembershipRow {
  id: string;
  org_id: string;
  room_id: string;
  employee_id: string;
  status: string;
  joined_at: string;
  left_at: string | null;
}

function asEmployeeStatus(value: string): EmployeeStatus {
  if (value === "active" || value === "suspended") {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored employee status is not valid.");
}

function asBindingStatus(value: string): BindingStatus {
  if (value === "active" || value === "revoked") {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored binding status is not valid.");
}

function asRuntimeType(value: string): RuntimeType {
  if (
    value === "MUSE_BROWSER" ||
    value === "CUE" ||
    value === "A2A" ||
    value === "API" ||
    value === "BROWSER"
  ) {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored runtime type is not valid.");
}

function asAdapterType(value: string): AdapterType {
  if (
    value === "browser" ||
    value === "muse" ||
    value === "cue" ||
    value === "a2a" ||
    value === "webhook"
  ) {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored adapter type is not valid.");
}

function asRoomStatus(value: string): RoomStatus {
  if (value === "active" || value === "archived") {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored room status is not valid.");
}

function asMembershipStatus(value: string): MembershipStatus {
  if (value === "active" || value === "left") {
    return value;
  }
  throw new DomainError("INVALID_INPUT", "Stored membership status is not valid.");
}

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    orgId: row.org_id,
    displayName: row.display_name,
    status: asEmployeeStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBinding(row: BindingRow): RuntimeBinding {
  return {
    id: row.id,
    orgId: row.org_id,
    employeeId: row.employee_id,
    runtimeType: asRuntimeType(row.runtime_type),
    adapterType: asAdapterType(row.adapter_type),
    externalRef: row.external_ref,
    status: asBindingStatus(row.status),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function mapDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    parentDepartmentId: row.parent_department_id,
    createdAt: row.created_at,
  };
}

function mapRole(row: RoleRow): Role {
  return {
    id: row.id,
    orgId: row.org_id,
    code: row.code,
    name: row.name,
    systemRole: row.system_role === 1,
    createdAt: row.created_at,
  };
}

function mapRoom(row: RoomRow): Room {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    departmentId: row.department_id,
    status: asRoomStatus(row.status),
    createdAt: row.created_at,
  };
}

function mapMembership(row: MembershipRow): RoomMembership {
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.room_id,
    employeeId: row.employee_id,
    status: asMembershipStatus(row.status),
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

/**
 * Relational store for Phase 1 identity.
 * Every tenant-owned statement includes org_id. Human users and the permission catalog are global.
 */
export class FoundationStore {
  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return this.clock();
  }

  private org(orgId: string): string {
    if (!isId(orgId, "org")) {
      throw new DomainError("INVALID_INPUT", "Organization id is not valid.");
    }
    return orgId;
  }

  async createHumanUser(input: unknown): Promise<HumanUser> {
    const command = parseCommand(createHumanUserSchema, input);
    const id = createId("usr");
    const createdAt = this.now();
    await this.db
      .prepare(`INSERT INTO human_users (id, display_name, created_at) VALUES (?, ?, ?)`)
      .bind(id, command.displayName, createdAt)
      .run();
    return { id, displayName: command.displayName, createdAt };
  }

  async createOrganization(input: unknown): Promise<Organization> {
    const command = parseCommand(createOrganizationSchema, input);
    const creator = await this.db
      .prepare(`SELECT id FROM human_users WHERE id = ?`)
      .bind(command.createdByUserId)
      .first<{ id: string }>();
    if (!creator) {
      throw new DomainError("NOT_FOUND", "Human user was not found.");
    }

    const id = createId("org");
    const now = this.now();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO organizations (id, name, status, created_by_user_id, created_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?)`,
        )
        .bind(id, command.name, command.createdByUserId, now, now),
    ];

    for (const template of ROLE_TEMPLATES) {
      const roleId = createId("role");
      statements.push(
        this.db
          .prepare(
            `INSERT INTO roles (id, org_id, code, name, system_role, created_at)
             VALUES (?, ?, ?, ?, 1, ?)`,
          )
          .bind(roleId, id, template.code, template.name, now),
      );
      for (const permission of template.permissions) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO role_permissions (org_id, role_id, permission_code)
               VALUES (?, ?, ?)`,
            )
            .bind(id, roleId, permission),
        );
      }
    }

    try {
      await this.db.batch(statements);
    } catch (error) {
      mapStorageError(error);
    }

    return {
      id,
      name: command.name,
      status: "active",
      createdByUserId: command.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    if (!isId(orgId, "org")) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, name, status, created_by_user_id, created_at, updated_at
         FROM organizations
         WHERE id = ?`,
      )
      .bind(orgId)
      .first<{
        id: string;
        name: string;
        status: string;
        created_by_user_id: string;
        created_at: string;
        updated_at: string;
      }>();
    if (!row) {
      return null;
    }
    if (row.status !== "active" && row.status !== "suspended") {
      throw new DomainError("INVALID_INPUT", "Stored organization status is not valid.");
    }
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createEmployee(orgId: string, input: unknown): Promise<Employee> {
    const org = this.org(orgId);
    const command = parseCommand(createEmployeeSchema, input);
    if (!(await this.getOrganization(org))) {
      throw new DomainError("NOT_FOUND", "Organization was not found.");
    }
    const id = createId("emp");
    const now = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO employees (id, org_id, display_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, org, command.displayName, now, now)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      displayName: command.displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }

  async getEmployee(orgId: string, employeeId: string): Promise<Employee | null> {
    if (!isId(orgId, "org") || !isId(employeeId, "emp")) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, org_id, display_name, status, created_at, updated_at
         FROM employees
         WHERE org_id = ? AND id = ?`,
      )
      .bind(orgId, employeeId)
      .first<EmployeeRow>();
    return row ? mapEmployee(row) : null;
  }

  async listEmployees(orgId: string): Promise<Employee[]> {
    const org = this.org(orgId);
    const result = await this.db
      .prepare(
        `SELECT id, org_id, display_name, status, created_at, updated_at
         FROM employees
         WHERE org_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(org)
      .all<EmployeeRow>();
    return result.results.map(mapEmployee);
  }

  async createDepartment(orgId: string, input: unknown): Promise<Department> {
    const org = this.org(orgId);
    const command = parseCommand(createDepartmentSchema, input);
    if (command.parentDepartmentId) {
      const parent = await this.getDepartment(org, command.parentDepartmentId);
      if (!parent) {
        throw new DomainError("NOT_FOUND", "Department was not found.");
      }
    }
    const id = createId("dept");
    const createdAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO departments (id, org_id, name, parent_department_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, org, command.name, command.parentDepartmentId, createdAt)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      name: command.name,
      parentDepartmentId: command.parentDepartmentId,
      createdAt,
    };
  }

  async getDepartment(orgId: string, departmentId: string): Promise<Department | null> {
    if (!isId(orgId, "org") || !isId(departmentId, "dept")) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, org_id, name, parent_department_id, created_at
         FROM departments
         WHERE org_id = ? AND id = ?`,
      )
      .bind(orgId, departmentId)
      .first<DepartmentRow>();
    return row ? mapDepartment(row) : null;
  }

  async createRole(orgId: string, input: unknown): Promise<Role> {
    const org = this.org(orgId);
    const command = parseCommand(createRoleSchema, input);
    if (!(await this.getOrganization(org))) {
      throw new DomainError("NOT_FOUND", "Organization was not found.");
    }
    const id = createId("role");
    const createdAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO roles (id, org_id, code, name, system_role, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        )
        .bind(id, org, command.code, command.name, createdAt)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      code: command.code,
      name: command.name,
      systemRole: false,
      createdAt,
    };
  }

  async getRole(orgId: string, roleId: string): Promise<Role | null> {
    if (!isId(orgId, "org") || !isId(roleId, "role")) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, org_id, code, name, system_role, created_at
         FROM roles
         WHERE org_id = ? AND id = ?`,
      )
      .bind(orgId, roleId)
      .first<RoleRow>();
    return row ? mapRole(row) : null;
  }

  async getRoleByCode(orgId: string, code: string): Promise<Role | null> {
    const org = this.org(orgId);
    const row = await this.db
      .prepare(
        `SELECT id, org_id, code, name, system_role, created_at
         FROM roles
         WHERE org_id = ? AND code = ?`,
      )
      .bind(org, code)
      .first<RoleRow>();
    return row ? mapRole(row) : null;
  }

  async listRoles(orgId: string): Promise<Role[]> {
    const org = this.org(orgId);
    const result = await this.db
      .prepare(
        `SELECT id, org_id, code, name, system_role, created_at
         FROM roles
         WHERE org_id = ?
         ORDER BY code ASC`,
      )
      .bind(org)
      .all<RoleRow>();
    return result.results.map(mapRole);
  }

  async assignPermission(orgId: string, roleId: string, permissionCode: string): Promise<void> {
    const org = this.org(orgId);
    if (!isPermissionCode(permissionCode)) {
      throw new DomainError("INVALID_PERMISSION", "Permission is not in the catalog.");
    }
    const role = await this.getRole(org, roleId);
    if (!role) {
      throw new DomainError("NOT_FOUND", "Role was not found.");
    }
    if (role.systemRole) {
      throw new DomainError("SYSTEM_ROLE_LOCKED", "System role permissions cannot be changed.");
    }
    try {
      await this.db
        .prepare(
          `INSERT INTO role_permissions (org_id, role_id, permission_code)
           VALUES (?, ?, ?)`,
        )
        .bind(org, role.id, permissionCode)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
  }

  async assignEmployeeRole(orgId: string, employeeId: string, roleId: string): Promise<void> {
    const org = this.org(orgId);
    const employee = await this.getEmployee(org, employeeId);
    if (!employee) {
      throw new DomainError("NOT_FOUND", "Employee was not found.");
    }
    const role = await this.getRole(org, roleId);
    if (!role) {
      throw new DomainError("NOT_FOUND", "Role was not found.");
    }
    const assignedAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO employee_roles (org_id, employee_id, role_id, assigned_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(org, employee.id, role.id, assignedAt)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
  }

  async listEmployeePermissionCodes(orgId: string, employeeId: string): Promise<PermissionCode[]> {
    const org = this.org(orgId);
    if (!isId(employeeId, "emp")) {
      return [];
    }
    const result = await this.db
      .prepare(
        `SELECT DISTINCT rp.permission_code AS code
         FROM employee_roles er
         JOIN role_permissions rp
           ON rp.org_id = er.org_id
          AND rp.role_id = er.role_id
         WHERE er.org_id = ?
           AND er.employee_id = ?
         ORDER BY rp.permission_code ASC`,
      )
      .bind(org, employeeId)
      .all<{ code: string }>();
    return result.results.flatMap((row) => (isPermissionCode(row.code) ? [row.code] : []));
  }

  async createRuntimeBinding(orgId: string, input: unknown): Promise<RuntimeBinding> {
    const org = this.org(orgId);
    const command = parseCommand(createRuntimeBindingSchema, input);
    const employee = await this.getEmployee(org, command.employeeId);
    if (!employee) {
      throw new DomainError("NOT_FOUND", "Employee was not found.");
    }
    const id = createId("rb");
    const createdAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO runtime_bindings (
             id, org_id, employee_id, runtime_type, adapter_type, external_ref, status, created_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .bind(
          id,
          org,
          employee.id,
          command.runtimeType,
          command.adapterType,
          command.externalRef,
          createdAt,
        )
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      employeeId: employee.id,
      runtimeType: command.runtimeType,
      adapterType: command.adapterType,
      externalRef: command.externalRef,
      status: "active",
      createdAt,
      revokedAt: null,
    };
  }

  async revokeRuntimeBinding(orgId: string, bindingId: string): Promise<RuntimeBinding> {
    const org = this.org(orgId);
    if (!isId(bindingId, "rb")) {
      throw new DomainError("NOT_FOUND", "Runtime binding was not found.");
    }
    const revokedAt = this.now();
    let changes = 0;
    try {
      const result = await this.db
        .prepare(
          `UPDATE runtime_bindings
           SET status = 'revoked', revoked_at = ?
           WHERE org_id = ? AND id = ? AND status = 'active'`,
        )
        .bind(revokedAt, org, bindingId)
        .run();
      changes = result.meta.changes;
    } catch (error) {
      mapStorageError(error);
    }
    const row = await this.db
      .prepare(
        `SELECT id, org_id, employee_id, runtime_type, adapter_type, external_ref, status, created_at, revoked_at
         FROM runtime_bindings
         WHERE org_id = ? AND id = ?`,
      )
      .bind(org, bindingId)
      .first<BindingRow>();
    if (!row) {
      throw new DomainError("NOT_FOUND", "Runtime binding was not found.");
    }
    if (changes !== 1) {
      throw new DomainError("BINDING_NOT_ACTIVE", "Runtime binding is not active.");
    }
    return mapBinding(row);
  }

  async listRuntimeBindings(orgId: string, employeeId: string): Promise<RuntimeBinding[]> {
    const org = this.org(orgId);
    if (!isId(employeeId, "emp")) {
      return [];
    }
    const result = await this.db
      .prepare(
        `SELECT id, org_id, employee_id, runtime_type, adapter_type, external_ref, status, created_at, revoked_at
         FROM runtime_bindings
         WHERE org_id = ? AND employee_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(org, employeeId)
      .all<BindingRow>();
    return result.results.map(mapBinding);
  }

  async createRoom(orgId: string, input: unknown): Promise<Room> {
    const org = this.org(orgId);
    const command = parseCommand(createRoomSchema, input);
    if (command.departmentId) {
      const department = await this.getDepartment(org, command.departmentId);
      if (!department) {
        throw new DomainError("NOT_FOUND", "Department was not found.");
      }
    }
    const id = createId("room");
    const createdAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO rooms (id, org_id, name, department_id, status, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .bind(id, org, command.name, command.departmentId, createdAt)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      name: command.name,
      departmentId: command.departmentId,
      status: "active",
      createdAt,
    };
  }

  async getRoom(orgId: string, roomId: string): Promise<Room | null> {
    if (!isId(orgId, "org") || !isId(roomId, "room")) {
      return null;
    }
    const row = await this.db
      .prepare(
        `SELECT id, org_id, name, department_id, status, created_at
         FROM rooms
         WHERE org_id = ? AND id = ?`,
      )
      .bind(orgId, roomId)
      .first<RoomRow>();
    return row ? mapRoom(row) : null;
  }

  async addRoomMember(orgId: string, roomId: string, employeeId: string): Promise<RoomMembership> {
    const org = this.org(orgId);
    const room = await this.getRoom(org, roomId);
    if (!room) {
      throw new DomainError("NOT_FOUND", "Room was not found.");
    }
    const employee = await this.getEmployee(org, employeeId);
    if (!employee) {
      throw new DomainError("NOT_FOUND", "Employee was not found.");
    }
    const id = createId("rmem");
    const joinedAt = this.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO room_memberships (
             id, org_id, room_id, employee_id, status, joined_at, left_at
           ) VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
        )
        .bind(id, org, room.id, employee.id, joinedAt)
        .run();
    } catch (error) {
      mapStorageError(error);
    }
    return {
      id,
      orgId: org,
      roomId: room.id,
      employeeId: employee.id,
      status: "active",
      joinedAt,
      leftAt: null,
    };
  }

  async listRoomMembers(orgId: string, roomId: string): Promise<RoomMembership[]> {
    const org = this.org(orgId);
    if (!isId(roomId, "room")) {
      return [];
    }
    const result = await this.db
      .prepare(
        `SELECT id, org_id, room_id, employee_id, status, joined_at, left_at
         FROM room_memberships
         WHERE org_id = ? AND room_id = ? AND status = 'active'
         ORDER BY joined_at ASC, id ASC`,
      )
      .bind(org, roomId)
      .all<MembershipRow>();
    return result.results.map(mapMembership);
  }

  async listPermissionCatalog(): Promise<string[]> {
    const result = await this.db
      .prepare(`SELECT code FROM permissions ORDER BY code ASC`)
      .all<{ code: string }>();
    return result.results.map((row) => row.code);
  }
}
