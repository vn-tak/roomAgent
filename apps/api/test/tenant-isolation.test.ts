import { createId } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createStudio, hire } from "./helpers";

describe("tenant isolation", () => {
  it("hides employees across organizations", async () => {
    const left = await createStudio("Studio A");
    const right = await createStudio("Studio B");
    const employee = await hire(left.store, left.org.id, "Worker A");

    expect(await right.store.getEmployee(right.org.id, employee.id)).toBeNull();
    expect((await right.store.listEmployees(right.org.id)).map((item) => item.id)).not.toContain(
      employee.id,
    );
    expect(await left.store.getEmployee(left.org.id, employee.id)).toMatchObject({
      id: employee.id,
      orgId: left.org.id,
    });
  });

  it("treats a forged employee id as missing", async () => {
    const studio = await createStudio("Studio C");
    expect(await studio.store.getEmployee(studio.org.id, "not-an-id")).toBeNull();
    expect(await studio.store.getEmployee("org_other", createId("emp"))).toBeNull();
  });

  it("rejects a runtime binding that points at another organization's employee", async () => {
    const left = await createStudio("Studio D");
    const right = await createStudio("Studio E");
    const employee = await hire(left.store, left.org.id, "Worker D");

    await expect(
      env.DB.prepare(
        `INSERT INTO runtime_bindings (
           id, org_id, employee_id, runtime_type, adapter_type, external_ref, status, created_at, revoked_at
         ) VALUES (?, ?, ?, 'MUSE_BROWSER', 'browser', NULL, 'active', ?, NULL)`,
      )
        .bind(createId("rb"), right.org.id, employee.id, "2026-10-08T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/TENANT_MISMATCH/);
  });
});
