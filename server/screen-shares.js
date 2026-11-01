'use strict';
/**
 * Screen share links (migrations/0022_screen_shares.sql; owner 2026-10-25: "a screen you can watch and use … with
 * other users … all together"). A machine's owner makes a link to its live screen and puts it where a group works (a
 * workspace room on OpenVibe.Chat shows it beside the conversation):
 *
 *   watch       holders see the screen live (the machine's own private OpenRestream stream, as /machines/:id/screen)
 *   use         holders also start the screen when it is off, and use the mouse and keyboard: each action is an
 *               `input` command to the machine as its owner, judged by the level the owner set on the machine (at
 *               `ask` each waits for approval there; `observe` refuses), audited with the link's id
 *
 * The token is shown once (Bot keeps its sha256). A link stops at once when revoked, when its end date passes, or when
 * the machine is removed. Nothing here lets a holder run programs, read files or point the screen elsewhere: only the
 * screen's start and stop, and the mouse and keyboard.
 *
 *   create(device, owner, { label, control, days, minutes, desk })  → { share, token }; the desk is any desk the
 *                                                   machine has (main, private or desk-<name>: an agent task's own
 *                                                   desk, plan L55), and the link ends in days or, when `minutes` is
 *                                                   given, in 5 to 240 minutes
 *   list(device, owner) / revoke(device, owner, id)
 *   open(token)                                     → { share, device } or null
 *   state(token) / start(token) / stop(token)        the screen, through the link
 *   input(token, value)                             a `bot.command@1` input value (click, double_click, right_click,
 *                                                   move, scroll, type, key) → the machine's answer
 */
const { BotError, prefixedId, sha256, token: newToken } = require('./util');
const { inputValue, ACTIONS, DESK } = require('./machine-screen');

const DAYS = { min: 1, max: 365, default: 30 };
// A link made in minutes (an agent's desk, watched for one turn) ends sooner than one made in days (plan L55).
const MINUTES = { min: 5, max: 240, default: 60 };
const PER_SECOND = 8;           // a person clicks and types a few times a second, not more

function createScreenShares({ db, domain, hub, machineScreen, now = () => Date.now() }) {
    const rate = new Map();     // share id → recent input timestamps (this process)

    const shape = (r) => ({
        id: r.id, device_id: r.device_id, label: r.label || null, control: !!r.control, desk: r.desk || 'main',
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        expires_at: r.expires_at ? (r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at) : null,
        last_used_at: r.last_used_at ? (r.last_used_at instanceof Date ? r.last_used_at.toISOString() : r.last_used_at) : null,
    });

    async function create(device, owner, { label = null, control = false, days = DAYS.default, minutes = null, desk = 'main' } = {}) {
        if (!device || device.owner_subject !== owner) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        // Any desk the machine has: its own screen (main), the private desk, or an agent task's own desk (desk-<name>).
        const where = desk == null || desk === '' ? 'main' : String(desk);
        if (!DESK.test(where)) throw new BotError(422, 'bot.invalid_input', 'desk is main, private or desk-<name>');
        // A link may end in minutes (an agent's desk, watched for one turn) or in days (the owner's own link).
        let ends;
        if (minutes != null && minutes !== '') {
            const m = Number(minutes);
            if (!Number.isInteger(m) || m < MINUTES.min || m > MINUTES.max) throw new BotError(422, 'bot.invalid_input', `minutes is a whole number from ${MINUTES.min} to ${MINUTES.max}`);
            ends = now() + m * 60000;
        } else {
            const d = Number(days);
            if (!Number.isInteger(d) || d < DAYS.min || d > DAYS.max) throw new BotError(422, 'bot.invalid_input', `days is a whole number from ${DAYS.min} to ${DAYS.max}`);
            ends = now() + d * 86400000;
        }
        const id = prefixedId('shr', now());
        const t = newToken(32);
        const l = label == null ? null : String(label).replace(/\s+/g, ' ').trim().slice(0, 80) || null;
        await db.query(`INSERT INTO machine_screen_shares (id, device_id, owner_subject, token_hash, label, control, created_at, expires_at, desk)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [id, device.id, owner, sha256(t), l, !!control, new Date(now()), new Date(ends), where]);
        const row = await db.maybe('SELECT * FROM machine_screen_shares WHERE id = $1', [id]);
        return { share: shape(row), token: t };
    }

    async function list(device, owner) {
        if (!device || device.owner_subject !== owner) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        const rows = await db.many('SELECT * FROM machine_screen_shares WHERE device_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) ORDER BY created_at DESC', [device.id, new Date(now())]);
        return rows.map(shape);
    }

    async function revoke(device, owner, id) {
        if (!device || device.owner_subject !== owner) throw new BotError(404, 'bot.device_not_found', 'no such machine of yours');
        const r = await db.query('UPDATE machine_screen_shares SET revoked_at = $3 WHERE id = $1 AND device_id = $2 AND revoked_at IS NULL', [String(id), device.id, new Date(now())]);
        return { revoked: (r.rowCount || r.changes || 0) > 0 };
    }

    /** The link behind a token, while it may be used: { share, device } or null (one answer for every reason). */
    async function open(t) {
        if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(t)) return null;
        const row = await db.maybe('SELECT * FROM machine_screen_shares WHERE token_hash = $1', [sha256(t)]);
        if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= now())) return null;
        const device = await db.maybe('SELECT * FROM devices WHERE id = $1 AND revoked_at IS NULL', [row.device_id]);
        if (!device || device.owner_subject !== row.owner_subject) return null;
        const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
        if (now() - last > 60000) await db.query('UPDATE machine_screen_shares SET last_used_at = $2 WHERE id = $1', [row.id, new Date(now())]);
        return { share: row, device };
    }

    async function must(t, { control = false } = {}) {
        const s = await open(t);
        if (!s) throw new BotError(404, 'bot.share_not_found', 'this screen link does not work: it was stopped, it ended, or it never existed');
        if (control && !s.share.control) throw new BotError(403, 'bot.share_watch_only', 'this link is for watching only');
        return s;
    }

    const asShare = (s) => ({ kind: 'share', sub: s.share.owner_subject, share: s.share.id });

    async function state(t) {
        const s = await must(t);
        const st = await machineScreen.state(s.device, s.share.owner_subject);
        return { ...st, name: s.device.name || 'A computer', control: !!s.share.control, label: s.share.label || null, desk: s.share.desk || 'main' };
    }

    async function start(t) {
        const s = await must(t, { control: true });
        return await machineScreen.start(s.device, s.share.owner_subject, asShare(s), { seconds: 1800, fps: 4, desk: s.share.desk || 'main' });
    }

    async function stop(t) {
        const s = await must(t, { control: true });
        return await machineScreen.stop(s.device, s.share.owner_subject, asShare(s));
    }

    /** One mouse or keyboard action through the link, as the owner, at the machine's own level. */
    async function input(t, value = {}) {
        const s = await must(t, { control: true });
        if (!hub) throw new BotError(503, 'bot.unavailable', 'machines are not connected here');
        const out = inputValue(value);
        if (s.share.desk && s.share.desk !== 'main') out.desk = s.share.desk;   // a desk link drives the desk, never the owner's screen
        const recent = (rate.get(s.share.id) || []).filter((x) => now() - x < 1000);
        if (recent.length >= PER_SECOND) throw new BotError(429, 'bot.rate_limited', 'slow down a little');
        recent.push(now());
        rate.set(s.share.id, recent);
        const r = await hub.machineCommand(s.device.id, asShare(s), s.share.owner_subject, { kind: 'input', value: out, ms: 15000 });
        if (r && r.result === 'ack') return { done: true };
        const code = (r && r.code) || 'bot.device_refused';
        throw new BotError(r && r.result === 'expired' ? 504 : 409, code.startsWith('bot.') ? code : 'bot.device_refused', `the computer did not do it: ${(r && (r.reason || r.result)) || 'no answer'}`.slice(0, 300));
    }

    return { create, list, revoke, open, state, start, stop, input, DAYS, MINUTES };
}

module.exports = { createScreenShares, ACTIONS };
