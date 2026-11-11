'use strict';
/**
 * Elements stage 1: GET /api/v1/robots/:id/role — the service that may control a robot (OpenVibe.Live,
 * sending a Viewer Deck press as the viewer) asks which role that viewer holds on it. A person may ask
 * about themself only, and a robot that does not exist is the same 404 for everyone.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const operator = t.network.newUser('operator');
    const stranger = t.network.newUser('stranger');

    await check('a service with bot.robot.control gets a named subject\'s role; read alone is refused', async () => {
        const { robot } = await t.robot(alex);
        const added = await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: operator.subject, role: 'operator' } });
        assert.strictEqual(added.status, 201, added.text);
        const svc = await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${operator.subject}`, { cap: ['bot.robot.control'] });
        assert.strictEqual(svc.status, 200, svc.text);
        assert.deepStrictEqual(svc.json, { subject: operator.subject, role: 'operator' });
        const owner = await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${alex.subject}`, { cap: ['bot.robot.control'] });
        assert.deepStrictEqual(owner.json, { subject: alex.subject, role: 'owner' });
        const none = await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${stranger.subject}`, { cap: ['bot.robot.control'] });
        assert.strictEqual(none.json.role, null, 'a non-member has no role, not an error');
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${operator.subject}`, { cap: ['bot.robot.read'] })).status, 403);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${operator.subject}`, { cap: [] })).status, 403);
    });

    await check('a service must name a subject, and a person may ask about themself only', async () => {
        const { robot } = await t.robot(alex);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/role`, { cap: ['bot.robot.control'] })).status, 422);
        const mine = await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${alex.subject}`, { user: alex });
        assert.strictEqual(mine.status, 200);
        assert.strictEqual(mine.json.role, 'owner');
        const other = await t.call('GET', `/api/v1/robots/${robot.id}/role?subject=${operator.subject}`, { user: alex });
        assert.strictEqual(other.status, 403);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}/role`, { token: null })).status, 401);
    });

    await check('an unknown robot is a 404, and no role answer leaks through it', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/robots/rob_00000000000000000000000000/role?subject=' + alex.subject, { cap: ['bot.robot.control'] })).status, 404);
        assert.strictEqual((await t.call('GET', '/api/v1/robots/rob_00000000000000000000000000/role?subject=' + alex.subject, { user: alex })).status, 404);
    });

    await t.close();
    done();
})();
