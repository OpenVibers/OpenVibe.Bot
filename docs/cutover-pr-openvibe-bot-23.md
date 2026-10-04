# OpenVibe.Bot — cutover runbook for PR #23

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal. PR #23 adds **no migration**: `0005_embed_public.sql`
(PR #22) is already applied on the base branch, and this PR only reads `robots.embed_public`. So this is a
no-schema cutover — what runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #23 (plan T15 step R9, second half) serves the framed read-only panel and its anonymous socket on top of
the owner's embed opt-in:

- `server/web/routes.js` — `GET /panel/:id/embed`: the panel for a frame. A signed-in visitor (the `ov_token`
  cookie) who is a member gets the same role `/panel/:id` decides (a stranger on a `queue` robot: `queue`) and
  drives over `/control`; anyone else gets `watcher` when the owner turned `embed_public` on; otherwise `403`
  with only a link out (`renderEmbedRefused`). An unknown robot is `404`. It never redirects to sign in and
  sets no cookie; the response carries its own
  `Content-Security-Policy: default-src 'self'; frame-ancestors 'self' <BOT_EMBED_ORIGINS>; object-src 'none'; base-uri 'self'`
  and `Cache-Control: no-store`. The owner-only `POST /robots/:id/embed` also calls `link.closeWatchers(id)`
  when the switch goes off.
- `server/realtime.js` — the third WebSocket, `wss://…/watch`: no credential, ever. A `join` on an
  `embed_public` robot answers `joined { role: "watcher", allowed_commands: [], state }` where `state` is the
  **public state** (online, e-stop latch, latency, battery, and only the sensor keys the profile's `telemetry`
  widgets read); an unknown or non-public robot answers `bot.not_an_operator` alike. Every other frame answers
  `bot.read_only` and reaches neither a device nor the audit. Frames over 4 KiB close 1009; over
  `BOT_WATCH_MAX_PER_IP` open sockets per client address (default 20) or `BOT_WATCH_MAX_PER_ROBOT` watchers on
  one robot (default 500) the socket closes 4003, as does the owner turning embedding off.
- `server/config.js` — `config.watch.maxPerIp` / `maxPerRobot` from `BOT_WATCH_MAX_PER_IP` (default 20) and
  `BOT_WATCH_MAX_PER_ROBOT` (default 500), each clamped to at least 1.
- `server/web/render.js`, `public/panel.js` — an `embed` render mode (no topbar, no owner form, outbound links
  `target="_blank" rel="noopener"`, a "Sign in to control" link only when signed out) and a watcher client
  that joins `/watch` and refuses to send anything but `join`/`leave`.
- `deploy/nginx/openvibe.bot.conf` — one additive `location = /watch` block that upgrades the third WebSocket
  to `127.0.0.1:4630` under the existing API rate-limit zone.
- `docs/protocol.md` (§2.1), `.env.example`, `README.md`, `STATUS.json`, `test/embed-panel.test.js`.

There is **no migration and no data-shaped change**: the two new settings have defaults, no row is written by
the deploy, and the only column involved (`robots.embed_public`) already exists and is only read. The previous
release knows neither route, neither setting nor the `/watch` path, so it serves correctly against the same
schema and the same rows; a rollback is a plain app rollback with no data step.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-23.md", "rehearsal": "openvibe-bot-23"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-23`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-23.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-23.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This deploy changes no schema and writes no rows, but the guard is
   unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). On boot the service
   applies `migrations/` (this PR leaves **0 pending**; a second run applies nothing) and serves on the pooled
   `DATABASE_URL`. Reload nginx after `deploy/nginx/openvibe.bot.conf` is in place so the new
   `location = /watch` block takes effect; the change is additive and no other vhost is touched. Set
   `BOT_WATCH_MAX_PER_IP` / `BOT_WATCH_MAX_PER_ROBOT` in `/etc/openvibe/bot.env` **only if** the defaults (20 /
   500) are not wanted — both have defaults and neither is required.
4. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (`migrations/0001_bot.sql` through
  `0005_embed_public.sql`, all applied on the base branch).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit` and
  `bot_event_outbox` are noted before the deploy for the verification step. The deploy applies no migration,
  so they must be identical afterwards apart from live traffic; this PR writes no rows at all (no watcher is
  audited, because a watcher's frames are refused before the gate and never reach the outbox).

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop); the journal shows **0 pending**
   migrations, the same schema as before the deploy, and the `wss://…/watch` hub listening.
2. `GET http://127.0.0.1:4630/api/health` answers 2xx and `GET http://127.0.0.1:4630/api/ready` answers 2xx
   (database, Valkey, Network readiness and the outbox relay).
3. Anonymous `GET /panel/<id>/embed` for a robot whose owner left embedding **off** answers `403` with the
   link out and **no robot data** (and never a `302` to `/auth/login`); an unknown id answers `404`; a
   signed-in member keeps their normal role. For a robot with embedding **on**, the anonymous answer is the
   watcher panel (`class="embed-page"`, no topbar, no owner form, every outbound link `target="_blank"
   rel="noopener"`) with `Cache-Control: no-store` and a `Content-Security-Policy` whose `frame-ancestors`
   is `'self'` plus exactly the `BOT_EMBED_ORIGINS` list — every other page still sends `frame-ancestors
   'self'`.
4. Anonymous `wss://openvibe.bot/watch` (through nginx, HTTP 101) with `{"type":"join","robot_id":"<public id>"}`
   answers `joined` with `role: "watcher"`, `allowed_commands: []` and the public state only; the same join on
   a **non-public or unknown** robot answers `bot.not_an_operator` and reveals nothing. A `command`/`estop`/
   `estop_clear` frame answers `bot.read_only` and produces no device frame and no audit row. The owner's
   e-stop reaches a joined watcher; the owner turning `embed_public` off closes its watchers with 4003.
5. With `BOT_WATCH_MAX_PER_IP=2` / `BOT_WATCH_MAX_PER_ROBOT=3` on a scratch start, the 3rd socket from one
   address and the 4th watcher on one robot close 4003; a frame over 4 KiB closes 1009.
6. The row counts from the backup step are unchanged (this PR writes none); `robots.embed_public` is only ever
   read and flips only when an owner uses the `POST /robots/:id/embed` form from PR #22, which is unchanged.

If any of 1–5 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. The previous release has no `/panel/:id/embed` (that path is a plain `404`), destroys an upgrade on
  `/watch`, and ignores `BOT_WATCH_*`; it serves the same schema and the same rows correctly.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
  If the new nginx block was reloaded, the previous vhost (device and control only) works unchanged; leave the
  additive `location = /watch` block in place or restore the previous vhost — either serves the rolled-back
  release.
- **Configuration:** `BOT_WATCH_MAX_PER_IP` / `BOT_WATCH_MAX_PER_ROBOT` are new and have defaults; the previous
  release ignores them, so a rollback needs no change. To return a still-running new release to its defaults,
  unset them (20 / 500) and restart.
- **Data:** there is **no data step to undo**. This PR adds no migration, writes no row, and its one column
  (`robots.embed_public`) belongs to PR #22 and stays in place for both releases. Restore from the pgBackRest
  backup taken in the backup step **only** if an unrelated data incident requires it, coordinating with the
  database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL,
with main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands
the harness runs after it has applied the migrations:

```rehearse
# PR 23 adds no migration: 0005 is already applied on main. This proves the framed /panel/:id/embed route and
# the anonymous read-only /watch socket against the migrated scratch schema, and that the normal panel still
# renders now that render.js grew an embed mode.
node test/embed-panel.test.js
node test/panel.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations — **none**: a second run applies nothing, and `0005_embed_public.sql` is already
   applied from the base branch.
2. It runs `node test/embed-panel.test.js` (the watch caps default to 20/500 and clamp; the embed render has no
   topbar, no owner form and only outbound links; the watcher client joins `/watch` and sends nothing else;
   `GET /panel/:id/embed` serves a public robot to anyone with its own CSP, `no-store` and no cookie and never
   a redirect; a non-public robot is `403` with no data and a member keeps their role; `/watch` answers the
   public state only and refuses a non-public or unknown robot; any other frame is `bot.read_only` and reaches
   neither device nor audit; the owner's e-stop reaches a watcher and readouts carry only the profile's sensor
   keys; turning embedding off closes watchers 4003; the per-address/per-robot caps close 4003) and
   `node test/panel.test.js` (the signed-in panel page, its controls and the simulated robot still render).
3. It confirms **0 pending** migrations afterwards and the fixture row counts unchanged — this PR writes no
   rows and adds no schema.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-23.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
