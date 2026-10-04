# OpenVibe.Bot

The open control panel for robots (openvibe.bot). Design: OpenVibe.Contracts docs/adr/ADR-043-bot-devices-and-control.md; plan track T15.

## Deploy

Production runs the Node process under systemd as `openvibe-bot.service` (unit reference: `deploy/systemd/openvibe-bot.service`), with `WorkingDirectory=/opt/openvibe.bot`, `ExecStart` running `server/index.js`, and secrets/config read from the environment file `/etc/openvibe/bot.env`. The app listens on port **4630** behind nginx (`deploy/nginx/openvibe.bot.conf`), which terminates TLS and upgrades the `/device` and `/control` WebSockets to `127.0.0.1:4630`. Readiness is `http://127.0.0.1:4630/api/ready` (liveness: `/api/health`); both are loopback-only.

To run the schema migrations before the service serves, start it once with the direct owner connection in `/etc/openvibe/bot.env` (`DATABASE_DIRECT_URL`); the boot applies `migrations/` and then serves on the pooled `DATABASE_URL`.

Set `BOT_PAIRING_AUTHORITY` to `bot` (the default) or `network`; any other value refuses to boot.

Set `BOT_WHIP_BASE` in `/etc/openvibe/bot.env` to the WHIP ingest base each device publishes to (`whip_url = <base>/<publish key>`, sent once with the pairing; OpenRe's is `https://ingest.openre.stream/whip`); leave it unset to pair devices without video.

The publish key is always an ingest key OpenRe.Stream issued for the robot's stream (OpenRe's WHIP ingest admits no other): set `BOT_OPENRE_URL` and `BOT_OPENRE_TOKEN` (a Network service token holding `openre.stream.read`, `openre.stream.write` and `openre.key.rotate`, or `openre.stream.*` with `openre.key.rotate`; `BOT_OPENRE_TIMEOUT_MS`, default 8000, bounds each call). Pairing creates the robot's OpenRe stream (or rotates the one it has), a credential rotation rotates its key, revoking a device or removing a robot revokes the key and ends the live session. Bot stores the stream id and the key's hint, never the key. With either variable unset, devices still pair but get no publish key and the answer says `"video": "not_configured"`; Bot mints no key of its own.

`/install` is proxied to the app, which answers a 302 to OpenVibe.Node's installer script (`BOT_INSTALLER_SOURCE_URL`, by default `install/install.sh` on OpenVibe.Node's `main`; https on an allow-listed GitHub or openvibe.bot host, checked at boot, and no query parameter changes the target). The pairing's installer command adds `--driver adeept|adeept-mecanum|cozmo` for those profiles and nothing for the others (the dry-run `none`).

## Deploy files

- `deploy/systemd/openvibe-bot.service` — systemd unit (`EnvironmentFile=/etc/openvibe/bot.env`, `PORT=4630`, hardening and `Restart=always`).
- `deploy/nginx/openvibe.bot.conf` — nginx reference site for openvibe.bot: TLS, www→apex, rate limits, and WebSocket upgrade headers for the device (`/device`) and operator (`/control`) sockets, passing the `Authorization` header through. It serves the existing Sites page from `/opt/openvibe.sites/dist/openvibe.bot` and shared assets from `/opt/openvibe.sites/dist/_shared`.

OpenVibe.Sites keeps building the front page, legal pages and `/shared/` assets under `/opt/openvibe.sites/dist/`, but no longer generates `deploy/nginx/openvibe.bot.conf` (sites.json marks the vhost as owned by OpenVibe.Bot). A Sites deploy leaves an installed vhost it no longer generates in place, so the current Sites vhost keeps serving openvibe.bot until Bot's first deploy installs this file over it; nothing has to be removed by hand, and later Sites deploys never overwrite Bot's `/device` and `/control` routes.
