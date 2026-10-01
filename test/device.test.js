'use strict';
// The device WebSocket (ADR-043 decisions 4–6): header-only auth, the pairing handshake, heartbeats and
// offline detection, no queueing for an offline device, idempotent ids and the deadline cap. The fake
// device is a `ws` client — the same shape the agent job will build against docs/protocol.md.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');

    const asOwner = () => t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
    async function ownerJoined(robotId) {
        const op = await asOwner();
        op.send({ type: 'join', robot_id: robotId });
        const joined = await op.waitFor((m) => m.type === 'joined');
        assert.strictEqual(joined.role, 'owner', joined.text || JSON.stringify(joined));
        return op;
    }
    async function pairOverWs(robotId, code) {
        const dev = await t.ws('/device');
        dev.send({ type: 'pair', robot: robotId, code, agent_version: '0.1.0', device_kind: 'onboard', drivers: ['cozmo'], capabilities: { camera: { resolution: '320x240' } } });
        const paired = await dev.waitFor((m) => m.type === 'paired');
        await dev.waitFor((m) => m.type === 'hello');
        await dev.waitFor((m) => m.type === 'config');
        return { dev, paired };
    }

    await check('device auth is by header, never a query string', async () => {
        const { robot, pairing } = await t.robot(alex);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        const cred = paired.json.credential;
        const qs = await t.ws(`/device?credential=${encodeURIComponent(cred)}`);
        qs.send({ type: 'status', firmware: 'x' });
        const err = await qs.waitFor((m) => m.type === 'error');
        assert.strictEqual(err.code, 'bot.not_paired', 'a query-string credential does not authenticate');
        assert.ok(!qs.messages.some((m) => m.type === 'hello'));
        qs.close();
        const bad = await t.ws('/device', { headers: { Authorization: 'Bearer not-a-credential' } });
        assert.strictEqual(await bad.waitForClose(), 4002);
    });

    await check('a paired device gets hello + config; heartbeats are acknowledged with the RTT', async () => {
        const { robot, pairing } = await t.robot(alex);
        const { dev, paired } = await pairOverWs(robot.id, pairing.code);
        dev.send({ type: 'heartbeat', seq: 1, rtt_ms: 42 });
        const ack = await dev.waitFor((m) => m.type === 'heartbeat_ack');
        assert.strictEqual(ack.seq, 1);
        assert.ok(ack.server_time);
        assert.strictEqual(t.hub.deviceState(paired.device_id).rtt_ms, 42);
        dev.close();
    });

    await check('a device that stops heartbeating goes offline; bot.robot.offline is written', async () => {
        const { robot, pairing } = await t.robot(alex);
        const { dev, paired } = await pairOverWs(robot.id, pairing.code);
        assert.strictEqual(t.hub.isOnline(paired.device_id), true);
        t.clock.offset += 2000;                        // past 2 missed + 0 grace
        const offline = await poll(() => !t.hub.isOnline(paired.device_id), 2000);
        assert.ok(offline, 'the hub marked the device offline');
        t.clock.offset -= 2000;
        await t.wait(50);
        const rows = await t.outboxRows('bot.robot.offline');
        assert.ok(rows.some((e) => e.payload.robot_id === robot.id), 'bot.robot.offline for the robot');
        dev.close();
    });

    await check('commands are refused, never queued, when the device is offline', async () => {
        const { robot, pairing } = await t.robot(alex);
        const { dev } = await pairOverWs(robot.id, pairing.code);
        const op = await ownerJoined(robot.id);
        dev.close();
        await dev.waitForClose();
        await t.wait(80);
        op.send({ type: 'command', id: 'off1', kind: 'drive', value: { throttle: 1 } });
        const r = await op.waitFor((m) => m.type === 'command_result' && m.id === 'off1');
        assert.strictEqual(r.result, 'refused');
        assert.strictEqual(r.code, 'bot.device_offline');
        op.close();
    });

    await check('the deadline is stamped and capped by max_command_ms', async () => {
        const { robot, pairing } = await t.robot(alex, { limits: { max_command_ms: 200 } });
        const { dev } = await pairOverWs(robot.id, pairing.code);
        const op = await ownerJoined(robot.id);
        const before = Date.now() + t.clock.offset;
        op.send({ type: 'command', id: 'd1', kind: 'drive', value: { throttle: 1, steer: 0 }, ms: 5000 });
        const c1 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'd1');
        const d1 = c1.deadline_ms - before;
        assert.ok(d1 > 100 && d1 <= 200 + 60, `capped to <=200 (was ${d1})`);
        dev.send({ type: 'ack', id: c1.id });
        await op.waitFor((m) => m.type === 'command_result' && m.id === 'd1');
        const before2 = Date.now() + t.clock.offset;
        op.send({ type: 'command', id: 'd2', kind: 'drive', value: { throttle: 1, steer: 0 }, ms: 100 });
        const c2 = await dev.waitFor((m) => m.type === 'command' && m.ref === 'd2');
        assert.ok(c2.deadline_ms - before2 <= 100 + 60, `a shorter request is honoured (was ${c2.deadline_ms - before2})`);
        dev.send({ type: 'ack', id: c2.id });
        op.close(); dev.close();
    });

    await check('the full fake-device round trip: pair → hello → command → ack → telemetry → robot_state', async () => {
        const { robot, pairing } = await t.robot(alex);
        const { dev, paired } = await pairOverWs(robot.id, pairing.code);
        assert.strictEqual(paired.profile.id, 'sim.rover');
        const op = await ownerJoined(robot.id);
        op.send({ type: 'command', id: 'c1', kind: 'drive', value: { throttle: 2, steer: -2 } });
        const cmd = await dev.waitFor((m) => m.type === 'command' && m.ref === 'c1');
        assert.deepStrictEqual(cmd.value, { throttle: 1, steer: -1 });   // clamped to the limits
        assert.ok(cmd.deadline_ms > Date.now() + t.clock.offset);
        dev.send({ type: 'ack', id: cmd.id });
        const res = await op.waitFor((m) => m.type === 'command_result' && m.id === 'c1');
        assert.strictEqual(res.result, 'ack');
        assert.ok(Number.isFinite(res.latency_ms));
        // a repeated id answers with the first result and never reaches the device again
        op.send({ type: 'command', id: 'c1', kind: 'drive', value: { throttle: 1 } });
        const again = await op.waitFor((m) => m.type === 'command_result' && m.id === 'c1' && m.cached);
        assert.strictEqual(again.result, 'ack');
        // The robot never sees an operator-chosen id, and a repeat while the first is in flight is not sent twice.
        assert.ok(/^cmd_/.test(cmd.id) && cmd.ref === 'c1', 'the device gets a server-minted id');
        let sentToDevice = 0;
        const counter = (m) => { if (m.type === 'command' && m.ref === 'p1') sentToDevice++; return false; };
        dev.waitFor(counter, 800).catch(() => {});
        op.send({ type: 'command', id: 'p1', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        op.send({ type: 'command', id: 'p1', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        const dup = await op.waitFor((m) => m.type === 'command_result' && m.id === 'p1' && m.result === 'pending');
        assert.strictEqual(dup.cached, true);
        await new Promise((r) => setTimeout(r, 300));
        assert.strictEqual(sentToDevice, 1, 'an in-flight duplicate is not sent to the robot');
        assert.strictEqual(dev.messages.filter((m) => m.type === 'command' && m.ref === 'c1').length, 1, 'only one command frame');
        dev.send({ type: 'telemetry', battery: 0.7, voltage: 7.4, sensors: { ultrasonic: 120 } });
        const state = await op.waitFor((m) => m.type === 'robot_state' && m.state && m.state.telemetry && m.state.telemetry.battery === 0.7);
        assert.strictEqual(state.state.online, true);
        assert.strictEqual(state.state.battery, 0.7);
        const audit = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok(audit.some((a) => a.result === 'ack' && a.kind === 'drive' && a.latency_ms != null), 'the command was audited with its latency');
        op.close(); dev.close();
    });

    await t.close();
    done();
})();

async function poll(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
        if (await fn()) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 25));
    }
}
