export const RUNTIME_TYPES = ["MUSE_BROWSER", "CUE", "A2A", "API", "BROWSER"] as const;
export type RuntimeType = (typeof RUNTIME_TYPES)[number];

export const ADAPTER_TYPES = ["browser", "muse", "cue", "a2a", "webhook"] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

export const EMPLOYEE_STATUSES = ["active", "suspended"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const BINDING_STATUSES = ["active", "revoked"] as const;
export type BindingStatus = (typeof BINDING_STATUSES)[number];

export const ROOM_STATUSES = ["active", "archived"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ["active", "left"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
