# PR 17 OpenRestream publish-key cutover

This PR makes a robot's WHIP publish key an ingest key OpenRestream issues for the robot's stream, instead of
a key Bot mints and hashes itself. Its schema change is `migrations/0003_openre_stream.sql` (phase `expand`):
it only **adds** two nullable columns, `robots.openre_stream_id` and `devices.publish_key_hint`. There is no
backfill, no `NOT NULL`, no index and no rewrite of existing rows, so the previous Bot revision keeps working
against the new schema. Bot applies the migration at startup through its usual migration step.

New configuration (names only): `BOT_OPENRE_URL`, `BOT_OPENRE_TOKEN` (a Network service token holding
`openre.stream.read`, `openre.stream.write` and `openre.key.rotate`), optional `BOT_OPENRE_TIMEOUT_MS`
(default 8000), and `BOT_WHIP_BASE=https://ingest.openre.stream/whip` in production. With `BOT_OPENRE_URL` or
`BOT_OPENRE_TOKEN` unset, pairing still succeeds and answers `"video": "not_configured"`; Bot mints no key.

## Rehearsal on a copy

Use an isolated copy of Bot's PostgreSQL data and the same deployment configuration as production, with test
credentials and endpoints (a test OpenRestream instance or the stub, never production OpenRestream). The rehearsal
name for the cutover gate is `pr_OpenVibe.Bot_17`.

1. Record the deployed Bot revision and take a restorable PostgreSQL backup using the normal backup workflow.
   Confirm the backup restores to the isolated copy before proceeding.
2. At the isolated deployment, set `BOT_OPENRE_URL`/`BOT_OPENRE_TOKEN` to the test endpoint and
   `BOT_WHIP_BASE` to the test WHIP base. Deploy PR 17 through the normal pipeline; Bot applies migration
   0003 at startup. Check `/api/ready` and `/api/health`.
3. Confirm the schema: `robots.openre_stream_id` and `devices.publish_key_hint` exist, both nullable, with no
   values changed in existing rows.
4. Pair a test robot. Confirm HTTP 201 with a `publish_key` OpenRestream admits, `whip_url` equal to
   `BOT_WHIP_BASE/<publish_key>`, and no `video` field. Confirm `robots.openre_stream_id` holds the OpenRestream
   stream id, `devices.publish_key_hint` the key's last characters, and `devices.publish_key_hash` is null;
   the key itself appears in no table, log or read.
5. Re-pair the same robot and rotate the device credential. Confirm OpenRestream rotated the same stream (no second
   stream definition is created) and the previous key stops being admitted, then keeps working only through
   the rotation's grace.
6. Revoke the device: confirm OpenRestream rotated with no grace and ended the live session. Remove the robot:
   confirm the stream is archived when nothing is live.
7. Restart with `BOT_OPENRE_URL`/`BOT_OPENRE_TOKEN` unset and pair. Confirm HTTP 201 with
   `"video": "not_configured"`, no `publish_key`/`whip_url`, and no local key minted.
8. Point `BOT_OPENRE_URL` at an unreachable host and pair. Confirm a clean `503 bot.openre_unavailable`, the
   pairing code left unused, and no device row written.
9. Revert the isolated deployment to the recorded prior revision. Confirm readiness and that the existing
   robot and device rows are intact. Rehearsal operators, not this PR, publish the result at
   `ds/deploy/rehearsals/pr_OpenVibe.Bot_17.json` on the harness with `{"ok": true}` only after every check
   passes.

## Production order and way back

1. Confirm OpenRestream is reachable and that the Network service token holds `openre.stream.read`,
   `openre.stream.write` and `openre.key.rotate`. Record the current Bot revision and take a fresh, restorable
   PostgreSQL backup before the guarded Bot deployment.
2. Add `BOT_OPENRE_URL`, `BOT_OPENRE_TOKEN` and `BOT_WHIP_BASE=https://ingest.openre.stream/whip` (and
   `BOT_OPENRE_TIMEOUT_MS` if the default 8000 ms is wrong) to `/etc/openvibe/bot.env` **before** deploying.
3. Deploy the reviewed revision through the merge pipeline. Confirm `/api/ready`, `/api/health`, and the two
   new columns. Pair one controlled test robot with a test owner, confirm its key is admitted by OpenRestream and
   stored only as a hint, then remove the robot so its stream is archived.
4. If the OpenRestream wiring is wrong, unset `BOT_OPENRE_*` and restart: pairing still works and answers
   `"video": "not_configured"`, and already-issued OpenRestream keys keep publishing until rotated. Roll Bot back to
   the recorded prior revision through the deployment pipeline; migration 0003 is expand-only, so the prior
   revision simply ignores the two new columns and no schema reversal or data restore is needed for a code
   rollback. Restore the backup only if an unrelated data incident requires it, coordinating with the database
   owner because a restore discards writes made after the snapshot.
