import { describe, expect, it } from "vitest";
import { createId } from "@ai-company/domain";
import { createOrganizationSchema, createRuntimeBindingSchema } from "../src/index";

describe("command schemas", () => {
  it("rejects an organization whose creator is not a user id", () => {
    const result = createOrganizationSchema.safeParse({
      name: "AI Studio Lab",
      createdByUserId: "emp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a browser runtime binding with an operator label", () => {
    const result = createRuntimeBindingSchema.safeParse({
      employeeId: createId("emp"),
      runtimeType: "MUSE_BROWSER",
      adapterType: "browser",
      externalRef: "muse-runtime-17",
    });
    expect(result.success).toBe(true);
  });
});
