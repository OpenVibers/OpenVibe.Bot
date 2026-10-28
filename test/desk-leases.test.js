'use strict';
// Desk leases for OpenVibe.Run's sessions (contracts 0.223.0, bot.desk.session; the Desks plan's D6). Only Run, with the
// capability, acting for a person: GET /api/v1/desk-hosts lists that person's own machines (agents allowed) and desk
// hosts whose owner offers them to other people and whose Node sandboxes every desk; a lease starts a browser desk,
// takes commands for that desk alone and ends with DELETE; the machine's own routes never reach a leased desk; a full
// machine is busy; anyone else gets 404.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0' } });
    const alex = t.network.newUser('alex');   // runs a desk host for other people
    const bob = t.network.newUser('bob');     // uses it, and has a machine of his own
    const carol = t.network.newUser('carol');
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const seen = [];
    const DESK = (isolation, max = 1) => ({ level: 'trusted', window_manager: null, input: true, screen: true, named: true, max_desks: max, kinds: ['browser'], profiles: false, ...(isolation ? { isolation } : {}) });

    /** A machine of `owner` whose fake Node answers desk and browser commands like the computer plugin would. */
    async function machine(owner, computer) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'desks' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        c.send(frame('status', { capabilities: { computer }, drivers: [], faults: [] }));
        c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_desks: 0 } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push({ deviceId, ...m });
            if (m.kind === 'desk') c.send(frame('ack', { id: m.id, data: { running: m.value.action !== 'stop', kind: 'browser', width: 1280, height: 800 } }));
            else if (m.kind === 'browser') c.send(frame('ack', { id: m.id, data: { url: m.value.url || 'https://example.org/', title: 'Example', text: 'Example page', truncated: false, links: [] } }));
            else if (m.kind === 'screen') c.send(frame('ack', { id: m.id, data: { format: 'jpeg', width: 1280, height: 800, content_b64: '/9j/' } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'not_allowed', message: 'this machine is a desk host for other people' }));
        });
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId };
    }
    const run = (cap = ['bot.desk.session']) => t.network.signService({ sub: 'svc:run', cap });
    const asRun = (subject, token = run()) => ({ token, headers: { 'X-OV-Subject': subject } });
    const SES = (n) => `ses_01JD2C3D4E5F6G7H8J9K0MNP${String(n).padStart(2, '0')}`;

    const host = await machine(alex, { desk: DESK('sandbox', 1) });   // two browser desks at once
    const plain = await machine(carol, { desk: DESK(null, 2) });      // desks, not sandboxed: never shared
    const own = await machine(bob, { desk: DESK(null, 2) });

    await check('only Run, with bot.desk.session, acting for a person', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/desk-hosts', { user: bob })).status, 403, 'not a person\'s own call');
        assert.strictEqual((await t.call('GET', '/api/v1/desk-hosts', asRun(bob.subject, t.network.signService({ sub: 'svc:actor', cap: ['bot.desk.session'] })))).status, 403, 'Run only');
        assert.strictEqual((await t.call('GET', '/api/v1/desk-hosts', asRun(bob.subject, run(['bot.computer.control'])))).status, 403, 'needs bot.desk.session');
        assert.strictEqual((await t.call('GET', '/api/v1/desk-hosts', { token: run() })).status, 422, 'for a person');
    });

    await check('desk hosts: the person\'s own machines where agents may work, and shared sandboxed hosts', async () => {
        let hosts = (await t.call('GET', '/api/v1/desk-hosts', asRun(bob.subject))).json.hosts;
        assert.deepStrictEqual(hosts, [], 'nothing before agents are allowed and nothing is shared');
        await t.domain.machines.setAgentComputer(own.deviceId, true);
        await t.domain.machines.setSharedDesks(host.deviceId, true);
        await t.domain.machines.setSharedDesks(plain.deviceId, true);   // set behind the web check: still never offered
        hosts = (await t.call('GET', '/api/v1/desk-hosts', asRun(bob.subject))).json.hosts;
        const by = Object.fromEntries(hosts.map((h) => [h.machine_id, h]));
        assert.deepStrictEqual(Object.keys(by).sort(), [host.deviceId, own.deviceId].sort(), 'never a host that does not sandbox its desks');
        assert.deepStrictEqual([by[own.deviceId].trust, by[own.deviceId].shared, by[own.deviceId].free], ['user-owned', false, 4]);
        assert.deepStrictEqual([by[host.deviceId].trust, by[host.deviceId].shared, by[host.deviceId].free, by[host.deviceId].online], ['community', true, 2, true]);
        assert.ok(!('name' in by[host.deviceId]), 'another person\'s machine name is not shown');
        const carols = (await t.call('GET', '/api/v1/desk-hosts', asRun(carol.subject))).json.hosts.map((h) => h.machine_id);
        assert.deepStrictEqual(carols, [host.deviceId], 'carol sees the shared host, not bob\'s own machine');
    });

    let lease;
    await check('a lease starts a browser desk on the shared host, once per session', async () => {
        const body = { session: SES(1), desk: 'desk-s01', kind: 'browser', width: 1024, height: 700 };
        const r = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body });
        assert.strictEqual(r.status, 201, r.text);
        lease = r.json;
        assert.deepStrictEqual([lease.machine_id, lease.desk, lease.session, lease.owner, lease.shared, lease.width], [host.deviceId, 'desk-s01', SES(1), `user:${bob.subject}`, true, 1024]);
        const start = seen.filter((m) => m.deviceId === host.deviceId && m.kind === 'desk').at(-1);
        assert.deepStrictEqual(start.value, { action: 'start', desk: 'desk-s01', kind: 'browser', width: 1024, height: 700 });
        assert.strictEqual((await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body })).status, 200, 'a repeat answers the lease');
        const other = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(carol.subject), body: { ...body, session: SES(2) } });
        assert.deepStrictEqual([other.status, other.json.code], [409, 'bot.desk_busy']);
        const bad = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { ...body, session: SES(3), desk: 'main' } });
        assert.strictEqual(bad.status, 422, 'never main or private');
        const notShared = await t.call('POST', `/api/v1/machines/${plain.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { ...body, session: SES(4) } });
        assert.strictEqual(notShared.status, 404, 'a host that does not sandbox its desks is never leased to someone else');
    });

    await check('commands reach the leased desk alone, for its person alone', async () => {
        const url = `/api/v1/machines/${host.deviceId}/desk-leases/desk-s01/commands`;
        const r = await t.call('POST', url, { ...asRun(bob.subject), body: { id: 'c1', kind: 'browser', value: { action: 'open', url: 'https://example.org/' } } });
        assert.deepStrictEqual([r.status, r.json.result, r.json.desk], [200, 'ack', 'desk-s01'], r.text);
        assert.strictEqual(seen.at(-1).value.desk, 'desk-s01', 'Run never names the desk: Bot does');
        assert.strictEqual((await t.call('POST', url, { ...asRun(bob.subject), body: { kind: 'browser', value: { action: 'read', desk: 'desk-other' } } })).status, 422, 'a value naming a desk');
        assert.strictEqual((await t.call('POST', url, { ...asRun(bob.subject), body: { kind: 'exec', value: { argv: ['id'] } } })).status, 422, 'never the machine itself');
        assert.strictEqual((await t.call('POST', url, { ...asRun(carol.subject), body: { kind: 'screen', value: {} } })).status, 404, 'another person');
        assert.strictEqual((await t.call('GET', `/api/v1/machines/${host.deviceId}/desk-leases/desk-s01`, asRun(carol.subject))).status, 404);
        // The host's owner, with their own machine's routes, never reaches the session's desk.
        await t.domain.machines.setAgentComputer(host.deviceId, true);
        const owner = await t.call('POST', `/api/v1/machines/${host.deviceId}/commands`, { user: alex, body: { kind: 'screen', value: { desk: 'desk-s01' } } });
        assert.deepStrictEqual([owner.status, owner.json.code], [409, 'bot.desk_leased']);
    });

    await check('a full machine is busy; the end stops the desk and frees the room', async () => {
        const second = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(carol.subject), body: { session: SES(5), desk: 'desk-s05', kind: 'browser' } });
        assert.strictEqual(second.status, 201, second.text);
        const third = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(6), desk: 'desk-s06', kind: 'browser' } });
        assert.deepStrictEqual([third.status, third.json.code], [409, 'bot.machine_busy'], 'max_desks 1: two browser desks');
        const end = await t.call('DELETE', `/api/v1/machines/${host.deviceId}/desk-leases/desk-s01`, asRun(bob.subject));
        assert.deepStrictEqual([end.status, end.json.ended, end.json.stopped], [200, true, true]);
        assert.deepStrictEqual(seen.filter((m) => m.kind === 'desk').at(-1).value, { action: 'stop', desk: 'desk-s01' });
        assert.strictEqual((await t.call('GET', `/api/v1/machines/${host.deviceId}/desk-leases/desk-s01`, asRun(bob.subject))).status, 404, 'gone');
        const again = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(6), desk: 'desk-s06', kind: 'browser' } });
        assert.strictEqual(again.status, 201, 'room again');
    });

    await check('a shared host is offered to the Network as a browser worker, community unless it is OpenVibe\'s', async () => {
        const offers = await t.app.locals.offers.build();
        const desk = offers.find((o) => o.offer_id === `desk:${host.deviceId}`);
        assert.ok(desk, 'the shared host is offered');
        assert.deepStrictEqual([desk.trust, desk.capabilities, desk.health.status], ['community', ['worker:browser'], 'up']);
        assert.ok(!offers.some((o) => o.offer_id === `desk:${plain.deviceId}`), 'never a host that does not sandbox its desks');
        assert.ok(!offers.some((o) => o.offer_id === `desk:${own.deviceId}`), 'a person\'s own machine is not offered to others');
    });

    await check('the machines page: a sandboxed host offers its desks with one button; another cannot', async () => {
        const cookie = { Cookie: `ov_token=${t.network.signUser(alex)}` };
        const form = (id, on) => fetch(`${t.base}/machines/${id}/shared-desks`, { method: 'POST', redirect: 'manual', body: `on=${on}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: t.base, ...cookie } });
        let html = '';
        let tries = 0;
        while (tries < 20 && !html.includes('Serving other people')) {
            if (tries) await t.wait(100);
            html = await (await fetch(`${t.base}/machines`, { headers: cookie })).text();
            tries += 1;
        }
        assert.ok(html.includes('Serving other people') && html.includes('desks in use'), 'the host says it serves other people, and how many desks are in use');
        assert.ok(html.includes('Stop offering my desks'));
        assert.strictEqual((await form(host.deviceId, 0)).status, 303);
        assert.strictEqual((await t.db.maybe('SELECT shared_desks FROM devices WHERE id = $1', [host.deviceId])).shared_desks, false);
        assert.strictEqual((await form(host.deviceId, 1)).status, 303);
        assert.strictEqual((await t.db.maybe('SELECT shared_desks FROM devices WHERE id = $1', [host.deviceId])).shared_desks, true);
        const carolsCookie = { Cookie: `ov_token=${t.network.signUser(carol)}` };
        const notSandboxed = await fetch(`${t.base}/machines/${plain.deviceId}/shared-desks`, { method: 'POST', redirect: 'manual', body: 'on=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: t.base, ...carolsCookie } });
        assert.strictEqual(notSandboxed.status, 409, 'a host that does not sandbox its desks is never offered');
    });

    await check('the owner stops offering: no new lease there', async () => {
        await t.domain.machines.setSharedDesks(host.deviceId, false);
        const r = await t.call('POST', `/api/v1/machines/${host.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(7), desk: 'desk-s07', kind: 'browser' } });
        assert.strictEqual(r.status, 404);
        const own2 = await t.call('POST', `/api/v1/machines/${own.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(8), desk: 'desk-s08', kind: 'browser' } });
        assert.deepStrictEqual([own2.status, own2.json.shared], [201, false], 'a person\'s own machine, where agents may work');
    });

    for (const m of [host, plain, own]) m.c.close();
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
