'use strict';
// A person's own computer (plan T14/T17, contracts 0.166.0): POST /api/v1/machines/:id/commands sends exec, fs and
// screen to the machine's computer plugin for its owner, or for their agent (svc:actor with bot.computer.control) once
// the owner turned "Let my agent use this computer" on; the machine's answer comes back in data (larger than the
// old 64 KB frame cap); nobody else reaches it; the audit keeps a summary, never content; a robot's operators never
// send these kinds; a machine whose plugin is off answers bot.computer_off.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const COMPUTER = { terminal: { level: 'trusted', timeout_s: 30 }, files: { level: 'trusted', roots: ['/home/alex'] }, screen: { level: 'trusted', tool: 'grim' }, probe: { lan_only: true }, input: { level: 'trusted', tool: 'xdotool', scroll: true } };
    const seen = [];

    /** A Network-paired machine of `owner` whose fake Node answers computer commands like the plugin would. */
    async function machine(owner, computer = COMPUTER) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: computer ? { computer } : {}, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_waiting: 0, computer_running: 0 } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push(m);
            if (m.kind === 'exec') c.send(frame('ack', { id: m.id, latency_ms: 5, data: { exit_code: 0, stdout: m.value.argv.includes('big') ? 'x'.repeat(200 * 1024) : 'hi\n', stderr: '', truncated: false, timed_out: false, duration_ms: 4 } }));
            else if (m.kind === 'fs') c.send(frame('ack', { id: m.id, data: { path: m.value.path, entries: [], total: 0, truncated: false } }));
            else if (m.kind === 'probe') c.send(frame('ack', { id: m.id, data: { status: 200, body: '{"up":true}', ms: 3 } }));
            else if (m.kind === 'input') c.send(frame('ack', { id: m.id, data: { done: true, action: m.value.action } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'not_allowed', message: 'this machine allows observing only' }));
        });
        await poll(() => t.hub.computerOf(deviceId) !== null || !computer);
        return { c, deviceId, config };
    }
    const cmd = (deviceId, body, opts) => t.call('POST', `/api/v1/machines/${deviceId}/commands`, { body, ...opts });
    const actor = (cap = ['bot.computer.control']) => t.network.signService({ sub: 'svc:actor', cap });
    const asActor = (token, subject) => ({ token, headers: { 'X-OV-Subject': subject } });

    let mine;
    await check('the owner runs a program and reads a folder; the answer is in data', async () => {
        mine = await machine(alex);
        assert.ok(['exec', 'fs', 'screen'].every((k) => mine.config.allowed_commands.includes(k)), 'the machine is told it takes the computer kinds');
        const r = await cmd(mine.deviceId, { id: 'a1', kind: 'exec', value: { argv: ['echo', 'hi'], stdin: 'secret input' } }, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.result, r.json.data.stdout, r.json.machine_id], ['ack', 'hi\n', mine.deviceId]);
        const sent = seen.at(-1);
        assert.deepStrictEqual([sent.kind, sent.operator.role, sent.value.argv], ['exec', 'owner', ['echo', 'hi']]);
        assert.ok(sent.deadline_ms - Date.now() > 50000, 'a long reply window by default');
        const ls = await cmd(mine.deviceId, { kind: 'fs', value: { op: 'list', path: '/home/alex' } }, { user: alex });
        assert.deepStrictEqual([ls.status, ls.json.data.path], [200, '/home/alex']);
        const again = await cmd(mine.deviceId, { id: 'a1', kind: 'exec', value: { argv: ['echo', 'hi'] } }, { user: alex });
        assert.deepStrictEqual([again.json.result, again.json.cached, again.json.data], ['ack', true, undefined], 'a repeated id: its result, never the data again');
    });

    await check('an answer larger than 64 KB comes through; a refusal on the machine says why', async () => {
        const big = await cmd(mine.deviceId, { kind: 'exec', value: { argv: ['cat', 'big'] } }, { user: alex });
        assert.deepStrictEqual([big.status, big.json.data.stdout.length], [200, 200 * 1024]);
        const nack = await cmd(mine.deviceId, { kind: 'screen', value: {} }, { user: alex });
        assert.deepStrictEqual([nack.status, nack.json.result, nack.json.reason], [200, 'nack', 'this machine allows observing only']);
    });

    await check('mouse and keyboard reach the machine as they were asked; a key is a key, never a command line', async () => {
        const typed = await cmd(mine.deviceId, { kind: 'input', value: { action: 'type', text: 'hunter2 is my password' } }, { user: alex });
        assert.deepStrictEqual([typed.status, typed.json.result, typed.json.data], [200, 'ack', { done: true, action: 'type' }]);
        const click = await cmd(mine.deviceId, { kind: 'input', value: { action: 'click', x: 640, y: 360, width: 1280, height: 720 } }, { user: alex });
        assert.strictEqual(click.json.result, 'ack');
        assert.deepStrictEqual(seen.filter((m) => m.kind === 'input').map((m) => m.value.action), ['type', 'click']);
        const shell = await cmd(mine.deviceId, { kind: 'input', value: { action: 'key', keys: 'ctrl+s; rm -rf ~' } }, { user: alex });
        assert.deepStrictEqual([shell.status, shell.json.code], [422, 'bot.invalid_input']);
    });

    await check('the audit keeps what was asked in short, never stdin, arguments or content', async () => {
        const rows = await t.db.many('SELECT * FROM command_audit WHERE robot_id = $1 ORDER BY id', [mine.deviceId]);
        assert.ok(rows.length >= 3);
        const exec = rows.find((r) => r.kind === 'exec');
        assert.deepStrictEqual(exec.value, { program: 'echo', args: 1 });
        assert.ok(!JSON.stringify(rows).includes('secret input'));
        const typed = rows.find((r) => r.kind === 'input' && r.value.action === 'type');
        assert.deepStrictEqual(typed.value, { action: 'type', chars: 22 }, 'typed text: its length, never the text');
        assert.ok(!JSON.stringify(rows).includes('hunter2'));
    });

    await check('nobody else reaches it; a bad value and a missing plugin are refused', async () => {
        assert.strictEqual((await cmd(mine.deviceId, { kind: 'exec', value: { argv: ['id'] } }, { user: bob })).status, 404);
        assert.strictEqual((await cmd(mine.deviceId, { kind: 'exec', value: { argv: ['id'] } }, { sub: 'svc:live', cap: ['bot.*'], headers: { 'X-OV-Subject': alex.subject } })).status, 403);
        const shell = await cmd(mine.deviceId, { kind: 'exec', value: { argv: 'rm -rf /' } }, { user: alex });
        assert.deepStrictEqual([shell.status, shell.json.code], [422, 'bot.invalid_input']);
        const fly = await cmd(mine.deviceId, { kind: 'drive', value: { throttle: 1 } }, { user: alex });
        assert.strictEqual(fly.status, 422);
        const off = await machine(bob, null);
        const r = await cmd(off.deviceId, { kind: 'fs', value: { op: 'list', path: '/' } }, { user: bob });
        assert.deepStrictEqual([r.status, r.json.code], [409, 'bot.computer_off']);
        off.c.close();
    });

    await check('the owner\'s agent uses it only after the owner turns it on, and only for that owner', async () => {
        const token = actor();
        const before = await cmd(mine.deviceId, { kind: 'screen', value: {} }, asActor(token, alex.subject));
        assert.deepStrictEqual([before.status, before.json.code], [403, 'bot.agent_not_allowed']);
        assert.deepStrictEqual((await t.call('GET', '/api/v1/machines', asActor(token, alex.subject))).json.machines, [], 'an agent sees no machine before it is allowed');
        const self = await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { ...asActor(token, alex.subject), body: { on: true } });
        assert.strictEqual(self.status, 403, 'the agent never turns itself on');
        const on = await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { user: alex, body: { on: true } });
        assert.deepStrictEqual([on.status, on.json.machine.agent_computer], [200, true]);
        const ok = await cmd(mine.deviceId, { kind: 'fs', value: { op: 'stat', path: '/home/alex' } }, asActor(token, alex.subject));
        assert.deepStrictEqual([ok.status, ok.json.result], [200, 'ack']);
        assert.strictEqual(seen.at(-1).operator.subject, alex.subject);
        assert.strictEqual((await cmd(mine.deviceId, { kind: 'fs', value: { op: 'stat', path: '/' } }, asActor(token, bob.subject))).status, 404, 'acting for someone else');
        assert.strictEqual((await cmd(mine.deviceId, { kind: 'fs', value: { op: 'stat', path: '/' } }, asActor(actor(['bot.robot.control']), alex.subject))).status, 403, 'needs bot.computer.control');
        const listed = (await t.call('GET', '/api/v1/machines', asActor(token, alex.subject))).json.machines;
        assert.deepStrictEqual(listed.map((m) => [m.id, m.computer.level, !!m.computer.terminal, m.computer.waiting]), [[mine.deviceId, 'trusted', true, 0]]);
        const one = await t.call('GET', `/api/v1/machines/${mine.deviceId}/computer`, asActor(token, alex.subject));
        assert.deepStrictEqual([one.status, one.json.machine.online, one.json.machine.computer.files.roots], [200, true, ['/home/alex']]);
        await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { user: alex, body: { on: false } });
        assert.strictEqual((await cmd(mine.deviceId, { kind: 'screen', value: {} }, asActor(token, alex.subject))).status, 403, 'off again');
    });

    await check('the machines page shows the level and the agent switch; only the owner flips it, same-site only', async () => {
        const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
        const form = (p, user, body, headers = {}) => fetch(t.base + p, { method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(user), ...headers } });
        const html = await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text();
        assert.match(html, /Computer: Trusted/);
        assert.match(html, /terminal, files, screen, mouse and keyboard/);
        assert.match(html, /Let my agent use this computer/);
        assert.strictEqual((await form(`/machines/${mine.deviceId}/agent-computer`, alex, 'on=1', { Origin: 'https://evil.test' })).status, 403);
        assert.strictEqual((await form(`/machines/${mine.deviceId}/agent-computer`, bob, 'on=1')).status, 404);
        assert.strictEqual((await form(`/machines/${mine.deviceId}/agent-computer`, alex, 'on=1')).status, 303);
        assert.strictEqual((await t.db.maybe('SELECT agent_computer FROM devices WHERE id = $1', [mine.deviceId])).agent_computer, true);
        assert.match(await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text(), /Stop my agent using this computer/);
        await form(`/machines/${mine.deviceId}/agent-computer`, alex, 'on=0');
        assert.strictEqual((await t.db.maybe('SELECT agent_computer FROM devices WHERE id = $1', [mine.deviceId])).agent_computer, false);
    });

    await check('Watch sends only probes, only where the owner let their watches use the computer', async () => {
        const watch = t.network.signService({ sub: 'svc:watch', cap: ['bot.computer.control'] });
        const asWatch = { token: watch, headers: { 'X-OV-Subject': alex.subject } };
        const probe = { kind: 'probe', value: { target: 'http://192.168.1.20/status' } };
        const before = await cmd(mine.deviceId, probe, asWatch);
        assert.deepStrictEqual([before.status, before.json.code], [403, 'bot.agent_not_allowed']);
        assert.match(before.json.detail || before.text, /watches/);
        assert.deepStrictEqual((await t.call('GET', '/api/v1/machines', asWatch)).json.machines, []);
        assert.strictEqual((await t.call('POST', `/api/v1/machines/${mine.deviceId}/watch-probe`, { ...asWatch, body: { on: true } })).status, 403, 'Watch never turns itself on');
        const on = await t.call('POST', `/api/v1/machines/${mine.deviceId}/watch-probe`, { user: alex, body: { on: true } });
        assert.deepStrictEqual([on.status, on.json.machine.watch_probe, !!on.json.machine.computer.probe], [200, true, true]);
        const ok = await cmd(mine.deviceId, probe, asWatch);
        assert.deepStrictEqual([ok.status, ok.json.result, ok.json.data.status], [200, 'ack', 200]);
        const exec = await cmd(mine.deviceId, { kind: 'exec', value: { argv: ['id'] } }, asWatch);
        assert.deepStrictEqual([exec.status, exec.json.code], [403, 'bot.forbidden'], 'Watch may send probes only');
        assert.deepStrictEqual((await t.call('GET', '/api/v1/machines', asWatch)).json.machines.map((m) => m.id), [mine.deviceId]);
        const audit = await t.db.maybe("SELECT value FROM command_audit WHERE robot_id = $1 AND kind = 'probe' ORDER BY id DESC LIMIT 1", [mine.deviceId]);
        assert.deepStrictEqual(audit.value, { scheme: 'http', host: '192.168.1.20' }, 'the audit keeps the host, not the path');
        const actorToo = await cmd(mine.deviceId, probe, { token: t.network.signService({ sub: 'svc:actor', cap: ['bot.computer.control'] }), headers: { 'X-OV-Subject': alex.subject } });
        assert.strictEqual(actorToo.status, 403, 'the watches switch does not open the computer to the agent');
        await t.call('POST', `/api/v1/machines/${mine.deviceId}/watch-probe`, { user: alex, body: { on: false } });
        assert.strictEqual((await cmd(mine.deviceId, probe, asWatch)).status, 403, 'off again');
    });

    await check('a robot\'s operators never send computer kinds', async () => {
        const { robot } = await t.robot(alex);
        const r = await t.call('POST', `/api/v1/robots/${robot.id}/commands`, { user: alex, body: { kind: 'exec', value: { argv: ['id'] } } });
        assert.strictEqual(r.status, 422, r.text);
    });

    mine.c.close();
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
