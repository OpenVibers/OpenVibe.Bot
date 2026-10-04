# OpenVibe.Bot — cutover runbook for PR #21

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal even when the change itself touches no schema. This is the
runbook for PR #21: what runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #21 (plan T15 step R8b) gives the panel its controls and readouts:

- `public/panel.js`, `public/panel.css`, `server/web/render.js` — a touch joystick, keyboard and gamepad input
  (each held control re-sent while held, zeroed at once on release), a latency meter, one camera tile per camera
  the profile lists (a placeholder until OpenRe.Stream can play a WHIP stream back to a browser), and a live
  online indicator on `/pair/:id`. These are static assets and server-rendered HTML; the panel still drives over
  `/control` and the command gate is unchanged.
- `test/panel.test.js`, `README.md`, `STATUS.json`.

**No migration and no schema change.** `migrations/` is untouched (`0001`–`0004` are already applied on the base
branch). No new route, no new configuration key and no new write path: the panel sends the same `/control`
commands the previous panel sent. Deploying the PR itself writes nothing.

## Cutover manifest (the harness writes it into the PR description)

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-21.md", "rehearsal": "openvibe-bot-21"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-21`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-21.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and the rehearsal
   marker saying `{"ok": true}` for the pushed head. Only then does the squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This PR needs no restore for its own sake, but the guard is unconditional:
   no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). On boot the service
   applies `migrations/` (0 pending). The nginx vhost is unchanged; no reload is needed.
4. **Verify.** Run the checks below before the deploy is called good. A failed readiness check rolls the
   release back automatically.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (`migrations/0001_bot.sql` through `0004_run_jobs.sql`).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit` and `bot_event_outbox`
  are noted before the deploy for the verification step.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop).
2. `GET http://127.0.0.1:4630/api/health` answers 2xx and `GET http://127.0.0.1:4630/api/ready` answers 2xx.
3. Signed out, `GET https://openvibe.bot/robots`, `/pair/<id>` and `/panel/<id>` still answer HTTP 302 to
   `/auth/login?next=<the page>`; `/panel/panel.js` and `/panel/panel.css` answer 200 with the right content
   types. `GET /install` is still a 302 to `BOT_INSTALLER_SOURCE_URL`.
4. Signed in as a test person with a `sim.rover` robot: `/panel/<id>` renders the joystick, a latency readout
   and one camera tile per profile camera; driving with the keyboard moves the simulated robot and releasing
   the key zeroes it; the camera tile shows its placeholder, not an error. A second person still gets 403 on
   the panel and on `/pair/<id>`.
5. The migrations table lists the same applied migrations as before — **0 pending** — and the row counts from
   the backup step are unchanged (apart from anything a test person added in step 4).

If any of 1–3 fails, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** while the deploy waits for readiness, a non-2xx `/api/ready` restores the previous release's
  sha. The previous release serves its own `panel.js`, `panel.css` and markup, so it works immediately.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
  Browsers that cached the new `panel.js` or `panel.css` pick up the old ones on the next load.
- **Configuration:** no new configuration key; there is nothing to unset.
- **Data:** no migration ran and the PR writes no new rows, so there is no schema to roll back and nothing to
  restore. Restore from the pgBackRest backup **only** if an unrelated data incident requires it,
  coordinating with the database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL, with
main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands the
harness runs after it has applied the migrations:

```rehearse
# PR 21 adds no migration; this proves the panel page, its controls and the simulated robot against the
# migrated scratch schema, and that the unchanged installer redirect still holds.
node test/panel.test.js
node test/install.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations (none new: a second run must apply nothing).
2. It runs `node test/panel.test.js` (the pages' sign-in redirects, access fences, the panel rendered from the
   profile with its joystick, latency meter and camera tiles, and the simulated robot) and
   `node test/install.test.js` (the `/install` redirect and the per-profile `--driver` suffix).
3. It confirms 0 pending migrations and unchanged row counts against the copy.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-21.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
