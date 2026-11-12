# AGENTS.md — OpenVibe.Bot

## Project overview

The open control panel for robots: pairs a robot's machines, keeps their state and gates every
operator command. A device opens one outbound WebSocket to `/device`; a person drives it from
`/control` or the REST API through the same gate — roles, per-robot limits, cooldowns and the turn
budget — over a panel built from the robot's profile rather than per-robot code. Node.js/Express +
`ws`, PostgreSQL (`ov_bot`), CommonJS, **no build step**.

- Service id `bot`, port `4630`, origin `https://openvibe.bot`, unit `openvibe-bot.service`,
  release root `/opt/openvibe.bot`.
- Design: OpenVibe.Contracts `docs/adr/ADR-043-bot-devices-and-control.md`.
- Boot applies `migrations/` with the owner role (`DATABASE_DIRECT_URL`, one connection, advisory
  lock), seeds the shipped profiles, then serves on the pooled runtime role (`DATABASE_URL`) with
  Valkey for shared per-process state. Several processes may start together.

## What it owns

- Robots, profiles, per-robot limits, `allow` lists, roles and operators; the curated kit catalogue
  (`server/kits/*.json`, metadata only).
- Devices and their credentials (hashed at rest, rotated, revoked, never readable back) and pairing
  codes (one-time, short-lived; `BOT_PAIRING_AUTHORITY=network` lets Network mint them).
- The `/device`, `/control` and `/watch` WebSockets, the command gate, the operator queue and the
  **latched e-stop**.
- Routines (`server/routines.js`), owner webhooks (`server/webhooks.js`, signed, retried), community
  robot profiles (`server/submissions.js`), the phone-as-robot device, the in-process simulator, the
  server-side ONVIF camera connector, and the job dispatcher for paired Link machines
  (`server/jobs/`).
- The front page, `/robots`, `/models`, `/r/:id`, `/pair/:id`, `/panel/:id`, `/try`, `/docs`,
  `/robots/submit`, legal pages, sitemap/llms/manifest, and the read-only embeddable panel.
- The command audit (`command_audit`, 30 days) and the `bot.*` outbox events.

Not owned: the robot hardware or its driver (Link plugins / the device), video ingest (OpenRestream),
live streaming and VODs (Live/Media), identity, the money ledger, AI model execution.

## Who calls it, and whom it calls

- Callers: people in the browser; the OpenVibe.Actor agent (`svc:actor`, only for the robot's owner,
  `GET/POST /api/v1/robots/:id/steps`), Live (a channel bound to a robot embeds `/panel/:id/embed`),
  and services using a Network service token with `bot.*` capabilities.
- Depends on: Network (user/service/node tokens, pairing, identity resolution, account export/
  deletion events), OpenRestream (WHIP ingest and the robot's stream key; `openre.*` capabilities),
  Billing (`billing.usage.record` for job usage), Search (`search.document.write`, model documents),
  Live (the owner's channel for the on-stream switch), and `openvibe-contracts`/`openvibe-sdk`/
  `openvibe-shared` pins.
- A device credential is a secret: `Authorization` header only (the phone uses the subprotocol
  `ov.device.<credential>` because a browser cannot set the header), never a query string.

## Repository map

- **Entry:** [server/index.js](server/index.js) — config, owner-role migration, profile seed, app,
  Valkey, simulators, telemetry, jobs and subscriptions; graceful stop.
- **App:** [server/app.js](server/app.js) — CSP (a special `HOME_CSP` for the front page),
  `/api/v1`, `/auth`, `/shared`, `/device`, `/control`, `/watch` upgrades, pages, error handling.
- **Config:** [server/config.js](server/config.js); database [server/db.js](server/db.js).
- **Domain:** [server/domain/](server/domain/), [server/profiles/](server/profiles/),
  [server/sim/](server/sim/), [server/onvif/](server/onvif/), [server/kits/](server/kits/).
- **API:** [server/api/](server/api/) — `v1.js`, `auth.js`, `actor-limits.js`, `resource-control.js`,
  `desk-leases.js`, `resource-index.js`.
- **Realtime:** [server/realtime.js](server/realtime.js) — `/device`, `/control`, `/watch`, the gate.
- **Web:** [server/web/](server/web/) — `home.js`, `routes.js`, `directory.js`, `docs.js`,
  `layouts.js`, `session.js`, `qr.js`, `surface.js`.
- **Browser:** [public/panel.js](public/panel.js), `public/drive.js`, `public/phone-device.js`,
  `public/try-device.js`, `public/sim-world.js`, `public/sim-view.js`, `public/embed-frame.js`.
- **Jobs/metering:** [server/jobs/](server/jobs/), [server/events/outbox.js](server/events/outbox.js).
- **Deploy:** [deploy/systemd/openvibe-bot.service](deploy/systemd/openvibe-bot.service),
  [deploy/nginx/openvibe.bot.conf](deploy/nginx/openvibe.bot.conf).

## Commands

```bash
npm ci
cp .env.example .env
npm run dev                  # http://127.0.0.1:4630
npm test                     # test/run.js, PGlite, in-process Network/Events stubs
npm run test:pg              # same suite on PostgreSQL (BOT_TEST_STORE=pg)
npm test -- profiles pairing # filter by file name
ov test                      # the harness's sharded run of what the change reaches
node --check <file.js>
```

## Database and migrations

PostgreSQL database `ov_bot` (host data role, ADR-035); PGlite in development/tests. Boot applies
`migrations/NNNN_*.sql` through the **owner** connection and then serves through the pooled runtime
role; the run is serialised by an advisory lock, so parallel starts are safe. Never edit an applied
migration; add a new number. The command audit is pruned after 30 days; job usage waits in
`run_usage_outbox` when Billing is not configured and is never dropped.

## Auth and the command gate

- User tokens (SSO session / `ov_token` cookie) and service tokens are both accepted on `/api/v1`;
  a **node token is refused** on person and service routes. A person acts only as themself — naming
  anyone else is refused, never ignored.
- The **owner** can list a robot, add/remove operators, edit limits, clear the latched panel e-stop, set
  the agent switch and flip streaming toggles. An operator drives within limits and cooldowns. An
  open-queue robot gives a viewer a turn, and leaving promotes the next person at once.
- `svc:actor` may read/drive **only** the owner's robot and only with `robots.agent_control` on;
  otherwise `403 bot.agent_not_allowed`. Every step passes the same gate as the owner's own commands.
- A machine runs only its owner's jobs: the dispatcher compares the job requester with the machine
  owner and refuses anyone else with `bot.not_owner`, whatever the placer chose.
- Every command, allowed or refused, is audited. Pairing codes are one-time; `halt` always passes;
  the owner or a Mod clears the panel e-stop, while the tray's STOP latch and ARM stay local.

## Frontend loading model

Server-rendered pages and plain forms, enhanced by no-build scripts (`public/panel.js` drives with
touch/keyboard/gamepad). There is no SPA, bundler or transpiler. `openvibe-shared` supplies the
Frame, showcase, arrange surface and serve handler (`/shared/*` from the pinned node_modules). The
front page uses its own CSP (`HOME_CSP`) for the Frame's Network calls; every other page keeps
`default-src 'self'`. Embedding takes both sides: `BOT_EMBED_ORIGINS` (bare https origins, no paths/
wildcards) and the embedding page's `frame-src` must both allow the frame.

## Deploy

Unit [deploy/systemd/openvibe-bot.service](deploy/systemd/openvibe-bot.service) runs
`/opt/openvibe.bot/server/index.js` on `127.0.0.1:4630`, env `/etc/openvibe/bot.env`; nginx
[deploy/nginx/openvibe.bot.conf](deploy/nginx/openvibe.bot.conf) terminates TLS and upgrades
`/device`, `/control` and `/watch` to the same port. The repo documents the unit and env, not an
`ovhost deploy` command — use the host's own installer. Readiness `/api/ready`, liveness
`/api/health`, both loopback-only. Env that refuses to boot when invalid: `BOT_PAIRING_AUTHORITY`
(`bot` or `network`), `BOT_EMBED_ORIGINS` (https origins only; `http://localhost` outside production).

## Tests

`npm test` runs each `test/*.test.js` in its own process through `openvibe-shared/test-runner`, with
PGlite and in-process Network/Events stubs. It covers the device and operator WebSocket gates, the
REST routes, pairing paths, profiles and kits, the owner fence, the e-stop, the outbox, routines,
webhooks, jobs/metering, the embed/watch limits, the simulator and the ONVIF camera against a stub.
`npm run test:pg` runs the same on PostgreSQL. `ov test` is the harness wrapper.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain logic in `server/domain/` and
  `server/`, HTTP in `server/api`/`server/web`, injectable config/db/clock/fetch/log for tests.
- Robot profiles and layouts are data (`bot.robot-profile@1`, `ui.surface@1`, `ui.layout@1`), not
  per-robot code; every control in a layout still goes through the same gate.
- Secrets: device credentials, pairing codes, publish keys and WHIP URLs never reach a log, an
  outbox event, an API response after their one showing, or a file.
- Errors are problem+json with stable codes; egress only to configured hosts (ONVIF one host, no
  redirects; webhooks public addresses only, no redirects).

## Pitfalls

- **The panel e-stop is latched; the owner or a Mod clears it** (a Mod never clears the tray's local STOP/ARM);
  `halt` always passes the gate and a layout cannot hide Stop or the overlay e-stop.
- **Never widen the owner fence.** A person naming another subject, a service, a node token or
  `svc:actor` without the owner's switch must be refused.
- **Device credentials are hashed and read-once.** Do not add a readable copy or a query-string form.
- **Webhooks are written in the transaction that emits the event**, signed and retried 30 s, 2, 10,
  30, 120 min; never post inline and lose the row.
- **ONVIF is one configured host, no embedded credentials, no redirects**, with secret refs only.
- **The simulator is not a device**: no jobs, not counted online, no outbox presence.
- **Embedding is opt-in** (`embed_public`), and `/api/v1` never exposes the flag.
- **Do not put a capability in a layout** — layouts arrange, the gate authorizes.
- **The front page CSP is separate**; a new Network/Frame asset must be added to `HOME_CSP` only, or
  to the site-wide policy if it is used elsewhere.

## Documentation

- [README.md](README.md) — the product, devices, limits, security and deploy.
- [docs/protocol.md](docs/protocol.md) — the device/control/watch WebSocket protocol.
- [docs/live-controls-migration.md](docs/live-controls-migration.md) — where Live's old controls went.
- [docs/controls-embed.md](docs/controls-embed.md) — embedding, tickets and CSP.
- [docs/ai-offers.md](docs/ai-offers.md), [docs/machine-access-relay.md](docs/machine-access-relay.md).
- ADR-043 is the binding contract; `openvibe-contracts` holds `bot.*` shapes and capabilities.
