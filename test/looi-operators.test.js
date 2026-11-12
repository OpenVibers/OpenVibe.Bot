'use strict';
// The LOOI Operators card and battery (Maticus's 2026-11-12 spec): a Mod role, per-person on/off, sole control,
// the authority audit, and the battery bound to the Node's top-level `battery` (0..100). A tray's own Stop stays
// local. No hardware: the fake device and the real HTTP panel only.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { loadProfiles } = require('../server/profiles');
// The /control and /device frames under test are server/realtime.js's; require it so the runner maps this test to it.
require('../server/realtime');

(async () => {
    const t = await boot({ env: { BOT_HEARTBEAT_MS: '60000', BOT_OFFLINE_MISSES: '100' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');
    const dave = t.network.newUser('dave');
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const get = (p, user) => fetch(t.base + p, { redirect: 'manual', headers: user ? cookie(user) : {} });
    const op = (user) => t.ws('/control', { headers: cookie(user) });
    const invite = (robotId, subject, role) => t.call('POST', `/api/v1/robots/${robotId}/operators`, { user: alex, body: { subject, role } });
    const cmd = (client, o) => client.send({ type: 'command', ...o });
    const result = (client, id) => client.waitFor((m) => m.type === 'command_result' && m.id === id);
    const opResult = (client, id) => client.waitFor((m) => m.type === 'operators_result' && m.id === id);
    let seq = 0;
    const nextId = (p) => `${p}-${++seq}`;
    async function join(client, robotId) {
        client.send({ type: 'join', robot_id: robotId });
        return client.waitFor((m) => m.type === 'joined' || m.type === 'error');
    }
    async function deviceFor(robotId, code) {
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        await dev.waitFor((m) => m.type === 'config');
        return dev;
    }
    async function act(client, action, fields = {}) {
        const id = nextId(`ops-${action}`);
        client.send({ type: 'operators', id, action, ...fields });
        return opResult(client, id);
    }
    async function promotedMod(client, robotId, subject) {
        const r = await act(client, 'role', { subject, role: 'mod' });
        assert.strictEqual(r.ok, true, r.reason);
        return r;
    }
    /** Send a drive, wait for the device's copy, ack it, and return the operator's result. */
    async function drive(client, dev, id, extra = {}) {
        cmd(client, { id, kind: 'drive', value: { throttle: 0.2, steer: 0 }, ...extra });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === id);
        if (!c) throw new Error(`no device command for ${id}`);
        dev.send({ type: 'ack', id: c.id });
        return result(client, id);
    }
    const looi = loadProfiles().get('looi');

    await check('the battery reads the Node top-level percent (0..100), a dash/unknown when missing, and p7 provisional', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        await join(a, robot.id);
        dev.send({ type: 'telemetry', battery: 42, sensors: { ultrasonic: 120 } });
        const st = await a.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.battery === 42);
        assert.strictEqual(st.state.battery, 0.42, '42 % becomes the 0..1 fraction the meter draws');
        const html = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(html.includes('data-status-row'), 'Battery | Latency is one compact status row');
        assert.ok(html.includes('data-battery-note>unknown'), 'the initial meter says unknown, never 0 %');
        assert.ok(html.includes('data-battery-provisional'), 'the provisional note is in the markup');
        // A full 100 is 100 %, not 1 %: a number above 1 is a percent, not the legacy fraction.
        dev.send({ type: 'telemetry', battery: 100, events: [{ kind: 'battery_full' }], sensors: { p7_battery: { pct: 100, usb: true, raw: '6401', unverified: true } } });
        const full = await a.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.battery === 100);
        assert.strictEqual(full.state.battery, 1);
        assert.strictEqual(full.state.telemetry.sensors.p7_battery.unverified, true, 'the raw provisional reading reaches the panel state');
        // Missing is null (a dash and an empty bar), never a made-up 0.
        dev.send({ type: 'telemetry', events: [{ kind: 'battery_clear' }], sensors: { cleared: true } });
        const none = await a.waitFor((m) => m.type === 'robot_state' && m.state.telemetry && m.state.telemetry.sensors && m.state.telemetry.sensors.cleared === true);
        assert.strictEqual(none.state.battery, null, 'no battery field is null, not 0');
        a.close(); dev.close();
    });

    await check('sole control admits only that subject; others are refused with a visible message; the owner overrides', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        await invite(robot.id, carol.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const b = await op(bob); const c = await op(carol);
        await join(a, robot.id); await join(b, robot.id); await join(c, robot.id);
        const granted = await act(a, 'sole', { subject: bob.subject });
        assert.strictEqual(granted.ok, true, granted.reason);
        const bobDrive = await drive(b, dev, 'sole-bob');
        assert.strictEqual(bobDrive.result, 'ack');
        cmd(c, { id: 'sole-carol', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        const refused = await result(c, 'sole-carol');
        assert.strictEqual(refused.result, 'refused');
        assert.strictEqual(refused.code, 'bot.sole_control');
        assert.strictEqual(refused.reason, 'Sole control is on: only the person it was given to can send commands right now. The owner or a Mod can switch back to Everyone.');
        // Owner always overrides, including while someone else has sole control.
        const ownerDrive = await drive(a, dev, 'sole-owner');
        assert.strictEqual(ownerDrive.result, 'ack');
        // halt always passes: safety is not blocked by sole control.
        cmd(c, { id: 'sole-halt', kind: 'halt', value: {} });
        const halt = await dev.waitFor((m) => m.type === 'command' && m.ref === 'sole-halt');
        assert.ok(halt, 'a halt reaches the device even under sole control');
        dev.send({ type: 'ack', id: halt.id });
        // Everyone gives shared control back to all enabled operators.
        const cleared = await act(a, 'sole', { subject: null });
        assert.strictEqual(cleared.ok, true);
        const carolDrive = await drive(c, dev, 'sole-carol-2');
        assert.strictEqual(carolDrive.result, 'ack');
        a.close(); b.close(); c.close(); dev.close();
    });

    await check('an Operator switched off is refused immediately; Mods switch Operators, the owner switches Mods', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        await invite(robot.id, carol.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const b = await op(bob);
        await join(a, robot.id); await join(b, robot.id);
        assert.strictEqual((await act(a, 'role', { subject: bob.subject, role: 'mod' })).ok, true);
        await b.waitForClose();
        const b2 = await op(bob); await join(b2, robot.id);
        assert.strictEqual((await act(b2, 'toggle', { subject: carol.subject, on: false })).ok, true);
        const c = await op(carol); await join(c, robot.id);
        cmd(c, { id: 'off-1', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        const off = await result(c, 'off-1');
        assert.strictEqual(off.code, 'bot.operator_off');
        assert.strictEqual(off.reason, 'You are switched off on this robot. The owner or a Mod can switch you back on.');
        assert.strictEqual((await act(b2, 'toggle', { subject: carol.subject, on: true })).ok, true);
        const on = await drive(c, dev, 'off-2');
        assert.strictEqual(on.result, 'ack');
        // The owner switches the Mod off; the Mod's gate reads it fresh and refuses.
        assert.strictEqual((await act(a, 'toggle', { subject: bob.subject, on: false })).ok, true);
        cmd(b2, { id: 'mod-off', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        assert.strictEqual((await result(b2, 'mod-off')).code, 'bot.operator_off');
        assert.strictEqual((await act(a, 'toggle', { subject: bob.subject, on: true })).ok, true);
        // A Mod cannot switch a Mod (itself), and nobody switches the owner off.
        const self = await act(b2, 'toggle', { subject: bob.subject, on: false });
        assert.strictEqual(self.ok, false);
        assert.strictEqual(self.code, 'bot.mod_limited');
        const owner = await act(a, 'toggle', { subject: alex.subject, on: false });
        assert.strictEqual(owner.ok, false);
        assert.strictEqual(owner.code, 'bot.owner_always_on');
        a.close(); b2.close(); c.close(); dev.close();
    });

    await check('Mods may grant/clear sole control; they may not promote, change Viewer access, or touch the tray', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        await invite(robot.id, carol.subject, 'operator');
        await invite(robot.id, dave.subject, 'viewer');
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const b = await op(bob);
        await join(a, robot.id); await join(b, robot.id);
        await promotedMod(a, robot.id, bob.subject);
        await b.waitForClose();
        const b2 = await op(bob); await join(b2, robot.id);
        assert.strictEqual((await act(b2, 'sole', { subject: carol.subject })).ok, true);
        cmd(b2, { id: 'mod-sole', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        assert.strictEqual((await result(b2, 'mod-sole')).code, 'bot.sole_control');
        assert.strictEqual((await act(b2, 'sole', { subject: null })).ok, true);
        // Old Mod limits.
        const promote = await act(b2, 'role', { subject: carol.subject, role: 'mod' });
        assert.deepStrictEqual([promote.ok, promote.code], [false, 'bot.owner_only']);
        const policy = await act(b2, 'policy', { policy: 'queue' });
        assert.deepStrictEqual([policy.ok, policy.code], [false, 'bot.mod_limited']);
        const viewerBtn = await act(b2, 'toggle', { subject: dave.subject, on: false });
        assert.strictEqual(viewerBtn.ok, false, 'viewers are not an Operator switch');
        // The Mod cannot change the owner's Viewer access through the owner's form either.
        const form = await fetch(`${t.base}/robots/${robot.id}/access`, { method: 'POST', redirect: 'manual',
            headers: { ...cookie(bob), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'access_policy=queue' });
        assert.strictEqual(form.status, 403);
        const limits = await fetch(`${t.base}/robots/${robot.id}/limits`, { method: 'POST', redirect: 'manual',
            headers: { ...cookie(bob), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'max_speed=0.9&max_turn=0.9' });
        assert.strictEqual(limits.status, 403, 'a Mod cannot change speed or turn');
        // The viewer never drives.
        const d = await op(dave); await join(d, robot.id);
        cmd(d, { id: 'viewer-drive', kind: 'drive', value: { throttle: 0.2, steer: 0 } });
        assert.strictEqual((await result(d, 'viewer-drive')).code, 'bot.read_only');
        a.close(); b2.close(); d.close(); dev.close();
    });

    await check('every authority change is audited with who did it, and the activity is Bot\'s own stamp', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const b = await op(bob);
        await join(a, robot.id); await join(b, robot.id);
        await act(a, 'sole', { subject: bob.subject });
        const drove = await drive(b, dev, 'act-drive');
        assert.strictEqual(drove.result, 'ack');
        const driveState = await a.waitFor((m) => m.type === 'operators_state' && m.operators.activity && m.operators.activity[bob.subject] && m.operators.activity[bob.subject].last);
        assert.strictEqual(driveState.operators.activity[bob.subject].last.channel, 'drive');
        assert.ok(driveState.operators.activity[bob.subject].last.at, 'the command has a when');
        assert.strictEqual((await act(a, 'sole', { subject: null })).ok, true);
        // Head and lights are their own channels; lights are non-motion.
        cmd(b, { id: 'act-head', kind: 'actuator', value: { name: 'head', value: 0.3 } });
        const head = await dev.waitFor((m) => m.type === 'command' && m.ref === 'act-head');
        dev.send({ type: 'ack', id: head.id });
        await result(b, 'act-head');
        const headState = await a.waitFor((m) => m.type === 'operators_state' && m.operators.activity[bob.subject] && m.operators.activity[bob.subject].last.channel === 'head');
        assert.ok(headState);
        cmd(b, { id: 'act-lights', kind: 'headlight', value: { on: true } });
        const lights = await dev.waitFor((m) => m.type === 'command' && m.ref === 'act-lights');
        dev.send({ type: 'ack', id: lights.id });
        await result(b, 'act-lights');
        const lightState = await a.waitFor((m) => m.type === 'operators_state' && m.operators.activity[bob.subject] && m.operators.activity[bob.subject].last.channel === 'lights');
        assert.ok(lightState);
        assert.strictEqual((await act(a, 'toggle', { subject: bob.subject, on: false })).ok, true);
        await act(a, 'toggle', { subject: bob.subject, on: true });
        await promotedMod(a, robot.id, bob.subject);
        await b.waitForClose();
        const b2 = await op(bob); await join(b2, robot.id);
        // The audit names the actors and actions, never a token or a command payload.
        const rows = await t.domain.operators.auditList(robot.id, { limit: 50 });
        const actions = rows.map((r) => r.action);
        for (const a of ['operator.sole', 'operator.toggle', 'operator.role']) assert.ok(actions.includes(a), a);
        assert.ok(rows.every((r) => JSON.stringify(r.value).length < 400 && !/token|bearer|secret/i.test(JSON.stringify(r.value))));
        a.close(); b2.close(); dev.close();
    });

    await check('the panel draws the card for each role, with the owner-only and Mod-only controls', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, bob.subject, 'operator');
        await invite(robot.id, carol.subject, 'operator');
        await invite(robot.id, dave.subject, 'viewer');
        const ownerHtml = await (await get(`/panel/${robot.id}`, alex)).text();
        assert.ok(ownerHtml.includes('data-operators'), 'the owner sees the card');
        assert.ok(ownerHtml.includes('data-operator-subject='), 'rows carry their subject');
        assert.ok(!ownerHtml.includes('data-operators-estop') && !/E-STOP|estop|emergency stop/i.test(ownerHtml.replace(/estop_state|estop_latched/g, '')), 'the card has no E-STOP row, button or note');
        assert.ok(ownerHtml.includes('Make Mod'), 'the owner can promote an Operator');
        const ownerOp = await op(alex); await join(ownerOp, robot.id);
        await promotedMod(ownerOp, robot.id, bob.subject);
        ownerOp.close();
        const modHtml = await (await get(`/panel/${robot.id}`, bob)).text();
        assert.ok(modHtml.includes('data-operators'), 'a Mod sees the card');
        assert.ok(!modHtml.includes('Make Mod') && !modHtml.includes('Make Operator'), 'a Mod has no owner-only role buttons');
        assert.ok(modHtml.includes('data-operator-sole'), 'a Mod can grant sole control');
        const opHtml = await (await get(`/panel/${robot.id}`, carol)).text();
        assert.ok(opHtml.includes('data-operators') && !opHtml.includes('data-operator-sole'), 'an Operator sees the roster but no controls');
        const viewerHtml = await (await get(`/panel/${robot.id}`, dave)).text();
        assert.ok(viewerHtml.includes('Viewers') && !viewerHtml.includes('data-operator-sole'), 'a viewer watches only');
    });

    await t.close();
    done();
})();
