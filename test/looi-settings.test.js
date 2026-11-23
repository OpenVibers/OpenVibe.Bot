'use strict';
// LOOI on a phone (Maticus, 11-21 and 11-23): the robot's settings from the panel as requests the robot checks, its own
// report read back (status.capabilities.looi_bridge), a turn holder reaching the app as an operator, a queue that waits
// while the robot cannot move, presses that never count the stick, and refusals in words. No hardware: a fake device.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
require('../server/realtime');

(async () => {
    // The hold test steps the injected clock 30 s, and device liveness runs on the same clock: at the suite-wide 200 ms beat a
    // sweep between the step and the robot's next report would drop the fake phone (the headlight suite's flake). A minute.
    const t = await boot({ env: { BOT_HEARTBEAT_MS: '60000' } });
    const alex = t.network.newUser('alex');     // the owner
    const mona = t.network.newUser('mona');     // a Mod
    const otto = t.network.newUser('otto');     // an Operator
    const quinn = t.network.newUser('quinn');   // a viewer taking turns
    const vera = t.network.newUser('vera');     // a viewer waiting in line
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
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
        await dev.waitFor((m) => m.type === 'hello');
        await dev.waitFor((m) => m.type === 'config');
        return dev;
    }
    // What the LOOI app sends (Maticus's spec §4): its host policy nested in status.capabilities.looi_bridge.
    const report = (dev, bridge) => dev.send({ type: 'status', firmware: 'looi-android/0.2.16-m2', estop_latched: false,
        capabilities: { drive: { type: 'differential', axes: ['throttle', 'steer'] }, looi_bridge: bridge } });

    await check('settings are the owner\'s and Mods\': a request the robot gets as `setting`, Off for the spin limit is the owner\'s alone', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        await invite(robot.id, mona.subject, 'mod');
        await invite(robot.id, otto.subject, 'operator');
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const m = await op(mona); const o = await op(otto);
        const [ja, jm, jo] = [await join(a, robot.id), await join(m, robot.id), await join(o, robot.id)];
        assert.ok(ja.allowed_commands.includes('setting') && jm.allowed_commands.includes('setting'));
        assert.ok(!jo.allowed_commands.includes('setting'), 'an Operator drives; the settings are not theirs');

        cmd(m, { id: 's1', kind: 'setting', value: { name: 'speed_stage', value: 48 } });
        const s1 = await dev.waitFor((x) => x.type === 'command' && x.ref === 's1');
        assert.strictEqual(s1.kind, 'setting');
        assert.deepStrictEqual(s1.value, { name: 'speed_stage', value: 48 });
        assert.deepStrictEqual(s1.operator, { subject: mona.subject, role: 'mod' });
        assert.strictEqual(s1.deadline_ms, null, 'a setting is not motion: no deadline');
        // The robot refuses in its own words, and the panel gets them.
        dev.send({ type: 'nack', id: s1.id, fault_code: 'moving', message: 'Stop the tracks before changing speed' });
        const r1 = await result(m, 's1');
        assert.deepStrictEqual([r1.result, r1.reason], ['nack', 'Stop the tracks before changing speed']);

        cmd(o, { id: 's2', kind: 'setting', value: { name: 'mode', value: 'camera_only' } });
        const r2 = await result(o, 's2');
        assert.deepStrictEqual([r2.result, r2.code], ['refused', 'bot.command_not_allowed']);
        assert.match(r2.reason, /Only the owner and Mods change the robot's settings/);

        cmd(m, { id: 's3', kind: 'setting', value: { name: 'yaw_limit', value: 'off' } });
        const r3 = await result(m, 's3');
        assert.deepStrictEqual([r3.result, r3.code], ['refused', 'bot.owner_only']);
        t.clock.offset += 1000;
        cmd(a, { id: 's4', kind: 'setting', value: { name: 'yaw_limit', value: 'off' } });
        const s4 = await dev.waitFor((x) => x.type === 'command' && x.ref === 's4');
        assert.deepStrictEqual(s4.value, { name: 'yaw_limit', value: 'off' });
        dev.send({ type: 'ack', id: s4.id });
        assert.strictEqual((await result(a, 's4')).result, 'ack');

        cmd(a, { id: 's5', kind: 'setting', value: { name: 'speed_stage', value: 50 } });
        const r5 = await result(a, 's5');
        assert.deepStrictEqual([r5.result, r5.code], ['refused', 'bot.invalid_input'], 'only a declared stage');
        cmd(a, { id: 's6', kind: 'setting', value: { name: 'yaw_center' } });
        const s6 = await dev.waitFor((x) => x.type === 'command' && x.ref === 's6');
        assert.deepStrictEqual(s6.value, { name: 'yaw_center' }, 'Set center here is an action with no value');
        a.close(); m.close(); o.close(); dev.close();
    });

    await check('the robot\'s own report reaches every panel in Bot\'s words: why it waits and the settings in effect', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex);
        await join(a, robot.id);
        report(dev, { operators_allowed: false, mode: 'DRIVE_AND_HEAD', speed_stage: '24', armed: false, yaw_limit: 90, yaw_from_center: -12.34, yaw_center_set: true });
        const st = await a.waitFor((x) => x.type === 'robot_state' && x.state.ready && x.state.ready.reported);
        const r = st.state.ready;
        assert.strictEqual(r.why, 'not_armed');
        assert.deepStrictEqual([r.armed, r.remote, r.stop], [false, false, false]);
        assert.deepStrictEqual(r.settings, { mode: 'drive_and_head', speed_stage: 24, yaw_limit: 90 }, 'the app\'s names are the profile\'s options');
        assert.strictEqual(r.yaw_from_center, -12.3);
        report(dev, { operators_allowed: false, mode: 'CAMERA_ONLY', speed_stage: '96', armed: true });
        const st2 = await a.waitFor((x) => x.type === 'robot_state' && x.state.ready && x.state.ready.armed === true);
        assert.strictEqual(st2.state.ready.why, 'remote_off', 'armed, but nobody else may drive yet');
        assert.deepStrictEqual(st2.state.ready.settings, { mode: 'camera_only', speed_stage: 96 });
        a.close(); dev.close();
    });

    await check('a turn holder reaches the app as an operator (turn: true, via queue); driving never spends the turn\'s presses', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi', access_policy: 'queue', limits: { turn_ms: 60000, turn_budget: 3 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const q = await op(quinn);
        const jq = await join(q, robot.id);
        assert.strictEqual(jq.role, 'queue');
        for (let i = 0; i < 6; i++) {
            cmd(q, { id: `d${i}`, kind: 'drive', value: { throttle: 0.2, steer: 0 } });
            const c = await dev.waitFor((x) => x.type === 'command' && x.ref === `d${i}`);
            if (i === 0) assert.deepStrictEqual(c.operator, { subject: quinn.subject, role: 'operator', via: 'queue', turn: true });
            dev.send({ type: 'ack', id: c.id });
            assert.strictEqual((await result(q, `d${i}`)).result, 'ack', `drive ${i} passes: a budget of 3 presses is not spent by the stick`);
        }
        const state = await t.domain.queue.state(robot.id, quinn.subject);
        assert.strictEqual(state.used, 0);
        // The audit keeps Bot's own role.
        const rows = await t.domain.audit.list(robot.id, { limit: 5 });
        assert.ok((rows.items || rows).some((row) => row.role === 'queue' && row.kind === 'drive'));
        q.close(); dev.close();
    });

    await check('a robot that cannot move holds the line: the turn keeps its time, says why, and goes on when it is armed', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi', access_policy: 'queue', limits: { turn_ms: 60000, turn_budget: 50 } });
        const dev = await deviceFor(robot.id, pairing.code);
        const q = await op(quinn);
        await join(q, robot.id);
        const v = await op(vera);
        await join(v, robot.id);
        // Vera waits: not "you are not an operator", but her place in line.
        cmd(v, { id: 'v1', kind: 'drive', value: { throttle: 0.2 } });
        const rv = await result(v, 'v1');
        assert.strictEqual(rv.code, 'bot.not_your_turn');
        assert.match(rv.reason, /not your turn yet\. You are #1 in line/);
        const before = await t.domain.queue.state(robot.id, quinn.subject);
        report(dev, { operators_allowed: true, mode: 'DRIVE_AND_HEAD', speed_stage: '24', armed: false });
        await q.waitFor((x) => x.type === 'robot_state' && x.state.queue && x.state.queue.paused && x.state.queue.paused.by === 'robot');
        const held = await t.domain.queue.state(robot.id, quinn.subject);
        assert.deepStrictEqual([held.paused.by, held.paused.why], ['robot', 'not_armed']);
        cmd(q, { id: 'h1', kind: 'drive', value: { throttle: 0.2 } });
        const rh = await result(q, 'h1');
        assert.strictEqual(rh.code, 'bot.robot_not_ready');
        assert.match(rh.reason, /keeps its time: the robot is not armed yet/);
        t.clock.offset += 30000;   // thirty seconds unarmed (liveness is a minute here)
        report(dev, { operators_allowed: true, mode: 'DRIVE_AND_HEAD', speed_stage: '24', armed: true });
        await q.waitFor((x) => x.type === 'robot_state' && x.state.queue && !x.state.queue.paused);
        const after = await t.domain.queue.state(robot.id, quinn.subject);
        assert.ok(after.active, 'still Quinn\'s turn');
        const kept = Date.parse(after.turn_ends_at) - Date.parse(before.turn_ends_at);
        assert.ok(kept >= 29000 && kept <= 31000, `the paused time is added to the turn (${kept} ms)`);
        cmd(q, { id: 'h2', kind: 'drive', value: { throttle: 0.2 } });
        const c = await dev.waitFor((x) => x.type === 'command' && x.ref === 'h2');
        dev.send({ type: 'ack', id: c.id });
        assert.strictEqual((await result(q, 'h2')).result, 'ack');
        q.close(); v.close(); dev.close();
    });

    await check('the panel draws the robot card from the profile, hidden until the robot reports; the owner sets turns', async () => {
        const { robot } = await t.robot(alex, { profile_id: 'looi', access_policy: 'queue' });
        const page = await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(alex) }).then((r) => r.text());
        assert.match(page, /data-widget="settings"[^>]*hidden/);
        assert.match(page, /data-set="speed_stage"/);
        assert.match(page, /data-option="&quot;off&quot;" data-owner-only/);
        assert.match(page, /data-set-action="yaw_center"/);
        assert.match(page, /action="\/robots\/[^"]+\/turns"/, 'the owner\'s Taking turns card');
        assert.match(page, /Driving and the head never count/);
    });

    await check('the owner revokes an old device from the robot\'s page: it disconnects at once and the card lists only the rest', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi' });
        const dev = await deviceFor(robot.id, pairing.code);
        const page = await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(alex) }).then((r) => r.text());
        const id = (page.match(/\/devices\/(dev_[0-9A-Z]+)\/revoke/) || [])[1];
        assert.ok(id, 'the Devices card names the device with its Revoke');
        assert.match(page, /Online now/);
        const closed = new Promise((resolve) => dev.ws.on('close', (code) => resolve(code)));
        const r = await fetch(`${t.base}/robots/${robot.id}/devices/${id}/revoke`, { method: 'POST', redirect: 'manual',
            headers: { ...cookie(alex), Origin: t.base, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(await closed, 4003, 'revoked: the socket closes');
        const after = await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(alex) }).then((x) => x.text());
        assert.ok(!after.includes(`/devices/${id}/revoke`), 'a revoked device leaves the card');
        const other = await fetch(`${t.base}/robots/${robot.id}/devices/${id}/revoke`, { method: 'POST', redirect: 'manual',
            headers: { ...cookie(quinn), Origin: t.base, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
        assert.ok(other.status === 403 || other.status === 404, `only the owner (${other.status})`);
    });

    await check('a guest takes a turn where the owner lets guests: one place per network, the robot sees an operator\'s turn, the page closing leaves the line', async () => {
        const { robot, pairing } = await t.robot(alex, { profile_id: 'looi', access_policy: 'queue', limits: { turn_ms: 60000, turn_budget: 50 } });
        await t.domain.robots.setEmbedPublic(robot.id, true);
        const dev = await deviceFor(robot.id, pairing.code);
        const watch = (ip) => t.ws('/watch', { headers: { 'X-Forwarded-For': ip } });
        const g = await watch('10.9.0.1');
        g.send({ type: 'join', robot_id: robot.id });
        const j0 = await g.waitFor((m) => m.type === 'joined');
        assert.deepStrictEqual([j0.role, j0.guest_turns], ['watcher', false], 'off until the owner turns it on');
        g.send({ type: 'take_turn' });
        const off = await g.waitFor((m) => m.type === 'error');
        assert.strictEqual(off.code, 'bot.sign_in');

        await t.domain.robots.update(robot.id, { limits: { turn_ms: 60000, turn_budget: 50, guest_turns: true } }, { subject: alex.subject, kind: 'user' });
        g.send({ type: 'join', robot_id: robot.id });
        const j1 = await g.waitFor((m) => m.type === 'joined' && m.guest_turns === true);
        assert.strictEqual(j1.role, 'watcher');
        g.send({ type: 'take_turn' });
        const j2 = await g.waitFor((m) => m.type === 'joined' && m.guest === true);
        assert.strictEqual(j2.role, 'queue');
        assert.ok(j2.allowed_commands.includes('drive') && !j2.allowed_commands.includes('setting'));
        assert.ok(j2.state.queue && j2.state.queue.active, 'first in line: the turn is the guest\'s');
        g.send({ type: 'command', id: 'g1', kind: 'drive', value: { throttle: 0.3, steer: 0 } });
        const c = await dev.waitFor((m) => m.type === 'command' && m.ref === 'g1');
        assert.match(c.operator.subject, /^gst_[A-Za-z0-9_-]{8,40}$/, 'a random guest id, nothing that names them');
        assert.deepStrictEqual([c.operator.role, c.operator.via, c.operator.turn], ['operator', 'queue', true]);
        dev.send({ type: 'ack', id: c.id });
        assert.strictEqual((await g.waitFor((m) => m.type === 'command_result' && m.id === 'g1')).result, 'ack');
        // A setting is never a guest's.
        g.send({ type: 'command', id: 'g2', kind: 'setting', value: { name: 'speed_stage', value: 127 } });
        const r2 = await g.waitFor((m) => m.type === 'command_result' && m.id === 'g2');
        assert.strictEqual(r2.result, 'refused');

        // One place per network and robot.
        const h = await watch('10.9.0.1');
        h.send({ type: 'join', robot_id: robot.id });
        await h.waitFor((m) => m.type === 'joined');
        h.send({ type: 'take_turn' });
        assert.strictEqual((await h.waitFor((m) => m.type === 'error')).code, 'bot.one_place');
        // Another network waits its turn.
        const k = await watch('10.9.0.2');
        k.send({ type: 'join', robot_id: robot.id });
        await k.waitFor((m) => m.type === 'joined');
        k.send({ type: 'take_turn' });
        const jk = await k.waitFor((m) => m.type === 'joined' && m.guest === true);
        assert.strictEqual(jk.state.queue.position, 1);
        k.send({ type: 'command', id: 'k1', kind: 'drive', value: { throttle: 0.3 } });
        assert.strictEqual((await k.waitFor((m) => m.type === 'command_result' && m.id === 'k1')).code, 'bot.not_your_turn');

        // The first guest closes the page: the line moves on.
        g.close();
        await k.waitFor((m) => m.type === 'robot_state' && m.state.queue && m.state.queue.active);
        h.close(); k.close(); dev.close();
    });

    await done();
})();
