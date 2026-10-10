'use strict';
// /api/v1, /, and observability: tokens by capability, robots/operators/devices/audit, problem+json.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const stranger = t.network.newUser('stranger');

    await check('health, ready, release.json and the GET / front page', async () => {
        const h = await t.call('GET', '/api/health', { token: null });
        assert.strictEqual(h.json.service, 'bot');
        assert.strictEqual(h.json.devices_online, 0);
        const r = await t.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.json.ready, true);
        assert.strictEqual(r.json.checks.db.detail.store, t.store.store);
        const rel = await t.call('GET', '/release.json', { token: null });
        assert.strictEqual(rel.json.service, 'bot');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json).errors, []);
        const home = await t.call('GET', '/', { token: null });
        assert.strictEqual(home.status, 200);
        assert.match(home.headers.get('content-type'), /text\/html/);   // the front page, test/home.test.js
    });

    await check('profiles are public reads; an unknown profile is a problem+json 404', async () => {
        const list = await t.call('GET', '/api/v1/profiles', { token: null });
        assert.strictEqual(list.status, 200);
        assert.deepStrictEqual(list.json.profiles.map((p) => p.id).sort(), ['adeept.adr036', 'adeept.adr036.mecanum', 'camera.onvif', 'cozmo', 'relay.generic', 'sim.rover']);
        const one = await t.call('GET', '/api/v1/profiles/adeept.adr036', { token: null });
        assert.strictEqual(one.json.profile.limits.max_command_ms, 300);
        const missing = await t.call('GET', '/api/v1/profiles/nope', { token: null });
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.headers.get('content-type'), 'application/problem+json');
    });

    await check('a typed Network token (realtime ticket, FedCM assertion) is never a session, even signed by the Network key', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/robots', { user: alex })).status, 200, 'a session token works');
        for (const extra of [{ typ: 'realtime', purpose: 'realtime' }, { typ: 'fedcm', aud: 'https://elsewhere.example' }]) {
            const r = await t.call('GET', '/api/v1/robots', { token: t.network.signUser(alex, extra) });
            assert.strictEqual(r.status, 401, `${extra.typ}: ${r.status}`);
        }
    });

    await check('a stranger cannot read or manage someone else\'s robot; the owner can', async () => {
        const { robot, pairing } = await t.robot(alex);
        assert.match(pairing.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        assert.match(pairing.installer, /--robot rob_/);
        assert.ok(pairing.expires_at);
        const mine = await t.call('GET', '/api/v1/robots', { user: alex });
        assert.strictEqual(mine.json.robots.length, 1);
        assert.strictEqual(mine.json.robots[0].access_policy, 'private');
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex })).status, 200);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: stranger })).status, 403);
        assert.strictEqual((await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: stranger, body: { name: 'x' } })).status, 403);
        const upd = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { name: 'Rover 2', access_policy: 'queue', limits: { max_speed: 0.5 } } });
        assert.strictEqual(upd.status, 200, upd.text);
        assert.strictEqual(upd.json.robot.name, 'Rover 2');
        assert.strictEqual(upd.json.robot.access_policy, 'queue');
        assert.strictEqual(upd.json.robot.limits.max_speed, 0.5);
    });

    await check('a service token needs the capability; an unknown robot is 404', async () => {
        const { robot } = await t.robot(bob);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { cap: ['bot.robot.control'] })).status, 403);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { cap: ['bot.robot.read'] })).status, 200);
        assert.strictEqual((await t.call('GET', '/api/v1/robots/rob_00000000000000000000000000', { cap: ['bot.robot.read'] })).status, 404);
        const wrongAud = t.network.signService({ aud: ['openvibe.tips'], cap: ['bot.*'] });
        assert.strictEqual((await t.call('GET', '/api/v1/robots', { token: wrongAud })).status, 401);
    });

    await check('operators: the owner invites, the operator may read but not manage', async () => {
        const { robot } = await t.robot(alex);
        const invited = t.network.newUser('invited');
        const add = await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: invited.subject, role: 'operator' } });
        assert.strictEqual(add.status, 201, add.text);
        assert.strictEqual(add.json.operators.find((o) => o.subject === invited.subject).role, 'operator');
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: invited })).status, 200);
        assert.strictEqual((await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: invited, body: { name: 'nope' } })).status, 403);
        const rm = await t.call('DELETE', `/api/v1/robots/${robot.id}/operators/${invited.subject}`, { user: alex });
        assert.strictEqual(rm.status, 200);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: invited })).status, 403);
    });

    await check('pairing-code create returns a fresh code; devices list is empty before pairing', async () => {
        const { robot } = await t.robot(alex);
        const code = await t.call('POST', `/api/v1/robots/${robot.id}/pairing-code`, { user: alex });
        assert.strictEqual(code.status, 201, code.text);
        assert.match(code.json.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        const devices = await t.call('GET', `/api/v1/robots/${robot.id}/devices`, { user: alex });
        assert.deepStrictEqual(devices.json.devices, []);
    });

    await check('audit is paged, newest first, keyset on id', async () => {
        const { robot } = await t.robot(alex);
        for (let i = 0; i < 3; i++) await t.domain.audit.record({ robotId: robot.id, subject: alex.subject, kind: 'drive', value: { throttle: 0.1 * i, steer: 0 }, result: 'refused', reason: 'test' });
        const page = await t.call('GET', `/api/v1/robots/${robot.id}/audit?limit=2`, { user: alex });
        assert.strictEqual(page.json.audit.length, 2);
        assert.ok(page.json.audit[0].id > page.json.audit[1].id);
        assert.ok(page.json.next_before);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/audit`, { user: stranger })).status, 403);
        // The audit is a read for a service: bot.robot.read opens it, manage alone does not.
        const svc = await t.call('GET', `/api/v1/robots/${robot.id}/audit`, { cap: ['bot.robot.read'] });
        assert.strictEqual(svc.status, 200, svc.text);
        assert.strictEqual(svc.json.audit.length, 3);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/audit`, { cap: ['bot.robot.manage'] })).status, 403);
    });

    await check('an outbox event is written for a refused command (bot.command.refused)', async () => {
        const { robot } = await t.robot(alex);
        await t.domain.audit.record({ robotId: robot.id, subject: alex.subject, kind: 'drive', value: {}, result: 'refused', reason: 'bot.estop_latched' });
        const rows = await t.outboxRows('bot.command.refused');
        assert.ok(rows.length >= 1);
        assert.strictEqual(rows[rows.length - 1].source, 'bot');
    });

    await t.close();
    done();
})();
