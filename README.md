# OpenVibe.Bot

The open control panel for robots (openvibe.bot). Design: OpenVibe.Contracts docs/adr/ADR-043-bot-devices-and-control.md; plan track T15.

## Deploy

Production runs the Node process under systemd as `openvibe-bot.service` (unit reference: `deploy/systemd/openvibe-bot.service`), with `WorkingDirectory=/opt/openvibe.bot`, `ExecStart` running `server/index.js`, and secrets/config read from the environment file `/etc/openvibe/bot.env`. The app listens on port **4630** behind nginx (`deploy/nginx/openvibe.bot.conf`), which terminates TLS and upgrades the `/device` and `/control` WebSockets to `127.0.0.1:4630`. Readiness is `http://127.0.0.1:4630/api/ready` (liveness: `/api/health`); both are loopback-only.

To run the schema migrations before the service serves, start it once with the direct owner connection in `/etc/openvibe/bot.env` (`DATABASE_DIRECT_URL`); the boot applies `migrations/` and then serves on the pooled `DATABASE_URL`.

Set `BOT_PAIRING_AUTHORITY` to `bot` (the default) or `network`; any other value refuses to boot.

Set `BOT_WHIP_BASE` in `/etc/openvibe/bot.env` to the WHIP ingest base each device publishes to (`whip_url = <base>/<publish key>`, sent once with the pairing); leave it unset to pair devices without video.

`/install` is proxied to the app, which serves/redirects the installer; the script itself ships in OpenVibe.Node's release assets (`install.sh` in each OpenVibe.Node release), so `/install` needs a published OpenVibe.Node release tag.

## Deploy files

- `deploy/systemd/openvibe-bot.service` — systemd unit (`EnvironmentFile=/etc/openvibe/bot.env`, `PORT=4630`, hardening and `Restart=always`).
- `deploy/nginx/openvibe.bot.conf` — nginx reference site for openvibe.bot: TLS, www→apex, rate limits, and WebSocket upgrade headers for the device (`/device`) and operator (`/control`) sockets, passing the `Authorization` header through. It serves the existing Sites page from `/opt/openvibe.sites/dist/openvibe.bot` and shared assets from `/opt/openvibe.sites/dist/_shared`.

OpenVibe.Sites keeps building the front page, legal pages and `/shared/` assets under `/opt/openvibe.sites/dist/`, but no longer generates `deploy/nginx/openvibe.bot.conf` (sites.json marks the vhost as owned by OpenVibe.Bot). A Sites deploy leaves an installed vhost it no longer generates in place, so the current Sites vhost keeps serving openvibe.bot until Bot's first deploy installs this file over it; nothing has to be removed by hand, and later Sites deploys never overwrite Bot's `/device` and `/control` routes.
