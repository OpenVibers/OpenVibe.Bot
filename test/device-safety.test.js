'use strict';
// Device-socket safety without a remote latch: a device may report a Stop held on the machine itself, and that
// report stays local. It never latches a robot, never refuses a later command and is never audited as an action;
// a report for a robot the device is not attached to is still refused. Frames sent during authentication are
// kept and handled in order, and a device's faults reach the panel.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const poll = async (fn, ms = 2000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await fn()) return true; await t.wait(25); }
        return false;
    };

    async function ownerJoined(robotId) {
        const op = await t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(alex)}` } });
        op.send({ type: 'join', robot_id: robotId });
        await op.waitFor((m) => m.type === 'joined');
        return op;
    }
    async function connected() {
        const { robot, pairing } = await t.robot(alex);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        assert.strictEqual(paired.status, 201, paired.text);
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${paired.json.credential}` } });
        await dev.waitFor((m) => m.type === 'config');
        return { robot, dev, deviceId: paired.json.device_id };
    }

    await check('a device\'s own Stop report is accepted and stays local: no latch, no refusal, no audit', async () => {
        const { robot, dev } = await connected();
        const op = await ownerJoined(robot.id);
        dev.send({ type: 'estop_state', latched: true, local_stop: true, reason: 'button on the base', robot_id: robot.id });
        assert.ok(await poll(() => t.domain.robots.get(robot.id).then((r) => r && r.estop_latched === false)), 'the old latch column stays false');
        const cmd = await t.call('POST', `/api/v1/robots/${robot.id}/commands`, { user: alex, body: { id: 'after-stop', kind: 'drive', value: { throttle: 0.2 } } });
        assert.notStrictEqual(cmd.json && cmd.json.code, 'bot.estop_latched', 'a Stop report never refuses a command');
        const audit = await t.domain.audit.list(robot.id, { limit: 10 });
        assert.ok(!audit.some((a) => a.kind === 'estop_state'), 'the report is not an audited action');
        op.close(); dev.close();
    });

    await check('a device\'s faults reach the panel\'s state, and the panel shows them and the robot\'s refusals in words', async () => {
        const { robot, dev } = await connected();
        const op = await ownerJoined(robot.id);
        op.messages.length = 0;
        dev.send({ type: 'status', firmware: 'test', capabilities: {}, faults: [{ code: 'not_connected', driver: 'looi', message: 'LOOI is not answering over Bluetooth' }] });
        const st = await op.waitFor((m) => m.type === 'robot_state' && m.state.status && m.state.status.faults && m.state.status.faults.length === 1);
        assert.deepStrictEqual(st.state.status.faults[0], { code: 'not_connected', driver: 'looi', message: 'LOOI is not answering over Bluetooth' });
        const fs = require('fs');
        const path = require('path');
        const panel = fs.readFileSync(path.join(__dirname, '..', 'public', 'panel.js'), 'utf8');
        assert.match(panel, /state\.status && Array\.isArray\(state\.status\.faults\)/, 'the panel reads the device\'s faults');
        assert.match(panel, /else if \(m\.result === 'nack'\) \{ const t = nackText\(m\.reason\); if \(t\) notice\(t\); \}/, 'and says why the robot refused');
        assert.match(panel, /const QUIET_NACKS = new Set\(\['expired'\]\);/, 'a deadline that passed in transit is not news');
        const html = require('../server/web/render').renderPanel({ robot: { id: robot.id, name: 'R', profile_id: 'sim.rover' }, profile: { id: 'sim.rover', name: 'Rover', commands: {}, widgets: [] }, role: 'operator' });
        assert.ok(html.includes('data-device-fault'), 'the panel has a place for them');
        op.close(); dev.close();
    });

    await check('a device cannot report for a robot it is not attached to (bot.forbidden, no state change)', async () => {
        const { dev, deviceId } = await connected();
        const { robot: other } = await t.robot(alex);
        dev.send({ type: 'estop_state', latched: true, robot_id: other.id });
        const e1 = await dev.waitFor((m) => m.type === 'error');
        assert.strictEqual(e1.code, 'bot.forbidden');
        assert.strictEqual(!!(await t.domain.robots.get(other.id)).estop_latched, false, 'the other robot is untouched');
        const audit = await t.domain.audit.list(other.id, { limit: 5 });
        assert.ok(!audit.some((a) => a.kind === 'estop_state' && a.device_id === deviceId), 'nothing is audited for a report');
        dev.close();
    });

    await check('status and a Stop report sent right after the upgrade are retained, in order', async () => {
        const { robot, pairing } = await t.robot(alex);
        const paired = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robot.id, code: pairing.code } });
        const byCredential = t.domain.devices.byCredential;
        t.domain.devices.byCredential = async (c) => { await t.wait(200); return byCredential(c); };
        let dev;
        try {
            dev = await t.ws('/device', { headers: { Authorization: `Bearer ${paired.json.credential}` } });
            dev.send({ type: 'status', firmware: 'adeept-0.1.0', faults: [] });
            dev.send({ type: 'estop_state', latched: true });
            dev.send({ type: 'status', firmware: 'adeept-0.1.1', faults: [] });
            await dev.waitFor((m) => m.type === 'config');
        } finally { t.domain.devices.byCredential = byCredential; }
        assert.ok(!dev.messages.some((m) => m.type === 'error'), JSON.stringify(dev.messages.filter((m) => m.type === 'error')));
        assert.ok(await poll(() => { const s = t.hub.deviceState(paired.json.device_id); return s && s.status && s.status.firmware === 'adeept-0.1.1'; }), 'both status frames handled, in order');
        const types = dev.messages.map((m) => m.type);
        assert.ok(types.indexOf('hello') < types.indexOf('config'), types.join());
        dev.close();
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
