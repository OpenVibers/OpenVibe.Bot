# PR 14 installer cutover

This PR adds `GET /install` and selects an installer driver from the robot profile. Its diff against `origin/main` contains no migration or schema change. Bot still runs its existing migration check at startup; no data conversion or database rollback is planned.

## Rehearsal on a copy

Use an isolated copy of Bot's PostgreSQL data and the same deployment configuration as production, with test credentials and endpoints. The rehearsal name for the cutover gate is `pr_OpenVibe.Bot_14`.

1. Record the deployed Bot revision and take a restorable PostgreSQL backup using the normal backup workflow. Confirm the backup can be restored to the isolated copy before proceeding.
2. Deploy PR 14 to the isolated environment through the normal pipeline. Start Bot with its usual migration step, then check `/api/ready` and `/api/health`.
3. Request `GET /install` without following redirects. Confirm HTTP 302 and `Location` equal to the configured `BOT_INSTALLER_SOURCE_URL`. Repeat with `?url=https://evil.test/x` and `?to=https://evil.test/x`; both must return the same `Location`.
4. Create one `adeept.adr036` and one `sim.rover` robot in the isolated environment. Confirm the first pairing command ends in `--driver adeept` and the second has no `--driver`. Do not run either installer command on production hardware as part of this check.
5. Revert the isolated deployment to the recorded prior revision. Confirm readiness and existing robot records. Rehearsal operators, not this PR, publish the result at `ds/deploy/rehearsals/pr_OpenVibe.Bot_14.json` on the harness with `{"ok": true}` only after every check passes.

## Production order and way back

1. Confirm the Node installer source is reachable and that the Node release consumed by its script is published. Record the current Bot revision and take a fresh, restorable PostgreSQL backup before the guarded Bot deployment.
2. Deploy the reviewed revision through the normal merge pipeline. Confirm `/api/ready` and `/api/health`, then repeat the 302, query-parameter and pairing-command checks above using a controlled test owner. Keep the installer command and pairing code out of logs and tickets.
3. If the new route or pairing command is wrong, roll Bot back to the recorded prior revision through the deployment pipeline and repeat the health and pairing checks. There is no schema reversal or data restore in the ordinary rollback because this PR changes neither schema nor stored data. If an unrelated data incident requires restoring the backup, coordinate it separately with the database owner because a restore can discard writes made after the snapshot.
