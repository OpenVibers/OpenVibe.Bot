'use strict';

/**
 * Community robot profiles (plan T15 "people submit bots and guides and Bot connects them": submissions are reviewed
 * and signed before they run on anyone's Node). Anyone signed in submits a profile whose id is under `community.`,
 * with the driver's source, a setup guide and a licence; an OpenVibe admin approves or rejects it. Approving signs the
 * profile (Ed25519 over its canonical JSON, BOT_PROFILE_SIGNING_KEY) and puts it in the catalogue (robot_profiles), so
 * robots can be added with it; the signature and Bot's public key are published so a Node or anyone can check it.
 *
 *   createSubmissions({ db, config, now })
 *     submit(person, { profile, driver_url, guide_url, license, notes })  → the submission row (pending)
 *     withdraw(id, person) / review(id, reviewer, { decision: 'approve'|'reject', note })
 *     get(id), mine(subject), pending(), community()                       (community(): approved, newest first)
 *     signatureFor(profileId, version) → { alg, key_id, value } | null
 *     signingKey() → { alg, key_id, public_key_pem } | null                (null when no key is configured)
 *   canonicalJson(value)                                                   (sorted keys, no spaces: what is signed)
 */
const crypto = require('crypto');
const { checkProfile } = require('./profiles');
const { BotError, prefixedId, iso, text } = require('./util');

const COMMUNITY_ID = /^community\.[a-z][a-z0-9_-]{1,40}$/;
const LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0-only', 'LGPL-3.0-only', 'MPL-2.0', 'CC0-1.0', 'other'];
const ALG = 'Ed25519';

function fail(status, code, detail) { throw new BotError(status, code, detail); }

/** JSON with every object's keys sorted and no whitespace: the exact bytes Bot signs. */
function canonicalJson(v) {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}

/** BOT_PROFILE_SIGNING_KEY: an Ed25519 private key as PEM (literal \n allowed) or base64 of the PEM or of PKCS#8 DER. */
function loadKey(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let key;
    try {
        if (s.includes('BEGIN')) key = crypto.createPrivateKey(s.replace(/\\n/g, '\n'));
        else {
            const buf = Buffer.from(s, 'base64');
            const pem = buf.toString('utf8');
            key = pem.includes('BEGIN') ? crypto.createPrivateKey(pem) : crypto.createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' });
        }
    } catch (e) { throw new Error(`BOT_PROFILE_SIGNING_KEY is not a private key: ${e.message}`); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('BOT_PROFILE_SIGNING_KEY must be an Ed25519 key');
    const pub = crypto.createPublicKey(key);
    const der = pub.export({ type: 'spki', format: 'der' });
    return { key, keyId: crypto.createHash('sha256').update(der).digest('hex').slice(0, 16), publicPem: pub.export({ type: 'spki', format: 'pem' }) };
}

function httpsUrl(v, name) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch { fail(422, 'bot.invalid_input', `${name} is not a URL`); }
    if (u.protocol !== 'https:' || u.username || u.password || s.length > 300) fail(422, 'bot.invalid_input', `${name} must be an https link of at most 300 characters`);
    return u.href;
}

function createSubmissions({ db, config = {}, now = () => Date.now(), log = console }) {
    // A key that does not load is logged and leaves approvals refused; it never stops the service.
    let signer = null;
    try { signer = loadKey(config.profiles && config.profiles.signingKey); } catch (e) { log.warn(`[Bot] ${e.message}; community profiles cannot be approved`); }

    async function get(id) { return db.maybe('SELECT * FROM profile_submissions WHERE id = $1', [id]); }
    async function mine(subject) { return db.many('SELECT * FROM profile_submissions WHERE submitter_subject = $1 ORDER BY created_at DESC LIMIT 100', [subject]); }
    async function pending() { return db.many("SELECT * FROM profile_submissions WHERE status = 'pending' ORDER BY created_at LIMIT 200"); }
    async function community() {
        return db.many(`SELECT DISTINCT ON (profile_id) * FROM profile_submissions WHERE status = 'approved'
            ORDER BY profile_id, profile_version DESC`);
    }

    async function submit(person, { profile, driver_url = null, guide_url = null, license = null, notes = null } = {}) {
        if (!person || !person.subject) fail(401, 'bot.sign_in', 'sign in to submit a robot');
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) fail(422, 'bot.invalid_input', 'the profile must be a JSON object');
        if (!COMMUNITY_ID.test(String(profile.id || ''))) fail(422, 'bot.invalid_input', 'a community profile\'s id is community.<name> (lower case letters, digits, - and _)');
        const checked = checkProfile(profile);
        if (!checked.valid) fail(422, 'bot.profile_invalid', checked.problems.join('; '));
        const p = checked.profile;
        const driver = httpsUrl(driver_url, 'the driver link');
        const guide = httpsUrl(guide_url, 'the setup guide link');
        if (!driver && p.mapping.driver === 'plugin') fail(422, 'bot.invalid_input', 'a robot driven by a community plugin needs a link to the plugin\'s source');
        const lic = license == null || license === '' ? null : String(license);
        if (lic && !LICENSES.includes(lic)) fail(422, 'bot.invalid_input', `licence must be one of ${LICENSES.join(', ')}`);
        const note = text(notes, 'notes', 2000) || null;

        // The id is someone's once it is in the catalogue: only its original submitter sends a newer version of it.
        const owners = await db.many("SELECT DISTINCT submitter_subject FROM profile_submissions WHERE profile_id = $1 AND status = 'approved'", [p.id]);
        if (owners.some((o) => o.submitter_subject && o.submitter_subject !== person.subject)) fail(409, 'bot.profile_taken', 'that profile id belongs to someone else; choose another');
        const latest = await db.maybe('SELECT max(version) AS v FROM robot_profiles WHERE id = $1', [p.id]);
        if (latest && latest.v != null && p.version <= latest.v) fail(409, 'bot.profile_version', `version ${latest.v} is already in the catalogue; submit version ${latest.v + 1} or later`);
        const rival = await db.maybe("SELECT 1 FROM profile_submissions WHERE profile_id = $1 AND status = 'pending' AND submitter_subject <> $2", [p.id, person.subject]);
        if (rival) fail(409, 'bot.profile_taken', 'someone else has a submission with that id waiting for review; choose another');

        const id = prefixedId('sub', now());
        const at = iso(now());
        await db.tx(async (t) => {
            // A newer submission of the same profile by the same person replaces their pending one.
            await t.query("UPDATE profile_submissions SET status = 'withdrawn', updated_at = $3 WHERE profile_id = $1 AND submitter_subject = $2 AND status = 'pending'", [p.id, person.subject, at]);
            await t.query(`INSERT INTO profile_submissions (id, submitter_subject, profile_id, profile_version, profile, driver_url, guide_url, license, notes, status, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'pending', $10, $10)`,
            [id, person.subject, p.id, p.version, JSON.stringify(p), driver, guide, lic, note, at]);
        });
        return get(id);
    }

    async function withdraw(id, person) {
        const row = await get(id);
        if (!row) fail(404, 'bot.submission_not_found', 'no such submission');
        if (!person || row.submitter_subject !== person.subject) fail(403, 'bot.forbidden', 'only its submitter may withdraw it');
        if (row.status !== 'pending') fail(409, 'bot.submission_closed', `it is already ${row.status}`);
        await db.query("UPDATE profile_submissions SET status = 'withdrawn', updated_at = $2 WHERE id = $1", [id, iso(now())]);
        return get(id);
    }

    async function review(id, reviewer, { decision, note = null } = {}) {
        if (!reviewer || reviewer.role !== 'admin') fail(403, 'bot.forbidden', 'only an OpenVibe admin reviews community robots');
        const row = await get(id);
        if (!row) fail(404, 'bot.submission_not_found', 'no such submission');
        if (row.status !== 'pending') fail(409, 'bot.submission_closed', `it is already ${row.status}`);
        const why = text(note, 'note', 1000) || null;
        const at = iso(now());
        if (decision === 'reject') {
            if (!why) fail(422, 'bot.invalid_input', 'say why, so its submitter can fix it');
            await db.query("UPDATE profile_submissions SET status = 'rejected', review_note = $2, reviewed_by = $3, reviewed_at = $4, updated_at = $4 WHERE id = $1", [id, why, reviewer.subject, at]);
            return get(id);
        }
        if (decision !== 'approve') fail(422, 'bot.invalid_input', 'decision is approve or reject');
        if (!signer) fail(503, 'bot.signing_unavailable', 'no profile signing key is configured (BOT_PROFILE_SIGNING_KEY)');
        const profile = typeof row.profile === 'string' ? JSON.parse(row.profile) : row.profile;
        const checked = checkProfile(profile);   // the rules may have moved since it was submitted
        if (!checked.valid) fail(422, 'bot.profile_invalid', checked.problems.join('; '));
        const signature = crypto.sign(null, Buffer.from(canonicalJson(checked.profile)), signer.key).toString('base64');
        await db.tx(async (t) => {
            const taken = await t.maybe('SELECT 1 FROM robot_profiles WHERE id = $1 AND version = $2', [row.profile_id, row.profile_version]);
            if (taken) fail(409, 'bot.profile_version', 'that version is already in the catalogue');
            await t.query('INSERT INTO robot_profiles (id, version, profile, created_at) VALUES ($1, $2, $3::jsonb, $4)', [row.profile_id, row.profile_version, JSON.stringify(checked.profile), at]);
            await t.query(`UPDATE profile_submissions SET status = 'approved', review_note = $2, reviewed_by = $3, reviewed_at = $4, updated_at = $4, signature = $5, key_id = $6
                WHERE id = $1`, [id, why, reviewer.subject, at, signature, signer.keyId]);
        });
        return get(id);
    }

    async function signatureFor(profileId, version) {
        const row = await db.maybe("SELECT signature, key_id FROM profile_submissions WHERE profile_id = $1 AND profile_version = $2 AND status = 'approved'", [profileId, version]);
        return row && row.signature ? { alg: ALG, key_id: row.key_id, value: row.signature } : null;
    }

    function signingKey() { return signer ? { alg: ALG, key_id: signer.keyId, public_key_pem: signer.publicPem } : null; }

    return { submit, withdraw, review, get, mine, pending, community, signatureFor, signingKey };
}

module.exports = { createSubmissions, canonicalJson, loadKey, COMMUNITY_ID, LICENSES };
