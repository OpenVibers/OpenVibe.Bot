'use strict';
// The owner's agent (plan T15/T17: OpenVibe.Actor uses every OpenVibe service): an owner turns on "Let my OpenVibe.Actor
// agent drive this robot" on their panel, and from then on svc:actor, acting for that owner and nobody else, reads the
// robot's state and the steps it takes (GET /api/v1/robots/:id/steps) and runs plain step lines through the same gate
// as a person's commands (POST …/steps, or one command on POST …/commands). Off, or for anyone but the owner, it is
// refused with bot.agent_not_allowed.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(50); } return null; };
    const { robot } = await t.robot(alex, { name: 'Desk rover', profile_id: 'sim.rover' });
    assert.ok(await t.app.locals.sim.attach(robot.id));
    await poll(() => t.hub.isOnline(`dev_sim_${robot.id}`));
    const actor = t.network.signService({ sub: 'svc:actor', cap: ['bot.robot.read', 'bot.robot.control'] });
    const asAgent = (method, path, forUser, body, token = actor) => t.call(method, `/api/v1/robots/${robot.id}${path}`, { token, headers: { 'X-OV-Subject': forUser.subject }, body });
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const post = (p, user, body, headers = {}) => fetch(t.base + p, {
        method: 'POST', redirect: 'manual', body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers },
    });
    const refused = (r, status, code) => { assert.strictEqual(r.status, status, r.text); assert.strictEqual(r.json.code, code); };

    await check('before the owner allows it, the agent can neither read the steps nor drive', async () => {
        refused(await asAgent('GET', '/steps', alex), 403, 'bot.agent_not_allowed');
        refused(await asAgent('POST', '/steps', alex, { steps: 'forward 0.3' }), 403, 'bot.agent_not_allowed');
        refused(await asAgent('POST', '/commands', alex, { id: 'a0', kind: 'drive', value: { throttle: 0.2 } }), 403, 'bot.agent_not_allowed');
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex })).json.robot.agent_control, false);
    });

    await check('the owner turns it on from the panel (owner only, same-site, on or off)', async () => {
        const panel = await (await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(alex) })).text();
        assert.ok(panel.includes('id="agent"') && panel.includes('Let my OpenVibe.Actor agent drive this robot'));
        assert.ok(panel.includes(`action="/robots/${robot.id}/agent"`));
        const path = `/robots/${robot.id}/agent`;
        assert.strictEqual((await post(path, bob, 'agent_control=off&agent_control=on')).status, 403, 'only the owner');
        assert.strictEqual((await post(path, alex, 'agent_control=off&agent_control=on', { Origin: 'https://evil.test' })).status, 403, 'no cross-site post');
        assert.strictEqual((await post(path, alex, 'agent_control=maybe')).status, 422);
        const on = await post(path, alex, 'agent_control=off&agent_control=on');
        assert.strictEqual(on.status, 303);
        assert.strictEqual(on.headers.get('location'), `/panel/${robot.id}#agent`);
        assert.strictEqual((await t.call('GET', `/api/v1/robots/${robot.id}`, { user: alex })).json.robot.agent_control, true);
    });

    await check('the agent reads the robot for its owner: online, the e-stop, and the steps this robot takes', async () => {
        const r = await asAgent('GET', '/steps', alex);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.online, true);
        assert.strictEqual(r.json.estop.latched, false);
        assert.strictEqual(r.json.name, 'Desk rover');
        assert.ok(r.json.steps.includes('forward 2') && r.json.steps.includes('headlights #ff8800'), r.json.steps.join(', '));
        assert.deepStrictEqual([r.json.max_steps, r.json.max_seconds], [20, 30]);
    });

    await check('the agent runs steps as the owner through the gate, and the audit names the service', async () => {
        const r = await asAgent('POST', '/steps', alex, { steps: 'forward 0.4\nheadlights #00ff00\nstop' });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.result, r.json.steps], ['done', 3]);
        const audit = await t.domain.audit.list(robot.id, { limit: 50 });
        assert.ok(audit.some((x) => x.kind === 'drive' && x.result === 'ack' && x.operator_kind === 'service'), 'driven as a service, on the record');
        assert.ok(audit.some((x) => x.kind === 'actuator' && x.result === 'ack'), 'the lights too');
        const one = await asAgent('POST', '/commands', alex, { id: 'a1', kind: 'drive', value: { throttle: 0.2 } });
        assert.strictEqual(one.status, 200, one.text);
        assert.strictEqual(one.json.result, 'ack');
    });

    await check('only for the owner: not for an operator, not another service, not without the control capability', async () => {
        await t.call('POST', `/api/v1/robots/${robot.id}/operators`, { user: alex, body: { subject: bob.subject, role: 'operator' } });
        refused(await asAgent('POST', '/steps', bob, { steps: 'forward 0.3' }), 403, 'bot.agent_not_allowed');
        refused(await asAgent('POST', '/commands', bob, { id: 'b1', kind: 'drive', value: { throttle: 0.2 } }), 403, 'bot.agent_not_allowed');
        refused(await asAgent('GET', '/steps', bob), 403, 'bot.agent_not_allowed');
        const live = t.network.signService({ sub: 'svc:live', cap: ['bot.robot.read', 'bot.robot.control'] });
        refused(await asAgent('POST', '/steps', alex, { steps: 'forward 0.3' }, live), 403, 'bot.forbidden');
        const readOnly = t.network.signService({ sub: 'svc:actor', cap: ['bot.robot.read'] });
        assert.strictEqual((await asAgent('POST', '/steps', alex, { steps: 'forward 0.3' }, readOnly)).status, 403);
        // A person drives their own robot's steps themself; someone else's are refused.
        const own = await t.call('POST', `/api/v1/robots/${robot.id}/steps`, { user: alex, body: { steps: 'left 0.2' } });
        assert.strictEqual(own.status, 200, own.text);
        refused(await t.call('POST', `/api/v1/robots/${robot.id}/steps`, { user: bob, body: { steps: 'left 0.2' } }), 403, 'bot.forbidden');
    });

    await check('steps are checked and bounded: a wrong line names it, at most 20 steps and 30 seconds', async () => {
        const bad = await asAgent('POST', '/steps', alex, { steps: 'forward 0.2\nfly 3' });
        assert.strictEqual(bad.status, 422);
        assert.match(bad.json.detail, /line 2/);
        assert.strictEqual((await asAgent('POST', '/steps', alex, { steps: Array(21).fill('wait 0.1').join('\n') })).status, 422);
        const long = await asAgent('POST', '/steps', alex, { steps: 'forward 20\nforward 20' });
        assert.strictEqual(long.status, 422);
        assert.match(long.json.detail, /30 seconds/);
    });

    await check('the e-stop stops the agent with its reason; turning the switch off refuses it again', async () => {
        assert.strictEqual((await t.call('POST', `/api/v1/robots/${robot.id}/estop`, { user: alex })).status, 200);
        const r = await asAgent('POST', '/steps', alex, { steps: 'forward 0.3' });
        assert.strictEqual(r.status, 200, r.text);
        assert.match(r.json.result, /^stopped: /);
        assert.strictEqual((await asAgent('GET', '/steps', alex)).json.estop.latched, true);
        assert.strictEqual((await post(`/robots/${robot.id}/agent`, alex, 'agent_control=off')).status, 303);
        refused(await asAgent('POST', '/steps', alex, { steps: 'forward 0.3' }), 403, 'bot.agent_not_allowed');
    });

    await t.close();
    done();
})();
