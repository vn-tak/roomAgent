import { FoundationStore } from "@ai-company/db";
import type { Clock, Employee, Organization } from "@ai-company/domain";
import { env } from "cloudflare:workers";

export function testStore(): FoundationStore {
  let tick = 0;
  const clock: Clock = () => {
    tick += 1;
    return `2026-10-08T00:00:${String(tick).padStart(2, "0")}.000Z`;
  };
  return new FoundationStore(env.DB, clock);
}

export async function createStudio(name: string): Promise<{
  store: FoundationStore;
  org: Organization;
}> {
  const store = testStore();
  const human = await store.createHumanUser({ displayName: `${name} owner` });
  const org = await store.createOrganization({
    name,
    createdByUserId: human.id,
  });
  return { store, org };
}

export async function hire(
  store: FoundationStore,
  orgId: string,
  displayName: string,
): Promise<Employee> {
  return store.createEmployee(orgId, { displayName });
}

export function organizationStub(orgId: string) {
  return env.ORGANIZATION.getByName(`org:${orgId}`);
}

export function roomStub(orgId: string, roomId: string) {
  return env.ROOM.getByName(`room:${orgId}:${roomId}`);
}

export function agentStub(orgId: string, employeeId: string) {
  return env.AGENT.getByName(`agent:${orgId}:${employeeId}`);
}

export function taskStub(orgId: string) {
  return env.TASK.getByName(`tasks:${orgId}`);
}

export function artifactStub(orgId: string) {
  return env.ARTIFACT.getByName(`artifacts:${orgId}`);
}

export async function openBrowserSession(
  org: Organization,
  employeeId: string,
  scopes: string[] = ["room.read", "room.message.send"],
): Promise<{ token: string; sessionId: string }> {
  const issued = await organizationStub(org.id).issueJoinCode({
    orgId: org.id,
    actorType: "human",
    actorId: org.createdByUserId,
    employeeId,
    scopes,
    ttlSeconds: 600,
  });
  if (issued.decision !== "ALLOW" || !issued.code) {
    throw new Error(issued.reason);
  }
  const redeemed = await agentStub(org.id, employeeId).redeem({
    orgId: org.id,
    employeeId,
    code: issued.code,
  });
  if (redeemed.decision !== "ALLOW" || !redeemed.token || !redeemed.sessionId) {
    throw new Error(redeemed.reason);
  }
  return { token: redeemed.token, sessionId: redeemed.sessionId };
}

export async function storedPolicyVersion(orgId: string): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT version FROM organization_policy WHERE org_id = ?`)
    .bind(orgId)
    .first<{ version: number }>();
  return row?.version ?? null;
}

export async function storedRoleCount(orgId: string, employeeId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM employee_roles WHERE org_id = ? AND employee_id = ?`,
  )
    .bind(orgId, employeeId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
