import { DomainError } from "@ai-company/domain";
import { describe, expect, it } from "vitest";
import { createStudio, hire } from "./helpers";

describe("employee and runtime separation", () => {
  it("keeps the employee when a runtime binding is revoked and replaced", async () => {
    const studio = await createStudio("Runtimes");
    const employee = await hire(studio.store, studio.org.id, "Sentinel");
    expect(await studio.store.listRuntimeBindings(studio.org.id, employee.id)).toEqual([]);

    const first = await studio.store.createRuntimeBinding(studio.org.id, {
      employeeId: employee.id,
      runtimeType: "MUSE_BROWSER",
      adapterType: "browser",
      externalRef: "muse-runtime-17",
    });
    await expect(
      studio.store.createRuntimeBinding(studio.org.id, {
        employeeId: employee.id,
        runtimeType: "CUE",
        adapterType: "cue",
        externalRef: "cue-runtime-2",
      }),
    ).rejects.toMatchObject({ code: "BINDING_ALREADY_ACTIVE" });

    const revoked = await studio.store.revokeRuntimeBinding(studio.org.id, first.id);
    expect(revoked.status).toBe("revoked");
    const stillThere = await studio.store.getEmployee(studio.org.id, employee.id);
    expect(stillThere).toMatchObject({ id: employee.id, displayName: "Sentinel" });

    const second = await studio.store.createRuntimeBinding(studio.org.id, {
      employeeId: employee.id,
      runtimeType: "CUE",
      adapterType: "cue",
      externalRef: "cue-runtime-2",
    });
    expect(second.employeeId).toBe(employee.id);
    expect(second.id).not.toBe(first.id);
    const history = await studio.store.listRuntimeBindings(studio.org.id, employee.id);
    expect(history.map((binding) => binding.status)).toEqual(["revoked", "active"]);
  });

  it("rejects credential-shaped labels and cross-organization employees", async () => {
    const left = await createStudio("Bind A");
    const right = await createStudio("Bind B");
    const employee = await hire(left.store, left.org.id, "Worker");
    await expect(
      left.store.createRuntimeBinding(left.org.id, {
        employeeId: employee.id,
        runtimeType: "MUSE_BROWSER",
        adapterType: "browser",
        externalRef: "Bearer secret-token",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      right.store.createRuntimeBinding(right.org.id, {
        employeeId: employee.id,
        runtimeType: "MUSE_BROWSER",
        adapterType: "browser",
        externalRef: "muse-runtime-9",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await left.store.getEmployee(left.org.id, employee.id)).not.toBeNull();
  });

  it("does not treat a revoked binding as active", async () => {
    const studio = await createStudio("Revoke twice");
    const employee = await hire(studio.store, studio.org.id, "Worker");
    const binding = await studio.store.createRuntimeBinding(studio.org.id, {
      employeeId: employee.id,
      runtimeType: "API",
      adapterType: "webhook",
      externalRef: "hook-1",
    });
    await studio.store.revokeRuntimeBinding(studio.org.id, binding.id);
    await expect(
      studio.store.revokeRuntimeBinding(studio.org.id, binding.id),
    ).rejects.toMatchObject({ code: "BINDING_NOT_ACTIVE" });
    await expect(
      studio.store.revokeRuntimeBinding(studio.org.id, "rb_missing"),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
