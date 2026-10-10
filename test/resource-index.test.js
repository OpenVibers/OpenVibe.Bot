'use strict';
// The first-party authority index lists only public robot summaries, with stable id pagination.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alice = t.network.newUser('resource-alice');
    const bob = t.network.newUser('resource-bob');
    const first = (await t.robot(alice, { name: 'First robot' })).robot;
    const second = (await t.robot(bob, { name: 'Second robot' })).robot;
    const third = (await t.robot(alice, { name: 'Third robot' })).robot;
    const auth = { cap: ['bot.resource.read'] };
    const get = (path, options = auth) => t.call('GET', `/api/v1/resources${path}`, options);

    await check('a page validates and reveals only the allowed summary fields', async () => {
        await t.db.query('UPDATE robots SET estop_latched = true WHERE id = $1', [second.id]);
        const response = await get('');
        assert.strictEqual(response.status, 200, response.text);
        assert.deepStrictEqual(contracts.validate('common.resource-list-result@1', response.json).errors, []);
        assert.deepStrictEqual(response.json.resources.map((r) => r.id), [first.id, second.id, third.id].sort());
        for (const summary of response.json.resources) {
            assert.deepStrictEqual(Object.keys(summary).sort(), ['created_at', 'id', 'kind', 'name', 'owner', 'service', 'state', 'updated_at']);
            assert.strictEqual(summary.kind, 'bot.robot');
            assert.strictEqual(summary.service, 'bot');
            assert.strictEqual(summary.ovrn, undefined);
            assert.strictEqual(contracts.resources.nameOf(summary), null);
            assert.ok(!Number.isNaN(Date.parse(summary.created_at)));
            assert.ok(!Number.isNaN(Date.parse(summary.updated_at)));
        }
        assert.deepStrictEqual(response.json.resources.find((r) => r.id === second.id).owner, { type: 'user', id: bob.subject });
        assert.strictEqual(response.json.resources.find((r) => r.id === second.id).state, 'estopped');
        assert.strictEqual(response.json.resources.find((r) => r.id === first.id).state, 'ready');
    });

    await check('an id cursor walks each robot exactly once', async () => {
        const ids = [];
        let cursor = null;
        do {
            const response = await get(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            assert.strictEqual(response.status, 200, response.text);
            assert.deepStrictEqual(contracts.validate('common.resource-list-result@1', response.json).errors, []);
            ids.push(...response.json.resources.map((r) => r.id));
            cursor = response.json.next_cursor;
        } while (cursor);
        assert.deepStrictEqual(ids, [first.id, second.id, third.id].sort());
        assert.strictEqual(new Set(ids).size, 3);
    });

    await check('project and kind filters are applied', async () => {
        assert.deepStrictEqual((await get('?kind=bot.robot')).json.resources.map((r) => r.id), [first.id, second.id, third.id].sort());
        for (const query of ['?kind=bot.unknown', '?project=prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', '?kind=bot.robot&project=prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C']) {
            assert.deepStrictEqual((await get(query)).json, { resources: [], next_cursor: null });
        }
        for (const query of ['?project=nope', '?limit=0', '?limit=1001', '?cursor=broken']) {
            const response = await get(query);
            assert.strictEqual(response.status, 400, response.text);
            assert.strictEqual(response.json.code, 'resources.bad_query');
        }
    });

    await check('a service token with bot.resource.read is required on both routes', async () => {
        for (const path of ['', '/ovrn%3Abot%3Aprj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C%3Arobot%2F' + first.id]) {
            const anonymous = await get(path, { token: null });
            assert.strictEqual(anonymous.status, 401);
            assert.strictEqual(anonymous.json.code, 'bot.sign_in');
            const person = await get(path, { user: alice });
            assert.strictEqual(person.status, 403);
            assert.strictEqual(person.json.code, 'bot.forbidden');
            const denied = await get(path, { cap: ['bot.robot.read'] });
            assert.strictEqual(denied.status, 403);
            assert.strictEqual(denied.json.code, 'capability.denied');
        }
    });

    await check('person-owned robots cannot be looked up by any OVRN', async () => {
        for (const id of [first.id, second.id, third.id]) {
            const name = `ovrn:bot:prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C:robot/${id}`;
            const response = await get(`/${encodeURIComponent(name)}`);
            assert.strictEqual(response.status, 404, response.text);
            assert.strictEqual(response.json.code, 'resources.unknown_resource');
        }
    });

    await check('removed robots leave the index', async () => {
        await t.db.query('DELETE FROM robots WHERE id = $1', [third.id]);
        assert.deepStrictEqual((await get('')).json.resources.map((r) => r.id), [first.id, second.id].sort());
    });

    await t.close();
    done();
})();
