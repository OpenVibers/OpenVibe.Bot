# OpenVibe.Bot — cutover runbook for PR #20

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal even when the change itself touches no schema. This is the
runbook for PR #20: what runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #20 (plan T15 step 3, R8) adds the signed-in five-minute path and the profile-rendered panel:

- `server/web/routes.js`, `server/web/render.js` — `GET/POST /robots`, `GET /pair/:id`, `GET /panel/:id`, and
  the two static assets `/panel/panel.js` and `/panel/panel.css` (from `public/`). Adding a robot and minting a
  pairing code through these pages count against the signed-in person's `bot.robot.manage` limit, the same one
  `/api/v1` applies; `/pair/:id` is owner-only and never mints a code for a cross-site navigation or prefetch.
- `server/sim/index.js`, `server/realtime.js`, `server/app.js`, `server/index.js` — an in-process simulator that
  drives robots whose profile driver is `sim`. It attaches through the hub (`attachSim`) with no socket and no
  credential, writes no `devices` row, reports no online/offline event and is not counted in `onlineCount()` or
  `devices()`. A real device online for the same robot is always preferred. At boot it is started for the `sim`
  robots that already exist.
- `deploy/nginx/openvibe.bot.conf` — three `location` blocks (`= /robots`, `^~ /pair/`, `^~ /panel/`) proxied to
  port 4630 under the existing `ovbot_api` rate-limit zone.
- `public/panel.js`, `public/panel.css`, `test/panel.test.js`, `docs/protocol.md`, `README.md`, `STATUS.json`.

**No migration and no schema change.** `migrations/` is untouched (`0001`–`0004` are already applied on the base
branch). The only data the new pages write is what the existing domain calls write: a `robots` row (and its
owner membership and first pairing code) when a person adds a robot, and a fresh `pairing_codes` row when the
owner opens `/pair/:id` — the same rows `POST /api/v1/robots` and the pairing API write today. Deploying the PR
itself writes nothing; the first rows appear only when a signed-in person uses the new pages.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-20.md", "rehearsal": "openvibe-bot-20"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-20`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-20.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-20.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This PR needs no restore for its own sake — it changes no schema — but the
   guard is unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). The release ships the
   nginx vhost `deploy/nginx/openvibe.bot.conf`; validate it (`nginx -t`) and reload nginx **after** the new
   release is serving, so the three new locations never proxy to a process that does not know them. On boot the
   service applies `migrations/` with the owner role on `DATABASE_DIRECT_URL` (0 pending), serves on the pooled
   `DATABASE_URL`, and starts the simulator for existing `sim` robots.
4. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (schema in `migrations/0001_bot.sql` through
  `0004_run_jobs.sql`, all already applied on the base branch).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit` and `bot_event_outbox`
  are noted before the deploy for the verification step.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop) and the journal shows no
   `[Bot] simulator:` warning; with no `sim` robots yet it prints nothing for the simulator.
2. `GET http://127.0.0.1:4630/api/health` answers 2xx; its online-device count is unchanged (a simulator is
   never counted as a machine).
3. `GET http://127.0.0.1:4630/api/ready` answers 2xx: database, Valkey, Network readiness and the outbox relay.
4. Signed out, `GET https://openvibe.bot/robots`, `/pair/<id>` and `/panel/<id>` each answer HTTP 302 to
   `/auth/login?next=<the page>` with `Cache-Control: no-store`; `/panel/panel.js` and `/panel/panel.css` answer
   200 with the right content types. `GET /install` is still a 302 to `BOT_INSTALLER_SOURCE_URL`.
5. Signed in as a test person: `/robots` lists only that person's robots; adding a `sim` robot answers 303 to
   its panel, which renders from the profile and shows the profile's allowed commands; a second person gets 403
   on that panel and on `/pair/<id>` (owner only). Delete or leave the test robot as the owner decides.
6. The migrations table lists the same applied migrations as before the deploy — **0 pending** — and the
   row counts from the backup step differ only by the test robot added in step 5.

If any of 1–4 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. The previous release ignores everything this PR added, so it serves immediately.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then restore the previous nginx vhost
  (the three new `location` blocks are additive; without them `/robots`, `/pair/` and `/panel/` simply 404 at
  the edge), `nginx -t` and reload, then re-run the verification above.
- **Configuration:** no new configuration key; there is nothing to unset.
- **Data:** no migration ran, so there is no schema to roll back. Rows written through the new pages (robots,
  memberships, pairing codes) are ordinary rows the previous release reads like any other and may stay; a
  `sim` robot just has no device behind it after a rollback. Restore from the pgBackRest backup taken in the
  backup step **only** if an unrelated data incident requires it, coordinating with the database owner because
  a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL, with
main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands the
harness runs after it has applied the migrations:

```rehearse
# PR 20 adds no migration; this proves the signed-in pages, the profile-rendered panel, the simulator and the
# per-person write limits, and that the unchanged installer redirect still holds.
node test/panel.test.js
node test/install.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations (none new: a second run must apply nothing).
2. It runs `node test/panel.test.js` (the pages' sign-in redirects, owner/member/queue access, the same-origin
   and prefetch fences, the panel rendered from the profile, and the simulated robot) and
   `node test/install.test.js` (the `/install` redirect and the per-profile `--driver` suffix).
3. It confirms 0 pending migrations against the copy.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-20.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
