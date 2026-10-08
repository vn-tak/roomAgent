import { describe, expect, it } from "vitest";
import { dependencyCycle, MAX_HANDOFFS, nextTaskState } from "../src/index";

describe("task state machine", () => {
  it("follows the canonical path and rejects jumps", () => {
    expect(MAX_HANDOFFS).toBe(8);
    expect(nextTaskState(null, "create")).toBe("CREATED");
    expect(nextTaskState("CREATED", "assign")).toBe("QUEUED");
    expect(nextTaskState("QUEUED", "deliver")).toBe("DELIVERED");
    expect(nextTaskState("DELIVERED", "ack")).toBe("ACKNOWLEDGED");
    expect(nextTaskState("ACKNOWLEDGED", "start")).toBe("WORKING");
    expect(nextTaskState("WORKING", "submit")).toBe("REVIEW");
    expect(nextTaskState("REVIEW", "request_revision")).toBe("REVISION");
    expect(nextTaskState("REVISION", "start")).toBe("WORKING");
    expect(nextTaskState("REVIEW", "approve")).toBe("APPROVED");
    expect(nextTaskState("APPROVED", "complete")).toBe("COMPLETED");

    expect(nextTaskState("CREATED", "ack")).toBeNull();
    expect(nextTaskState("CREATED", "complete")).toBeNull();
    expect(nextTaskState("WORKING", "approve")).toBeNull();
    expect(nextTaskState("COMPLETED", "cancel")).toBeNull();
    expect(nextTaskState("COMPLETED", "create")).toBeNull();
    expect(nextTaskState("PAUSED", "assign")).toBeNull();
    expect(nextTaskState("PAUSED", "cancel")).toBe("CANCELLED");
  });

  it("detects a dependency that reaches the new task", () => {
    const edges = new Map<string, readonly string[]>([
      ["task_a", ["task_b"]],
      ["task_b", ["task_new"]],
    ]);
    expect(dependencyCycle(edges, "task_new", ["task_a"])).toBe(true);
    expect(dependencyCycle(edges, "task_new", ["task_new"])).toBe(true);
    expect(dependencyCycle(new Map(), "task_new", ["task_a"])).toBe(false);
  });
});
