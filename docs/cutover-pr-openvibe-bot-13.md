# Cutover runbook — OpenVibe.Bot PR #13

PR #13 (`Document installer source URL env and the O30 WHIP ingest base`) changes three files:
`.env.example` (commented env entries), `README.md` (one deploy paragraph) and `server/config.js` (one
comment). No executable path changes and no database change is introduced.

It still needs this runbook because the deploy gate marks every Bot merge `data`: the recipe
(`ds/deploy-recipes.json`, service `bot`) carries `risk: "data"` — Bot owns a schema and its first deploy
creates it — and `ds-deploy.js:riskOf()` returns `data` for that recipe whatever the PR's file list is. So
this manifest is required by rule, not because the change touches data.

## Where the data stands

The running release is `8d0c65b` (`Bot slice B2, plus two findings from Bot PR 10's review`, deployed and
healthy). Its boot applied `migrations/0001_bot.sql` and `migrations/0002_node_principal.sql`; those are the
whole `migrations/` directory at this PR's head, and both are recorded in `ov_migrations`. Migrations are
applied once, in order, each in a transaction unless it says `-- no-transaction`, and are recorded with a
checksum — editing an applied file is refused (`node_modules/openvibe-sdk/src/db/migrate.js`). Nothing is
pending or held, so this deploy applies no schema change and the previous release stays the schema's author.
`server/index.js:27-28` logs any migration that is applied and warns for each one held; a clean boot here
logs neither.

## Order of work

The pipeline (`ds-finish.js` deploy phase) runs these in order for a `data` risk; every one is the broker,
never SSH:

1. **Pre-check** — `ov access run openvibe-ovh health bot`. Passes only on a line containing ` ready `.
2. **Backup** — `ov access run openvibe-ovh db-backup bot`. Unshifted automatically for `risk: data`
   (`ds-finish.js:830`) and is the only pre-deploy restore point.
3. **Deploy** — `ov access run openvibe-ovh deploy bot`. The ordinary release swap and service restart.
4. **Smoke** — `ov access run openvibe-ovh health bot`, again ` ready `.
5. **Record** — `ov access run openvibe-ovh releases bot` shows the new release id, and
   `ov access run openvibe-ovh journal openvibe-bot.service 200` the boot lines.

There is no manual step between them for this change: nothing in the PR is read by the running process, so
there is nothing to switch on or off.

## The backup

`db-backup bot` writes outside the release (ovhost's backup area), not into the repository. Keep it even
though no schema changes: it is what a restore would use if a later, unrelated migration had to be undone,
and it costs one command in a pipeline that already holds the host lock.

## How the result is verified

- `health bot` says ` ready `, and the smoke step is the pipeline's own gate.
- The boot log shows no new migration applied and no `migrations held` warning (`server/index.js:27-28`).
- `GET /api/ready` on loopback answers 200; `GET /api/health` answers with the outbox status
  (`server/app.js:72-76`). Both are loopback-only, so they are probed from the host.
- `releases bot` reports the merged sha.

For this change specifically there is no response-shape difference to check: no endpoint, default or
profile is touched, and `.env.example` is not read at runtime (`dotenv` loads `.env`). A ready service on
the merged release is the whole verification.

## The way back

- **Code** — `ov access run openvibe-ovh rollback bot` returns the service to the release that ran before.
  Because this change has no database effect, the previous release reads exactly the data it left, so no
  restore is needed.
- **Data** — only if a restore is ever needed: the step-2 backup is the point to restore to. Raw restores
  are an owner decision, not an agent step.
- **Downtime** — none beyond the ordinary restart; the deploy is the same swap every Bot release takes.

## The rehearsal

Proposed marker name: `bot-pr13-docs`. It is written by whoever runs this runbook against a copy of the
data, never by this PR:

1. Take a copy of the production bot database (or the harness's PG scratch database) and boot the merged
   release with `DATABASE_DIRECT_URL` pointing at the copy.
2. Confirm `migrate()` reports nothing applied and nothing held, and that the table set and row counts are
   unchanged across the boot (the copy proves the boot is a no-op for the schema).
3. Run the PostgreSQL suite (`BOT_TEST_STORE=pg`, the harness's `ov test` with PG) so the store path is
   exercised against real PostgreSQL, not just PGlite.
4. Only if all of that passed, record `{"ok": true}` in `ds/deploy/rehearsals/bot-pr13-docs.json`.
