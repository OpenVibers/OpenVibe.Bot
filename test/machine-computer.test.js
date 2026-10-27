'use strict';
// A person's own computer (plan T14/T17, contracts 0.166.0): POST /api/v1/machines/:id/commands sends exec, fs and
// screen to the machine's computer plugin for its owner, or for their agent (svc:actor with bot.computer.control) once
// the owner turned "Let my agent use this computer" on; the machine's answer comes back in data (larger than the
// old 64 KB frame cap); nobody else reaches it; the audit keeps a summary, never content; a robot's operators never
// send these kinds; a machine whose plugin is off answers bot.computer_off.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_PERSON_TURN_MS: '400' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const COMPUTER = { terminal: { level: 'trusted', timeout_s: 30 }, files: { level: 'trusted', roots: ['/home/alex'] }, screen: { level: 'trusted', tool: 'grim' }, probe: { lan_only: true }, input: { level: 'trusted', tool: 'xdotool', scroll: true }, browser: { level: 'trusted', browser: 'chromium', headless: true } };
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
            else if (m.kind === 'browser') c.send(frame('ack', { id: m.id, data: { url: m.value.url || 'https://example.org/', title: 'Example', text: 'Example page', truncated: false, links: [] } }));
            else if (m.kind === 'desk' && m.value.action === 'list') c.send(frame('ack', { id: m.id, data: { desks: [{ desk: 'desk-task-a', kind: 'browser', running: true, width: 1280, height: 800, since: 1793102400 }, { desk: 'private', kind: 'desktop', running: true, display: ':91', width: 1280, height: 800, since: 1793102000 }], max_desks: 4, available: true } }));
            else if (m.kind === 'desk') c.send(frame('ack', { id: m.id, data: { running: m.value.action !== 'stop', display: ':91', width: 1280, height: 800 } }));
            else if (m.kind === 'screen' && m.value.desk && m.value.desk !== 'main') c.send(frame('ack', { id: m.id, data: { format: 'png', width: 1280, height: 800, content_b64: 'iVBORw0KGgo=' } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'not_allowed', message: 'this machine allows observing only' }));
        });
        // Beat like a real Node while the socket is open, so a longer check never sees its machine go offline.
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
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

    await check('the browser kind reaches the machine; a file: address is refused before it leaves', async () => {
        const open = await cmd(mine.deviceId, { kind: 'browser', value: { action: 'open', url: 'https://example.org/account?token=abc' } }, { user: alex });
        assert.deepStrictEqual([open.status, open.json.result, open.json.data.title], [200, 'ack', 'Example']);
        const fill = await cmd(mine.deviceId, { kind: 'browser', value: { action: 'fill', selector: '#password', text: 'hunter3 secret' } }, { user: alex });
        assert.strictEqual(fill.json.result, 'ack');
        assert.deepStrictEqual(seen.filter((m) => m.kind === 'browser').map((m) => m.value.action), ['open', 'fill']);
        const file = await cmd(mine.deviceId, { kind: 'browser', value: { action: 'open', url: 'file:///etc/passwd' } }, { user: alex });
        assert.deepStrictEqual([file.status, file.json.code], [422, 'bot.invalid_input']);
        const rows = await t.db.many("SELECT * FROM command_audit WHERE robot_id = $1 AND kind = 'browser' AND result = 'ack' ORDER BY id", [mine.deviceId]);
        assert.deepStrictEqual(rows.map((r) => r.value), [{ action: 'open', host: 'example.org' }, { action: 'fill', selector: '#password', chars: 14 }],
            'the audit keeps the host (never the path or query) and how much was typed (never the text)');
        assert.ok(!JSON.stringify(rows).includes('hunter3') && !JSON.stringify(rows).includes('token=abc'));
    });

    await check('the private desk (contracts 0.214.0): start, stop and status reach a machine that has one, and desk: private acts there; one without says so', async () => {
        const withDesk = await machine(alex, { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true } });
        const listed = await t.call('GET', `/api/v1/machines/${withDesk.deviceId}/computer`, { user: alex });
        assert.strictEqual(listed.json.machine.computer.desk.window_manager, 'openbox', 'the machine says it has a desk');
        const start = await cmd(withDesk.deviceId, { kind: 'desk', value: { action: 'start', width: 1280, height: 800 } }, { user: alex });
        assert.deepStrictEqual([start.status, start.json.result, start.json.data.display], [200, 'ack', ':91']);
        assert.deepStrictEqual(seen.at(-1).value, { action: 'start', width: 1280, height: 800 });
        const look = await cmd(withDesk.deviceId, { kind: 'screen', value: { desk: 'private', max_width: 1280 } }, { user: alex });
        assert.deepStrictEqual([look.json.result, look.json.data.width], ['ack', 1280]);
        const click = await cmd(withDesk.deviceId, { kind: 'input', value: { action: 'click', x: 10, y: 10, width: 1280, height: 800, desk: 'private' } }, { user: alex });
        assert.strictEqual(click.json.result, 'ack');
        assert.strictEqual(seen.at(-1).value.desk, 'private', 'the machine is told to act on the desk');
        const open = await cmd(withDesk.deviceId, { kind: 'browser', value: { action: 'open', url: 'https://example.org/', desk: 'private' } }, { user: alex });
        assert.strictEqual(open.json.result, 'ack');
        const rows = await t.db.many("SELECT kind, value FROM command_audit WHERE robot_id = $1 AND result = 'ack' ORDER BY id", [withDesk.deviceId]);
        assert.deepStrictEqual(rows.map((r) => [r.kind, r.value]), [
            ['desk', { action: 'start', width: 1280, height: 800 }], ['screen', { max_width: 1280, desk: 'private' }],
            ['input', { action: 'click', x: 10, y: 10, desk: 'private' }], ['browser', { action: 'open', host: 'example.org', desk: 'private' }],
        ], 'the audit says where it acted');
        const tiny = await cmd(withDesk.deviceId, { kind: 'desk', value: { action: 'start', width: 100, height: 100 } }, { user: alex });
        assert.deepStrictEqual([tiny.status, tiny.json.code], [422, 'bot.invalid_input'], 'the contract\'s sizes');
        const none = await cmd(mine.deviceId, { kind: 'desk', value: { action: 'status' } }, { user: alex });
        assert.deepStrictEqual([none.status, none.json.code], [409, 'bot.computer_off']);
        assert.match(none.json.detail || none.json.reason || '', /no private desk/);
        const blind = await cmd(mine.deviceId, { kind: 'input', value: { action: 'click', x: 1, y: 1, width: 2, height: 2, desk: 'private' } }, { user: alex });
        assert.deepStrictEqual([blind.status, blind.json.code], [409, 'bot.computer_off'], 'desk: private on a machine without one never reaches its own screen');
        // The person always wins: the owner just clicked on the desk, so their agent's click there waits; on the
        // owner's own screen (another screen) and for reading the page it goes on.
        const token = actor();
        await t.call('POST', `/api/v1/machines/${withDesk.deviceId}/agent-computer`, { user: alex, body: { on: true } });
        assert.strictEqual((await cmd(withDesk.deviceId, { kind: 'input', value: { action: 'move', x: 5, y: 5, width: 1280, height: 800, desk: 'private' } }, { user: alex })).json.result, 'ack');
        const agentClick = await cmd(withDesk.deviceId, { kind: 'input', value: { action: 'click', x: 20, y: 20, width: 1280, height: 800, desk: 'private' } }, asActor(token, alex.subject));
        assert.deepStrictEqual([agentClick.status, agentClick.json.code], [409, 'bot.person_driving']);
        assert.match(agentClick.json.detail || agentClick.json.reason || '', /a person is using this screen right now/);
        const agentRead = await cmd(withDesk.deviceId, { kind: 'browser', value: { action: 'read', desk: 'private' } }, asActor(token, alex.subject));
        assert.strictEqual(agentRead.json.result, 'ack', 'reading never fights for the screen');
        const elsewhere = await cmd(withDesk.deviceId, { kind: 'input', value: { action: 'move', x: 1, y: 1, width: 2, height: 2 } }, asActor(token, alex.subject));
        assert.strictEqual(elsewhere.json.result, 'ack', 'the owner\'s own screen is another screen');
        await t.wait(450);   // BOT_PERSON_TURN_MS is 400 in this boot
        const later = await cmd(withDesk.deviceId, { kind: 'input', value: { action: 'click', x: 20, y: 20, width: 1280, height: 800, desk: 'private' } }, asActor(token, alex.subject));
        assert.strictEqual(later.json.result, 'ack', 'once the person stops, the agent goes on');
        await t.call('POST', `/api/v1/machines/${withDesk.deviceId}/agent-computer`, { user: alex, body: { on: false } });   // the checks below start with no machine open to the agent
        withDesk.c.close();
    });

    await check('desk turn (Desks plan D4): an agent sees whether its person is using a desk and when they last did; read only', async () => {
        const m = await machine(alex, { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } });
        const token = actor();
        await t.call('POST', `/api/v1/machines/${m.deviceId}/agent-computer`, { user: alex, body: { on: true } });
        const turn = async (desk) => t.call('GET', `/api/v1/machines/${m.deviceId}/desk-turn?desk=${desk}`, asActor(token, alex.subject));
        const before = await turn('desk-task-a');
        assert.deepStrictEqual([before.status, before.json.person_driving, before.json.last_person_at], [200, false, null], 'nobody yet');
        assert.strictEqual((await cmd(m.deviceId, { kind: 'input', value: { action: 'move', x: 5, y: 5, width: 1280, height: 800, desk: 'desk-task-a' } }, { user: alex })).json.result, 'ack');
        const during = await turn('desk-task-a');
        assert.strictEqual(during.json.person_driving, true, 'the person is using it');
        assert.ok(Date.parse(during.json.last_person_at) <= Date.now());
        assert.strictEqual((await turn('desk-task-b')).json.person_driving, false, 'another desk is another screen');
        await t.wait(450);   // BOT_PERSON_TURN_MS is 400 in this boot
        const after = await turn('desk-task-a');
        assert.deepStrictEqual([after.json.person_driving, after.json.last_person_at], [false, during.json.last_person_at], 'they stopped; when they last did stays');
        assert.strictEqual((await turn('desk-../x')).status, 422);
        await t.call('POST', `/api/v1/machines/${m.deviceId}/agent-computer`, { user: alex, body: { on: false } });
        m.c.close();
    });

    await check('named desks (contracts 0.215.0, Node v0.19.0): one per agent task, each its own screen; an older Node runs one', async () => {
        const multi = await machine(alex, { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } });
        const single = await machine(alex, { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true } });
        const start = await cmd(multi.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a' } }, { user: alex });
        assert.strictEqual(start.json.result, 'ack');
        assert.deepStrictEqual(seen.at(-1).value, { action: 'start', desk: 'desk-task-a' }, 'the machine is told which desk');
        const open = await cmd(multi.deviceId, { kind: 'browser', value: { action: 'open', url: 'https://example.org/', desk: 'desk-task-a' } }, { user: alex });
        assert.strictEqual(open.json.result, 'ack');
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a');
        const listed = await cmd(multi.deviceId, { kind: 'desk', value: { action: 'list' } }, { user: alex });
        assert.strictEqual(listed.json.result, 'ack');
        const rows = await t.db.many("SELECT kind, value FROM command_audit WHERE robot_id = $1 AND result = 'ack' ORDER BY id", [multi.deviceId]);
        assert.deepStrictEqual(rows.map((r) => [r.kind, r.value]), [
            ['desk', { action: 'start', desk: 'desk-task-a' }], ['browser', { action: 'open', host: 'example.org', desk: 'desk-task-a' }], ['desk', { action: 'list' }],
        ], 'the audit names the desk');
        // A machine on an older Node runs its private desk only: a named one is refused there, never sent.
        const sent = seen.length;
        const old = await cmd(single.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a' } }, { user: alex });
        assert.deepStrictEqual([old.status, old.json.code], [409, 'bot.computer_off']);
        assert.match(old.json.detail || old.json.reason || '', /Node v0\.19\.0/);
        assert.strictEqual((await cmd(single.deviceId, { kind: 'screen', value: { desk: 'desk-task-a' } }, { user: alex })).json.code, 'bot.computer_off');
        assert.strictEqual(seen.length, sent, 'nothing reached the older machine');
        // Names follow the contract.
        const bad = await cmd(multi.deviceId, { kind: 'screen', value: { desk: 'desk-../x' } }, { user: alex });
        assert.deepStrictEqual([bad.status, bad.json.code], [422, 'bot.invalid_input']);
        // Each desk is its own screen: the owner driving desk-task-a never holds the agent off desk-task-b.
        const token = actor();
        await t.call('POST', `/api/v1/machines/${multi.deviceId}/agent-computer`, { user: alex, body: { on: true } });
        assert.strictEqual((await cmd(multi.deviceId, { kind: 'input', value: { action: 'move', x: 5, y: 5, width: 1280, height: 800, desk: 'desk-task-a' } }, { user: alex })).json.result, 'ack');
        const held = await cmd(multi.deviceId, { kind: 'input', value: { action: 'click', x: 9, y: 9, width: 1280, height: 800, desk: 'desk-task-a' } }, asActor(token, alex.subject));
        assert.strictEqual(held.json.code, 'bot.person_driving', 'the desk the person drives waits');
        const other = await cmd(multi.deviceId, { kind: 'input', value: { action: 'click', x: 9, y: 9, width: 1280, height: 800, desk: 'desk-task-b' } }, asActor(token, alex.subject));
        assert.strictEqual(other.json.result, 'ack', 'another desk goes on');
        await t.call('POST', `/api/v1/machines/${multi.deviceId}/agent-computer`, { user: alex, body: { on: false } });
        multi.c.close();
        single.c.close();
    });

    await check('browser desks (contracts 0.216.0, Node v0.23.0): a desk starts as a kind the machine runs; the audit names it; an older Node is never sent one', async () => {
        const desk = { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 };
        const both = await machine(alex, { ...COMPUTER, desk: { ...desk, kinds: ['desktop', 'browser'] } });
        const mac = await machine(alex, { ...COMPUTER, desk: { ...desk, window_manager: null, kinds: ['browser'] } });
        const old = await machine(alex, { ...COMPUTER, desk });
        const page = await cmd(both.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a', kind: 'browser' } }, { user: alex });
        assert.strictEqual(page.json.result, 'ack', page.text);
        assert.deepStrictEqual(seen.at(-1).value, { action: 'start', desk: 'desk-task-a', kind: 'browser' }, 'the machine is told the kind');
        assert.strictEqual((await cmd(both.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-b', kind: 'desktop' } }, { user: alex })).json.result, 'ack');
        assert.strictEqual((await cmd(mac.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a', kind: 'browser' } }, { user: alex })).json.result, 'ack');
        const before = seen.length;
        const whole = await cmd(mac.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-b' } }, { user: alex });
        assert.deepStrictEqual([whole.status, whole.json.code], [409, 'bot.computer_off']);
        assert.match(whole.json.detail || whole.json.reason || '', /browser desks only/);
        const older = await cmd(old.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a', kind: 'browser' } }, { user: alex });
        assert.deepStrictEqual([older.status, older.json.code], [409, 'bot.computer_off'], 'an older Node would start a whole desk instead');
        assert.match(older.json.detail || older.json.reason || '', /Node v0\.23\.0/);
        const bad = await cmd(both.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-c', kind: 'vm' } }, { user: alex });
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(seen.length, before, 'nothing refused reached a machine');
        // An older Node still starts its whole desks as before (no kind).
        assert.strictEqual((await cmd(old.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-a' } }, { user: alex })).json.result, 'ack');
        const audit = await t.db.many('SELECT value FROM command_audit WHERE robot_id = $1 AND kind = $2 AND result = $3 ORDER BY id', [both.deviceId, 'desk', 'ack']);
        assert.deepStrictEqual(audit.map((r) => r.value.kind), ['browser', 'desktop'], 'the audit names the kind');
        // A kept profile (contracts 0.217.0, Node v0.24.0) reaches the machine and the audit names it.
        const kept = await cmd(both.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-k', kind: 'browser', profile: 'agent' } }, { user: alex });
        assert.strictEqual(kept.json.result, 'ack', kept.text);
        assert.strictEqual(seen.at(-1).value.profile, 'agent');
        const keptRow = await t.db.one('SELECT value FROM command_audit WHERE robot_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1', [both.deviceId, 'desk']);
        assert.strictEqual(keptRow.value.profile, 'agent');
        assert.strictEqual((await cmd(both.deviceId, { kind: 'desk', value: { action: 'start', desk: 'desk-task-k', profile: '../x' } }, { user: alex })).status, 422, 'a bad profile name is refused');
        both.c.close();
        mac.c.close();
        old.c.close();
    });

    await check('a desk host (Node v0.20.0 --desk-host): no screen of its own, yet its desks are seen and driven', async () => {
        // Nobody is signed in to a desk host: it offers no screen or input of its own, only its desks' (desk.screen, desk.input).
        const { screen: _s, input: _i, ...headless } = COMPUTER;
        const host = await machine(alex, { ...headless, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } });
        const look = await cmd(host.deviceId, { kind: 'screen', value: { desk: 'desk-task-a', max_width: 1280 } }, { user: alex });
        assert.strictEqual(look.json.result, 'ack', look.text);
        const click = await cmd(host.deviceId, { kind: 'input', value: { action: 'click', x: 10, y: 10, width: 1280, height: 800, desk: 'desk-task-a' } }, { user: alex });
        assert.strictEqual(click.json.result, 'ack', click.text);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a');
        // Its own screen is still refused: there is none.
        const own = await cmd(host.deviceId, { kind: 'screen', value: { max_width: 1280 } }, { user: alex });
        assert.deepStrictEqual([own.status, own.json.code], [409, 'bot.computer_off']);
        const ownClick = await cmd(host.deviceId, { kind: 'input', value: { action: 'click', x: 1, y: 1, width: 2, height: 2 } }, { user: alex });
        assert.deepStrictEqual([ownClick.status, ownClick.json.code], [409, 'bot.computer_off']);
        // A desk that cannot be seen (no X capture tool) is refused, never sent.
        const blind = await machine(alex, { ...headless, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: false, named: true, max_desks: 4 } });
        const before = seen.length;
        const dark = await cmd(blind.deviceId, { kind: 'screen', value: { desk: 'desk-task-a' } }, { user: alex });
        assert.deepStrictEqual([dark.status, dark.json.code], [409, 'bot.computer_off']);
        assert.strictEqual(seen.length, before, 'nothing reached the machine');
        host.c.close();
        blind.c.close();
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

    await check('the machines page says what desks each machine runs, and offers to make a spare computer a desk host', async () => {
        const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
        const desk = { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true };
        const host = await machine(alex, { files: COMPUTER.files, desk: { ...desk, max_desks: 4, kinds: ['desktop', 'browser'], profiles: true } });
        const mac = await machine(alex, { ...COMPUTER, desk: { ...desk, window_manager: null, max_desks: 2, kinds: ['browser'] } });
        const html = await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text();
        assert.ok(html.includes('Desks for your agents: 4 at once, or twice as many browser desks, sign-ins kept'), 'a desk host');
        assert.ok(html.includes('Desks for your agents: 4 browser desks at once'), 'a Mac: browser desks only');
        const add = await fetch(`${t.base}/machines`, { method: 'POST', redirect: 'manual', body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(alex) } });
        assert.strictEqual(add.status, 201);
        const page = await add.text();
        assert.ok(page.includes('Or make a spare computer a desk host'));
        const hostCmd = /<code>(curl -fsSL [^<]+ --desk-host)<\/code>/.exec(page);
        assert.ok(hostCmd, 'the desk host install command');
        assert.ok(!hostCmd[1].includes('--worker'), 'a desk host never runs the job worker too');
        host.c.close();
        mac.c.close();
    });

    await check('a machine\'s desks page: its running desks to watch, take over or stop, for its owner only; stop is same-site only', async () => {
        const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
        const host = await machine(alex, { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4, kinds: ['desktop', 'browser'] } });
        host.c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_waiting: 0, computer_running: 0, computer_desks: 2 } }));
        await poll(async () => (await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text()).includes('2 desks running'));
        const list = await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text();
        assert.ok(list.includes(`href="/machines/${host.deviceId}/desks"`), 'the card links its desks');
        const page = await fetch(`${t.base}/machines/${host.deviceId}/desks`, { headers: cookie(alex) });
        assert.strictEqual(page.status, 200);
        const html = await page.text();
        assert.deepStrictEqual(seen.at(-1).value, { action: 'list' }, 'asked of the machine when the page opens');
        assert.ok(html.includes('<code>desk-task-a</code>') && html.includes('Browser desk') && html.includes('Whole desk'));
        assert.ok(html.includes(`href="/machines/${host.deviceId}/screen?desk=desk-task-a"`), 'Watch and take over that desk');
        assert.ok(html.includes('name="desk" value="desk-task-a"'), 'its Stop');
        assert.ok(html.includes('At most 4 whole desks at once here'));
        assert.strictEqual((await fetch(`${t.base}/machines/${host.deviceId}/desks`, { headers: cookie(bob) })).status, 404, 'nobody else');
        const stop = (body, headers = {}) => fetch(`${t.base}/machines/${host.deviceId}/desks/stop`, { method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(alex), ...headers } });
        assert.strictEqual((await stop('desk=desk-task-a', { Origin: 'https://evil.test' })).status, 403);
        assert.strictEqual((await stop('desk=main')).status, 422, 'never the person\'s own screen');
        assert.strictEqual((await stop('desk=desk-../x')).status, 422);
        const done = await stop('desk=desk-task-a');
        assert.strictEqual(done.status, 303);
        assert.match(done.headers.get('location'), /\/desks\?stopped=desk-task-a$/);
        assert.deepStrictEqual(seen.at(-1).value, { action: 'stop', desk: 'desk-task-a' });
        assert.ok((await (await fetch(`${t.base}${done.headers.get('location')}`, { headers: cookie(alex) })).text()).includes('Stopped <code>desk-task-a</code>'));
        host.c.close();
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
