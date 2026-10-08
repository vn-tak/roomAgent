import { z } from "zod";
import {
  ADAPTER_TYPES,
  RUNTIME_TYPES,
  assertExternalRef,
  assertName,
  assertRoleCode,
  isId,
} from "@ai-company/domain";

function named(value: string, ctx: z.RefinementCtx): string {
  try {
    return assertName(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid name.",
    });
    return z.NEVER;
  }
}

export const displayNameSchema = z.string().transform(named);

export const createHumanUserSchema = z.object({
  displayName: displayNameSchema,
});

export const createOrganizationSchema = z.object({
  name: displayNameSchema,
  createdByUserId: z.string().refine((value) => isId(value, "usr")),
});

export const createEmployeeSchema = z.object({
  displayName: displayNameSchema,
});

export const createDepartmentSchema = z.object({
  name: displayNameSchema,
  parentDepartmentId: z
    .string()
    .refine((value) => isId(value, "dept"))
    .nullable(),
});

export const createRoleSchema = z.object({
  code: z.string().transform((value, ctx) => {
    try {
      return assertRoleCode(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid role code.",
      });
      return z.NEVER;
    }
  }),
  name: displayNameSchema,
});

export const createRoomSchema = z.object({
  name: displayNameSchema,
  departmentId: z
    .string()
    .refine((value) => isId(value, "dept"))
    .nullable(),
});

export const createRuntimeBindingSchema = z.object({
  employeeId: z.string().refine((value) => isId(value, "emp")),
  runtimeType: z.enum(RUNTIME_TYPES),
  adapterType: z.enum(ADAPTER_TYPES),
  externalRef: z
    .string()
    .nullable()
    .transform((value, ctx) => {
      try {
        return assertExternalRef(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : "Invalid external ref.",
        });
        return z.NEVER;
      }
    }),
});

export type CreateHumanUser = z.infer<typeof createHumanUserSchema>;
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type CreateEmployee = z.infer<typeof createEmployeeSchema>;
export type CreateDepartment = z.infer<typeof createDepartmentSchema>;
export type CreateRole = z.infer<typeof createRoleSchema>;
export type CreateRoom = z.infer<typeof createRoomSchema>;
export type CreateRuntimeBinding = z.infer<typeof createRuntimeBindingSchema>;
