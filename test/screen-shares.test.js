'use strict';
// Screen share links (server/screen-shares.js, migration 0022): the machine's owner makes a link to its live screen,
// shown once; "watch" links read the screen's state, "use" links also start and stop it and send mouse and keyboard
// input to the machine as its owner (audited, rate-limited, nothing else: no exec, no files); the share page works in a
// frame on OpenVibe's workspaces; another person cannot make links for the machine; a revoked or ended link answers 404.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_WHIP_BASE: 'https://ingest.openre.test/whip/' } });
    const alex = t.network.newUser('alex');
    const bob = t.network.newUser('bob');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const COMPUTER = { screen: { level: 'trusted', tool: 'grim', stream: true }, input: { level: 'trusted' }, files: { level: 'trusted', roots: ['/home/alex'] }, terminal: { level: 'trusted' } };
    const seen = [];
    const principal = t.network.addNode({ owner: alex.subject, ref: `worker:${alex.subject}`, name: 'staff-desk' });
    const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
    const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
    const config = await c.waitFor((m) => m.type === 'config');
    c.send(frame('status', { capabilities: { computer: COMPUTER }, drivers: [], faults: [] }));
    c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_screen_stream: 'off' } }));
    c.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type !== 'command') return;
        seen.push(m);
        if (m.kind === 'screen_stream' && m.value.action === 'start') c.send(frame('ack', { id: m.id, data: { streaming: true, seconds: m.value.seconds, fps: m.value.fps, until_ms: Date.now() + m.value.seconds * 1000 } }));
        else c.send(frame('ack', { id: m.id, data: {} }));
    });
    const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
    c.ws.on('close', () => clearInterval(beat));
    await poll(() => t.hub.computerOf(deviceId) !== null);
    const cookie = (user) => ({ Cookie: `ov_token=${t.network.signUser(user)}` });
    const form = (p, user, body = '', headers = {}) => fetch(t.base + p, { method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(user ? cookie(user) : {}), ...headers } });
    const json = async (method, p, body) => { const r = await fetch(t.base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null), headers: r.headers, text: '' }; };
    const linkOf = (html) => (/value="(https?:\/\/[^"]+\/screen\/([A-Za-z0-9_-]+))"/.exec(html) || [])[2];
    let watch, use;

    await check('the owner makes links, each shown once; the page lists them; nobody else makes one', async () => {
        let r = await form(`/machines/${deviceId}/shares`, alex, 'label=Staff+room&days=30');
        assert.strictEqual(r.status, 200);
        watch = linkOf(await r.text());
        assert.ok(watch && watch.length >= 40, 'a watch link');
        r = await form(`/machines/${deviceId}/shares`, alex, 'label=Staff+room+(use)&days=7&control=1');
        const html = await r.text();
        use = linkOf(html);
        assert.ok(use && use !== watch);
        assert.match(html, /watch and use/);
        const rows = await t.db.many('SELECT * FROM machine_screen_shares WHERE device_id = $1 ORDER BY created_at', [deviceId]);
        assert.deepStrictEqual(rows.map((x) => [x.label, x.control]), [['Staff room', false], ['Staff room (use)', true]]);
        assert.ok(rows.every((x) => !JSON.stringify(x).includes(watch) && !JSON.stringify(x).includes(use)), 'only hashes are kept');
        r = await fetch(`${t.base}/machines/${deviceId}/screen`, { headers: cookie(alex) });
        const page = await r.text();
        assert.match(page, /Staff room \(use\)/);
        assert.ok(!page.includes(use), 'a link is never shown again');
        assert.ok((await form(`/machines/${deviceId}/shares`, bob, 'label=mine')).status >= 400, 'another person cannot share it');
        assert.strictEqual((await form(`/machines/${deviceId}/shares`, alex, 'label=x', { Origin: 'https://evil.test' })).status, 403, 'no cross-site post');
    });

    await check('the share page: framed by OpenVibe\'s workspaces, controls only on a use link', async () => {
        let r = await fetch(`${t.base}/screen/${watch}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-security-policy'), /frame-ancestors [^;]*https:\/\/openvibe\.chat/);
        assert.match(r.headers.get('content-security-policy'), /frame-ancestors [^;]*https:\/\/openvibe\.actor/);
        assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
        let html = await r.text();
        assert.match(html, /staff-desk/);
        assert.ok(!html.includes('screen-share.js'), 'a watch link has no controls');
        r = await fetch(`${t.base}/screen/${use}`);
        html = await r.text();
        assert.match(html, /screen-share\.js/);
        assert.match(html, /Use the mouse and keyboard/);
        assert.strictEqual((await fetch(`${t.base}/screen/notarealtokennotarealtokennotarealtoken12345`)).status, 404);
    });

    await check('watch reads the state; only use starts the screen or sends input', async () => {
        let r = await json('GET', `/screen/${watch}/state.json`);
        assert.deepStrictEqual([r.status, r.json.live, r.json.online, r.json.control], [200, false, true, false]);
        assert.strictEqual((await json('POST', `/screen/${watch}/start`)).status, 403);
        assert.strictEqual((await json('POST', `/screen/${watch}/input`, { action: 'click', x: 1, y: 1, width: 10, height: 10 })).json.code, 'bot.share_watch_only');
        r = await json('POST', `/screen/${use}/start`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const start = seen.filter((m) => m.kind === 'screen_stream').at(-1);
        assert.deepStrictEqual([start.value.action, start.value.seconds, start.value.fps], ['start', 1800, 4]);
    });

    await check('input reaches the machine as the owner, audited with the action only', async () => {
        let r = await json('POST', `/screen/${use}/input`, { action: 'click', x: 640, y: 360, width: 1280, height: 720 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const click = seen.filter((m) => m.kind === 'input').at(-1);
        assert.deepStrictEqual(click.value, { action: 'click', x: 640, y: 360, width: 1280, height: 720 });
        assert.strictEqual(click.operator.subject, alex.subject);
        r = await json('POST', `/screen/${use}/input`, { action: 'type', text: 'hello team' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(seen.filter((m) => m.kind === 'input').at(-1).value, { action: 'type', text: 'hello team' });
        r = await json('POST', `/screen/${use}/input`, { action: 'key', keys: 'ctrl+s' });
        assert.strictEqual(r.status, 200);
        assert.ok((await json('POST', `/screen/${use}/input`, { action: 'key', keys: 'ctrl+s; rm -rf ~' })).status >= 400, 'the contract refuses a shell line');
        assert.strictEqual((await json('POST', `/screen/${use}/input`, { action: 'exec', argv: ['rm'] })).status, 422, 'only mouse and keyboard');
        const audit = await t.db.many("SELECT value, result FROM command_audit WHERE robot_id = $1 AND kind = 'input' ORDER BY id", [deviceId]);
        assert.ok(audit.length >= 3);
        assert.ok(!JSON.stringify(audit).includes('hello team'), 'typed text is not kept');
    });

    await check('a desk link shows and drives the private desk, never the owner\'s screen', async () => {
        let r = await fetch(`${t.base}/machines/${deviceId}/screen`, { headers: cookie(alex) });
        assert.ok(!(await r.text()).includes('Show the private desk'), 'no desk, no desk button');
        c.send(frame('status', { capabilities: { computer: { ...COMPUTER, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true } } }, drivers: [], faults: [] }));
        await poll(() => (t.hub.computerOf(deviceId) || {}).desk);
        r = await fetch(`${t.base}/machines/${deviceId}/screen`, { headers: cookie(alex) });
        const page = await r.text();
        assert.ok(page.includes('Show the private desk') && page.includes('<option value="private">The private desk, where your agent works</option>'));
        r = await form(`/machines/${deviceId}/shares`, alex, 'label=Agent+desk&days=1&control=1&desk=private');
        const html = await r.text();
        const desk = linkOf(html);
        assert.ok(desk, 'a desk link');
        assert.match(html, /Agent desk<\/strong> · the private desk · watch and use/);
        assert.match(await (await fetch(`${t.base}/screen/${desk}`)).text(), /the private desk, where an agent works/);
        assert.strictEqual((await json('GET', `/screen/${desk}/state.json`)).json.desk, 'private');
        assert.strictEqual((await json('POST', `/screen/${desk}/start`)).status, 200);
        assert.strictEqual(seen.filter((m) => m.kind === 'screen_stream').at(-1).value.desk, 'private', 'the live screen of the desk');
        assert.strictEqual((await json('POST', `/screen/${desk}/input`, { action: 'click', x: 5, y: 5, width: 100, height: 100 })).status, 200);
        assert.strictEqual(seen.filter((m) => m.kind === 'input').at(-1).value.desk, 'private', 'a click on the desk, never the owner\'s screen');
        assert.strictEqual((await t.db.maybe("SELECT desk FROM machine_screen_shares WHERE label = 'Agent desk'")).desk, 'private');
    });

    await check('a link may show any desk the machine has, not only the private one (plan L55)', async () => {
        let r = await form(`/machines/${deviceId}/shares`, alex, 'label=Task+desk&days=1&control=1&desk=desk-task-a');
        const html = await r.text();
        const task = linkOf(html);
        assert.ok(task, 'a link to a named desk');
        assert.match(html, /the desk-task-a desk/);
        assert.match(await (await fetch(`${t.base}/screen/${task}`)).text(), /the desk-task-a desk/);
        assert.strictEqual((await json('GET', `/screen/${task}/state.json`)).json.desk, 'desk-task-a');
        assert.strictEqual((await t.db.maybe("SELECT desk FROM machine_screen_shares WHERE label = 'Task desk'")).desk, 'desk-task-a');
        // A desk the machine does not have is refused by the contract, not stored.
        r = await form(`/machines/${deviceId}/shares`, alex, 'label=Bad&days=1&desk=desk-../x');
        assert.ok(r.status >= 400, 'not a desk name');
    });

    await check('a burst is slowed down; a revoked link stops at once', async () => {
        let limited = 0;
        for (let i = 0; i < 12; i++) { if ((await json('POST', `/screen/${use}/input`, { action: 'move', x: i, y: i, width: 100, height: 100 })).status === 429) limited++; }
        assert.ok(limited > 0, 'rate-limited');
        const id = (await t.db.maybe("SELECT id FROM machine_screen_shares WHERE label = 'Staff room (use)'")).id;
        const r = await form(`/machines/${deviceId}/shares/${id}/revoke`, alex);
        assert.strictEqual(r.status, 303);
        assert.strictEqual((await fetch(`${t.base}/screen/${use}`)).status, 404);
        assert.strictEqual((await json('POST', `/screen/${use}/input`, { action: 'click', x: 1, y: 1, width: 2, height: 2 })).status, 404);
        // An ended link is gone too.
        await t.db.query("UPDATE machine_screen_shares SET expires_at = now() - interval '1 minute' WHERE label = 'Staff room'");
        assert.strictEqual((await json('GET', `/screen/${watch}/state.json`)).status, 404);
    });

    c.close();
    await done(t);
})().catch((err) => { console.error(err); process.exit(1); });
