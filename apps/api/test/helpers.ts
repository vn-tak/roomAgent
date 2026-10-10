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

// Fixture for tests that drive the workflow binding directly: writes the same durable
// start claim the HTTP entrypoint records before it creates an instance.
export async function claimWorkflowStart(
  runId: string,
  params: { orgId: string; taskId: string; artifactId: string; version: number },
): Promise<void> {
  const owner = await env.DB.prepare(
    `SELECT created_by_user_id AS id FROM organizations WHERE id = ?`,
  )
    .bind(params.orgId)
    .first<{ id: string }>();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workflow_start_claims (
       id, org_id, task_id, artifact_id, artifact_version, actor_type, actor_id,
       idempotency_key, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'human', ?, ?, 'claimed', ?, ?)`,
  )
    .bind(
      runId,
      params.orgId,
      params.taskId,
      params.artifactId,
      params.version,
      owner?.id ?? "",
      `fixture_${runId.slice(4, 28)}`,
      now,
      now,
    )
    .run();
}
