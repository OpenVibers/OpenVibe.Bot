'use strict';

/** Small shared pieces: ids, time, the error type, input checks, hashing, cursors. */
const crypto = require('crypto');
const { ids, validate } = require('openvibe-contracts');

class BotError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

function fail(status, code, detail, extra) { throw new BotError(status, code, detail, extra); }

const prefixedId = (prefix, ms = Date.now()) => `${prefix}_${ids.ulid(ms)}`;
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** A random token: `bytes` bytes, base64url (URL-safe, no padding). */
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
/** A secret's storage form: a salted hash is unnecessary here (32 random bytes have no dictionary). */
const hashSecret = (s) => sha256(s);
const json = (v, d) => { if (v == null || v === '') return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

/** Constant-time equality of two hex strings (length-independent enough for stored hashes). */
function secretEquals(a, b) {
    const x = Buffer.from(String(a || ''), 'utf8');
    const y = Buffer.from(String(b || ''), 'utf8');
    if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
    return crypto.timingSafeEqual(x, y);
}

// PostgreSQL stores no NUL character in text or jsonb: every text from outside goes through storable().
const NUL = /\u0000/g;
const storable = (v) => String(v).toWellFormed().replace(NUL, '');

/** Optional trimmed text: null when empty, refused when longer than max. */
function text(v, field, max) {
    if (v == null) return null;
    const s = storable(v).replace(/\r\n?/g, '\n').trim();
    if (!s) return null;
    if (s.length > max) fail(422, 'bot.text_too_long', `${field} must be at most ${max} characters`);
    return s;
}

/** A user SubjectRef or bare usr_ id → the subject id. */
function userSubject(v, field = 'subject') {
    const ref = typeof v === 'string' ? { type: 'user', id: v } : v;
    if (!ref || !validate('identity.subject-ref@1', ref).valid || ref.type !== 'user' || !ids.isSubjectId('user', ref.id)) {
        fail(422, 'bot.invalid_subject', `${field} must be a user SubjectRef ({ type: 'user', id: 'usr_…' })`);
    }
    return ref.id;
}

/** A robot id (rob_…) or null. */
const isRobotId = (v) => typeof v === 'string' && /^rob_[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

/** A database refusal the caller caused (a value PostgreSQL cannot store) → the BotError to answer with, else null. */
function inputError(e) {
    const code = e && (e.code || (e.cause && e.cause.code));
    return ['22021', '22P05', '22P02', '22007', '22008'].includes(code)
        ? new BotError(422, 'bot.invalid_input', 'the request carries a value that cannot be stored (such as a NUL character)') : null;
}

/** A keyset cursor: base64url JSON [at ISO, id] → the pair, or 422; cursorOf(row) makes one. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
function readCursor(cursor) {
    let cur = null;
    try { cur = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* refused below */ }
    if (!Array.isArray(cur) || typeof cur[0] !== 'string' || !ISO_RE.test(cur[0]) || !Number.isInteger(cur[1])) fail(422, 'bot.invalid_input', 'bad cursor');
    return cur;
}
const cursorOf = (row) => Buffer.from(JSON.stringify([row.at, Number(row.id)])).toString('base64url');

module.exports = {
    BotError, fail, prefixedId, iso, sha256, token, hashSecret, secretEquals, json,
    storable, text, userSubject, isRobotId, inputError, readCursor, cursorOf,
};
