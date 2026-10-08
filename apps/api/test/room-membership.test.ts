import { createId, DomainError } from "@ai-company/domain";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createStudio, hire } from "./helpers";

describe("room membership", () => {
  it("adds a member only inside the same organization", async () => {
    const left = await createStudio("Rooms A");
    const right = await createStudio("Rooms B");
    const department = await left.store.createDepartment(left.org.id, {
      name: "Production",
      parentDepartmentId: null,
    });
    const room = await left.store.createRoom(left.org.id, {
      name: "Episode 01",
      departmentId: department.id,
    });
    const employee = await hire(left.store, left.org.id, "Worker A");
    const membership = await left.store.addRoomMember(left.org.id, room.id, employee.id);
    expect(membership).toMatchObject({
      orgId: left.org.id,
      roomId: room.id,
      employeeId: employee.id,
    });
    expect(await left.store.listRoomMembers(left.org.id, room.id)).toHaveLength(1);

    await expect(left.store.addRoomMember(left.org.id, room.id, employee.id)).rejects.toMatchObject(
      {
        code: "ALREADY_MEMBER",
      },
    );
    const outsider = await hire(right.store, right.org.id, "Outsider");
    await expect(left.store.addRoomMember(left.org.id, room.id, outsider.id)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await expect(
      right.store.addRoomMember(right.org.id, room.id, outsider.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await right.store.listRoomMembers(right.org.id, room.id)).toEqual([]);
  });

  it("rejects a parent department from another organization", async () => {
    const left = await createStudio("Dept A");
    const right = await createStudio("Dept B");
    const parent = await left.store.createDepartment(left.org.id, {
      name: "Studio",
      parentDepartmentId: null,
    });
    await expect(
      right.store.createDepartment(right.org.id, {
        name: "Nested",
        parentDepartmentId: parent.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a raw membership that crosses organizations", async () => {
    const left = await createStudio("Raw A");
    const right = await createStudio("Raw B");
    const room = await left.store.createRoom(left.org.id, {
      name: "Room",
      departmentId: null,
    });
    const employee = await hire(right.store, right.org.id, "Other");
    await expect(
      env.DB.prepare(
        `INSERT INTO room_memberships (
           id, org_id, room_id, employee_id, status, joined_at, left_at
         ) VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      )
        .bind(createId("rmem"), left.org.id, room.id, employee.id, "2026-10-08T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/TENANT_MISMATCH/);
    await expect(
      left.store.addRoomMember(left.org.id, "room_nope", employee.id),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
