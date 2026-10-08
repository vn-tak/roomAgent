import { isId } from "@ai-company/domain";

export async function resolveHttpPrincipal(
  env: Env,
  orgId: string,
  authorization: string | undefined,
  employeeId: string | undefined,
  scope: string,
): Promise<{
  decision: "ALLOW" | "DENY";
  reason: string;
  actorType: "human" | "employee" | null;
  actorId: string | null;
}> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (/^hum_[0-9a-f]{64}$/.test(token)) {
    const verified = await env.ORGANIZATION.getByName(`org:${orgId}`).verifyHumanSession({
      orgId,
      token,
    });
    return {
      decision: verified.decision,
      reason: verified.reason,
      actorType: verified.decision === "ALLOW" ? "human" : null,
      actorId: verified.userId,
    };
  }
  if (!employeeId || !isId(employeeId, "emp") || !/^[0-9a-f]{64}$/.test(token)) {
    return { decision: "DENY", reason: "SESSION_INVALID", actorType: null, actorId: null };
  }
  const verified = await env.AGENT.getByName(`agent:${orgId}:${employeeId}`).verify({
    orgId,
    employeeId,
    token,
    scope,
  });
  return {
    decision: verified.decision,
    reason: verified.reason,
    actorType: verified.decision === "ALLOW" ? "employee" : null,
    actorId: verified.decision === "ALLOW" ? employeeId : null,
  };
}
