'use strict';

/**
 * OpenVibe.Bot domain (ADR-043): robots, devices, pairing, operators, the command audit, the timed turn
 * queue and the control gate. Everything here is database-backed and testable without a socket; the
 * realtime layer (server/realtime.js) owns the live connections and calls into this.
 *
 * A robot (rob_…) is what the owner shares; a device (dev_…) is a running agent attached to one or more
 * robots, holding one rotatable, revocable credential (32 random bytes, stored hashed, shown once). The
 * gate applies, in order: the robot exists, the e-stop is clear, the caller's role, the per-role command
 * allowlist, the access policy (private/invite: owner + operators; queue: the active turn holder too),
 * the owner's limits (clamped), the per-turn budget and cooldowns, and the device being online (commands
 * are never queued). Every decision — allowed or refused — is audited.
 */
const {
    BotError, fail, prefixedId, iso, token, hashSecret, secretEquals, json, text, storable,
} = require('../util');
const { getProfile } = require('../profiles');
const { ENVELOPE } = require('../events/outbox');

const DEFAULT_ALLOW = {
    owner: ['drive', 'actuator', 'ptz', 'say', 'display', 'halt'],
    operator: ['drive', 'actuator', 'ptz', 'say', 'display', 'halt'],
    queue: ['drive', 'halt'],
};
const KINDS = new Set(['drive', 'actuator', 'ptz', 'say', 'display', 'halt']);
const MOTION = new Set(['drive', 'actuator', 'ptz']);

// Crockford base32: no I, L, O or U, so a code read aloud cannot be mistyped into another.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const normaliseCode = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[ILO]/g, (c) => ({ I: '1', L: '1', O: '0' }[c]));
function newCode() {
    const b = require('crypto').randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] % 32];
    return s;
}
const formatCode = (s) => `${s.slice(0, 4)}-${s.slice(4)}`;
const isCodeShape = (s) => /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s);

const clampNum = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function createDomain({ db, config, outbox, link = null, now = () => Date.now(), log = console }) {
    // ── Presenters ────────────────────────────────────────────────────────────────────────────────
    const presentRobot = (r) => (r ? {
        id: r.id, name: r.name, profile_id: r.profile_id, profile_version: r.profile_version,
        access_policy: r.access_policy, limits: json(r.limits, {}),
        estop: { latched: !!r.estop_latched, by: r.estop_by || null, at: r.estop_at ? iso(new Date(r.estop_at).getTime()) : null },
        created_at: iso(new Date(r.created_at).getTime()), updated_at: iso(new Date(r.updated_at).getTime()),
    } : null);
    // A device is presented without any hash: the credential and the publish key are shown once only.
    const presentDevice = (d) => (d ? {
        id: d.id, robot_ids: json(d.robot_ids, []), name: d.name || null, kind: d.kind,
        agent_version: d.agent_version || null, drivers: json(d.drivers, []), capabilities: json(d.capabilities, {}),
        last_seen: d.last_seen ? iso(new Date(d.last_seen).getTime()) : null, revoked_at: d.revoked_at ? iso(new Date(d.revoked_at).getTime()) : null,
        created_at: iso(new Date(d.created_at).getTime()), updated_at: iso(new Date(d.updated_at).getTime()),
    } : null);

    async function emit(t, event_type, subject, payload) {
        await outbox.emitIn(t, { ...ENVELOPE, event_type, subject, payload });
    }

    // ── Membership and roles ──────────────────────────────────────────────────────────────────────
    async function roleOf(robotId, subject, q = db) {
        if (!subject) return null;
        const r = await q.maybe('SELECT role FROM robot_operators WHERE robot_id = $1 AND subject = $2', [robotId, subject]);
        return r ? r.role : null;
    }
    async function listOperators(robotId) {
        return db.many('SELECT subject, role, added_by, created_at FROM robot_operators WHERE robot_id = $1 ORDER BY created_at', [robotId]);
    }
    async function addOperator(robotId, subject, role, addedBy) {
        if (!['owner', 'operator', 'viewer'].includes(role)) fail(422, 'bot.invalid_role', 'role must be owner, operator or viewer');
        if (role === 'owner') fail(422, 'bot.invalid_role', 'ownership is not transferred by adding an operator');
        await db.query(
            `INSERT INTO robot_operators (robot_id, subject, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (robot_id, subject) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
            [robotId, subject, role, addedBy || null, iso(now())]);
    }
    async function removeOperator(robotId, subject) {
        await db.query(`DELETE FROM robot_operators WHERE robot_id = $1 AND subject = $2 AND role <> 'owner'`, [robotId, subject]);
    }

    // ── Robots ────────────────────────────────────────────────────────────────────────────────────
    async function getRobot(id) {
        return db.maybe('SELECT * FROM robots WHERE id = $1', [id]);
    }
    async function listRobots(owner) {
        return db.many('SELECT * FROM robots WHERE owner_subject = $1 ORDER BY created_at DESC', [owner]);
    }
    async function createRobot({ owner, name, profile_id, access_policy = 'private', limits = {}, installerUrl }) {
        const profile = await getProfile(db, profile_id);
        if (!profile) fail(422, 'bot.unknown_profile', `no profile ${profile_id}`);
        const cleanName = text(name, 'name', 80);
        if (!cleanName) fail(422, 'bot.invalid_input', 'name is required');
        if (!['private', 'invite', 'queue'].includes(access_policy)) fail(422, 'bot.invalid_policy', 'access_policy must be private, invite or queue');
        const id = prefixedId('rob', now());
        const at = iso(now());
        const created = await db.tx(async (t) => {
            await t.query(`INSERT INTO robots (id, owner_subject, name, profile_id, profile_version, access_policy, limits, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
                [id, owner, cleanName, profile.id, profile.version, access_policy, JSON.stringify(cleanLimits(limits)), at]);
            await t.query(`INSERT INTO robot_operators (robot_id, subject, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)`, [id, owner, at]);
            return t.maybe('SELECT * FROM robots WHERE id = $1', [id]);
        });
        const pairing = await createPairingCode(id, owner, installerUrl);
        return { robot: created, pairing };
    }
    function cleanLimits(limits = {}) {
        const out = {};
        for (const k of ['max_speed', 'max_turn', 'max_command_ms', 'turn_ms', 'turn_budget', 'cooldown_ms']) {
            const n = Number(limits[k]);
            if (limits[k] != null && Number.isFinite(n) && n >= 0) out[k] = n;
        }
        if (limits.allow && typeof limits.allow === 'object') {
            out.allow = {};
            for (const role of ['owner', 'operator', 'queue']) {
                if (Array.isArray(limits.allow[role])) out.allow[role] = limits.allow[role].filter((k) => KINDS.has(k));
            }
        }
        return out;
    }
    async function updateRobot(id, { name, access_policy, limits }) {
        const sets = []; const args = [id];
        if (name !== undefined) { const n = text(name, 'name', 80); if (!n) fail(422, 'bot.invalid_input', 'name cannot be empty'); args.push(n); sets.push(`name = $${args.length}`); }
        if (access_policy !== undefined) { if (!['private', 'invite', 'queue'].includes(access_policy)) fail(422, 'bot.invalid_policy', 'bad access_policy'); args.push(access_policy); sets.push(`access_policy = $${args.length}`); }
        if (limits !== undefined) { args.push(JSON.stringify(cleanLimits(limits))); sets.push(`limits = $${args.length}::jsonb`); }
        if (!sets.length) return getRobot(id);
        args.push(iso(now()));
        sets.push(`updated_at = $${args.length}`);
        await db.query(`UPDATE robots SET ${sets.join(', ')} WHERE id = $1`, args);
        return getRobot(id);
    }
    async function removeRobot(id) {
        await db.query('DELETE FROM robots WHERE id = $1', [id]);
    }

    // ── Pairing (ADR-043 decision 2) ──────────────────────────────────────────────────────────────
    async function createPairingCode(robotId, createdBy, installerUrl) {
        const code = newCode();
        const at = iso(now());
        const expires = iso(now() + config.pairing.ttlMs);
        // One live code per robot: an older unused one is replaced.
        await db.tx(async (t) => {
            await t.query('DELETE FROM pairing_codes WHERE robot_id = $1 AND used_at IS NULL', [robotId]);
            await t.query('INSERT INTO pairing_codes (id, robot_id, code_hash, created_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [prefixedId('pair', now()), robotId, hashSecret(code), createdBy || null, expires, at]);
        });
        return { code: formatCode(code), expires_at: expires, installer: installerCommand(robotId, formatCode(code), installerUrl) };
    }
    function installerCommand(robotId, code, installerUrl) {
        const url = installerUrl || config.installer.scriptUrl;
        return `curl -fsSL ${url} | sh -s -- --robot ${robotId} --code ${code}`;
    }
    /**
     * Redeem a pairing code. `robot` (from the installer command/QR) attributes a wrong code to that
     * robot's live code and counts the try (5 end it); without it the code is matched by hash across
     * every live code. On success the credential and the publish key are returned once, never stored in
     * the clear.
     */
    async function redeem({ robot = null, code, agent_version = null, device_kind = 'onboard', drivers = [], capabilities = {}, name = null }) {
        const normal = normaliseCode(code);
        if (!isCodeShape(normal)) fail(422, 'bot.invalid_pairing_code', 'the pairing code must be 8 characters (XXXX-XXXX)');
        const hash = hashSecret(normal);
        const at = iso(now());
        // A wrong try must survive the refusal, so refusals are returned (not thrown) inside the
        // transaction and raised only after it commits.
        const result = await db.tx(async (t) => {
            let row = null;
            if (robot) {
                row = await t.maybe('SELECT * FROM pairing_codes WHERE robot_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [robot]);
                if (!row) return { error: [404, 'bot.no_pairing_code', 'this robot has no pairing code; ask the owner for a new one'] };
                if (!secretEquals(row.code_hash, hash)) {
                    const tries = row.tries + 1;
                    const dead = tries >= config.pairing.maxTries;
                    await t.query('UPDATE pairing_codes SET tries = $2, used_at = CASE WHEN $3 THEN $4 ELSE used_at END WHERE id = $1', [row.id, tries, dead, at]);
                    return { error: [403, dead ? 'bot.pairing_code_locked' : 'bot.pairing_code_invalid', dead ? 'too many wrong tries; the code is dead' : 'that is not the pairing code'] };
                }
            } else {
                row = await t.maybe('SELECT * FROM pairing_codes WHERE code_hash = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [hash]);
                if (!row) return { error: [403, 'bot.pairing_code_invalid', 'that is not a live pairing code'] };
            }
            if (row.used_at) return { error: [403, 'bot.pairing_code_used', 'that pairing code has already been used'] };
            if (new Date(row.expires_at).getTime() <= now()) return { error: [403, 'bot.pairing_code_expired', 'that pairing code has expired'] };
            if (row.tries >= config.pairing.maxTries) return { error: [403, 'bot.pairing_code_locked', 'too many wrong tries; the code is dead'] };
            await t.query('UPDATE pairing_codes SET used_at = $2 WHERE id = $1', [row.id, at]);
            const deviceId = prefixedId('dev', now());
            const credential = token(32);
            const publishKey = token(32);
            const device = await t.maybe(
                `INSERT INTO devices (id, robot_ids, name, kind, agent_version, drivers, capabilities, credential_hash, publish_key_hash, created_at, updated_at)
                 VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $10) RETURNING *`,
                [deviceId, JSON.stringify([row.robot_id]), text(name, 'name', 80), device_kind, storable(agent_version || ''), JSON.stringify(drivers || []), JSON.stringify(capabilities || {}), hashSecret(credential), hashSecret(publishKey), at]);
            return { device, credential, publishKey, robot_id: row.robot_id };
        });
        if (result.error) fail(result.error[0], result.error[1], result.error[2]);
        const profile = await getProfile(db, (await getRobot(result.robot_id)).profile_id);
        return { device: result.device, credential: result.credential, publish_key: result.publishKey, profile: profile ? profile.profile : null };
    }
    async function prunePairingCodes() {
        await db.query('DELETE FROM pairing_codes WHERE expires_at < $1', [iso(now() - 24 * 3600 * 1000)]);
    }

    // ── Devices (ADR-043 decision 1) ──────────────────────────────────────────────────────────────
    function byCredential(credential) {
        if (!credential) return Promise.resolve(null);
        const hash = hashSecret(credential);
        return db.maybe(
            `SELECT * FROM devices WHERE revoked_at IS NULL AND (credential_hash = $1 OR (credential_prev_hash = $1 AND prev_valid_until > $2))`,
            [hash, iso(now())]);
    }
    async function getDevice(id) { return db.maybe('SELECT * FROM devices WHERE id = $1', [id]); }
    async function listDevicesForRobot(robotId) {
        return db.many('SELECT * FROM devices WHERE robot_ids @> $1::jsonb ORDER BY created_at DESC', [JSON.stringify([robotId])]);
    }
    async function rotateDevice(id) {
        const d = await getDevice(id);
        if (!d || d.revoked_at) fail(404, 'bot.device_not_found', 'no live device');
        const credential = token(32);
        const publishKey = token(32);
        const at = iso(now());
        const updated = await db.maybe(
            `UPDATE devices SET credential_hash = $2, credential_prev_hash = $3, prev_valid_until = $4, publish_key_hash = $5, updated_at = $6
             WHERE id = $1 RETURNING *`,
            [id, hashSecret(credential), d.credential_hash, iso(now() + config.device.rotateGraceMs), hashSecret(publishKey), at]);
        return { device: updated, credential, publish_key: publishKey };
    }
    async function revokeDevice(id) {
        const d = await getDevice(id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        const at = iso(now());
        const updated = await db.maybe('UPDATE devices SET revoked_at = $2, credential_prev_hash = NULL, prev_valid_until = NULL, updated_at = $2 WHERE id = $1 RETURNING *', [id, at]);
        return updated;
    }
    async function touchSeen(id) { await db.query('UPDATE devices SET last_seen = $2 WHERE id = $1', [id, iso(now())]); }

    async function setOnline(device, online) {
        const robotIds = json(device.robot_ids, []);
        const at = iso(now());
        await db.tx(async (t) => {
            if (online) await t.query('UPDATE devices SET last_seen = $2 WHERE id = $1', [device.id, at]);
            for (const robotId of robotIds) {
                await emit(t, online ? 'bot.robot.online' : 'bot.robot.offline', { type: 'robot', id: robotId },
                    { robot_id: robotId, device_id: device.id });
            }
        });
    }

    // ── E-stop (ADR-043 decision 6) ───────────────────────────────────────────────────────────────
    async function setEstop(robotId, { latched, by, principalKind = 'device' }) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        const at = iso(now());
        const updated = await db.tx(async (t) => {
            const row = await t.maybe('UPDATE robots SET estop_latched = $2, estop_by = $3, estop_at = CASE WHEN $2 THEN $4::timestamptz ELSE NULL END, updated_at = $4 WHERE id = $1 RETURNING *',
                [robotId, latched, latched ? (by || null) : null, at]);
            await emit(t, latched ? 'bot.estop.set' : 'bot.estop.cleared', { type: 'robot', id: robotId },
                { robot_id: robotId, by: latched ? (by || null) : null, principal_kind: principalKind });
            return row;
        });
        return updated;
    }
    async function clearEstop(robotId, owner) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (robot.owner_subject !== owner) fail(403, 'bot.forbidden', 'only the owner clears the e-stop');
        return setEstop(robotId, { latched: false, by: owner, principalKind: 'user' });
    }

    // ── Turn queue (ADR-043 decision 8) ───────────────────────────────────────────────────────────
    const turnMs = (robot) => { const l = json(robot.limits, {}); return Number(l.turn_ms) > 0 ? Number(l.turn_ms) : config.control.queueTurnMs; };
    const turnBudget = (robot) => { const l = json(robot.limits, {}); return Number(l.turn_budget) > 0 ? Number(l.turn_budget) : config.control.queueTurnBudget; };
    /** The active turn for a robot, expiring it and promoting the oldest waiting row when it has ended. */
    async function currentTurn(robotId, q = db) {
        const robot = await q.maybe('SELECT * FROM robots WHERE id = $1', [robotId]);
        if (!robot) return null;
        let active = await q.maybe(`SELECT * FROM robot_queue WHERE robot_id = $1 AND state = 'active'`, [robotId]);
        if (active && new Date(active.turn_ends_at).getTime() > now()) return active;
        if (active) await q.query(`UPDATE robot_queue SET state = 'done' WHERE robot_id = $1 AND subject = $2`, [robotId, active.subject]);
        const next = await q.maybe(`SELECT * FROM robot_queue WHERE robot_id = $1 AND state = 'waiting' ORDER BY joined_at LIMIT 1 FOR UPDATE`, [robotId]);
        if (!next) return null;
        const at = now();
        await q.query(`UPDATE robot_queue SET state = 'active', turn_started_at = $3, turn_ends_at = $4, commands_used = 0 WHERE robot_id = $1 AND subject = $2`,
            [robotId, next.subject, iso(at), iso(at + turnMs(robot))]);
        return { ...next, state: 'active', turn_started_at: iso(at), turn_ends_at: iso(at + turnMs(robot)), commands_used: 0 };
    }
    async function joinQueue(robotId, subject) {
        const at = iso(now());
        await db.query(`INSERT INTO robot_queue (robot_id, subject, joined_at, state) VALUES ($1, $2, $3, 'waiting')
            ON CONFLICT (robot_id, subject) DO NOTHING`, [robotId, subject, at]);
        await currentTurn(robotId);
        return queueState(robotId, subject);
    }
    async function queueState(robotId, subject) {
        const robot = await getRobot(robotId);
        if (!robot) return null;
        const active = await currentTurn(robotId);
        const mine = await db.maybe('SELECT * FROM robot_queue WHERE robot_id = $1 AND subject = $2', [robotId, subject]);
        let position = null;
        if (mine && mine.state === 'waiting') {
            const n = await db.value(`SELECT count(*)::int FROM robot_queue WHERE robot_id = $1 AND state = 'waiting' AND joined_at <= $2`, [robotId, mine.joined_at]);
            position = Number(n);
        }
        return {
            robot_id: robotId, subject: subject || null, active: !!(active && active.subject === subject),
            turn_ends_at: active ? iso(new Date(active.turn_ends_at).getTime()) : null,
            turn_subject: active ? active.subject : null,
            position: active && active.subject === subject ? 0 : position,
            budget: turnBudget(robot),
            used: active && active.subject === subject ? active.commands_used : 0,
        };
    }
    async function consumeTurn(robotId, subject) {
        const active = await currentTurn(robotId);
        if (!active || active.subject !== subject) return { ok: false, code: 'bot.not_your_turn' };
        const robot = await getRobot(robotId);
        if (active.commands_used >= turnBudget(robot)) return { ok: false, code: 'bot.turn_budget' };
        await db.query(`UPDATE robot_queue SET commands_used = commands_used + 1 WHERE robot_id = $1 AND subject = $2`, [robotId, subject]);
        return { ok: true };
    }
    /** Expire ended turns and promote the next waiting person; returns the robots that changed. */
    async function sweepQueues() {
        const changed = new Set();
        const ended = await db.many(`SELECT DISTINCT robot_id FROM robot_queue WHERE state = 'active' AND turn_ends_at <= $1`, [iso(now())]);
        for (const r of ended) { await currentTurn(r.robot_id); changed.add(r.robot_id); }
        const idle = await db.many(`SELECT DISTINCT q.robot_id FROM robot_queue q WHERE q.state = 'waiting'
            AND NOT EXISTS (SELECT 1 FROM robot_queue a WHERE a.robot_id = q.robot_id AND a.state = 'active')`);
        for (const r of idle) { await currentTurn(r.robot_id); changed.add(r.robot_id); }
        return [...changed];
    }

    // ── Audit (ADR-043 decision 9) ────────────────────────────────────────────────────────────────
    async function auditCommand(entry) {
        const at = iso(entry.at != null ? entry.at : now());
        const row = await db.maybe(
            `INSERT INTO command_audit (robot_id, device_id, operator_subject, operator_kind, role, kind, value, result, reason, latency_ms, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING id, at`,
            [entry.robotId, entry.deviceId || null, entry.subject || null, entry.operatorKind || null, entry.role || null, entry.kind || null,
                JSON.stringify(entry.value || {}), entry.result, entry.reason || null, Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : null, at]);
        if (entry.result === 'refused') {
            await db.tx(async (t) => emit(t, 'bot.command.refused', { type: 'robot', id: entry.robotId },
                { robot_id: entry.robotId, kind: entry.kind || null, reason: entry.reason || null, role: entry.role || null }));
        }
        return row;
    }
    const mapAudit = (r) => ({
        id: Number(r.id), robot_id: r.robot_id, device_id: r.device_id, operator_subject: r.operator_subject,
        operator_kind: r.operator_kind, role: r.role, kind: r.kind, value: json(r.value, {}), result: r.result,
        reason: r.reason, latency_ms: r.latency_ms, at: iso(new Date(r.at).getTime()),
    });
    async function listAudit(robotId, { limit = 50 } = {}) {
        const rows = await db.many('SELECT * FROM command_audit WHERE robot_id = $1 ORDER BY id DESC LIMIT $2', [robotId, Math.min(200, Math.max(1, limit))]);
        return rows.map(mapAudit);
    }
    /** One page of the owner's audit, newest first, keyset on id (before = the last id seen). */
    async function listAuditPage(robotId, { before = null, limit = 50 } = {}) {
        const n = Math.min(200, Math.max(1, limit));
        const rows = before
            ? await db.many('SELECT * FROM command_audit WHERE robot_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3', [robotId, before, n])
            : await db.many('SELECT * FROM command_audit WHERE robot_id = $1 ORDER BY id DESC LIMIT $2', [robotId, n]);
        return rows.map(mapAudit);
    }
    async function pruneAudit(days = 30) {
        return db.exec('DELETE FROM command_audit WHERE at < $1', [iso(now() - days * 24 * 3600 * 1000)]);
    }

    // ── The control gate (ADR-043 decisions 5, 6, 8) ──────────────────────────────────────────────
    const effectiveLimits = (robot, profile) => {
        const rl = json(robot.limits, {});
        const pl = (profile && profile.limits) || {};
        const maxSpeed = rl.max_speed != null ? Math.min(rl.max_speed, pl.max_speed) : pl.max_speed;
        const maxTurn = rl.max_turn != null ? Math.min(rl.max_turn, pl.max_turn) : pl.max_turn;
        const maxCommandMs = rl.max_command_ms != null ? Math.min(rl.max_command_ms, pl.max_command_ms) : pl.max_command_ms;
        const cooldownMs = rl.cooldown_ms != null ? rl.cooldown_ms : config.control.cooldownMs;
        return { maxSpeed, maxTurn, maxCommandMs, cooldownMs };
    };
    // Cooldown is measured from the last command sent (not from an acknowledgement), per operator and
    // kind; the owner is never cooldowned. Bounded so a flood of subjects cannot grow it without end.
    const lastCommandAt = new Map();
    const markCooldown = (robotId, subject, kind) => {
        lastCommandAt.set(`${robotId}|${subject}|${kind}`, now());
        if (lastCommandAt.size > 4096) lastCommandAt.delete(lastCommandAt.keys().next().value);
    };

    const allowedFor = (robot, role) => {
        const rl = json(robot.limits, {});
        const fromOwner = rl.allow && Array.isArray(rl.allow[role]) ? rl.allow[role] : null;
        return fromOwner || DEFAULT_ALLOW[role] || [];
    };

    /** Clamp a command value to the profile/owner limits; returns the value to send and its audit summary. */
    function clampValue(kind, value, eff, profile) {
        const v = value && typeof value === 'object' ? value : {};
        if (kind === 'drive') {
            const out = { throttle: clampNum(v.throttle != null ? v.throttle : v.speed, -eff.maxSpeed, eff.maxSpeed, 0), steer: clampNum(v.steer != null ? v.steer : v.turn, -eff.maxTurn, eff.maxTurn, 0) };
            if (v.variant) out.variant = String(v.variant).slice(0, 16);
            return out;
        }
        if (kind === 'actuator') {
            const servo = String(v.servo || '').slice(0, 24);
            return { servo, angle: clampNum(v.angle, -1, 1, 0) };
        }
        if (kind === 'ptz') return { pan: clampNum(v.pan, -1, 1, 0), tilt: clampNum(v.tilt, -1, 1, 0), zoom: clampNum(v.zoom, -1, 1, 0) };
        if (kind === 'say') {
            const t = text(v.text, 'text', 200);
            if (!t) fail(422, 'bot.invalid_input', 'say needs text');
            return { text: t };
        }
        if (kind === 'display') {
            if (v.animation != null) {
                const anims = profile && profile.mapping && Array.isArray(profile.mapping.animations) ? profile.mapping.animations : null;
                const anim = storable(v.animation).slice(0, 64);
                if (anims && !anims.includes(anim)) fail(422, 'bot.unknown_animation', 'that animation is not in the profile');
                return { animation: anim };
            }
            const t = text(v.text, 'text', 80);
            if (!t) fail(422, 'bot.invalid_input', 'display needs text or animation');
            return { text: t };
        }
        return {};
    }

    /**
     * Decide a command. Returns { ok:true, robot, profile, role, kind, value, deadlineMs } or
     * { ok:false, code, reason, robot?, role? }. `online` is the live socket state the hub knows.
     */
    async function prepare({ robotId, principal, kind, value = {}, online = false, requestedMs = null }) {
        const robot = await getRobot(robotId);
        if (!robot) return { ok: false, code: 'bot.robot_not_found', reason: 'no such robot' };
        const profileRow = await getProfile(db, robot.profile_id, robot.profile_version);
        const profile = profileRow ? profileRow.profile : null;
        if (!KINDS.has(kind)) return { ok: false, code: 'bot.unknown_command', reason: `unknown command kind ${kind}`, robot };
        if (robot.estop_latched) return { ok: false, code: 'bot.estop_latched', reason: 'the e-stop is latched; only the owner can clear it', robot };

        const subject = principal && principal.kind !== 'device' ? principal.subject : null;
        let role = await roleOf(robotId, subject);
        if (!role && robot.access_policy === 'queue' && subject) {
            const turn = await currentTurn(robotId);
            if (turn && turn.subject === subject) role = 'queue';
        }
        if (!role) {
            return { ok: false, code: subject ? 'bot.not_an_operator' : 'bot.sign_in', reason: subject ? 'you are not an operator on this robot' : 'sign in to control a robot', robot };
        }
        if (role === 'viewer') {
            if (robot.access_policy === 'queue') role = 'queue';
            else return { ok: false, code: 'bot.read_only', reason: 'you are a viewer on this robot', robot, role };
        }
        const allow = allowedFor(robot, role);
        if (!allow.includes(kind)) return { ok: false, code: 'bot.command_not_allowed', reason: `${kind} is not allowed for ${role}`, robot, role };
        if (!online) return { ok: false, code: 'bot.device_offline', reason: 'the device is offline; commands are never queued', robot, role };

        const eff = effectiveLimits(robot, profile);
        if (eff.cooldownMs > 0 && role !== 'owner') {
            const last = lastCommandAt.get(`${robotId}|${subject}|${kind}`);
            if (last && now() - last < eff.cooldownMs) {
                return { ok: false, code: 'bot.cooldown', reason: `wait ${eff.cooldownMs} ms between ${kind} commands`, robot, role };
            }
        }
        if (role === 'queue') {
            const budget = await consumeTurn(robotId, subject);
            if (!budget.ok) return { ok: false, code: budget.code, reason: budget.code === 'bot.turn_budget' ? 'your turn budget is spent' : 'it is not your turn', robot, role };
        }
        let clamped;
        try { clamped = clampValue(kind, value, eff, profile); } catch (e) { return { ok: false, code: e.code || 'bot.invalid_input', reason: e.detail || e.message, robot, role }; }
        if (eff.cooldownMs > 0 && role !== 'owner') markCooldown(robotId, subject, kind);
        const deadlineMs = MOTION.has(kind)
            ? now() + clampNum(requestedMs != null ? requestedMs : eff.maxCommandMs, 1, eff.maxCommandMs, eff.maxCommandMs)
            : null;
        return { ok: true, robot, profile, role, kind, value: clamped, deadlineMs, limits: eff };
    }

    return {
        db, now, config, log, outbox, link,
        present: { robot: presentRobot, device: presentDevice },
        robots: { create: createRobot, list: listRobots, get: getRobot, update: updateRobot, remove: removeRobot },
        members: { roleOf, add: addOperator, remove: removeOperator, list: listOperators },
        pairing: { create: createPairingCode, redeem, prune: prunePairingCodes, installerCommand },
        devices: { byCredential, get: getDevice, listForRobot: listDevicesForRobot, rotate: rotateDevice, revoke: revokeDevice, touchSeen, setOnline },
        estop: { set: setEstop, clear: clearEstop },
        queue: { join: joinQueue, state: queueState, currentTurn, consume: consumeTurn, sweep: sweepQueues },
        audit: { record: auditCommand, list: listAudit, listPage: listAuditPage, prune: pruneAudit },
        control: { prepare, allowedFor, effectiveLimits, DEFAULT_ALLOW, KINDS },
    };
}

module.exports = { createDomain, DEFAULT_ALLOW, KINDS, normaliseCode, formatCode, newCode, isCodeShape };
