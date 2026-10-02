'use strict';
// Device-socket safety (plan T15 follow-up A): a device's estop_state is a report that may latch a robot
// it is attached to and never clears the owner's latch; frames sent during authentication are kept and
// handled in order; telemetry carrying events passes the 2-Hz rule; heartbeat_ack correlates through
// `echo` while Bot's envelope seq stays strictly increasing.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');

    async function ownerJoined(robotId) {
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robotId });
        await op.waitFor((m) => m.type === 'joined');
        return op;
    }
    /** A credential from the REST pair, so the socket authenticates by header on the upgrade. */
    async function credentialFor() {
        const { robot, pairing } = await t.robot(alex);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        return { robot, credential: paired.json.credential, deviceId: paired.json.device_id };
    }
    async function connected() {
        const c = await credentialFor();
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${c.credential}` } });
        await dev.waitFor((m) => m.type === 'config');
        return { ...c, dev };
    }

    await check('a device estop_state latched:false never clears the owner latch (a report only)', async () => {
        const { robot, dev } = await connected();
        const op = await ownerJoined(robot.id);
        op.send({ type: 'estop' });
        await dev.waitFor((m) => m.type === 'estop' && m.latched === true);
        dev.send({ type: 'estop_state', latched: false, robot_id: robot.id });
        const st = await op.waitFor((m) => m.type === 'robot_state' && m.state.device_estop && m.state.device_estop.latched === false);
        assert.strictEqual(st.state.estop.latched, true, 'the owner latch stands');
        assert.strictEqual(!!(await t.domain.robots.get(robot.id)).estop_latched, true);
        dev.send({ type: 'estop_state', latched: false });   // robot_id omitted = every attached robot
        await t.wait(100);
        assert.strictEqual(!!(await t.domain.robots.get(robot.id)).estop_latched, true);
        assert.ok(!dev.messages.some((m) => m.type === 'error'), JSON.stringify(dev.messages.filter((m) => m.type === 'error')));
        await assert.rejects(t.domain.estop.set(robot.id, { latched: false, by: 'device', principalKind: 'device' }), (e) => e.code === 'bot.forbidden');
        // the owner clear path still works and tells the device
        op.send({ type: 'estop_clear' });
        await dev.waitFor((m) => m.type === 'estop' && m.latched === false);
        assert.strictEqual(!!(await t.domain.robots.get(robot.id)).estop_latched, false);
        // and a device's latched:true still latches
        dev.send({ type: 'estop_state', latched: true });
        await op.waitFor((m) => m.type === 'robot_state' && m.state.estop.latched === true);
        op.close(); dev.close();
    });

    await check('a device cannot latch or report for a robot it is not attached to (bot.forbidden, audited)', async () => {
        const { dev, deviceId } = await connected();
        const { robot: other } = await t.robot(alex);
        dev.send({ type: 'estop_state', latched: true, robot_id: other.id });
        const e1 = await dev.waitFor((m) => m.type === 'error');
        assert.strictEqual(e1.code, 'bot.forbidden');
        dev.send({ type: 'estop_state', latched: false, robot_id: other.id });
        await dev.waitFor((m) => m.type === 'error' && m !== e1);
        assert.strictEqual(!!(await t.domain.robots.get(other.id)).estop_latched, false, 'the other robot is untouched');
        const audit = await t.domain.audit.list(other.id, { limit: 5 });
        const refused = audit.filter((a) => a.kind === 'estop_state' && a.result === 'refused' && a.reason === 'bot.forbidden' && a.device_id === deviceId);
        assert.strictEqual(refused.length, 2, JSON.stringify(audit));
        dev.close();
    });

    await check('status and estop_state sent right after the upgrade are retained, in order', async () => {
        const { robot, credential, deviceId } = await credentialFor();
        // A slow credential lookup, so the frames below certainly arrive while authentication is in progress.
        const byCredential = t.domain.devices.byCredential;
        t.domain.devices.byCredential = async (c) => { await t.wait(200); return byCredential(c); };
        let dev;
        try {
            dev = await t.ws('/device', { headers: { Authorization: `Bearer ${credential}` } });
            dev.send({ type: 'status', firmware: 'adeept-0.1.0', faults: [] });
            dev.send({ type: 'estop_state', latched: true });
            dev.send({ type: 'status', firmware: 'adeept-0.1.1', faults: [] });
            await dev.waitFor((m) => m.type === 'config');
        } finally { t.domain.devices.byCredential = byCredential; }
        const latched = await poll(async () => !!(await t.domain.robots.get(robot.id)).estop_latched, 2000);
        assert.ok(latched, 'the startup estop_state latched the robot');
        assert.ok(!dev.messages.some((m) => m.type === 'error'), JSON.stringify(dev.messages.filter((m) => m.type === 'error')));
        const state = t.hub.deviceState(deviceId);
        assert.strictEqual(state.status && state.status.firmware, 'adeept-0.1.1', 'both status frames handled, in order');
        const types = dev.messages.map((m) => m.type);
        assert.ok(types.indexOf('hello') < types.indexOf('config'), types.join());
        dev.close();
    });

    await check('a telemetry frame with events inside the 500-ms window is delivered; plain ones are still throttled', async () => {
        const { robot, dev } = await connected();
        const op = await ownerJoined(robot.id);
        dev.send({ type: 'telemetry', battery: 0.5 });
        dev.send({ type: 'telemetry', battery: 0.4, events: [{ kind: 'bump', at: Date.now() }] });
        dev.send({ type: 'telemetry', battery: 0.39, events: [{ kind: 'low_battery' }] });
        dev.send({ type: 'telemetry', battery: 0.3 });
        await op.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.battery === 0.4);
        await op.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.battery === 0.39);
        await t.wait(150);
        assert.ok(!op.messages.some((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.battery === 0.3), 'a plain frame inside the window is dropped');
        op.close(); dev.close();
    });

    await check('heartbeat_ack echoes t; Bot\'s envelope seq stays strictly increasing', async () => {
        const { dev } = await connected();
        for (let i = 1; i <= 4; i++) dev.send({ type: 'heartbeat', seq: 1, t: 1000 + i, rtt_ms: 10 });
        dev.send({ type: 'heartbeat', rtt_ms: 10 });
        await dev.waitFor(() => dev.messages.filter((m) => m.type === 'heartbeat_ack').length === 5);
        const acks = dev.messages.filter((m) => m.type === 'heartbeat_ack');
        assert.deepStrictEqual(acks.map((a) => a.echo), [1001, 1002, 1003, 1004, null]);
        const seqs = dev.messages.map((m) => m.seq);
        for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs.join(',')}`);
        dev.close();
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
