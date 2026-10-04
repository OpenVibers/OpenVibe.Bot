# OpenVibe.Bot — cutover runbook for PR #26

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal. PR #26 adds **no migration** but does add **code and
routes**: it serves the internal Run → Bot jobs API. So this is a no-schema cutover with a code step — what
runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #26 makes `bot.job.dispatch` real: the Run service, which owns `run.job.*`, no longer needs an in-process
call into `server/jobs/dispatch.js` — it reaches Bot over the internal HTTP API, service to service. Three new
routes in `server/api/v1.js` wrap what already existed:

- `POST /api/v1/jobs` → `dispatch(db, node_id, job, { link, project, subject, provider })`; `201 { job, sent }`.
- `POST /api/v1/jobs/:id/cancel` → `cancel(db, job_id, { link })`; `{ job, sent }`.
- `GET /api/v1/jobs/:id` → the `run_jobs` row plus its captured stdout; `{ job, stdout }`.

The gate is a new capability `bot.job.dispatch` and it is **services only**: no token answers `401 bot.sign_in`,
a person's token or a node token answers `403 bot.forbidden`, and a service token without the capability
answers `403 capability.denied`. `project_id` is required (`422 bot.invalid_input` — Run is the payer), a job
whose class the device does not advertise is `409 bot.class_unadvertised` and is never stored, and an unknown
job id is `404 bot.job_not_found`. `bot.job.dispatch` is added to `STATUS.json`, to the README capability table
and to `docs/protocol.md` §3; §1.2 now names the HTTP routes instead of "no HTTP route".

- `server/api/v1.js` — the three routes, `requireJobDispatch`, `presentJob`.
- `server/jobs/dispatch.js` — comment only: the module is now called over HTTP.
- `docs/protocol.md` §§1.2, 3 · `README.md` · `STATUS.json` — the routes and the capability.
- `test/run-jobs.test.js` — the new API's refusals, idempotency, stdout and cancel.
- `docs/cutover-pr-openvibe-bot-26.md` — this runbook.

There is **no migration and no schema change**: `run_jobs` and `run_usage_outbox` (plan T14) already exist on
main, and this PR only adds a way to reach `dispatch`/`cancel` that the tests already drove directly. The new
routes write the same rows in the same shape the module already wrote. The previous release reads the same
schema and serves everything else identically, so a rollback is a plain app rollback plus the data note below.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-26.md", "rehearsal": "openvibe-bot-26"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-26`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-26.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-26.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This change touches no schema, but it does add a route that inserts rows,
   and the guard is unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). The service restarts on
   the new code; `migrations/` has **0 pending** (a second run applies nothing). No nginx or `/etc/openvibe/bot.env`
   change is needed — the routes ride the existing `/api/v1` listener, and Run is granted `bot.job.dispatch` by
   the Network service-token authority, not by a Bot setting.
4. **Verify.** Run the checks in the next section before the deploy is called good.
5. **Hand over to Run.** Only once 1–4 are green does Run switch from any direct call to the HTTP API; that
   switch is Run's own cutover (its runbook owns it), and until it runs the routes are simply unexercised.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (`migrations/0001_bot.sql` through `0005_embed_public.sql`,
  all applied on the base branch).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit`, `bot_event_outbox`
  and — because this PR is about them — `run_jobs` and `run_usage_outbox` are noted before the deploy. The
  eight must be unchanged afterwards apart from live traffic and any job Run dispatches during the window.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop) and the journal shows **0 pending**
   migrations.
2. `GET http://127.0.0.1:4630/api/health` and `GET http://127.0.0.1:4630/api/ready` answer 2xx.
3. The new routes are gated as the contract says, checked with a service token holding `bot.job.dispatch`:
   - `POST /api/v1/jobs` with no token → `401 bot.sign_in`; with a person's token → `403 bot.forbidden`; with a
     node token → `403 bot.forbidden`; with a service token lacking the capability → `403 capability.denied`;
     without `project_id` → `422 bot.invalid_input`.
   - A valid dispatch of a job whose class the target Node advertises → `201`, `sent: true`, a `run_jobs` row in
     state `queued`, and the Node receives one `job` frame; the same body again → the same row, `sent: false`,
     no second frame; a class the device does not advertise → `409 bot.class_unadvertised` with **no** row.
   - `GET /api/v1/jobs/:id` → `200` with the row and any captured stdout; an unknown id → `404 bot.job_not_found`.
   - `POST /api/v1/jobs/:id/cancel` → `200`, the row `cancelled`, the Node receives one `job_cancel` frame.
4. Behaviour elsewhere is unchanged: the person and node routes still answer exactly as before, and the
   `/device` and `/control` sockets still gate the same way.
5. `docs/protocol.md` §1.2 no longer says "no HTTP route", §3 lists the three routes and `bot.job.dispatch`,
   and README/STATUS.json carry the capability.
6. The row counts from the backup step are unchanged (apart from live traffic and dispatched jobs).

If 1–4 fail, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** a non-2xx `/api/ready` while the deploy waits for readiness restores the previous release's
  sha; it runs identically on the same schema.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
  The old release has no jobs routes, so Run's HTTP calls fail cleanly and it falls back to whatever it did
  before this cutover.
- **Configuration:** nothing changed in `/etc/openvibe/bot.env` or nginx; no setting needs to be restored.
- **Data:** there is **no migration to undo**. `run_jobs` and `run_usage_outbox` already existed. Rows written
  by a job dispatched through the new route are ordinary `run_jobs` rows with a `run_usage_outbox` metering
  tail; the previous release never reads either table from an HTTP route, so they are inert to it and need no
  cleanup. Restore from the pgBackRest backup taken in the backup step **only** if an unrelated data incident
  requires it, coordinating with the database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL,
with main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands
the harness runs after it has applied the migrations:

```rehearse
# PR 26 adds no migration: run_jobs and run_usage_outbox are already on main. This proves the new internal
# jobs API (auth, idempotency, class check, stdout, cancel) and the metering it wraps against the migrated
# scratch schema, and that the docs (README, STATUS.json, protocol.md) still match the code.
node test/docs.test.js
node test/run-jobs.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations — **none**: a second run applies nothing.
2. It runs `node test/docs.test.js` (README, STATUS.json and protocol.md agree with the code and package.json,
   including the new `bot.job.dispatch` capability) and `node test/run-jobs.test.js` (the dispatcher, its
   metering, and the new `bot.job.dispatch` routes: service-only auth, `project_id`, idempotency, the
   unadvertised class, stdout, `job_not_found` and cancel).
3. It confirms **0 pending** migrations afterwards and the fixture row counts unchanged.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-26.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
