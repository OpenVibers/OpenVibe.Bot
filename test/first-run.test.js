'use strict';
// The guided first run, measured (OpenVibe Link's `openvibe-node`): the Link sends one `node.first_run` telemetry
// event per step (installed, paired, self_check with ok or the reason, first_job with the machine's counts). Bot stores
// one row per device and step, the machine's page shows what its first job found, and a reviewer sees the funnel.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.newUser('alex');
    const ada = t.network.newUser('ada');
    ada.role = 'admin';
    const cookie = (u) => ({ Cookie: `ov_token=${t.network.signUser(u)}` });
    const get = (p, u) => fetch(t.base + p, { redirect: 'manual', headers: u ? cookie(u) : {} });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const poll = async (fn, ms = 5000) => {
        const end = Date.now() + ms;
        for (;;) {
            const v = await fn();
            if (v) return v;
            if (Date.now() > end) return null;
            await wait(50);
        }
    };
    async function pairOverWs(robotId, code, capabilities = {}) {
        const dev = await t.ws('/device');
        dev.send({ type: 'pair', robot: robotId, code, agent_version: 'v0.39.0', device_kind: 'onboard', drivers: ['dryrun'],
            capabilities: { worker: { runtime_classes: ['function'] }, ...capabilities } });
        const paired = await dev.waitFor((m) => m.type === 'paired');
        await dev.waitFor((m) => m.type === 'hello');
        await dev.waitFor((m) => m.type === 'config');
        return { dev, paired };
    }
    const rowsFor = (id) => t.db.many('SELECT * FROM device_first_run WHERE device_id = $1 ORDER BY at', [id]);

    const { robot, pairing } = await t.robot(alex);
    const { dev, paired } = await pairOverWs(robot.id, pairing.code);
    const at = Date.now() - 60_000;
    const event = (step, extra = {}) => ({ name: 'node.first_run', ts: at + ['installed', 'paired', 'self_check', 'first_job'].indexOf(step) * 1000,
        fields: { step, version: 'v0.39.0', os: 'linux', arch: 'amd64', ...extra } });

    await check('one node.first_run event per step is stored, with the machine counts and no personal fields', async () => {
        dev.send({ type: 'telemetry', events: [
            event('installed'),
            event('paired'),
            event('self_check', { ok: true }),
            event('first_job', { cpus: 8, memory_total_bytes: 16 << 30, memory_free_bytes: 8 << 30,
                disk_total_bytes: 100 << 30, disk_free_bytes: 40 << 30,
                // A buggy client's extra fields are never stored.
                path: '/home/alice', user: 'alice', ip: '10.0.0.7' }),
        ] });
        const rows = await poll(async () => { const r = await rowsFor(paired.device_id); return r.length === 4 ? r : null; });
        assert.ok(rows, 'the four steps were stored');
        assert.deepStrictEqual(rows.map((r) => r.step), ['installed', 'paired', 'self_check', 'first_job']);
        assert.strictEqual(rows[0].agent_version, 'v0.39.0');
        assert.strictEqual(rows[0].os, 'linux');
        assert.strictEqual(rows[2].ok, true);
        assert.strictEqual(rows[3].ok, null);
        assert.strictEqual(rows[3].info.cpus, 8);
        assert.strictEqual(rows[3].info.memory_total_bytes, 16 << 30);
        assert.strictEqual(rows[3].info.disk_free_bytes, 40 << 30);
        assert.deepStrictEqual(Object.keys(rows[3].info).sort(), ['arch', 'cpus', 'disk_free_bytes', 'disk_total_bytes', 'memory_free_bytes', 'memory_total_bytes']);
        const stored = JSON.stringify(rows);
        assert.ok(!stored.includes('/home/alice') && !stored.includes('alice') && !stored.includes('10.0.0.7'), 'no path, user or address is stored');
    });

    await check('a failed self-check keeps its reason for the funnel; a resend updates the step instead of adding one', async () => {
        dev.send({ type: 'telemetry', events: [event('self_check', { ok: false, reason: 'OpenVibe.Bot answered HTTP 503' })] });
        const failed = await poll(async () => { const r = await rowsFor(paired.device_id); const s = r.find((x) => x.step === 'self_check'); return s && s.ok === false ? s : null; });
        assert.ok(failed, 'the failure replaced the pass');
        assert.strictEqual(failed.reason, 'OpenVibe.Bot answered HTTP 503');
        dev.send({ type: 'telemetry', events: [event('self_check', { ok: false, reason: 'bad\u0000line' }), { name: 'other', ts: at, fields: { step: 'installed' } },
            { name: 'node.first_run', ts: at, fields: { step: 'not_a_step' } }] });
        const cleaned = await poll(async () => { const r = await rowsFor(paired.device_id); const s = r.find((x) => x.step === 'self_check'); return s && s.reason === 'bad line' ? s : null; });
        assert.ok(cleaned, 'control characters are cleaned from the reason');
        const rows = await rowsFor(paired.device_id);
        assert.strictEqual(rows.length, 4, 'ignored events added no rows and the resend added none');
    });

    await check('the owner’s machines page shows what the first job found', async () => {
        const page = await (await get('/machines', alex)).text();
        assert.ok(page.includes('First run'), page.slice(0, 500));
        assert.ok(page.includes('8 CPUs') && page.includes('free disk') && page.includes('linux/amd64'), 'the machine figures are shown');
        assert.ok(!page.includes('/home/alice'));
    });

    await check('only a reviewer reads the funnel, and it counts machines and the time between steps', async () => {
        const normal = await get('/admin/first-run', alex);
        assert.strictEqual(normal.status, 404);
        const anon = await get('/admin/first-run');
        assert.notStrictEqual(anon.status, 200, 'signed out: not the funnel');
        const r = await get('/admin/first-run', ada);
        assert.strictEqual(r.status, 200);
        const page = await r.text();
        assert.ok(page.includes('First run') && page.includes('The funnel'), 'the funnel page');
        assert.ok(page.includes('First job done') && page.includes('Review'), `the steps are listed: ${page.slice(0, 900)}`);
        assert.ok(page.includes('1 s') || page.includes('under a second'), 'the median between steps (the fixture is 1 s apart)');
        assert.match(page, new RegExp(paired.device_id), 'the recent machine');
        assert.ok(page.includes('0 self-checks passed, 1 failed') || page.includes('1 failed'), 'the failed self-check is counted as reached');
    });

    dev.close();
    await t.close();
    done();
})();
