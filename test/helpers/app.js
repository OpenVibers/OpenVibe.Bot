'use strict';
/**
 * Boots Bot against the stubs on a random port with a migrated database of its own (helpers/db.js:
 * PGlite, or the containers with BOT_TEST_STORE=pg). Jobs are off: tests drive the queue sweep and the
 * outbox explicitly. The realtime hub is attached to the HTTP server's upgrade event, exactly as
 * server/index.js does.
 *
 *   t.call(method, path, { body, user, cap, sub, token, headers })   user → Bearer user JWT;
 *                                                                    otherwise a service token with `cap`
 *   t.ws(path, { headers })                                          a WebSocket client: .send, .waitFor
 *   t.clock.offset                                                   advance the injected clock (ms)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { startNetwork, startEvents } = require('./stubs');
const { testDb } = require('./db');

async function boot(opts = {}) {
    const network = await startNetwork();
    const events = await startEvents();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
    const env = {
        NODE_ENV: 'test',
        BASE_URL: 'http://bot.test',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'bot',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        EVENTS_URL: events.url,
        EVENTS_RELAY_INTERVAL_MS: '50',
        BOT_JOBS: 'off',
        BOT_HEARTBEAT_MS: '200',
        BOT_OFFLINE_MISSES: '2',
        BOT_OFFLINE_GRACE_MS: '0',
        BOT_ROTATE_GRACE_MS: '60000',
        BOT_QUEUE_TURN_MS: '60000',
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const { seedProfiles } = require('../../server/profiles');
    const config = loadConfig(env);
    const clock = { offset: 0 };
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const store = opts.db ? { db: opts.db, store: opts.db.store, close: async () => {} } : await testDb({ store: opts.store });
    await seedProfiles(store.db, { log: { log() {} } });
    const app = createApp({ config, db: store.db, valkey: opts.valkey || null, now: () => Date.now() + clock.offset, log, ...(opts.appOpts || {}) });
    await app.locals.keys.load();
    const server = await new Promise((resolve) => {
        const s = http.createServer(app);
        s.on('upgrade', (req, socket, head) => app.locals.hub.handleUpgrade(req, socket, head));
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const domain = app.locals.domain;
    const hub = app.locals.hub;

    let n = 0;
    async function call(method, p, { body, user, cap = ['bot.*'], sub = 'svc:live', key, token, headers = {} } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || (user ? network.signUser(user) : network.signService({ sub, cap }))}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if ((method === 'POST' || method === 'PATCH') && key !== null) h['Idempotency-Key'] = key || `test-${process.pid}-${++n}-${crypto.randomBytes(4).toString('hex')}`;
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    // The test host runs many jobs at once, so a socket's connect or a small frame can be delayed by
    // seconds even when the server is healthy; wait long enough that only a real hang fails a test.
    const SOCKET_WAIT_MS = 20000;

    /** A WebSocket client to /device or /control. waitFor(pred) resolves the first matching frame. */
    function ws(p, { headers = {} } = {}) {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(`${base.replace('http', 'ws')}${p}`, { headers });
            const client = { ws: socket, messages: [], ended: false, waiters: [], closeCode: null };
            const timer = setTimeout(() => reject(new Error(`ws open timeout on ${p}`)), SOCKET_WAIT_MS);
            socket.on('message', (raw) => {
                let m; try { m = JSON.parse(raw.toString()); } catch { return; }
                client.messages.push(m);
                client.waiters = client.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
            });
            socket.on('close', (code) => { clearTimeout(timer); client.ended = true; client.closeCode = code; client.waiters.forEach((w) => w.resolve(null)); client.waiters = []; if (client.onClose) client.onClose(code); });
            socket.on('error', () => { /* close follows */ });
            socket.on('open', () => { clearTimeout(timer); resolve(client); });
            client.send = (o) => socket.send(JSON.stringify(o));
            client.waitFor = (pred, ms = SOCKET_WAIT_MS) => new Promise((ok, fail) => {
                const hit = client.messages.find(pred);
                if (hit) return ok(hit);
                if (client.ended) return ok(null);
                const w = { pred, resolve: ok };
                client.waiters.push(w);
                setTimeout(() => { client.waiters = client.waiters.filter((x) => x !== w); fail(new Error(`waitFor timed out; got ${JSON.stringify(client.messages.map((m) => m.type))}`)); }, ms).unref();
            });
            client.waitForClose = (ms = SOCKET_WAIT_MS) => new Promise((ok) => {
                if (client.ended) return ok(client.closeCode);
                client.onClose = (code) => ok(code);
                setTimeout(() => ok(null), ms).unref();
            });
            client.close = () => { try { socket.close(); } catch { /* gone */ } };
        });
    }

    /** A robot owned by `ownerSubject`, created through the API so the pairing code is real. */
    async function robot(ownerUser, body = {}) {
        const r = await call('POST', '/api/v1/robots', { user: ownerUser, body: { name: 'Test rover', profile_id: 'sim.rover', ...body } });
        if (r.status !== 201) throw new Error(`robot setup: ${r.status} ${r.text}`);
        return r.json;
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    return {
        app, base, call, ws, robot, wait, domain, hub, db: domain.db, store, config, clock, network, events, logs, dir,
        outboxRows: async (type) => (await domain.db.many('SELECT envelope FROM bot_event_outbox ORDER BY id')).map((r) => r.envelope).filter((e) => !type || e.event_type === type),
        close: async () => {
            await hub.close().catch(() => {});
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
            await app.locals.outbox.stop();
            await Promise.all([network.close(), events.close()]);
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done };
