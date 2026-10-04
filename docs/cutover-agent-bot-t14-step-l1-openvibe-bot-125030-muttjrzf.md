# OpenVibe.Bot — cutover runbook for plan T14 step L1 (jobs on the device link)

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal. This PR does touch the schema: it adds one migration. This
is its runbook: what runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

Bot becomes the dispatcher of plan T14: it hands `platform.job@1` jobs to a paired OpenVibe.Node over the
`/device` socket (`platform.job-frame@1`) and meters them per wall-clock second for OpenVibe.Billing.

- `migrations/0004_run_jobs.sql` (`-- phase: expand`) — two **new** tables and their indexes:
  - `run_jobs` — one row per job id: the job body, the device (`node_id` → `devices.id`), its state and how far
    it is metered (`usage_read`). `project_id` is plain text with no FK (Bot holds no projects).
  - `run_usage_outbox` — `platform.usage-sample@1` readings waiting for Billing, keyed by
    `event_id` = `run:<job id>:<second>` (UNIQUE), in the openvibe-sdk outbox shape.
- `server/jobs/{dispatch,store,metering}.js` and the device switch in `server/realtime.js` — the seven job
  frames; no HTTP route and no new capability (the Run service calls `dispatch` later).
- `server/config.js`, `.env.example` — `BOT_BILLING_URL`, `BOT_BILLING_TOKEN`, `BOT_BILLING_INTERVAL_MS`,
  `BOT_BILLING_TIMEOUT_MS`. Unset, the usage relay is off and readings wait in `run_usage_outbox`.
- `openvibe-contracts` pin v0.85.0 → v0.92.0 (`platform.job@1`, `platform.job-frame@1`).

The migration is **additive and expand-only**: nothing existing is altered, renamed or dropped, and there is
**no backfill** — both tables start empty and only fill once a caller dispatches a job, which nothing in
production does yet. Existing rows of `robots`, `devices`, `command_audit` and `bot_event_outbox` are untouched.

## Cutover manifest (the harness writes it into the PR description)

```cutover
{"runbook": "docs/cutover-agent-bot-t14-step-l1-openvibe-bot-125030-muttjrzf.md", "rehearsal": "bot-t14-l1"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `bot-t14-l1`; the rehearsal writes `ds/deploy/rehearsals/bot-t14-l1.json` =
  `{"ok": true}` on the harness when it is green. That marker is written by whoever runs the rehearsal, never by
  this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/bot-t14-l1.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. No deploy starts on an unbacked database.
3. **Deploy.** `ov deploy bot` queues the guarded deploy on `openvibe-ovh` (unit `openvibe-bot.service`, layout
   `/opt/openvibe.bot`, port 4630). On boot the service applies `migrations/` with the owner role on
   `DATABASE_DIRECT_URL` (serialised by an advisory lock): `0004_run_jobs.sql` creates the two tables, then the
   service serves on the pooled `DATABASE_URL`.
4. **Configure (optional, any time later).** Set `BOT_BILLING_URL` and `BOT_BILLING_TOKEN` (a Network service
   token, audience `openvibe.billing`, holding `billing.usage.record`) in `/etc/openvibe/bot.env` once Billing
   grants Bot. Until then readings queue; nothing is lost and nothing is billed twice when the relay starts.
5. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database, then `pgbackrest info` to confirm a restore
  point newer than the deploy start.
- The migration only creates empty tables, so there is nothing of this PR's to restore; the backup is the guard
  that lets the deploy proceed, and the way back for any other commit in the same release.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop); the start line reads
   `usage relay off (readings wait)` while `BOT_BILLING_URL`/`BOT_BILLING_TOKEN` are unset.
2. `GET http://127.0.0.1:4630/api/health` and `GET http://127.0.0.1:4630/api/ready` answer 2xx.
3. The migrations table lists `0004_run_jobs.sql` as applied — **0 pending** — and `run_jobs` and
   `run_usage_outbox` exist and are empty.
4. Row counts of `robots`, `devices`, `command_audit` and `bot_event_outbox` are unchanged.
5. A paired device still connects on `/device`, and a command (`halt`) still reaches it and is acked.

If any of 1–5 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** a non-2xx `/api/ready` while the deploy waits restores the previous release's sha.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run checks 1, 2, 4 and 5.
- **Data:** leave the two tables in place. The previous release never reads `run_jobs` or `run_usage_outbox`,
  so they are inert; they are empty unless a job was dispatched, and any queued readings in
  `run_usage_outbox` must be kept (they are owed to Billing) and are delivered once a release with this PR
  returns. Never drop them in a rollback, and never restore the backup for this PR alone.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL, with
main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands the
harness runs after it has applied the migrations:

```rehearse
# 0004_run_jobs.sql is additive (two new tables, no backfill). This proves the job frames, the per-second
# metering and the Billing outbox against the migrated scratch schema.
node test/run-jobs.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations: exactly `0004_run_jobs.sql` applies, and a second run applies nothing.
2. It runs `node test/run-jobs.test.js`: a job reaches a connected Node and only for an advertised class; it is
   resent until acked; exited 0 writes one reading per second plus the partial last second; a lost `job_usage`
   is backfilled; a second `job_exit` writes nothing; a cancel before `job_started` bills nothing;
   `usage_read` never regresses; and with Billing unset or down readings stay queued until a later sweep
   delivers each key once.
3. It confirms 0 pending migrations, the two new tables present, and unchanged row counts of the existing tables
   against the copy.
4. When all of it is green, record the marker `ds/deploy/rehearsals/bot-t14-l1.json` = `{"ok": true}` on the
   harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
