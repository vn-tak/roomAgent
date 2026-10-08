export interface AgentSessionRequest {
  orgId: string;
  employeeId: string;
}

export interface AgentDelivery {
  orgId: string;
  employeeId: string;
  payload: Uint8Array;
}

export type Reachability =
  "NATIVE_PUSH" | "BROWSER_ACTIVE" | "BROWSER_CONNECTED" | "POLL_ONLY" | "MANUAL" | "UNREACHABLE";

/**
 * Execution runtimes implement this port. Domain services must not branch on a provider name.
 * Phase 4 adds the first implementation, BrowserAgentAdapter.
 */
export interface AgentAdapter {
  readonly type: string;
  createSession(input: AgentSessionRequest): Promise<{ sessionId: string }>;
  getReachability(input: { orgId: string; employeeId: string }): Promise<Reachability>;
  deliver(input: AgentDelivery): Promise<{ delivered: boolean }>;
  revoke(input: { sessionId: string }): Promise<void>;
}
