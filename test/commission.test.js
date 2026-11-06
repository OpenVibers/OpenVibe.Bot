'use strict';
// Commissioned per-robot limits (safety): the owner, as a person, may raise max_speed/max_turn above the
// profile's defaults and up to its ceiling only after commissioning; everyone else never can; the device
// receives the same effective values the gate uses.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const profiles = loadProfiles();
    const eff = async (robotId) => {
        const row = await t.domain.robots.get(robotId);
        return t.domain.control.effectiveLimits(row, profiles.get(row.profile_id));
    };
    const patch = (robotId, limits, user = alex) => t.call('PATCH', `/api/v1/robots/${robotId}`, { user, body: { limits } });
    const commission = (robotId, body = { confirm: true }, user = alex) => t.call('POST', `/api/v1/robots/${robotId}/commission`, { user, body });
    const uncommission = (robotId, user = alex) => t.call('POST', `/api/v1/robots/${robotId}/uncommission`, { user, body: {} });

    await check('LOOI carries a ceiling above its defaults; a profile without one keeps its limits as the ceiling', () => {
        assert.deepStrictEqual(profiles.get('looi').ceiling, { max_speed: 1, max_turn: 1 });
        const cozmo = profiles.get('cozmo');
        assert.deepStrictEqual(cozmo.ceiling, { max_speed: cozmo.limits.max_speed, max_turn: cozmo.limits.max_turn }, 'no ceiling: the limits clamp');
        assert.deepStrictEqual(profiles.get('sim.rover').ceiling, { max_speed: profiles.get('sim.rover').limits.max_speed, max_turn: profiles.get('sim.rover').limits.max_turn });
    });

    await check('without commissioning, values above the profile default clamp to the default exactly as today', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi', limits: { max_speed: 0.9, max_turn: 0.9 } });
        assert.deepStrictEqual(await eff(robot.id), { maxSpeed: 0.5, maxTurn: 0.6, maxCommandMs: 300, cooldownMs: 0 });
    });

    await check('commissioning needs the owner, a person and an explicit confirm', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        const noConfirm = await commission(robot.id, {});
        assert.strictEqual(noConfirm.status, 422);
        assert.strictEqual(noConfirm.json.code, 'bot.confirm_required');
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: bob.subject, role: 'operator' } });
        const byOperator = await commission(robot.id, { confirm: true }, bob);
        assert.strictEqual(byOperator.status, 403, byOperator.text);
        // Even a service acting for the owner (X-OV-Subject) may not: only the owner's own person token.
        const byService = await t.call('POST', `/api/v1/robots/${robot.id}/commission`, {
            cap: ['bot.robot.manage'], headers: { 'x-ov-subject': alex.subject }, body: { confirm: true },
        });
        assert.strictEqual(byService.status, 403, 'an app token with manage still never commissions');
        assert.strictEqual((await t.domain.robots.get(robot.id)).commissioned_at, null);
    });

    await check('an app token may lower a limit but never raise one, even on a commissioned robot', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        await commission(robot.id);
        const asOwner = { cap: ['bot.robot.manage'], headers: { 'x-ov-subject': alex.subject } };
        const raise = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { ...asOwner, body: { limits: { max_speed: 0.9 } } });
        assert.strictEqual(raise.status, 403, raise.text);
        assert.strictEqual((await eff(robot.id)).maxSpeed, 0.5);
        const lower = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { ...asOwner, body: { limits: { max_speed: 0.3 } } });
        assert.strictEqual(lower.status, 200, lower.text);
        assert.strictEqual((await eff(robot.id)).maxSpeed, 0.3);
    });

    await check('the owner commissions: who and when are recorded, and higher values apply up to the ceiling', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        const r = await commission(robot.id);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.robot.commissioned.by, alex.subject);
        assert.ok(r.json.robot.commissioned.at);
        assert.strictEqual((await patch(robot.id, { max_speed: 0.8, max_turn: 0.9 })).status, 200);
        assert.deepStrictEqual(await eff(robot.id), { maxSpeed: 0.8, maxTurn: 0.9, maxCommandMs: 300, cooldownMs: 0 });
        const audit = await t.domain.audit.list(robot.id, { limit: 20 });
        const row = audit.find((a) => a.kind === 'robot.commission');
        assert.ok(row && row.operator_subject === alex.subject && row.result === 'ack');
    });

    await check('never above the ceiling', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        await commission(robot.id);
        await patch(robot.id, { max_speed: 5, max_turn: 5 });
        assert.deepStrictEqual(await eff(robot.id), { maxSpeed: 1, maxTurn: 1, maxCommandMs: 300, cooldownMs: 0 });
    });

    await check('max_command_ms is never raised, even when commissioned', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        await commission(robot.id);
        await patch(robot.id, { max_command_ms: 5000 });
        assert.deepStrictEqual(await eff(robot.id), { maxSpeed: 0.5, maxTurn: 0.6, maxCommandMs: 300, cooldownMs: 0 });
    });

    await check('uncommissioning drops back to the defaults at once, and the audit says so', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        await commission(robot.id);
        await patch(robot.id, { max_speed: 0.9, max_turn: 0.9 });
        assert.strictEqual((await eff(robot.id)).maxSpeed, 0.9);
        const r = await uncommission(robot.id);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.robot.commissioned, null);
        assert.deepStrictEqual(await eff(robot.id), { maxSpeed: 0.5, maxTurn: 0.6, maxCommandMs: 300, cooldownMs: 0 });
        const audit = await t.domain.audit.list(robot.id, { limit: 20 });
        assert.ok(audit.some((a) => a.kind === 'robot.uncommission' && a.result === 'ack'));
    });

    await check('the device receives the effective values: defaults, higher after commissioning, defaults again', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi', limits: { max_speed: 0.9 } });
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        const first = await dev.waitFor((m) => m.type === 'config');
        assert.deepStrictEqual(first.limits, { max_speed: 0.5, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 }, 'clamped before commissioning');
        await commission(robot.id);
        await dev.waitFor((m) => m.type === 'config' && m.seq > first.seq);
        const high = await patch(robot.id, { max_speed: 0.9, max_turn: 0.9 });
        assert.strictEqual(high.status, 200);
        const second = await dev.waitFor((m) => m.type === 'config' && m.seq > first.seq && m.limits.max_turn === 0.9);
        assert.deepStrictEqual(second.limits, { max_speed: 0.9, max_turn: 0.9, max_command_ms: 300, heartbeat_ms: 1000 });
        await uncommission(robot.id);
        const third = await dev.waitFor((m) => m.type === 'config' && m.seq > second.seq && m.limits.max_speed === 0.5);
        assert.deepStrictEqual(third.limits, { max_speed: 0.5, max_turn: 0.6, max_command_ms: 300, heartbeat_ms: 1000 }, 'at once, on the device');
        dev.close();
    });

    await t.close();
    done();
})();
