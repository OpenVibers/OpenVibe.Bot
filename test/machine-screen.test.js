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

    /** A machine of `owner` whose fake Link answers screen_stream like Link v0.12.0. */
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
        // Heartbeats keep it online, as a real Link's do.
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId, config };
    }
    const screen = (method, deviceId, opts = {}) => t.call(method, `/api/v1/machines/${deviceId}/screen`, opts);
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });

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

    await check('the machines pages moved to Link: /machines and every sub-path answer 301', async () => {
        for (const p of ['/machines', `/machines/${mine.deviceId}/screen`, `/machines/${mine.deviceId}/screen.json`, '/machines/x/desks']) {
            const r = await fetch(t.base + p, { redirect: 'manual', headers: cookie(alex) });
            assert.strictEqual(r.status, 301, p);
            assert.strictEqual(r.headers.get('location'), 'https://openvibe.link/machines', p);
        }
    });

    await check('a desk on the live screen: private, or a named desk on a Link that runs several (contracts 0.215.0); never a bad name', async () => {
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

    await check('a desk host (Link v0.20.0 --desk-host) streams its desks though it has no screen of its own', async () => {
        const host = await machine(alex, { files: SCREEN.files, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } });
        const r = await screen('POST', host.deviceId, { user: alex, body: { seconds: 60, desk: 'desk-task-a' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-task-a');
        const own = await screen('POST', host.deviceId, { user: alex, body: { seconds: 60 } });
        assert.deepStrictEqual([own.status, own.json.code], [409, 'bot.computer_off'], 'its own screen: there is none');
        host.c.close();
    });

    await check('a desk on the owner\'s OpenVibe Live channel (Desks plan D8): a public stream of its own, linked to their channel; never their own screen; Live\'s refusal said', async () => {
        const host = await machine(alex, { ...SCREEN, desk: { screen: true, named: true, kinds: ['desktop', 'browser'] } });
        const privateBefore = [...t.openre.streams.values()].filter((x) => x.refs.some((r) => r.type === 'machine' && r.id === host.deviceId)).map((x) => [x.id, x.mirror_to_live, x.playback_visibility]);
        assert.strictEqual((await screen('POST', host.deviceId, { user: alex, body: { live: true } })).json.code, 'bot.live_desk_only', 'never the person\'s own screen');
        const r = await screen('POST', host.deviceId, { user: alex, body: { desk: 'desk-task-a', live: true, seconds: 1800 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json.live.channel_url, /^https:\/\/openvibe\.live\/@/);
        const sent = seen.at(-1);
        assert.deepStrictEqual([sent.kind, sent.value.action, sent.value.desk, sent.value.seconds], ['screen_stream', 'start', 'desk-task-a', 1800]);
        const live = [...t.openre.streams.values()].find((x) => x.refs.some((ref) => ref.type === 'machine_live' && ref.id === host.deviceId));
        assert.ok(live, 'a stream of its own for Live');
        assert.deepStrictEqual([live.playback_visibility, live.mirror_to_live, live.refs.some((ref) => ref.service === 'live')], ['public', true, true], 'public and linked to the channel');
        assert.ok(t.openre.admits(sent.value.publish_key) && live.keys.some((k) => k.key === sent.value.publish_key && k.status === 'active'), 'the machine publishes to it');
        const privateAfter = [...t.openre.streams.values()].filter((x) => x.refs.some((r) => r.type === 'machine' && r.id === host.deviceId)).map((x) => [x.id, x.mirror_to_live, x.playback_visibility]);
        assert.deepStrictEqual(privateAfter, privateBefore, 'the private screen stream is never touched');
        // Again: the same stream, a new key, linked once.
        const again = await screen('POST', host.deviceId, { user: alex, body: { desk: 'desk-task-a', live: true } });
        assert.strictEqual(again.json.live.channel_url, r.json.live.channel_url);
        assert.strictEqual([...t.openre.streams.values()].filter((x) => x.refs.some((ref) => ref.type === 'machine_live' && ref.id === host.deviceId)).length, 1);
        // Without a Live account: Live's reason, and nothing is sent to the machine.
        const bobs = await machine(bob, { ...SCREEN, desk: { screen: true, named: true } });
        t.openre.noLive.add(bob.subject);
        const before = seen.length;
        const refused = await screen('POST', bobs.deviceId, { user: bob, body: { desk: 'desk-task-b', live: true } });
        assert.deepStrictEqual([refused.status, refused.json.code], [409, 'live.no_account'], refused.text);
        assert.match(refused.json.detail || '', /Sign in to openvibe\.live once/);
        assert.strictEqual(seen.length, before, 'nothing went to the machine');
        host.c.close();
        bobs.c.close();
    });

    await check('removing the machine archives its screen stream', async () => {
        for (const session of [...t.openre.sessions.values()]) if (session.stream_id === streamId) t.openre.endLive(session.id);
        const r = await t.call('POST', `/api/v1/machines/${mine.deviceId}/revoke`, {
            sub: 'svc:network', cap: ['bot.machine.manage'], headers: { 'X-OV-Subject': alex.subject }, body: {},
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(t.openre.calls.some((c) => c.method === 'DELETE' && c.path === `/api/v1/streams/${streamId}`));
    });

    mine.c.close();
    await done(t);
})();
