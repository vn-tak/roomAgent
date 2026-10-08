# Agent runtime

The core sees an adapter port, not a Muse client.

```text
Employee -> RuntimeBinding -> AgentAdapter -> Runtime session
```

`BrowserAgentAdapter` (`type = "browser"`) is the first adapter. It implements `createSession`, `getReachability`, `deliver`, and `revoke`. Muse and CUE stay replaceable and unimplemented. An employee row is never a provider account.

## Join codes

OrganizationDO owns pairing codes. `issueJoinCode` requires `runtime.bind`. `revokeJoinCode` requires `runtime.revoke`. `consumeJoinCode` has no actor: the code is the secret. Issuing does not bump `policy_version`.

The code is 32 random bytes, returned once as 64 hex characters. OrganizationDO SQLite and the D1 table `join_codes` store the SHA-256 hex only. `max_uses` is 1. `ttlSeconds` is an integer from 0 through 600. A ttl of 0 expires immediately. Scopes are 1 to 8 unique permission codes.

A suspended target returns `SUSPENDED_AGENT_DENY` and the code stays unused. The wrong employee does not consume the code. The claim runs inside one SQLite transaction. One of two parallel redeems is `ALLOW`. The other is `ALREADY_USED`. A failed D1 projection undoes the object write.

Each organization object counts failures for 60 seconds. The limit is 5. Counted failures are a bad shape, an unknown hash, the wrong employee, expiry, revoke, an already used code, suspension, and a tenant miss. Success does not increment the counter. While the object is throttled, consume returns `THROTTLED` and does not consume a still-active code. A hash that belongs to another organization is `WRONG_ORG`. A missing hash is `INVALID_CODE`.

There is no HTTP route to issue or revoke a code. Tests call OrganizationDO directly. The public redeem is `POST /orgs/:orgId/join` with `{ employee_id, code }`. A short code is `400 INVALID_INPUT` at the gateway and does not touch the throttle. `ALLOW` returns `{ session_id, expires_at, token }`. `THROTTLED` is 429. `TENANT_BOUNDARY` is 404. Other denials are 403. The response and the logs do not echo the code.

## Runtime session

AgentDO is one SQLite object per employee, named `agent:{org_id}:{employee_id}`, even when that employee is in many rooms. `redeem` consumes the join code, reuses the active runtime binding, or inserts `runtime_type = BROWSER`, `adapter_type = browser`, and `external_ref = NULL`. It mints `ses_` and a 64 hex token, stores `token_hash` only, and sets a 12 hour TTL. A new redeem revokes the employee's earlier active sessions. If the D1 batch fails, the object restores those sessions.

`verify` and `sessionOpen` check revocation, expiry, an active binding, and a live employee. An empty scope skips the scope list. Any other scope must be on the session or the result is `NO_SCOPE`. `revokeSession` authorizes `runtime.revoke` for the employee named by the object, then calls `dropSession`. The adapter uses `dropSession` directly. That path sets `revoked_at`, reachability `UNREACHABLE`, availability `OFFLINE`, and closes sockets with `session.revoked` and close code 4001.

## Inbox

Inbox states are `QUEUED`, `DELIVERED`, `ACKNOWLEDGED`, `EXPIRED`, and `FAILED`. `FAILED` is reserved. With no open socket, enqueue stays `QUEUED`. An open socket marks `DELIVERED` and broadcasts `inbox.delivered`. ACK moves only `DELIVERED` to `ACKNOWLEDGED`. The same idempotency key does not insert a second row. Inbox ACK does not change the task state machine. Task `ack` is a TaskDO command and does not by itself set `current_task_id`. Acknowledging an inbox packet of type `task` stores `current_task_id` and sets availability `BUSY`. That field is the last acknowledged inbox task id.

`sweep` expires `DELIVERED` rows whose `delivered_at` is before the cutoff and sets availability `DEGRADED`. Reachability has no degraded value. It is `BROWSER_CONNECTED` while the agent socket is open and `UNREACHABLE` otherwise. `wake_mode = BROWSER` names the adapter. A received frame does not mean the browser is awake.

A heartbeat sets `lease_until` to 30 seconds ahead and `last_heartbeat`. A `DEGRADED` availability stays degraded across a heartbeat.

## Gateway and adapter

`GET /orgs/:orgId/agents/:employeeId/socket` checks the id shape and the WebSocket upgrade, then forwards the request. The URL has no token. `session.hello` carries it. The constructor registers the bare `ping` / `pong` auto-response and the schema. It does not reset reachability. The attachment is `{ sessionId }` after hello succeeds.

`BrowserAgentAdapter` is constructed with the AgentDO namespace and D1. `createSession` returns the active session id. Minting stays on `redeem`. With no active session it throws `NO_SESSION`. `deliver` reads a UTF-8 JSON payload of at most 4000 bytes and calls `enqueue`. `delivered` is true only when the new state is `DELIVERED` and the row is not a duplicate. `revoke` loads `org_id` and `employee_id` from `runtime_sessions`, then calls `dropSession`.

Room sockets verify this token before room authority. See `realtime.md`.

Chat text has zero authority. Task transitions stay in TaskDO.

## Limits

Issue and revoke stay on the trusted RPC path until a human session exists. Direct Durable Object RPC can still name an employee id. JSON `ping` wakes the object. A duplicate agent-delivery message uses the task command key and does not insert a second inbox row or set `current_task_id`. `@ai-company/domain` is an API devDependency that the Worker imports. Tests and the local bundle resolve it.
