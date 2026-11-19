'use strict';
// Crowd control, stage 2 (plan §H2, Maticus's mixer): on a robot whose access_policy is `crowd`, viewers steer
// together. Their drives are inputs; one mixed command a tick reaches the device through the same gate as an operator's
// (the owner's limits, the viewer cap, sole control), as the `crowd` role. A crowd member cannot halt or send anything
// else; the owner driving pauses the crowd; an idle crowd sends nothing.
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    const carol = t.network.newUser('carol');

    const op = (user) => t.ws('/control', { headers: { Authorization: `Bearer ${t.network.signUser(user)}` } });
    async function join(client, robotId) {
        client.send({ type: 'join', robot_id: robotId });
        return client.waitFor((m) => m.type === 'joined' || m.type === 'error');
    }
    async function deviceFor(robotId, code) {
        const p = await t.call('POST', '/api/v1/pair', { token: null, body: { robot: robotId, code } });
        const dev = await t.ws('/device', { headers: { Authorization: `Bearer ${p.json.credential}` } });
        await dev.waitFor((m) => m.type === 'hello');
        // The test link calls a device offline after 400 ms of silence (helpers/app.js): this one keeps beating.
        const beat = setInterval(() => { try { dev.send({ type: 'heartbeat', t: Date.now() }); } catch { /* closing */ } }, 100);
        const close = dev.close.bind(dev);
        dev.close = () => { clearInterval(beat); close(); };
        return dev;
    }
    const cmd = (client, o) => client.send({ type: 'command', ...o });
    const result = (client, id) => client.waitFor((m) => m.type === 'command_result' && m.id === id);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const isCrowd = (x) => x.type === 'command' && /^crowd-/.test(String(x.ref));
    /** The device's crowd commands since a mark (its messages keep every frame). */
    const crowdSince = (dev, mark) => dev.messages.slice(mark).filter(isCrowd);
    async function auditRow(robotId, pred, ms = 3000) {
        const end = Date.now() + ms;
        for (;;) { const rows = await t.domain.audit.list(robotId, { limit: 50 }); const hit = rows.find(pred); if (hit || Date.now() > end) return hit || null; await pause(60); }
    }

    await check('a crowd robot: viewers join as the crowd, may only drive, and two opposite pulls become one capped command', async () => {
        const { robot, pairing } = await t.robot(alex, { access_policy: 'crowd', limits: { crowd: { style: 'tug', cap: 0.5 } } });
        assert.strictEqual(robot.access_policy, 'crowd');
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob); const c = await op(carol);
        const jb = await join(b, robot.id); await join(c, robot.id);
        assert.strictEqual(jb.role, 'crowd');
        assert.deepStrictEqual(jb.allowed_commands, ['drive'], 'no halt for a crowd member');
        cmd(b, { id: 'h1', kind: 'halt', value: {} });
        assert.strictEqual((await result(b, 'h1')).code, 'bot.crowd_drive_only');
        cmd(b, { id: 'b1', kind: 'drive', value: { throttle: 1, steer: 1 } });
        cmd(c, { id: 'c1', kind: 'drive', value: { throttle: 1, steer: -1 } });
        const rb = await result(b, 'b1');
        assert.strictEqual(rb.result, 'mixed');
        const m = await dev.waitFor((x) => isCrowd(x) && x.value && x.value.throttle > 0, 3000);
        dev.send({ type: 'ack', id: m.id });
        assert.strictEqual(m.kind, 'drive');
        assert.ok(Math.abs(m.value.throttle - 0.5) < 1e-9, `the average forward pull, held to the 0.5 cap: ${JSON.stringify(m.value)}`);
        assert.ok(Math.abs(m.value.steer) < 1e-9, 'opposite steering cancels in tug-of-war');
        assert.strictEqual(m.operator && m.operator.role, 'crowd');
        assert.ok(t.app.locals.hub.crowdTelemetry(robot.id), 'telemetry for the Operators card');
        // bot.crowd-tick@1 reaches every panel: how many steer and their pull, naming no one.
        const tick = await b.waitFor((x) => x.type === 'crowd_tick' && x.people === 2, 3000);
        const v = validate('bot.crowd-tick@1', tick);
        assert.ok(v.valid !== false && !(v.errors && v.errors.length), `the tick keeps its contract: ${JSON.stringify(v.errors || v)}`);
        assert.deepStrictEqual([tick.style, tick.paused, tick.override, tick.pull.steer], ['tug', false, null, 0]);
        assert.ok(!JSON.stringify(tick).includes(bob.subject) && !JSON.stringify(tick).includes(carol.subject), 'no subject in the tick');
        assert.ok(await auditRow(robot.id, (a) => a.role === 'crowd' && a.kind === 'drive' && a.result === 'ack'), 'the mixed command is audited as the crowd');
        // Four commands a second reach the device, but the audit keeps one row a second per result.
        const ack = setInterval(() => { for (const x of dev.messages) if (isCrowd(x) && !x.acked) { x.acked = true; dev.send({ type: 'ack', id: x.id }); } }, 20);
        const steer = setInterval(() => { cmd(b, { kind: 'drive', value: { throttle: 1 } }); cmd(c, { kind: 'drive', value: { throttle: 1 } }); }, 100);
        await pause(1300);
        clearInterval(steer); clearInterval(ack);
        const sent = dev.messages.filter(isCrowd).length;
        const rows = (await t.domain.audit.list(robot.id, { limit: 50 })).filter((a) => a.role === 'crowd');
        assert.ok(sent >= 4, `the crowd drove on every tick: ${sent}`);
        assert.ok(rows.length <= 3, `the audit is thinned to about one row a second: ${rows.length} rows for ${sent} commands`);
        b.close(); c.close(); dev.close();
    });

    await check('the owner driving pauses the crowd; sole control stops it', async () => {
        const { robot, pairing } = await t.robot(alex, { access_policy: 'crowd', limits: { crowd: { style: 'last', cap: 1 } } });
        const dev = await deviceFor(robot.id, pairing.code);
        const a = await op(alex); const b = await op(bob);
        assert.strictEqual((await join(a, robot.id)).role, 'owner');
        await join(b, robot.id);
        cmd(a, { id: 'o1', kind: 'drive', value: { throttle: 0.2 } });
        const owned = await dev.waitFor((x) => x.type === 'command' && x.ref === 'o1');
        dev.send({ type: 'ack', id: owned.id });
        const mark = dev.messages.length;
        cmd(b, { id: 'b2', kind: 'drive', value: { throttle: 0.9 } });
        await result(b, 'b2');
        await pause(500);
        assert.strictEqual(crowdSince(dev, mark).length, 0, 'within a second of the owner\'s command the crowd waits');
        const waiting = b.messages.slice().reverse().find((x) => x.type === 'crowd_tick');
        assert.ok(waiting && waiting.paused && waiting.override && waiting.override.role === 'owner', `the panels hear the crowd waits for the owner: ${JSON.stringify(waiting)}`);
        // After the pause the crowd drives again: last input wins at full cap.
        await pause(600);
        cmd(b, { id: 'b3', kind: 'drive', value: { throttle: 0.9 } });
        const m = await dev.waitFor((x) => isCrowd(x) && dev.messages.indexOf(x) >= mark, 3000);
        dev.send({ type: 'ack', id: m.id });
        assert.ok(Math.abs(m.value.throttle - 0.9) < 1e-9, JSON.stringify(m.value));
        // Sole control given to one person stops the crowd's mix at the gate (refused, audited).
        await t.domain.operators.setSole(robot.id, alex.subject, alex.subject);
        await pause(400);
        cmd(b, { id: 'b4', kind: 'drive', value: { throttle: 0.9 } });
        assert.ok(await auditRow(robot.id, (r) => r.role === 'crowd' && r.result === 'refused'), 'sole control: the crowd\'s mix is refused');
        a.close(); b.close(); dev.close();
    });

    await check('the owner and Mods see who steers and take someone out of the crowd; nobody else can', async () => {
        const { robot, pairing } = await t.robot(alex, { access_policy: 'crowd', limits: { crowd: { style: 'tug', cap: 0.5 } } });
        const dev = await deviceFor(robot.id, pairing.code);
        const b = await op(bob); const c = await op(carol);
        await join(b, robot.id); await join(c, robot.id);
        cmd(b, { id: 'k1', kind: 'drive', value: { throttle: 1 } });
        cmd(c, { id: 'k2', kind: 'drive', value: { throttle: 1 } });
        await result(b, 'k1'); await result(c, 'k2');
        const cookie = (u) => ({ Cookie: `ov_token=${t.network.signUser(u)}` });
        const list = async (u) => fetch(`${t.base}/panel/${robot.id}/crowd`, { headers: { Accept: 'application/json', ...cookie(u) } });
        const kick = (u, body, extra = {}) => fetch(`${t.base}/panel/${robot.id}/crowd/kick`, { method: 'POST', body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', Origin: t.base, 'Sec-Fetch-Site': 'same-origin', ...cookie(u), ...extra } });

        const r = await list(alex);
        assert.strictEqual(r.status, 200);
        const people = (await r.json()).people;
        assert.deepStrictEqual(people.map((x) => x.subject).sort(), [bob.subject, carol.subject].sort(), 'the owner sees both people steering');
        assert.ok(people.every((x) => x.inputs >= 1 && x.seconds_ago >= 0));
        assert.strictEqual((await list(carol)).status, 403, 'a crowd member does not see the list');

        assert.strictEqual((await kick(carol, { subject: bob.subject })).status, 403, 'a crowd member kicks no one');
        assert.strictEqual((await kick(alex, { subject: bob.subject }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'never from another site');
        assert.strictEqual((await kick(alex, { subject: 'nobody' })).status, 422);
        const k = await kick(alex, { subject: bob.subject, minutes: 10 });
        assert.strictEqual(k.status, 200, await k.text());
        assert.deepStrictEqual((await (await list(alex)).json()).people.map((x) => x.subject), [carol.subject], 'their drive went at once');
        cmd(b, { id: 'k3', kind: 'drive', value: { throttle: 1 } });
        const refused = await result(b, 'k3');
        assert.deepStrictEqual([refused.result, refused.code], ['refused', 'bot.crowd_kicked'], 'and they steer nothing until it ends');
        cmd(c, { id: 'k4', kind: 'drive', value: { throttle: 1 } });
        assert.strictEqual((await result(c, 'k4')).result, 'mixed', 'everyone else steers on');
        const page = await (await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(alex) })).text();
        assert.ok(page.includes('data-crowd-who'), 'the owner\'s card has the list');
        const theirs = await (await fetch(`${t.base}/panel/${robot.id}`, { headers: cookie(bob) })).text();
        assert.ok(!theirs.includes('data-crowd-who'), 'a crowd member\'s card does not');
        b.close(); c.close(); dev.close();
    });

    await check('the gate: the crowd role exists only on a crowd robot; private, invite, queue and crowd are the policies', async () => {
        const { robot } = await t.robot(alex);
        const r = await t.domain.control.prepare({ robotId: robot.id, principal: { kind: 'crowd', subject: alex.subject }, kind: 'drive', value: { throttle: 0.5 }, online: true });
        assert.deepStrictEqual([r.ok, r.code], [false, 'bot.not_crowd']);
        const bad = await t.call('POST', '/api/v1/robots', { user: alex, body: { name: 'x', profile_id: 'sim.rover', access_policy: 'mob' } });
        assert.strictEqual(bad.status, 422);
        const { robot: crowdRobot } = await t.robot(alex, { access_policy: 'crowd' });
        const cfg = t.domain.control.crowdConfig(await t.domain.robots.get(crowdRobot.id), { commands: { drive: { axes: { throttle: [-1, 1] } } } });
        assert.deepStrictEqual(cfg, { style: 'mixed', windowMs: 250, cap: 0.5, axes: { throttle: [-1, 1] } }, 'defaults: Mixed, 250 ms, half speed');
        // The setting is API-only for now: a crowd robot's form shows and keeps it; another robot's form cannot choose it.
        const cookie = { Cookie: `ov_token=${t.network.signUser(alex)}` };
        const page = await (await fetch(`${t.base}/panel/${crowdRobot.id}`, { redirect: 'manual', headers: cookie })).text();
        assert.ok(page.includes('<option value="crowd" selected>'), 'a crowd robot\'s form keeps crowd control selected');
        assert.ok(page.includes('data-operators-crowd'), 'the Operators card has its crowd line (bot.crowd-tick@1)');
        const plain = await (await fetch(`${t.base}/panel/${robot.id}`, { redirect: 'manual', headers: cookie })).text();
        assert.ok(plain.includes('<option value="private" selected>') && !plain.includes('value="crowd"'), 'other robots are not offered it yet');
        assert.ok(!plain.includes('data-operators-crowd'), 'and draw no crowd line');
        const post = (id, policy) => fetch(`${t.base}/robots/${id}/access`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ access_policy: policy }).toString(),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: t.base, ...cookie } });
        assert.ok((await post(crowdRobot.id, 'crowd')).status < 400, 'saving a crowd robot\'s form keeps it');
        assert.strictEqual((await t.domain.robots.get(crowdRobot.id)).access_policy, 'crowd');
        assert.strictEqual((await post(robot.id, 'crowd')).status, 422, 'the form cannot turn crowd control on');
    });

    await t.close();
    done();
})();
