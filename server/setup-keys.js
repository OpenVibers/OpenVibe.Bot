'use strict';
/**
 * Setup keys: a microSD card that adds its robot to openvibe.bot by itself (owner 2026-10-24: "if you just have a fresh
 * MicroSD card … the site needs to guide the user … now I can't even enter that command").
 *
 * /setup/sd-card makes the card's first-boot files in the person's browser: Wi-Fi, a login, SSH, and one command that
 * runs the installer with a setup key (`install.sh --setup <key>`). The installer starts a claim with the key
 * (server/claims.js), and the claim is approved at once for the key's owner with the choices made with the card files
 * (name, model, who may drive, Live) — no code to read off a screen, no /link.
 *
 *   create(owner, { name, profile_id, access_policy, live, hostname }) → { id, key, expires_at }   (the key only here)
 *   redeem(key)            → the live key row (not revoked, expired or spent), or null
 *   attach(id, { claim_id, robot_id })                                  the claim it started (and the robot, once)
 *   paired(robotId)        → the robot paired: its key is spent
 *   status(owner, id)      → { state: waiting | installing | paired | expired | revoked, robot_id, … } or null
 *   revoke(owner, id)
 *
 * A key lasts until its robot has paired, or 7 days. Until then a retry (the installer failed half way, the card was
 * flashed again with the same files) pairs the same robot with a fresh code rather than making a second one. The key is
 * a bearer secret on the card: it can only add a robot to its owner's account, once. Only its hash is kept.
 */
const { prefixedId, iso, token, hashSecret, fail, text } = require('./util');

const TTL_MS = 7 * 24 * 3600 * 1000;
const KEY_RE = /^osk_[A-Za-z0-9_-]{43}$/;
const POLICIES = ['private', 'invite', 'queue'];
// What a hostname may be (RFC 1123 label): the card writes it and the person ssh-es to <hostname>.local.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function createSetupKeys({ db, now = () => Date.now() }) {
    async function create(owner, { name, profile_id, access_policy = 'private', live = false, hostname = null } = {}) {
        if (!owner) fail(401, 'bot.unauthenticated', 'sign in to make card files');
        const cleanName = text(name, 'name', 80);
        if (!cleanName) fail(422, 'bot.invalid_input', 'name is required');
        if (!profile_id || typeof profile_id !== 'string') fail(422, 'bot.unknown_profile', 'choose a model');
        if (!POLICIES.includes(access_policy)) fail(422, 'bot.invalid_policy', 'access_policy must be private, invite or queue');
        const host = hostname == null || hostname === '' ? null : String(hostname).toLowerCase();
        if (host !== null && !HOSTNAME_RE.test(host)) fail(422, 'bot.invalid_input', 'the hostname is letters, digits and dashes (at most 63)');
        const id = prefixedId('osk', now());
        const key = `osk_${token(32)}`;
        const at = now();
        await db.query(
            `INSERT INTO device_setup_keys (id, owner_subject, secret_hash, name, profile_id, access_policy, want_live, hostname, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, owner, hashSecret(key), cleanName, profile_id, access_policy, !!live, host, iso(at), iso(at + TTL_MS)]);
        return { id, key, expires_at: iso(at + TTL_MS) };
    }

    async function redeem(key) {
        if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
        const row = await db.maybe('SELECT * FROM device_setup_keys WHERE secret_hash = $1', [hashSecret(key)]);
        if (!row || row.revoked_at || row.paired_at || new Date(row.expires_at).getTime() <= now()) return null;
        return row;
    }

    async function attach(id, { claim_id, robot_id = null }) {
        await db.query(
            `UPDATE device_setup_keys SET claim_id = $2, robot_id = COALESCE(robot_id, $3), claimed_at = COALESCE(claimed_at, $4) WHERE id = $1`,
            [id, claim_id, robot_id, iso(now())]);
    }

    async function paired(robotId) {
        await db.query('UPDATE device_setup_keys SET paired_at = $2 WHERE robot_id = $1 AND paired_at IS NULL', [robotId, iso(now())]);
    }

    async function status(owner, id) {
        const row = typeof id === 'string' && /^osk_[0-9A-Z]{26}$/.test(id)
            ? await db.maybe('SELECT * FROM device_setup_keys WHERE id = $1 AND owner_subject = $2', [id, owner]) : null;
        if (!row) return null;
        const state = row.revoked_at ? 'revoked' : row.paired_at ? 'paired' : row.robot_id ? 'installing'
            : new Date(row.expires_at).getTime() <= now() ? 'expired' : 'waiting';
        return { id: row.id, state, name: row.name, hostname: row.hostname, robot_id: row.robot_id || null,
            expires_at: new Date(row.expires_at).toISOString(), claimed_at: row.claimed_at ? new Date(row.claimed_at).toISOString() : null };
    }

    async function revoke(owner, id) {
        const row = await db.maybe('UPDATE device_setup_keys SET revoked_at = $3 WHERE id = $1 AND owner_subject = $2 AND revoked_at IS NULL AND paired_at IS NULL RETURNING id',
            [id, owner, iso(now())]);
        if (!row) fail(404, 'bot.not_found', 'no such card files, or they were already used or revoked');
    }

    async function prune() {
        await db.query('DELETE FROM device_setup_keys WHERE expires_at < $1', [iso(now() - 30 * 24 * 3600 * 1000)]);
    }

    return { create, redeem, attach, paired, status, revoke, prune, TTL_MS };
}

module.exports = { createSetupKeys, SETUP_KEY_RE: KEY_RE, SETUP_KEY_TTL_MS: TTL_MS, HOSTNAME_RE };
