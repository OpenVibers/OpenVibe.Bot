'use strict';
// The owner fence on /api/v1: only a person (as themself) or a service with the capability (for the
// subject it names) reads or creates robots for an owner. No token → 401 bot.sign_in; a node token →
// 403 bot.forbidden; a person naming someone else (?owner, body owner, X-OV-Subject) → 403 bot.forbidden.
// The fence comes before any lookup, so a real robot or device id answers exactly as a made-up one.
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

    await check('POST /robots?owner= naming anyone but the caller is refused, never ignored', async () => {
        const before = await robotsOf(bob);
        const body = { name: 'x', profile_id: 'sim.rover' };
        refused(await t.call('POST', `/api/v1/robots?owner=${bob.subject}`, { user: alex, body }), 403, 'bot.forbidden');
        refused(await t.call('POST', `/api/v1/robots?owner=${alex.subject}`, { cap: ['bot.robot.manage'], body: { ...body, owner: bob.subject } }), 403, 'bot.forbidden');
        refused(await t.call('POST', `/api/v1/robots?owner=${bob.subject}`, { token: null, body }), 401, 'bot.sign_in');
        assert.strictEqual(await robotsOf(bob), before);
        const mine = await robotsOf(alex);
        const own = await t.call('POST', `/api/v1/robots?owner=${alex.subject}`, { user: alex, body });
        assert.strictEqual(own.status, 201, own.text);
        assert.strictEqual(await robotsOf(alex), mine + 1);
    });

    await check('a real and a made-up robot id answer the same without a token or with a node token', async () => {
        const fake = `rob_${'0'.repeat(26)}`;
        const fakeDevice = `dev_${'0'.repeat(26)}`;
        const { device_id: realDevice } = (await t.call('POST', '/api/v1/devices/bind', { token: nodeToken })).json;
        const routes = (id, dev) => [
            ['GET', `/robots/${id}`], ['PATCH', `/robots/${id}`, { name: 'x' }], ['DELETE', `/robots/${id}`],
            ['POST', `/robots/${id}/pairing-code`], ['GET', `/robots/${id}/operators`], ['POST', `/robots/${id}/operators`, { subject: alex.subject }],
            ['DELETE', `/robots/${id}/operators/${alex.subject}`], ['GET', `/robots/${id}/devices`], ['GET', `/robots/${id}/audit`],
            ['POST', `/robots/${id}/estop`], ['POST', `/robots/${id}/estop/clear`], ['POST', `/devices/${dev}/rotate`], ['POST', `/devices/${dev}/revoke`],
        ];
        const shape = (r) => ({ status: r.status, code: r.json && r.json.code, title: r.json && r.json.title, detail: r.json && r.json.detail });
        const real = routes(bobsRobot.id, realDevice);
        const made = routes(fake, fakeDevice);
        for (const [token, status, code] of [[null, 401, 'bot.sign_in'], [nodeToken, 403, 'bot.forbidden']]) {
            for (let i = 0; i < real.length; i++) {
                const [method, p, body] = real[i];
                const a = await t.call(method, `/api/v1${p}`, { token, body });
                const b = await t.call(made[i][0], `/api/v1${made[i][1]}`, { token, body: made[i][2] });
                assert.deepStrictEqual(shape(a), { status, code, title: a.json.title, detail: a.json.detail }, `${method} ${p}: ${a.text}`);
                assert.deepStrictEqual(shape(b), shape(a), `${method} ${made[i][1]} differs from the real id`);
            }
        }
        const still = await t.call('GET', `/api/v1/robots/${bobsRobot.id}`, { user: bob });
        assert.strictEqual(still.status, 200, 'nothing was changed');
        assert.strictEqual(still.json.robot.name, bobsRobot.name);
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
