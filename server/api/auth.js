'use strict';

/**
 * Who is calling /api/v1 — resolved into req.principal:
 *
 *   { kind: 'service', sub: 'svc:live', cap: [...] }   a Network client-credentials token for audience
 *                                                       openvibe.bot; each route checks ONE capability
 *   { kind: 'user', subject: 'usr_…', username, name, avatar, role }
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded.
 */
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const ANON = Object.freeze({ kind: 'anonymous' });

function decodePayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** A Network user token's claims → the user principal (null when it names no subject). */
function userPrincipal(claims) {
    if (!claims) return null;
    const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
    if (!subject) return null;
    return {
        kind: 'user', subject, username: claims.username || null, name: claims.display_name || claims.username || null,
        avatar: claims.avatar_url || null, role: claims.role || 'user',
    };
}

/** Verify a service token (audience openvibe.bot). Returns { ok, claims } or { ok:false, code, reason }. */
function verifyService(token, { publicKey, issuer, audience }) {
    if (!publicKey) return { ok: false, code: 'identity.unavailable', reason: 'the Network signing key is not loaded yet' };
    const payload = decodePayload(token);
    if (!payload || typeof payload.sub !== 'string' || !PRINCIPAL_SUB.test(payload.sub)) return { ok: false, code: 'token.invalid', reason: 'not a service token' };
    const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer, audience });
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
    return { ok: true, claims: r.claims };
}

function createApiAuth({ config, keys, userAuth }) {
    function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { principal: ANON };
        const token = header.slice(7).trim();
        const publicKey = keys.get();
        if (!publicKey) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
        const payload = decodePayload(token);
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
            const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.network.issuer, audience: config.audience });
            if (!r.ok) return { error: [401, r.code, r.reason] };
            return { principal: { kind: 'service', sub: r.claims.sub, cap: r.claims.cap || [], jti: r.claims.jti } };
        }
        const claims = userAuth.verify(token);
        if (!claims) return { error: [401, 'token.invalid', 'the user token is invalid or expired'] };
        const p = userPrincipal(claims);
        if (!p) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
        return { principal: p };
    }

    function middleware(req, res, next) {
        const r = resolve(req);
        if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
        req.principal = r.principal;
        return next();
    }

    const granted = (p, cap) => p.kind === 'service' && capabilities.grants(p.cap, cap);

    return { middleware, resolve, granted };
}

module.exports = { createApiAuth, userPrincipal, verifyService, decodePayload, PRINCIPAL_SUB };
