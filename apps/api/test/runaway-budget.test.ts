import type { Organization, TaskBudgets } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createStudio, hire, organizationStub, taskStub } from "./helpers";

function ownerOf(org: Organization) {
  return { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
}

async function setup(name: string) {
  const prefix = name.toLowerCase().replaceAll(" ", "_");
  const studio = await createStudio(name);
  const worker = await hire(studio.store, studio.org.id, `${name} worker`);
  const employeeRole = await studio.store.getRoleByCode(studio.org.id, "employee");
  if (!employeeRole) throw new Error("Missing employee role");
  expect(
    await organizationStub(studio.org.id).assignRole({
      ...ownerOf(studio.org),
      employeeId: worker.id,
      roleId: employeeRole.id,
    }),
  ).toMatchObject({ decision: "ALLOW" });
  const room = await studio.store.createRoom(studio.org.id, {
    name: `${name} room`,
    departmentId: null,
  });
  const otherRoom = await studio.store.createRoom(studio.org.id, {
    name: `${name} other room`,
    departmentId: null,
  });
  const task = taskStub(studio.org.id);
  const created = await task.execute({
    ...ownerOf(studio.org),
    idempotencyKey: `${prefix}_create`,
    command: "create",
    taskId: null,
    assigneeId: null,
    title: "Budgeted task",
    objective: "Count real task-scoped agent messages, not state transitions.",
    roomId: room.id,
    dependsOn: [],
  });
  expect(created.decision).toBe("ALLOW");
  if (!created.taskId) throw new Error("Task create did not return an id");
  const employee = { orgId: studio.org.id, actorType: "employee" as const, actorId: worker.id };
  for (const [command, key, assigneeId] of [
    ["assign", `${prefix}_assign`, worker.id],
    ["deliver", `${prefix}_deliver`, null],
    ["ack", `${prefix}_ack`, null],
    ["start", `${prefix}_start`, null],
  ] as const) {
    const actor = command === "ack" || command === "start" ? employee : ownerOf(studio.org);
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
  return {
    org: studio.org,
    roomId: room.id,
    otherRoomId: otherRoom.id,
    employeeId: worker.id,
    taskId: created.taskId,
    task,
  };
}

function messageInput(
  state: Awaited<ReturnType<typeof setup>>,
  idempotencyKey: string,
  expectedRoomId = state.roomId,
) {
  return {
    orgId: state.org.id,
    employeeId: state.employeeId,
    taskId: state.taskId,
    expectedRoomId,
    idempotencyKey,
  };
}

describe("TaskDO runaway budgets", () => {
  it("counts idempotent actual agent messages and pauses before exceeding the limit", async () => {
    const state = await setup("Task message budget");
    expect(await state.task.configureBudgetsForTest({ maxAgentMessagesPerTask: 1 })).toEqual({
      configured: true,
    });
    const input = messageInput(state, "budget_message_1");
    expect(await state.task.recordAgentMessage(input)).toMatchObject({
      decision: "ALLOW",
      duplicate: false,
      state: "WORKING",
    });
    expect(await state.task.recordAgentMessage(input)).toMatchObject({
      decision: "ALLOW",
      duplicate: true,
      state: "WORKING",
    });
    const blocked = await state.task.recordAgentMessage(messageInput(state, "budget_message_2"));
    expect(blocked).toMatchObject({
      decision: "DENY",
      reason: "BUDGET_GUARD",
      state: "PAUSED",
      humanReviewRequired: true,
      pauseReason: "BUDGET_GUARD",
    });
    const task = await env.DB.prepare(
      `SELECT state, human_review_required, pause_reason FROM tasks WHERE org_id = ? AND id = ?`,
    )
      .bind(state.org.id, state.taskId)
      .first<{ state: string; human_review_required: number; pause_reason: string | null }>();
    expect(task).toEqual({
      state: "PAUSED",
      human_review_required: 1,
      pause_reason: "BUDGET_GUARD",
    });
    await vi.waitFor(async () => {
      const event = await env.DB.prepare(
        `SELECT type, correlation_id FROM domain_events WHERE org_id = ? AND subject_id = ? AND type = 'task.paused'`,
      )
        .bind(state.org.id, state.taskId)
        .first<{ type: string; correlation_id: string }>();
      expect(event?.type).toBe("task.paused");
      expect(event?.correlation_id).toMatch(/^corr_/);
    });
  });

  it("serializes concurrent agent messages against the task limit", async () => {
    const state = await setup("Concurrent message budget");
    expect(await state.task.configureBudgetsForTest({ maxAgentMessagesPerTask: 1 })).toEqual({
      configured: true,
    });
    const results = await Promise.all([
      state.task.recordAgentMessage(messageInput(state, "concurrent_message_1")),
      state.task.recordAgentMessage(messageInput(state, "concurrent_message_2")),
    ]);
    expect(results.map((result) => result.decision).sort()).toEqual(["ALLOW", "DENY"]);
    expect(results.find((result) => result.decision === "DENY")).toMatchObject({
      reason: "BUDGET_GUARD",
      state: "PAUSED",
      humanReviewRequired: true,
    });
  });

  it("checks the canonical room boundary before resolving a duplicate message key", async () => {
    const state = await setup("Task message room boundary");
    expect(
      await state.task.recordAgentMessage(messageInput(state, "boundary_message_1")),
    ).toMatchObject({
      decision: "ALLOW",
    });
    const otherTask = await state.task.execute({
      ...ownerOf(state.org),
      idempotencyKey: "boundary_other_room",
      command: "create",
      taskId: null,
      assigneeId: null,
      title: "Other room",
      objective: "Test a duplicate through the wrong room boundary.",
      roomId: state.otherRoomId,
      dependsOn: [],
    });
    expect(otherTask.decision).toBe("ALLOW");
    const duplicate = await state.task.recordAgentMessage({
      ...messageInput(state, "boundary_message_1"),
      expectedRoomId: state.otherRoomId,
    });
    expect(duplicate).toMatchObject({ decision: "DENY", reason: "ROOM_MISMATCH" });
  });

  it("includes actual task messages in daily employee action guards", async () => {
    const state = await setup("Task action budget");
    expect(
      await state.task.configureBudgetsForTest({
        agentActionBudget: 1,
      } satisfies Partial<TaskBudgets>),
    ).toEqual({
      configured: true,
    });
    const result = await state.task.recordAgentMessage(messageInput(state, "agent_action_message"));
    expect(result).toMatchObject({
      decision: "DENY",
      reason: "BUDGET_GUARD",
      state: "PAUSED",
      humanReviewRequired: true,
    });
  });
  it("pauses a second assignment when the agent active-task limit is exhausted", async () => {
    const state = await setup("Active task budget");
    await state.task.configureBudgetsForTest({ maxActiveTasksPerAgent: 1 });
    const owner = {
      orgId: state.org.id,
      actorType: "human" as const,
      actorId: state.org.createdByUserId,
    };
    const created = await state.task.execute({
      ...owner,
      command: "create",
      idempotencyKey: "active_limit_create",
      taskId: null,
      assigneeId: null,
      title: "Second task",
      objective: "Await capacity",
      roomId: state.roomId,
      dependsOn: [],
    });
    expect(created.decision).toBe("ALLOW");
    expect(
      await state.task.execute({
        ...owner,
        command: "assign",
        idempotencyKey: "active_limit_assign",
        taskId: created.taskId,
        assigneeId: state.employeeId,
        title: null,
        objective: null,
        roomId: null,
        dependsOn: [],
      }),
    ).toMatchObject({
      state: "PAUSED",
      reason: "BUDGET_GUARD",
      humanReviewRequired: true,
    });
  });

  it("pauses at the organization daily action limit", async () => {
    const state = await setup("Organization daily budget");
    await state.task.configureBudgetsForTest({ orgDailyActionBudget: 1 });
    expect(
      await state.task.recordAgentMessage(messageInput(state, "org_action_message")),
    ).toMatchObject({
      decision: "DENY",
      state: "PAUSED",
      reason: "BUDGET_GUARD",
      humanReviewRequired: true,
    });
  });

  it("pauses a revision restart when the task retry budget is exhausted", async () => {
    const state = await setup("Task retry budget");
    expect(await state.task.configureBudgetsForTest({ maxTaskRetries: 1 })).toEqual({
      configured: true,
    });
    for (let retry = 1; retry <= 2; retry += 1) {
      for (const command of ["submit", "request_revision", "start"] as const) {
        const actor =
          command === "request_revision"
            ? { actorType: "human" as const, actorId: state.org.createdByUserId }
            : { actorType: "employee" as const, actorId: state.employeeId };
        const result = await state.task.execute({
          ...actor,
          orgId: state.org.id,
          taskId: state.taskId,
          command,
          idempotencyKey: `retry_limit_${command}_${retry}`,
          assigneeId: null,
          title: null,
          objective: null,
          roomId: null,
          dependsOn: [],
        });
        expect(result).toMatchObject(
          command === "start" && retry === 2
            ? { state: "PAUSED", reason: "BUDGET_GUARD", humanReviewRequired: true }
            : { decision: "ALLOW" },
        );
      }
    }
  });
});
