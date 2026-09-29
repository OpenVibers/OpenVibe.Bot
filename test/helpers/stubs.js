'use strict';
/**
 * Stand-ins for the services Bot talks to, each on a random port.
 *
 *   startNetwork()  JWKS and user/service JWTs (signUser, signService, newUser)
 *   startEvents()   POST /api/v1/events recording what Bot's outbox relays; GET /api/health
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
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    return { url, publicPem, signService, signUser, newUser, close: () => new Promise((r) => server.close(r)) };
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

module.exports = { startNetwork, startEvents };
