'use strict';
// Network-paired machines (T2 §9.2 B1, dual-accept): a node token binds a device from Network's record,
// POST /devices/bind issues its publish key without a credential, the /device socket speaks first exactly
// as for a credential, `status` persists what the machine declares, `reauth` keeps the socket, and revoke
// and rotate reach Network and the machine. Credential devices keep today's behaviour.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const WHIP_BASE = 'https://whip.test/ingest';

(async () => {
    const t = await boot({ env: { BOT_WHIP_BASE: WHIP_BASE } });
    const alex = t.network.newUser('alex');
    const sam = t.network.newUser('sam');

    const bind = (token) => t.call('POST', '/api/v1/devices/bind', { token });
    const deviceRow = (id) => t.db.maybe('SELECT * FROM devices WHERE id = $1', [id]);
    const connect = (token) => t.ws('/device', { headers: { Authorization: `Bearer ${token}` } });
    /** A robot of `owner` and a machine Network paired for it. */
    async function paired(owner = alex, node = {}) {
        const { robot } = await t.robot(owner);
        return { robot, principal: t.network.addNode({ owner: owner.subject, ref: robot.id, ...node }) };
    }

    await check('bind creates the device from Network\'s record with safe initial values, and answers no credential', async () => {
        const { robot, principal } = await paired();
        const r = await bind(t.network.signNode(principal));
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.deepStrictEqual(Object.keys(r.json).sort(), ['device_id', 'profile', 'publish_key', 'robot_id', 'whip_url']);
        assert.match(r.json.device_id, /^dev_/);
        assert.strictEqual(r.json.robot_id, robot.id);
        assert.strictEqual(r.json.profile.id, 'sim.rover');
        assert.ok(r.json.publish_key.length >= 40);
        assert.strictEqual(r.json.whip_url, `${WHIP_BASE}/${r.json.publish_key}`);
        const d = await deviceRow(r.json.device_id);
        assert.deepStrictEqual(d.robot_ids, [robot.id]);
        assert.strictEqual(d.name, 'garage-pi');
        assert.strictEqual(d.kind, 'onboard');
        assert.deepStrictEqual(d.drivers, []);
        assert.deepStrictEqual(d.capabilities, {});
        assert.strictEqual(d.agent_version, null);
        assert.strictEqual(d.credential_hash, null);
        assert.strictEqual(d.node_principal, principal);
        assert.strictEqual(d.publish_key_hint, r.json.publish_key.slice(-4), 'only the hint of the OpenRestream key is kept');
        assert.strictEqual(d.publish_key_hash, null, 'Bot mints and hashes no key of its own');
        assert.ok(t.openre.admits(r.json.publish_key), 'the publish key is one OpenRestream admits');
    });

    await check('bind twice answers the same device and a new publish key; the old key stops working', async () => {
        const { principal } = await paired();
        const first = await bind(t.network.signNode(principal));
        const second = await bind(t.network.signNode(principal));
        assert.strictEqual(second.status, 201, second.text);
        assert.strictEqual(second.json.device_id, first.json.device_id);
        assert.notStrictEqual(second.json.publish_key, first.json.publish_key);
        const d = await deviceRow(first.json.device_id);
        assert.strictEqual(d.publish_key_hint, second.json.publish_key.slice(-4));
        assert.ok(t.openre.admits(second.json.publish_key), 'the new key is admitted');
        assert.ok(!t.openre.admits(first.json.publish_key), 'the old key stops working');
        assert.strictEqual(Number((await t.db.maybe('SELECT count(*) AS n FROM devices WHERE node_principal = $1', [principal])).n), 1);
    });

    await check('bind refuses anything but a node token for openvibe.bot', async () => {
        const { principal } = await paired();
        const network = await bind(t.network.signNode(principal, { aud: ['openvibe.network'] }));
        assert.strictEqual(network.status, 401, network.text);
        const user = await t.call('POST', '/api/v1/devices/bind', { user: alex });
        assert.strictEqual(user.status, 401, user.text);
        assert.strictEqual(user.json.code, 'bot.node_token_required');
        const service = await t.call('POST', '/api/v1/devices/bind', { cap: ['bot.*'] });
        assert.strictEqual(service.status, 401, service.text);
    });

    await check('an upgrade with a node token and no prior bind gets hello then config first, and no paired frame', async () => {
        const { robot, principal } = await paired();
        const c = await connect(t.network.signNode(principal));
        const config = await c.waitFor((m) => m.type === 'config');
        assert.ok(config);
        assert.deepStrictEqual(c.messages.slice(0, 2).map((m) => m.type), ['hello', 'config']);
        assert.ok(!c.messages.some((m) => m.type === 'paired'));
        const hello = c.messages[0];
        assert.deepStrictEqual(hello.robot_ids, [robot.id]);
        const d = await deviceRow(hello.device_id);
        assert.strictEqual(d.node_principal, principal);
        assert.strictEqual(d.publish_key_hint, null, 'no publish key until the machine calls bind');
        assert.ok(t.hub.isOnline(d.id));
        // A later bind finds the same device.
        const b = await bind(t.network.signNode(principal));
        assert.strictEqual(b.json.device_id, d.id);
        c.close();
    });

    await check('a status with device_kind, drivers, capabilities and agent_version updates the row; invalid values do not', async () => {
        const { principal } = await paired();
        const c = await connect(t.network.signNode(principal));
        const hello = await c.waitFor((m) => m.type === 'hello');
        c.send({ v: 1, seq: 1, ts: Date.now(), type: 'status', firmware: 'x', device_kind: 'bridge', drivers: ['pca9685', 'picamera2'], capabilities: { camera: true }, agent_version: '0.3.1' });
        let d;
        for (let i = 0; i < 40; i++) { d = await deviceRow(hello.device_id); if (d.kind === 'bridge') break; await t.wait(25); }
        assert.strictEqual(d.kind, 'bridge');
        assert.deepStrictEqual(d.drivers, ['pca9685', 'picamera2']);
        assert.deepStrictEqual(d.capabilities, { camera: true });
        assert.strictEqual(d.agent_version, '0.3.1');
        for (const bad of [{ device_kind: 'toaster' }, { drivers: 'pca9685' }, { drivers: [1] }, { agent_version: 'x'.repeat(41) }, { capabilities: [] }]) {
            const before = c.messages.filter((m) => m.type === 'error').length;
            c.send({ v: 1, seq: 2, ts: Date.now(), type: 'status', ...bad });
            await c.waitFor(() => c.messages.filter((m) => m.type === 'error').length > before);
            const err = c.messages.filter((m) => m.type === 'error').pop();
            assert.strictEqual(err.code, 'bot.bad_frame', JSON.stringify(bad));
        }
        const after = await deviceRow(hello.device_id);
        assert.strictEqual(after.kind, 'bridge');
        assert.deepStrictEqual(after.drivers, ['pca9685', 'picamera2']);
        assert.strictEqual(after.agent_version, '0.3.1');
        c.close();
    });

    await check('a credential device\'s status stays memory-only', async () => {
        const { robot, pairing } = await t.robot(alex);
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code, drivers: ['a'] } });
        const c = await connect(p.json.credential);
        await c.waitFor((m) => m.type === 'config');
        c.send({ v: 1, seq: 1, ts: Date.now(), type: 'status', device_kind: 'server', drivers: ['b'], agent_version: '9' });
        c.send({ v: 1, seq: 2, ts: Date.now(), type: 'reauth', token: 'x' });
        const err = await c.waitFor((m) => m.type === 'error');
        assert.strictEqual(err.code, 'bot.unknown_message', 'reauth is not a credential device\'s frame');
        const d = await deviceRow(p.json.device_id);
        assert.strictEqual(d.kind, 'onboard');
        assert.deepStrictEqual(d.drivers, ['a']);
        c.close();
    });

    await check('a principal paired for another owner\'s robot, revoked, or not for Bot → 403 and close 4002', async () => {
        const { robot: samsRobot } = await t.robot(sam);
        const cases = {
            'another owner\'s robot': t.network.addNode({ owner: alex.subject, ref: samsRobot.id }),
            revoked: (await paired(alex, { status: 'revoked' })).principal,
            'paired for another service (Network answers 404)': (await paired(alex, { service: 'live' })).principal,
            'paired for another service (seen)': (await paired(alex, { service: 'live', unscoped: true })).principal,
            'unknown on Network': 'nod_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        };
        for (const [name, principal] of Object.entries(cases)) {
            const r = await bind(t.network.signNode(principal));
            assert.strictEqual(r.status, 403, `${name}: ${r.text}`);
            assert.strictEqual(r.json.code, 'bot.node_not_bound', name);
            const c = await connect(t.network.signNode(principal));
            assert.strictEqual(await c.waitForClose(), 4002, name);
            assert.ok(!c.messages.some((m) => m.type === 'hello'), name);
            assert.strictEqual(await t.db.maybe('SELECT id FROM devices WHERE node_principal = $1', [principal]), null, name);
        }
    });

    await check('no valid reauth within 330 s of the last token → close 4002; a valid one keeps the socket', async () => {
        const { principal } = await paired();
        const other = (await paired()).principal;
        const c = await connect(t.network.signNode(principal));
        await c.waitFor((m) => m.type === 'config');
        t.clock.offset += 200 * 1000;
        c.send({ v: 1, seq: 1, ts: Date.now(), type: 'reauth', token: t.network.signNode(other) });
        assert.strictEqual((await c.waitFor((m) => m.type === 'error')).code, 'bot.reauth_refused', 'another machine\'s token is no reauth');
        c.send({ v: 1, seq: 2, ts: Date.now(), type: 'reauth', token: t.network.signNode(principal) });
        await t.wait(100);
        t.clock.offset += 200 * 1000;   // 400 s after connect, 200 s after the reauth
        await t.wait(400);
        assert.ok(!c.ended, 'a valid reauth moved the deadline');
        t.clock.offset += 131 * 1000;   // 331 s after the reauth
        assert.strictEqual(await c.waitForClose(), 4002);
        t.clock.offset = 0;
    });

    await check('revoke of a Network-paired device revokes the principal on Network and closes the socket; it never binds again', async () => {
        const { principal } = await paired();
        const c = await connect(t.network.signNode(principal));
        const hello = await c.waitFor((m) => m.type === 'hello');
        const r = await t.call('POST', `/api/v1/devices/${hello.device_id}/revoke`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(t.network.revokes.includes(principal));
        assert.strictEqual(await c.waitForClose(), 4003);
        const again = await bind(t.network.signNode(principal));
        assert.strictEqual(again.status, 403);
        assert.strictEqual(again.json.code, 'bot.node_not_bound');
    });

    await check('rotate of a Network-paired device asks the machine to rotate and answers no credential', async () => {
        const { principal } = await paired();
        const c = await connect(t.network.signNode(principal));
        const hello = await c.waitFor((m) => m.type === 'hello');
        const r = await t.call('POST', `/api/v1/devices/${hello.device_id}/rotate`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.sent, true);
        assert.ok(!('credential' in r.json) && !('publish_key' in r.json), r.text);
        assert.ok(await c.waitFor((m) => m.type === 'rotate'));
        assert.strictEqual((await deviceRow(hello.device_id)).credential_hash, null);
        c.close();
    });

    await t.close();
    done();
})();
