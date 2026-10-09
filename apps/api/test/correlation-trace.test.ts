import type { Organization } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

describe("canonical task correlation trace", () => {
  it("keeps task lifecycle events on the persisted correlation root with command causation", async () => {
    const studio = await createStudio("Task correlation trace");
    const worker = await hire(studio.store, studio.org.id, "Trace worker");
    const role = await studio.store.getRoleByCode(studio.org.id, "employee");
    if (!role) throw new Error("Missing employee role");
    expect(
      await organizationStub(studio.org.id).assignRole({
        ...ownerOf(studio.org),
        employeeId: worker.id,
        roleId: role.id,
      }),
    ).toMatchObject({ decision: "ALLOW" });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Trace room",
      departmentId: null,
    });
    const task = taskStub(studio.org.id);
    const created = await task.execute({
      ...ownerOf(studio.org),
      idempotencyKey: "trace_create_task",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Trace the lifecycle",
      objective: "All task events share a stable correlation root.",
      roomId: room.id,
      dependsOn: [],
    });
    expect(created.decision).toBe("ALLOW");
    if (!created.taskId) throw new Error("Task create did not return an id");
    const employee = { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id };
    const commands = [
      ["assign", "trace_assign", ownerOf(studio.org), worker.id],
      ["deliver", "trace_deliver", ownerOf(studio.org), null],
      ["ack", "trace_ack", employee, null],
      ["start", "trace_start", employee, null],
      ["submit", "trace_submit", employee, null],
    ] as const;
    for (const [command, key, actor, assigneeId] of commands) {
      expect(
        await task.execute({
          ...actor,
          idempotencyKey: key,
          command,
          taskId: created.taskId,
          assigneeId,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        }),
      ).toMatchObject({ decision: "ALLOW" });
    }
    const keys = ["trace_create_task", ...commands.map(([, key]) => key)];
    await vi.waitFor(async () => {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM domain_events WHERE org_id = ? AND subject_id = ? AND type LIKE 'task.%'`,
      )
        .bind(studio.org.id, created.taskId)
        .first<{ n: number }>();
      expect(count?.n).toBe(keys.length);
    });
    const events = await env.DB.prepare(
      `SELECT type, seq, correlation_id, causation_id FROM domain_events
       WHERE org_id = ? AND subject_id = ? AND type LIKE 'task.%' ORDER BY seq`,
    )
      .bind(studio.org.id, created.taskId)
      .all<{ type: string; seq: number; correlation_id: string; causation_id: string }>();
    const taskRow = await env.DB.prepare(
      `SELECT correlation_id FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(studio.org.id, created.taskId)
      .first<{ correlation_id: string }>();
    expect(taskRow?.correlation_id).toMatch(/^corr_/);
    expect(events.results.map((event) => event.correlation_id)).toEqual(
      Array(keys.length).fill(taskRow?.correlation_id),
    );
    expect(events.results.map((event) => event.causation_id)).toEqual(keys);
    expect(events.results.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
