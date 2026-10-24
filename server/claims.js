'use strict';
/**
 * A device that asks to be added: the one command on the machine (plan T15 "five-minute path", owner 2026-10-17: "I
 * should be able to run a single command on my raspi … ready to go live and controllable").
 *
 *   curl -fsSL https://openvibe.bot/install | sh          (no robot, no code)
 *
 * The installer looks at the machine (the kit on its I2C bus, the camera), then starts a claim here and shows the
 * person a code and openvibe.bot/link. Signed in there, they see what the device found and approve it (name, model,
 * who may drive, its video on their Live channel) or deny it. The approval makes the robot exactly as Add robot does
 * (domain.robots.create) and keeps that robot's pairing on the claim. The device polls with the secret only it holds,
 * gets the pairing and pairs the usual way (POST /pair, or Network's form), so pairing itself is unchanged. When it has
 * paired (domain.pairing.onPaired) the claim drops the pairing and turns on what the owner asked for: the robot's
 * stream exists only from then on.
 *
 *   start({ hostname, hardware, address, setupKey })  → { id, user_code, secret, expires_at, interval, verification_url, … }
 *       with a setup key (a card made on /setup/sd-card, server/setup-keys.js) the claim is approved at once for the
 *       key's owner with the choices made with the card files; a retry before the robot has paired pairs the same robot
 *   poll(id, secret)                            → { state: pending | approved (+ pairing) | denied | expired | paired }
 *   find(userCode)                              → the pending claim the code names, or null
 *   approve(id, owner, { name, profile_id, access_policy, live })  → { robot, claim }
 *   deny(id, owner)
 *   afterPair(robotId)                          → the onPaired hook
 *   prune()
 *
 * The code is 8 Crockford characters like a pairing code (only its hash is stored); the secret is 32 random bytes
 * (hash stored). What the device reports is untrusted: it is cut to known fields and lengths, shown escaped, and only
 * ever pre-selects a model the person can change. A claim lasts 15 minutes.
 */
const { prefixedId, iso, token, hashSecret, secretEquals, fail, text } = require('./util');
const { newCode, formatCode, normaliseCode, isCodeShape } = require('./domain');
const { getProfile } = require('./profiles');

const TTL_MS = 15 * 60 * 1000;
const POLL_S = 3;
const KEEP_MS = 24 * 3600 * 1000;
const HARDWARE_FIELDS = { model: 80, os: 80, arch: 20, kit: 60, kit_name: 80, camera: 80 };

const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** The hostname as a robot name: what a hostname may hold, else "robot". */
function cleanHostname(v) {
    const s = clip(v, 63).replace(/[^A-Za-z0-9._-]/g, '');
    return s || 'robot';
}

/** Only the fields the approval page shows, each cut to length; `found` is a short list ("PCA9685 at 0x5f"). */
function cleanHardware(h) {
    const out = {};
    if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
    for (const [k, max] of Object.entries(HARDWARE_FIELDS)) { const v = clip(h[k], max); if (v) out[k] = v; }
    if (Array.isArray(h.found)) {
        const found = h.found.map((x) => clip(x, 60)).filter(Boolean).slice(0, 8);
        if (found.length) out.found = found;
    }
    return out;
}

function createClaims({ db, domain, config, setupKeys = null, now = () => Date.now(), log = console }) {
    const base = String(config.baseUrl || 'https://openvibe.bot').replace(/\/+$/, '');

    async function start({ hostname, hardware, address = null, setupKey = null } = {}) {
        let key = null;
        if (setupKey != null && setupKey !== '') {
            key = setupKeys ? await setupKeys.redeem(setupKey) : null;
            if (!key) {
                fail(403, 'bot.setup_key_invalid', "this card's setup key was used, revoked or is more than 7 days old: make new card files "
                    + `on ${base}/setup/sd-card, or run the installer without --setup and approve its code on ${base}/link`);
            }
        }
        const hw = cleanHardware(hardware);
        const kit = hw.kit && !hw.kit.startsWith('local.') ? await getProfile(db, hw.kit).catch(() => null) : null;
        const id = prefixedId('clm', now());
        const secret = token(32);
        const at = now();
        // A fresh code until one is free: two live claims never share a code.
        for (let tries = 0; tries < 5; tries++) {
            const code = newCode();
            const row = await db.maybe(
                `INSERT INTO device_claims (id, user_code_hash, secret_hash, hostname, hardware, suggested_profile, address, created_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) ON CONFLICT (user_code_hash) DO NOTHING RETURNING id`,
                [id, hashSecret(code), hashSecret(secret), cleanHostname(hostname), JSON.stringify(hw), kit ? kit.profile.id : null,
                    address ? clip(String(address), 64) : null, iso(at), iso(at + TTL_MS)]);
            if (row) {
                const userCode = formatCode(code);
                if (key) await approveWithKey(id, key);
                return {
                    id, user_code: userCode, secret, expires_at: iso(at + TTL_MS), interval: POLL_S,
                    verification_url: `${base}/link`, verification_url_complete: `${base}/link?code=${userCode}`,
                    ...(key ? { approved: true } : {}),
                };
            }
        }
        fail(503, 'bot.unavailable', 'could not make a claim code; try again');
        return null;
    }

    const live = (row) => row && new Date(row.expires_at).getTime() > now();

    async function poll(id, secret) {
        const row = typeof id === 'string' && /^clm_[0-9A-Z]{26}$/.test(id) ? await db.maybe('SELECT * FROM device_claims WHERE id = $1', [id]) : null;
        // A wrong secret and a claim that does not exist answer the same.
        if (!row || typeof secret !== 'string' || !secretEquals(hashSecret(secret), row.secret_hash)) fail(404, 'bot.claim_not_found', 'no such claim');
        if (row.state === 'denied') return { state: 'denied' };
        if (row.state === 'paired') return { state: 'paired', robot_id: row.robot_id };
        if (row.state === 'approved' && row.pairing) {
            const robot = await domain.robots.get(row.robot_id);
            const p = row.pairing;
            return {
                state: 'approved', robot_id: row.robot_id, name: robot ? robot.name : null, profile_id: robot ? robot.profile_id : null,
                driver: robot ? domain.pairing.driverForProfile(robot.profile_id) : 'none',
                pairing: p.pairing_id ? { network: config.network && config.network.url, pairing_id: p.pairing_id, code: p.code, expires_at: p.expires_at }
                    : { robot: row.robot_id, code: p.code, expires_at: p.expires_at },
                panel_url: `${base}/panel/${row.robot_id}`, live: !!row.want_live,
            };
        }
        if (!live(row)) return { state: 'expired' };
        return { state: 'pending', expires_at: new Date(row.expires_at).toISOString(), interval: POLL_S };
    }

    async function find(userCode) {
        const normal = normaliseCode(userCode);
        if (!isCodeShape(normal)) return null;
        const row = await db.maybe("SELECT * FROM device_claims WHERE user_code_hash = $1 AND state = 'pending'", [hashSecret(normal)]);
        return live(row) ? row : null;
    }

    async function pending(id) {
        const row = typeof id === 'string' ? await db.maybe('SELECT * FROM device_claims WHERE id = $1', [id]) : null;
        if (!row || row.state !== 'pending' || !live(row)) fail(404, 'bot.claim_not_found', 'that device is no longer waiting (a code lasts 15 minutes): run the command on it again');
        return row;
    }

    async function approve(id, owner, { name, profile_id, access_policy = 'private', live: wantLive = false } = {}) {
        await pending(id);
        // Taken first, so two approvals at once cannot make two robots; given back if making the robot fails.
        const taken = await db.maybe("UPDATE device_claims SET state = 'approving', owner_subject = $2 WHERE id = $1 AND state = 'pending' RETURNING *", [id, owner]);
        if (!taken) fail(409, 'bot.claim_taken', 'that device was just approved or denied');
        let made;
        try {
            made = await domain.robots.create({ owner, name: text(name, 'name', 80) || taken.hostname, profile_id, access_policy });
        } catch (e) {
            await db.query("UPDATE device_claims SET state = 'pending', owner_subject = NULL WHERE id = $1 AND state = 'approving'", [id]);
            throw e;
        }
        const p = made.pairing || {};
        const claim = await db.maybe(
            `UPDATE device_claims SET state = 'approved', robot_id = $2, pairing = $3::jsonb, want_live = $4, decided_at = $5
             WHERE id = $1 RETURNING *`,
            [id, made.robot.id, JSON.stringify({ code: p.code, expires_at: p.expires_at, pairing_id: p.pairing_id || null }), !!wantLive, iso(now())]);
        return { robot: made.robot, claim };
    }

    /**
     * A claim started with a setup key: approved for the key's owner at once. The first one makes the robot with the
     * card's choices; a retry (the robot has not paired yet) gives the same robot a fresh pairing code instead of a
     * second robot. Two first starts at once: the one that marks the key first makes the robot, the other is refused.
     */
    async function approveWithKey(id, key) {
        const existing = key.robot_id ? await domain.robots.get(key.robot_id) : null;
        if (existing) {
            const p = await domain.pairing.create(existing.id, key.owner_subject, null, existing);
            await db.query(
                `UPDATE device_claims SET state = 'approved', owner_subject = $2, robot_id = $3, pairing = $4::jsonb, want_live = $5, decided_at = $6
                 WHERE id = $1 AND state = 'pending'`,
                [id, key.owner_subject, existing.id, JSON.stringify({ code: p.code, expires_at: p.expires_at, pairing_id: p.pairing_id || null }),
                    !!key.want_live, iso(now())]);
            await setupKeys.attach(key.id, { claim_id: id });
            return;
        }
        const first = await db.maybe('UPDATE device_setup_keys SET claimed_at = $2, claim_id = $3 WHERE id = $1 AND claimed_at IS NULL RETURNING id',
            [key.id, iso(now()), id]);
        if (!first) fail(409, 'bot.setup_key_busy', 'this card is being added right now: wait a minute and run the installer again');
        const made = await approve(id, key.owner_subject, { name: key.name, profile_id: key.profile_id, access_policy: key.access_policy, live: key.want_live });
        await setupKeys.attach(key.id, { claim_id: id, robot_id: made.robot.id });
    }

    async function deny(id, owner) {
        await pending(id);
        const row = await db.maybe("UPDATE device_claims SET state = 'denied', owner_subject = $2, decided_at = $3 WHERE id = $1 AND state = 'pending' RETURNING id", [id, owner, iso(now())]);
        if (!row) fail(409, 'bot.claim_taken', 'that device was just approved or denied');
    }

    /** The robot paired: drop the pairing, and turn on what its owner asked for when they approved it. */
    async function afterPair(robotId) {
        if (setupKeys) await setupKeys.paired(robotId).catch((e) => log.warn(`[Bot] setup key of ${robotId}: ${e.message}`));
        const row = await db.maybe(
            `UPDATE device_claims SET state = 'paired', pairing = NULL, paired_at = $2
             WHERE robot_id = $1 AND state IN ('approved', 'paired') RETURNING *`, [robotId, iso(now())]);
        if (!row || !row.want_live || row.live_applied_at) return;
        try {
            await domain.streaming.set(robotId, { subject: row.owner_subject, kind: 'user' }, { to: 'live', on: true });
            await db.query('UPDATE device_claims SET live_applied_at = $2 WHERE id = $1', [row.id, iso(now())]);
        } catch (e) {
            log.warn(`[Bot] claim ${row.id}: could not put ${robotId} on Live: ${e.message}`);
        }
    }

    async function prune() {
        await db.query("DELETE FROM device_claims WHERE expires_at < $1 AND state <> 'approved'", [iso(now() - KEEP_MS)]);
        // An approval whose device never paired keeps its pairing until the pairing itself is long dead.
        await db.query("DELETE FROM device_claims WHERE state = 'approved' AND decided_at < $1", [iso(now() - KEEP_MS)]);
    }

    return { start, poll, find, waiting: pending, approve, deny, afterPair, prune, TTL_MS };
}

module.exports = { createClaims, cleanHardware, cleanHostname, CLAIM_TTL_MS: TTL_MS };
