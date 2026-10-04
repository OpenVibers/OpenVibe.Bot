# OpenVibe.Bot — cutover runbook for PR #18

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal even when the change itself touches no schema. This is the
runbook for PR #18: what runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #18 changes the default target of the `GET /install` redirect so it points at OpenVibe.Node's **released**
installer asset instead of a path on OpenVibe.Node's `main` branch:

- `server/config.js` — the `BOT_INSTALLER_SOURCE_URL` fallback becomes
  `https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/install.sh` (was
  `https://raw.githubusercontent.com/OpenVibers/OpenVibe.Node/main/install/install.sh`).
- `test/install.test.js` — asserts the new default, keeps the allow-list checks, and still proves no query
  parameter can change the redirect target.
- `.env.example` and `README.md` — document the new default and why a released asset is used.

No migration, no schema change, no new route, no new configuration key and no data change. The allow-list in
`checkInstallerSource` (https on `raw.githubusercontent.com`, `github.com`, `objects.githubusercontent.com` or
`openvibe.bot`) is unchanged, and `github.com` was already on it. Merging and deploying this PR writes nothing
to the database. The cutover is therefore a **no-op on data**; the steps below are the standard deploy guards,
kept so the rehearsal exercises them on a copy of the data.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-18.md", "rehearsal": "openvibe-bot-18"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-18`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-18.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-18.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This PR cannot need it — it changes no schema and no row — but the guard is
   unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; the unit is `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630, behind the nginx
   vhost `deploy/nginx/openvibe.bot.conf`). On boot the service applies `migrations/` with the owner role on
   `DATABASE_DIRECT_URL`, then serves on the pooled `DATABASE_URL`.
4. **Verify.** Run the checks in the next section before the deploy is called good. A failed readiness check
   rolls the release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- Because this PR changes no schema and no rows, there is nothing to restore for it; the backup is the guard
  that lets the deploy proceed at all, and it is the way back for any other commit that ships in the same
  release.
- No import step applies: Bot is already on PostgreSQL (schema in `migrations/0001_bot.sql`, with
  `0002_node_principal.sql` and `0003_openre_stream.sql` additive and already applied on the base branch).

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop).
2. `GET http://127.0.0.1:4630/api/health` answers 2xx (the process, online devices and outbox status).
3. `GET http://127.0.0.1:4630/api/ready` answers 2xx: database, Valkey, Network readiness and the outbox relay.
4. `GET https://openvibe.bot/install` **without following redirects** answers HTTP 302 and `Location` equal to
   the configured `BOT_INSTALLER_SOURCE_URL`; with `BOT_INSTALLER_SOURCE_URL` unset the default is
   `https://github.com/OpenVibers/OpenVibe.Node/releases/latest/download/install.sh`. Repeat with
   `?url=https://evil.test/x` and `?to=https://evil.test/x`: both must still answer the same 302 target.
5. The installer command a pairing returns ends in `--driver adeept` for `adeept.adr036`, `--driver adeept-mecanum`
   for `adeept.adr036.mecanum` and `--driver cozmo` for `cozmo`, and has no `--driver` for `sim.rover`.
6. The migrations table shows the same set of applied migrations as before the deploy — **0 pending** for this
   PR — and row counts of `robots`, `devices`, `command_audit` and `bot_event_outbox` are unchanged.

If any of 1–4 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. Nothing in this PR needs a data rollback, so the previous release serves immediately.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
- **Configuration:** the only knob is `BOT_INSTALLER_SOURCE_URL`. Unset it to fall back to the new default, or
  set it back to `https://raw.githubusercontent.com/OpenVibers/OpenVibe.Node/main/install/install.sh` to return
  to the previous target without a code change; both hosts are on the allow-list, so the service restarts clean.
- **Data:** there is no data to roll back for this PR (no migration ran and no row changed). Restore from the
  pgBackRest backup taken in the backup step **only** if an unrelated data incident requires it, coordinating
  with the database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL, with
main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands the
harness runs after it has applied the migrations:

```rehearse
# PR 18 adds no migration; this proves the changed installer default, the unchanged allow-list and the
# pairing installer command against the migrated scratch schema.
node test/install.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations (none new: a second run must apply nothing).
2. It runs `node test/install.test.js`, which asserts the new default source, refuses a non-https or
   non-allow-listed source at boot, confirms `GET /install` redirects with no query parameter able to change
   the target, and checks the per-profile `--driver` suffix.
3. It confirms 0 pending migrations and unchanged row counts against the copy.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-18.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
