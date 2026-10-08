import type { FoundationStore } from "@ai-company/db";
import type { Organization, Role } from "@ai-company/domain";
import { describe, expect, it } from "vitest";
import { createStudio, hire, organizationStub, roomStub } from "./helpers";

function ownerOf(org: Organization) {
  return {
    orgId: org.id,
    actorType: "human" as const,
    actorId: org.createdByUserId,
  };
}

async function roleByCode(store: FoundationStore, orgId: string, code: string): Promise<Role> {
  const role = await store.getRoleByCode(orgId, code);
  if (!role) {
    throw new Error(`Missing role ${code}`);
  }
  return role;
}

describe("room sequence races", () => {
  it("assigns distinct sequences and keeps one row for a duplicate key", async () => {
    const studio = await createStudio("Room race");
    const worker = await hire(studio.store, studio.org.id, "Worker");
    const employeeRole = await roleByCode(studio.store, studio.org.id, "employee");
    const owner = ownerOf(studio.org);
    await organizationStub(studio.org.id).assignRole({
      ...owner,
      employeeId: worker.id,
      roleId: employeeRole.id,
    });
    const room = await studio.store.createRoom(studio.org.id, {
      name: "Episode",
      departmentId: null,
    });
    const live = roomStub(studio.org.id, room.id);
    await live.join({ ...owner, roomId: room.id, employeeId: worker.id });
    const actor = {
      orgId: studio.org.id,
      roomId: room.id,
      actorType: "employee" as const,
      actorId: worker.id,
    };
    const [left, right] = await Promise.all([
      live.postMessage({ ...actor, body: "Left", idempotencyKey: "race_left_001" }),
      live.postMessage({ ...actor, body: "Right", idempotencyKey: "race_right_01" }),
    ]);
    expect(left.decision).toBe("ALLOW");
    expect(right.decision).toBe("ALLOW");
    const sequences = [left.event?.seq ?? 0, right.event?.seq ?? 0].sort((a, b) => a - b);
    expect(sequences[1]).toBe((sequences[0] ?? 0) + 1);

    const [first, second] = await Promise.all([
      live.postMessage({ ...actor, body: "Same", idempotencyKey: "race_same_001" }),
      live.postMessage({ ...actor, body: "Same", idempotencyKey: "race_same_001" }),
    ]);
    expect(first.decision).toBe("ALLOW");
    expect(second.decision).toBe("ALLOW");
    expect(first.event?.seq).toBe(second.event?.seq);
    const log = await live.eventsSince({ ...owner, roomId: room.id, afterSeq: 0 });
    expect(log.events.filter((item) => item.data.idempotency_key === "race_same_001")).toHaveLength(
      1,
    );
    expect(log.seq).toBe(Math.max(sequences[1] ?? 0, first.event?.seq ?? 0));
  });
});
