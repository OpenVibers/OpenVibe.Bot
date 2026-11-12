'use strict';
// Agent Streams S7, Bot's part: an agent's commands are steps on its stream, chat cannot drive through the agent
// stream, and Live's stop reaches the robot through Bot.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const AGS = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPS';

(async () => {
    process.env.BOT_KILL_SECRET = 'test-kill-secret';
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_KILL_SECRET: 'test-kill-secret' } });
    const alex = t.network.newUser('alex');
    const { robot } = await t.robot(alex, { name: 'Stream rover', profile_id: 'sim.rover' });
    assert.ok(await t.app.locals.sim.attach(robot.id));
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(50); } return null; };
    await poll(() => t.hub.isOnline(`dev_sim_${robot.id}`));
    await t.domain.robots.setAgentControl(robot.id, true);
    const actor = t.network.signService({ sub: 'svc:actor', cap: ['bot.robot.read', 'bot.robot.control'] });
    const asAgent = (method, path, body) => t.call(method, `/api/v1/robots/${robot.id}${path}`, { token: actor, headers: { 'X-OV-Subject': alex.subject }, body });

    await check('an agent command is a step on the stream', async () => {
        const r = await asAgent('POST', '/commands', { id: 's7-1', kind: 'drive', value: { throttle: 0.5 }, ms: 500, agent_stream_id: AGS });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result, 'ack');
        const steps = await asAgent('GET', `/steps?agent_stream=${AGS}`);
        assert.strictEqual(steps.status, 200, steps.text);
        const step = steps.json.commands.find((c) => c.agent_stream_id === AGS);
        assert.ok(step, JSON.stringify(steps.json.commands));
        assert.match(step.title, /^Drive/);
        assert.strictEqual(step.status, 'passed');
        assert.strictEqual(step.kind, 'drive');
        const other = await asAgent('GET', '/steps?agent_stream=ags_01JAB2C3D4E5F6G7H8J9K0MNPV');
        assert.ok(!other.json.commands.some((c) => c.agent_stream_id === AGS), 'a stream sees only its own steps');
    });

    await check('chat cannot drive a robot through the agent-stream surface', async () => {
        const chat = t.network.signService({ sub: 'svc:chat', cap: ['bot.robot.control'] });
        const r = await t.call('POST', `/api/v1/robots/${robot.id}/commands`, {
            token: chat, headers: { 'X-OV-Subject': alex.subject },
            body: { id: 's7-chat', kind: 'drive', value: { throttle: 0.2 }, surface: 'agent-stream' },
        });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'bot.chat_cannot_drive');
        const state = await asAgent('GET', '/steps');
    });

    await check('Live\'s stop reaches the robot through Bot as a halt', async () => {
        const wrong = await t.call('POST', `/internal/robots/${robot.id}/stop`, { headers: { 'X-OV-Bot-Kill': 'not-the-secret' }, body: {} });
        assert.strictEqual(wrong.status, 401, wrong.text);
        const ok = await t.call('POST', `/internal/robots/${robot.id}/stop`, { headers: { 'X-OV-Bot-Kill': 'test-kill-secret' }, body: { reason: 'agent_stream_ended' } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.stop, true);
        const sent = await asAgent('POST', '/commands', { id: 's7-2', kind: 'drive', value: { throttle: 0.5 }, ms: 500, agent_stream_id: AGS });
        assert.strictEqual(sent.status, 200, sent.text);
        assert.strictEqual(sent.json.result, 'ack', 'a Stop is one command, not a latch');
    });

    await check('the step title is the command, never markup or unbounded text', async () => {
        const { titleOf } = require('../server/agent-steps');
        assert.strictEqual(titleOf('drive', { throttle: 1 }), 'Drive (throttle 1)');
        assert.strictEqual(titleOf('say', { text: 'hello' }), 'Say hello');
        assert.ok(Array.from(titleOf('drive', { note: 'x'.repeat(500) })).length <= 120);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
