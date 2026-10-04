'use strict';
/**
 * Stand-ins for the services Bot talks to, each on a random port.
 *
 *   startNetwork()  JWKS and user/service JWTs (signUser, signService, newUser); node principals as
 *                   GET /internal/node-principals/:id and POST …/:id/revoke answer them (addNode, signNode,
 *                   nodes, revokes), scoped to the calling service like Network's own routes
 *   startEvents()   POST /api/v1/events recording what Bot's outbox relays; GET /api/health
 *   startOpenRe()   OpenRe.Stream's stream routes Bot calls (server/api/v1.js there): GET /api/v1/streams?external_ref=,
 *                   POST /api/v1/streams, POST …/:id/keys/rotate, DELETE …/:id (409 while live), behind one bearer
 *                   token whose capabilities OpenRe's guards check (setCaps(list) to narrow them; 403
 *                   capability.denied). streams, calls (every request, its token and X-OV-Subject), admits(key)
 *                   (OpenRe's resolveIngestKey: an active key or one in grace), failNext(status | 'hang')
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function readBody(req) {
    return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let issuer = 'http://network.test';
    let n = 100;

    function signService({ sub = 'svc:live', aud = ['openvibe.bot'], cap = [], expSec = 300 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: 'service', aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex') }, privatePem);
    }
    function signUser(u) {
        return jwt.sign({ sub: String(u.networkId || ++n), subject_id: u.subject, username: u.username, display_name: u.display_name || u.username, role: u.role || 'user' },
            privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    // Node principals: the view Network's principalView answers (server/registry/node-principals.js).
    // `unscoped: true` answers a principal to any service, so Bot's own paired_for check is exercised too.
    const nodes = new Map();
    const revokes = [];
    function addNode({ owner, ref, service = 'bot', status = 'active', name = 'garage-pi', unscoped = false } = {}) {
        const id = ids.newId('node');
        nodes.set(id, {
            unscoped,
            view: {
                principal: id, node_id: `n-${id.slice(4).toLowerCase()}`, name, owner: { kind: 'user', subject: owner },
                home_cell: 'cell-eu-1', status, paired_for: service ? { service, ref } : null,
                last_seen_at: null, created_at: new Date().toISOString(), revoked_at: status === 'revoked' ? new Date().toISOString() : null,
            },
        });
        return id;
    }
    function signNode(principal, { aud = ['openvibe.bot'], expSec = 300 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: issuer, sub: `node:${principal}`, actor_type: 'node', aud, cap: [], iat: now, exp: now + expSec, jti: `tok_${crypto.randomBytes(12).toString('hex')}` }, privatePem);
    }
    /** The calling service (svc:<id> → <id>) of a valid network.node.manage token for openvibe.network, or null. */
    function nodeManager(req) {
        const h = String(req.headers.authorization || '');
        const r = serviceAuth.verifyServiceToken(h.slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
        if (!h.startsWith('Bearer ') || !r.ok || !(r.claims.cap || []).includes('network.node.manage')) return null;
        return r.claims.sub.replace(/^svc:/, '');
    }

    // Node pairings (POST /internal/node-pairings): every call is kept; failPairings(status) answers that status
    // instead (null: mint again).
    const pairings = [];
    let pairingFailure = null;
    const failPairings = (status) => { pairingFailure = status; };

    function newUser(username) {
        return { subject: ids.newId('user'), username, display_name: username[0].toUpperCase() + username.slice(1) };
    }

    const server = http.createServer(async (req, res) => {
        if (req.url === '/api/.well-known/jwks') return send(res, 200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/api/health') return send(res, 200, { ok: true });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
            if (body.client_secret !== 'shh') return send(res, 401, { error: 'invalid_client' });
            const cap = String(body.scope || '').split(/\s+/).filter(Boolean);
            return send(res, 200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience || 'openvibe.bot'], cap }), token_type: 'Bearer', expires_in: 300 });
        }
        if (req.url === '/internal/node-pairings' && req.method === 'POST') {
            const service = nodeManager(req);
            if (!service) return send(res, 401, { code: 'token.invalid' });
            if (pairingFailure) return send(res, pairingFailure, { code: 'registry.failed' });
            const body = JSON.parse(await readBody(req) || '{}');
            const code = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/^(.{4})/, '$1-');
            const out = { pairing_id: `pair_${ids.ulid()}`, code, expires_at: new Date(Date.now() + 600000).toISOString() };
            pairings.push({ service, body, ...out });
            return send(res, 201, out);
        }
        const np = /^\/internal\/node-principals\/([^/]+)(\/revoke)?$/.exec(req.url);
        if (np && (req.method === (np[2] ? 'POST' : 'GET'))) {
            const service = nodeManager(req);
            if (!service) return send(res, 401, { code: 'token.invalid' });
            const n = nodes.get(decodeURIComponent(np[1]));
            if (!n || (!n.unscoped && (!n.view.paired_for || n.view.paired_for.service !== service))) return send(res, 404, { code: 'registry.unknown_node' });
            if (np[2]) {
                revokes.push(n.view.principal);
                if (n.view.status !== 'revoked') Object.assign(n.view, { status: 'revoked', revoked_at: new Date().toISOString() });
            }
            return send(res, 200, n.view);
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    return { url, publicPem, signService, signUser, newUser, addNode, signNode, nodes, revokes, pairings, failPairings, close: () => new Promise((r) => server.close(r)) };
}

async function startEvents() {
    const events = [];
    const server = http.createServer(async (req, res) => {
        if (req.url === '/api/health') return send(res, 200, { ok: true });
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            let body = {};
            try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* ignore */ }
            const list = Array.isArray(body) ? body : (body.events || [body]);
            for (const e of list) if (e && e.event_id) events.push(e);
            return send(res, 200, { results: list.map((e) => ({ event_id: e && e.event_id, seq: events.length })) });
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    return { url, events, close: () => new Promise((r) => server.close(r)) };
}

// The capabilities BOT_OPENRE_TOKEN must hold: GET /streams is openre.stream.read, POST and DELETE
// openre.stream.write, keys/rotate openre.key.rotate (OpenRe server/api/v1.js guards).
const OPENRE_CAPS = ['openre.stream.read', 'openre.stream.write', 'openre.key.rotate'];

async function startOpenRe({ token = `ovt_${crypto.randomBytes(16).toString('hex')}`, caps = OPENRE_CAPS } = {}) {
    let granted = [...caps];
    // OpenRe's hasCap: the exact capability or a `.*` grant covering it.
    const hasCap = (id) => granted.some((g) => g === id || (g.endsWith('.*') && id.startsWith(g.slice(0, -1))));
    const streams = new Map();
    const calls = [];
    let failure = null;
    let n = 0;
    const newKey = () => {
        const key = `ork_${crypto.randomBytes(32).toString('base64url')}`;
        return { id: `key_${++n}`, key, hint: key.slice(-4), status: 'active', grace_until: null };
    };
    const view = (st) => ({ id: st.id, owner: { type: 'user', id: st.owner }, protocols: st.protocols, state: st.state, external_refs: st.refs,
        keys: st.keys.filter((k) => k.status !== 'revoked').map((k) => ({ id: k.id, hint: k.hint, status: k.status })) });
    const problem = (res, status, code, detail) => { res.writeHead(status, { 'Content-Type': 'application/problem+json' }); res.end(JSON.stringify({ type: 'about:blank', status, code, detail })); };
    function admits(key) {
        for (const st of streams.values()) {
            const k = st.keys.find((x) => x.key === key);
            if (k) return st.state === 'active' && (k.status === 'active' || (k.status === 'grace' && k.grace_until > Date.now()));
        }
        return false;
    }
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        const subject = req.headers['x-ov-subject'] || null;
        const url = new URL(req.url, 'http://openre.test');
        calls.push({ method: req.method, path: url.pathname, query: url.search, body, subject, authorization: req.headers.authorization || null });
        if (failure === 'hang') return;   // never answered: the client's timeout ends it
        if (failure) { const status = failure; failure = null; return problem(res, status, status >= 500 ? 'openre.internal' : 'openre.forbidden', `stubbed ${status}`); }
        if (req.headers.authorization !== `Bearer ${token}`) return problem(res, 401, 'token.invalid', 'a service token is required');
        const m = /^\/api\/v1\/streams(?:\/([^/]+)(\/keys\/rotate)?)?$/.exec(url.pathname);
        const need = m && (m[2] ? 'openre.key.rotate' : req.method === 'GET' ? 'openre.stream.read' : 'openre.stream.write');
        if (need && !hasCap(need)) return problem(res, 403, 'capability.denied', `${need} not granted`);
        if (!subject || !/^usr_/.test(subject)) return problem(res, 400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
        const mine = (id) => { const st = streams.get(id); return st && st.state !== 'archived' && st.owner === subject ? st : null; };
        if (url.pathname === '/api/v1/streams' && req.method === 'GET') {
            const [service, type, ...rest] = String(url.searchParams.get('external_ref') || '').split(':');
            const st = [...streams.values()].find((x) => x.state !== 'archived' && x.owner === subject && x.refs.some((r) => r.service === service && r.type === type && r.id === rest.join(':')));
            return send(res, 200, { streams: st ? [view(st)] : [] });
        }
        if (url.pathname === '/api/v1/streams' && req.method === 'POST') {
            const refs = (body && body.external_refs) || [];
            if (refs.some((r) => [...streams.values()].some((x) => x.state !== 'archived' && x.refs.some((y) => y.service === r.service && y.type === r.type && y.id === r.id)))) {
                return problem(res, 409, 'openre.ref_taken', 'already belongs to another stream definition');
            }
            const st = { id: `str_${++n}`, owner: subject, protocols: body.protocols, refs, state: 'active', live: false, keys: [newKey()] };
            streams.set(st.id, st);
            const k = st.keys[0];
            return send(res, 201, { stream: view(st), key: { id: k.id, key: k.key, hint: k.hint, shown_once: true } });
        }
        const st = m && m[1] && mine(decodeURIComponent(m[1]));
        if (m && m[1] && !st) return problem(res, 404, 'openre.stream_not_found', 'no such stream definition');
        if (st && m[2] && req.method === 'POST') {
            const grace = Math.max(0, Number(body && body.grace_seconds) || 0);
            const old = st.keys.filter((k) => k.status === 'active');
            for (const k of old) Object.assign(k, grace ? { status: 'grace', grace_until: Date.now() + grace * 1000 } : { status: 'revoked' });
            const k = newKey();
            st.keys.push(k);
            const ending = body && body.end_sessions && st.live ? 1 : 0;
            return send(res, 200, { key: { id: k.id, key: k.key, hint: k.hint, shown_once: true }, retired: old.map((x) => ({ id: x.id, hint: x.hint, status: x.status })), grace_until: null, sessions_ending: ending });
        }
        if (st && !m[2] && req.method === 'DELETE') {
            if (st.live) return problem(res, 409, 'openre.stream_live', 'end the live session before archiving this stream');
            st.state = 'archived';
            for (const k of st.keys) k.status = 'revoked';
            res.writeHead(204); return res.end();
        }
        problem(res, 404, 'not_found', 'not found');
    });
    const url = await listen(server);
    return {
        url, token, streams, calls, admits,
        failNext: (what) => { failure = what; },
        setCaps: (list) => { granted = [...(list || caps)]; },
        close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
    };
}

module.exports = { startNetwork, startEvents, startOpenRe };
