# OpenVibe.Bot — the device and control protocol

Everything here is exactly what `server/realtime.js` implements today; the device agent job builds
against this document. Two WebSockets share one hub:

- `wss://openvibe.bot/device` — one **outbound** connection per device (ADR-043 decision 4). It works
  behind any home router and on an ESP32; video goes separately over WHIP to OpenRe.
- `wss://openvibe.bot/control` — operators (a signed-in person, or a service acting for one).

Every frame is JSON with three envelope fields on **every** message:

```json
{ "v": 1, "seq": 7, "ts": 1738065600000, "type": "…" }
```

`seq` is a per-connection monotonic counter (each side numbers its own frames); `ts` is epoch
milliseconds. Unknown `type`s are answered with an `error` and otherwise ignored.

---

## 1. `/device` — the device WebSocket

### Authentication

The upgrade carries `Authorization: Bearer <device credential>` — **never** a query string (a
credential in `?credential=` is ignored and the socket stays unpaired). A bad or revoked credential
closes the socket with code **4002**. A device that has no credential yet connects **without** the
header; such a socket may only send `pair` until it is answered (anything else → `error`
`bot.not_paired`). One socket per device: a second connection replaces the first (close code **4000**),
so a reconnecting agent cannot be shadowed by a stale socket.

### Server → device

| type | fields (besides v, seq, ts) | when |
|---|---|---|
| `paired` | `device_id, credential, publish_key, robot_ids, profile_id, profile` | the answer to `pair`; `credential`/`publish_key` are shown **once** |
| `hello` | `session_id, device_id, robot_ids, server_time` | on every authenticated connection |
| `config` | `heartbeat_ms, limits, allowed_commands, estop_latched` | right after `hello` |
| `command` | `id, kind, value, deadline_ms, operator{subject,role}, robot_id` | an operator's command passed the gate |
| `estop` | `latched, by, at` | the e-stop latched or the owner cleared it |
| `heartbeat_ack` | `seq, server_time` | the answer to `heartbeat`; the device computes RTT |
| `error` | `code, detail` | a frame the server refused |

### Device → server

| type | fields (besides v, seq, ts) | notes |
|---|---|---|
| `pair` | `robot, code, agent_version, device_kind, drivers[], capabilities{}, name` | the one-time pairing code; `robot` (from the installer command / QR) attributes a wrong try to that robot's code |
| `heartbeat` | `seq, rtt_ms` | every `heartbeat_ms` (1 s); `rtt_ms` is the device's own measured latency |
| `telemetry` | `battery, voltage, sensors{}, …` | at most 2 Hz; extra frames are dropped |
| `status` | `firmware, capabilities, faults[], estop_latched` | on connect and on change |
| `ack` | `id` | a command ran |
| `nack` | `id, fault_code` | a command was refused on the device |
| `estop_state` | `latched, by, at, robot_id?` | a hardware latch; `robot_id` omitted = every robot the device serves |

`kind` is one of `drive`, `actuator`, `ptz`, `say`, `display`, `halt`. `deadline_ms` is an absolute
epoch-ms instant and is present on the motion kinds only (`drive`, `actuator`, `ptz`): the device
**must** stop the motors at that instant if no newer command arrived, and on every disconnect or crash
path, without asking the network.

### Examples

Pair (unauthenticated socket):

```json
{ "v": 1, "seq": 1, "ts": 1738065600000, "type": "pair", "robot": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X",
  "code": "7Q2M-4XZP", "agent_version": "0.1.0", "device_kind": "onboard",
  "drivers": ["pca9685", "ads7830"], "capabilities": { "camera": { "resolution": "640x480" } }, "name": "Rover" }
```

The answer (the only time the credential appears over the wire):

```json
{ "v": 1, "seq": 1, "ts": 1738065600000, "type": "paired", "device_id": "dev_01J8Z4…",
  "credential": "Xb3…", "publish_key": "Vt9…", "robot_ids": ["rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X"],
  "profile_id": "adeept.adr036", "profile": { "id": "adeept.adr036", "limits": { "max_command_ms": 300, "heartbeat_ms": 1000 } } }
```

```json
{ "v": 1, "seq": 2, "ts": 1738065600000, "type": "hello", "session_id": "sess_01J8Z4…",
  "device_id": "dev_01J8Z4…", "robot_ids": ["rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X"], "server_time": "2026-09-29T19:20:00.000Z" }
```

```json
{ "v": 1, "seq": 3, "ts": 1738065600000, "type": "config",
  "heartbeat_ms": 1000, "limits": { "max_speed": 1, "max_turn": 1, "max_command_ms": 300, "heartbeat_ms": 1000 },
  "allowed_commands": ["drive", "actuator", "ptz", "say", "display", "halt"], "estop_latched": false }
```

A drive command (a held control re-sends every 150 ms with a fresh `id`):

```json
{ "v": 1, "seq": 9, "ts": 1738065600000, "type": "command", "id": "cmd_01J8Z4F…", "kind": "drive",
  "value": { "throttle": 0.6, "steer": -0.25 }, "deadline_ms": 1738065600300,
  "operator": { "subject": "usr_01J8…", "role": "operator" }, "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X" }
```

```json
{ "v": 1, "seq": 10, "ts": 1738065600005, "type": "ack", "id": "cmd_01J8Z4F…" }
{ "v": 1, "seq": 11, "ts": 1738065600010, "type": "nack", "id": "cmd_01J8Z4F…", "fault_code": "obstacle" }
```

```json
{ "v": 1, "seq": 12, "ts": 1738065600500, "type": "heartbeat", "seq": 41, "rtt_ms": 63 }
{ "v": 1, "seq": 4, "ts": 1738065600501, "type": "heartbeat_ack", "seq": 41, "server_time": "2026-09-29T19:20:00.501Z" }
```

```json
{ "v": 1, "seq": 13, "ts": 1738065600800, "type": "telemetry", "battery": 0.72, "voltage": 7.41,
  "sensors": { "ultrasonic": 118 }, "rssi": -57 }
```

```json
{ "v": 1, "seq": 14, "ts": 1738065600900, "type": "status", "firmware": "adeept-0.1.0",
  "capabilities": { "drive": { "type": "differential", "axes": ["throttle", "steer"] } }, "faults": [], "estop_latched": false }
```

```json
{ "v": 1, "seq": 15, "ts": 1738065601200, "type": "estop_state", "latched": true, "by": "device", "at": "2026-09-29T19:20:01.200Z" }
{ "v": 1, "seq": 6, "ts": 1738065601201, "type": "estop", "latched": false, "by": "usr_01J8…", "at": "2026-09-29T19:20:01.201Z" }
```

Liveness: the server marks a device **offline** when no frame arrives within
`heartbeat_ms × 2 + 3000 ms` (2 missed beats plus the grace) and never queues a command for it; a
heartbeat or any frame brings it back. Commands are never replayed after a reconnect, and a repeated
`id` is answered with the first result without reaching the device again.

---

## 2. `/control` — the operator WebSocket

### Authentication

`ov_token` cookie (a Network user JWT, set by `/auth`) **or** `Authorization: Bearer <user JWT>`, or a
**service token** with capability `bot.robot.control` (audience `openvibe.bot`) plus
`X-OV-Subject: usr_…` naming the person it acts for. Without one the socket closes with code **4002**.
The gate then applies the **acted-for subject's** role — a service acting for a viewer is a viewer.

### Client → server

| type | fields | notes |
|---|---|---|
| `join` | `robot_id` | subscribe to a robot; refused with `error` `bot.not_an_operator` when the caller has no access |
| `leave` | — | unsubscribe |
| `command` | `id, kind, value, ms?` | the same `kind`s as the device; `ms` requests a deadline (capped by `max_command_ms`) |
| `estop` | — | latch the e-stop (owner or operator) |
| `estop_clear` | — | clear the latched e-stop (**owner only**) |

### Server → client

| type | fields | notes |
|---|---|---|
| `joined` | `robot, role, profile, allowed_commands, state` | the answer to `join` |
| `robot_state` | `state{robot_id, online, estop{latched,by,at}, latency_ms, battery, telemetry, status, queue}` | on every change and on telemetry, ≤ 2 Hz |
| `command_result` | `id, result, code?, reason?, latency_ms?, cached?` | `result` is `ack`, `nack`, `refused` or `expired`; a repeated `id` is answered `cached: true` |
| `error` | `code, detail` | a frame or join the server refused |

`robot_state.queue` (only for a `queue` robot) is
`{ robot_id, subject, active, turn_ends_at, turn_subject, position, budget, used }` — a waiting
person's `position` is 1-based (0 while they hold the turn).

### Examples

```json
{ "v": 1, "seq": 1, "ts": 1738065600000, "type": "join", "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X" }
```

```json
{ "v": 1, "seq": 1, "ts": 1738065600001, "type": "joined",
  "robot": { "id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "name": "Rover", "access_policy": "private",
             "estop": { "latched": false, "by": null, "at": null } },
  "role": "operator", "profile": { "id": "adeept.adr036" },
  "allowed_commands": ["drive", "actuator", "ptz", "say", "display", "halt"],
  "state": { "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "online": true, "latency_ms": 63, "battery": 0.72, "queue": null } }
```

```json
{ "v": 1, "seq": 2, "ts": 1738065600200, "type": "command", "id": "cmd_01J8Z4F…",
  "kind": "drive", "value": { "throttle": 0.6, "steer": -0.25 }, "ms": 300 }
```

```json
{ "v": 1, "seq": 2, "ts": 1738065600205, "type": "command_result", "id": "cmd_01J8Z4F…",
  "result": "ack", "latency_ms": 42 }
```

```json
{ "v": 1, "seq": 3, "ts": 1738065600206, "type": "command_result", "id": "cmd_01J8Z4F…",
  "result": "refused", "code": "bot.device_offline", "reason": "the device is offline; commands are never queued" }
```

```json
{ "v": 1, "seq": 3, "ts": 1738065600800, "type": "robot_state",
  "state": { "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "online": true,
             "estop": { "latched": false, "by": null, "at": null }, "latency_ms": 63, "battery": 0.71,
             "telemetry": { "battery": 0.71, "voltage": 7.4 }, "status": null,
             "queue": { "active": false, "position": 3, "turn_ends_at": null, "budget": 50, "used": 0 } } }
```

```json
{ "v": 1, "seq": 4, "ts": 1738065601000, "type": "estop" }
{ "v": 1, "seq": 4, "ts": 1738065601001, "type": "error", "code": "bot.forbidden", "detail": "only the owner clears the e-stop" }
```

Refusal codes (the gate, in order): `bot.robot_not_found`, `bot.unknown_command`, `bot.estop_latched`,
`bot.not_an_operator`, `bot.sign_in`, `bot.read_only`, `bot.command_not_allowed`, `bot.device_offline`,
`bot.cooldown`, `bot.not_your_turn`, `bot.turn_budget`, `bot.unknown_animation`, `bot.invalid_input`.

---

## 3. REST (the same gate, HTTP)

Every error is RFC 9457 `application/problem+json`. Authenticate with a Network **user token**
(`Authorization: Bearer`, people act on their own things) or a **service token** with the capability
shown; a service acts for `X-OV-Subject` / the body's `owner`.

| Method & path | Auth (capability) | Answer |
|---|---|---|
| `GET /profiles`, `GET /profiles/:id` | public | `{ profiles[] }` / `{ profile }` |
| `GET /robots` | user, or `bot.robot.read` + `?owner=` | `{ robots[] }` |
| `POST /robots` | the owner, or `bot.robot.manage` | `201 { robot, pairing{code,expires_at,installer} }` |
| `GET /robots/:id` | a member, or `bot.robot.read` | `{ robot, role }` |
| `PATCH /robots/:id` | owner, or `bot.robot.manage` | `{ robot }` |
| `DELETE /robots/:id` | owner, or `bot.robot.manage` | `204` |
| `POST /robots/:id/pairing-code` | owner, or `bot.robot.manage` | `201 { code, expires_at, installer }` |
| `GET /robots/:id/operators` | member, or `bot.robot.read` | `{ operators[] }` |
| `POST /robots/:id/operators` | owner, or `bot.robot.manage` | `201 { operators[] }` |
| `DELETE /robots/:id/operators/:subject` | owner, or `bot.robot.manage` | `{ operators[] }` |
| `GET /robots/:id/devices` | member, or `bot.robot.read` | `{ devices[] }` (no hashes, `online`) |
| `POST /devices/:id/rotate` | the robot's owner, `bot.device.connect` | `{ device, credential, publish_key }` (once) |
| `POST /devices/:id/revoke` | the robot's owner, `bot.device.connect` | `{ device }`; the socket closes at once |
| `POST /robots/:id/estop` | owner/operator, `bot.robot.control` | `{ robot }` |
| `POST /robots/:id/estop/clear` | **owner only**, `bot.robot.control` | `{ robot }` |
| `GET /robots/:id/audit?limit=&before=` | owner, or `bot.robot.read` | `{ audit[], next_before }` (newest first) |
| `POST /pair` | the one-time code is the credential | `201 { device_id, credential, publish_key, robot_id, profile }` |

Not in `/api/v1`: `GET /api/health`, `GET /api/ready`, `GET /metrics`, `GET /release.json`, the
`/auth/*` SSO routes, and `GET /` (a one-line text health placeholder).

---

## 4. Audit and events

Every command — allowed or refused — is written to `command_audit` (robot, device, the operator
principal and its kind, role, kind, the clamped value summary, result `ack|nack|refused|expired`,
reason, latency, time), kept 30 days. The outbox publishes `bot.robot.online`, `bot.robot.offline`,
`bot.estop.set`, `bot.estop.cleared` and `bot.command.refused` — small payloads of ids, kinds and
results, never a credential, a pairing code or a publish key.
