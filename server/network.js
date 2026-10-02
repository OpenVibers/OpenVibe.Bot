'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 public key (OV_NETWORK_PUBLIC_KEY, else GET /api/.well-known/jwks,
 *             refreshed every 6 h and retried every 30 s until it loads). It verifies service tokens
 *             (audience openvibe.bot) and the browser's Network user JWT, both offline.
 *   nodes     Network's node principals (machines paired for Bot): POST /internal/node-pairings (a pairing
 *             code, BOT_PAIRING_AUTHORITY=network), GET /internal/node-principals/:id and POST …/:id/revoke with
 *             Bot's own svc:bot token (audience openvibe.network, network.node.manage).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');
const { serviceAuth } = require('openvibe-contracts');
const { BotError } = require('./util');

function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    let pem = config.network.publicKey ? crypto.createPublicKey(config.network.publicKey).export({ type: 'spki', format: 'pem' }) : null;
    let timer = null;
    async function load() {
        const url = `${config.network.internalUrl}/api/.well-known/jwks`;
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`JWKS ${res.status}`);
            const body = await res.json();
            const jwk = (body.keys || []).find((k) => k.kty === 'RSA');
            if (jwk) pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
            else if (typeof body.public_key === 'string') pem = crypto.createPublicKey(body.public_key).export({ type: 'spki', format: 'pem' });
            else throw new Error('JWKS contained no keys');
            return pem;
        } catch (e) {
            log.warn(`[Bot] Network key not loaded from ${url}: ${e.message}`);
            return null;
        }
    }
    function start() {
        if (config.network.publicKey || timer) return;
        const retry = () => load().then((k) => { if (!k) setTimeout(retry, 30_000).unref(); });
        retry();
        timer = setInterval(async () => { await load(); }, 6 * 60 * 60 * 1000);
        timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { get: () => pem, load, start, stop };
}

/** The OAuth client of the browser session layer plus offline verification of the Network user JWT. */
function createUserAuth(config, keys) {
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        publicKey: null,
        authBase: config.network.url,
        internalBase: config.network.internalUrl,
    });
    /** Claims of a valid user token, or null. Service tokens are never user tokens. */
    function verify(token) {
        if (!token) return null;
        const key = keys.get();
        if (!key) return null;
        let claims;
        try { claims = jwt.verify(token, key, { algorithms: ['RS256'], issuer: config.network.issuer }); } catch { return null; }
        if (!claims || typeof claims !== 'object') return null;
        if (typeof claims.sub === 'string' && /^(svc|app|mod|node):/.test(claims.sub)) return null;
        if (claims.actor_type === 'service' || claims.actor_type === 'node') return null;
        return claims;
    }
    return { client, verify };
}

/**
 * Network's view of a node principal (OpenVibe.Network server/registry/node-principals.js principalView):
 * { principal, node_id, name, owner{kind,subject}, home_cell, status, paired_for{service,ref}|null, … }.
 * get(id) → that view, or null when Network knows no such principal paired by Bot (it answers 404, never 403).
 * revoke(id) → the revoked view, or null for the same 404; idempotent on Network's side.
 * pair({subject, ref}) → { pairing_id, code, expires_at }: a one-time code for the person `subject` to pair a
 * machine for robot `ref` (POST /internal/node-pairings; Network keeps one live code per ref).
 * Any other failure throws 503 bot.network_unavailable.
 */
function createNodePrincipals(config, { fetchImpl = globalThis.fetch } = {}) {
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.node.manage', fetchImpl,
    });
    async function call(method, path, body) {
        let res;
        try {
            res = await fetchImpl(`${config.network.internalUrl}${path}`, {
                method, headers: { ...(await tokens.authHeaders()), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
            });
        } catch (e) {
            throw new BotError(503, 'bot.network_unavailable', `Network did not answer for the machine: ${e.message}`);
        }
        if (res.status === 401) tokens.invalidate();
        if (res.status === 404 && !body) return null;
        const out = await res.json().catch(() => null);
        if (!res.ok || !out) throw new BotError(503, 'bot.network_unavailable', `Network answered ${res.status} for the machine`);
        return out;
    }
    const principal = (id) => `/internal/node-principals/${encodeURIComponent(id)}`;
    return {
        get: (id) => call('GET', principal(id)),
        revoke: (id) => call('POST', `${principal(id)}/revoke`),
        pair: ({ subject, ref }) => call('POST', '/internal/node-pairings', { owner: { kind: 'user', subject }, ref }),
    };
}

module.exports = { createKeyProvider, createUserAuth, createNodePrincipals };
