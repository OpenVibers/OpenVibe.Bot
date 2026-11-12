'use strict';
// The Link hub's machine controls (the page removed in #371): the network's hub (svc:network, bot.machine.manage,
// X-OV-Subject) acts for the owner exactly as the person's own session does — the agent and watch switches, the
// live screen (10 minutes by default), the mouse and keyboard, the machine's desks, and its screen links. Bot owns
// every check: a machine that is not that person's is 404, and only the network's own service may act for a person.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_WHIP_BASE: 'https://ingest.openre.test/whip/' } });
    const alex = t.network.newUser('alex');
    const sam = t.network.newUser('sam');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const COMPUTER = {
        level: 'ask',
        screen: { level: 'ask', tool: 'grim', stream: true },
        terminal: { level: 'ask' }, files: { level: 'ask', roots: ['/home/alex'] },
        desk: { level: 'ask', max_desks: 2, kinds: ['browser'], isolation: 'sandbox', screen: true, named: true },
        probe: { level: 'observe' },
        input: { level: 'ask' },
    };
    const seen = [];

    /** A machine of `owner` whose fake Link answers the computer plugin, its desks, the screen and the input. */
    async function machine(owner) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { computer: COMPUTER }, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: { computer_level: 'ask', computer_waiting: 0, computer_desks: 1, computer_screen_stream: 'off' } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push(m);
            if (m.kind === 'screen_stream' && m.value.action === 'start') {
                c.send(frame('ack', { id: m.id, data: { streaming: true, until_ms: Date.now() + m.value.seconds * 1000 } }));
            } else if (m.kind === 'screen_stream') c.send(frame('ack', { id: m.id, data: { streaming: false, stopped: true } }));
            else if (m.kind === 'desk' && m.value.action === 'list') {
                c.send(frame('ack', { id: m.id, data: { desks: [{ desk: 'desk-a', kind: 'browser', since: 1700000000, width: 1280, height: 720 }], max_desks: 2 } }));
            } else if (m.kind === 'desk' && m.value.action === 'stop') c.send(frame('ack', { id: m.id, data: { stopped: m.value.desk } }));
            else if (m.kind === 'input') c.send(frame('ack', { id: m.id, data: { done: true } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'unsupported' }));
        });
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId };
    }
    /** The hub's own call: Network acting for the person. */
    const hub = (method, path, { body, subject = alex.subject } = {}) =>
        t.call(method, path, { body, sub: 'svc:network', cap: ['bot.machine.manage'], headers: { 'X-OV-Subject': subject } });

    const mine = await machine(alex);
    const theirs = await machine(sam);

    await check('the hub turns the owner\'s switches, exactly as the person does', async () => {
        const listed = await hub('GET', '/api/v1/machines');
        assert.strictEqual(listed.status, 200, listed.text);
        const row = listed.json.machines.find((m) => m.id === mine.deviceId);
        assert.deepStrictEqual([row.agent_computer, row.watch_probe], [false, false], 'off until the owner turns them on');
        const on = await hub('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { body: { on: true } });
        assert.strictEqual(on.status, 200, on.text);
        assert.strictEqual(on.json.machine.agent_computer, true);
        assert.strictEqual((await t.db.maybe('SELECT agent_computer FROM devices WHERE id = $1', [mine.deviceId])).agent_computer, true);
        const watch = await hub('POST', `/api/v1/machines/${mine.deviceId}/watch-probe`, { body: { on: true } });
        assert.strictEqual(watch.status, 200, watch.text);
        assert.strictEqual(watch.json.machine.watch_probe, true);
        // The person themselves still may, and a machine that is not theirs is 404, never 403.
        const own = await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { user: alex, body: { on: false } });
        assert.strictEqual(own.status, 200, own.text);
        assert.strictEqual(own.json.machine.agent_computer, false);
        for (const [method, path, body] of [
            ['POST', `/api/v1/machines/${theirs.deviceId}/agent-computer`, { on: true }],
            ['POST', `/api/v1/machines/${theirs.deviceId}/watch-probe`, { on: true }],
            ['POST', `/api/v1/machines/${theirs.deviceId}/screen`, {}],
            ['GET', `/api/v1/machines/${theirs.deviceId}/desks`],
        ]) {
            const other = await hub(method, path, { body });
            assert.strictEqual(other.status, 404, `${method} ${path}: ${other.text}`);
            assert.strictEqual(other.json.code, 'bot.device_not_found');
        }
        // 2026-11-12: every switch of the machine card: the models, voice, and lending the desks to other people's
        // agents (only where every desk is sandboxed; this fake Link's are).
        for (const [route, col] of [['ai-models', 'ai_models'], ['voice', 'voice_on'], ['shared-desks', 'shared_desks']]) {
            const r = await hub('POST', `/api/v1/machines/${mine.deviceId}/${route}`, { body: { on: true } });
            assert.strictEqual(r.status, 200, `${route}: ${r.text}`);
            assert.strictEqual((await t.db.maybe(`SELECT ${col} FROM devices WHERE id = $1`, [mine.deviceId]))[col], true, route);
            const other = await hub('POST', `/api/v1/machines/${theirs.deviceId}/${route}`, { body: { on: true } });
            assert.strictEqual(other.status, 404, `${route} on another person's machine: ${other.text}`);
            const bad = await hub('POST', `/api/v1/machines/${mine.deviceId}/${route}`, { body: { on: 'yes' } });
            assert.strictEqual(bad.status, 422, `${route}: on is true or false`);
        }
        assert.strictEqual((await hub('GET', '/api/v1/machines')).json.machines.find((m) => m.id === mine.deviceId).shared_desks, true, 'the card reads it back');
        const lentOff = await t.call('POST', `/api/v1/machines/${mine.deviceId}/shared-desks`, { user: alex, body: { on: false } });
        assert.strictEqual(lentOff.status, 200, lentOff.text);
        assert.strictEqual(lentOff.json.machine.shared_desks, false, 'the person themselves stops lending');
        // Another service with the capability cannot act for a person.
        const stranger = await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, {
            body: { on: true }, sub: 'svc:codes', cap: ['bot.machine.manage'], headers: { 'X-OV-Subject': alex.subject },
        });
        assert.strictEqual(stranger.status, 403, stranger.text);
        assert.strictEqual(stranger.json.code, 'bot.forbidden');
    });

    await check('a computer whose desks are not each in a sandbox cannot lend them to other people', async () => {
        // The same machine, now saying its desks share one browser profile (no sandbox of their own).
        mine.c.send(frame('status', { capabilities: { computer: { ...COMPUTER, desk: { ...COMPUTER.desk, isolation: 'profile' } } }, drivers: [], faults: [] }));
        await poll(() => { const o = t.hub.computerOf(mine.deviceId); return o && o.desk && o.desk.isolation === 'profile'; });
        const r = await hub('POST', `/api/v1/machines/${mine.deviceId}/shared-desks`, { body: { on: true } });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.code, 'bot.desks_not_sandboxed');
        assert.strictEqual((await t.db.maybe('SELECT shared_desks FROM devices WHERE id = $1', [mine.deviceId])).shared_desks, false);
        const off = await hub('POST', `/api/v1/machines/${mine.deviceId}/shared-desks`, { body: { on: false } });
        assert.strictEqual(off.status, 200, 'turning it off always works');
        mine.c.send(frame('status', { capabilities: { computer: COMPUTER }, drivers: [], faults: [] }));
        await poll(() => { const o = t.hub.computerOf(mine.deviceId); return o && o.desk && o.desk.isolation === 'sandbox'; });
    });

    await check('the live screen: the hub starts it for ten minutes, reads it, takes the input and stops it', async () => {
        const start = await hub('POST', `/api/v1/machines/${mine.deviceId}/screen`, { body: {} });
        assert.strictEqual(start.status, 201, start.text);
        assert.deepStrictEqual([start.json.streaming, start.json.seconds, start.json.fps], [true, 600, 2], '10 minutes at 2 frames a second by default');
        let sent = seen.filter((m) => m.kind === 'screen_stream').at(-1);
        assert.deepStrictEqual([sent.value.action, sent.value.seconds], ['start', 600]);
        assert.ok(sent.value.publish_key && sent.value.whip_url, 'the machine gets the key, never the page');
        const state = await hub('GET', `/api/v1/machines/${mine.deviceId}/screen`);
        assert.strictEqual(state.status, 200, state.text);
        assert.deepStrictEqual([state.json.state, state.json.online], ['off', true]);
        const input = await hub('POST', `/api/v1/machines/${mine.deviceId}/screen/input`, { body: { action: 'click', x: 2, y: 3, width: 100, height: 100 } });
        assert.strictEqual(input.status, 200, input.text);
        assert.strictEqual(input.json.done, true);
        assert.strictEqual(seen.filter((m) => m.kind === 'input').at(-1).value.action, 'click');
        const stopped = await hub('DELETE', `/api/v1/machines/${mine.deviceId}/screen`);
        assert.deepStrictEqual([stopped.status, stopped.json.stopped], [200, true]);
    });

    await check('the desks: listed through the machine, stopped, and put on the owner\'s Live channel', async () => {
        const list = await hub('GET', `/api/v1/machines/${mine.deviceId}/desks`);
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual(list.json.desks.map((d) => [d.desk, d.kind, d.width, d.height]), [['desk-a', 'browser', 1280, 720]]);
        assert.strictEqual(list.json.max_desks, 2);
        const stop = await hub('POST', `/api/v1/machines/${mine.deviceId}/desks/desk-a/stop`, { body: {} });
        assert.strictEqual(stop.status, 200, stop.text);
        assert.strictEqual(stop.json.stopped, 'desk-a');
        assert.deepStrictEqual(seen.filter((m) => m.kind === 'desk').at(-1).value, { action: 'stop', desk: 'desk-a' });
        const live = await hub('POST', `/api/v1/machines/${mine.deviceId}/desks/desk-a/live`, { body: {} });
        assert.strictEqual(live.status, 201, live.text);
        assert.deepStrictEqual([live.json.desk, live.json.seconds], ['desk-a', 1800], 'the Live channel gets it for 30 minutes');
        assert.ok(live.json.live && /^https:\/\/openvibe\.live\/@/.test(live.json.live.channel_url || ''), live.text);
    });

    await check('the screen links: made by the owner, listed without the token, and revoked', async () => {
        const made = await t.call('POST', `/api/v1/machines/${mine.deviceId}/watch-links`, { user: alex, body: { label: 'Staff room', minutes: 60 } });
        assert.strictEqual(made.status, 201, made.text);
        const shareId = made.json.share_id;
        assert.ok(shareId, 'the link has its id');
        const list = await hub('GET', `/api/v1/machines/${mine.deviceId}/shares`);
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual(list.json.shares.map((s) => [s.id, s.label, s.control, s.desk]), [[shareId, 'Staff room', false, 'main']]);
        assert.ok(!JSON.stringify(list.json).includes(made.json.url.split('/screen/')[1]), 'never the token');
        const revoked = await hub('DELETE', `/api/v1/machines/${mine.deviceId}/shares/${shareId}`);
        assert.deepStrictEqual([revoked.status, revoked.json.revoked], [200, true]);
        assert.deepStrictEqual((await hub('GET', `/api/v1/machines/${mine.deviceId}/shares`)).json.shares, []);
    });

    await check('only the owner\'s own machine: another person\'s screen, desks and shares are not there', async () => {
        const otherScreen = await hub('GET', `/api/v1/machines/${theirs.deviceId}/screen`, { subject: sam.subject });
        assert.strictEqual(otherScreen.status, 200, 'its owner may read it, of course');
        for (const [method, path] of [
            ['GET', `/api/v1/machines/${theirs.deviceId}/screen`],
            ['DELETE', `/api/v1/machines/${theirs.deviceId}/screen`],
            ['GET', `/api/v1/machines/${theirs.deviceId}/shares`],
            ['GET', `/api/v1/machines/${theirs.deviceId}/desks`],
            ['POST', `/api/v1/machines/${theirs.deviceId}/desks/desk-a/stop`],
        ]) {
            const r = await hub(method, path, { body: method === 'POST' ? {} : undefined });
            assert.strictEqual(r.status, 404, `${method} ${path}: ${r.text}`);
            assert.strictEqual(r.json.code, 'bot.device_not_found');
        }
    });

    await done();
})().catch((e) => { console.error(e); process.exit(1); });
