# OpenVibe.Bot — cutover runbook for PR #16

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal even when the change itself touches no schema. This is the
runbook for PR #16: how it is ordered, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #16 lets services with the `bot.robot.read` capability read a robot's audit log, instead of requiring the
owner subject. The change is in the API layer only:

- `server/api/v1.js` — adds `ownerOrRead(req, robotId)` that accepts a service principal with
  `bot.robot.read` (via `requireRead(req)`) and falls back to the owner check for persons. The
  `GET /robots/:id/audit` route now calls `ownerOrRead` instead of `owner`.
- `test/api.test.js` — asserts that a service with `bot.robot.read` receives 200 and the audit rows, and
  that a service with only `bot.robot.manage` is still refused with 403.

No migration, no schema change, no new route, no configuration, no environment variable and no data change.
Merging and deploying it writes nothing to the database. The cutover is therefore a **no-op on data**; the
steps below are the standard deploy guards, kept so the rehearsal exercises them on a copy of the data.

## Cutover manifest (paste into the PR description)

The merge gate requires this fenced block in the PR description (the harness reads `runbook` and `rehearsal`
from it). Keep any existing PR text and add exactly:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-16.md", "rehearsal": "bot-pr16"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `bot-pr16`; the rehearsal writes `ds/deploy/rehearsals/bot-pr16.json`
  = `{"ok": true}` on the harness when it is green. That marker is written by whoever runs the runbook on a
  copy of the data, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook in the PR description
   (`{"runbook": "docs/cutover-pr-openvibe-bot-16.md", "rehearsal": "bot-pr16"}`) and
   `ds/deploy/rehearsals/bot-pr16.json` saying `{"ok": true}`. Only then does the squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest, the nightly
   repository in B2) and confirm the latest restore point is current. This PR cannot need it, but the guard
   is unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; the unit is `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). On boot the
   service applies `migrations/` with the owner role on `DATABASE_DIRECT_URL` and then serves on the pooled
   `DATABASE_URL`.
4. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- Because this PR changes no schema, there is nothing to restore for it; the backup is the guard that lets
  the deploy proceed at all, and it is the way back for any other commit that ships in the same release.
- No `scripts/migrate-to-postgres.js` import step applies: Bot is already on PostgreSQL (schema final in
  `migrations/0001_bot.sql`, with `0002_node_principal.sql` additive).

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop).
2. `GET http://127.0.0.1:4630/api/health` answers 2xx (the process, online devices and outbox status).
3. `GET http://127.0.0.1:4630/api/ready` answers 2xx: database, Valkey, Network readiness and the outbox relay.
4. `GET /api/v1/robots/:id/audit` with a service principal carrying `bot.robot.read` answers 200 and returns
   the audit rows; the same call with only `bot.robot.manage` answers 403 `bot.forbidden`.
5. The migrations table shows the same set of applied migrations as before the deploy — **0 pending** for
   this PR — and row counts of `robots`, `devices`, `command_audit` and `bot_event_outbox` are unchanged.
6. `https://openvibe.bot/` serves, and the `/device` and `/control` WebSocket upgrades still answer.

If any of 1–3 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. Nothing in this PR needs a data rollback, so the previous release serves immediately.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
- **Data:** there is no data to roll back for this PR (no migration ran and no row changed). If a later
  commit in the same release did move data, restore from the pgBackRest backup taken in step 2 and roll the
  release back to the sha that matches it.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production:

1. Restore a copy of a recent Bot database backup into a scratch database and start Bot against it (a scratch
   instance, not `openvibe-bot.service`), with the branch's `migrations/` in place.
2. Confirm the migration step reports **0 pending** for this PR and leaves the tables and row counts as they
   were, then run the verification list above against the scratch instance.
3. When all of it is green, record the marker
   `ds/deploy/rehearsals/bot-pr16.json` = `{"ok": true}` on the harness. **This runbook must not write that
   marker itself** — it is written by whoever performed the rehearsal.
