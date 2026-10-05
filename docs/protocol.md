# OpenVibe.Bot — the device and control protocol

Everything here is exactly what `server/realtime.js` implements today; the device agent job builds
against this document. Three WebSockets share one hub:

- `wss://openvibe.bot/device` — one **outbound** connection per device (ADR-043 decision 4). It works
  behind any home router and on an ESP32; video goes separately over WHIP to OpenRe.
- `wss://openvibe.bot/control` — operators (a signed-in person, or a service acting for one).
- `wss://openvibe.bot/watch` — anyone, read-only: the public state of a robot whose owner allows embedding
  (§2.1, the embeddable panel).

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

**Pairing authority** (`BOT_PAIRING_AUTHORITY`, `bot` by default, or `network`). With `network` the
pairing code is minted by OpenVibe.Network (Bot calls `POST /internal/node-pairings` with its own service
token, `{owner: {kind: 'user', subject}, ref: <robot id>}`) and Bot stores none; the installer command
carries `--network <Network URL> --pairing pair_… --code XXXX-XXXX` (plus `--driver <kind>`, as below), and the machine pairs on Network and
connects with a node token (below). The `pair` frame is then answered `error` `bot.pairing_moved` (its
`detail` names the Network URL) and the socket stays unpaired. Devices that already hold a Bot credential
keep connecting with it either way.

**The installer command** is `curl -fsSL <BOT_INSTALLER_URL> | sh -s -- --robot rob_… --code XXXX-XXXX` (or the
Network form above), plus `--driver adeept`, `adeept-mecanum` or `cozmo` for the `adeept.adr036`,
`adeept.adr036.mecanum` and `cozmo` profiles; any other profile gets no `--driver` (the installer's dry-run
`none`). `GET /install` answers a 302 to `BOT_INSTALLER_SOURCE_URL` (OpenVibe.Node's `install/install.sh`).

**A Network-paired machine** (a node principal `nod_…`, paired on OpenVibe.Network for one of its
owner's robots) carries `Authorization: Bearer <node token>` instead: a Network JWT with `actor_type`
`node`, `sub` `node:nod_…` and audience `openvibe.bot`. Bot binds it to a device on first use (from
Network's record: the robot the machine was paired for, which must be one of the principal's owner's
robots, and the principal must be `active`), then speaks first exactly as for a credential — `hello`,
`config` — with **no** `paired` frame. A refused node token, or a principal Bot will not bind (revoked,
paired for another service, for someone else's robot, or revoked here), closes the socket with **4002**.
A node token lives 300 s: the machine sends `reauth` with a fresh one before it expires; with no valid
`reauth` within 330 s of the last token Bot closes the socket with **4002**. Any other Bearer is a device
credential, as above.

Frames sent while authentication is still in progress — right after an upgrade that carries the
header, or after `pair` until it is answered — are **kept** and handled in arrival order once it
completes (after `hello` and `config`), so a device may send its first `status` and `estop_state`
straight after the upgrade. They are never answered `bot.not_paired`. If the credential is refused
they are discarded with the socket; after a refused `pair` they are answered as on an unpaired socket.
At most 64 frames wait; any more are answered `error` `bot.not_ready`.

### Server → device

| type | fields (besides v, seq, ts) | when |
|---|---|---|
| `paired` | `device_id, credential, publish_key, whip_url, robot_ids, profile_id, profile` | the answer to `pair`; `credential`/`publish_key`/`whip_url` are shown **once**; without OpenRe configured `video: "not_configured"` instead of `publish_key`/`whip_url` |
| `hello` | `session_id, device_id, robot_ids, server_time` | on every authenticated connection |
| `config` | `heartbeat_ms, limits, allowed_commands, estop_latched` | right after `hello`, and again whenever the owner changes the robot's limits (or `allow` lists) and whenever Bot's latch is set or cleared (after the `estop` frame) |
| `command` | `id, kind, value, deadline_ms, operator{subject,role}, robot_id` | an operator's command passed the gate |
| `estop` | `latched, by, at` | the e-stop latched or the owner cleared it |
| `heartbeat_ack` | `echo, t, server_time` | the answer to `heartbeat`; `echo` is the heartbeat's `t` (or `null`), so the device computes RTT, and `t` repeats a finite `t` (device ms) unchanged — the field OpenVibe.Node reads. The envelope `seq` is Bot's own counter and never echoes the device's |
| `rotate` | — | the owner forced a rotation of a Network-paired machine (`POST /devices/:id/rotate`); the machine rotates its credential with Network itself |
| `error` | `code, detail` | a frame the server refused |

### Device → server

| type | fields (besides v, seq, ts) | notes |
|---|---|---|
| `pair` | `robot, code, agent_version, device_kind, drivers[], capabilities{}, name` | the one-time pairing code; `robot` (from the installer command / QR) attributes a wrong try to that robot's code. With `BOT_PAIRING_AUTHORITY=network` → `error` `bot.pairing_moved` |
| `heartbeat` | `t, rtt_ms` | every `heartbeat_ms` (1 s); `t` is the device's send time in unix ms (a finite number), returned as both `heartbeat_ack.echo` and `heartbeat_ack.t`; `rtt_ms` is the device's own measured latency |
| `telemetry` | `battery, voltage, sensors{}, events[]?, …` | at most 2 Hz; extra frames are dropped — except a frame with a non-empty `events` array (a fault, a bump, low battery), which is always delivered and does not count against the samples' window. `battery` is either a 0..1 fraction or an object `{volts, percent}` with `percent` 0..100 (as OpenVibe.Node sends it); `robot_state.battery` is always the fraction 0..1 (or `null`), while `robot_state.telemetry` keeps the raw frame |
| `status` | `firmware, capabilities, faults[], estop_latched, device_kind?, drivers[]?, agent_version?` | on connect and on change. See below |
| `reauth` | `token` | a Network-paired machine only: a fresh node token for the same principal, before the last one expires (300 s); a refused one is answered `error` `bot.reauth_refused` and moves nothing |
| `ack` | `id` | a command ran (or, keyed by a job id, a job was accepted: §1.2) |
| `nack` | `id, fault_code` | a command (or a job, §1.2) was refused on the device |
| `estop_state` | `latched, by, at, robot_id?` | the device's own latch, a **report**; `robot_id` omitted = every robot the device serves. See below |

`kind` is one of `drive`, `actuator`, `ptz`, `say`, `display`, `halt`, and a device only ever gets the
kinds its robot's profile declares (§1.1), with values in the shapes and ranges declared there.
`deadline_ms` is an absolute epoch-ms instant and is present on the motion kinds only (`drive`,
`actuator`, `ptz`): the device **must** stop the motors at that instant if no newer command arrived, and
on every disconnect or crash path, without asking the network. `halt` (value `{}`, no deadline) stops
everything at once and passes the gate even while the e-stop is latched.

`status` of a Network-paired machine also says what it is: `device_kind` (`onboard` \| `bridge` \|
`server`), `drivers` (an array of strings), `capabilities` (an object) and `agent_version` (a string of at
most 40 characters), each optional. Bot stores them on the device row when they differ from it (the row
starts as `onboard`, no drivers, `{}`, no version); if any of them is invalid the frame is answered `error`
`bot.bad_frame` and the row is left unchanged. For a credential device these fields are not stored: what
it declared at pairing stays.

`config.limits` are the **effective** limits — the owner's (`PATCH /robots/:id` `limits`) clamped by the
profile's — as `{ max_speed, max_turn, max_command_ms, heartbeat_ms }`, the same numbers the gate clamps
with; `allowed_commands` is what the owner may send: the profile's kinds, cut by the owner's allowlist,
always with `halt`. Both are re-sent to the connected device the moment the owner changes the limits.

`whip_url` is where the device publishes its camera: OpenRe's WHIP ingest (`POST`, RFC 9725, body
`application/sdp`) at `<BOT_WHIP_BASE>/<publish_key>`, any trailing slash on the base trimmed. It is built
from the device's own publish key (never the owner's stream key), so it is a secret like the key: returned
only by `pair` / `POST /pair` and by a rotation (which issues a new key, so a new URL), never by a read.
With `BOT_WHIP_BASE` unset or empty the field is left out of the answer entirely and the device runs
without video.

`publish_key` is an ingest key OpenRe.Stream issued, the only kind its WHIP ingest admits: each robot has one
OpenRe stream (external ref `bot:robot:<robot id>`, protocol `webrtc`, no recording), created at its first
pairing with `BOT_OPENRE_URL`/`BOT_OPENRE_TOKEN` set and found again by that ref (the token needs
`openre.stream.read`, `openre.stream.write` and `openre.key.rotate`; `openre.stream.*` covers the first two).
A pairing or `POST /devices/bind` rotates the stream's key with no grace (the robot's previous device stops publishing), a
credential rotation with the credential's grace, a revocation with no grace and the live session ended;
removing the robot does the same and archives the stream when nothing is live. Bot stores the stream id and
the key's hint, never the key. OpenRe refusing is `502 bot.openre_refused` (its problem code in `detail`),
not answering `503 bot.openre_unavailable`; a pairing that fails so leaves the code unused and no device.
With `BOT_OPENRE_URL` or `BOT_OPENRE_TOKEN` unset the answers carry `"video": "not_configured"` and neither
`publish_key` nor `whip_url`.

### 1.1 Command values (the profile's `commands`)

Each profile (`server/profiles/*.json`) declares, per kind, what its device accepts; the gate allows only
those kinds (plus `halt`) and builds every value from the declaration — only the declared axes and
names, clamped into the declared ranges and the owner's limits; a value the device would refuse is
refused here (`bot.invalid_input`, `bot.unknown_actuator`) and never sent.

| kind | profile declares | the device gets |
|---|---|---|
| `drive` | `axes: { throttle, steer }` (differential) or `{ x, y, rotation }` (mecanum) → `[min, max]` | every declared axis (an absent one is 0): `{ "throttle": 0.6, "steer": -0.25 }` or `{ "x": 0.5, "y": -0.4, "rotation": 0 }`; `max_speed` caps throttle/x/y, `max_turn` steer/rotation |
| `ptz` | `axes: { pan, tilt, zoom }` → `[min, max]` | only the axes sent: `{ "pan": 0.2 }` |
| `actuator` | `names: { <name>: { type, … } }` | `{ "name": "<name>", "value": … }` — `number` in its `range`; `rgb` `{r,g,b}` integers 0–255 (plus `index` < `count` when declared) or `null` (off); `tone` `{ "hz": 440 }` inside its `hz` range (an operator may send `{ "note": "A4" }`) or `null` (off); `bool` `true`/`false` |
| `say` | `max_chars` | `{ "text": "…" }` |
| `display` | `modes` of `text`, `face`, `image_png_b64`; `faces`; `max_chars` | exactly one of `{ "text" }`, `{ "face": "happy" }`, `{ "image_png_b64": "…" }` (base64, ≤ 48 KiB) |
| `halt` | — (every profile) | `{}` |

The shipped profiles and the plugin each one matches (`test/profiles.test.js` checks every panel control
against these):

| profile | device | commands |
|---|---|---|
| `adeept.adr036` | Node plugin `adeept_adr036`, ordinary wheels | `drive {throttle, steer}`; `actuator` `pan`/`tilt` −1..1, `buzzer` tone 220–880 Hz, `lights` rgb (8 LEDs) |
| `adeept.adr036.mecanum` | Node plugin `adeept_adr036`, mecanum wheels | `drive {x, y, rotation}`; the same actuators |
| `cozmo` | Node plugin `cozmo` | `drive {throttle, steer}`; `actuator` `head` −1..1, `lift` 0..1, `backpack_lights`/`cube_lights` rgb; `say`; `display` text, face (`neutral happy sad surprised sleepy angry`) or image |
| `camera.onvif` | server driver `onvif` | `ptz {pan, tilt, zoom}` −1..1 |
| `sim.rover` | server driver `sim` | `drive {throttle, steer}` |

**A device's `estop_state` is a report, never a clear.** `latched: true` latches each robot the device is
attached to (if it is not already latched). `latched: false` is recorded as the device's reported state
only (`robot_state.state.device_estop`); it never clears Bot's latch — clearing is the owner's alone
(`estop_clear` on `/control`, `POST /robots/:id/estop/clear`), after which Bot sends `estop` with
`latched: false`. A `robot_id` the device is not attached to is refused with `error` `bot.forbidden`
and audited (`kind: estop_state`, `result: refused`); nothing changes on that robot.

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
  "credential": "Xb3…", "publish_key": "Vt9…", "whip_url": "https://ingest.openre.stream/whip/Vt9…",
  "robot_ids": ["rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X"],
  "profile_id": "adeept.adr036", "profile": { "id": "adeept.adr036", "limits": { "max_command_ms": 300, "heartbeat_ms": 1000 } } }
```

```json
{ "v": 1, "seq": 2, "ts": 1738065600000, "type": "hello", "session_id": "sess_01J8Z4…",
  "device_id": "dev_01J8Z4…", "robot_ids": ["rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X"], "server_time": "2026-09-29T19:20:00.000Z" }
```

```json
{ "v": 1, "seq": 3, "ts": 1738065600000, "type": "config",
  "heartbeat_ms": 1000, "limits": { "max_speed": 1, "max_turn": 1, "max_command_ms": 300, "heartbeat_ms": 1000 },
  "allowed_commands": ["drive", "actuator", "halt"], "estop_latched": false }
```

An actuator command on the Adeept (the pan servo, −1..1):

```json
{ "v": 1, "seq": 8, "ts": 1738065600000, "type": "command", "id": "cmd_01J8Z4E…", "kind": "actuator",
  "value": { "name": "pan", "value": -0.4 }, "deadline_ms": 1738065600300,
  "operator": { "subject": "usr_01J8…", "role": "operator" }, "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X" }
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
{ "v": 1, "seq": 12, "ts": 1738065600500, "type": "heartbeat", "t": 1738065600500, "rtt_ms": 63 }
{ "v": 1, "seq": 4, "ts": 1738065600501, "type": "heartbeat_ack", "echo": 1738065600500, "t": 1738065600500, "server_time": "2026-09-29T19:20:00.501Z" }
```

```json
{ "v": 1, "seq": 13, "ts": 1738065600800, "type": "telemetry", "battery": 0.72, "voltage": 7.41,
  "sensors": { "ultrasonic": 118 }, "rssi": -57 }
{ "v": 1, "seq": 14, "ts": 1738065600850, "type": "telemetry", "battery": 0.72, "events": [{ "kind": "bump" }] }
{ "v": 1, "seq": 15, "ts": 1738065600900, "type": "telemetry", "battery": { "volts": 7.42, "percent": 59 }, "sensors": { "ultrasonic": 118 } }
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

### 1.2 Jobs (platform.job-frame@1)

Bot is the dispatcher of plan T14: it hands a `platform.job@1` job to a paired OpenVibe.Node over this socket
and meters it. The Run service (which owns `run.job.*`) calls it over the internal HTTP API under the
`bot.job.dispatch` capability: `POST /api/v1/jobs`, `POST /api/v1/jobs/:id/cancel` and `GET /api/v1/jobs/:id`
(`server/api/v1.js`) call the jobs service `server/jobs/index.js` `createJobs({ db, hub, usage, log, now })`, which
wraps `server/jobs/dispatch.js` `dispatch(db, nodeId, job, { link, project, subject, provider })` and
`cancel(db, jobId, { link })` and holds the one `createJobFrames` instance (and its stdout rings) that both this
socket and `GET /api/v1/jobs/:id` use. Each frame carries the envelope (`v`, `seq`, `ts`, `type`) and is validated
against `platform.job-frame@1` from the pinned openvibe-contracts; an invalid one is answered `error`
`bot.bad_frame`, and one naming a job of another device `error` `bot.unknown_job` (nothing changes).

| direction | type | fields | Bot's part |
|---|---|---|---|
| server → device | `job` | `job` (platform.job@1) | sent by `dispatch` when the device is connected, and resent on every reconnect while unacked. Never sent for a `class` missing from the device's stored `capabilities.worker.runtime_classes` (dispatch answers `409 bot.class_unadvertised`; a queued job whose class is no longer advertised fails with `fault_code` `bot.class_unadvertised`) |
| server → device | `job_cancel` | `id` | sent by `cancel` if the job was sent and has not ended; resent on a reconnect and when a `job_started` or `ack` crosses it. A job not yet started is `cancelled` at once; a cancelled job is never sent again |
| server → device | `job_exit_ack` | `id` | after every reading of the job is committed to `run_usage_outbox`; the Node then forgets the job and stops resending its `job_exit` |
| device → server | `ack` / `nack` | `id`, `fault_code` | the Node accepted (`placed`) or refused (`failed`, `fault_code` kept) the job |
| device → server | `job_started` | `id, started_ms` | `running`; the first `started_ms` anchors every second and never changes |
| device → server | `job_stdout` | `id, chunk_seq, chunk` | the last 1 MiB of each job, in memory; a `chunk_seq` already held is dropped. Never metered |
| device → server | `job_usage` | `id, started_ms, second, cpu_ms?` | one reading for `second` (quantity 1); ignored once `job_exit` was taken |
| device → server | `job_exit` | `id, reason, code, result, usage{started_ms?, wall_ms, …}` | authoritative: writes (or finds) every second it stands for, sets the final state, then `job_exit_ack`. A second `job_exit` writes nothing and is acked again |

States (`run_jobs.state`): `queued` → `placed` (ack) → `running` (`job_started`) → `succeeded` (exited, code 0),
`failed` (exited ≠ 0, `limit`, `stopped`, `failed`, or a `nack`), `cancelled`, `expired` (`ttl`).

**Metering keys.** Each wall-clock second `n` of a job is one `platform.usage-sample@1` reading:

| field | value |
|---|---|
| `id`, `idempotency_key` | `run:<job id>:<n>` |
| `service` / `operation` / `unit` | `run` / `function.invoke` / `s` |
| `quantity` | `1`; the partial last second `(wall_ms mod 1000)/1000`, never 0 |
| `at` | `new Date(started_ms + n*1000).toISOString()` |
| `resource` / `node` / `source` | the job id / the device id (`dev_…`) / `openvibe-node.worker` |
| `project`, `subject`, `provider` | from Bot's record of the job (what `dispatch` was given); left out when unset |

No field depends on when or how often a frame arrived, and no rating field is set. `job_exit` writes seconds
0 … floor(wall_ms/1000) − 1 and the partial last second, so a lost `job_usage` is backfilled; a resend, a
`job_usage` and the backfill of one second are one key, kept once in `run_usage_outbox` (`ON CONFLICT DO
NOTHING`). `run_jobs.usage_read` (seconds queued) only moves forward. Every reason is billed for the seconds the
process held, never beyond the job's own `limits.wall_ms` (a later second is not metered and `wall_ms` is capped
there). The relay posts each reading to OpenVibe.Billing's `billing.usage.record` (`POST <BOT_BILLING_URL>/api/v1/usage`,
`Authorization: Bearer <BOT_BILLING_TOKEN>`), one per request; 201 (written) and 200 (identical replay) mark it
sent. 400/409/413/422 mark it rejected (kept, never resent). Anything else, and `BOT_BILLING_URL` or
`BOT_BILLING_TOKEN` unset, leaves it queued and retried with backoff: a reading is never dropped and never billed
twice.

## 2. `/control` — the operator WebSocket

### Authentication

`ov_token` cookie (a Network user JWT, set by `/auth`) **or** `Authorization: Bearer <user JWT>`, or a
**service token** with capability `bot.robot.control` (audience `openvibe.bot`) plus
`X-OV-Subject: usr_…` naming the person it acts for. Without one the socket closes with code **4002**.
The gate then applies the **acted-for subject's** role — a service acting for a viewer is a viewer.
The same gate is reachable over HTTP as `POST /robots/:id/commands` (§3), so a bound channel's chat can
forward commands without holding a socket.

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
| `joined` | `robot, role, profile, allowed_commands, state` | the answer to `join`; `allowed_commands` is the role's allowlist cut to the profile's kinds, with `halt` for every role that may drive |
| `robot_state` | `state{robot_id, online, estop{latched,by,at}, latency_ms, battery, telemetry, status, device_estop{latched,at}, queue}` | on every change and on telemetry, ≤ 2 Hz (a telemetry frame with `events` always); `estop` is Bot's latch, `device_estop` the device's last report (or `null`) |
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
  "allowed_commands": ["drive", "actuator", "halt"],
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
             "telemetry": { "battery": 0.71, "voltage": 7.4 }, "status": null, "device_estop": null,
             "queue": { "active": false, "position": 3, "turn_ends_at": null, "budget": 50, "used": 0 } } }
```

```json
{ "v": 1, "seq": 4, "ts": 1738065601000, "type": "estop" }
{ "v": 1, "seq": 4, "ts": 1738065601001, "type": "error", "code": "bot.forbidden", "detail": "only the owner clears the e-stop" }
```

Refusal codes (the gate, in order): `bot.robot_not_found`, `bot.unknown_command`, `bot.command_not_allowed`
(the profile takes no such kind), `bot.estop_latched`, `bot.not_an_operator`, `bot.sign_in`,
`bot.read_only`, `bot.command_not_allowed` (the role's allowlist), `bot.device_offline`, `bot.cooldown`,
`bot.not_your_turn`, `bot.turn_budget`, `bot.unknown_actuator`, `bot.invalid_input`, `bot.text_too_long`.
`halt` is never refused for the e-stop, the allowlist, a cooldown or the turn budget; it still needs a
role that may drive (a queue robot's turn holder, not someone waiting) and an online device.

### 2.1 `/watch` and the embeddable panel (plan T15 R9)

`GET /panel/:id/embed` is the panel for a frame on another site. It never redirects to sign in and sets no
cookie. A signed-in visitor (the `ov_token` cookie) who is a member gets their role exactly as `/panel/:id`
decides (a stranger on a `queue` robot: `queue`) and drives over `/control`; anyone else gets the role
`watcher` when the owner turned on `embed_public` (`POST /robots/:id/embed`), with every control disabled
and a "Sign in to control" link that opens `/panel/:id` in a new tab; otherwise `403` with only a link out.
An unknown robot is `404`. The e-stop state is always shown; the E-stop button only to an owner or operator.
Its response carries `Content-Security-Policy: default-src 'self'; frame-ancestors 'self' <BOT_EMBED_ORIGINS>;
object-src 'none'; base-uri 'self'` and `Cache-Control: no-store`; every other page keeps
`frame-ancestors 'self'`. Framing takes both sides and the two lists are independent: `BOT_EMBED_ORIGINS` lets
a page frame Bot, while that page must list Bot's origin — its own `BASE_URL`, `https://openvibe.bot` in
production — in its own CSP `frame-src` (OpenVibe.Live computes it from `LIVE_BOT_URL`, default
`https://openvibe.bot`). Allow the framer here but not Bot there and the browser refuses the frame.

The watcher's panel joins on `wss://openvibe.bot/watch`: no credential, never a cookie or token.

| client → server | fields | answer |
|---|---|---|
| `join` | `robot_id` | `joined { role: "watcher", profile, allowed_commands: [], state }` for an `embed_public` robot; otherwise (or an unknown robot) `error` `bot.not_an_operator` |
| `leave` | — | unsubscribe |
| anything else (`command`, `estop`, `estop_clear`, …) | — | `error` `bot.read_only`; never reaches a device or the audit |

A joined watcher then gets `robot_state { state }` on every change, as a `/control` subscriber does, but always
the **public state**: `{ robot_id, online, estop{latched}, latency_ms, battery, telemetry }`, where
`telemetry` is `null` or `{ sensors: { … } }` holding only the keys the profile's `telemetry` widgets read
(`sensor.ultrasonic` → `ultrasonic`). Never the queue, a subject, who latched the e-stop, the device's ids,
its `status` or the rest of its telemetry.

Frames over 4 KiB close the socket (1009). Over `BOT_WATCH_MAX_PER_IP` open sockets from one client address
(default 20) or `BOT_WATCH_MAX_PER_ROBOT` watchers on one robot (default 500) the socket closes **4003**; the
owner turning `embed_public` off closes the robot's watchers with 4003 too.

```json
{ "v": 1, "seq": 1, "ts": 1738065600001, "type": "joined", "role": "watcher", "profile": { "id": "adeept.adr036" },
  "allowed_commands": [],
  "state": { "robot_id": "rob_01J8Z4M2Q0R7T9YV3K6N8P1W2X", "online": true, "estop": { "latched": false },
             "latency_ms": 63, "battery": 0.72, "telemetry": { "sensors": { "ultrasonic": 41.5 } } } }
```

---

## 3. REST (the same gate, HTTP)

Every error is RFC 9457 `application/problem+json`. Authenticate with a Network **user token**
(`Authorization: Bearer`, people act on their own things) or a **service token** with the capability
shown; a service acts for `X-OV-Subject` / the body's `owner`. A person acts only as themself: naming
anyone else (`?owner=`, the body's `owner`, `X-OV-Subject`) is `403 bot.forbidden`; `?owner=` is refused,
never ignored, on both `GET /robots` and `POST /robots` (a service's `?owner=` on `POST /robots` must name
the subject it acts for). Without a token, every route but `GET /profiles`, `GET /profiles/:id`, `POST /pair`
and `POST /devices/bind` answers `401 bot.sign_in`: `GET|POST /robots`, `GET|PATCH|DELETE /robots/:id`,
`POST /robots/:id/pairing-code`, `GET|POST /robots/:id/operators`, `DELETE /robots/:id/operators/:subject`,
`GET /robots/:id/devices`, `POST /devices/:id/rotate|revoke`, `POST /robots/:id/estop`,
`POST /robots/:id/estop/clear`, `POST /robots/:id/commands` and `GET /robots/:id/audit`. A node token gets `403 bot.forbidden` on the same
routes. Both come before any lookup, so a real robot or device id answers exactly as a made-up one. The three
jobs routes are service-only: the same `401 bot.sign_in` without a token, `403 bot.forbidden` for a person or a
node token, and a service token is judged on `bot.job.dispatch` alone.

| Method & path | Auth (capability) | Answer |
|---|---|---|
| `GET /profiles`, `GET /profiles/:id` | public | `{ profiles[] }` / `{ profile }` |
| `GET /robots` | user (own robots), or `bot.robot.read` + `?owner=` | `{ robots[] }` |
| `POST /robots` | the owner, or `bot.robot.manage` | `201 { robot, pairing{code,expires_at,installer} }`; with `BOT_PAIRING_AUTHORITY=network` the pairing is Network's and also carries `pairing_id`, and `503 bot.network_unavailable` if Network did not answer (no robot is created) |
| `GET /robots/:id` | a member, or `bot.robot.read` | `{ robot, role }` |
| `PATCH /robots/:id` | owner, or `bot.robot.manage` | `{ robot }`; new `limits` (including `allow`) re-send `config` to the connected device |
| `DELETE /robots/:id` | owner, or `bot.robot.manage` | `204` |
| `POST /robots/:id/pairing-code` | owner, or `bot.robot.manage` | `201 { code, expires_at, installer }`; with `BOT_PAIRING_AUTHORITY=network` `201 { code, expires_at, pairing_id, installer }` minted by Network for the robot's owner, or `503 bot.network_unavailable` |
| `GET /robots/:id/operators` | member, or `bot.robot.read` | `{ operators[] }` |
| `POST /robots/:id/operators` | owner, or `bot.robot.manage` | `201 { operators[] }` |
| `DELETE /robots/:id/operators/:subject` | owner, or `bot.robot.manage` | `{ operators[] }` |
| `GET /robots/:id/devices` | member, or `bot.robot.read` | `{ devices[] }` (no hashes, `online`) |
| `POST /devices/:id/rotate` | the robot's owner, `bot.device.connect` | `{ device, credential, publish_key, whip_url }` (once; `video: "not_configured"` instead of the key without OpenRe); for a Network-paired machine `{ device, sent }` — the machine is sent `rotate`, no credential is answered |
| `POST /devices/:id/revoke` | the robot's owner, `bot.device.connect` | `{ device }`; the socket closes at once. A Network-paired machine's principal is revoked on Network too (`503 bot.network_unavailable` if Network did not answer: revoked here, retry) and never binds again. The OpenRe key the device holds is revoked and its live session ended (`502`/`503 bot.openre_*` if OpenRe did not: revoked here, retry) |
| `POST /devices/bind` | a Network node token (audience `openvibe.bot`), no body | `201 { device_id, publish_key, whip_url, robot_id, profile }` — `POST /pair`'s answer without `credential`; again → the same device and a new publish key (the old one stops working); without OpenRe `video: "not_configured"` instead of the key. Refused: `401 bot.node_token_required`, `403 bot.node_not_bound` |
| `POST /robots/:id/estop` | owner/operator, `bot.robot.control` | `{ robot }` |
| `POST /robots/:id/estop/clear` | **owner only**, `bot.robot.control` | `{ robot }` |
| `POST /robots/:id/commands` | owner/operator, `bot.robot.control` | `{ robot_id, id, result, code?, reason?, latency_ms?, cached? }` — one command through the same gate, audit and per-subject `id` idempotency key as `/control` (a bound channel's chat forwards here instead of a hardware socket). `result` is `ack`, `nack` or `expired` (a repeated `id` answers `cached: true`); a gate refusal is its code as an RFC 9457 problem: `403 bot.not_an_operator` / `bot.read_only` / `bot.not_your_turn`, `404 bot.robot_not_found`, `409 bot.device_offline` / `bot.estop_latched`, `422` the command-shape codes, `429 bot.cooldown` / `bot.turn_budget` |
| `GET /robots/:id/audit?limit=&before=` | owner, or `bot.robot.read` | `{ audit[], next_before }` (newest first) |
| `POST /jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id` | **a service only**, with `bot.job.dispatch` (Run → Bot; a person or a node token is `403 bot.forbidden`) | `201 { job, sent }` / `{ job, sent }` / `{ job, stdout }`; `422 bot.invalid_input` without `project_id`, `409 bot.class_unadvertised` when the device does not advertise the job's class, `404 bot.job_not_found` |
| `POST /pair` | the one-time code is the credential | `201 { device_id, credential, publish_key, whip_url, robot_id, profile }`; with `BOT_PAIRING_AUTHORITY=network` always `410 bot.pairing_moved` (the `detail` names the Network URL) |

Not in `/api/v1`: `GET /api/health`, `GET /api/ready`, `GET /metrics`, `GET /release.json`, the
`/auth/*` SSO routes, `GET /` (a one-line text health placeholder), `GET /install` (a 302 to the installer),
and the signed-in pages `GET|POST /robots`, `GET /pair/:id`, `GET /panel/:id` and `GET /panel/panel.{js,css}`
(`server/web/routes.js`; adding a robot and minting a code count against the `bot.robot.manage` per-person limit,
30 a minute and 300 an hour, as on `/api/v1`; past it `429 rate_limited`).

---

## 4. Audit and events

Every command — allowed or refused — is written to `command_audit` (robot, device, the operator
principal and its kind, role, kind, the clamped value summary, result `ack|nack|refused|expired`,
reason, latency, time), kept 30 days. The outbox publishes `bot.robot.online`, `bot.robot.offline`,
`bot.estop.set`, `bot.estop.cleared` and `bot.command.refused` — small payloads of ids, kinds and
results, never a credential, a pairing code, a publish key or a WHIP URL.
