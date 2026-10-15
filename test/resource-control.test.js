'use strict';
// ADR-048 amendment 2026-10-15: OpenVibe.Services stops and resumes a person's robot through Bot's control API
// (bot.resource.control, common.owned-resource-control-request@1). Only the owner Bot holds may be named; a repeat
// answers the first result; an agent's resume waits for the owner's confirmation; first-party only.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alice = t.network.newUser('control-alice');
    const bob = t.network.newUser('control-bob');
    const robot = (await t.robot(alice, { name: 'Alice robot' })).robot;
    const auth = { cap: ['bot.resource.control'], sub: 'svc:services' };
    const send = (body, options = auth) => t.call('POST', '/api/v1/resources/control', { ...options, body });
    let n = 0;
    const req = (action, over = {}) => ({
        action, owned: { kind: 'bot.robot', id: robot.id }, owner: { type: 'user', id: alice.subject },
        on_behalf_of: { type: 'user', id: alice.subject }, idempotency_key: `idem_robot_${++n}_${Date.now()}`, ...over,
    });
    const latched = async () => (await t.db.query('SELECT estop_latched FROM robots WHERE id = $1', [robot.id])).rows[0].estop_latched;
    const valid = (body) => assert.ok(contracts.resources.checkControlResult(body).valid, JSON.stringify(contracts.resources.checkControlResult(body).errors));

    await check('stop latches the e-stop; a repeat answers the first result; stop again changes nothing', async () => {
        const first = req('stop');
        let r = await send(first);
        assert.strictEqual(r.status, 200, r.text);
        valid(r.json);
        assert.deepStrictEqual([r.json.state, r.json.result, r.json.resource], ['done', { estop: true, changed: true }, undefined]);
        assert.strictEqual(await latched(), true);
        const again = await send(first);
        assert.deepStrictEqual(again.json, r.json, 'the same key answers the first result');
        r = await send({ ...first, dry_run: true });
        assert.deepStrictEqual([r.status, r.json.code], [409, 'control.idempotency_conflict'], 'the key reused with another request');
        r = await send(req('stop'));
        assert.deepStrictEqual(r.json.result, { estop: true, changed: false });
        const events = (await t.db.query("SELECT envelope FROM bot_event_outbox WHERE envelope->>'event_type' = 'bot.estop.set' AND envelope->'subject'->>'id' = $1", [robot.id])).rows;
        assert.strictEqual(events.length, 1, 'bot.estop.set is announced once');
    });

    await check('resume clears it (dry run first); an agent\'s resume needs the owner\'s confirmation', async () => {
        let r = await send(req('resume', { dry_run: true }));
        assert.deepStrictEqual([r.json.state, r.json.result.dry_run], ['done', true]);
        assert.strictEqual(await latched(), true, 'a dry run applies nothing');
        r = await send(req('resume', { on_behalf_of: { type: 'agent', id: 'agt_01J8ZQ4Y7N3M2K1H0G9F8E7D6C' } }));
        assert.deepStrictEqual([r.json.state, r.json.problem.code], ['refused', 'control.confirmation_needed']);
        assert.strictEqual(await latched(), true);
        r = await send(req('resume'));
        assert.deepStrictEqual([r.json.state, r.json.result], ['done', { estop: false, changed: true }]);
        assert.strictEqual(await latched(), false);
        r = await send(req('stop', { on_behalf_of: { type: 'agent', id: 'agt_01J8ZQ4Y7N3M2K1H0G9F8E7D6C' } }));
        assert.deepStrictEqual(r.json.result, { estop: true, changed: true }, 'an agent may always stop it');
        await send(req('resume'));
    });

    await check('only the owner Bot holds; unknown kinds and actions are refused', async () => {
        let r = await send(req('stop', { owner: { type: 'user', id: bob.subject }, on_behalf_of: { type: 'user', id: bob.subject } }));
        assert.deepStrictEqual([r.json.state, r.json.problem.code], ['refused', 'resources.unknown_resource'], 'another person\'s robot is not confirmed to exist');
        assert.strictEqual(await latched(), false);
        r = await send(req('stop', { on_behalf_of: { type: 'user', id: bob.subject } }));
        assert.deepStrictEqual([r.status, r.json.code], [400, 'control.bad_request'], 'a person acts only on what they own');
        r = await send(req('delete'));
        assert.deepStrictEqual([r.json.state, r.json.problem.code], ['refused', 'control.unsupported_action']);
        r = await send(req('stop', { owned: { kind: 'bot.device', id: 'dev_01J8ZQ4Y7N3M2K1H0G9F8E7D6C' } }));
        assert.strictEqual(r.json.problem.code, 'resources.unknown_resource');
        r = await send({ action: 'delete', resource: 'ovrn:bot:prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C:robot/rob_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', idempotency_key: 'idem_project_1' });
        assert.deepStrictEqual([r.status, r.json.code], [400, 'control.bad_request'], 'Bot holds no project resources');
    });

    await check('first-party only, with bot.resource.control', async () => {
        let r = await send(req('stop'), { cap: ['bot.resource.read'], sub: 'svc:services' });
        assert.strictEqual(r.status, 403);
        r = await send(req('stop'), { user: alice });
        assert.strictEqual(r.status, 403, 'a person\'s own token is not a first-party service');
        r = await send(req('stop'), { token: null });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(await latched(), false);
    });

    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
