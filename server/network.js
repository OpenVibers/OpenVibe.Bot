'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 signing keys: openvibe-sdk/auth createNetworkKeys (OV_NETWORK_PUBLIC_KEY pinned,
 *             else the JWKS, retried every 30 s until it loads, refreshed every 15 minutes, a rotation followed on an
 *             unknown kid). They verify service and node tokens (audience openvibe.bot) and the browser's Network
 *             user JWT, all offline (openvibe-sdk/auth).
 *   nodes     Network's node principals (machines paired for Bot): POST /internal/node-pairings (a pairing
 *             code, BOT_PAIRING_AUTHORITY=network), GET /internal/node-principals/:id and POST …/:id/revoke with
 *             Bot's own svc:bot token (audience openvibe.network, network.node.manage).
 *   identity  Network's people (identity.subject.resolve): resolve a username to a subject and look up the
 *             names of subjects the robot's owner added.
 */
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');
const { createNetworkKeys, verifyUserToken } = require('openvibe-sdk/auth');
const { serviceAuth } = require('openvibe-contracts');
const { BotError } = require('./util');

/** keys.verifyOptions (spread into the openvibe-sdk/auth verifiers), keys.loaded(), keys.start(), keys.stop(), keys.refresh(). */
function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    return createNetworkKeys({ network: config.network.internalUrl, publicKey: config.network.publicKey || null, fetch: fetchImpl, log });
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
    /**
     * Claims of a valid user token, or null. openvibe-sdk/auth verifyUserToken refuses service, app and mod principals
     * and typed tokens (a realtime ticket, a FedCM assertion, an export token); a node token (a machine paired for Bot)
     * is refused here too.
     */
    async function verify(token) {
        if (!token) return null;
        let claims;
        try { claims = await verifyUserToken(String(token), { ...keys.verifyOptions, issuer: config.network.issuer }); } catch { return null; }
        if (typeof claims.sub === 'string' && /^node:/.test(claims.sub)) return null;
        if (claims.actor_type === 'node') return null;
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

/**
 * Network's identity resolution for people (usernames ↔ subjects), with Bot's own svc:bot token
 * (audience openvibe.network, identity.subject.resolve — Network grants Bot this).
 *   byUsername(name) → GET /internal/identity/resolve?username=<name> → { subject, username, display_name },
 *                     or null when Network knows no such person (a 404 whose problem code is
 *                     identity.subject_not_found).
 *   names(subjectIds) → POST /internal/identity/resolve-batch { subject_ids } → Map(subject → { username,
 *                     display_name }), skipping the ids Network does not know. Answers are cached in memory
 *                     for five minutes, at most 2000 subjects.
 * Any other failure throws 503 bot.network_unavailable.
 */
function createIdentity(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.network.internalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve', fetchImpl,
    });
    const TTL_MS = 5 * 60 * 1000;
    const MAX_ENTRIES = 2000;
    const cache = new Map();   // subject → { username, display_name, at }
    async function call(method, path, body) {
        let res;
        try {
            res = await fetchImpl(`${config.network.internalUrl}${path}`, {
                method, headers: { ...(await tokens.authHeaders()), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
            });
        } catch (e) {
            throw new BotError(503, 'bot.network_unavailable', `Network did not answer to resolve a person: ${e.message}`);
        }
        if (res.status === 401) tokens.invalidate();
        const out = await res.json().catch(() => null);
        // Only Network's own "no such person" is null. A 404 from a Network that lacks the route (or any
        // other 404) and a 400 identity.bad_request are an outage, never "no such account".
        if (method === 'GET' && res.status === 404 && out && out.code === 'identity.subject_not_found') return null;
        if (!res.ok || !out) throw new BotError(503, 'bot.network_unavailable', `Network answered ${res.status} for identity`);
        return out;
    }
    function remember(subject, p) {
        if (!subject || !p || typeof p.username !== 'string' || !p.username) return;
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(subject, { username: p.username, display_name: typeof p.display_name === 'string' && p.display_name ? p.display_name : p.username, at: now() });
    }
    async function byUsername(name) {
        const out = await call('GET', `/internal/identity/resolve?username=${encodeURIComponent(name)}`);
        if (!out || typeof out.subject !== 'string') return null;
        remember(out.subject, out);
        return { subject: out.subject, username: out.username, display_name: out.display_name || out.username };
    }
    async function names(subjectIds) {
        const ids = [...new Set((subjectIds || []).filter((s) => typeof s === 'string' && s))];
        const found = new Map();
        const missing = [];
        for (const id of ids) {
            const hit = cache.get(id);
            if (hit && now() - hit.at < TTL_MS) found.set(id, { username: hit.username, display_name: hit.display_name });
            else missing.push(id);
        }
        for (let i = 0; i < missing.length; i += 500) {
            const out = await call('POST', '/internal/identity/resolve-batch', { subject_ids: missing.slice(i, i + 500) });
            for (const [subject, p] of Object.entries((out && out.results) || {})) {
                if (!p || typeof p.username !== 'string') continue;
                remember(subject, p);
                found.set(subject, { username: p.username, display_name: p.display_name || p.username });
            }
        }
        return found;
    }
    return { byUsername, names };
}

module.exports = { createKeyProvider, createUserAuth, createNodePrincipals, createIdentity };
