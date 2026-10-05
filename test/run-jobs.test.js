'use strict';
// Jobs on the device link (plan T14 L1, platform.job-frame@1): server/jobs/dispatch.js hands a platform.job@1 job
// to a paired Node, only for a class it advertises, resends it until acked, and meters it into run_usage_outbox
// one reading per wall-clock second (run:<job id>:<n>), backfilled and deduplicated from job_exit; the relay
// delivers each reading to Billing once, and keeps it queued while Billing is unset or down.
const assert = require('assert');
const { ids, validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const PROJECT = `prj_${ids.ulid()}`;

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const SUBJECT = `user:${alex.subject}`;
    // Required after boot(): it reloads server/, and these must be the same modules the app runs.
    const { dispatch, cancel } = require('../server/jobs/dispatch');
    const { createUsageRelay } = require('../server/jobs/metering');

    let seq = 0;
    const frame = (type, fields) => ({ v: 1, seq: ++seq, ts: Date.now(), type, ...fields });
    const newJob = (over = {}) => ({
        id: `job_${ids.ulid()}`, class: 'function', artifact: { name: 'thumbnail', version: '1.2.0' }, args: { width: 320 },
        ttl_ms: 60000, limits: { wall_ms: 30000, cpu_ms: 30000, mem_bytes: 268435456 }, ...over,
    });
    const row = (id) => t.db.maybe('SELECT * FROM run_jobs WHERE id = $1', [id]);
    const readings = async (id) => (await t.db.many('SELECT envelope FROM run_usage_outbox WHERE event_id LIKE $1 ORDER BY id', [`run:${id}:%`])).map((r) => r.envelope);
    const send = (deviceId, job, opts = {}) => dispatch(t.db, deviceId, job, { link: t.hub, project: PROJECT, subject: SUBJECT, ...opts });
    const sawJob = (c, id) => c.messages.some((m) => m.type === 'job' && m.job.id === id);

    /** A Network-paired Node advertising `classes`, connected; its capabilities are persisted before it returns. */
    async function node(classes = ['function']) {
        const { robot } = await t.robot(alex);
        const principal = t.network.addNode({ owner: alex.subject, ref: robot.id });
        const n = { principal, c: null, deviceId: null };
        n.connect = async () => {
            n.c = await t.ws('/device', { headers: { Authorization: `Bearer ${t.network.signNode(principal)}` } });
            n.deviceId = (await n.c.waitFor((m) => m.type === 'hello')).device_id;
            await n.c.waitFor((m) => m.type === 'config');
            return n.c;
        };
        await n.connect();
        n.c.send(frame('status', { capabilities: { worker: { capabilities: classes.map((x) => `worker:${x}`), runtime_classes: classes } } }));
        await poll(async () => { const d = await t.db.maybe('SELECT capabilities FROM devices WHERE id = $1', [n.deviceId]); return d && d.capabilities.worker; });
        /** A frame from the Node, then the Bot frame that answers it (or the settle of a no-answer frame). */
        n.say = (type, fields) => n.c.send(frame(type, fields));
        n.exit = async (id, fields) => {
            const before = n.c.messages.filter((m) => m.type === 'job_exit_ack' && m.id === id).length;
            n.say('job_exit', { id, code: null, result: null, ...fields });
            await n.c.waitFor(() => n.c.messages.filter((m) => m.type === 'job_exit_ack' && m.id === id).length > before);
        };
        /** A running job: dispatched, acked, started at `startedMs`. */
        n.running = async (startedMs, over = {}) => {
            const job = newJob(over);
            await send(n.deviceId, job);
            await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
            n.say('ack', { id: job.id });
            n.say('job_started', { id: job.id, started_ms: startedMs });
            await poll(async () => (await row(job.id)).state === 'running');
            return job;
        };
        return n;
    }

    await check('a job reaches its connected Node as a valid job frame and the ack places it', async () => {
        const n = await node();
        const job = newJob();
        const r = await send(n.deviceId, job);
        assert.strictEqual(r.sent, true);
        assert.strictEqual(r.job.state, 'queued');
        const f = await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        assert.deepStrictEqual(f.job, job);
        assert.ok(validate('platform.job-frame@1', f).valid, JSON.stringify(validate('platform.job-frame@1', f).errors));
        n.say('ack', { id: job.id });
        await poll(async () => (await row(job.id)).state === 'placed');
        const again = await send(n.deviceId, job);
        assert.strictEqual(again.sent, false, 'the same job again is idempotent and not resent once acked');
        await assert.rejects(send(n.deviceId, { ...job, args: { width: 1 } }), (e) => e.code === 'bot.job_id_reused');
        await assert.rejects(send(n.deviceId, { ...newJob(), ttl_ms: 0 }), (e) => e.code === 'bot.invalid_job');
        await assert.rejects(send(n.deviceId, newJob(), { project: 'not-a-project' }), (e) => e.code === 'bot.invalid_job');
    });

    await check('a class the Node does not advertise is never sent, at dispatch or on a reconnect', async () => {
        const n = await node(['function']);
        const code = newJob({ class: 'code' });
        await assert.rejects(send(n.deviceId, code), (e) => e.code === 'bot.class_unadvertised');
        assert.strictEqual(await row(code.id), null);
        // Stored while the Node is away; it comes back advertising another class only.
        n.c.close(); await n.c.waitForClose();
        const fn = newJob();
        assert.strictEqual((await send(n.deviceId, fn)).sent, false);
        await t.db.query('UPDATE devices SET capabilities = $2 WHERE id = $1', [n.deviceId, JSON.stringify({ worker: { runtime_classes: ['code'] } })]);
        await n.connect();
        await poll(async () => (await row(fn.id)).state === 'failed');
        assert.strictEqual((await row(fn.id)).fault_code, 'bot.class_unadvertised');
        assert.ok(!sawJob(n.c, code.id) && !sawJob(n.c, fn.id), 'no job frame for a class the Node lacks');
    });

    await check('an unacked job is resent on every reconnect until acked, then never again', async () => {
        const n = await node();
        const job = newJob();
        await send(n.deviceId, job);
        await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        n.c.close(); await n.c.waitForClose();
        await n.connect();
        const f = await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        assert.deepStrictEqual(f.job, job);
        n.say('ack', { id: job.id });
        await poll(async () => (await row(job.id)).state === 'placed');
        n.c.close(); await n.c.waitForClose();
        await n.connect();
        await t.wait(300);
        assert.ok(!sawJob(n.c, job.id), 'an acked job is not resent');
    });

    await check('exited 0 writes one reading of quantity 1 per second plus the partial last second', async () => {
        const n = await node();
        const S = 1790935200250;
        const job = await n.running(S);
        n.say('job_usage', { id: job.id, started_ms: S, second: 0, cpu_ms: 640 });
        n.say('job_usage', { id: job.id, started_ms: S, second: 1 });
        await n.exit(job.id, { reason: 'exited', code: 0, result: { url: 'media:object-7' }, usage: { started_ms: S, wall_ms: 2350, cpu_ms: 1800 } });
        const got = await readings(job.id);
        assert.deepStrictEqual(got.map((r) => [r.idempotency_key, r.quantity, r.at]), [
            [`run:${job.id}:0`, 1, new Date(S).toISOString()],
            [`run:${job.id}:1`, 1, new Date(S + 1000).toISOString()],
            [`run:${job.id}:2`, 0.35, new Date(S + 2000).toISOString()],
        ]);
        for (const r of got) {
            assert.ok(validate('platform.usage-sample@1', r).valid);
            assert.deepStrictEqual({ ...r, idempotency_key: undefined, id: undefined, quantity: undefined, at: undefined }, {
                idempotency_key: undefined, id: undefined, quantity: undefined, at: undefined,
                service: 'run', operation: 'function.invoke', unit: 's', resource: job.id, node: n.deviceId,
                source: 'openvibe-node.worker', project: PROJECT, subject: SUBJECT,
            });
            assert.strictEqual(r.id, r.idempotency_key);
        }
        const j = await row(job.id);
        assert.strictEqual(j.state, 'succeeded');
        assert.strictEqual(j.usage_read, 3);
        assert.deepStrictEqual(j.result, { url: 'media:object-7' });
        const ack = n.c.messages.find((m) => m.type === 'job_exit_ack' && m.id === job.id);
        assert.ok(validate('platform.job-frame@1', ack).valid);
    });

    await check('a lost job_usage is backfilled from job_exit.usage', async () => {
        const n = await node();
        const S = 1790935300000;
        const job = await n.running(S);
        n.say('job_usage', { id: job.id, started_ms: S, second: 0 });
        n.say('job_usage', { id: job.id, started_ms: S, second: 2 });   // second 1 was lost with the link
        await n.exit(job.id, { reason: 'limit', usage: { started_ms: S, wall_ms: 3000 } });
        const got = await readings(job.id);
        assert.deepStrictEqual(got.map((r) => [r.idempotency_key, r.quantity]), [0, 2, 1].map((k) => [`run:${job.id}:${k}`, 1]), 'second 1 written from job_exit; no partial second when wall_ms is whole');
        assert.strictEqual((await row(job.id)).state, 'failed');
    });

    await check('job_exit twice writes one set and is acked twice', async () => {
        const n = await node();
        const S = 1790935400000;
        const job = await n.running(S);
        const exit = { reason: 'exited', code: 3, usage: { started_ms: S, wall_ms: 1500 } };
        await n.exit(job.id, exit);
        const first = await readings(job.id);
        await n.exit(job.id, exit);
        await n.exit(job.id, { ...exit, usage: { started_ms: S, wall_ms: 9000 } });   // a different resend changes nothing
        assert.deepStrictEqual(await readings(job.id), first);
        assert.strictEqual(first.length, 2);
        const j = await row(job.id);
        assert.strictEqual(j.state, 'failed');
        assert.strictEqual(Number(j.wall_ms), 1500);
        assert.strictEqual(j.exit_code, 3);
    });

    await check('job_cancel before job_started: the job is cancelled, never started, and nothing is billed', async () => {
        const n = await node();
        const job = newJob();
        await send(n.deviceId, job);
        await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        n.say('ack', { id: job.id });
        await poll(async () => (await row(job.id)).state === 'placed');
        const r = await cancel(t.db, job.id, { link: t.hub });
        assert.strictEqual(r.sent, true);
        assert.strictEqual(r.job.state, 'cancelled');
        const f = await n.c.waitFor((m) => m.type === 'job_cancel' && m.id === job.id);
        assert.ok(validate('platform.job-frame@1', f).valid);
        await n.exit(job.id, { reason: 'cancelled', usage: { wall_ms: 0 } });
        const j = await row(job.id);
        assert.strictEqual(j.state, 'cancelled');
        assert.strictEqual(j.started_ms, null);
        assert.deepStrictEqual(await readings(job.id), []);
        // Cancelled while the Node is away and never sent: it is not sent on the reconnect either.
        n.c.close(); await n.c.waitForClose();
        const away = newJob();
        await send(n.deviceId, away);
        await cancel(t.db, away.id, { link: t.hub });
        await n.connect();
        await t.wait(300);
        assert.ok(!sawJob(n.c, away.id));
        assert.strictEqual((await row(away.id)).state, 'cancelled');
    });

    await check('usage_read never regresses and a reading is never written twice', async () => {
        const n = await node();
        const S = 1790935500000;
        const job = await n.running(S);
        for (let k = 0; k < 5; k++) n.say('job_usage', { id: job.id, started_ms: S, second: k });
        await poll(async () => (await row(job.id)).usage_read === 5);
        n.say('job_usage', { id: job.id, started_ms: S, second: 1 });   // a replay after a reconnect
        await n.exit(job.id, { reason: 'stopped', usage: { started_ms: S, wall_ms: 2000 } });   // smaller than what was read
        const j = await row(job.id);
        assert.strictEqual(j.usage_read, 5);
        assert.deepStrictEqual((await readings(job.id)).map((r) => r.idempotency_key), [0, 1, 2, 3, 4].map((k) => `run:${job.id}:${k}`));
    });

    await check('a Node never meters another device\'s job, nor seconds past limits.wall_ms', async () => {
        const a = await node();
        const b = await node();
        const S = 1790935600000;
        const job = await a.running(S, { limits: { wall_ms: 2500, cpu_ms: 30000, mem_bytes: 268435456 } });
        b.say('job_usage', { id: job.id, started_ms: S, second: 0 });
        assert.strictEqual((await b.c.waitFor((m) => m.type === 'error')).code, 'bot.unknown_job');
        b.say('job_exit', { id: job.id, reason: 'exited', code: 0, result: null, usage: { started_ms: S, wall_ms: 5000 } });
        await b.c.waitFor(() => b.c.messages.filter((m) => m.type === 'error').length === 2);
        assert.ok(!b.c.messages.some((m) => m.type === 'job_exit_ack'));
        a.say('job_usage', { id: job.id, started_ms: S, second: 2 });   // [2000, 3000) is past the 2500 ms cap
        await a.exit(job.id, { reason: 'limit', usage: { started_ms: S, wall_ms: 2600 } });
        assert.deepStrictEqual((await readings(job.id)).map((r) => [r.idempotency_key, r.quantity]), [[`run:${job.id}:0`, 1], [`run:${job.id}:1`, 1], [`run:${job.id}:2`, 0.5]]);
        assert.strictEqual(Number((await row(job.id)).wall_ms), 2500);
    });

    await check('Billing unset or down keeps readings queued; a later sweep delivers each key once', async () => {
        assert.strictEqual(t.app.locals.usage.enabled, false, 'BOT_BILLING_* unset: no relay');
        const queued = (await t.db.many('SELECT event_id FROM run_usage_outbox ORDER BY id')).map((r) => r.event_id);
        assert.ok(queued.length >= 10);
        assert.strictEqual(await t.app.locals.usage.pending(), queued.length, 'nothing dropped while Billing is unset');

        // A Billing stand-in with POST /api/v1/usage's idempotency: 201 new, 200 identical replay, 409 a different reading.
        const billed = new Map(); const posts = []; let up = false; let clock = Date.now();
        const fetchImpl = async (url, init) => {
            posts.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
            if (!up) return new Response('{}', { status: 503 });
            const r = JSON.parse(init.body); const prev = billed.get(r.idempotency_key);
            if (prev) return new Response('{}', { status: prev === init.body ? 200 : 409 });
            billed.set(r.idempotency_key, init.body);
            return new Response('{}', { status: 201 });
        };
        const config = { ...t.config, billing: { url: 'http://billing.test', token: 'svc-token', intervalMs: 100, timeoutMs: 2000 } };
        const relay = createUsageRelay({ db: t.db, config, fetchImpl, now: () => clock, log: { warn() {} } });
        assert.strictEqual(relay.enabled, true);
        const down = await relay.flush();
        assert.strictEqual(down.sent, 0);
        assert.strictEqual(await relay.pending(), queued.length, 'Billing down: still queued');
        assert.strictEqual(await relay.rejected(), 0);

        up = true; clock += 10 * 60 * 1000;
        const whileDown = posts.length;
        await relay.flush();
        await relay.flush();
        assert.strictEqual(await relay.pending(), 0);
        assert.deepStrictEqual([...billed.keys()].sort(), [...queued].sort());
        assert.deepStrictEqual(posts.slice(whileDown).map((p) => p.body.idempotency_key), queued, 'each key posted once, in queue order');
        assert.ok(posts.every((p) => p.url === 'http://billing.test/api/v1/usage' && p.auth === 'Bearer svc-token'));
        const sentNow = posts.length;
        await relay.flush();
        assert.strictEqual(posts.length, sentNow, 'a later sweep sends nothing again');
        await relay.stop();
    });

    await check('the jobs API serves bot.job.dispatch (dispatch, state with stdout, cancel) to a service only', async () => {
        const n = await node();
        const job = newJob();
        const body = { node_id: n.deviceId, job, project_id: PROJECT, subject: SUBJECT };
        const call = (method, p, opts = {}) => t.call(method, p, { cap: ['bot.job.dispatch'], ...opts });
        // A person, a service without the capability, a node token and no token at all are all refused.
        refused(await call('POST', '/api/v1/jobs', { user: alex, body }), 403, 'bot.forbidden');
        refused(await call('POST', '/api/v1/jobs', { cap: ['bot.robot.read'], body }), 403, 'capability.denied');
        refused(await call('POST', '/api/v1/jobs', { token: t.network.signNode(n.principal), body }), 403, 'bot.forbidden');
        refused(await call('POST', '/api/v1/jobs', { token: null, body }), 401, 'bot.sign_in');
        // project_id is required: Run is the payer.
        refused(await call('POST', '/api/v1/jobs', { body: { ...body, project_id: undefined } }), 422, 'bot.invalid_input');
        // The dispatch reaches the Node once; the same job again is idempotent.
        const r = await call('POST', '/api/v1/jobs', { body });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.sent, true);
        assert.strictEqual(r.json.job.state, 'queued');
        await n.c.waitFor((m) => m.type === 'job' && m.job.id === job.id);
        n.say('ack', { id: job.id });
        await poll(async () => (await row(job.id)).state === 'placed');
        // The same job id again is idempotent: the same row, not sent again once it is placed.
        const again = await call('POST', '/api/v1/jobs', { body });
        assert.strictEqual(again.json.job.id, job.id);
        assert.deepStrictEqual(again.json.job.job, job);
        assert.strictEqual(again.json.sent, false);
        // A class the device does not advertise is refused and never stored.
        const code = newJob({ class: 'code' });
        refused(await call('POST', '/api/v1/jobs', { body: { ...body, job: code } }), 409, 'bot.class_unadvertised');
        assert.strictEqual(await row(code.id), null);
        // GET answers the state and the captured stdout.
        n.say('job_stdout', { id: job.id, chunk_seq: 1, chunk: 'hello\n' });
        await poll(async () => (await call('GET', `/api/v1/jobs/${job.id}`)).json.stdout);
        const got = await call('GET', `/api/v1/jobs/${job.id}`);
        assert.strictEqual(got.status, 200, got.text);
        assert.strictEqual(got.json.job.state, 'placed');
        assert.strictEqual(got.json.stdout.text, 'hello\n');
        // One jobs service (server/jobs/index.js) holds the rings for the device socket and the API.
        assert.deepStrictEqual(t.app.locals.jobs.stdout(job.id), got.json.stdout);
        refused(await call('GET', '/api/v1/jobs/job_00000000000000000000000000'), 404, 'bot.job_not_found');
        refused(await call('POST', '/api/v1/jobs/job_00000000000000000000000000/cancel'), 404, 'bot.job_not_found');
        // Cancel asks the Node to stop it.
        const c = await call('POST', `/api/v1/jobs/${job.id}/cancel`);
        assert.strictEqual(c.status, 200, c.text);
        assert.strictEqual(c.json.job.state, 'cancelled');
        await n.c.waitFor((m) => m.type === 'job_cancel' && m.id === job.id);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });

function refused(res, status, code) {
    assert.strictEqual(res.status, status, `${res.status} ${res.text}`);
    assert.strictEqual(res.json && res.json.code, code, JSON.stringify(res.json));
}

async function poll(fn, ms = 20000) {
    const until = Date.now() + ms;
    for (;;) {
        if (await fn()) return;
        if (Date.now() > until) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 25));
    }
}
