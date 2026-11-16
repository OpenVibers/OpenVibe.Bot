'use strict';
// Machines lend more to other people (2026-11-14; OpenVibe.Link v0.65.0, contracts 0.433.0): the owner may lend whole
// desktops to other people's agents (shared_desktops) and run other people's jobs, coding tasks and agents
// (shared_jobs). Each switch turns on only where the machine's own Link says it keeps that work away from the machine
// (a desk host that lends desktops, each sandboxed; a worker that serves other people), Run gets a community offer for
// it, a desktop is leased like a browser desk but driven with screen and input only, and another person's job goes
// out marked for the Link, never to a machine whose owner did not lend it.
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
// The key another person's sandbox id is made with (server/jobs/dispatch.js sandboxOf): this process's, read on first use.
process.env.BOT_SANDBOX_KEY = process.env.BOT_SANDBOX_KEY || 'a-test-sandbox-key';

(async () => {
    const t = await boot({ env: { BOT_ROUTINE_TICK_MS: '0', BOT_WEBHOOK_TICK_MS: '0', BOT_OFFLINE_GRACE_MS: '30000' } });
    const alex = t.network.newUser('alex');   // lends his machines
    const bob = t.network.newUser('bob');     // uses them
    const { dispatch } = require('../server/jobs/dispatch');
    const offers = t.app.locals.offers;
    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const poll = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await t.wait(30); } return null; };
    const seen = [];
    const DESK = (kinds) => ({ level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 1, kinds, profiles: false, isolation: 'sandbox' });
    const WORKER = (serveOthers) => ({ capabilities: ['worker:code'], runtime_classes: ['code'], max_jobs: 2, ...(serveOthers ? { serve_others: true, egress: 'public' } : {}) });

    /** A machine of `owner` whose fake Link reports `capabilities` and answers desk, screen and input like the plugin. */
    async function machine(owner, capabilities) {
        const principal = t.network.addNode({ owner: owner.subject, ref: `worker:${owner.subject}`, name: 'lender' });
        const c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
        const deviceId = (await c.waitFor((m) => m.type === 'hello')).device_id;
        const config = await c.waitFor((m) => m.type === 'config');
        const report = (caps) => c.send(frame('status', { capabilities: caps, drivers: [], faults: [] }));
        report(capabilities);
        c.send(frame('telemetry', { sensors: { computer_level: 'trusted', computer_desks: 0 } }));
        c.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'command') return;
            seen.push({ deviceId, ...m });
            if (m.kind === 'desk') c.send(frame('ack', { id: m.id, data: { running: m.value.action !== 'stop', kind: m.value.kind || 'desktop', width: 1280, height: 800 } }));
            else if (m.kind === 'screen') c.send(frame('ack', { id: m.id, data: { format: 'jpeg', width: 1280, height: 800, content_b64: '/9j/' } }));
            else if (m.kind === 'input') c.send(frame('ack', { id: m.id, data: { done: true } }));
            else c.send(frame('nack', { id: m.id, fault_code: 'unsupported', message: 'a lent desktop has no browser command' }));
        });
        const beat = setInterval(() => { try { c.send(frame('heartbeat', { t: Date.now() })); } catch { /* closed */ } }, Math.max(100, Math.floor(config.heartbeat_ms / 2)));
        c.ws.on('close', () => clearInterval(beat));
        await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [deviceId]); return d && Object.keys(d.capabilities || {}).length; });
        if (capabilities.computer) await poll(() => t.hub.computerOf(deviceId) !== null);
        return { c, deviceId, report };
    }
    const asRun = (subject) => ({ token: t.network.signService({ sub: 'svc:run', cap: ['bot.desk.session'] }), headers: { 'X-OV-Subject': subject } });
    const SES = (n) => `ses_01JD2C3D4E5F6G7H8J9K0MNP${String(n).padStart(2, '0')}`;
    const job = () => ({ id: `job_${ids.ulid()}`, class: 'code', artifact: { name: 'openvibe-codes', version: '1.0.0' }, args: {}, ttl_ms: 60000, limits: { wall_ms: 30000, cpu_ms: 30000, mem_bytes: 268435456 } });
    const project = `prj_${ids.ulid()}`;

    const worker = await machine(alex, { worker: WORKER(false) });
    const desks = await machine(alex, { computer: { desk: DESK(['browser', 'desktop']) } });
    const browsersOnly = await machine(alex, { computer: { desk: DESK(['browser']) } });

    await check('"Run other people\'s jobs" turns on only where the Link serves other people', async () => {
        const off = await t.call('POST', `/api/v1/machines/${worker.deviceId}/shared-jobs`, { user: alex, body: { on: true } });
        assert.deepStrictEqual([off.status, off.json.code], [409, 'bot.worker_not_shared'], off.text);
        assert.match(off.json.detail || off.json.message || off.text, /--serve-others/);
        worker.report({ worker: WORKER(true) });
        await poll(async () => ((await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [worker.deviceId])).capabilities.worker || {}).serve_others);
        const on = await t.call('POST', `/api/v1/machines/${worker.deviceId}/shared-jobs`, { user: alex, body: { on: true } });
        assert.strictEqual(on.status, 200, on.text);
        assert.deepStrictEqual([on.json.machine.shared_jobs, on.json.machine.worker], [true, { classes: ['code'], serve_others: true, egress: 'public' }]);
        const notHis = await t.call('POST', `/api/v1/machines/${worker.deviceId}/shared-jobs`, { user: bob, body: { on: false } });
        assert.strictEqual(notHis.status, 404, 'only its owner');
    });

    await check('another person\'s job goes out marked for the Link; the owner\'s own job does not', async () => {
        const theirs = await dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: `user:${bob.subject}` });
        assert.strictEqual(theirs.sent, true);
        const f = await worker.c.waitFor((m) => m.type === 'job' && m.job.id === theirs.job.id);
        assert.strictEqual(f.for, 'other', 'the Link runs it without the owner\'s sign-ins');
        const own = await dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: `user:${alex.subject}` });
        const g = await worker.c.waitFor((m) => m.type === 'job' && m.job.id === own.job.id);
        assert.ok(!('for' in g), 'the owner\'s own job');
        // 2026-11-16: another person's job names their own sandbox on this machine (contracts 0.442.0, Link v0.72.0): the
        // same for every job of theirs here, never the owner's, never a stored part of the job.
        assert.match(f.job.sandbox || '', /^sbx_[0-9a-f]{32}$/, JSON.stringify(f.job));
        assert.ok(!('sandbox' in g.job), 'the owner\'s own job names none: its sandbox is the owner\'s');
        const next = await dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: `user:${bob.subject}` });
        const h = await worker.c.waitFor((m) => m.type === 'job' && m.job.id === next.job.id);
        assert.strictEqual(h.job.sandbox, f.job.sandbox, 'the same person on the same machine: the same sandbox');
        const { sandboxOf } = require('../server/jobs/dispatch');
        assert.notStrictEqual(sandboxOf('dev_other_machine', bob.subject), f.job.sandbox, 'another machine: another id');
        assert.notStrictEqual(sandboxOf(worker.deviceId, alex.subject), f.job.sandbox, 'another person: another id');
        assert.ok(!('sandbox' in (await t.db.maybe('SELECT job FROM run_jobs WHERE id = $1', [theirs.job.id])).job), 'the stored job is the caller\'s');

        // What the person typed reaches their running job (job_stdin); the wrong person, or a job that ended, is refused.
        const call = (p, body) => t.call('POST', p, { cap: ['bot.job.dispatch'], body });
        const early = await call(`/api/v1/jobs/${next.job.id}/stdin`, { data: 'x' });
        assert.deepStrictEqual([early.status, early.json.code], [409, 'bot.job_not_running'], 'sent but not started yet: the Link would drop it');
        worker.c.send(frame('ack', { id: next.job.id }));
        worker.c.send(frame('job_started', { id: next.job.id, started_ms: Date.now() }));
        await poll(async () => (await t.db.maybe('SELECT state FROM run_jobs WHERE id = $1', [next.job.id])).state === 'running');
        const typed = await call(`/api/v1/jobs/${next.job.id}/stdin`, { data: 'the-code\n', subject: `user:${bob.subject}` });
        assert.strictEqual(typed.status, 200, typed.text);
        assert.strictEqual(typed.json.sent, true);
        const sin = await worker.c.waitFor((m) => m.type === 'job_stdin' && m.id === next.job.id);
        assert.deepStrictEqual([sin.data, 'eof' in sin], ['the-code\n', false]);
        const wrong = await call(`/api/v1/jobs/${next.job.id}/stdin`, { data: 'x', subject: `user:${alex.subject}` });
        assert.deepStrictEqual([wrong.status, wrong.json.code], [403, 'bot.not_owner']);
        const big = await call(`/api/v1/jobs/${next.job.id}/stdin`, { data: 'x'.repeat(4097) });
        assert.deepStrictEqual([big.status, big.json.code], [422, 'bot.invalid_input']);
        const person = await t.call('POST', `/api/v1/jobs/${next.job.id}/stdin`, { user: bob, body: { data: 'x' } });
        assert.strictEqual(person.status, 403, 'services only: a person types through Run, which checks it is their job');
        await assert.rejects(dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: 'service:watch' }),
            (e) => e.status === 403 && e.code === 'bot.not_owner', 'never a service\'s job on a person\'s machine');
        const built = await offers.build();
        const offer = built.find((o) => o.offer_id === `jobs:${worker.deviceId}`);
        assert.ok(offer, JSON.stringify(built.map((o) => o.offer_id)));
        assert.deepStrictEqual([offer.trust, offer.capabilities, offer.health.status, 'owner' in offer], ['community', ['worker:code'], 'up', false]);
        assert.ok(built.some((o) => o.offer_id === `node:${worker.deviceId}` && o.trust === 'user-owned'), 'its owner\'s own offer stays');
    });

    await check('turned off, or a Link that stops serving others, and nobody else\'s job runs there', async () => {
        await t.call('POST', `/api/v1/machines/${worker.deviceId}/shared-jobs`, { user: alex, body: { on: false } });
        await assert.rejects(dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: `user:${bob.subject}` }),
            (e) => e.status === 403 && e.code === 'bot.not_owner');
        assert.ok(!(await offers.build()).some((o) => o.offer_id === `jobs:${worker.deviceId}`), 'no community offer');
        await t.domain.machines.setSharedJobs(worker.deviceId, true);
        worker.report({ worker: WORKER(false) });
        await poll(async () => !((await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [worker.deviceId])).capabilities.worker || {}).serve_others);
        await assert.rejects(dispatch(t.db, worker.deviceId, job(), { link: t.hub, project, subject: `user:${bob.subject}` }),
            (e) => e.status === 403 && e.code === 'bot.not_owner', 'the switch alone is not enough');
        assert.ok(!(await offers.build()).some((o) => o.offer_id === `jobs:${worker.deviceId}`));
    });

    await check('"Lend desktops" turns on only where the Link lends sandboxed desktops', async () => {
        const no = await t.call('POST', `/api/v1/machines/${browsersOnly.deviceId}/shared-desktops`, { user: alex, body: { on: true } });
        assert.deepStrictEqual([no.status, no.json.code], [409, 'bot.desktops_not_lent'], no.text);
        const on = await t.call('POST', `/api/v1/machines/${desks.deviceId}/shared-desktops`, { user: alex, body: { on: true } });
        assert.strictEqual(on.status, 200, on.text);
        assert.deepStrictEqual([on.json.machine.shared_desktops, on.json.machine.shared_desks], [true, false]);
        const offer = (await offers.build()).find((o) => o.offer_id === `desk:${desks.deviceId}`);
        assert.deepStrictEqual([offer.trust, offer.capabilities], ['community', ['worker:desktop']], 'desktops only: browsers are not lent');
        const asDesktop = (await t.call('GET', '/api/v1/desk-hosts?kind=desktop', asRun(bob.subject))).json.hosts;
        assert.deepStrictEqual(asDesktop.map((h) => [h.machine_id, h.kinds, h.free]), [[desks.deviceId, ['desktop'], 1]], 'a desktop takes both halves of max_desks 1');
        assert.deepStrictEqual((await t.call('GET', '/api/v1/desk-hosts', asRun(bob.subject))).json.hosts, [], 'no browser desks lent');
        assert.strictEqual((await t.call('GET', '/api/v1/desk-hosts?kind=vm', asRun(bob.subject))).status, 422);
    });

    await check('a desktop lease: started as a desktop, screen and input only, as much room as two browser desks', async () => {
        const browser = await t.call('POST', `/api/v1/machines/${desks.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(1), desk: 'desk-b01', kind: 'browser' } });
        assert.deepStrictEqual([browser.status, browser.json.code], [409, 'bot.kind_unavailable'], browser.text);
        const r = await t.call('POST', `/api/v1/machines/${desks.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(2), desk: 'desk-d02', kind: 'desktop', width: 1280, height: 800 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual([r.json.kind, r.json.shared], ['desktop', true]);
        const start = seen.find((m) => m.deviceId === desks.deviceId && m.kind === 'desk' && m.value.action === 'start');
        assert.deepStrictEqual([start.value.desk, start.value.kind], ['desk-d02', 'desktop']);
        const cmd = (kind, value) => t.call('POST', `/api/v1/machines/${desks.deviceId}/desk-leases/desk-d02/commands`, { ...asRun(bob.subject), body: { kind, value } });
        assert.strictEqual((await cmd('screen', {})).status, 200);
        assert.strictEqual((await cmd('input', { action: 'click', x: 10, y: 10 })).status, 200);
        const b = await cmd('browser', { action: 'open', url: 'https://example.org/' });
        assert.deepStrictEqual([b.status, b.json.code], [422, 'bot.kind_mismatch']);
        const full = await t.call('POST', `/api/v1/machines/${desks.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(3), desk: 'desk-d03', kind: 'desktop' } });
        assert.deepStrictEqual([full.status, full.json.code], [409, 'bot.machine_busy'], 'max_desks 1 is one desktop');
        const origins = await t.call('POST', `/api/v1/machines/${desks.deviceId}/desk-leases`, { ...asRun(bob.subject), body: { session: SES(4), desk: 'desk-d04', kind: 'desktop', origins: ['https://example.org'] } });
        assert.strictEqual(origins.status, 409, 'a desktop cannot hold a browser origin list');
        // Its owner stops lending desktops: the lease is gone for the session.
        await t.call('POST', `/api/v1/machines/${desks.deviceId}/shared-desktops`, { user: alex, body: { on: false } });
        assert.strictEqual((await cmd('screen', {})).status, 404);
        await t.db.exec('DELETE FROM desk_leases WHERE device_id = $1', [desks.deviceId]);
    });

    await done(t);
})();
