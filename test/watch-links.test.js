'use strict';
// A watch link to a machine's desk (plan L55): the owner's agent (svc:actor with bot.machine.watch_link) asks Bot for a
// link that shows the desk it works on, live, inside a chat turn. The link is the owner's own (the machine is the one
// the named subject owns), it needs no sign-in, it may sit in a frame on openvibe.chat or openvibe.actor, and it ends
// in minutes. Another person's machine is not there at all (404), another service may not make one, and the mouse and
// keyboard come with it only when asked for.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_WHIP_BASE: 'https://ingest.openre.test/whip/' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const COMPUTER = { screen: { level: 'trusted', tool: 'grim', stream: true }, input: { level: 'trusted' }, files: { level: 'trusted', roots: ['/home/alex'] }, terminal: { level: 'trusted' },
        desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } };
    const seen = [];

    /** A Network-paired machine of `owner` whose fake Node answers screen and input like the plugin would. */
    async function machine(owner, computer = COMPUTER) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desk-pc' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { computer }, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_screen_stream: 'off' } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push(m);
            if (m.kind === 'screen_stream' && m.value.action === 'start') c.send(frame('ack', { id: m.id, data: { streaming: true, seconds: m.value.seconds, fps: m.value.fps, until_ms: Date.now() + m.value.seconds * 1000 } }));
            else c.send(frame('ack', { id: m.id, data: { done: true } }));
        });
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId };
    }
    const actor = (cap = ['bot.machine.watch_link']) => t.network.signService({ sub: 'svc:actor', cap });
    const asActor = (token, subject) => ({ token, headers: { 'X-OV-Subject': subject } });
    const link = (deviceId, body, opts) => t.call('POST', `/api/v1/machines/${deviceId}/watch-links`, { body, ...opts });

    let mine, theirs;
    await check('the agent asks for a link to the desk it works on; the link is the owner\'s own and shows it', async () => {
        mine = await machine(alex);
        theirs = await machine(bob);
        await t.call('POST', `/api/v1/machines/${mine.deviceId}/agent-computer`, { user: alex, body: { on: true } });
        const r = await link(mine.deviceId, { desk: 'desk-task-a', minutes: 30 }, asActor(actor(), alex.subject));
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json.url, /^https?:\/\/[^/]+\/screen\/[A-Za-z0-9_-]{40,60}$/, 'the link is a page on openvibe.bot');
        assert.ok(r.json.expires_at, 'it says when it ends');
        const left = new Date(r.json.expires_at).getTime() - Date.now();
        assert.ok(left > 29 * 60000 && left <= 30 * 60000, 'thirty minutes, more or less');
        assert.deepStrictEqual([r.json.desk, r.json.control], ['desk-task-a', false], 'watching only, unless asked for');
        // The page itself: no sign-in, and it may sit in a frame on OpenVibe\'s own services.
        const token = r.json.url.split('/').pop();
        const page = await fetch(t.base + `/screen/${token}`);
        assert.strictEqual(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /frame-ancestors [^;]*https:\/\/openvibe\.actor/);
        assert.match(page.headers.get('content-security-policy'), /frame-ancestors [^;]*https:\/\/openvibe\.chat/);
        assert.match(await page.text(), /desk-task-a desk/);
        assert.strictEqual((await fetch(t.base + `/screen/${token}/state.json`)).status, 200);
    });

    await check('another person\'s machine is not there at all, and another service may not make a link', async () => {
        const other = await link(mine.deviceId, { desk: 'main' }, asActor(actor(), bob.subject));
        assert.strictEqual(other.status, 404, 'never 403: nobody may learn whose machine an id is');
        assert.strictEqual(other.json.code, 'bot.device_not_found');
        // The agent may not make a link for a machine the owner never opened to it.
        await t.call('POST', `/api/v1/machines/${theirs.deviceId}/agent-computer`, { user: bob, body: { on: false } });
        const notOpen = await link(theirs.deviceId, { desk: 'main' }, asActor(actor(), bob.subject));
        assert.strictEqual(notOpen.status, 403);
        assert.strictEqual(notOpen.json.code, 'bot.agent_not_allowed');
        // Another service, even holding the capability, is not the owner\'s agent.
        const other1 = await link(mine.deviceId, { desk: 'main' }, { token: t.network.signService({ sub: 'svc:live', cap: ['bot.machine.watch_link'] }), headers: { 'X-OV-Subject': alex.subject } });
        assert.strictEqual(other1.status, 403);
        assert.strictEqual(other1.json.code, 'bot.forbidden');
        // The agent shows its own desk, never the owner's screen, and names the desk it means.
        const ownScreen = await link(mine.deviceId, { desk: 'main', minutes: 30 }, asActor(actor(), alex.subject));
        assert.strictEqual(ownScreen.status, 422);
        assert.strictEqual(ownScreen.json.code, 'bot.desk_not_agents');
        const unnamed = await link(mine.deviceId, { minutes: 30 }, asActor(actor(), alex.subject));
        assert.strictEqual(unnamed.status, 422, 'no desk named is not the owner\'s screen either');
        assert.strictEqual((await link(mine.deviceId, { desk: 'private', minutes: 30 }, asActor(actor(), alex.subject))).status, 201, 'the private desk is an agent\'s');
        // The agent without the capability has no route at all.
        const noCap = await link(mine.deviceId, { desk: 'main' }, asActor(actor(['bot.computer.control']), alex.subject));
        assert.strictEqual(noCap.status, 403);
        assert.strictEqual(noCap.json.code, 'capability.denied');
    });

    await check('the link ends in minutes, and the desk is any agent desk the machine has', async () => {
        const soon = await link(mine.deviceId, { desk: 'desk-task-a', minutes: 5 }, asActor(actor(), alex.subject));
        assert.strictEqual(soon.status, 201, soon.text);
        const five = new Date(soon.json.expires_at).getTime() - Date.now();
        assert.ok(five > 4 * 60000 && five <= 5 * 60000, 'five minutes');
        for (const minutes of [4, 241, 0, 'soon', 1.5]) {
            const bad = await link(mine.deviceId, { desk: 'desk-task-a', minutes }, asActor(actor(), alex.subject));
            assert.strictEqual(bad.status, 422, `minutes ${minutes}`);
            assert.strictEqual(bad.json.code, 'bot.invalid_input');
        }
        for (const desk of ['private', 'desk-task-a', 'desk-a-b-9']) {
            const ok = await link(mine.deviceId, { desk, minutes: 60 }, asActor(actor(), alex.subject));
            assert.strictEqual(ok.status, 201, `desk ${desk}`);
            assert.strictEqual(ok.json.desk, desk);
        }
        for (const desk of ['desk-../x', 'desk-', 'DESK-a', 'other', 'desk-' + 'x'.repeat(30)]) {
            const bad = await link(mine.deviceId, { desk, minutes: 60 }, asActor(actor(), alex.subject));
            assert.strictEqual(bad.status, 422, `desk ${desk}`);
            assert.strictEqual(bad.json.code, 'bot.invalid_input');
        }
    });

    await check('the mouse and the keyboard come with the link only when asked for', async () => {
        const plain = await link(mine.deviceId, { desk: 'desk-task-a', minutes: 30 }, asActor(actor(), alex.subject));
        const token = plain.json.url.split('/').pop();
        const html = await (await fetch(t.base + `/screen/${token}`)).text();
        assert.ok(!html.includes('screen-share.js'), 'a watch link has no controls');
        assert.strictEqual((await fetch(t.base + `/screen/${token}/start`, { method: 'POST' })).status, 403);
        const use = await link(mine.deviceId, { desk: 'desk-task-a', control: true, minutes: 30 }, asActor(actor(), alex.subject));
        assert.strictEqual(use.json.control, true);
        const useToken = use.json.url.split('/').pop();
        const useHtml = await (await fetch(t.base + `/screen/${useToken}`)).text();
        assert.match(useHtml, /screen-share\.js/);
        assert.strictEqual((await fetch(t.base + `/screen/${useToken}/start`, { method: 'POST' })).status, 200);
        const start = seen.filter((m) => m.kind === 'screen_stream').at(-1);
        assert.strictEqual(start.value.desk, 'desk-task-a', 'the live screen of that desk');
    });

    await check('the owner may make one themselves; the making of it is audited', async () => {
        const own = await link(mine.deviceId, { desk: 'desk-task-a', minutes: 30 }, { user: alex });
        assert.strictEqual(own.status, 201, own.text);
        assert.ok(own.json.url.includes('/screen/'));
        const audit = await t.db.many("SELECT operator_subject, operator_kind, kind, value, result FROM command_audit WHERE robot_id = $1 AND kind = 'screen.share' ORDER BY id", [mine.deviceId]);
        assert.ok(audit.length >= 1, 'the link is in the audit');
        assert.deepStrictEqual(audit.at(-1).value.desk, 'desk-task-a');
        assert.strictEqual(audit.at(-1).result, 'ack');
        assert.strictEqual(audit.at(-1).operator_subject, alex.subject);
    });

    await check('too many links for one person are refused', async () => {
        let refused = 0;
        for (let i = 0; i < 80; i++) {
            const r = await link(mine.deviceId, { desk: 'main', minutes: 5 }, asActor(actor(), alex.subject));
            if (r.status === 429) { refused++; break; }
        }
        assert.strictEqual(refused, 1, 'rate-limited');
    });

    mine.c.close();
    theirs.c.close();
    await done(t);
})().catch((err) => { console.error(err); process.exit(1); });
