'use strict';
// PR1: a robot's owner and the limits it really enforces, and GET /me for the account ID.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const invited = t.network.newUser('invited');
    const stranger = t.network.newUser('stranger');

    await check('GET /me answers the token\'s own account', async () => {
        const me = await t.call('GET', '/api/v1/me', { user: alex });
        assert.strictEqual(me.status, 200, me.text);
        assert.strictEqual(me.json.subject, alex.subject);
        assert.strictEqual(me.json.username, 'alex');
        assert.strictEqual(me.json.display_name, 'Alex');
        assert.strictEqual(me.json.kind, 'user');
        assert.strictEqual((await t.call('GET', '/api/v1/me', { token: null })).status, 401);
    });

    await check('an app token answers for its own subject, never a person\'s', async () => {
        const r = await t.call('GET', '/api/v1/me', { sub: 'svc:actor' });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.subject, 'svc:actor');
        assert.strictEqual(r.json.kind, 'service');
        assert.strictEqual(r.json.username, null);
    });

    await check('GET /robots/:id carries owner_subject, effective_limits and limits_source', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi', limits: { max_speed: 0.4 } });
        const r = await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.robot.owner_subject, alex.subject);
        assert.deepStrictEqual(r.json.robot.effective_limits, { max_speed: 0.4, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 });
        assert.deepStrictEqual(r.json.robot.limits_source.profile, { max_speed: 0.5, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 });
        assert.deepStrictEqual(r.json.robot.limits_source.robot, { max_speed: 0.4 }, 'only the owner\'s overrides');
    });

    await check('a robot with no limits{} says the profile\'s effective values, not {}', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        const r = await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex });
        assert.deepStrictEqual(r.json.robot.limits, {});
        assert.deepStrictEqual(r.json.robot.effective_limits, { max_speed: 0.5, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 });
        assert.deepStrictEqual(r.json.robot.limits_source.robot, {});
    });

    await check('the list carries the same fields, for a member and for a service', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi', limits: { max_turn: 0.2 } });
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: invited.subject, role: 'operator' } });
        const seen = await t.call('GET', `/api/v1/robots/${robot.id}`, { user: invited });
        assert.strictEqual(seen.status, 200);
        assert.strictEqual(seen.json.role, 'operator');
        assert.strictEqual(seen.json.robot.owner_subject, alex.subject);
        assert.strictEqual(seen.json.robot.effective_limits.max_turn, 0.2);
        const list = await t.call('GET', '/api/v1/robots', { user: alex });
        const one = list.json.robots.find((x) => x.id === robot.id);
        assert.ok(one);
        assert.strictEqual(one.owner_subject, alex.subject);
        assert.strictEqual(one.effective_limits.max_turn, 0.2);
        const svc = await t.call('GET', `/api/v1/robots?owner=${alex.subject}`, { cap: ['bot.robot.read'] });
        assert.strictEqual(svc.status, 200, svc.text);
        assert.strictEqual(svc.json.robots.find((x) => x.id === robot.id).effective_limits.max_speed, 0.5);
        assert.strictEqual((await t.call('GET', '/api/v1/robots', { user: stranger })).json.robots.length, 0);
    });

    await t.close();
    done();
})();
