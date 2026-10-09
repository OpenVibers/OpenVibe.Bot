'use strict';
/**
 * ADR-033: Bot's part of an account export and of an account deletion, through the signed loopback route
 * POST /internal/events with a stand-in Network. Alex owns a robot with a paired device and is an operator on Bob's
 * robot. The export carries Alex's robots and roles. The deletion removes Alex's robot the way its owner would (its
 * operators and command history with it), revokes the device that served only it, removes Alex's role on Bob's robot
 * and takes Alex's id out of Bob's command history, keeps Bob's robot, and confirms once.
 */
const assert = require('assert');
const http = require('http');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/app');

const SECRET = `whsec_${'fixture'.repeat(6)}`;

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_bot', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ env: { BOT_EVENTS_SECRET: SECRET }, appOpts: { accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'bot', clientSecret: 'shh' }) } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const db = t.db;
    const count = async (sql, args) => Number(await db.value(sql, args));
    const deliver = async (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        const res = await fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } });
        return { status: res.status, json: await res.json().catch(() => null) };
    };
    const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });
    let mine;
    let theirs;
    let deviceId;

    try {
        await check('alex\'s robot with a paired device, and alex as an operator on bob\'s robot', async () => {
            const made = await t.robot(alex, { name: 'Alex rover' });
            mine = made.robot;
            const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: mine.id, code: made.pairing.code } });
            assert.ok(paired.status < 300, paired.text);
            deviceId = paired.json.device_id || paired.json.device?.id || (await db.value("SELECT id FROM devices WHERE robot_ids @> $1::jsonb", [JSON.stringify([mine.id])]));
            theirs = (await t.robot(bob, { name: 'Bob rover' })).robot;
            const add = await t.call('POST', `/api/v1/robots/${theirs.id}/operators`, { user: bob, body: { subject: alex.subject, role: 'operator' } });
            assert.ok(add.status < 300, add.text);
            const at = new Date().toISOString();
            await db.exec(`INSERT INTO command_audit (robot_id, operator_subject, operator_kind, role, kind, result, at) VALUES
                ($1, $2, 'user', 'operator', 'drive', 'ack', $4), ($3, $5, 'user', 'operator', 'drive', 'ack', $4)`, [theirs.id, alex.subject, mine.id, at, bob.subject]);
        });

        await check('the export carries alex\'s robots, roles and commands, and nothing of bob\'s', async () => {
            const r = await deliver(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: alex.subject }));
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'exported'], JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_bot');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            assert.deepStrictEqual(files['robots.json'].map((x) => x.name), ['Alex rover']);
            assert.ok(files['operating.json'].some((o) => o.robot_id === theirs.id));
            assert.ok(!JSON.stringify(part.body).includes(bob.subject));
            assert.ok(!/credential|publish_key/i.test(JSON.stringify(part.body)), 'no device secret');
        });

        await check('the deletion removes alex\'s robot, revokes its device, removes alex from bob\'s robot; once', async () => {
            const event = ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: alex.subject });
            const r = await deliver(event);
            assert.deepStrictEqual([r.status, r.json && r.json.outcome], [200, 'erased'], JSON.stringify(r.json));
            assert.strictEqual(await count('SELECT count(*) FROM robots WHERE owner_subject = $1', [alex.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM command_audit WHERE robot_id = $1', [mine.id]), 0, 'her robot\'s history goes with it');
            const dev = await db.maybe('SELECT revoked_at, name FROM devices WHERE id = $1', [deviceId]);
            assert.ok(dev.revoked_at, 'the device that served only her robot is revoked');
            assert.strictEqual(dev.name, null);
            assert.strictEqual(await count('SELECT count(*) FROM robot_operators WHERE subject = $1', [alex.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM command_audit WHERE operator_subject = $1', [alex.subject]), 0);
            assert.strictEqual(await count('SELECT count(*) FROM command_audit WHERE robot_id = $1 AND operator_subject IS NULL', [theirs.id]), 1, 'bob keeps his robot\'s history, without her id');
            assert.strictEqual(await count('SELECT count(*) FROM robots WHERE id = $1', [theirs.id]), 1, 'bob\'s robot stays');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            // robot_operators: her owner row on her own robot and her operator role on bob's.
            assert.deepStrictEqual([conf[0].body.erased.robots, conf[0].body.erased.robot_operators, conf[0].body.retained.devices], [1, 2, 1]);
            assert.strictEqual((await deliver(event)).json.outcome, 'unchanged');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('/confirmations')).length, 1);
        });

        await check('the route refuses a bad signature and a request that came through a proxy', async () => {
            const event = ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: alex.subject });
            assert.strictEqual((await deliver(event, { secret: `whsec_${'mismatch'.repeat(5)}` })).status, 401);
            assert.strictEqual((await deliver(event, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 403);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
