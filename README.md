# OpenVibe.Bot

The open control panel for robots (openvibe.bot). Design: OpenVibe.Contracts docs/adr/ADR-043-bot-devices-and-control.md; plan track T15.

## Purpose

OpenVibe.Bot pairs a robot's machines, keeps their state and gates every operator command. A device opens one outbound WebSocket to `/device`; a person drives it from `/control` or the REST API, through the same gate — roles, per-robot limits, cooldowns and the turn budget — over a panel built from the robot's profile rather than per-robot code.

## Owns

- Robots, their profiles and each robot's limits, `allow` lists, roles and operators.
- Devices (the machines that serve a robot) and the credentials that identify them: hashed at rest, rotated and revoked, never readable back.
- Pairing: one-time codes with a short expiry, minted by Bot or, with `BOT_PAIRING_AUTHORITY=network`, by OpenVibe.Network.
- The `/device` and `/control` WebSockets, the command gate and the latched e-stop.
- The command audit (`command_audit`, kept 30 days) and the `bot.*` outbox events.

## Does not own

- Identity, subjects and tokens (OpenVibe.Network) and the robot's record on Network.
- Video: a device publishes over WHIP to OpenRe.Stream; Bot only hands out the URL at pairing.
- The agent that runs on the robot; it ships with the T15 device-agent job.
- The public openvibe.bot front page and legal pages, built by OpenVibe.Sites.

## Depends on

- PostgreSQL 18: robots, devices, profile rows, pairing codes, the command audit and the event outbox; `migrations/` applies on boot.
- Valkey (`VALKEY_URL`, optional): the shared per-actor limit counters; unset, limits are counted per process.
- OpenVibe.Network: user and service tokens, node tokens, and pairing when the authority is `network`.
- OpenRe.Stream: the WHIP ingest base (`BOT_WHIP_BASE`) devices publish to.
- `openvibe-contracts` v0.85.0, `openvibe-sdk` v0.26.0 and `openvibe-shared` v2.5.0 (package.json).

## Capabilities

| capability | guards |
|---|---|
| `bot.robot.read` | `GET /robots`, `GET /robots/:id`, operators, devices and the audit, for a service acting for an owner |
| `bot.robot.manage` | create, patch and delete a robot, pairing codes, operators |
| `bot.robot.control` | the e-stop set and clear (clear is owner-only) and the control gate |
| `bot.device.connect` | rotate and revoke a device credential |

A person acts on their own robots with a Network user token; a service acts with a service token plus the capability, for the subject it names. The REST routes are in `docs/protocol.md` §3 and the two WebSockets in §§1–2.

## Tests

`npm test` runs `test/run.js`, the whole suite. `npm run test:pg` (`BOT_TEST_STORE=pg`) runs the same suite against PostgreSQL; the default store is in-process PGlite. The tests cover the device and operator WebSocket gates, the REST routes, the pairing paths, the owner fence, the e-stop and the outbox.

## Security

- A device credential is a secret: sent only in the `Authorization` header (never a query string), stored hashed, returned once by `pair` or a rotation, and revoking it closes the socket at once.
- A person acts only as themself; naming anyone else is refused, never ignored, and a node token is refused on the person and service routes.
- Pairing codes are one-time and short-lived; the e-stop is latched and only the owner clears it, while `halt` always passes the gate.
- Every command, allowed or refused, is audited; the outbox carries ids, kinds and results — never a credential, a pairing code, a publish key or a WHIP URL.
- `/api/health` and `/api/ready` are loopback-only; nginx terminates TLS and upgrades `/device` and `/control`.

## Deploy

Production runs the Node process under systemd as `openvibe-bot.service` (unit reference: `deploy/systemd/openvibe-bot.service`), with `WorkingDirectory=/opt/openvibe.bot`, `ExecStart` running `server/index.js`, and secrets/config read from the environment file `/etc/openvibe/bot.env`. The app listens on port **4630** behind nginx (`deploy/nginx/openvibe.bot.conf`), which terminates TLS and upgrades the `/device` and `/control` WebSockets to `127.0.0.1:4630`. Readiness is `http://127.0.0.1:4630/api/ready` (liveness: `/api/health`); both are loopback-only.

To run the schema migrations before the service serves, start it once with the direct owner connection in `/etc/openvibe/bot.env` (`DATABASE_DIRECT_URL`); the boot applies `migrations/` and then serves on the pooled `DATABASE_URL`.

Set `BOT_PAIRING_AUTHORITY` to `bot` (the default) or `network`; any other value refuses to boot.

Set `BOT_WHIP_BASE` in `/etc/openvibe/bot.env` to the WHIP ingest base each device publishes to (`whip_url = <base>/<publish key>`, sent once with the pairing); leave it unset to pair devices without video.

`/install` is proxied to the app, which answers a 302 to OpenVibe.Node's installer script (`BOT_INSTALLER_SOURCE_URL`, by default `install/install.sh` on OpenVibe.Node's `main`; https on an allow-listed GitHub or openvibe.bot host, checked at boot, and no query parameter changes the target). The pairing's installer command adds `--driver adeept|adeept-mecanum|cozmo` for those profiles and nothing for the others (the dry-run `none`).

## Deploy files

- `deploy/systemd/openvibe-bot.service` — systemd unit (`EnvironmentFile=/etc/openvibe/bot.env`, `PORT=4630`, hardening and `Restart=always`).
- `deploy/nginx/openvibe.bot.conf` — nginx reference site for openvibe.bot: TLS, www→apex, rate limits, and WebSocket upgrade headers for the device (`/device`) and operator (`/control`) sockets, passing the `Authorization` header through. It serves the existing Sites page from `/opt/openvibe.sites/dist/openvibe.bot` and shared assets from `/opt/openvibe.sites/dist/_shared`.

OpenVibe.Sites keeps building the front page, legal pages and `/shared/` assets under `/opt/openvibe.sites/dist/`, but no longer generates `deploy/nginx/openvibe.bot.conf` (sites.json marks the vhost as owned by OpenVibe.Bot). A Sites deploy leaves an installed vhost it no longer generates in place, so the current Sites vhost keeps serving openvibe.bot until Bot's first deploy installs this file over it; nothing has to be removed by hand, and later Sites deploys never overwrite Bot's `/device` and `/control` routes.
