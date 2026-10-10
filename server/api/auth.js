'use strict';

/**
 * Who is calling /api/v1 — resolved into req.principal:
 *
 *   { kind: 'service', sub: 'svc:live', cap: [...] }   a Network client-credentials token for audience
 *                                                       openvibe.bot; each route checks ONE capability
 *   { kind: 'node', principal: 'nod_…', sub: 'node:nod_…' }   a Network node token (actor_type node, audience
 *                                                       openvibe.bot): a machine paired for Bot; it may only bind
 *   { kind: 'user', subject: 'usr_…', username, name, avatar, role }
 *   { kind: 'anonymous' }
 *
 * A request that presents a token is judged on that token alone: a bad one is refused, never downgraded.
 */
const contracts = require('openvibe-contracts');
const { verifyServiceToken } = require('openvibe-sdk/auth');

const { capabilities, http, ids } = contracts;

const PRINCIPAL_SUB = /^(svc|app|mod|node):/;
const NODE_SUB = /^node:(nod_[0-9A-HJKMNP-TV-Z]{26})$/;
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

/**
 * The pinned contracts rules with the key the token's kid names (openvibe-sdk/auth verifyServiceToken). No key yet is
 * identity.unavailable (a 503), as before.
 */
async function principalToken(token, { keyOptions, issuer, audience }) {
    const r = await verifyServiceToken(token, { ...keyOptions, issuer, audience, contracts });
    if (!r.ok && r.code === 'token.unavailable') return { ok: false, code: 'identity.unavailable', reason: 'the Network signing key is not loaded yet' };
    return r;
}

/** Verify a service token (audience openvibe.bot). Returns { ok, claims } or { ok:false, code, reason }. */
async function verifyService(token, opts) {
    const payload = decodePayload(token);
    if (!payload || typeof payload.sub !== 'string' || !PRINCIPAL_SUB.test(payload.sub)) return { ok: false, code: 'token.invalid', reason: 'not a service token' };
    const r = await principalToken(token, opts);
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
    return { ok: true, claims: r.claims };
}

/** A Bearer that claims to be a node token (actor_type node); verifyNode decides whether it is one. */
function isNodeToken(token) {
    const payload = decodePayload(token);
    return !!payload && payload.actor_type === 'node';
}

/**
 * Verify a node token: signed by Network, audience openvibe.bot, actor_type node, sub node:nod_…
 * Returns { ok, principal: 'nod_…', claims } or { ok:false, code, reason }.
 */
async function verifyNode(token, opts) {
    const r = await principalToken(token, opts);
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason };
    const m = NODE_SUB.exec(String(r.claims.sub || ''));
    if (r.claims.actor_type !== 'node' || !m) return { ok: false, code: 'token.invalid', reason: 'not a node token' };
    return { ok: true, principal: m[1], claims: r.claims };
}

function createApiAuth({ config, keys, userAuth }) {
    const opts = () => ({ keyOptions: keys.verifyOptions, issuer: config.network.issuer, audience: config.audience });

    async function resolve(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ')) return { principal: ANON };
        const token = header.slice(7).trim();
        if (!keys.loaded()) return { error: [503, 'identity.unavailable', 'the Network signing key is not loaded yet'] };
        const payload = decodePayload(token);
        if (payload && payload.actor_type === 'node') {
            const r = await verifyNode(token, opts());
            if (!r.ok) return { error: [401, r.code, r.reason] };
            return { principal: { kind: 'node', principal: r.principal, sub: r.claims.sub, jti: r.claims.jti } };
        }
        if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
            const r = await principalToken(token, opts());
            if (!r.ok) return { error: [r.code === 'identity.unavailable' ? 503 : 401, r.code, r.reason] };
            return { principal: { kind: 'service', sub: r.claims.sub, cap: r.claims.cap || [], jti: r.claims.jti } };
        }
        const claims = await userAuth.verify(token);
        if (!claims) return { error: [401, 'token.invalid', 'the user token is invalid or expired'] };
        const p = userPrincipal(claims);
        if (!p) return { error: [403, 'identity.no_subject', 'this account has no canonical subject yet; sign in again'] };
        return { principal: p };
    }

    function middleware(req, res, next) {
        resolve(req).then((r) => {
            if (r.error) return http.sendProblem(res, r.error[0], r.error[1], { detail: r.error[2], ctx: req.ov });
            req.principal = r.principal;
            return next();
        }, next);
    }

    const granted = (p, cap) => p.kind === 'service' && capabilities.grants(p.cap, cap);

    return { middleware, resolve, granted };
}

module.exports = { createApiAuth, userPrincipal, verifyService, verifyNode, isNodeToken, decodePayload, PRINCIPAL_SUB };
