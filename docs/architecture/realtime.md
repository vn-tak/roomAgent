# Realtime

RoomDO is the ordering authority for one room. The object name is `room:{org_id}:{room_id}`. Storage is SQLite. The API Worker checks the id shape and the WebSocket upgrade, then forwards the request. It does not keep room state.

## Hibernation

The constructor registers `setWebSocketAutoResponse` for the bare frame `ping` / `pong`. That reply does not wake a hibernated object. A JSON `ping` is an ordinary message and does wake it. Sockets are accepted with `acceptWebSocket`. The attachment that survives hibernation is `{ employeeId, sessionId }`. Sequence, events, and presence live in SQLite.

## Protocol

Client messages are `session.hello`, `presence.update`, `message.send`, JSON `ping`, `task.ack`, `task.start`, and `task.submit`. `artifact.submit` returns `NOT_AVAILABLE` and does not change a task. A task frame requires session scope `task.accept`, a task id, and an idempotency key. RoomDO calls TaskDO. On success it appends `task.updated`. A session without `task.accept` receives `NO_SCOPE` and the room sequence stays put.

Server envelopes are `{ v: 1, type, event_id, seq, data }`. Stored types include `member.joined`, `member.left`, `presence.updated`, `message.created`, `task.available`, and `task.updated`. `session.ready`, `session.revoked`, `error`, and JSON `pong` are not stored and do not consume a sequence number.

`session.hello` carries `employee_id`, a 64 hex `token`, and `last_seen_seq`. RoomDO calls `AgentDO.verify` with scope `room.read` before authorize, membership, and the cursor. `SESSION_INVALID` leaves the socket open so the client can retry. `SUSPENDED_AGENT_DENY` sends `session.revoked` and closes with code 4001. The object then replays events with a greater `seq`, at most 100. A larger gap returns `RESYNC_REQUIRED` and does not send a partial history. A negative, non-integer, or future cursor returns `INVALID_SEQUENCE`. The same presence state does not append another event.

`message.send` requires an idempotency key of 8 to 80 URL-safe characters and a body of 1 to 2000 characters. The same actor and key returns the original envelope to the sender only. A new message is broadcast to every open socket after the D1 head projection succeeds. If that projection fails, the object undoes the SQLite write.

## Authority

RoomDO calls `OrganizationDO.authorize`. Hello, presence, and leaving oneself require `room.read`. Sending a message requires `room.message.send`. Inviting another employee requires `agent.invite`. Removing another employee requires `agent.remove`. Publishing `task.available` requires `task.create`. Publishing `task.updated` requires `task.assign`. An employee must also be an active member of the room. The owner human is not a room member and may publish when authorize allows it.

After hello, `presence.update` calls `sessionOpen` with scope `room.read`. `message.send` calls `sessionOpen` with scope `room.message.send`. `task.ack`, `task.start`, and `task.submit` call `sessionOpen` with scope `task.accept`. `SESSION_REVOKED`, `SESSION_EXPIRED`, and `SUSPENDED_AGENT_DENY` close the socket. `NO_SCOPE` is an error and leaves the socket open. Room RPC such as `postMessage` and `join` stays on the trusted path and does not require a session token.

Chat text has no authority. A message body is an event. It does not create an override or change organization policy.

## Membership

Active membership stays in D1 `room_memberships`. A second active join is idempotent and does not bump the sequence. Leaving sets status `left`, appends `member.left`, and closes that employee's sockets with `session.revoked` and close code 4001. A suspended employee is denied by OrganizationDO. Hello closes immediately. A later message sends `session.revoked` and closes.

The head sequence is projected to D1 `room_sequences` with `MAX`, so an older write cannot move the head backward. RoomDO remains the ordering authority.

## Gateway

`GET /orgs/:orgId/rooms/:roomId/socket`. A request without `Upgrade: websocket` returns 426 `UPGRADE_REQUIRED`. A malformed id returns 404. The URL does not carry an employee id or a token. `session.hello` is the credential check. The employee id alone does not authenticate the socket.

## Limits

There is no tail resync API after `RESYNC_REQUIRED`. A room `task.updated` frame is not a queue event. Domain events travel on the queue bus in `events.md`. A forged token for a real member returns `SESSION_INVALID` and does not emit `session.ready`. Task transitions are authoritative in TaskDO. The room event is a projection of a command that already succeeded.
