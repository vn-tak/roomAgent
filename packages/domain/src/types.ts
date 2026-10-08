import type {
  AdapterType,
  BindingStatus,
  EmployeeStatus,
  MembershipStatus,
  RoomStatus,
  RuntimeType,
} from "./runtime";

export interface HumanUser {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
  status: "active" | "suspended";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Employee {
  id: string;
  orgId: string;
  displayName: string;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeBinding {
  id: string;
  orgId: string;
  employeeId: string;
  runtimeType: RuntimeType;
  adapterType: AdapterType;
  externalRef: string | null;
  status: BindingStatus;
  createdAt: string;
  revokedAt: string | null;
}

export interface Department {
  id: string;
  orgId: string;
  name: string;
  parentDepartmentId: string | null;
  createdAt: string;
}

export interface Role {
  id: string;
  orgId: string;
  code: string;
  name: string;
  systemRole: boolean;
  createdAt: string;
}

export interface Room {
  id: string;
  orgId: string;
  name: string;
  departmentId: string | null;
  status: RoomStatus;
  createdAt: string;
}

export interface RoomMembership {
  id: string;
  orgId: string;
  roomId: string;
  employeeId: string;
  status: MembershipStatus;
  joinedAt: string;
  leftAt: string | null;
}

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
