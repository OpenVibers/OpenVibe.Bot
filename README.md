# OpenVibe.Bot

The open control panel for robots (openvibe.bot). Design: OpenVibe.Contracts docs/adr/ADR-043-bot-devices-and-control.md; plan track T15.

## Purpose

OpenVibe.Bot pairs a robot's machines, keeps their state and gates every operator command. A device opens one outbound WebSocket to `/device`; a person drives it from `/control` or the REST API, through the same gate — roles, per-robot limits, cooldowns and the turn budget — over a panel built from the robot's profile rather than per-robot code.

## Owns

- Robots, their profiles and each robot's limits, `allow` lists, roles and operators.
- The curated kit catalogue (`server/kits/*.json`, `GET /api/v1/kits`, `/kits/:id`): each kit's parts list and build guide, bound to a shipped profile (the Adeept ADR036 first). Metadata only — pricing, shipping and returns are the owner's (O29).
- Devices (the machines that serve a robot) and the credentials that identify them: hashed at rest, rotated and revoked, never readable back.
- Pairing: one-time codes with a short expiry, minted by Bot or, with `BOT_PAIRING_AUTHORITY=network`, by OpenVibe.Network.
- The `/device` and `/control` WebSockets, the command gate and the latched e-stop.
- The front page, `GET /` (`server/web/home.js`): the OpenVibe Frame (`openvibe-shared/shell`) around `openvibe-shared/showcase` sections that say only what works today (pairing, the panel's controls, the gate and the e-stop, people and the queue, the read-only embed, the simulator and the kits with drivers), with its own CSP for the Frame's calls to the Network; the rest of the site keeps `default-src 'self'`. `/shared/` is openvibe-shared's serve handler.
- The signed-in pages (`server/web/routes.js`): `/robots` to list and add robots, `/pair/:id` for a pairing code and the installer command, and `/panel/:id`, the panel rendered from the profile. A `sim.rover` robot is driven by an in-process simulator (`server/sim`), so the panel works before any hardware exists. It gets no jobs, and it is not counted as a device or reported online in the outbox. The panel (`public/panel.js`, no build step) drives with a touch joystick, the keyboard or a gamepad, shows a latency meter and one camera tile per camera the profile lists; a tile plays the robot's OpenRe WebRTC session when one is live (the mediasoup-client viewer flow OpenVibe.Live runs, against the session's playback descriptor), and stays the placeholder when there is none.
- Server-side ONVIF cameras (`camera.onvif`, `mapping.driver: onvif`): an in-process connector beside the simulator (`server/onvif`) attaches a camera configured with `BOT_ONVIF_CAMERAS`, writes a real `kind: server` device row, translates a `ptz` command into ONVIF `ContinuousMove`/`Stop` (with the profile's deadline as a deadman) and carries the camera's `GetStatus` readout in telemetry. Its credentials are secret references only (`username_ref`/`password_ref`).
- The command audit (`command_audit`, kept 30 days) and the `bot.*` outbox events.
- Operators and viewers from the panel: the owner adds a person to a robot by `@username` (OpenVibe.Network resolves the name to a subject) and removes them again, each listed on the panel's People card. On an open-queue robot a signed-in visitor sees their turn — or their place in line — and can leave the queue, which promotes the next person at once (`POST /robots/:id/operators`, `POST /robots/:id/operators/:subject/remove`, `POST /robots/:id/queue/leave`, all plain forms that work without JavaScript).
- The robot's streaming and recording toggles, off by default: `media` records live sessions to OpenVibe.Media and `live` shows them on the owner's OpenVibe.Live channel. They live only on the robot's OpenRe stream (`recording_mode`, `mirror_to_live`); Bot stores no copy and the owner, not an operator, flips them (`GET`/`POST /api/v1/robots/:id/streaming`).
- Dispatching `platform.job@1` jobs to a paired Node over `/device` (`server/jobs/index.js` over `server/jobs/dispatch.js`; the internal `bot.job.dispatch` API is `POST /api/v1/jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id`) and metering them per wall-clock second (`run_jobs`, `run_usage_outbox`; docs/protocol.md §1.2).

## Does not own

- Identity, subjects and tokens (OpenVibe.Network) and the robot's record on Network.
- Video: a device publishes over WHIP to OpenRe.Stream; Bot only hands out the URL at pairing.
- The agent that runs on the robot; it ships with the T15 device-agent job.
- The legal pages (`/terms`, `/privacy`, `/dmca`) and `sitemap.xml`: the frozen OpenVibe.Sites files.

## Devices

- A device (the machine that serves a robot) pairs with one pasted command, shown on the robot's pairing page: `curl -fsSL <BOT_INSTALLER_URL> | sh -s -- --robot rob_… --code XXXX-XXXX [--driver …]` (the Network form in `docs/protocol.md` §1). The `--driver` follows the robot's profile: `adeept` for `adeept.adr036`, `adeept-mecanum` for `adeept.adr036.mecanum`, `cozmo` for `cozmo`; any other profile gets none (`server/domain/index.js` `driverForProfile`), the installer's dry-run `none`.
- A server-side ONVIF camera (`camera.onvif`) is not installed on a machine: it gets no `--driver` and Bot attaches it itself from `BOT_ONVIF_CAMERAS` (see Deploy), so its panel works as soon as the camera answers.
- The robot's panel is `openvibe.bot/panel/<rob_…>` (`GET /panel/:id`, rendered from the profile; `docs/protocol.md` §3). The device-side bring-up steps for the Adeept ADR036 kit live with the driver, in OpenVibe.Node's `docs/hardware-adeept.md` (T15 step 1).
- A robot can use its own `local.rob_…` profile, stored with that robot and validated against `bot.robot-profile@1` and Bot's capability, driver and widget registries. On the owner's robot page, the Buttons form adds or removes rows and saves each button's name, label, optional keyboard key, cooldown in milliseconds and hold setting. The Video click checkbox enables a separate point cooldown. Only the owner can save or return to the robot's catalogue profile; each change is audited.
- Profiles declare `button` commands by name and `point` commands for normalised video coordinates in `[0, 1]`. A hold button sends `down` while pressed and `up` on release; each `down` has the device deadline used for held controls. The command gate checks declarations, roles, robot limits and control specific cooldowns. The panel and read-only embed render the profile's labels, with buttons disabled for anyone who cannot drive.

## Depends on

- PostgreSQL 18: robots, devices, profile rows, pairing codes, the command audit and the event outbox; `migrations/` applies on boot.
- Valkey (`VALKEY_URL`, optional): the shared per-actor limit counters; unset, limits are counted per process.
- OpenVibe.Network: user and service tokens, node tokens, pairing when the authority is `network`, and identity resolution (a `@username` to a subject, and subjects to names, for the panel's People card).
- OpenRe.Stream: the WHIP ingest base (`BOT_WHIP_BASE`) devices publish to.
- OpenVibe.Billing: job usage readings go to `billing.usage.record` (`BOT_BILLING_URL`; Bot mints its own Network service token for audience `openvibe.billing` with `billing.usage.record`, and `BOT_BILLING_TOKEN` overrides it); unset, they wait in `run_usage_outbox`.
- `openvibe-contracts` v0.112.0, `openvibe-sdk` v0.37.0 and `openvibe-shared` v2.17.0 (package.json).
- Account export and deletion (ADR-033): Network grants `events.subscription.manage` (openvibe.events) for the two
  subscriptions created at boot, then, last and once the release is live, `network.account.export.contribute` and
  `network.account.deletion.confirm` (openvibe.network).

## Account export and deletion (ADR-033)

`network.account.export_requested` and `network.account.deleted` arrive at `POST /internal/events`. The route is
loopback-only (nginx answers 404 for `/internal/`, and the handler refuses a forwarded request) and signed with
`BOT_EVENTS_SECRET`. They are answered by `server/account-data.js` over `openvibe-sdk/account-data`, with one receipt
per export and deletion in `account_data_events` (migration 0008).

- **Export:** the person's robots, the roles they hold on other robots, their commands and their run jobs. Device
  credentials and publish keys are hashes and never exported.
- **Their robots:** each is removed the way its owner would remove it (`robots.remove`: the OpenRe stream key is
  revoked and the stream archived first). Its pairing codes, operators, queue, local profile and Live conversion go
  with it, and so does its command history. A device that served only their robots is revoked and loses its name;
  the row stays because run jobs reference it.
- **Elsewhere:** their operator role and queue place on other robots go, and their id leaves other robots' command
  history, e-stop marks, pairing codes and invitations.
- **Kept:** run jobs they started, whose usage seconds were reported to Billing.

## Capabilities

| capability | guards |
|---|---|
| `bot.robot.read` | `GET /robots`, `GET /robots/:id`, operators, devices, the audit and the streaming toggles, for a service acting for an owner |
| `bot.robot.manage` | create, patch and delete a robot, pairing codes, operators, and the streaming toggles (`POST /robots/:id/streaming`) |
| `bot.robot.control` | the e-stop set and clear (clear is owner-only), the control gate and `POST /robots/:id/commands` (so a bound channel's chat can forward a command over HTTP instead of a hardware socket) |
| `bot.device.connect` | rotate and revoke a device credential |
| `bot.job.dispatch` | the internal Run → Bot jobs API (`POST /jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id`); services only |

A person acts on their own robots with a Network user token; a service acts with a service token plus the capability, for the subject it names. The REST routes are in `docs/protocol.md` §3 and the two WebSockets in §§1–2.

## Tests

`npm test` runs `test/run.js`, the whole suite. `npm run test:pg` (`BOT_TEST_STORE=pg`) runs the same suite against PostgreSQL; the default store is in-process PGlite. The tests cover the device and operator WebSocket gates, the REST routes, the pairing paths, the profiles and the kit catalogue, the owner fence, the e-stop, the outbox and the server-side ONVIF camera (against a stub endpoint: `ptz` → `ContinuousMove`, telemetry → the `GetStatus` readout).

## Security

- A device credential is a secret: sent only in the `Authorization` header (never a query string), stored hashed, returned once by `pair` or a rotation, and revoking it closes the socket at once.
- A person acts only as themself; naming anyone else is refused, never ignored, and a node token is refused on the person and service routes.
- Pairing codes are one-time and short-lived; the e-stop is latched and only the owner clears it, while `halt` always passes the gate.
- Every command, allowed or refused, is audited; the outbox carries ids, kinds and results — never a credential, a pairing code, a publish key or a WHIP URL.
- A server-side ONVIF camera is reached only at the one URL configured in `BOT_ONVIF_CAMERAS` (http(s), one host, no embedded credentials), with a timeout and no redirects, so a camera cannot steer Bot elsewhere. Its ONVIF user and password are named by secret reference (`username_ref`/`password_ref`), read only when a request is built, sent as a WS-Security digest and never stored, answered or logged.
- `/api/health` and `/api/ready` are loopback-only; nginx terminates TLS and upgrades `/device` and `/control`.

## Deploy

Production runs the Node process under systemd as `openvibe-bot.service` (unit reference: `deploy/systemd/openvibe-bot.service`), with `WorkingDirectory=/opt/openvibe.bot`, `ExecStart` running `server/index.js`, and secrets/config read from the environment file `/etc/openvibe/bot.env`. The app listens on port **4630** behind nginx (`deploy/nginx/openvibe.bot.conf`), which terminates TLS and upgrades the `/device`, `/control` and `/watch` WebSockets to `127.0.0.1:4630`. Readiness is `http://127.0.0.1:4630/api/ready` (liveness: `/api/health`); both are loopback-only.

To run the schema migrations before the service serves, start it once with the direct owner connection in `/etc/openvibe/bot.env` (`DATABASE_DIRECT_URL`); the boot applies `migrations/` and then serves on the pooled `DATABASE_URL`.

Set `BOT_PAIRING_AUTHORITY` to `bot` (the default) or `network`; any other value refuses to boot.

Set `BOT_EMBED_ORIGINS` (comma or space separated; default `https://openvibe.live,https://www.openvibe.live`) to the pages that may frame a robot's read-only panel (the CSP `frame-ancestors` list). Each entry is a bare https origin, with no path, query or wildcard (`http://localhost:<port>` only outside production); an invalid entry refuses to boot. A robot is embeddable only after its owner turns on `embed_public` with the form on its panel (`POST /robots/:id/embed`); the flag is web-only and never appears in `/api/v1`. Migration `0005_embed_public.sql` adds the column, off for every robot.

The embeddable panel is `GET /panel/:id/embed` (framed only by `BOT_EMBED_ORIGINS`; no cookie needed to watch) and its read-only socket is `wss://openvibe.bot/watch` (docs/protocol.md §2.1); nginx must upgrade `/watch` like `/control`. Framing takes both sides: the embedding page must also list Bot's origin — its `BASE_URL`, `https://openvibe.bot` in production — in its own CSP `frame-src`, computed from that page's own configuration (OpenVibe.Live's `LIVE_BOT_URL`, default `https://openvibe.bot`), or the browser refuses the frame even though `BOT_EMBED_ORIGINS` allows the framer. Set `BOT_WATCH_MAX_PER_IP` (default 20) and `BOT_WATCH_MAX_PER_ROBOT` (default 500) to cap open `/watch` sockets per client address and watchers per robot; over a cap the socket closes 4003.

Set `BOT_WHIP_BASE` in `/etc/openvibe/bot.env` to the WHIP ingest base each device publishes to (`whip_url = <base>/<publish key>`, sent once with the pairing; OpenRe's is `https://ingest.openre.stream/whip`); leave it unset to pair devices without video.

The publish key is always an ingest key OpenRe.Stream issued for the robot's stream (OpenRe's WHIP ingest admits no other): set `BOT_OPENRE_URL` and Bot mints its own Network service token for audience `openvibe.openre` from its OAuth client (`OV_OAUTH_CLIENT_ID`/`OV_OAUTH_CLIENT_SECRET` against `OV_NETWORK_INTERNAL_URL`), holding `openre.stream.read`, `openre.stream.write`, `openre.key.rotate` and `openre.session.read`/`openre.output.read`/`openre.output.write` — Network's grant to the `bot` client; `openre.session.read` is the panel's live video (the open session and its playback descriptor) and the output capabilities are for restreaming later. `BOT_OPENRE_TOKEN` (a Network service token with the same grant, or `openre.stream.*` with `openre.key.rotate`) is an optional operator override; `BOT_OPENRE_TIMEOUT_MS`, default 8000, bounds each call. The same token covers the streaming toggles: `GET /api/v1/robots/:id/streaming` reads the stream with `openre.stream.read`, `POST` PATCHes `recording_mode`/`mirror_to_live` with `openre.stream.write`. Pairing creates the robot's OpenRe stream (or rotates the one it has), a credential rotation rotates its key, revoking a device or removing a robot revokes the key and ends the live session. Bot stores the stream id and the key's hint, never the key. With `BOT_OPENRE_URL` unset, or neither `BOT_OPENRE_TOKEN` nor the Network client credentials available, devices still pair but get no publish key and the answer says `"video": "not_configured"`; Bot mints no key of its own.

Set `BOT_BILLING_URL` in `/etc/openvibe/bot.env` to OpenVibe.Billing's base URL and Bot mints its own Network service token for audience `openvibe.billing` (`billing.usage.record`, Network's grant to the `bot` client) from the same OAuth client credentials, posting each job usage reading to `<BOT_BILLING_URL>/api/v1/usage`; `BOT_BILLING_TOKEN` is an optional operator-minted override, and `BOT_BILLING_TIMEOUT_MS`, default 5000, bounds each post. With `BOT_BILLING_URL` unset the relay stays off and the readings wait in `run_usage_outbox`, retried across restarts and never dropped.

Set `BOT_ONVIF_CAMERAS` (JSON, unset by default) to the server-side cameras Bot may connect to: a map from a robot id (each key names exactly one robot; there is no wildcard) to `{ "url": "http://<host>/onvif/ptz_service", "username_ref": "CAM_USER", "password_ref": "CAM_PASSWORD" }`. The refs are the *names* of the secrets (env vars, or keys a deployment resolves through a secret store), read per request; the URL must be http(s), on one host and carry no credentials, and `BOT_ONVIF_TIMEOUT_MS` (default 5000) bounds each request. Anything else — including a key that is not a robot id — refuses to boot. A robot whose profile is `camera.onvif` and that has a configured camera attaches server-side at boot and when its panel is opened.

`/install` is proxied to the app, which answers a 302 to OpenVibe.Node's installer script (`BOT_INSTALLER_SOURCE_URL`, by default the `install.sh` asset on OpenVibe.Node's [latest release](https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/) — a released, checksummed installer that never drifts with Node's `main`, whose CI keeps `dist/install.sh` byte-identical to `install/install.sh`; https on an allow-listed GitHub or openvibe.bot host, checked at boot, and no query parameter changes the target). The pairing's installer command adds `--driver adeept|adeept-mecanum|cozmo` for those profiles and nothing for the others (the dry-run `none`).

## Deploy files

- `deploy/systemd/openvibe-bot.service` — systemd unit (`EnvironmentFile=/etc/openvibe/bot.env`, `PORT=4630`, hardening and `Restart=always`).
- `deploy/nginx/openvibe.bot.conf` — nginx reference site for openvibe.bot: TLS, www→apex, rate limits, and WebSocket upgrade headers for the device (`/device`) and operator (`/control`) sockets, passing the `Authorization` header through. It proxies the front page (`location = /`) and `/shared/` to the app, and serves the frozen OpenVibe.Sites legal pages, `robots.txt`, `sitemap.xml` and 404 page from `/opt/openvibe.sites/dist/openvibe.bot`.

OpenVibe.Sites keeps the frozen legal pages, `robots.txt` and `sitemap.xml` under `/opt/openvibe.sites/dist/openvibe.bot` (its front page there is no longer served), but no longer generates `deploy/nginx/openvibe.bot.conf` (sites.json marks the vhost as owned by OpenVibe.Bot). A Sites deploy leaves an installed vhost it no longer generates in place, so the current Sites vhost keeps serving openvibe.bot until Bot's first deploy installs this file over it; nothing has to be removed by hand, and later Sites deploys never overwrite Bot's `/device` and `/control` routes.

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.37.0
- openvibe-shared: v2.17.0
<!-- versions:end -->
