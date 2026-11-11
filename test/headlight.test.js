'use strict';
// LOOI headlights (Maticus's 2026-11-11 handoff): the owner's and People Operators' explicit ON/OFF action, gated
// by the same command gate as drive/actuator, stamped with Bot's provenance and a 300 ms lifetime/250 ms deadline,
// relayed as its own non-motion kind, with the driver's stage=headlight_pending/headlight_refused ack data and
// sensors.p7_headlight telemetry. No hardware: the fake device and HTTP panel only.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
// The /control and /device frames under test are server/realtime.js's; require it so the runner maps this test to it.
require('../server/realtime');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers: { ...(user ? cookie(user) : {}), ...headers } });
    const op = (user) => t.ws('/control', { headers: cookie(user) });
    const invite = (robotId, subject, role) => t.call('POST', `/api/v1/robots/${robotId}/operators`, { user: alex, body: { subject, role } });
    const cmd = (client, o) => client.send({ type: 'command', ...o });
    const result = (client, id) => client.waitFor((m) => m.type === 'command_result' && m.id === id);
    async function join(client, robotId) {
        client.send({ type: 'join', robot_id: robotId });
        return client.waitFor((m) => m.type === 'joined' || m.type === 'error');
    }
    async function deviceFor(robotId, code) {
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        const hello = await dev.waitFor((m) => m.type === 'hello');
        await dev.waitFor((m) => m.type === 'config');
        return { dev, hello };
    }
    const looi = loadProfiles().get('looi');

    await check('the LOOI profile declares the custom headlight action; owner and operator are allowed, queue is not', () => {
        assert.deepStrictEqual(looi.mapping.actions, ['headlight']);
        const owner = t.domain.control.allowedFor({ limits: {} }, 'owner', looi);
        const operator = t.domain.control.allowedFor({ limits: {} }, 'operator', looi);
        const queue = t.domain.control.allowedFor({ limits: {} }, 'queue', looi);
        assert.ok(owner.includes('headlight') && operator.includes('headlight'));
        assert.ok(!queue.includes('headlight'));
        // An owner who removes it from the operator allow list takes it away from People Operators.
        const restricted = t.domain.control.allowedFor({ limits: { allow: { operator: ['drive'] } } }, 'operator', looi);
        assert.deepStrictEqual(restricted, ['drive', 'halt']);
    });

    await check('the owner\'s action is stamped by Bot: operator, turn epoch, provenance (300 ms original / 250 ms deadline)', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        const { dev, hello } = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        const j = await join(a, robot.id);
        assert.strictEqual(j.role, 'owner');
        assert.ok(j.allowed_commands.includes('headlight'));
        const before = Date.now() + t.clock.offset;
        cmd(a, { id: 'hl-1', kind: 'headlight', value: { on: true } });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'hl-1');
        assert.strictEqual(c.kind, 'headlight', 'actuator would renew the motion deadline');
        assert.deepStrictEqual(c.value, { on: true });
        assert.strictEqual(c.operator.role, 'owner');
        assert.strictEqual(c.operator.subject, alex.subject);
        assert.ok(c.deadline_ms > before && c.deadline_ms <= before + 250 + 20, `deadline ${c.deadline_ms - before} ms`);
        assert.strictEqual(c.provenance.expires_at_ms - c.provenance.issued_at_ms, 300);
        assert.strictEqual(c.provenance.issued_at_ms, c.ts, 'issued_at_ms is the frame ts');
        assert.strictEqual(c.provenance.seq, c.seq, 'provenance seq is the envelope seq');
        assert.strictEqual(c.provenance.session, hello.session_id);
        assert.strictEqual(typeof c.provenance.clock_uncertainty_ms, 'number');
        // The accepted-not-confirmed answer rides back in the ack's data.
        dev.send({ type: 'ack', id: c.id, data: { stage: 'headlight_pending', admitted: true } });
        const r = await result(a, 'hl-1');
        assert.strictEqual(r.result, 'ack');
        assert.deepStrictEqual(r.data, { stage: 'headlight_pending', admitted: true });
        // The driver's busy answer is an ack too, admitted:false; the panel keeps the state it shows.
        t.clock.offset += 1000;
        cmd(a, { id: 'hl-2', kind: 'headlight', value: { on: false } });
        const c2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'hl-2');
        dev.send({ type: 'ack', id: c2.id, data: { stage: 'headlight_refused', admitted: false } });
        const r2 = await result(a, 'hl-2');
        assert.strictEqual(r2.result, 'ack');
        assert.deepStrictEqual(r2.data, { stage: 'headlight_refused', admitted: false });
        // A nack is a rejection, with the driver's words.
        t.clock.offset += 1000;
        cmd(a, { id: 'hl-3', kind: 'headlight', value: { on: true } });
        const c3 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'hl-3');
        dev.send({ type: 'nack', id: c3.id, fault_code: 'not_connected', message: 'LOOI is not connected over Bluetooth' });
        const r3 = await result(a, 'hl-3');
        assert.strictEqual(r3.result, 'nack');
        assert.strictEqual(r3.reason, 'LOOI is not connected over Bluetooth');
        // Telemetry is the only state the robot reports.
        dev.send({ type: 'telemetry', sensors: { p7_headlight: { commanded: true, pending: false, physical_state_verified: false } } });
        const st = await a.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.sensors && m.state.telemetry.sensors.p7_headlight);
        assert.deepStrictEqual(st.state.telemetry.sensors.p7_headlight, { commanded: true, pending: false, physical_state_verified: false });
        a.close(); dev.close();
    });

    await check('a People Operator is allowed and stamped as operator; removing headlight from the owner\'s allow list refuses and hides it', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        const { dev } = await deviceFor(robot.id, pairing.code);
        const b = await op(bob);
        const j = await join(b, robot.id);
        assert.strictEqual(j.role, 'operator');
        assert.ok(j.allowed_commands.includes('headlight'));
        cmd(b, { id: 'op-hl', kind: 'headlight', value: { on: true } });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'op-hl');
        assert.deepStrictEqual(c.operator, { subject: bob.subject, role: 'operator' });
        dev.send({ type: 'ack', id: c.id });
        await result(b, 'op-hl');
        assert.ok((await (await get(`/panel/${robot.id}`, bob)).text()).includes('data-headlight'));
        t.clock.offset += 1000;
        const patch = await t.call('PATCH', `/api/v1/robots/${robot.id}`, { user: alex, body: { limits: { allow: { operator: ['drive'] } } } });
        assert.strictEqual(patch.status, 200, patch.text);
        cmd(b, { id: 'op-hl-2', kind: 'headlight', value: { on: false } });
        const r = await result(b, 'op-hl-2');
        assert.strictEqual(r.result, 'refused');
        assert.strictEqual(r.code, 'bot.command_not_allowed');
        assert.ok(!(await (await get(`/panel/${robot.id}`, bob)).text()).includes('data-headlight'), 'hidden, not disabled');
        b.close(); dev.close();
    });

    await check('viewers, watchers and the queue never get it: each command is refused, each panel has no control', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, carol.subject, 'viewer');
        await t.db.query('UPDATE robots SET embed_public = true WHERE id = $1', [robot.id]);
        const { dev } = await deviceFor(robot.id, pairing.code);
        const v = await op(carol);
        const vj = await join(v, robot.id);
        assert.strictEqual(vj.role, 'viewer');
        assert.ok(!vj.allowed_commands.includes('headlight'));
        cmd(v, { id: 'v-hl', kind: 'headlight', value: { on: true } });
        const vr = await result(v, 'v-hl');
        assert.strictEqual(vr.result, 'refused');
        assert.strictEqual(vr.code, 'bot.read_only');
        const viewerHtml = await (await get(`/panel/${robot.id}`, carol)).text();
        assert.ok(!viewerHtml.includes('data-headlight'));
        const anon = await (await get(`/panel/${robot.id}/embed`)).text();
        assert.ok(anon.includes('data-role="watcher"') && !anon.includes('data-headlight'));
        // An anonymous caller has no subject: the command route refuses before any command reaches the gate.
        const anonCmd = await t.call('POST', `/api/v1/robots/${robot.id}/commands`, { token: null, body: { id: 'a-hl', kind: 'headlight', value: { on: true } } });
        assert.strictEqual(anonCmd.status, 401);
        assert.strictEqual(anonCmd.json.code, 'bot.sign_in');
        // The queue role is not a headlight path, even with a turn.
        const q = await t.robot(alex, { profile_id: 'looi', access_policy: 'queue' });
        const qc = await op(carol);
        const qj = await join(qc, q.robot.id);
        assert.strictEqual(qj.role, 'queue');
        assert.ok(!qj.allowed_commands.includes('headlight'));
        t.clock.offset += 1000;
        cmd(qc, { id: 'q-hl', kind: 'headlight', value: { on: true } });
        const qr = await result(qc, 'q-hl');
        assert.strictEqual(qr.result, 'refused');
        assert.strictEqual(qr.code, 'bot.command_not_allowed');
        v.close(); qc.close(); dev.close();
    });

    await check('the value is explicit on/off only, and three in a second are rate-limited', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        const { dev } = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        await join(a, robot.id);
        for (const [id, value] of [['bad-1', {}], ['bad-2', { on: 'yes' }], ['bad-3', { on: 1 }], ['bad-4', { on: true, x: 1 }]]) {
            cmd(a, { id, kind: 'headlight', value });
            const r = await result(a, id);
            assert.strictEqual(r.result, 'refused', id);
            assert.strictEqual(r.code, 'bot.invalid_input', id);
        }
        for (let i = 0; i < 2; i++) {
            const id = `rate-${i}`;
            cmd(a, { id, kind: 'headlight', value: { on: i === 0 } });
            const c = await dev.waitFor((m) => m.type === 'command' && m.ref === id);
            dev.send({ type: 'ack', id: c.id });
            assert.strictEqual((await result(a, id)).result, 'ack');
        }
        cmd(a, { id: 'rate-2', kind: 'headlight', value: { on: true } });
        const r = await result(a, 'rate-2');
        assert.strictEqual(r.result, 'refused');
        assert.strictEqual(r.code, 'bot.headlight_busy');
        t.clock.offset += 1000;
        cmd(a, { id: 'rate-3', kind: 'headlight', value: { on: false } });
        assert.ok(await dev.waitFor((m) => m.type === 'command' && m.ref === 'rate-3'), 'the next second is allowed');
        a.close(); dev.close();
    });

    await check('the full panel and the embed panel carry the control and its exact words; overlay and compact do not', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        const page = await (await get(`/panel/${robot.id}`, alex)).text();
        for (const s of ['data-headlight', 'Headlights', 'Unknown', 'Not confirmed on the robot', 'Turn on', 'Turn off']) assert.ok(page.includes(s), s);
        // The control sits in the head controls card beside the slider, not as a new widget.
        assert.ok(/data-widget="head"[\s\S]*data-headlight/.test(page));
        for (const mode of ['overlay', 'compact']) {
            const html = await (await get(`/panel/${robot.id}/embed?mode=${mode}`)).text();
            assert.ok(!html.includes('data-headlight'), `${mode} has the full panel's control`);
        }
        assert.ok((await (await get(`/panel/${robot.id}/embed`, alex)).text()).includes('data-headlight'), 'the channel Robot tab uses the full panel');
    });

    t.app.locals.sim.stopAll();
    await t.close();
    done();
})();
