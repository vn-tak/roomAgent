import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createStudio, hire, openBrowserSession, organizationStub } from "./helpers";

describe("authenticated room snapshot HTTP transport", () => {
  it("exposes current state only to an authenticated room member", async () => {
    const { org, store } = await createStudio("Snapshot HTTP");
    const member = await hire(store, org.id, "Member");
    const outsider = await hire(store, org.id, "Non-member");
    const role = await store.getRoleByCode(org.id, "employee");
    const owner = { orgId: org.id, actorType: "human" as const, actorId: org.createdByUserId };
    for (const employee of [member, outsider]) {
      await organizationStub(org.id).assignRole({
        ...owner,
        employeeId: employee.id,
        roleId: role?.id ?? "",
      });
    }
    const room = await store.createRoom(org.id, { name: "Snapshot", departmentId: null });
    await store.addRoomMember(org.id, room.id, member.id);
    const url = `https://company.local/orgs/${org.id}/rooms/${room.id}/snapshot`;
    expect((await exports.default.fetch(url)).status).toBe(401);
    const memberSession = await openBrowserSession(org, member.id);
    const response = await exports.default.fetch(url, {
      headers: { authorization: `Bearer ${memberSession.token}`, "x-employee-id": member.id },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      room_id: room.id,
      head_seq: expect.any(Number),
      members: [{ employee_id: member.id, joined_at: expect.any(String) }],
      tasks: [],
      artifacts: [],
    });
    const outsiderSession = await openBrowserSession(org, outsider.id);
    const denied = await exports.default.fetch(url, {
      headers: { authorization: `Bearer ${outsiderSession.token}`, "x-employee-id": outsider.id },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "NOT_MEMBER" } });
    const other = await createStudio("Snapshot other org");
    const foreign = await exports.default.fetch(
      `https://company.local/orgs/${other.org.id}/rooms/${room.id}/snapshot`,
      { headers: { authorization: `Bearer ${memberSession.token}`, "x-employee-id": member.id } },
    );
    expect(foreign.status).toBe(401);
  });
});
