# OpenVibe.Bot — cutover runbook for PR #22

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal. PR #22 is the first step that actually adds a migration
(`0005_embed_public.sql`), so this runbook is a real data cutover, not the no-op kind: what runs in which
order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #22 (plan T15 step R9, first half) adds the owner's opt-in to anonymous read-only embedding and the
validated allow-list of pages that may frame it:

- `migrations/0005_embed_public.sql` — **phase `expand`**: `ALTER TABLE robots ADD COLUMN embed_public boolean
  NOT NULL DEFAULT false`. Additive only: one new column, `false` for every existing robot, nothing to backfill.
  No row is touched and no event is written. There is no `contract` step in this PR; the column stays.
- `server/config.js` — `BOT_EMBED_ORIGINS` (comma or space separated, default
  `https://openvibe.live,https://www.openvibe.live`) is parsed into `config.embed.origins`, and
  `frameAncestors(config)` builds the CSP `frame-ancestors` list. Each entry must be a bare https origin (no
  path, query or wildcard; `http://localhost:<port>` / `http://127.0.0.1:<port>` only outside production). An
  invalid entry **refuses to boot**.
- `server/domain/index.js`, `server/web/routes.js`, `server/web/render.js` — `setEmbedPublic` and the owner-only
  `POST /robots/:id/embed` (a same-origin form post, `embed_public=on|off`, 303 back to the panel; a
  non-owner, a cross-site Origin, a bad value and a missing robot are refused and audited as usual). The flag is
  web-only: `present.robot` never carries it, so `/api/v1` is unchanged.
- `test/embed-flag.test.js`, `.env.example`, `README.md`, `STATUS.json`.

The migration is the only data-shaped change and it is backward-compatible in both directions: the previous
release's queries neither name `embed_public` nor depend on its absence (new rows take the column default), so
an old release serves correctly against the migrated schema. Deploying this PR writes no rows; a row changes
only when an owner flips the switch, and only that one boolean.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-22.md", "rehearsal": "openvibe-bot-22"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-22`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-22.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-22.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This migration cannot lose or rewrite data, but the guard is unconditional:
   no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). On boot the service
   applies `migrations/` with the owner role on `DATABASE_DIRECT_URL` (this PR leaves **1 pending**: `0005`),
   serialised by the SDK's advisory lock; the single `ALTER TABLE` is transactional, so it either applies
   whole or not at all. It then serves on the pooled `DATABASE_URL`. The nginx vhost is unchanged; no reload is
   needed. Set `BOT_EMBED_ORIGINS` in `/etc/openvibe/bot.env` first **only if** the framing pages differ from
   the default OpenVibe.Live pair — an invalid value stops the service at boot, so set it before the restart,
   not after.
4. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (`migrations/0001_bot.sql` through
  `0004_run_jobs.sql`, all applied on the base branch).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit` and
  `bot_event_outbox` are noted before the deploy for the verification step. The new column starts `false` for
  every row, so `SELECT count(*) FROM robots WHERE embed_public` is 0 immediately after the migration.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop); the journal shows `0005_embed_public.sql`
   applied and no migration held.
2. `GET http://127.0.0.1:4630/api/health` answers 2xx and `GET http://127.0.0.1:4630/api/ready` answers 2xx
   (database, Valkey, Network readiness and the outbox relay).
3. The migrations table lists `0005_embed_public.sql` as applied and **0 pending**; `robots.embed_public`
   exists, is `NOT NULL DEFAULT false`, and `SELECT count(*) FROM robots WHERE embed_public` is 0 — so no
   existing robot was opted in by the migration.
4. With an intentionally invalid `BOT_EMBED_ORIGINS` (e.g. `https://*.evil.test` or `https://x.test/path`), a
   scratch start refuses to boot; with the default or a valid list it boots. The list is only parsed and
   validated in this PR — `frameAncestors(config)` is exported for the embed view that follows in a later step,
   and the responses' CSP still carries the existing `frame-ancestors 'self'`, unchanged by this PR.
5. Signed out, `GET https://openvibe.bot/robots`, `/pair/<id>` and `/panel/<id>` still answer HTTP 302 to
   `/auth/login?next=<the page>`; `GET /install` is still a 302 to `BOT_INSTALLER_SOURCE_URL`.
6. Signed in as a test person with a `sim.rover` robot: `/panel/<id>` shows the embed switch (and `/robots`
   shows one per robot); posting `embed_public=on` answers 303 to `/panel/<id>` and the column becomes `true`;
   posting `off` clears it. `GET /api/v1/robots/<id>` never contains `embed_public`. A member operator and an
   unrelated person get 403 and the flag does not move; a cross-site `Origin` gets 403; a value other than
   `on`/`off` is refused and a missing robot is 404 — with no flag change in any refusal.
7. The row counts from the backup step are unchanged apart from anything the test person added in step 6;
   `embed_public` moved only for the test robot and only while the test held it.

If any of 1–5 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. The previous release never reads `embed_public` and never names `BOT_EMBED_ORIGINS`, so it serves
  correctly against the migrated schema with no data step.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
- **Configuration:** `BOT_EMBED_ORIGINS` is new; the previous release ignores it, so a rollback needs no change.
  To return a still-running new release to its defaults, unset it (falls back to the OpenVibe.Live pair) or set
  it to `https://openvibe.live,https://www.openvibe.live` and restart.
- **Data:** do **not** drop the column to roll back. `embed_public` is additive (`NOT NULL DEFAULT false`), so
  the previous release and this one both serve with it in place; dropping it is a destructive `contract` step
  that belongs to a later PR, and doing it here would break a re-deploy of this release and every row a
  rollback did not touch. Values written during the window are ordinary booleans the previous release ignores.
  Restore from the pgBackRest backup taken in the backup step **only** if an unrelated data incident requires
  it, coordinating with the database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL, with
main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands the
harness runs after it has applied the migrations:

```rehearse
# PR 22 adds migration 0005 (an additive robots.embed_public column); this proves the column, the owner-only
# switch and the validated origin list against the migrated scratch schema, and that the panel still renders.
node test/embed-flag.test.js
node test/panel.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations — `0005_embed_public.sql` applies once, and a second run applies nothing.
2. It runs `node test/embed-flag.test.js` (the column is `false` by default and absent from `/api/v1`; the
   owner flips it on and off and the panel/list reflect it; members and outsiders, cross-site posts, bad values
   and missing robots are refused; `setEmbedPublic` emits no event; the origin list defaults, accepts custom
   lists, and refuses a wildcard, path, query, bare scheme or plain http) and `node test/panel.test.js` (the
   panel page, its controls and the simulated robot still render against the migrated schema).
3. It confirms `0005` applied, **0 pending** afterwards, and the fixture row counts unchanged.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-22.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
