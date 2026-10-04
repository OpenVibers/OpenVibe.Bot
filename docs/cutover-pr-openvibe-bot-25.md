# OpenVibe.Bot — cutover runbook for PR #25

The harness marks OpenVibe.Bot **risk data** (the repository owns `migrations/`), so a PR that merges into it
must carry a cutover manifest and a green rehearsal. PR #25 adds **no migration** and changes **no code**: it
documents the two-sided framing contract of the embed panel. So this is a no-schema, no-code cutover — what
runs in which order, what is backed up, how the result is verified, and the way back.

## Scope — what this PR actually changes

PR #25 states that framing the embed panel takes both sides, and that the two allow-lists are independent:
`BOT_EMBED_ORIGINS` lets a page frame Bot (CSP `frame-ancestors` on `/panel/:id/embed`), while that page must
list Bot's origin (its `BASE_URL`, `https://openvibe.bot` in production) in its own CSP `frame-src`
(OpenVibe.Live computes it from `LIVE_BOT_URL`, default `https://openvibe.bot`).

- `docs/protocol.md` (§2.1) — the paragraph on the embed response's CSP.
- `README.md` — the same contract next to the `BOT_EMBED_ORIGINS` and `/watch` paragraph.
- `.env.example` — two comment lines on `BOT_EMBED_ORIGINS`; the commented-out value is unchanged.
- `docs/cutover-pr-openvibe-bot-25.md` — this runbook.

There is **no migration and no data-shaped change**: no setting, route, header or row is added or altered, the
runtime reads the same variables with the same defaults, and `.env.example` is a template that no deploy reads.
The previous release serves the same schema and rows identically; a rollback is a plain app rollback with no
data step.

## Cutover manifest (the harness writes it into the PR description)

The merge gate reads `runbook` and `rehearsal` from a fenced `cutover` block in the PR description. The harness
adds it from this file at the verified head; it resolves to:

```cutover
{"runbook": "docs/cutover-pr-openvibe-bot-25.md", "rehearsal": "openvibe-bot-25"}
```

- `runbook` — this file, the runbook the rehearsal follows.
- `rehearsal` — the marker name `openvibe-bot-25`; the rehearsal writes
  `ds/deploy/rehearsals/openvibe-bot-25.json` = `{"ok": true}` on the harness when it is green. That marker is
  written by whoever runs the rehearsal, never by this runbook and never by the PR author.

## What runs, in which order

1. **Merge gate (harness).** Checks green, review SHIP, this runbook on the verified head, and
   `ds/deploy/rehearsals/openvibe-bot-25.json` saying `{"ok": true}` for the pushed head. Only then does the
   squash-merge run.
2. **Backup.** Take the standard pre-deploy backup of Bot's PostgreSQL database (pgBackRest) and confirm the
   latest restore point is current. This change touches no schema and writes no rows, but the guard is
   unconditional: no deploy starts on an unbacked database.
3. **Deploy.** Bot deploys through its own pipeline (`ov deploy bot` queues the guarded deploy on
   `openvibe-ovh`; unit `openvibe-bot.service`, layout `/opt/openvibe.bot`, port 4630). The service restarts on
   unchanged code; `migrations/` has **0 pending** (a second run applies nothing). No nginx or
   `/etc/openvibe/bot.env` change is needed.
4. **Verify.** Run the checks in the next section before the deploy is called good.

## The backup

- Command: the standard pgBackRest backup of the Bot database (the same one every Bot deploy takes), then
  `pgbackrest info` to confirm a restore point newer than the deploy start.
- No import step applies: Bot is already on PostgreSQL (`migrations/0001_bot.sql` through
  `0005_embed_public.sql`, all applied on the base branch).
- Row counts of `robots`, `devices`, `robot_operators`, `pairing_codes`, `command_audit` and
  `bot_event_outbox` are noted before the deploy; they must be unchanged afterwards apart from live traffic.

## How the result is verified

1. `openvibe-bot.service` is active after the restart (no crash loop) and the journal shows **0 pending**
   migrations.
2. `GET http://127.0.0.1:4630/api/health` and `GET http://127.0.0.1:4630/api/ready` answer 2xx.
3. Behaviour is unchanged: anonymous `GET /panel/<id>/embed` for a robot with embedding **on** still answers
   the watcher panel with `Cache-Control: no-store` and a `Content-Security-Policy` whose `frame-ancestors` is
   `'self'` plus exactly the `BOT_EMBED_ORIGINS` list; with embedding **off** it still answers `403`; every
   other page still sends `frame-ancestors 'self'`. Anonymous `wss://openvibe.bot/watch` still answers
   `joined` with `role: "watcher"` for a public robot.
4. The documentation says what the behaviour is: `docs/protocol.md` §2.1 and the README embed paragraph both
   say the embedding page must list Bot's origin in its own `frame-src`, and `.env.example` carries the same
   note above `BOT_EMBED_ORIGINS`.
5. The row counts from the backup step are unchanged.

If 1–3 fail, the deploy is not good: roll back (below) and investigate.

## Way back (rollback and restore)

- **Automatic:** a non-2xx `/api/ready` while the deploy waits for readiness restores the previous release's
  sha; it runs identically on the same schema and rows.
- **Manual:** `ovhost rollback bot --to <previous sha>` on `openvibe-ovh`, then re-run the verification above.
- **Configuration:** nothing changed; no setting needs to be restored.
- **Data:** there is **no data step to undo**. This PR adds no migration and writes no row. Restore from the
  pgBackRest backup taken in the backup step **only** if an unrelated data incident requires it, coordinating
  with the database owner because a restore discards writes made after the snapshot.

## Rehearsal on a copy of the data

Whoever runs this runbook rehearses it **on a copy** — never on production — against a scratch PostgreSQL,
with main's migrations, the repository's fixtures and this PR's head. The fenced block declares the commands
the harness runs after it has applied the migrations:

```rehearse
# PR 25 adds no migration and no code. This proves the docs and README tests still hold and that the embed
# panel and its CSP behave as the new text describes, against the migrated scratch schema.
node test/docs.test.js
node test/embed-panel.test.js
```

1. The harness starts a scratch database, applies the base branch's migrations and the repository's fixtures,
   then this PR's migrations — **none**: a second run applies nothing.
2. It runs `node test/docs.test.js` (README and STATUS.json agree with package.json) and
   `node test/embed-panel.test.js` (the embed route's own CSP with `frame-ancestors` from
   `BOT_EMBED_ORIGINS`, `no-store`, the watcher socket and its caps).
3. It confirms **0 pending** migrations afterwards and the fixture row counts unchanged.
4. When all of it is green, record the marker `ds/deploy/rehearsals/openvibe-bot-25.json` = `{"ok": true}` on
   the harness. **This runbook must not write that marker itself** — it is written by whoever performed the
   rehearsal, from the runbook's exit code.
