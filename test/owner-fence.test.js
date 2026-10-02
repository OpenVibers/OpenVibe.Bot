'use strict';
// The owner fence on /api/v1: only a person (as themself) or a service with the capability (for the
// subject it names) reads or creates robots for an owner. No token → 401 bot.sign_in; a node token →
// 403 bot.forbidden; a person naming someone else (?owner, body owner, X-OV-Subject) → 403 bot.forbidden.
// Public routes, POST /pair (its code) and POST /devices/bind (a node token) keep their own auth.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const { robot: bobsRobot } = await t.robot(bob);
    const nodeToken = t.network.signNode(t.network.addNode({ owner: bob.subject, ref: bobsRobot.id }));

    const robotsOf = async (u) => Number((await t.db.maybe('SELECT count(*) AS n FROM robots WHERE owner_subject = $1', [u.subject])).n);
    const listFor = (u, opts) => t.call('GET', `/api/v1/robots?owner=${u.subject}`, opts);
    const createFor = (u, opts) => t.call('POST', '/api/v1/robots', { ...opts, body: { name: 'Not yours', profile_id: 'sim.rover', owner: u.subject } });
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, r.text); assert.strictEqual(r.json.code, code, r.text); assert.ok(!r.json.robots && !r.json.robot && !r.json.pairing, r.text); };

    await check('no token: listing or creating another person\'s robots → 401 bot.sign_in', async () => {
        const before = await robotsOf(bob);
        refused(await listFor(bob, { token: null }), 401, 'bot.sign_in');
        refused(await createFor(bob, { token: null }), 401, 'bot.sign_in');
        refused(await t.call('POST', '/api/v1/robots', { token: null, headers: { 'X-OV-Subject': bob.subject }, body: { name: 'x', profile_id: 'sim.rover' } }), 401, 'bot.sign_in');
        assert.strictEqual(await robotsOf(bob), before);
    });

    await check('a node token: listing or creating robots for its owner → 403 bot.forbidden', async () => {
        const before = await robotsOf(bob);
        refused(await listFor(bob, { token: nodeToken }), 403, 'bot.forbidden');
        refused(await createFor(bob, { token: nodeToken }), 403, 'bot.forbidden');
        assert.strictEqual(await robotsOf(bob), before);
    });

    await check('a person naming another owner (?owner, body owner or X-OV-Subject) → 403 bot.forbidden', async () => {
        const before = await robotsOf(bob);
        refused(await listFor(bob, { user: alex }), 403, 'bot.forbidden');
        refused(await t.call('GET', '/api/v1/robots', { user: alex, headers: { 'X-OV-Subject': bob.subject } }), 403, 'bot.forbidden');
        refused(await createFor(bob, { user: alex }), 403, 'bot.forbidden');
        refused(await t.call('POST', '/api/v1/robots', { user: alex, headers: { 'X-OV-Subject': bob.subject }, body: { name: 'x', profile_id: 'sim.rover' } }), 403, 'bot.forbidden');
        assert.strictEqual(await robotsOf(bob), before);
    });

    await check('a person acts as themself, named or not', async () => {
        const created = await createFor(alex, { user: alex });
        assert.strictEqual(created.status, 201, created.text);
        const plain = await t.call('POST', '/api/v1/robots', { user: alex, body: { name: 'Mine', profile_id: 'sim.rover' } });
        assert.strictEqual(plain.status, 201, plain.text);
        const named = await listFor(alex, { user: alex });
        assert.strictEqual(named.status, 200, named.text);
        const own = await t.call('GET', '/api/v1/robots', { user: alex });
        assert.strictEqual(own.status, 200, own.text);
        assert.deepStrictEqual(named.json.robots.map((r) => r.id).sort(), [created.json.robot.id, plain.json.robot.id].sort());
        assert.deepStrictEqual(own.json.robots, named.json.robots);
    });

    await check('a service acts for the subject it names, with the capability (unchanged)', async () => {
        const list = await listFor(bob, { cap: ['bot.robot.read'] });
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual(list.json.robots.map((r) => r.id), [bobsRobot.id]);
        refused(await listFor(bob, { cap: ['bot.robot.control'] }), 403, 'capability.denied');
        refused(await t.call('GET', '/api/v1/robots', { cap: ['bot.robot.read'] }), 422, 'bot.invalid_input');
        const before = await robotsOf(bob);
        const viaBody = await createFor(bob, { cap: ['bot.robot.manage'] });
        assert.strictEqual(viaBody.status, 201, viaBody.text);
        const viaHeader = await t.call('POST', '/api/v1/robots', { cap: ['bot.robot.manage'], headers: { 'X-OV-Subject': bob.subject }, body: { name: 'Via header', profile_id: 'sim.rover' } });
        assert.strictEqual(viaHeader.status, 201, viaHeader.text);
        assert.strictEqual(await robotsOf(bob), before + 2);
        refused(await createFor(bob, { cap: ['bot.robot.read'] }), 403, 'capability.denied');
        refused(await t.call('POST', '/api/v1/robots', { cap: ['bot.robot.manage'], body: { name: 'x', profile_id: 'sim.rover' } }), 422, 'bot.invalid_input');
    });

    await check('public routes, POST /pair and POST /devices/bind keep their own auth', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/profiles', { token: null })).status, 200);
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/sim.rover', { token: null })).status, 200);
        const pair = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: bobsRobot.id, code: 'AAAA-AAAA' } });
        assert.strictEqual(pair.status, 403, pair.text);
        assert.match(pair.json.code, /^bot\.pairing_code_/);
        const bind = await t.call('POST', '/api/v1/devices/bind', { token: nodeToken });
        assert.strictEqual(bind.status, 201, bind.text);
    });

    await t.close();
    done();
})();
