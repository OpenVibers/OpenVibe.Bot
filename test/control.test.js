'use strict';
// The control gate (ADR-043 decisions 6 and 8): roles, the access policy, owner limits that clamp an
// operator, cooldowns, the latched e-stop (owner-cleared only), the turn queue and a service acting for
// a viewer. Every decision is audited.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const dave = t.network.newUser('dave');

    const op = (user) => t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(user)}` } });
    async function joinResult(client, robotId) {
        client.send({ type: 'join', robot_id: robotId });
        return client.waitFor((m) => m.type === 'joined' || m.type === 'error');
    }
    async function deviceFor(robotId, code) {
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        return dev;
    }
    const invite = (robotId, subject, role) => t.call('POST', `/api/v1/robots/${robotId}/operators`, { user: alex, body: { subject, role } });
    const cmd = (client, o) => client.send({ type: 'command', ...o });
    const result = (client, id) => client.waitFor((m) => m.type === 'command_result' && m.id === id);

    await check('a private robot refuses a stranger', async () => {
        const { robot } = await t.robot(alex);
        const stranger = await op(carol);
        const r = await joinResult(stranger, robot.id);
        assert.strictEqual(r.type, 'error');
        assert.strictEqual(r.code, 'bot.not_an_operator');
        stranger.close();
    });

    await check('the owner\'s limits clamp an operator\'s values; the audit keeps the clamped value', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { max_speed: 0.4, max_turn: 0.3 } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        const j = await joinResult(b, robot.id);
        assert.strictEqual(j.role, 'operator');
        cmd(b, { id: 'k1', kind: 'drive', value: { throttle: 5, steer: 5 } });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'k1');
        assert.deepStrictEqual(c.value, { throttle: 0.4, steer: 0.3 });
        dev.send({ type: 'ack', id: c.id });
        await result(b, 'k1');
        const audit = await t.domain.audit.list(robot.id, { limit: 1 });
        assert.deepStrictEqual(audit[0].value, { throttle: 0.4, steer: 0.3 });
        b.close();
    });

    await check('a cooldown refuses the operator\'s second command of a kind', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { cooldown_ms: 1000 } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        await joinResult(b, robot.id);
        cmd(b, { id: 'z1', kind: 'drive', value: { throttle: 0.2 } });
        await dev.waitFor((m) => m.type === 'command' && m.ref === 'z1');
        cmd(b, { id: 'z2', kind: 'drive', value: { throttle: 0.2 } });
        const again = await result(b, 'z2');
        assert.strictEqual(again.result, 'refused');
        assert.strictEqual(again.code, 'bot.cooldown');
        b.close();
    });

    await check('the e-stop latches, refuses commands, and only the owner clears it', async () => {
        const { robot, pairing } = await t.robot(alex);
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        await joinResult(b, robot.id);
        b.send({ type: 'estop' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !!r.estop_latched)), 'the e-stop latched');
        cmd(b, { id: 'e1', kind: 'drive', value: { throttle: 0.2 } });
        const refused = await result(b, 'e1');
        assert.strictEqual(refused.code, 'bot.estop_latched');
        b.send({ type: 'estop_clear' });
        const denied = await b.waitFor((m) => m.type === 'error' && /forbidden/.test(m.code));
        assert.strictEqual(denied.code, 'bot.forbidden');
        const a = await op(alex);
        await joinResult(a, robot.id);
        a.send({ type: 'estop_clear' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !r.estop_latched)), 'the owner cleared it');
        cmd(b, { id: 'e2', kind: 'drive', value: { throttle: 0.2 } });
        assert.ok(await dev.waitFor((m) => m.type === 'command' && m.ref === 'e2'), 'an operator may drive again');
        a.close(); b.close();
    });

    await check('halt passes the gate while the e-stop is latched; every other kind is refused', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { cooldown_ms: 60000, allow: { operator: ['drive'] } } });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        const j = await joinResult(b, robot.id);
        assert.deepStrictEqual(j.allowed_commands, ['drive', 'halt'], 'no allowlist removes halt');
        b.send({ type: 'estop' });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => !!r.estop_latched)), 'the e-stop latched');
        cmd(b, { id: 'h0', kind: 'drive', value: { throttle: 0.2 } });
        assert.strictEqual((await result(b, 'h0')).code, 'bot.estop_latched');
        cmd(b, { id: 'h1', kind: 'halt' });
        const h1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'h1');
        assert.strictEqual(h1.kind, 'halt');
        assert.deepStrictEqual(h1.value, {});
        assert.strictEqual(h1.deadline_ms, null, 'halt is not a motion with a deadline');
        dev.send({ type: 'ack', id: h1.id });
        assert.strictEqual((await result(b, 'h1')).result, 'ack');
        cmd(b, { id: 'h2', kind: 'halt' });
        const h2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'h2');
        assert.ok(h2, 'halt is never cooled down');
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((x) => x.kind === 'halt' && x.result === 'ack'), 'halt is audited like any command');
        b.close();
    });

    await check('the profile decides the kinds and shapes: a mecanum drive keeps x/y/rotation, an actuator is {name, value}', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'adeept.adr036.mecanum', limits: { max_turn: 0.5 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        const j = await joinResult(a, robot.id);
        assert.deepStrictEqual(j.allowed_commands, ['drive', 'actuator', 'halt']);
        cmd(a, { id: 'm1', kind: 'drive', value: { x: 0.5, y: -0.4, rotation: 2 } });
        const m1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'm1');
        assert.deepStrictEqual(m1.value, { x: 0.5, y: -0.4, rotation: 0.5 });
        cmd(a, { id: 'm2', kind: 'actuator', value: { name: 'lights', value: { r: 300, g: 0, b: 7 } } });
        const m2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'm2');
        assert.deepStrictEqual(m2.value, { name: 'lights', value: { r: 255, g: 0, b: 7 } });
        cmd(a, { id: 'm3', kind: 'actuator', value: { name: 'horn' } });
        assert.strictEqual((await result(a, 'm3')).code, 'bot.unknown_actuator');
        cmd(a, { id: 'm4', kind: 'say', value: { text: 'hi' } });
        const m4 = await result(a, 'm4');
        assert.strictEqual(m4.code, 'bot.command_not_allowed', 'the adeept plugin has no speech');
        a.close();
    });

    await check('config carries the effective limits and is re-sent to the device when the owner changes them', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'cozmo', limits: { max_speed: 0.9, max_turn: 0.5 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const first = await dev.waitFor((m) => m.type === 'config');
        assert.deepStrictEqual(first.limits, { max_speed: 0.6, max_turn: 0.5, max_command_ms: 300, heartbeat_ms: 1000 }, 'the owner\'s clamped by cozmo\'s 0.6');
        assert.deepStrictEqual(first.allowed_commands, ['drive', 'actuator', 'say', 'display', 'halt'], 'cozmo takes no ptz');
        const r = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { limits: { max_speed: 0.3, max_turn: 0.2, max_command_ms: 200, allow: { owner: ['drive', 'say'] } } } });
        assert.strictEqual(r.status, 200, r.text);
        const second = await dev.waitFor((m) => m.type === 'config' && m.seq > first.seq);
        assert.deepStrictEqual(second.limits, { max_speed: 0.3, max_turn: 0.2, max_command_ms: 200, heartbeat_ms: 1000 });
        assert.deepStrictEqual(second.allowed_commands, ['drive', 'say', 'halt']);
        const renamed = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { name: 'Cozmo II' } });
        assert.strictEqual(renamed.status, 200);
        await t.wait(100);
        assert.strictEqual(dev.messages.filter((m) => m.type === 'config').length, 2, 'a rename does not re-send config');
    });

    await check('a queue robot gives a turn that expires and passes to the next waiting person', async () => {
        const { robot, pairing } = await t.robot(alex, { access_policy: 'queue', limits: { turn_ms: 300, turn_budget: 5 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const c = await op(carol);
        const cj = await joinResult(c, robot.id);
        assert.strictEqual(cj.role, 'queue');
        const d = await op(dave);
        await joinResult(d, robot.id);
        cmd(c, { id: 'q1', kind: 'drive', value: { throttle: 0.2 } });
        const q1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'q1');
        assert.ok(q1, 'the turn holder may drive');
        dev.send({ type: 'ack', id: q1.id });
        await result(c, 'q1');
        t.clock.offset += 1000;                       // past the 300 ms turn
        cmd(c, { id: 'q2', kind: 'drive', value: { throttle: 0.2 } });
        const rc = await result(c, 'q2');
        assert.strictEqual(rc.result, 'refused', 'the expired turn no longer drives');
        cmd(d, { id: 'q3', kind: 'drive', value: { throttle: 0.2 } });
        assert.ok(await dev.waitFor((m) => m.type === 'command' && m.ref === 'q3'), 'the next waiting person is promoted');
        t.clock.offset -= 1000;
        c.close(); d.close();
    });

    await check('a service token with bot.robot.control acts for a viewer and is held to the viewer role', async () => {
        const { robot, pairing } = await t.robot(alex);
        const viewer = t.network.newUser('viewer');
        await invite(robot.id, viewer.subject, 'viewer');
        await deviceFor(robot.id, pairing.code);
        const svc = t.network.signService({ sub: 'svc:chat', cap: ['bot.robot.control'], aud: ['openvibe.bot'] });
        const s = await t.ws('/control', { headers: { Authorization: `Bearer ${svc}`, 'X-OV-Subject': viewer.subject } });
        const j = await joinResult(s, robot.id);
        assert.strictEqual(j.role, 'viewer');
        cmd(s, { id: 'v1', kind: 'drive', value: { throttle: 0.5 } });
        const r = await result(s, 'v1');
        assert.strictEqual(r.result, 'refused');
        assert.strictEqual(r.code, 'bot.read_only');
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((x) => x.result === 'refused' && x.reason === 'bot.read_only' && x.operator_kind === 'service'), 'the refusal is audited');
        s.close();

        const noSubject = await t.ws('/control', { headers: { Authorization: `Bearer ${svc}` } });
        assert.strictEqual(await noSubject.waitForClose(), 4002, 'a service must name the subject it acts for');
        const noCap = t.network.signService({ sub: 'svc:chat', cap: ['bot.robot.read'], aud: ['openvibe.bot'] });
        const weak = await t.ws('/control', { headers: { Authorization: `Bearer ${noCap}`, 'X-OV-Subject': viewer.subject } });
        assert.strictEqual(await weak.waitForClose(), 4002, 'without bot.robot.control a service cannot control');
        const anon = await t.ws('/control');
        assert.strictEqual(await anon.waitForClose(), 4002, 'an anonymous socket is refused');
    });

    await t.close();
    done();
})();

async function poll(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        if (await fn()) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}
