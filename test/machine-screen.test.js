'use strict';
// The live screen (plan T14, contracts 0.182.0): the machine's owner, signed in, watches its screen on their own
// private OpenRestream stream. POST /api/v1/machines/:id/screen makes or rotates the machine's stream (playback
// private, no recording, never on Live) and sends screen_stream start with the WHIP URL and key; GET answers the
// session's viewer URL once the machine publishes; DELETE stops it and retires the key. Nobody else starts it — not
// another person, an agent, a watch or a robot operator — and the generic command route never sends the kind; the
// audit keeps the action, never the URL or key. The web page (/machines/:id/screen) does the same for the owner.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_WHIP_BASE: 'https://ingest.openre.test/whip/' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const SCREEN = { screen: { level: 'observe', tool: 'grim', stream: true }, files: { level: 'observe', roots: ['/home/alex'] } };
    const seen = [];

    /** A machine of `owner` whose fake Node answers screen_stream like Node v0.12.0. */
    async function machine(owner, computer = SCREEN) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { computer }, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: { computer_level: 'observe', computer_waiting: 0, computer_running: 0, computer_screen_stream: 'off' } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push(m);
            if (m.kind === 'screen_stream' && m.value.action === 'start') {
                c.send(frame('ack', { id: m.id, data: { streaming: true, sid: 'abc', seconds: m.value.seconds, fps: m.value.fps, until_ms: Date.now() + m.value.seconds * 1000 } }));
            } else if (m.kind === 'screen_stream') c.send(frame('ack', { id: m.id, data: { streaming: false, stopped: true } }));
            else if (m.kind === 'input') c.send(frame('ack', { id: m.id, data: { done: true, action: m.value.action } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'unsupported' }));
        });
        // Heartbeats keep it online, as a real Node's do.
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId, config };
    }
    const screen = (method, deviceId, opts = {}) => t.call(method, `/api/v1/machines/${deviceId}/screen`, opts);
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const form = (p, user, headers = {}) => fetch(t.base + p, { method: 'POST', redirect: 'manual', body: '', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers } });

    let mine;
    let streamId;
    await check('the owner starts it: a private stream of the machine\'s own, the URL and key go to the machine only', async () => {
        mine = await machine(alex);
        assert.ok(mine.config.allowed_commands.includes('screen_stream'), 'the machine is told it takes screen_stream');
        const r = await screen('POST', mine.deviceId, { user: alex, body: { seconds: 120, fps: 3 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual([r.json.streaming, r.json.seconds, r.json.fps, r.json.machine_id], [true, 120, 3, mine.deviceId]);
        assert.ok(Date.parse(r.json.until) > Date.now() + 100000);
        const sent = seen.at(-1);
        assert.strictEqual(sent.kind, 'screen_stream');
        assert.deepStrictEqual([sent.value.action, sent.value.seconds, sent.value.fps], ['start', 120, 3]);
        assert.match(sent.value.publish_key, /^ork_/);
        assert.strictEqual(sent.value.whip_url, `https://ingest.openre.test/whip/${encodeURIComponent(sent.value.publish_key)}`);
        const st = [...t.openre.streams.values()].find((x) => x.owner === alex.subject && x.refs.some((ref) => ref.type === 'machine'));
        assert.ok(st, 'a stream on OpenRestream, as alex');
        streamId = st.id;
        assert.deepStrictEqual([st.playback_visibility, st.recording_mode, st.mirror_to_live, st.protocols], ['private', 'none', false, ['webrtc']]);
        assert.deepStrictEqual(st.refs.map((ref) => [ref.service, ref.type, ref.id]), [['bot', 'machine', mine.deviceId]]);
        assert.strictEqual((await t.db.maybe('SELECT screen_stream_id FROM devices WHERE id = $1', [mine.deviceId])).screen_stream_id, streamId);
        assert.ok(t.openre.admits(sent.value.publish_key), 'OpenRestream admits the key the machine got');
    });

    await check('the audit keeps the action, never the URL or the key', async () => {
        const rows = await t.db.many("SELECT * FROM command_audit WHERE robot_id = $1 AND kind = 'screen_stream'", [mine.deviceId]);
        assert.deepStrictEqual(rows.map((x) => [x.result, x.value]), [['ack', { action: 'start', seconds: 120, fps: 3 }]]);
        assert.ok(!JSON.stringify(rows).includes('ork_') && !JSON.stringify(rows).includes('whip'));
    });

    await check('GET answers the viewer URL once the machine publishes', async () => {
        const before = await screen('GET', mine.deviceId, { user: alex });
        assert.deepStrictEqual([before.status, before.json.live, before.json.signaling_url, before.json.state], [200, false, null, 'off']);
        await t.wait(600);   // telemetry samples are kept at most twice a second
        mine.c.send(frame('telemetry', { sensors: { computer_level: 'observe', computer_screen_stream: 'live' } }));
        const session = t.openre.goLive(streamId);
        const live = await poll(async () => { const r = await screen('GET', mine.deviceId, { user: alex }); return r.json.live ? r : null; });
        assert.ok(live, 'live');
        assert.strictEqual(live.json.signaling_url, `ws://127.0.0.1:9936/w/${session.id}`);
    });

    await check('a new start rotates the key and ends the open session; the old key stops working', async () => {
        const oldKey = seen.filter((m) => m.kind === 'screen_stream').at(-1).value.publish_key;
        const r = await screen('POST', mine.deviceId, { user: alex, body: {} });
        assert.deepStrictEqual([r.status, r.json.seconds, r.json.fps], [201, 600, 2], `ten minutes at 2 frames a second by default: ${r.text}`);
        const newKey = seen.at(-1).value.publish_key;
        assert.notStrictEqual(newKey, oldKey);
        assert.ok(!t.openre.admits(oldKey) && t.openre.admits(newKey));
        const rotate = t.openre.calls.filter((c) => c.path === `/api/v1/streams/${streamId}/keys/rotate`).at(-1);
        assert.deepStrictEqual(rotate.body, { grace_seconds: 0, end_sessions: true });
        assert.strictEqual([...t.openre.streams.values()].filter((x) => x.owner === alex.subject).length, 1, 'still one stream per machine');
    });

    await check('nobody else starts it, and no command route sends the kind', async () => {
        assert.strictEqual((await screen('POST', mine.deviceId, { user: bob })).status, 404);
        assert.strictEqual((await screen('GET', mine.deviceId, { user: bob })).status, 404);
        const agent = await screen('POST', mine.deviceId, { sub: 'svc:actor', cap: ['bot.computer.control'], headers: { 'X-OV-Subject': alex.subject } });
        assert.strictEqual(agent.status, 403, 'not the owner\'s agent either');
        const viaCommands = await t.call('POST', `/api/v1/machines/${mine.deviceId}/commands`,
            { user: alex, body: { kind: 'screen_stream', value: { action: 'start', whip_url: 'https://evil.test/whip/x', publish_key: 'x' } } });
        assert.deepStrictEqual([viaCommands.status, viaCommands.json.code], [422, 'bot.invalid_input']);
        assert.ok(!seen.some((m) => m.value && m.value.whip_url === 'https://evil.test/whip/x'), 'it never reached the machine');
        assert.strictEqual((await screen('POST', mine.deviceId, { user: alex, body: { seconds: 5 } })).status, 422, 'seconds from 30 to 1800');
        assert.strictEqual((await screen('POST', mine.deviceId, { user: alex, body: { fps: 30 } })).status, 422, 'fps from 1 to 5');
    });

    await check('a machine without the live screen is refused before a key is made', async () => {
        const old = await machine(bob, { screen: { level: 'observe', tool: 'gnome-screenshot', stream: false } });
        const before = t.openre.calls.length;
        const r = await screen('POST', old.deviceId, { user: bob });
        assert.deepStrictEqual([r.status, r.json.code], [409, 'bot.computer_off']);
        assert.match(r.json.detail, /v0\.12\.0/);
        const made = t.openre.calls.slice(before).filter((c) => c.method === 'POST' && c.path === '/api/v1/streams');
        assert.strictEqual(made.length, 0, 'refused before any stream or key is made');
        old.c.close();
    });

    await check('DELETE stops it on the machine and retires the key', async () => {
        const key = seen.filter((m) => m.kind === 'screen_stream' && m.value.action === 'start').at(-1).value.publish_key;
        const r = await screen('DELETE', mine.deviceId, { user: alex });
        assert.deepStrictEqual([r.status, r.json.stopped], [200, true]);
        assert.deepStrictEqual(seen.at(-1).value, { action: 'stop' });
        assert.ok(!t.openre.admits(key));
    });

    await check('the web page: Show my screen, the viewer page with the panel\'s CSP, its state, Stop', async () => {
        const list = await (await fetch(`${t.base}/machines`, { headers: cookie(alex) })).text();
        assert.ok(list.includes(`action="/machines/${mine.deviceId}/screen"`) && list.includes('Watch my screen'), 'the machine offers it (Watch: its telemetry says the screen is live)');
        const started = await form(`/machines/${mine.deviceId}/screen`, alex);
        assert.strictEqual(started.status, 303);
        const where = started.headers.get('location');
        assert.match(where, new RegExp(`^/machines/${mine.deviceId}/screen\\?until=\\d{4}-`));
        const page = await fetch(t.base + where, { headers: cookie(alex) });
        assert.strictEqual(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /connect-src 'self' wss:\/\/ingest\.openre\.stream/);
        const html = await page.text();
        assert.ok(html.includes(`data-screen-state="/machines/${mine.deviceId}/screen.json"`) && html.includes('/panel/panel.js'));
        const state = await fetch(`${t.base}/machines/${mine.deviceId}/screen.json`, { headers: cookie(alex) });
        assert.strictEqual(state.status, 200);
        assert.strictEqual(state.headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await fetch(`${t.base}/machines/${mine.deviceId}/screen.json`, { headers: cookie(bob) })).status, 404);
        assert.strictEqual((await form(`/machines/${mine.deviceId}/screen`, alex, { Origin: 'https://evil.test' })).status, 403, 'no cross-site post');
        const stopped = await form(`/machines/${mine.deviceId}/screen/stop`, alex);
        await t.wait(600);   // telemetry samples are kept at most twice a second
        mine.c.send(frame('telemetry', { sensors: { computer_level: 'observe', computer_screen_stream: 'off' } }));
        const idle = await poll(async () => {
            const html = await (await fetch(`${t.base}/machines/${mine.deviceId}/screen`, { headers: cookie(alex) })).text();
            return !html.includes('data-screen-state') ? html : null;
        });
        assert.ok(idle && idle.includes(`action="/machines/${mine.deviceId}/screen"`), 'opened from a link with nothing shown, it offers to start');
        assert.deepStrictEqual([stopped.status, stopped.headers.get('location')], [303, '/machines']);
        assert.deepStrictEqual(seen.at(-1).value, { action: 'stop' });
    });

    await check('a desk on the live screen: private, or a named desk on a Node that runs several (contracts 0.215.0); never a bad name', async () => {
        const desk = { level: 'trusted', window_manager: 'openbox', input: true, screen: true };
        const multi = await machine(alex, { ...SCREEN, desk: { ...desk, named: true, max_desks: 4 } });
        const r = await screen('POST', multi.deviceId, { user: alex, body: { seconds: 60, desk: 'desk-task-a' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a', 'the machine streams that desk');
        const single = await machine(alex, { ...SCREEN, desk });
        const old = await screen('POST', single.deviceId, { user: alex, body: { seconds: 60, desk: 'desk-task-a' } });
        assert.deepStrictEqual([old.status, old.json.code], [409, 'bot.computer_off']);
        const bad = await screen('POST', multi.deviceId, { user: alex, body: { seconds: 60, desk: 'desk-../x' } });
        assert.deepStrictEqual([bad.status, bad.json.code], [422, 'bot.invalid_input']);
        multi.c.close();
        single.c.close();
    });

    await check('a desk host (Node v0.20.0 --desk-host) shows its desks live though it has no screen of its own', async () => {
        const host = await machine(alex, { files: SCREEN.files, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } });
        const r = await screen('POST', host.deviceId, { user: alex, body: { seconds: 60, desk: 'desk-task-a' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a');
        const own = await screen('POST', host.deviceId, { user: alex, body: { seconds: 60 } });
        assert.deepStrictEqual([own.status, own.json.code], [409, 'bot.computer_off'], 'its own screen: there is none');
        host.c.close();
    });

    await check('watch and take over an agent\'s desk (Desks plan D4): a task\'s link opens its desk; the owner\'s mouse and keyboard go to the desk shown, as the owner; same site only', async () => {
        const desk = { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 };
        const m = await machine(alex, { ...SCREEN, input: { level: 'trusted', tool: 'xdotool' }, desk });
        const idle = await (await fetch(`${t.base}/machines/${m.deviceId}/screen?desk=desk-task-a`, { headers: cookie(alex) })).text();
        assert.ok(idle.includes('Watch your agent&#39;s desk') || idle.includes("Watch your agent's desk"), 'a task\'s link offers its desk first');
        assert.ok(idle.includes('name="desk" value="desk-task-a"'));
        const bad = await (await fetch(`${t.base}/machines/${m.deviceId}/screen?desk=desk-../x`, { headers: cookie(alex) })).text();
        assert.ok(!bad.includes('name="desk" value="desk-../x"'), 'a bad name is never offered');
        const started = await fetch(`${t.base}/machines/${m.deviceId}/screen`, { method: 'POST', redirect: 'manual', body: 'desk=desk-task-a', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(alex) } });
        assert.strictEqual(started.status, 303);
        assert.match(started.headers.get('location'), /&desk=desk-task-a$/);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a', 'the machine streams that desk');
        const html = await (await fetch(t.base + started.headers.get('location'), { headers: cookie(alex) })).text();
        assert.ok(html.includes('data-owner="1"') && html.includes('/panel/screen-share.js') && html.includes('Take over: use the mouse and keyboard'), 'the page offers Take over');
        const st = await (await fetch(`${t.base}/machines/${m.deviceId}/screen/state.json`, { headers: cookie(alex) })).json();
        assert.strictEqual(st.desk, 'desk-task-a');
        const json = (body, headers = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...cookie(alex), ...headers } });
        const click = await fetch(`${t.base}/machines/${m.deviceId}/screen/input`, json({ action: 'click', x: 10, y: 20, width: 100, height: 100 }));
        assert.strictEqual(click.status, 200, await click.clone().text());
        assert.deepStrictEqual(await click.json(), { done: true, desk: 'desk-task-a' });
        const sent = seen.at(-1);
        assert.deepStrictEqual([sent.kind, sent.value.desk, sent.value.action, sent.value.x], ['input', 'desk-task-a', 'click', 10], 'on the desk shown, never the owner\'s own screen');
        assert.strictEqual(sent.operator && sent.operator.subject, alex.subject, 'as the owner');
        assert.strictEqual((await fetch(`${t.base}/machines/${m.deviceId}/screen/input`, json({ action: 'click', x: 1, y: 1, width: 2, height: 2 }, { Origin: 'https://evil.test' }))).status, 403, 'no cross-site input');
        assert.strictEqual((await fetch(`${t.base}/machines/${m.deviceId}/screen/input`, json({ action: 'reboot' }))).status, 422);
        const bobInput = await fetch(`${t.base}/machines/${m.deviceId}/screen/input`, { method: 'POST', body: '{"action":"click"}', headers: { 'Content-Type': 'application/json', ...cookie(bob) } });
        assert.strictEqual(bobInput.status, 404, 'only the owner');
        const stop = await fetch(`${t.base}/machines/${m.deviceId}/screen/stop`, json({}));
        assert.deepStrictEqual([stop.status, (await stop.json()).stopped !== undefined], [200, true], 'the page\'s own Stop answers JSON');
        m.c.close();
    });

    await check('removing the machine archives its screen stream', async () => {
        const r = await form(`/machines/${mine.deviceId}/remove`, alex);
        assert.strictEqual(r.status, 303);
        assert.ok(t.openre.calls.some((c) => c.method === 'DELETE' && c.path === `/api/v1/streams/${streamId}`));
    });

    mine.c.close();
    await done(t);
})();
