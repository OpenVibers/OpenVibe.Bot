'use strict';

/**
 * Account export and deletion → Bot (ADR-033; openvibe-sdk/account-data). What Bot holds about a person:
 *
 *   their robots        each removed the way its owner would remove it (domain.robots.remove: the robot's OpenRestream
 *                       stream key is revoked and its stream archived, then the row goes, and with it, by
 *                       ON DELETE CASCADE, its pairing codes, operators, queue, local profile and Live conversion).
 *                       Its command history goes too, and a device that served only their robots is revoked
 *                       (domain.devices.revoke): run jobs reference devices and are billing records, so the device
 *                       row stays, revoked, without its name.
 *   elsewhere           their operator role and queue place on other people's robots go; their id leaves other
 *                       robots' command history (operator_subject), e-stop marks, pairing codes and invitations.
 *   their machines      the worker machines they added (no robot, plan T14/T16) are exported, then revoked and kept
 *                       without a name or an owner (run jobs reference them).
 *   kept                run jobs they started: usage seconds reported to Billing, counted as retained.
 *
 * Nothing exported is a secret: device credentials and publish keys are stored as hashes and never exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'robot_operators', subject: 'subject', file: 'operating.json', columns: ['robot_id', 'role', 'created_at'] },
    { table: 'robot_queue', subject: 'subject', file: null },
    { table: 'command_audit', subject: 'operator_subject', file: 'commands.json', columns: ['robot_id', 'kind', 'result', 'reason', 'at'], order: 'at', erase: anonymize },
    { table: 'robots', subject: 'estop_by', file: null, erase: anonymize },
    { table: 'pairing_codes', subject: 'created_by', file: null, erase: anonymize },
    { table: 'robot_operators', subject: 'added_by', file: null, erase: anonymize },
    { table: 'live_conversions', subject: 'owner_subject', file: null },
    // A device's request to be added (server/claims.js): who approved or denied it. Short-lived; erased with the account.
    { table: 'device_claims', subject: 'owner_subject', file: null },
    { table: 'run_jobs', subject: 'subject', value: (usr) => [usr, `user:${usr}`], file: 'run-jobs.json', columns: ['id', 'class', 'state', 'wall_ms', 'exit_reason', 'created_at', 'finished_at'], erase: { keep: 'usage seconds reported to Billing' } },
    // Community robot profiles: the person's own submissions are exported; on deletion the ones still waiting, refused or
    // withdrawn go (extraErase) and an approved one stays in the catalogue, authorless (robots may use it).
    { table: 'profile_submissions', subject: 'submitter_subject', file: 'robot-submissions.json', columns: ['profile_id', 'profile_version', 'profile', 'driver_url', 'guide_url', 'license', 'notes', 'status', 'review_note', 'created_at'], order: 'created_at', erase: { keep: 'approved profiles stay in the catalogue, authorless (extraErase)' } },
    { table: 'profile_submissions', subject: 'reviewed_by', file: null, erase: anonymize },
    // Their own machines that run their jobs (plan T14/T16): exported here; revoked and made nameless and ownerless in
    // extraErase (run jobs reference the device rows and are billing records). What the machine's coding agents last
    // reported (fleet, fleet_at; Codes C9c) is theirs too: labels, numbers and times only, never a key or a token.
    { table: 'devices', subject: 'owner_subject', file: 'machines.json', columns: ['id', 'name', 'kind', 'agent_version', 'created_at', 'last_seen', 'revoked_at', 'fleet', 'fleet_at'], order: 'created_at', erase: { keep: 'revoked and made ownerless in extraErase' } },
];

async function extraExport(db, subject) {
    const robots = await db.many(`SELECT id, name, profile_id, profile_version, access_policy, limits, created_at, updated_at FROM robots
        WHERE owner_subject = $1 ORDER BY created_at DESC`, [subject]);
    if (!robots.length) return [];
    const ids = robots.map((r) => r.id);
    const routines = await db.many('SELECT robot_id, name, source, trigger, enabled, created_at FROM robot_routines WHERE robot_id = ANY($1::text[]) ORDER BY created_at', [ids]);
    const hooks = await db.many('SELECT robot_id, url, events, created_at FROM robot_webhooks WHERE robot_id = ANY($1::text[]) ORDER BY created_at', [ids]);
    return [{ name: 'robots.json', content: robots },
        ...(routines.length ? [{ name: 'robot-routines.json', content: routines }] : []),
        ...(hooks.length ? [{ name: 'robot-webhooks.json', content: hooks }] : [])];
}

/** The account-data handle over Bot's domain (server/domain: robots.remove, devices.revoke). */
function create({ domain, log = console } = {}) {
    async function extraErase(t, subjects, counts) {
        // Their worker machines: revoked (the link closes as the device is next seen), then the row keeps no name or owner.
        const machines = await t.many('SELECT id FROM devices WHERE owner_subject = ANY($1::text[]) AND revoked_at IS NULL', [subjects]);
        for (const d of machines) await domain.devices.revoke(d.id);
        // (The table map's `devices` entry already counts them as retained.)
        await t.exec('UPDATE devices SET owner_subject = NULL, name = NULL WHERE owner_subject = ANY($1::text[])', [subjects]);
        // A submission that never reached the catalogue is the person's alone; an approved one stays, without its author.
        counts.add(counts.erased, 'profile_submissions', await t.exec("DELETE FROM profile_submissions WHERE submitter_subject = ANY($1::text[]) AND status <> 'approved'", [subjects]));
        await t.exec("UPDATE profile_submissions SET submitter_subject = NULL WHERE submitter_subject = ANY($1::text[])", [subjects]);
        const robots = await t.many('SELECT id FROM robots WHERE owner_subject = ANY($1::text[])', [subjects]);
        const ids = robots.map((r) => r.id);
        if (ids.length) {
            // Devices that served only these robots: revoked (run jobs reference them), and their name goes.
            const devices = await t.many(`SELECT id FROM devices WHERE revoked_at IS NULL AND jsonb_array_length(robot_ids) > 0
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(robot_ids) r WHERE NOT (r = ANY($1::text[])))`, [ids]);
            for (const d of devices) await domain.devices.revoke(d.id);
            counts.add(counts.retained, 'devices', devices.length);
            await t.exec(`UPDATE devices SET name = NULL WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(robot_ids) r WHERE NOT (r = ANY($1::text[])))
                AND jsonb_array_length(robot_ids) > 0`, [ids]);
            counts.add(counts.erased, 'command_audit', await t.exec('DELETE FROM command_audit WHERE robot_id = ANY($1::text[])', [ids]));
            // Each robot the way its owner would remove it (OpenRestream key revoked first; a refusal there rolls this back and
            // Events retries).
            for (const id of ids) await domain.robots.remove(id);
            counts.add(counts.erased, 'robots', ids.length);
        }
    }
    return createAccountData({ db: domain.db, service: 'bot', tables: TABLES, extraExport, extraErase, log });
}

module.exports = { create, TABLES, TOPICS };
