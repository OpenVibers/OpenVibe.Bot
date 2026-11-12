# Machine access relay (Contracts 0.409.0, stage 1)

Two paired machines talk through Bot's device WebSocket, and only while Network's signed grant allows it. This page is
the wire between OpenVibe.Link (stage 2) and Bot; Network's routes are named at the end.

## The grant token

Network mints an RS256 JWT with the key published at `GET /api/.well-known/jwks` (`kid` `ov-network-1`). Its claims are
`link.access-grant-token@1`:

```json
{ "iss": "https://openvibe.network", "aud": "lnk_TARGET", "sub": "lnk_ASKER", "jti": "tok_…",
  "grant_id": "grt_…", "scopes": ["agent", "send", "screen", "desk", "computer", "worker"],
  "iat": 1794430000, "exp": 1794430300 }
```

`aud` is the receiving machine, `sub` the asking machine, `exp` at most five minutes after `iat` and never after the
stored grant ends. The asking Link gets it with its own Link token:
`POST /api/v1/link/self/access-grants/:grant_id/token` → `{ grant, grant_token, expires_at }`.
The receiving Link verifies the same token itself: signature with Network's key, `iss`, `aud` = its own `lnk_…`,
`sub`, `scopes` and `exp`. It is the second enforcement; Bot is a relay, never the authority.

## Frames on `wss://…/device`

Every frame carries Bot's `v`, `seq`, `ts` like every other device frame. Only a socket authenticated with a Link
token (a Network-paired machine) may open a relay.

| out (Link → Bot) | answer | meaning |
| --- | --- | --- |
| `{ "type": "relay.open", "to": "lnk_B", "grant_token": "…" }` | `relay.opened` on both machines | Open one relay under that grant. Bot checks the token (RS256, issuer, `aud` = `to`, `sub` = the socket's own `lnk_…`, `exp`, scopes) and that B is online. |
| `{ "type": "relay.frame", "relay": "rly_…", "scope": "screen", "body": { … } }` | `{ "type": "relay.frame", "relay": "rly_…", "from": "lnk_A", "scope": "screen", "body": { … } }` on the other machine | One opaque body. Bot checks the relay is open, the sender is one of its two machines, the scope is in the grant and the token is still in date. The answer comes back with the same shape (`from` is B). `body` is at most 256 KiB. |
| `{ "type": "relay.close", "relay": "rly_…" }` | `{ "type": "relay.closed", "relay": "rly_…", "reason": "closed" }` on both | Either machine ends it. |

`relay.opened` is sent to both machines and carries `relay`, `from`, `to`, the same `grant_token`, `scopes` and
`expires_at`, so B can verify the grant before the first frame. `relay.closed` reasons are `closed`, `revoked`,
`expired` and `offline` (one of the two sockets went away).

### `computer`

For `scope: "computer"` the asking machine's `body` must name the level it wants: `{ "level": "observe" | "ask" |
"trusted" | "full", … }`. Bot refuses a level above the receiving machine's own setting (its status'
`telemetry.sensors.computer_level`, else its computer capability's level; unknown is treated as `ask`) and refuses
when the receiving machine does not offer its computer. The receiving Link still applies its own level, including the
owner's approval at `ask`.

### Audit

On the first frame of each scope in a relay, Bot tells Network `POST /internal/link-access/grants/:grant_id/use`
with `{ from_principal, to_principal, scope, action }`; Network stores the line both owners read
(`GET /api/v1/me/nodes/access-audit`). A failed ledger call never stops a relay.

## Agent tasks (`agent.task@1`)

Network delivers a task for a Link-local agent over HTTP:
`POST http://127.0.0.1:<bot>/api/v1/machines/:device_id/relay` with a Network service token (`cap` `bot.machine.relay`,
`X-OV-Subject` the machine's owner) and `{ "type": "agent.task", "task": { "id": "tsk_…", "thread": "thr_…",
"from": "agt_…", "to": "agt_…", "on_behalf_of": "usr_…", "message": { "role": "user", "parts": [{ "type": "text",
"text": "…" }] } } }`. Bot answers `201 { machine_id, delivered: true }`, or `404` when the machine is not that
person's, `409` when it is offline or the id is not a `tsk_…`, `422` for another type.

The machine receives `{ "type": "agent.task", "task": { … } }` on its device socket. It answers:

```json
{ "type": "agent.task_result", "task_id": "tsk_…", "status": "running|completed|failed|cancelled",
  "result": { "parts": [{ "type": "text", "text": "at most 8000 characters" }] } }
```

Bot checks the task was delivered to that socket, the status and at most 20 text parts of 8000 characters, forwards it
to Network (`POST /api/v1/agents/tasks/:id/result`), and acknowledges with
`{ "type": "agent.task_result_ack", "task_id": "tsk_…", "status": "…" }`. Only the machine the task reached may answer
it; a `completed`/`failed`/`cancelled` answer closes it.

## Revocation

Bot subscribes at OpenVibe.Events to `network.link.access.revoked@1`. On that event every relay under the payload's
`grant_id` is closed at once (both machines get `relay.closed` with reason `revoked`), and the relay never outlives its
token's `exp` anyway. The same event is what the two Links should act on for their local sessions.

## Network's routes (stage 2)

| call | who |
| --- | --- |
| `POST /api/v1/link/self/access-requests` `{ to_principal \| target, scopes, duration_seconds \| null, reason, from_agent? }` | the asking machine (Link token) |
| `GET /api/v1/link/self/access-requests`, `GET /api/v1/link/self/access-grants` | the machine (sent and received) |
| `POST /api/v1/link/self/access-grants/:id/token`, `GET /api/v1/link/self/access-grants/:id/status` | the machine |
| `GET/POST /api/v1/me/nodes/access-requests`, `POST /api/v1/me/nodes/access-requests/:id/answer` `{ approve, scopes?, duration_seconds? }` | the owner's session |
| `GET /api/v1/me/nodes/access-grants`, `POST /api/v1/me/nodes/access-grants/:id/revoke`, `GET /api/v1/me/nodes/access-audit` | the owner's session |
| `GET/PUT /api/v1/me/nodes/:id/access-settings` `{ others_may_ask, auto_agent_send, agents_talk }` | the owner's session |
| `POST /api/v1/agents/register` `{ id?, kind, name, skills, status, owner? }` | a service token (`network.agents.register`) or the machine (Link token) |
| `POST /api/v1/agents/:id/tasks` `{ from, thread?, message, skillId? }` | a service token or the machine |
| `GET /api/v1/agents/tasks/:id`, `GET /api/v1/agents/inbox` | the sending/receiving agent's machine or service |
| `GET /api/v1/me/agents`, `PUT /api/v1/me/agents/:id/allow-others`, `GET /api/v1/me/agent-threads`, `POST /api/v1/me/agent-threads/:id/stop` | the owner's session |
