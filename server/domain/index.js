'use strict';

/**
 * OpenVibe.Bot domain (ADR-043): robots, devices, pairing, operators, the command audit, the timed turn
 * queue and the control gate. Everything here is database-backed and testable without a socket; the
 * realtime layer (server/realtime.js) owns the live connections and calls into this.
 *
 * A robot (rob_…) is what the owner shares; a device (dev_…) is a running agent attached to one or more
 * robots, holding one rotatable, revocable credential (32 random bytes, stored hashed, shown once). The
 * gate applies, in order: the robot exists, its profile takes the command kind, the e-stop is clear, the
 * caller's role, the per-role command allowlist, the access policy (private/invite: owner + operators;
 * queue: the active turn holder too), the device being online (commands are never queued), cooldowns and
 * the per-turn budget, and finally builds the value from the profile's `commands` (names, shapes, ranges,
 * clamped by the owner's limits). `halt` passes the e-stop, the allowlist, cooldowns and the budget: a
 * stop is never refused to someone who may drive. Every decision — allowed or refused — is audited.
 */
const {
    BotError, fail, prefixedId, iso, token, hashSecret, secretEquals, json, text, storable, isRobotId,
} = require('../util');
const { getProfile, validateProfile, reservedKeyReason } = require('../profiles');
const { ENVELOPE } = require('../events/outbox');

const DEFAULT_ALLOW = {
    owner: ['drive', 'actuator', 'ptz', 'say', 'display', 'button', 'point', 'halt'],
    operator: ['drive', 'actuator', 'ptz', 'say', 'display', 'button', 'point', 'halt'],
    queue: ['drive', 'button', 'point', 'halt'],
};
const KINDS = new Set(['drive', 'actuator', 'ptz', 'say', 'display', 'button', 'point', 'halt']);
const MOTION = new Set(['drive', 'actuator', 'ptz']);
const CONTROL_ROLES = new Set(['owner', 'operator', 'queue']);
// Drive axes the owner's max_turn caps; every other drive axis is capped by max_speed.
const TURN_AXES = new Set(['steer', 'rotation']);
// The older drive names, still read for the axis they stand for.
const AXIS_ALIASES = { throttle: 'speed', steer: 'turn' };
// A display image rides a 64 KB control frame, so its base64 stays well under that.
const MAX_IMAGE_B64 = 48 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

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

// The installer driver a robot's profile needs (OpenVibe.Node install/install.sh --driver). Simulated,
// camera and unknown profiles get `none`, the dry-run plugin, which is also the installer's default.
const DRIVER_BY_PROFILE = Object.freeze({ 'adeept.adr036': 'adeept', 'adeept.adr036.mecanum': 'adeept-mecanum', cozmo: 'cozmo' });
const driverForProfile = (profileId) => (Object.hasOwn(DRIVER_BY_PROFILE, profileId) ? DRIVER_BY_PROFILE[profileId] : 'none');

const clampNum = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// Scientific pitch: 'A4' is 440 Hz; a sharp (#) or flat (b) after the letter.
const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function noteToHz(note) {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(note));
    if (!m) return null;
    const semis = NOTE_SEMITONES[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 440 * 2 ** ((12 * (Number(m[3]) + 1) + semis - 69) / 12);
}


function createDomain({ db, config, outbox, link = null, nodes = null, openre = null, now = () => Date.now(), log = console }) {
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

    /** A pairing/rotation answer's video fields: the publish key and its WHIP URL (once), or why there is no key. */
    const presentVideo = (r) => (r.publish_key
        ? { publish_key: r.publish_key, ...(r.whip_url ? { whip_url: r.whip_url } : {}) }
        : { video: r.video || 'not_configured' });

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
        const before = await roleOf(robotId, subject);
        await db.query(
            `INSERT INTO robot_operators (robot_id, subject, role, added_by, created_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (robot_id, subject) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
            [robotId, subject, role, addedBy || null, iso(now())]);
        if (before !== role) membershipChanged(robotId, subject, 'your role on this robot changed');
    }
    async function removeOperator(robotId, subject) {
        const before = await roleOf(robotId, subject);
        await db.query(`DELETE FROM robot_operators WHERE robot_id = $1 AND subject = $2 AND role <> 'owner'`, [robotId, subject]);
        if (before && before !== 'owner') membershipChanged(robotId, subject, 'you were removed from this robot');
    }
    /**
     * A membership change: the person's live /control sockets on the robot are dropped (so their join
     * re-derives the role) and every panel of the robot is re-broadcast. The one place both the web form
     * routes and the v1 API reach, since both change membership through addOperator/removeOperator.
     */
    function membershipChanged(robotId, subject, reason) {
        if (link && link.dropSubject) link.dropSubject(robotId, subject, reason);
        if (link && link.broadcast) link.broadcast(robotId);
    }

    // ── Robots ────────────────────────────────────────────────────────────────────────────────────
    async function getRobot(id) {
        return db.maybe('SELECT * FROM robots WHERE id = $1', [id]);
    }
    async function listRobots(owner) {
        return db.many('SELECT * FROM robots WHERE owner_subject = $1 ORDER BY created_at DESC', [owner]);
    }
    async function createRobot({ owner, name, profile_id, access_policy = 'private', limits = {}, installerUrl }) {
        if (String(profile_id).startsWith('local.')) fail(422, 'bot.unknown_profile', 'choose a catalogue profile');
        const profile = await getProfile(db, profile_id);
        if (!profile) fail(422, 'bot.unknown_profile', `no profile ${profile_id}`);
        const cleanName = text(name, 'name', 80);
        if (!cleanName) fail(422, 'bot.invalid_input', 'name is required');
        if (!['private', 'invite', 'queue'].includes(access_policy)) fail(422, 'bot.invalid_policy', 'access_policy must be private, invite or queue');
        const id = prefixedId('rob', now());
        const at = iso(now());
        // A Network-minted code comes first, so a Network that does not answer leaves no robot behind.
        const minted = networkPairing() ? await mintOnNetwork(id, owner, installerUrl, driverForProfile(profile.id)) : null;
        const created = await db.tx(async (t) => {
            await t.query(`INSERT INTO robots (id, owner_subject, name, profile_id, profile_version, access_policy, limits, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
                [id, owner, cleanName, profile.id, profile.version, access_policy, JSON.stringify(cleanLimits(limits)), at]);
            await t.query(`INSERT INTO robot_operators (robot_id, subject, role, added_by, created_at) VALUES ($1, $2, 'owner', $2, $3)`, [id, owner, at]);
            return t.maybe('SELECT * FROM robots WHERE id = $1', [id]);
        });
        const pairing = minted || await createPairingCode(id, owner, installerUrl, created);
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
    async function localProfile(robotId) {
        return db.maybe('SELECT source_profile_id, profile FROM robot_profiles WHERE robot_id = $1', [robotId]);
    }
    async function saveLocalProfile(robotId, actor, { buttons, point }) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (!actor || actor.subject !== robot.owner_subject) fail(403, 'bot.forbidden', 'only the owner may edit buttons');
        const local = await localProfile(robotId);
        const sourceId = local ? local.source_profile_id : robot.profile_id;
        const source = await getProfile(db, sourceId);
        if (!source) fail(422, 'bot.unknown_profile', 'catalogue profile is missing');
        for (const [name, b] of Object.entries(buttons || {})) {
            const why = b.key && reservedKeyReason(b.key, source.profile);
            if (why) fail(422, 'bot.invalid_input', `${b.key}: ${why}; give ${name} another key`);
        }
        // Profile IDs are lowercase by contract; robot ULIDs are uppercase.
        const id = `local.${robotId.toLowerCase()}`;
        const base = source.profile;
        const commands = { ...base.commands };
        delete commands.button; delete commands.point;
        const widgets = base.widgets.filter((w) => w.type !== 'buttons' && w.type !== 'video_click');
        if (buttons && Object.keys(buttons).length) {
            commands.button = { names: buttons };
            widgets.push({ type: 'buttons', command: { kind: 'button' } });
        }
        if (point) {
            commands.point = point.cooldown_ms == null ? {} : { cooldown_ms: point.cooldown_ms };
            if (!widgets.some((w) => w.type === 'camera')) widgets.push({ type: 'camera' });
            widgets.push({ type: 'video_click', command: { kind: 'point' } });
        }
        let profile;
        try { profile = validateProfile({ ...base, id, version: 1, name: `${robot.name} controls`, commands, widgets }); }
        catch (e) { if (e.code === 'bot.profile_invalid') fail(422, 'bot.profile_invalid', e.detail || e.message); throw e; }
        await db.tx(async (t) => {
            await t.query(`INSERT INTO robot_profiles (id, version, profile, created_at, robot_id, source_profile_id)
                VALUES ($1, 1, $2::jsonb, $3, $4, $5)
                ON CONFLICT (id, version) DO UPDATE SET profile = EXCLUDED.profile`,
            [id, JSON.stringify(profile), iso(now()), robotId, sourceId]);
            await t.query('UPDATE robots SET profile_id = $2, profile_version = 1, updated_at = $3 WHERE id = $1', [robotId, id, iso(now())]);
        });
        await auditCommand({ robotId, subject: actor.subject, operatorKind: actor.kind, role: 'owner', kind: 'profile.local',
            value: { buttons: Object.keys(buttons || {}), point: !!point }, result: 'ack' });
        if (link && link.refreshConfig) await link.refreshConfig(robotId);
        if (link && link.broadcast) link.broadcast(robotId);
        return profile;
    }
    async function useCatalogueProfile(robotId, actor) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (!actor || actor.subject !== robot.owner_subject) fail(403, 'bot.forbidden', 'only the owner may change the profile');
        const local = await localProfile(robotId);
        if (!local || robot.profile_id !== `local.${robotId.toLowerCase()}`) fail(422, 'bot.invalid_profile', 'this robot is using its catalogue profile');
        const source = await getProfile(db, local.source_profile_id);
        if (!source) fail(422, 'bot.unknown_profile', 'catalogue profile is missing');
        await db.query('UPDATE robots SET profile_id = $2, profile_version = $3, updated_at = $4 WHERE id = $1', [robotId, source.id, source.version, iso(now())]);
        await auditCommand({ robotId, subject: actor.subject, operatorKind: actor.kind, role: 'owner', kind: 'profile.catalogue',
            value: { profile_id: source.id }, result: 'ack' });
        if (link && link.refreshConfig) await link.refreshConfig(robotId);
        if (link && link.broadcast) link.broadcast(robotId);
        return source.profile;
    }
    /** Opt a robot in or out of anonymous read-only embedding (the owner check is the caller's; no event). */
    async function setEmbedPublic(id, value) {
        await db.query('UPDATE robots SET embed_public = $2, updated_at = $3 WHERE id = $1', [id, !!value, iso(now())]);
        return getRobot(id);
    }
    /**
     * Remove a robot. Its OpenRestream stream's key is revoked first (rotated with no grace, its sessions ended), so
     * nothing publishes as the robot afterwards; an OpenRestream that refuses or does not answer leaves the robot in
     * place for the owner to retry. The stream is archived when nothing was live (OpenRestream refuses a live one).
     */
    async function removeRobot(id) {
        const robot = await getRobot(id);
        if (robot && robot.openre_stream_id && !openre) log.warn(`[Bot] robot ${id} removed with OpenRestream stream ${robot.openre_stream_id} left as it is: OpenRestream is not configured`);
        if (robot && robot.openre_stream_id && openre) {
            const ended = await openre.rotate(robot.openre_stream_id, robot.owner_subject, { grace_seconds: 0, end_sessions: true });
            if (ended && !ended.sessions_ending) {
                await openre.archive(robot.openre_stream_id, robot.owner_subject)
                    .catch((e) => log.warn(`[Bot] OpenRestream stream ${robot.openre_stream_id} of removed robot ${id} not archived: ${e.message}`));
            }
        }
        await db.query('DELETE FROM robots WHERE id = $1', [id]);
    }

    // ── Pairing (ADR-043 decision 2) ──────────────────────────────────────────────────────────────
    const networkPairing = () => config.pairing.authority === 'network';
    async function createPairingCode(robotId, createdBy, installerUrl, robotRow = null) {
        const robot = robotRow || await getRobot(robotId);
        const local = robot && robot.profile_id.startsWith('local.') ? await localProfile(robotId) : null;
        const driver = driverForProfile(local ? local.source_profile_id : robot && robot.profile_id);
        if (networkPairing()) return mintOnNetwork(robotId, robot.owner_subject, installerUrl, driver);
        const code = newCode();
        const at = iso(now());
        const expires = iso(now() + config.pairing.ttlMs);
        // One live code per robot: an older unused one is replaced.
        await db.tx(async (t) => {
            await t.query('DELETE FROM pairing_codes WHERE robot_id = $1 AND used_at IS NULL', [robotId]);
            await t.query('INSERT INTO pairing_codes (id, robot_id, code_hash, created_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [prefixedId('pair', now()), robotId, hashSecret(code), createdBy || null, expires, at]);
        });
        return { code: formatCode(code), expires_at: expires, installer: installerCommand(robotId, formatCode(code), installerUrl, driver) };
    }
    /** ` --driver <kind>` for a profile that needs a real driver; nothing for `none` (the installer's default). */
    const driverFlag = (driver) => (driver && driver !== 'none' ? ` --driver ${driver}` : '');
    function installerCommand(robotId, code, installerUrl, driver = 'none') {
        const url = installerUrl || config.installer.scriptUrl;
        return `curl -fsSL ${url} | sh -s -- --robot ${robotId} --code ${code}${driverFlag(driver)}`;
    }
    /**
     * BOT_PAIRING_AUTHORITY=network (plan T15 B2): Network mints the code for the robot's owner (POST
     * /internal/node-pairings, ref = the robot) and Bot stores none. The machine redeems it on Network and
     * reaches Bot with a node token (bindNode). A Network that does not answer is 503 bot.network_unavailable.
     */
    async function mintOnNetwork(robotId, ownerSubject, installerUrl, driver = 'none') {
        if (!nodes) fail(503, 'bot.network_unavailable', 'Network pairing is not configured here');
        const p = await nodes.pair({ subject: ownerSubject, ref: robotId });
        if (!p || typeof p.pairing_id !== 'string' || typeof p.code !== 'string') fail(503, 'bot.network_unavailable', 'Network answered no pairing code');
        const url = installerUrl || config.installer.scriptUrl;
        return {
            code: p.code, expires_at: p.expires_at, pairing_id: p.pairing_id,
            installer: `curl -fsSL ${url} | sh -s -- --network ${config.network.url} --pairing ${p.pairing_id} --code ${p.code}${driverFlag(driver)}`,
        };
    }
    /**
     * Redeem a pairing code. `robot` (from the installer command/QR) attributes a wrong code to that
     * robot's live code and counts the try (5 end it); without it the code is matched by hash across
     * every live code. On success the credential and the publish key are returned once, never stored in
     * the clear. The publish key is a new ingest key of the robot's OpenRestream stream (newStreamKey), asked for
     * only once the code is good: an OpenRestream that refuses or does not answer fails the pairing and leaves the
     * code unused, with no device. Without OpenRestream configured the device pairs without video.
     */
    async function redeem({ robot = null, code, agent_version = null, device_kind = 'onboard', drivers = [], capabilities = {}, name = null }) {
        if (networkPairing()) fail(410, 'bot.pairing_moved', `pairing moved to OpenVibe.Network: pair this machine on ${config.network.url}`);
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
            const deviceDisplayName = text(name, 'name', 80);
            const issued = await newStreamKey(await t.maybe('SELECT * FROM robots WHERE id = $1', [row.robot_id]));
            await t.query('UPDATE pairing_codes SET used_at = $2 WHERE id = $1', [row.id, at]);
            const deviceId = prefixedId('dev', now());
            const credential = token(32);
            if (issued) await keepStream(t, row.robot_id, issued.streamId, deviceId);
            const device = await t.maybe(
                `INSERT INTO devices (id, robot_ids, name, kind, agent_version, drivers, capabilities, credential_hash, publish_key_hint, created_at, updated_at)
                 VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $10) RETURNING *`,
                [deviceId, JSON.stringify([row.robot_id]), deviceDisplayName, device_kind, storable(agent_version || ''), JSON.stringify(drivers || []), JSON.stringify(capabilities || {}), hashSecret(credential), issued ? issued.hint : null, at]);
            return { device, credential, issued, robot_id: row.robot_id };
        });
        if (result.error) fail(result.error[0], result.error[1], result.error[2]);
        const profile = await getProfile(db, (await getRobot(result.robot_id)).profile_id);
        return { device: result.device, credential: result.credential, ...videoKey(result.issued), profile: profile ? profile.profile : null };
    }
    // ── Video: the robot's OpenRestream stream (T15 R5) ─────────────────────────────────────────────────
    // OpenRestream's WHIP worker admits only its own ingest keys, so the publish key is always one OpenRestream issued for
    // the robot's stream (external ref bot:robot:<id>); Bot keeps the stream id and the key's hint, never the
    // key. One stream per robot, so the device given the newest key is the robot's publisher.
    /**
     * A new ingest key for the robot's OpenRestream stream → { streamId, key, hint }, or null when OpenRestream is not
     * configured. The stored stream is rotated (graceSeconds: how long the previous key keeps publishing);
     * with none stored, or one OpenRestream no longer has, the stream is found by its external ref and rotated, or
     * else created with its first key. Throws OpenRestream's refusal or silence (502/503) and writes nothing here.
     */
    async function newStreamKey(robot, graceSeconds = 0) {
        if (!openre || !robot) return null;
        const owner = robot.owner_subject;
        const rotated = async (streamId) => {
            const r = await openre.rotate(streamId, owner, { grace_seconds: graceSeconds, end_sessions: false });
            return r && { streamId, key: r.key };
        };
        let out = robot.openre_stream_id ? await rotated(robot.openre_stream_id) : null;
        if (!out) {
            const found = await openre.find(`bot:robot:${robot.id}`, owner);
            if (found && found.id) out = await rotated(found.id);
        }
        if (!out) {
            const created = await openre.create({
                title: robot.name, protocols: ['webrtc'], recording_mode: 'none', recording_visibility: 'unlisted', playback_visibility: 'unlisted',
                external_refs: [{ service: 'bot', type: 'robot', id: robot.id, label: robot.name }],
            }, owner);
            out = created && created.stream && { streamId: created.stream.id, key: created.key };
        }
        if (!out || typeof out.streamId !== 'string' || !out.key || typeof out.key.key !== 'string' || !out.key.key) {
            fail(503, 'bot.openre_unavailable', 'OpenRestream answered no ingest key for the robot');
        }
        return { streamId: out.streamId, key: out.key.key, hint: typeof out.key.hint === 'string' ? out.key.hint.slice(0, 16) : null };
    }
    /** Record the robot's stream and that `deviceId` now holds its key: other devices' keys are retired. */
    async function keepStream(t, robotId, streamId, deviceId) {
        await t.query('UPDATE robots SET openre_stream_id = $2 WHERE id = $1 AND openre_stream_id IS DISTINCT FROM $2', [robotId, streamId]);
        await t.query('UPDATE devices SET publish_key_hint = NULL WHERE robot_ids @> $1::jsonb AND id <> $2 AND publish_key_hint IS NOT NULL',
            [JSON.stringify([robotId]), deviceId]);
    }
    /** The answer fields for an issued key: publish_key and whip_url, or video: 'not_configured' without OpenRestream. */
    function videoKey(issued) {
        if (!issued) return { video: 'not_configured' };
        const whUrl = whipUrl(issued.key);
        return { publish_key: issued.key, ...(whUrl ? { whip_url: whUrl } : {}) };
    }
    /**
     * Where the device publishes its camera: OpenRestream's WHIP ingest (`POST <base>/<key>`, RFC 9725) with
     * this device's publish key as the stream key. The key must be one OpenRestream admits, an ingest key OpenRestream
     * issued for the robot's stream (newStreamKey): OpenRestream refuses any other. It carries the key, so it is
     * shown once, with the key.
     * The base's trailing slashes are trimmed; with no base (BOT_WHIP_BASE unset or empty) it is null, and
     * the caller omits the field entirely rather than sending null or an empty string.
     */
    function whipUrl(publishKey) {
        const base = config.media && config.media.whipBase;
        const clean = base ? String(base).replace(/\/+$/, '') : '';
        return clean && publishKey ? `${clean}/${encodeURIComponent(publishKey)}` : null;
    }
    // ── Streaming toggles (the owner's OpenRestream stream is the single source of truth) ────────────────
    // Bot stores no copy: `media` is the stream's recording_mode ('vod' on, 'none' off) and `live` its
    // mirror_to_live. `live` is the owner's consent, but OpenRestream mirrors a session into their Live channel
    // only once Live plays OpenRestream streams for that channel, so the answer always carries `effective`.
    const LIVE_EFFECTIVE = 'when your Live channel plays OpenRestream streams';
    const streamingState = (robot, stream) => ({
        available: true,
        media: { on: stream.recording_mode === 'vod' },
        live: { on: !!stream.mirror_to_live, effective: LIVE_EFFECTIVE },
        stream_id: robot.openre_stream_id,
    });
    /** The offline shape: nothing to read, with why — OpenRestream unset, no stream yet, or OpenRestream lost it. */
    const streamingUnavailable = (robot, reason) => ({
        available: false, reason, stream_id: robot.openre_stream_id || null,
        media: { on: false }, live: { on: false, effective: LIVE_EFFECTIVE },
    });
    /**
     * The robot's streaming toggles, read from its OpenRestream stream. `available: false` with reason
     * 'not_configured' (OpenRestream unset), 'not_paired' (the robot has no stream yet) or 'stream_missing'
     * (OpenRestream answers 404).
     */
    async function streaming(robotId) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (!openre) return streamingUnavailable(robot, 'not_configured');
        if (!robot.openre_stream_id) return streamingUnavailable(robot, 'not_paired');
        const stream = await openre.get(robot.openre_stream_id, robot.owner_subject);
        if (!stream) return streamingUnavailable(robot, 'stream_missing');
        return streamingState(robot, stream);
    }
    /**
     * Turn `media` (recording_mode 'vod'/'none') or `live` (mirror_to_live) on or off on the robot's OpenRestream
     * stream, and audit the change once (kind streaming.media/streaming.live, value { on }). Idempotent:
     * setting the value it already has answers the state and writes no audit row.
     */
    async function setStreaming(robotId, actor, { to, on } = {}) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        if (!['media', 'live'].includes(to) || typeof on !== 'boolean') fail(422, 'bot.invalid_streaming', "to must be 'media' or 'live' and on must be true or false");
        if (!openre) fail(409, 'bot.openre_not_configured', 'OpenRestream is not configured here');
        if (!robot.openre_stream_id) fail(409, 'bot.not_paired', 'the robot has no OpenRestream stream yet; pair a device first');
        const current = await openre.get(robot.openre_stream_id, robot.owner_subject);
        if (!current) fail(409, 'bot.not_paired', 'OpenRestream no longer has the robot\'s stream; pair a device again');
        const already = to === 'media' ? current.recording_mode === 'vod' : !!current.mirror_to_live;
        if (already === on) return streamingState(robot, current);
        const fields = to === 'media' ? { recording_mode: on ? 'vod' : 'none' } : { mirror_to_live: on };
        const updated = await openre.update(robot.openre_stream_id, fields, robot.owner_subject);
        if (!updated) fail(409, 'bot.not_paired', 'OpenRestream no longer has the robot\'s stream; pair a device again');
        await auditCommand({
            robotId, subject: actor && actor.subject, operatorKind: actor && actor.kind, role: 'owner',
            kind: `streaming.${to}`, value: { on }, result: 'ack',
        });
        return streamingState(robot, updated);
    }
    // ── Panel video: the robot's live OpenRestream WebRTC session (T15) ──────────────────────────────────
    /**
     * The viewer signaling URL of the robot's open WebRTC session, or null. The session list names the
     * stream's open session — only ever through the robot owner's OpenRestream view — and a WebRTC session's
     * playback descriptor carries `webrtc.signaling_url`, keyed by the session's playback id, never the
     * ingest key (OpenRestream README "playback descriptor"). Null without OpenRestream, without a stream, with
     * nothing publishing, or when the live session is not WebRTC: the panel's tile keeps its
     * placeholder. OpenRestream refusing or not answering throws like any client call; the caller decides.
     */
    async function liveVideo(robotId) {
        if (!openre) return null;
        const robot = await getRobot(robotId);
        if (!robot || !robot.openre_stream_id) return null;
        const open = await openre.sessions(robot.openre_stream_id, robot.owner_subject, { state: 'open' });
        const session = open.find((s) => s && s.protocol === 'webrtc') || null;
        if (!session) return null;
        const descriptor = await openre.playback(session.id, robot.owner_subject);
        const url = descriptor && descriptor.webrtc && descriptor.webrtc.signaling_url;
        return typeof url === 'string' && /^wss?:\/\//.test(url) ? url : null;
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
    /**
     * The device row for a server-side connector (server/onvif): a real kind 'server' row, so the owner sees
     * the camera as a device of the robot, keyed by a deterministic id so a restart reuses it instead of
     * adding one per boot. It holds no credential: the connector attaches in-process, never over /device, so
     * the stored hash is of a random token nothing is ever given (and a revoked row is left alone).
     */
    async function ensureServerDevice({ id, robotId, name, drivers = [], capabilities = {} }) {
        const inserted = await db.maybe(
            `INSERT INTO devices (id, robot_ids, name, kind, agent_version, drivers, capabilities, credential_hash, created_at, updated_at)
             VALUES ($1, $2::jsonb, $3, 'server', NULL, $4::jsonb, $5::jsonb, $6, $7, $7)
             ON CONFLICT (id) DO UPDATE SET robot_ids = EXCLUDED.robot_ids, name = EXCLUDED.name,
                 drivers = EXCLUDED.drivers, capabilities = EXCLUDED.capabilities, updated_at = EXCLUDED.updated_at
             WHERE devices.revoked_at IS NULL RETURNING *`,
            [id, JSON.stringify([robotId]), name, JSON.stringify(drivers), JSON.stringify(capabilities), hashSecret(token(32)), iso(now())]);
        return inserted || db.maybe('SELECT * FROM devices WHERE id = $1 AND revoked_at IS NULL', [id]);
    }
    async function listDevicesForRobot(robotId) {
        return db.many('SELECT * FROM devices WHERE robot_ids @> $1::jsonb ORDER BY created_at DESC', [JSON.stringify([robotId])]);
    }
    /**
     * A new credential and a new publish key (the robot's OpenRestream stream rotated; the old key keeps publishing
     * for the credential's grace). OpenRestream is asked first: if it refuses or does not answer, nothing changes.
     */
    async function rotateDevice(id) {
        const d = await getDevice(id);
        if (!d || d.revoked_at) fail(404, 'bot.device_not_found', 'no live device');
        const robotId = json(d.robot_ids, [])[0];
        const issued = await newStreamKey(await getRobot(robotId), Math.ceil(config.device.rotateGraceMs / 1000));
        const credential = token(32);
        const at = iso(now());
        const updated = await db.tx(async (t) => {
            if (issued) await keepStream(t, robotId, issued.streamId, id);
            return t.maybe(
                `UPDATE devices SET credential_hash = $2, credential_prev_hash = $3, prev_valid_until = $4,
                    publish_key_hint = CASE WHEN $5 THEN $6 ELSE publish_key_hint END, updated_at = $7
                 WHERE id = $1 RETURNING *`,
                [id, hashSecret(credential), d.credential_hash, iso(now() + config.device.rotateGraceMs), !!issued, issued ? issued.hint : null, at]);
        });
        return { device: updated, credential, ...videoKey(issued) };
    }
    /**
     * Revoke the OpenRestream key a device holds, after the device itself is revoked: the robot's stream is rotated
     * with no grace and its sessions ended (OpenRestream refuses to archive a live stream). The new key is shown to
     * no one; the robot's next pairing or rotation issues another. A failure throws and keeps the device's
     * key hint, so the owner's retry asks again. → true when a key was revoked.
     */
    async function revokeVideo(id) {
        const d = await getDevice(id);
        if (!d || !d.publish_key_hint) return false;
        const robot = await getRobot(json(d.robot_ids, [])[0]);
        if (robot && robot.openre_stream_id) {
            if (!openre) {
                log.warn(`[Bot] device ${id} revoked but its key on OpenRestream stream ${robot.openre_stream_id} was not: OpenRestream is not configured`);
                return false;
            }
            await openre.rotate(robot.openre_stream_id, robot.owner_subject, { grace_seconds: 0, end_sessions: true });
        }
        await db.query('UPDATE devices SET publish_key_hint = NULL WHERE id = $1', [id]);
        return true;
    }
    async function revokeDevice(id) {
        const d = await getDevice(id);
        if (!d) fail(404, 'bot.device_not_found', 'no such device');
        const at = iso(now());
        const updated = await db.maybe('UPDATE devices SET revoked_at = $2, credential_prev_hash = NULL, prev_valid_until = NULL, updated_at = $2 WHERE id = $1 RETURNING *', [id, at]);
        return updated;
    }

    // ── Network-paired devices (node principals, T2 §9.2 B1) ──────────────────────────────────────
    /**
     * The live device bound to Network node principal `principalId`, creating it on first use. Idempotent:
     * a live row is returned as it is. Otherwise Network's record decides (GET /internal/node-principals/:id
     * with Bot's service token): the principal must be active, paired for Bot, for a robot of the principal's
     * own owner; anything else is 403 bot.node_not_bound. A principal whose device the owner revoked here
     * never binds again. The row starts from Network's record and safe values only; what the device declares
     * arrives later in its `status` frames.
     */
    async function bindNode(principalId) {
        const known = await db.maybe(
            'SELECT * FROM devices WHERE node_principal = $1 ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 1', [principalId]);
        if (known && !known.revoked_at) return known;
        const refuse = (why) => fail(403, 'bot.node_not_bound', why);
        if (known) refuse('this machine was revoked on Bot; pair it again');
        if (!nodes) refuse('Network-paired machines are not configured here');
        const p = await nodes.get(principalId);
        if (!p || p.principal !== principalId) refuse('Network knows no such machine paired for Bot');
        if (p.status !== 'active') refuse(`the machine is ${p.status} on Network`);
        if (!p.paired_for || p.paired_for.service !== 'bot') refuse('the machine was not paired for Bot');
        const robot = isRobotId(p.paired_for.ref) ? await getRobot(p.paired_for.ref) : null;
        if (!robot || !p.owner || p.owner.kind !== 'user' || p.owner.subject !== robot.owner_subject) refuse("the machine was not paired for one of its owner's robots");
        const at = iso(now());
        const name = typeof p.name === 'string' ? storable(p.name).trim().slice(0, 80) || null : null;
        // Two first connections at once: the unique index lets one insert win, and the other reads it.
        const inserted = await db.maybe(
            `INSERT INTO devices (id, robot_ids, name, kind, agent_version, drivers, capabilities, credential_hash, node_principal, created_at, updated_at)
             VALUES ($1, $2::jsonb, $3, 'onboard', NULL, '[]'::jsonb, '{}'::jsonb, NULL, $4, $5, $5)
             ON CONFLICT (node_principal) WHERE node_principal IS NOT NULL AND revoked_at IS NULL DO NOTHING RETURNING *`,
            [prefixedId('dev', now()), JSON.stringify([robot.id]), name, principalId, at]);
        return inserted || db.maybe('SELECT * FROM devices WHERE node_principal = $1 AND revoked_at IS NULL', [principalId]);
    }
    /**
     * Issue (or re-issue) a device's WHIP publish key, a new ingest key of its robot's OpenRestream stream: the new
     * key replaces the old one, which stops working. → { device, publish_key, whip_url?, profile }, the key
     * shown this once; without OpenRestream configured { device, video: 'not_configured', profile }.
     */
    async function issuePublishKey(id) {
        const live = await db.maybe('SELECT * FROM devices WHERE id = $1 AND revoked_at IS NULL', [id]);
        if (!live) fail(404, 'bot.device_not_found', 'no live device');
        const robot = await getRobot(json(live.robot_ids, [])[0]);
        const issued = await newStreamKey(robot);
        const device = await db.tx(async (t) => {
            if (issued) await keepStream(t, robot.id, issued.streamId, id);
            return t.maybe(
                `UPDATE devices SET publish_key_hint = CASE WHEN $2 THEN $3 ELSE publish_key_hint END, updated_at = $4
                 WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
                [id, !!issued, issued ? issued.hint : null, iso(now())]);
        });
        if (!device) fail(404, 'bot.device_not_found', 'no live device');
        const profile = robot ? await getProfile(db, robot.profile_id) : null;
        return { device, ...videoKey(issued), profile: profile ? profile.profile : null };
    }
    /** Persist what a Network-paired device declares (kind, drivers, capabilities, agent_version): only the given fields. */
    async function updateDeclared(id, { kind, drivers, capabilities, agent_version: agentVersion }) {
        return db.maybe(
            `UPDATE devices SET kind = COALESCE($2, kind), drivers = COALESCE($3::jsonb, drivers), capabilities = COALESCE($4::jsonb, capabilities),
                agent_version = CASE WHEN $5 THEN $6 ELSE agent_version END, updated_at = $7
             WHERE id = $1 AND revoked_at IS NULL RETURNING *`,
            [id, kind ?? null, drivers ? JSON.stringify(drivers) : null, capabilities ? JSON.stringify(capabilities) : null,
                agentVersion !== undefined, agentVersion ?? null, iso(now())]);
    }
    /** Revoke a Network-paired device's principal on Network too (null: Network no longer knows it). */
    async function revokeNode(principalId) {
        if (!nodes) fail(503, 'bot.network_unavailable', 'Network-paired machines are not configured here');
        return nodes.revoke(principalId);
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
    // `estop.set` only latches: a clear goes through clearEstop (owner only), so no device report and no other
    // caller can ever lift an owner's latch.
    async function setEstop(robotId, { latched, by, principalKind = 'device' }) {
        if (!latched) fail(403, 'bot.forbidden', 'only the owner clears the e-stop');
        return writeEstop(robotId, { latched: true, by, principalKind });
    }
    async function writeEstop(robotId, { latched, by, principalKind }) {
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
        return writeEstop(robotId, { latched: false, by: owner, principalKind: 'user' });
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
    /**
     * Leave the queue: remove the person's row (waiting or the active turn) and, when their turn ends,
     * promote the oldest waiting one. Returns the leaver's view of the queue (null/mostly empty when gone).
     */
    async function leaveQueue(robotId, subject) {
        const robot = await getRobot(robotId);
        if (!robot) fail(404, 'bot.robot_not_found', 'no such robot');
        await db.query('DELETE FROM robot_queue WHERE robot_id = $1 AND subject = $2', [robotId, subject]);
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
    /** The owner's limits clamped by the profile's (a profile missing one falls back to Bot's defaults). */
    const effectiveLimits = (robot, profile) => {
        const rl = json(robot.limits, {});
        const pl = (profile && profile.limits) || {};
        const pSpeed = pl.max_speed != null ? pl.max_speed : 1;
        const pTurn = pl.max_turn != null ? pl.max_turn : 1;
        const pMs = pl.max_command_ms != null ? pl.max_command_ms : config.control.maxCommandMs;
        const maxSpeed = rl.max_speed != null ? Math.min(rl.max_speed, pSpeed) : pSpeed;
        const maxTurn = rl.max_turn != null ? Math.min(rl.max_turn, pTurn) : pTurn;
        const maxCommandMs = rl.max_command_ms != null ? Math.min(rl.max_command_ms, pMs) : pMs;
        const cooldownMs = rl.cooldown_ms != null ? rl.cooldown_ms : config.control.cooldownMs;
        return { maxSpeed, maxTurn, maxCommandMs, cooldownMs };
    };
    /** The limits a device enforces itself (the `config` frame): the effective ones, never the profile's alone. */
    const deviceLimits = (robot, profile) => {
        const eff = effectiveLimits(robot, profile);
        const hb = profile && profile.limits && profile.limits.heartbeat_ms != null ? profile.limits.heartbeat_ms : config.device.heartbeatMs;
        return { max_speed: eff.maxSpeed, max_turn: eff.maxTurn, max_command_ms: eff.maxCommandMs, heartbeat_ms: hb };
    };
    // Cooldown is measured from the last command sent (not from an acknowledgement), per operator and
    // kind; the owner is never cooldowned. Bounded so a flood of subjects cannot grow it without end.
    const lastCommandAt = new Map();
    const activeButtons = new Map();
    const markCooldown = (robotId, subject, kind) => {
        lastCommandAt.set(`${robotId}|${subject}|${kind}`, now());
        if (lastCommandAt.size > 4096) lastCommandAt.delete(lastCommandAt.keys().next().value);
    };

    /** The command kinds the robot's profile takes (`halt` always). */
    const profileTakes = (profile, kind) => kind === 'halt' || !!(profile && profile.commands && profile.commands[kind]);
    /**
     * What `role` may send to this robot: the owner's allowlist for the role (or the default), cut to the
     * kinds the profile takes. Every role that may drive also gets `halt`, which no allowlist removes.
     */
    const allowedFor = (robot, role, profile = null) => {
        const rl = json(robot.limits, {});
        const fromOwner = rl.allow && Array.isArray(rl.allow[role]) ? rl.allow[role] : null;
        const kinds = (fromOwner || DEFAULT_ALLOW[role] || []).filter((k) => k !== 'halt' && profileTakes(profile, k));
        return CONTROL_ROLES.has(role) ? [...kinds, 'halt'] : kinds;
    };

    /** An axis value: the schema's range, cut for drive by the owner's max_speed (or max_turn for a turn axis). */
    function axisValue(kind, axis, range, raw, eff) {
        const cap = kind !== 'drive' ? Infinity : TURN_AXES.has(axis) ? eff.maxTurn : eff.maxSpeed;
        const lo = Math.max(range[0], -cap);
        const hi = Math.min(range[1], cap);
        return clampNum(raw, lo, hi, clampNum(0, lo, hi));
    }
    function actuatorValue(name, a, x) {
        if (a.type === 'number') {
            if (typeof x !== 'number' || !Number.isFinite(x)) fail(422, 'bot.invalid_input', `${name} takes a number`);
            return clampNum(x, a.range[0], a.range[1]);
        }
        if (a.type === 'bool') {
            if (typeof x !== 'boolean') fail(422, 'bot.invalid_input', `${name} takes true or false`);
            return x;
        }
        if (a.type === 'rgb') {
            if (x == null || x === false) return null;   // off
            if (!x || typeof x !== 'object' || Array.isArray(x)) fail(422, 'bot.invalid_input', `${name} takes {r,g,b} (0–255) or null`);
            const out = { r: Math.round(clampNum(x.r, 0, 255)), g: Math.round(clampNum(x.g, 0, 255)), b: Math.round(clampNum(x.b, 0, 255)) };
            if (x.index != null) {
                if (!a.count || !Number.isInteger(x.index) || x.index < 0 || x.index >= a.count) fail(422, 'bot.invalid_input', `${name} index must be 0..${(a.count || 1) - 1}`);
                out.index = x.index;
            }
            return out;
        }
        // tone: {hz} or {note}, sent as {hz} inside the range; null, 0 or {hz:0} is off.
        if (!x) return null;
        if (typeof x !== 'object' || Array.isArray(x)) fail(422, 'bot.invalid_input', `${name} takes {note}, {hz} or null`);
        const hz = x.note != null ? noteToHz(x.note) : typeof x.hz === 'number' && Number.isFinite(x.hz) ? x.hz : null;
        if (hz == null) fail(422, 'bot.invalid_input', `${name} takes {note} (like "A4"), {hz} or null`);
        if (hz === 0) return null;
        return { hz: Math.round(clampNum(hz, a.hz[0], a.hz[1]) * 100) / 100 };
    }

    /**
     * Build the value the device gets from the operator's, by the profile's schema for the kind: only the
     * declared axes and actuator names, in the declared shapes, clamped to the declared ranges and the
     * owner's limits. Throws a 422 BotError for a value the device would refuse.
     */
    function buildValue(kind, value, eff, profile) {
        if (kind === 'halt') return {};
        const spec = profile.commands[kind];
        const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        if (kind === 'button') {
            const name = typeof v.name === 'string' ? v.name : '';
            if (!Object.hasOwn(spec.names, name)) fail(422, 'bot.command_not_allowed', 'this robot has no such button');
            if (Object.keys(v).some((k) => k !== 'name' && k !== 'state')) fail(422, 'bot.invalid_input', 'button takes only name and state');
            const hold = !!spec.names[name].hold;
            if (hold && !['down', 'up'].includes(v.state)) fail(422, 'bot.invalid_input', 'a hold button needs down or up');
            if (!hold && Object.hasOwn(v, 'state')) fail(422, 'bot.invalid_input', 'a plain button takes no state');
            return hold ? { name, state: v.state } : { name };
        }
        if (kind === 'point') {
            if (Object.keys(v).some((k) => k !== 'x' && k !== 'y') ||
                typeof v.x !== 'number' || !Number.isFinite(v.x) || v.x < 0 || v.x > 1 ||
                typeof v.y !== 'number' || !Number.isFinite(v.y) || v.y < 0 || v.y > 1) {
                fail(422, 'bot.invalid_input', 'point needs x and y between 0 and 1');
            }
            return { x: v.x, y: v.y };
        }
        if (kind === 'drive') {
            // Every declared axis is sent; an absent one is 0, so a drive frame always says the whole motion.
            const out = {};
            for (const [axis, range] of Object.entries(spec.axes)) out[axis] = axisValue(kind, axis, range, v[axis] != null ? v[axis] : v[AXIS_ALIASES[axis]], eff);
            return out;
        }
        if (kind === 'ptz') {
            // Only the axes given move; the others stay where they are.
            const out = {};
            for (const [axis, range] of Object.entries(spec.axes)) if (v[axis] != null) out[axis] = axisValue(kind, axis, range, v[axis], eff);
            if (!Object.keys(out).length) fail(422, 'bot.invalid_input', `ptz needs one of ${Object.keys(spec.axes).join(', ')}`);
            return out;
        }
        if (kind === 'actuator') {
            const name = typeof v.name === 'string' ? v.name : '';
            if (!Object.prototype.hasOwnProperty.call(spec.names, name)) fail(422, 'bot.unknown_actuator', `this robot has no actuator ${name.slice(0, 24) || '(unnamed)'}`);
            return { name, value: actuatorValue(name, spec.names[name], v.value) };
        }
        if (kind === 'say') {
            const t = text(v.text, 'text', spec.max_chars);
            if (!t) fail(422, 'bot.invalid_input', 'say needs text');
            return { text: t };
        }
        // display: one of the declared modes, in the plugin's order of preference.
        const modes = new Set(spec.modes);
        if (modes.has('image_png_b64') && v.image_png_b64 != null) {
            const img = String(v.image_png_b64);
            if (!img || img.length > MAX_IMAGE_B64 || !BASE64_RE.test(img)) fail(422, 'bot.invalid_input', `image_png_b64 must be base64, at most ${MAX_IMAGE_B64} characters`);
            return { image_png_b64: img };
        }
        if (modes.has('face') && v.face != null) {
            const face = String(v.face).toLowerCase();
            if (!spec.faces.includes(face)) fail(422, 'bot.invalid_input', `face must be one of ${spec.faces.join(', ')}`);
            return { face };
        }
        const t = modes.has('text') ? text(v.text, 'text', spec.max_chars) : null;
        if (!t) fail(422, 'bot.invalid_input', `display needs ${spec.modes.join(' or ')}`);
        return { text: t };
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
        if (!profileTakes(profile, kind)) return { ok: false, code: 'bot.command_not_allowed', reason: `this robot takes no ${kind} commands`, robot };
        const halt = kind === 'halt';
        if (robot.estop_latched && !halt) return { ok: false, code: 'bot.estop_latched', reason: 'the e-stop is latched; only the owner can clear it', robot };

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
        const allow = allowedFor(robot, role, profile);
        if (!allow.includes(kind)) return { ok: false, code: 'bot.command_not_allowed', reason: `${kind} is not allowed for ${role}`, robot, role };
        if (!online) return { ok: false, code: 'bot.device_offline', reason: 'the device is offline; commands are never queued', robot, role };

        const eff = effectiveLimits(robot, profile);
        const release = kind === 'button' && value && value.state === 'up';
        const activeKey = kind === 'button' && value && typeof value.name === 'string' ? `${robotId}|${subject}|${value.name}` : null;
        const repeatedHold = !!(activeKey && value.state === 'down' && activeButtons.get(activeKey) > now());
        const cooled = eff.cooldownMs > 0 && role !== 'owner' && !halt && !release && !repeatedHold;
        if (cooled) {
            const last = lastCommandAt.get(`${robotId}|${subject}|${kind}`);
            if (last && now() - last < eff.cooldownMs) {
                return { ok: false, code: 'bot.cooldown', reason: `wait ${eff.cooldownMs} ms between ${kind} commands`, robot, role };
            }
        }
        if (role === 'queue') {
            // A halt needs the turn (a waiting person may not stop the driver) but spends none of its budget.
            if (halt || release || repeatedHold) {
                const turn = await currentTurn(robotId);
                if (!turn || turn.subject !== subject) return { ok: false, code: 'bot.not_your_turn', reason: 'it is not your turn', robot, role };
            } else {
                const budget = await consumeTurn(robotId, subject);
                if (!budget.ok) return { ok: false, code: budget.code, reason: budget.code === 'bot.turn_budget' ? 'your turn budget is spent' : 'it is not your turn', robot, role };
            }
        }
        let built;
        try { built = buildValue(kind, value, eff, profile); } catch (e) { return { ok: false, code: e.code || 'bot.invalid_input', reason: e.detail || e.message, robot, role }; }
        const specificMs = kind === 'button' ? profile.commands.button.names[built.name].cooldown_ms || 0
            : kind === 'point' ? profile.commands.point.cooldown_ms || 0 : 0;
        const specificKey = kind === 'button' ? `button:${built.name}` : 'point';
        if (specificMs > 0 && !release && !repeatedHold) {
            const last = lastCommandAt.get(`${robotId}|${subject}|${specificKey}`);
            if (last && now() - last < specificMs) return { ok: false, code: 'bot.cooldown', reason: `wait ${specificMs} ms between ${specificKey} commands`, robot, role };
        }
        if (cooled) markCooldown(robotId, subject, kind);
        if (specificMs > 0 && !release && !repeatedHold) markCooldown(robotId, subject, specificKey);
        const deadlineMs = (MOTION.has(kind) || (kind === 'button' && built.state === 'down'))
            ? now() + clampNum(requestedMs != null ? requestedMs : eff.maxCommandMs, 1, eff.maxCommandMs, eff.maxCommandMs)
            : null;
        if (activeKey && built.state === 'down') activeButtons.set(activeKey, deadlineMs);
        if (activeKey && built.state === 'up') activeButtons.delete(activeKey);
        if (activeButtons.size > 4096) activeButtons.delete(activeButtons.keys().next().value);
        return { ok: true, robot, profile, role, kind, value: built, deadlineMs, limits: eff };
    }

    return {
        db, now, config, log, outbox, link,
        present: { robot: presentRobot, device: presentDevice, video: presentVideo },
        robots: { create: createRobot, list: listRobots, get: getRobot, update: updateRobot, setEmbedPublic, remove: removeRobot,
            localProfile, saveLocalProfile, useCatalogueProfile },
        members: { roleOf, add: addOperator, remove: removeOperator, list: listOperators },
        pairing: { create: createPairingCode, redeem, prune: prunePairingCodes, installerCommand, driverForProfile, whipUrl },
        devices: { byCredential, bindNode, issuePublishKey, revokeVideo, updateDeclared, revokeNode, ensureServerDevice, get: getDevice, listForRobot: listDevicesForRobot, rotate: rotateDevice, revoke: revokeDevice, touchSeen, setOnline },
        streaming: { get: streaming, set: setStreaming },
        video: { live: liveVideo },
        estop: { set: setEstop, clear: clearEstop },
        queue: { join: joinQueue, leave: leaveQueue, state: queueState, currentTurn, consume: consumeTurn, sweep: sweepQueues },
        audit: { record: auditCommand, list: listAudit, listPage: listAuditPage, prune: pruneAudit },
        control: { prepare, allowedFor, effectiveLimits, deviceLimits, buildValue, DEFAULT_ALLOW, KINDS },
    };
}

module.exports = { createDomain, DEFAULT_ALLOW, DRIVER_BY_PROFILE, driverForProfile, KINDS, normaliseCode, formatCode, newCode, isCodeShape, noteToHz };
